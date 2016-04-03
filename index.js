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
    this.cronName                   = undefined;
}

inherits(WindowControl, BaseModule);

_module = WindowControl;

// ----------------------------------------------------------------------------
// --- Module instance initialized
// ----------------------------------------------------------------------------

WindowControl.prototype.init = function (config) {
    WindowControl.super_.prototype.init.call(this, config);

    var self = this;
    self.cronName = "WindowControl.ventilate."+self.id;
    
    // Create control devices
    _.each(self.modes,function(type) {
        if (self.config[type+'Active'] === true) {
            self[type+'Device'] = this.controller.devices.create({
                deviceId: "WindowControl_"+type+'_'+ self.id,
                defaults: {
                    metrics: {
                        active: [],
                        title: self.langFile[type+'_title'],
                        level: 'off',
                        icon: self.imagePath+'/icon_'+type+'_off.png'
                    }
                },
                handler: _.bind(self.commandModeDevice,self,type),
                overlay: {
                    probeType: 'controller_window_'+type,
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
                    title: self.langFile.target_temperature_title
                },
            },
            overlay: {
                probeType: 'thermostat_set_point',
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
    
    // Setup ventilation scenes
    if (self.config.ventilationActive) {
        self.controller.on(self.cronName,_.bind(self.processVentilate,self));
        
        // Set ventilation times
        _.each(self.config.ventilationRules.time,function(time) {
            var parsedTime = self.parseTime(time);
            self.controller.emit("cron.addTask",self.cronName, {
                minute:     parsedTime.getMinutes(),
                hour:       parsedTime.getHours(),
                weekDay:    null,
                day:        null,
                month:      null,
            });
        });
        
        _.each(self.config.zones,function(zone,index) {
            self.log('Create ventilation device for '+index);
            self.ventilationControlDevices.push(
                self.controller.devices.create({
                    deviceId: "WindowControl_Ventilate_" + self.id+'_Zone'+index,
                    defaults: {
                        metrics: {
                            level: 'off',
                            title: self.langFile.ventilation_title+' '+index,
                            icon: self.imagePath+"/icon_ventilate.png"
                        },
                    },
                    overlay: {
                        probeType: 'scene_ventilate',
                        deviceType: 'toggleButton'
                    },
                    handler: function(command, args) {
                        if (command === 'on') {
                            args = args || {};
                            if (typeof(args.force) === 'undefined') {
                                args.force = true;
                            }
                            if (typeof(args.last) === 'undefined') {
                                args.last = 0;
                            }
                            return self.processVentilateZone(index,args);
                        }
                    },
                    moduleId: self.id
                })
            );
        });
    }
    
    // Setup event callbacks
    self.alarmCallback      = _.bind(self.processAlarm,self);
    self.rainCallback       = _.bind(self.processRain,self);
    self.ventilateCallback  = _.bind(self.processVentilate,self);
    
    self.controller.on('security.smoke.alarm',self.alarmCallback);
    self.controller.on('security.smoke.stop',self.alarmCallback);
    self.controller.on('rain.start',self.rainCallback);
    self.controller.on(self.cronName,self.ventilateCallback);
    
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
    if (self.config.ventilationActive) {
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
    self.controller.off('security.smoke.stop',self.alarmCallback);
    
    // Unbind rain callbacks
    self.controller.off('rain.start',self.rainCallback);
    if (typeof(self.rainSensorDevice) !== 'undefined') {
        self.rainSensorDevice.off('change:metrics:level',self.rainCallback);
        self.rainSensorDevice = undefined;
    }
    
    // Remove cron
    self.controller.emit("cron.removeTask", self.cronName);
    self.controller.off(self.cronName,self.ventilateCallback);
    
    // Reset callbacks
    self.alarmCallback      = undefined;
    self.rainCallback       = undefined;
    self.ventilateCallback  = undefined;
    
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
    
    self.checkDevices();
    
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
    
    self.log('Detected rain. Closing all windows');
    self.moveDevices(self.allDevices,0,'none');
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
    var windLevel   = self.getDeviceValue(self.config.windSensorDevice);
    var windMax     = self.config.maxWind;
    if (typeof(windLevel) !== 'undefined'
        && windLevel > windMax) {
        return true;
    }
    
    return false;
};

WindowControl.prototype.checkConditions = function() {
    var self = this;
    
    self.checkDevices();
    
    // Check rain
    if (self.checkRain()) {
        self.log('Closing all windows due to rain');
        self.moveDevices(self.allDevices,0,'none');
        return;
    }
    
    // Check rain
    if (self.checkWind()) {
        self.log('Closing all windows due to wind');
        self.moveDevices(self.allDevices,0,'none');
        return;
    }
    
    _.each(['winter','summer'],function(type) {
        if (self.config[type+'Active']
            && self[type+'Device'].get('metrics:level') === 'on') {
            self.log('Evaluating '+type+' window positions');
            var uctype = type.charAt(0).toUpperCase() + type.slice(1);
            self['process'+uctype]();
        }
    });
};

WindowControl.prototype.checkDevices = function() {
    var self = this;
    var now  = Math.floor(new Date().getTime() / 1000);

    // Check ventilate
    _.each(self.config.zones,function(zone,zoneIndex) {
        var controlDevice = self.ventilationControlDevices[zoneIndex];
        var offTime = controlDevice.get('metrics:offTime');
        if (self.config.ventilationActive
            && controlDevice.get('metrics:level') === 'on'
            && typeof(offTime) === 'number' 
            && offTime < now) {
            self.processStopVentilate(zoneIndex);
        }
    });
    
    // Check off time & mode
    _.each(self.windowDevices,function(deviceObject) {
        var offTime     = deviceObject.get('metrics:offTime');
        var level       = deviceObject.get('metrics:level');
        var auto        = deviceObject.get('metrics:auto');
        var deviceMode  = deviceObject.get('metrics:windowMode') || 'none';
        if (typeof(offTime) === 'number' 
            && offTime < now
            && level > 0
            && auto === true) {
            self.log('Close window after off time '+deviceObject.id);
            self.moveDevices(deviceObject,0,'none');
        } else if (level === 0
            && (auto === true || deviceMode !== 'none')) {
            self.log('Fix device mode mismatch');
            deviceObject.set('metrics:windowMode','none');
            deviceObject.set('metrics:auto',false);
        }
    });
};

WindowControl.prototype.processWinter = function() {
    var self = this;
    
    var temperatureOutside  = self.getDeviceValue(self.config.temperatureOutsideSensorDevice);
    var now                 = Math.floor(new Date().getTime() / 1000);
    var limit               = now - self.config.winterRules.maxOpenTime * 60;
    var targetPos           = 100; // TODO sane targetPos
    
    _.each(self.config.zones,function(zone,index) {
        var temperatureInside = self.getTemperatureZone(zone);
        
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
            
            if (temperatureOutside > (temperatureInside + 0.2)
                && deviceMode === 'none') {
                action = 'open';
                self.log('Opening window in zone '+index+' due to high outside temperature');
            } else if (deviceMode === 'winter'
                && deviceAuto === true
                && deviceLevel > 0
                && temperatureOutside < temperatureInside) {
                action = 'close';
                self.log('Closing window in zone '+index+' after it was opened due to high outside temperature');
            } else if (deviceAuto === true
                && deviceLevel > 0
                && lastChange < limit
                && temperatureOutside < temperatureInside) {
                action = 'close';
                self.log('Closing window in zone '+index+' max winter open time');
            } else {
                self.log('Not moving window in zone '+index+'. Outside:'+ temperatureOutside+' Inside:'+temperatureInside+' Mode:'+deviceMode+' Level:'+deviceLevel);
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

WindowControl.prototype.processSummer = function() {
    var self = this;
    
    var forecastLow, forecastHigh;
    var temperatureOutside  = self.getDeviceValue(self.config.temperatureOutsideSensorDevice);
    var thermostatSetpoint  = self.thermostatDevice.get('metrics:value');
    var windLevel           = self.getDeviceValue(self.config.windSensorDevice);
    var windMax             = self.config.maxWind;
    var minTemperature      = self.config.summerRules.minTemperatureOutside;
    var conditionDevice     = self.getDevice([['probeType','=','condition']]);
    var forecastDevice      = self.getDevice([['probeType','=','forecast']]);
    var windowPosition      = 100;
    var operationMode       = 'default';
    var temperatureDiff     = 0;
    var temperatureOpen     = thermostatSetpoint + self.toUnit(0.25);
    var temperatureClose    = thermostatSetpoint - self.toUnit(0.75);
    var now                 = new Date(Date.now());
    var presence            = self.getDeviceValue([['probeType','=','presence']]);
    
    // Warn about missing devices
    if (typeof(conditionDevice) === 'undefined' 
        || typeof(forecastDevice) === 'undefined') {
        self.log('Forecast and condition device not found. Please install the WeatherUnderground or ForecastIO module to improve window operation');
    }
    if (typeof(presence) === 'undefined') {
        self.log('Presence device not found. Please install the Presence module to improve window operation');
    }
    
    // Calculate window position based on POP
    if (typeof(conditionDevice) !== 'undefined') {
        var pop             = conditionDevice.get('metrics:pop');
        var condition       = conditionDevice.get('metrics:conditiongroup');
        if (pop > 50
            && condition !== 'fair') {
            windowPosition = windowPosition - pop + 30;
        }
    }
    
    // Calculate window position based on wind
    if (windLevel >= (windMax / 2)) {
        var windSteps       = (windMax / 2);
        var maxPosition     = (windLevel - windSteps) / windSteps * 100;
        maxPosition         = Math.max(25,maxPosition);
        windowPosition      = Math.min(windowPosition,maxPosition);
    }
    
    // Calculate window open/close thresholds
    if (typeof(forecastDevice) !== 'undefined') {
        forecastLow = forecastDevice.get('metrics:low');
        forecastHigh = forecastDevice.get('metrics:high');
    // Try to guess forecast
    } else {
        // TODO now.getHour()
    }
        
    // Low temperature mode for end of summer
    if (forecastLow < (minTemperature - self.toUnit(4))) {
        operationMode           = "low";
        temperatureOpen         = thermostatSetpoint + self.toUnit(1.25);
        temperatureClose        = thermostatSetpoint + self.toUnit(0.25);
    // High temperature mode for heatwaves
    } else if (forecastHigh > (thermostatSetpoint + self.toUnit(3))
        &&  forecastLow > (thermostatSetpoint - self.toUnit(8))) {
        operationMode           = "high";
        var temperatureDelta    = forecastHigh - thermostatSetpoint;
        temperatureOpen         = temperatureOpen - (temperatureDelta/3);
        temperatureClose        = temperatureClose - (temperatureDelta/3);
        temperatureOpen         = Math.max(temperatureOpen,thermostatSetpoint - self.toUnit(2));
        temperatureClose        = Math.max(temperatureClose,thermostatSetpoint - self.toUnit(3));
        minTemperature          = minTemperature - self.toUnit(1);
        temperatureDiff         = temperatureDiff + self.toUnit(0.5);
    }
    
    // Evening mode
    if (now.getHours() >= 20) {
        temperatureDiff         = temperatureDiff + self.toUnit(1);
    // Night mode during warm days
    } else if (operationMode == "high" && now.getHours() <= 6) {
        minTemperature          = minTemperature - self.toUnit(1);
        temperatureDiff         = temperatureDiff + self.toUnit(1);
        temperatureOpen         = temperatureOpen - self.toUnit(0.5);
        temperatureClose        = temperatureClose - self.toUnit(0.5);
    // Strong sun mode
    } else if (typeof(conditionDevice) !== 'undefined') {
        var uv = conditionDevice.get('metrics:uv');
        if (typeof(uv) !== 'undefined'
            && uv > 6) {
            temperatureDiff = temperatureDiff - self.toUnit(1);
        }
    }
    
    if (typeof(presence) === 'undefined') {
        // Home and cool
        if (presence === 'on'
            && temperatureOutside < thermostatSetpoint) {
            minTemperature      = minTemperature + self.toUnit(1);
            temperatureDiff     = temperatureDiff - self.toUnit(1);
        // Away and hot
        } else if (presence === 'off'
            && operationMode === 'high') {
            temperatureOpen     = temperatureOpen - self.toUnit(0.5);
            temperatureClose    = temperatureClose - self.toUnit(0.5);
            temperatureDiff     = temperatureDiff + self.toUnit(0.5);
        // Home and heatwave
        } else if (presence === 'on'
            && operationMode == "high"
            && forecastHigh > (thermostatSetpoint + self.toUnit(6))) {
            minTemperature      = minTemperature - self.toUnit(1);
            temperatureDiff     = temperatureDiff + self.toUnit(0.5);
        }
    }
    
    // Mode
    self.log(operationMode+' temperature windows mode (Open>='+temperatureOpen+', Close<'+temperatureClose+')');
    
    // Process zones
    _.each(self.config.zones,function(zone,index) {
        var temperatureInside   = self.getTemperatureZone(zone);
        var roomAction          = 'keep';
        var zonePosition        = windowPosition;
        // Corridor
        if (temperatureOutside < thermostatSetpoint
            && forecastLow < TEMPERATURE.NIGHT
            && temperatureInside < (thermostatSetpoint + self.toUnit(3))) {
            var corridor = (temperatureOutside - minTemperature) / (thermostatSetpoint - minTemperature + self.toUnit(1)) * 100;
            if (corridor > 60) {
                corridor = corridor - 10;
            }
            zonePosition = Math.min(zonePosition,corridor);
            if (position !== zonePosition) {
                self.log("Corridor reduced to "+zonePosition+"% from "+position+"%");
            }
        }
        
        self.log("Inside="+temperatureInside+", Outside="+temperatureOutside+", Position="+zonePosition+", Diff="+temperatureDiff+", Min="+minTemperature);
        
        // Handle zero or negative position
        if (zonePosition <= 0) {
            zonePosition = 0;
            self.log("Closing all windows in zone "+index+" (temperature corridor + pop)");
            zoneAction = "close";
        // Warmer inside -> open
        } else if (temperatureInside >= temperatureOpen
            && (temperatureInside + temperatureDiff - 0.5) >= temperatureOutside) {
            self.log("Opening all windows in zone "+index+" to "+zonePosition+"% (inside temperature "+temperatureInside+" above outside temperature "+temperatureOutside+")");
            zoneAction = "open";
        // Cool inside -> close
        } else if (temperatureInside <= temperatureClose) {
            self.log("Closing all windows in zone "+index+" (inside temperature "+temperatureInside+" below "+temperatureClose+")");
            zoneAction = "close";
        // Warmer outside -> close
        } else if ((temperatureInside + temperatureDiff + 0.5) <= temperatureOutside) {
            self.log("Closing all windows in zone "+index+" (inside temperature "+temperatureInside+"+0.5 below outside temperature "+temperatureOutside+")");
            zoneAction = "close";
        }
        
        if (zoneAction == "keep") {
            self.log("Not changing window status");
        } else {                
            zonePosition = Math.max(zonePosition,20);
            _.each(zone.windowDevices,function(deviceId) {
                var deviceObject = self.controller.devices.get(deviceId);
                
                if (deviceObject === null) {
                    return;
                }
                
                var deviceAuto  = deviceObject.get('metrics:auto') || false;
                var deviceLevel = deviceObject.get('metrics:level') || 0;
                var deviceMode  = deviceObject.get('metrics:windowMode') || 'none';
                var lastChange  = deviceObject.get('metrics:modificationTime') || now;
                
                if (zoneAction === 'close'
                    && deviceAuto === true
                    && deviceMode === 'summer') {
                    self.log('Closing window '+deviceObject.id);
                    //deviceObject.performCommand('off');
                    //deviceObject.set('metrics:windowMode','none');
                    //deviceObject.set('metrics:auto',false);
                } else if (zoneAction === 'open'
                    && deviceAuto === false
                    && deviceMode === 'none') {
                    self.log('Opening window '+deviceObject.id);
                    //deviceObject.performCommand('exact', { level: zonePosition });
                    //deviceObject.set('metrics:windowMode','summer');
                    //deviceObject.set('metrics:auto',true );
                }
            });
        }
    });
    
};

WindowControl.prototype.processVentilate = function() {
    var self = this;
    
    // Check virtual device
    if (self.ventilationDevice.get('metrics:level') !== 'on') {
        self.log('Ventilation is disabled');
        return;
    }
    
    var temperatureOutside = self.getDeviceValue(self.config.temperatureOutsideSensorDevice);
    
    // Check wind, rain & temperature
    if (self.checkRain() 
        || self.checkWind()
        || temperatureOutside < self.config.ventilationRules.minTemperatureOutside) {
        self.log('Ignoring ventilation due to wind/rain/low temperature');
        return;
    }
    
    // Ventilate zones
    _.each(self.config.zones,function(zoneConfig,zoneIndex) {
        self.processVentilateZone(zoneIndex);
    });
};

WindowControl.prototype.processVentilateZone = function(zoneIndex,args) {
    var self                = this;
    args                    = args || {};
    var forceVentilate      = args.force || false;
    var duration            = args.duration;
    var lastVentilationDiff = args.last || self.config.ventilationRules.interval;
    lastVentilationDiff     = lastVentilationDiff * 60;
    var windowPosition      = args.position || self.config.ventilationRules.windowPosition || 50;
    var now                 = Math.floor(new Date().getTime() / 1000);
    var controlDevice       = self.ventilationControlDevices[zoneIndex];
    
    // Check wind & rain
    if (self.checkRain() || self.checkWind()) {
        self.log('Ignoring ventilation due to wind/rain');
        return;
    }
    
    // Calc duration
    if (typeof(duration) === 'undefined') {
        var temperatureOutside  = self.getDeviceValue(self.config.temperatureOutsideSensorDevice);
        var temperatureInside   = self.getTemperatureZone(self.config.zones[zoneIndex]);
        var temperatureMin      = self.config.ventilationRules.minTemperatureOutside;
        var durationDiff        = self.config.ventilationRules.maxTime - self.config.ventilationRules.minTime;
        
        if (temperatureOutside < temperatureMin) {
            if (! forceVentilate) {
                return;
            }
            duration = 0;
        } else {
            var tempDiff = (temperatureOutside - temperatureMin);
            var tempGradient = (temperatureInside - temperatureMin);
            var timeDiff = tempDiff / tempGradient;
            timeDiff = Math.min(Math.max(timeDiff,0),1);
            duration = timeDiff * durationDiff;
        }
        
        duration = self.config.ventilationRules.minTime + duration;
        self.log('Calculated duration '+duration+' minutes');
    }
    var offTime = now + (duration * 60);
    
    if (forceVentilate === false) {
        var ventilating;
        var lastVentilation = [];
        
        // Get all window sensors
        self.processDeviceList(self.config.zones[zoneIndex].windowSensors,function(deviceObject) {
            if (deviceObject.get('metrics:level') === 'on') {
                self.log('Zone '+zoneIndex+' already ventilated - sensor. Skipping');
                ventilating = true;
            } else {
                lastVentilation.push(deviceObject.get('metrics:modificationTime'));
            }
        });
        
        if (ventilating) return;
        
        // Get all window sensors
        self.processDeviceList(self.config.zones[zoneIndex].windowDevices,function(deviceObject) {
            if (deviceObject.get('metrics:level') > 0) {
                self.log('Zone '+zoneIndex+' already ventilated - window. Skipping');
                ventilating = true;
            } else {
                lastVentilation.push(deviceObject.get('metrics:modificationTime'));
            }
        });
        
        if (ventilating) return;
        
        lastVentilation.sort(function(a,b) { return b-a; });
        var lastMinutes = parseInt(((new Date()).getTime() / 1000 - lastVentilation[0]) / 60,10);
        
        if (lastMinutes < lastVentilationDiff) {
            self.log("Last ventilation "+lastMinutes+" minutes ago. Skipping");
            return;
        }
    }
    
    self.log('Ventilate zone '+zoneIndex+' for '+duration+' minutes');
    
    controlDevice.set('metrics:offTime',offTime);
    controlDevice.set('metrics:level','on');
    controlDevice.set('metrics:icon',self.imagePath+"/icon_ventilate_on.png");
    
    self.processDeviceList(self.config.zones[zoneIndex].windowDevices,function(deviceObject) {
        var deviceAuto  = deviceObject.get('metrics:auto') || false;
        var deviceLevel = deviceObject.get('metrics:level') || 0;
        var deviceMode  = deviceObject.get('metrics:windowMode') || 'none';
        
        if ((deviceMode !== 'none' || deviceAuto === true) && deviceLevel > 0)  {
            self.log('Skipping window '+deviceObject.id+' Current mode:'+ deviceMode+', Auto:'+deviceAuto);
            return;
        }
        
        self.moveDevices(deviceObject,windowPosition,'ventilate',offTime);
    });
    
    setTimeout(_.bind(self.processStopVentilate,self,zoneIndex),(duration * 60 * 1000));
    
    return duration * 60;
};

WindowControl.prototype.processStopVentilate = function(zoneIndex) {
    var self = this;
    self.log('Stop ventilate zone '+zoneIndex);
    var controlDevice = self.ventilationControlDevices[zoneIndex];
    
    self.moveDevices(self.config.zones[zoneIndex].windowDevices,0,'none');
    controlDevice.set('metrics:offTime',undefined);
    controlDevice.set('metrics:icon',self.imagePath+"/icon_ventilate.png");
    controlDevice.set('metrics:level',"off");
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
    
    // TODO close all windows that were opened based on this controller
    
    device.set('metrics:level',command);
    device.set("metrics:icon", self.imagePath+"/icon_"+type+"_"+command+".png");
};

WindowControl.prototype.getTemperatureZone = function(zone) {
    var self = this;
    
    if (typeof(zone) === 'number') {
        zone = self.config.zones[zone];
    }
    
    if (typeof(zone) === 'object') {
        var temperature = self.getDeviceValue(zone.temperatureSensorDevice);
        if (typeof(temperature) !== 'undefined') {
            if (self.config.unitTemperature === 'celsius') {
                temperature = Math.min(temperature,40); // Max 40 degrees
                temperature = Math.max(temperature,5); // Min 5 degrees
            } else if (self.config.unitTemperature === 'fahrenheit') {
                temperature = Math.min(temperature,105 ); // Max 105 degrees
                temperature = Math.max(temperature,40); // Min 40 degrees
            }
            return temperature;
        }
    }
    
    // Fallback temperature
    // TODO fallback
    return 20;
};

WindowControl.prototype.moveDevices = function(devices,position,windowMode,offTime) {
    var self = this;
    
    self.processDeviceList(devices,function(deviceObject) {
        var deviceAuto = deviceObject.get('metrics:auto') || false;
        // TODO handle auto
        //if ((position < 255 && deviceAuto === false) || (position === 255 && deviceAuto === true)) {
        //    return;
        //}
        self.log('Auto move window '+deviceObject.id+' to '+position);
        if (position === 0) {
            deviceObject.set('metrics:auto',false);
            deviceObject.set('metrics:offTime',null);
            deviceObject.set('metrics:windowMode','none');
            deviceObject.performCommand('off');
        } else {
            if (position >= 99) {
                deviceObject.performCommand('on');
            } else {
                deviceObject.performCommand('exact',{ level: position });
            }
            deviceObject.set('metrics:auto',true);
            if (typeof(windowMode) !== 'undefined') {
                deviceObject.set('metrics:windowMode',windowMode);
            }
            if (typeof(offTime) !== 'undefined') {
                deviceObject.set('metrics:offTime',offTime);
            }
        }
    });
};

WindowControl.prototype.toUnit = function(celsius) {
    if (this.config.unitTemperature === 'celsius') {
        return celsius;
    }
    return Math.round(celsius * 1.8 * 10) / 10;
};