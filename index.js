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
    
    this.allDevices             = [];
    this.modes                  = ['summer','winter','ventilate'];
    _.each(this.modes,function(type) {
        this[type+'Device'] = undefined;
    });
    
    this.thermostatDevice       = undefined;
    this.rainSensorDevice       = undefined;
    this.conditionDevice        = undefined;
    this.forecastDevice         = undefined;
    this.alarmCallback          = undefined;
    this.rainCallback           = undefined;
    this.interval               = undefined;
    
}

inherits(WindowControl, BaseModule);

_module = WindowControl;

// ----------------------------------------------------------------------------
// --- Module instance initialized
// ----------------------------------------------------------------------------

WindowControl.prototype.init = function (config) {
    WindowControl.super_.prototype.init.call(this, config);

    var self = this;
    
    // Create vdev
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
                handler: _.bind(self.commandDevice,self,type),
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
        && typeof(self.config.thermostatDevice) === 'undefined') {
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
            moduleId: this.id
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
    
    // Remove devices
    _.each(self.modes,function(type) {
        var key = type+'Device';
        if (typeof(self[key]) !== 'undefined') {
            self.controller.devices.remove(self[key].id);
            self[key] = undefined;
        }
    });
    
    // Setup thermostat
    if (typeof(self.config.thermostatDevice) === 'undefined') {
        self.controller.devices.remove(self.thermostatDevice.id);
    }
    self.thermostatDevice = undefined;
    
    // Stop interval
    if (typeof(self.interval) !== 'undefined') {
        clearInterval(self.interval);
        self.interval = undefined;
    }
    
    // Unbind event callbacks
    self.controller.off('security.smoke.alarm',self.alarmCallback);
    self.controller.off('security.smoke.cancel',self.alarmCallback);
    self.controller.off('security.smoke.stop',self.alarmCallback);
    
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
    self.allDevices = _.uniq(_.flatten(devices));
    
    // Get thermostat device
    if (typeof(self.config.thermostatDevice) !== 'undefined') {
        self.thermostatDevice = self.getDevice('thermostat');
    }
    
    // Get rain sensor
    if (typeof(self.config.rainSensor) !== 'undefined') {
        self.rainSensorDevice = self.getDevice('rainSensor');
        if (typeof(self.rainSensorDevice) !== 'undefined') {
            self.rainSensorDevice.on('change:metrics:level',self.rainCallback);
        }
    }
    
    // Get all devices
    self.controller.devices.each(function(vDev) {
        var deviceType  = vDev.get('deviceType');
        var probeTitle  = vDev.get('metrics:probeTitle');
        if (deviceType === 'sensorMultilevel'
            && probeTitle === 'WeatherUndergoundForecast') {
            self.forecastDevice = vDev;
        } else if (deviceType === 'sensorMultilevel'
            && probeTitle === 'WeatherUndergoundCurrent') {
            self.conditionDevice = vDev;
        }
    });
};


// ----------------------------------------------------------------------------
// --- Module methods
// ----------------------------------------------------------------------------

WindowControl.prototype.processAlarm = function(event) {
    var self = this;
    
    var alarmed = true;
    
    var presence = self.getPresenceBoolean();
    self.controller.devices.each(function(vDev) {
        var probeTitle = vDev.get('metrics:probeTitle');
        var probeType = vDev.get('probeType');
        if (probeTitle === 'security'
            && vDev.get('metrics:securityType') === 'smoke') {
            var state = vDev.get('metrics:state');
            if (state !== 'alarm' || state !== 'timeout') {
                alarmed = false;
            }
        }
    });
    
    if (alarmed) {
        console.log('[WindowControl] Opening all windows due to smoke alarm');
    }
    
    _.each(self.allDevices,function(deviceId) {
        var deviceObject = self.controller.devices.get(deviceId);
        if (deviceObject === null) {
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
    
    if (typeof(self.rainSensorDevice) !== 'undefined') {
        var level = self.rainSensorDevice.get('metrics:level');
        if (level === 'off') {
            return;
        }
    }
    
    console.log('[WindowControl] Detected rain. Closing all windows');
    
    self.moveDevices(self.allDevices,255);
};

WindowControl.prototype.checkConditions = function() {
    var self = this;

    console.log('[WindowControl] Evaluating window positions');
    if (self.vDev.get('metrics:level') === 'off') {
        return;
    }
    
    // Check rain
    if (typeof(self.rainSensorDevice) !== 'undefined') {
        var level = self.rainSensorDevice.get('metrics:level');
        if (level === 'on') {
            console.log('[WindowControl] Closing all windows due to rain');
            self.moveDevices(self.allDevices,255);
            return;
        }
    }
    
    // Check wind level
    var windLevel   = self.getDeviceData('windSensor');
    var windMax     = self.config.maxWind;
    if (typeof(windLevel) !== 'undefined'
        && windMax > windLevel) {
        console.log('[WindowControl] Closing all windows due to wind');
        self.moveDevices(self.allDevices,255);
        return;
    }
    
    // Get desired temperature
    var thermostatLevel = self.getDeviceData('thermostat');
    if (typeof(thermostatLevel) === 'undefined') {
        console.error('[WindowControl] Cannot find thermostat device');
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
    
    /*
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
};

WindowControl.prototype.getDevice = function(type) {
    var self = this;
    
    var deviceId = self.config[type+'_device'];
    if (typeof(deviceId) === 'undefined') {
        self.error('Could not find '+type+' device');
        return;
    }
    var deviceObject = self.controller.devices.get(deviceId);
    return deviceObject;
};

WindowControl.prototype.getDeviceData = function(type) {
    var self = this;
    
    var deviceObject = self.getDevice(type);
    if (deviceObject === null) {
        return;
    }
    return deviceObject.get('metrics:level');
};

WindowControl.prototype.moveDevices = function(devices,position) {
    var self = this;
    
    _.each(devices,function(deviceId) {
        var deviceObject = self.controller.devices.get(deviceId);
        if (deviceObject === null) {
            console.error('[WindowControl] Could not find window device '+deviceId);
            return;
        }
        var deviceAuto = deviceObject.get('metrics:auto');
        if ((position < 255 && deviceAuto === false) || (position === 255 && deviceAuto === true)) {
            return;
        }
        console.error('[WindowControl] Auto move window '+deviceId+' to '+position);
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