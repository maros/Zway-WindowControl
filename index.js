/*** WindowControl Z-Way HA module *******************************************

Version: 1.02
(c) Maroš Kollár, 2015
-----------------------------------------------------------------------------
Author: Maroš Kollár <maros@k-1.com>
Description:
    This module controls window openers for optimal ventilation and
    cooling.

******************************************************************************/

function WindowControl (id, controller) {
    // Call superconstructor first (AutomationModule)
    WindowControl.super_.call(this, id, controller);
    
    this.allDevices         = [];
    this.rainDevice         = undefined;
}

inherits(WindowControl, AutomationModule);

_module = WindowControl;

// ----------------------------------------------------------------------------
// --- Module instance initialized
// ----------------------------------------------------------------------------

WindowControl.prototype.init = function (config) {
    WindowControl.super_.prototype.init.call(this, config);

    var self = this;
    var langFile = self.controller.loadModuleLang("WindowControl");
    
    // Create vdev
    this.vDev = this.controller.devices.create({
        deviceId: "WindowControl_" + this.id,
        defaults: {
            metrics: {
                probeTitle: 'controller',
                title: langFile.title,
                level: 'off',
                icon: '/ZAutomation/api/v1/load/modulemedia/WindowControl/icon_off.png'
            }
        },
        overlay: {
            deviceType: 'switchBinary'
        },
        handler: function(command,args) {
            if (command === 'on' || command === 'off') {
                this.set('metrics:level',command);
                this.set('metrics:icon','/ZAutomation/api/v1/load/modulemedia/WindowControl/icon_'+command+'.png');
            }
        },
        moduleId: this.id
    });
    
    self.alarmCallback = _.bind(self.processAlarm,self);
    self.rainCallback = _.bind(self.processRain,self);
    self.controller.on('security.smoke.alarm',self.alarmCallback);
    self.controller.on('security.smoke.cancel',self.alarmCallback);
    self.controller.on('rain.start',self.rainCallback);
    
    self.interval = setInterval(_.bind(self.checkConditions,self),1000*60*3);
};

WindowControl.prototype.stop = function () {
    var self = this;
    
    if (self.vDev) {
        self.controller.devices.remove(self.vDev.id);
        self.vDev = undefined;
    }
    
    if (typeof(self.interval) !== 'undefined') {
        clearInterval(self.interval);
        self.interval = undefined;
    }
    
    self.controller.off('security.smoke.alarm',self.alarmCallback);
    self.controller.off('security.smoke.cancel',self.alarmCallback);
    self.controller.off('rain.start',self.rainCallback);
    if (typeof(self.rainDevice) !== 'undefined') {
        self.rainDevice.off('change:metrics:level',self.rainCallback);
    }
    self.alarmCallback = undefined;
    self.rainCallback = undefined;
    
    WindowControl.super_.prototype.stop.call(this);
};

WindowControl.prototype.initCallback = function() {
    var self = this;
    
    var devices = [];
    _.each(self.config.rules,function(rule) {
        devices.push(rule.devices);
    });
    self.allDevices = _.uniq(_.flatten(devices));
    
    if (typeof(self.config.rain_sensor) !== 'undefined') {
        var deviceObject = self.controller.devices.get(self.config.rain_sensor);
        if (typeof(deviceObject) === 'undefined') {
            console.error('[WindowControl] Could not find rain device');
        } else {
            self.rainDevice = deviceObject;
            self.rainDevice.on('change:metrics:level',self.rainCallback);
        }
    }
};


// ----------------------------------------------------------------------------
// --- Module methods
// ----------------------------------------------------------------------------

WindowControl.prototype.processAlarm = function(event) {
    var self = this;
    
    var alarmed = true;
    var present = true;
    self.controller.devices.each(function(vDev) {
        var probeTitle = vDev.get('metrics:probeTitle');
        if (probeTitle === 'security'
            && vDev.get('metrics:securityType') === 'smoke') {
            var state = vDev.get('metrics:state');
            if (state !== 'alarm' || state !== 'timeout') {
                alarmed = false;
            }
        } else if (probeTitle === 'presence') {
            present = vDev.get('metrics:level') === 'off'? false:true;
        }
    });
    
    if (alarmed) {
        console.log('[WindowControl] Opening all windows due to smoke alarm');
    }
    
    _.each(self.allDevices,function(deviceId) {
        var deviceObject = self.controller.devices.get(deviceId);
        if (typeof(deviceObject) === 'undefined') {
            console.error('[WindowControl] Could not find window device '+deviceId);
            return;
        }
        if (alarm === true && present === true) {
            deviceObject.set('metrics:auto',true);
            deviceObject.performCommand('on');
        } else {
            deviceObject.set('metrics:auto',false);
        }
    });
};

WindowControl.prototype.processRain = function(event) {
    var self = this;
    
    if (typeof(self.rainDevice) !== 'undefined') {
        var level = self.rainDevice.get('metrics:level');
        if (level === 'off') {
            return;
        }
    }
    
    console.log('[WindowControl] Detected rain. Closing all windows');
     // TODO check for smoke alarm
    _.each(self.allDevices ,function(deviceId) {
        var deviceObject = self.controller.devices.get(deviceId);
        if (typeof(deviceObject) === 'undefined') {
            console.error('[WindowControl] Could not find window device '+deviceId);
            return;
        }
        deviceObject.set('metrics:auto',false);
        deviceObject.performCommand('off');
    });
};

WindowControl.prototype.checkConditions = function() {
    var self = this;

    console.log('[WindowControl] Evaluating window positions');
    if (self.vDev.get('metrics:level') === 'ogg') {
        return;
    }
    
    // TODO
};