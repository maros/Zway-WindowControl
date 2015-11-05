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
    
    self.weatherUndergound = undefined;

    // Create vdev
    this.vDev = this.controller.devices.create({
        deviceId: "WindowControl_" + this.id,
        defaults: {
            metrics: {
                probeTitle: 'WindowControl',
                title: langFile.title,
                level: 'off',
                icon: '/ZAutomation/api/v1/load/modulemedia/WindowControl/icon_off.png'
            }
        },
        overlay: {
            deviceType: 'switchBinary',
        },
        handler: function(command,args) {
            
        },
        moduleId: this.id
    });
    
};

WindowControl.prototype.stop = function () {
    var self = this;
    
    if (self.vDev) {
        self.controller.devices.remove(self.vDev.id);
        self.vDev = undefined;
    }
    
    WindowControl.super_.prototype.stop.call(this);
};

// ----------------------------------------------------------------------------
// --- Module methods
// ----------------------------------------------------------------------------
