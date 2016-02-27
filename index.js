/*** WindowControl Z-Way HA module *******************************************

Version: 1.00
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
    
    this.modes                      = ['summer','winter','ventilation'];
    _.each(this.modes,function(type) {
        this[type+'Device'] = undefined;
    });
    
    this.windowDevices              = [];
    this.ventilationControlDevices  = [];
    this.thermostatDevice           = undefined;
    this.rainSensorDevice           = undefined;
    this.alarmCallback              = undefined;
    this.rainCallback               = undefined;
    this.interval                   = undefined;
    
}

inherits(WindowControl, BaseModule);

_module = WindowControl;

// ----------------------------------------------------------------------------
// --- Module instance initialized
// ----------------------------------------------------------------------------

WindowControl.prototype.init = function (config) {
    WindowControl.super_.prototype.init.call(this, config);

    var self = this;
    
    // Create control devices
    _.each(self.modes,function(type) {
        if (self.config[type+'Active'] === true) {
            self[type+'Device'] = this.controller.devices.create({
                deviceId: "WindowControl_"+type+'_'+ self.id,
                defaults: {
                    metrics: {
                        active: [],
                        title: self.langFile[type+'_active_label'],
                        level: 'off',
                        icon: '/ZAutomation/api/v1/load/modulemedia/WindowControl/icon_'+type+'_off.png'
                    }
                },
                handler: _.bind(self.commandModeDevice,self,type),
                overlay: {
                    probeType: 'WindowController',
                    deviceType: 'switchBinary'
                },
                moduleId: self.id
            });
        }
    });
    
    // Setup thermostat
    if (self.config.summerActive
        && typeof(self.config.summerRules.thermostatDevice) === 'undefined') {
        self.thermostatDevice = self.controller.devices.create({
            deviceId: "WindowControl_Thermostat_" + self.id,
            defaults: {
                metrics: {
                    scaleTitle: config.unitTemperature === "celsius" ? '°C' : '°F',
                    level: config.unitTemperature === "celsius" ? 24 : 75,
                    icon: 'thermostat',
                    title: self.langFile.thermostat
                },
            },
            overlay: {
                deviceType: 'thermostat'
            },
            handler: function(command, args) {
                if (command === 'exact') {
                    self.thermostatDevice.set('metrics.level',args.level);
                }
            },
            moduleId: self.id
        });
    }
    
    // Setup ventilation controller
    if (self.config.ventilateActive) {
        _.each(self.deviceId,function(zone,index) {
            self.ventilationControlDevices.push(
                self.controller.devices.create({
                    deviceId: "WindowControl_Ventilate_" + self.id+'_'+index,
                    defaults: {
                        metrics: {
                            level: 'off',
                            title: self.langFile.ventilateTitle+' '+index,
                            icon: "/ZAutomation/api/v1/load/modulemedia/WindowControl/icon_ventialte.png"

                        },
                    },
                    overlay: {
                        probeType: 'Scene',
                        deviceType: 'toggleButton'
                    },
                    handler: function(command, args) {
                        if (command === 'on') {
                            self.commandVentilateZone(index,args);
                        }
                    },
                    moduleId: self.id
                })
            );
        });
    }
    
    // Setup event callbacks
    self.alarmCallback  = _.bind(self.processAlarm,self);
    self.rainCallback   = _.bind(self.processRain,self);
    
    self.controller.on('security.smoke.alarm',self.alarmCallback);
    self.controller.on('security.smoke.cancel',self.alarmCallback);
    self.controller.on('security.smoke.stop',self.alarmCallback);
    self.controller.on('rain.start',self.rainCallback);
    
    // Start check interval
    self.interval = setInterval(_.bind(self.checkConditions,self),1000*60*3);
    setTimeout(_.bind(self.initCallback,self),1000*60);
};

WindowControl.prototype.stop = function () {
    var self = this;
    
    // Remove control devices
    _.each(self.modes,function(type) {
        var key = type+'Device';
        if (typeof(self[key]) !== 'undefined') {
            self.controller.devices.remove(self[key].id);
            self[key] = undefined;
        }
    });
    
    // Remove thermostat
    if (self.config.summerActive
        && typeof(self.config.summerRules.thermostatDevice) === 'undefined') {
        self.controller.devices.remove(self.thermostatDevice.id);
    }
    self.thermostatDevice = undefined;
    
    // Reset ventilation devices
    if (self.config.ventilateActive) {
        _.each(self.ventilationControlDevices,function(deviceObject) {
            self.controller.devices.remove(deviceObject.id);
        });
        self.ventilationControlDevices = [];
    }
    
    // Stop interval
    if (typeof(self.interval) !== 'undefined') {
        clearInterval(self.interval);
        self.interval = undefined;
    }
    
    // Unbind event callbacks
    self.controller.off('security.smoke.alarm',self.alarmCallback);
    self.controller.off('security.smoke.cancel',self.alarmCallback);
    self.controller.off('security.smoke.stop',self.alarmCallback);
    
    // Unbind rain callbacks
    self.controller.off('rain.start',self.rainCallback);
    if (typeof(self.rainSensorDevice) !== 'undefined') {
        self.rainSensorDevice.off('change:metrics:level',self.rainCallback);
        self.rainSensorDevice = undefined;
    }
    
    self.alarmCallback = undefined;
    self.rainCallback = undefined;
    
    WindowControl.super_.prototype.stop.call(this);
};

WindowControl.prototype.initCallback = function() {
    var self = this;
    
    // Get all devices
    var devices = [];
    _.each(self.config.rules,function(rule) {
        devices.push(rule.devices);
    });
    self.windowDevices = _.uniq(_.flatten(devices));
    
    // Get thermostat device
    if (self.config.summerActive
        && typeof(self.config.summerRules.thermostatDevice) !== 'undefined') {
        self.thermostatDevice = self.getDevice(self.config.summerRules.thermostatDevice);
    }
    
    // Get rain sensor
    if (typeof(self.config.rainSensor) !== 'undefined') {
        self.rainSensorDevice = self.getDevice(self.config.rainSensorDevice);
        if (typeof(self.rainSensorDevice) !== 'undefined') {
            self.rainSensorDevice.on('change:metrics:level',self.rainCallback);
        }
    }
};


// ----------------------------------------------------------------------------
// --- Module methods
// ----------------------------------------------------------------------------

WindowControl.prototype.processAlarm = function(event) {
    var self = this;
    
    var presence = self.getPresenceBoolean();
    self.log('Smoke alarm');
    console.logJS(event);
    
    // TODO
    
    /*
    _.each(self.windowDevices,function(deviceId) {
        var deviceObject = self.controller.devices.get(deviceId);
        if (deviceObject === null) {
            self.error('Could not find window device '+deviceId);
            return;
        }
        if (alarm === true && present === true) {
            deviceObject.set('metrics:auto',true);
            deviceObject.performCommand('on');
        } else {
            deviceObject.set('metrics:auto',false);
        }
    });
    */
};

WindowControl.prototype.processRain = function(event) {
    var self = this;
    // TODO
    console.logJS(event);
    
    self.log('Detected rain. Closing all windows');
    self.moveDevices(self.allDevices,255);
};

WindowControl.prototype.checkRain = function () {
    var self = this;
    
    // Check rain
    if (typeof(self.rainSensorDevice) !== 'undefined') {
        var level = self.rainSensorDevice.get('metrics:level');
        if (level === 'on') {
            return true;
        }
    }
    
    return false;
};

WindowControl.prototype.checkWind = function () {
    var self = this;
    
    // Check rain
    var windDevice = self.getDevice(self.config.windSensorDevice);
    if (typeof(windDevice) !== 'undefined') {
        var windMax     = self.config.maxWind;
        var windLevel   = windDevice.get('metrics:level');
        // Check wind level
        if (typeof(windLevel) !== 'undefined'
            && windMax > windLevel) {
            return trie;
        }
    }
    
    return false;
};

WindowControl.prototype.checkConditions = function() {
    var self = this;
    
    // Check rain
    if (self.checkRain()) {
        self.log('Closing all windows due to rain');
        self.moveDevices(self.allDevices,255);
        return;
    }
    
    // Check rain
    if (self.checkWind()) {
        self.log('Closing all windows due to wind');
        self.moveDevices(self.allDevices,255);
        return;
    }
    
    _.each(self.modes,function(type) {
        if (self.config[type+'Active']
            && self[type+'Device'].get('metrics:level') === 'on') {
            self.log('Evaluating '+type+' window positions');
            self[type+'Process']();
        }
    });
};

WindowControl.prototype.winterProcess = function() {
    var self = this;
    
    self.log('Process winter rules');
    var temperatureOutsideDevice    = self.getDevice(self.config.temperatureOutsideSensorDevice);
    var temperatureOutside          = temperatureOutsideDevice.get('metrics:value');
    var now                         = Math.floor(new Date().getTime() / 1000);
    var limit                       = now - self.config.winterRules.maxOpenTime * 60;
    var targetPos                   = 100; // TODO sane targetPos
    
    _.each(self.config.zones,function(zone,index) {
        var temperatureInsideDevice = self.getDevice(zone.temperatureSensor);
        var temperatureInside = temperatureInsideDevice.get('metrics:value');
        var zoneStatus = self.winterDevice.get('metrics:zone'+index) || false;
        
        _.each(zone.windowDevices,function(deviceId) {
            var deviceObject = self.controller.devices.get(deviceId);
            if (deviceObject === null) {
                return;
            }
            var action      = 'keep';
            var deviceAuto  = deviceObject.get('metrics:auto') || false;
            var deviceLevel = deviceObject.get('metrics:level') || 0;
            var deviceMode  = deviceObject.get('metrics:windowMode') || 'none';
            var lastChange  = deviceObject.get('metrics:modificationTime') || now;
            
            // TODO sanity check
            if (temperatureOutside > (temperatureInside + 0.2)
                && deviceMode === 'none') {
                action = 'open';
                self.log('Opening window in zone '+index+' due to high outside temperature');
            } else if (deviceMode === 'winter'
                && deviceAuto === true
                && temperatureOutside <= temperatureInside) {
                action = 'close';
                self.log('Closing window in zone '+index+' after it was opened due to high outside temperature');
            } else if (deviceAuto === true
                && deviceLevel > 0
                && lastChange < limit) {
                action = 'close';
                self.log('Closing window in zone '+index+' max winter open time');
            }
            
            if (action === 'close') {
                deviceObject.performCommand('off');
                deviceObject.set('metrics:windowMode','none');
                deviceObject.set('metrics:auto',false);
            } else if (action === 'open') {
                deviceObject.performCommand('exact', { level: targetPos });
                deviceObject.set('metrics:windowMode','winter');
                deviceObject.set('metrics:auto',true );
            }
        });
    });
};

WindowControl.prototype.summerProcess = function() {
    var self = this;
    
    // TODO
};

WindowControl.prototype.ventilateProcess = function() {
    var self = this;
    
    // TODO
};
   
   
/*

    
    // Get desired temperature
    var thermostatLevel = self.getDevice('thermostat');
    if (typeof(thermostatLevel) === 'undefined') {
        self.error('Cannot find thermostat device');
        return;
    }
    
    // Set window position to 100%
    var position    = 100;
    
    // Get window position based on POP
    if (typeof(self.currentDevice) !== 'undefined') {
        var pop         = self.currentDevice.get('metrics:pop');
        var condition   = self.currentDevice.get('metrics:condition');
        if (pop > 50
            && condition !== 'clear'
            && condition !== 'mostlysunny') {
            position = position - pop + 30;
        }
    }
    
    // Get window position based on wind
    if (windLevel >= (windMax / 2)) {
        var windSteps       = (windMax / 2);
        var maxPosition     = (windLevel-windSteps) / windSteps * 100;
        maxPosition         = Math.max(25,maxPosition);
        position            = Math.min(position,maxPosition);
    }
    
    
    // Winter mode
    // Summer mode
    
    
        -- Temp calulations for summer
        local mode = "default"
        if data.season == "summer" then
            if weather_status.low < (WINDOWS.MIN_TEMPERATURE_OUTSIDE - 4) then
                mode = "low"
                temperature_open = data.setpoint + 1.25
                temperature_close = data.setpoint + 0.25
                -- TODO different values for end of summer?
            elseif weather_status.high > (data.setpoint + 3)
                and weather_status.low > (data.setpoint - 8) then
                mode = "high"
                local temperature_delta     = weather_status.high - data.setpoint
                temperature_close           = temperature_close - (temperature_delta/3)
                temperature_open            = temperature_open - (temperature_delta/3)
                temperature_close           = math.max(temperature_close,TEMPERATURE.DEFAULT+1.5)
                temperature_open            = math.max(temperature_open,TEMPERATURE.DEFAULT+2.5)
            end
        end
        
        local temperature_diff = 0
        local min_temperature = WINDOWS.MIN_TEMPERATURE_OUTSIDE
        
        -- Evening mode
        if datetable.hour >= 19 then
            temperature_diff = 1
        -- Night mode during warm days
        elseif mode == "high" and datetable.hour <= 6 then
            min_temperature = min_temperature - 1
            temperature_diff = 1
            temperature_open = temperature_open - 0.5
            temperature_close = temperature_close - 0.5
        -- Strong sun mode
        elseif weather_status.uv >= 5
            or weather_status.solar > 600 then
            temperature_diff = -1
        end
        
        -- Home and cool
        if data.statuskey == 'HOME'
            and weather_status.temperature < data.setpoint then
            min_temperature = min_temperature + 1
            temperature_diff = temperature_diff - 1
        -- Away and hot
        elseif data.statuskey == 'AWAY'
            and mode == "high" then
            temperature_open = temperature_open - 0.5
            temperature_close = temperature_close - 0.5
            temperature_diff = temperature_diff + 0.5
        -- Home and heatwave
        elseif data.statuskey == 'HOME'
            and mode == "high"
            and weather_status.high > (TEMPERATURE.MAX + 6) then
            min_temperature = min_temperature - 1
            temperature_diff = temperature_diff + 0.5
        end
        
        -- Mode
        if mode == "high" then
            min_temperature = min_temperature - 1
            temperature_diff = temperature_diff + 0.5
            luup.log('[MyHome] High temperature windows mode (Open>='..temperature_open..', Close<'..temperature_close..')')
        elseif mode == "low" then
            luup.log('[MyHome] Low temperature windows mode (Open>='..temperature_open..', Close<'..temperature_close..')')
        else
            luup.log('[MyHome] Default windows mode (Open>='..temperature_open..', Close<'..temperature_close..')')
        end
        
        -- Get rooms
        local rooms_set = {}
        for index,device_id in pairs(devices_search({ ["class"] = "Window" })) do
            local room_num = tonumber(device_attr(device_id,"room_num"))
            rooms_set[room_num] = true
        end
        
        -- Loop rooms
        for room_num,_ in pairs(rooms_set) do
            local room_name = luup.rooms[room_num]
            local temperature_inside = temperature_room(room_num)
            local room_action = "keep"
            local room_position = position
            luup.log('[MyHome] Processing windows in room ' .. room_name)
            
            -- Winter mode 
            if data.season == "winter"
                or datetable.month >= 10 
                or datetable.month <= 3 then
                -- Outside warmer than inside
                if temperature_inside < weather_status.temperature then
                    room_position = math.min(room_position,50)
                    luup.log("[MyHome] Opening all windows in "..room_name.." to "..open_position.."% (Winter mode; inside temperature "..weather_status.inside.." lower than outside temperature "..weather_status.temperature..")")
                    room_action = "open"
                -- Inside warmer than outside (1 degree diff)
                elseif temperature_inside >= (weather_status.temperature + 1) then
                    luup.log("[MyHome] Closing all windows in "..room_name.." (Winter mode; Outside temperature low)")
                    room_action = "close"
                end
            -- Summer mode 
            else
                -- Corridor
                if weather_status.temperature < data.setpoint
                    and weather_status.low < TEMPERATURE.NIGHT
                    and temperature_inside < (data.setpoint + 3) then
                    local corridor = (weather_status.temperature - min_temperature) / (data.setpoint - min_temperature + 1) * 100
                    if corridor > 60 then
                        corridor = corridor - 10
                    end
                    room_position = math.min(room_position,corridor)
                    if position > room_position then
                        luup.log("[MyHome] Corridor reduced to "..room_position.."% from "..position.."%")
                    end
                end
                
                luup.log("[MyHome] Inside="..temperature_inside..", Outside="..weather_status.temperature..", Position="..room_position..", Diff="..temperature_diff..", Min="..min_temperature);
                
                -- Handle zero or negative position
                if room_position <= 0 then
                    room_position = 0
                    luup.log("[MyHome] Closing all windows in "..room_name.." (temperature corridor + pop "..weather_status.pop..")")
                    room_action = "close"
                -- Warmer inside -> open
                elseif temperature_inside >= temperature_open
                    and (temperature_inside + temperature_diff - 0.5) >= weather_status.temperature then
                    luup.log("[MyHome] Opening all windows in "..room_name.." to "..room_position.."% (inside temperature "..temperature_inside.." above outside temperature "..weather_status.temperature..")")
                    room_action = "open"
                -- Cool inside -> close
                elseif temperature_inside <= temperature_close then
                    luup.log("[MyHome] Closing all windows in "..room_name.." (inside temperature "..temperature_inside.." below "..temperature_close..")")
                    room_action = "close"
                -- Warmer outside -> close
                elseif (temperature_inside + temperature_diff + 0.5) <= weather_status.temperature then
                    luup.log("[MyHome] Closing all windows in "..room_name.." (inside temperature "..temperature_inside.."+0.5 below outside temperature "..weather_status.temperature..")")
                    room_action = "close"
                end
            end
            
            if room_action == "keep" then
                luup.log("[MyHome] Not changing window status")
            end
            
            if room_position > 0 and room_position < 20 then
                room_position = 20
            end
            
            -- TODO enable actions
            for index,device_id in pairs(devices_search({ ["class"] = "Window", ["room_num"] = room_num })) do
                device_auto_move(device_id,room_action,room_position)
            end
        end

     */

WindowControl.prototype.getDevice = function(deviceId) {
    var self = this;
    
    if (typeof(deviceId) === 'undefined') {
        return;
    }
    var deviceObject = self.controller.devices.get(deviceId);
    if (deviceObject === null) {
        self.error('Could not find '+deviceId+' device');
        return;
    }
    return deviceObject;
};

WindowControl.prototype.commandModeDevice = function(type,command,args) {
    var self = this;
    
    var device = self[type+'Device'];
    if (command !== 'on' && command !== 'off')
        return;
    
    // Turn off other device
    if (command === 'on') {
        if (type === 'winter' && self.config.summerActive) {
            self.summerDevice.performCommand('off');
        } else if (type === 'summer' && self.config.winterActive) {
            self.summerDevice.performCommand('off');
        }
    }
    
    device.set('metrics:level',command);
    device.set("metrics:icon", "/ZAutomation/api/v1/load/modulemedia/WindowControl/icon_"+type+"_"+command+".png");

};

WindowControl.prototype.commandVentilateZone = function(zone,args) {
    var self            = this;
    args                = args || {};
    var forceVentilate  = args.force || false;
    var duration        = args.duration;
    var last            = args.last || 60;
    
    // Check wind & rain
    if (self.checkRain() || self.checkWind()) {
        self.log('Ignoring ventilation due to wind/rain');
        return;
    }
    
    if (typeof(duration) === 'undefined') {
        // TODO calulate duration
    }
    
    self.processDeviceList(self.config.zones[zone].windowSensors,function(deviceObject) {
        // TODO Get window status
    });
    
    self.processDeviceList(self.config.zones[zone].windowDevices,function(deviceObject) {
        var deviceAuto  = deviceObject.get('metrics:auto') || false;
        var deviceLevel = deviceObject.get('metrics:level') || 0;
        var deviceMode  = deviceObject.get('metrics:windowMode') || 'none';
        var lastChange  = deviceObject.get('metrics:modificationTime') || now;
        
        // TODO
    });
    
    // TODO
};

WindowControl.prototype.moveDevices = function(devices,position) {
    var self = this;
    
    _.each(devices,function(deviceId) {
        var deviceObject = self.controller.devices.get(deviceId);
        if (deviceObject === null) {
            self.error('Could not find window device '+deviceId);
            return;
        }
        var deviceAuto = deviceObject.get('metrics:auto');
        if ((position < 255 && deviceAuto === false) || (position === 255 && deviceAuto === true)) {
            return;
        }
        self.error('Auto move window '+deviceId+' to '+position);
        if (position < 255) {
            deviceObject.set('metrics:auto',true);
            deviceObject.performCommand('on');
        } else if (position >= 255) {
            deviceObject.set('metrics:auto',false);
            deviceObject.performCommand('off');
        } else {
            deviceObject.set('metrics:auto',true);
            deviceObject.performCommand('exact',{ level: position });
        }
    });
};