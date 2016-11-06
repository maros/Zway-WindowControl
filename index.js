/*** WindowControl Z-Way HA module *******************************************

Version: 1.01
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
    if (typeof(self.config.thermostatDevice) === 'undefined') {
        self.thermostatDevice = self.controller.devices.create({
            deviceId: "WindowControl_Thermostat_" + self.id,
            defaults: {
                metrics: {
                    scaleTitle: config.unitTemperature === "celsius" ? '°C' : '°F',
                    level: config.unitTemperature === "celsius" ? 24 : 75,
                    min: config.unitTemperature === "celsius" ? 18 : 84,
                    max: config.unitTemperature === "celsius" ? 32 : 90,
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
                    var level = parseFloat(args.level);
                    self.log('Set target temperature to '+level);
                    this.set('metrics:level',level);
                }
            },
            moduleId: self.id
        });
    }

    // Setup ventilation scenes
    if (self.config.ventilationActive) {
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
                            // Check wind, rain & temperature
                            if (self.checkRain()
                                || self.checkWind()) {
                                self.log('Ignoring ventilation due to wind/rain');
                                return 0;
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
    if (typeof(self.config.thermostatDevice) === 'undefined') {
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
    _.each(self.config.zones,function(zone,zoneIndex) {
        devices.push(zone.windowDevices);
    });
    self.windowDevices = _.uniq(_.flatten(devices));

    self.checkDevices();

    // Get thermostat device
    if (typeof(self.config.thermostatDevice) !== 'undefined') {
        self.thermostatDevice = self.getDevice(self.config.summerRules.thermostatDevice);
    }

    // Get rain sensor
    if (typeof(self.config.rainSensorDevice) !== 'undefined') {
        self.rainSensorDevice = self.getDevice(self.config.rainSensorDevice);
        if (typeof(self.rainSensorDevice) !== 'undefined') {
            self.rainSensorDevice.on('change:metrics:level',function(vDev) {
                if (self.rainSensorDevice.get('metrics:level') === 'on') {
                    self.rainCallback();
                }
            });
        }
    }
};

// ----------------------------------------------------------------------------
// --- Module methods
// ----------------------------------------------------------------------------

WindowControl.prototype.processAlarm = function(event) {
    var self = this;

    //var presence = self.getPresenceBoolean();
    self.log('Smoke alarm');
    var alarm = false;
    if (event == 'security.smoke.alarm') {
        alarm = true;
    }

    _.each(self.windowDevices,function(deviceId) {
        var deviceObject = self.controller.devices.get(deviceId);
        if (deviceObject === null) {
            self.error('Could not find window device '+deviceId);
            return;
        }
        if (alarm === true) {
            // Really close on smoke alarm
            deviceObject.set('metrics:auto',true);
            deviceObject.performCommand('off');
        } else {
            deviceObject.set('metrics:auto',false);
            // Ventilate after alarm?
        }
    });
};

WindowControl.prototype.processRain = function(event) {
    var self = this;

    self.log('Detected rain. Closing all windows');
    self.moveDevices(self.windowDevices,0,'none');
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
        self.moveDevices(self.windowDevices,0,'none');
        return;
    }

    // Check wind
    if (self.checkWind()) {
        self.log('Closing all windows due to wind');
        self.moveDevices(self.windowDevices,0,'none');
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
        if (typeof(controlDevice) !== 'undefined') {
            var offTime = controlDevice.get('metrics:offTime');
            if (self.config.ventilationActive
                && controlDevice.get('metrics:level') === 'on'
                && typeof(offTime) === 'number'
                && offTime < now) {
                self.processStopVentilate(zoneIndex);
            }
        }
    });

    // Check off time & mode
    self.processDeviceList(self.windowDevices,function(deviceObject) {
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
    var targetPos           = self.getTargetPosition(75);

    _.each(self.config.zones,function(zone,index) {
        var temperatureInside   = self.getTemperatureZone(zone);
        var targetTemperature   = self.thermostatDevice.get('metrics:level') + (zone.setpointDiff || 0);

        if (self.getLockedZone(zone)) {
            self.log('Zone '+index+' is locke. Not moving');
            return;
        }

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
            var debug       = 'Outside:'+ temperatureOutside+' Inside:'+temperatureInside+' Mode:'+deviceMode+' Level:'+deviceLevel;

            if (temperatureOutside > (temperatureInside + 0.2)
                && deviceMode === 'none'
                && temperatureInside < targetTemperature) {
                action = 'open';
                self.log('Opening window in zone '+index+' due to high outside temperature. '+debug);
            } else if (deviceMode === 'winter'
                && deviceAuto === true
                && deviceLevel > 0
                && temperatureOutside < temperatureInside) {
                action = 'close';
                self.log('Closing window in zone '+index+' after it was opened due to high outside temperature. '+ debug);
            } else if (deviceAuto === true
                && deviceLevel > 0
                && lastChange < limit
                && temperatureOutside < temperatureInside) {
                action = 'close';
                self.log('Closing window in zone '+index+' max winter open time');
            } else {
                self.log('Not moving window in zone '+index+'. '+debug);
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
    var thermostatSetpoint  = parseFloat(self.thermostatDevice.get('metrics:level'));
    var minTemperature      = self.config.summerRules.minTemperatureOutside;
    var conditionDevice     = self.getDevice([['probeType','=','condition']]);
    var forecastDevice      = self.getDevice([['probeType','=','forecast_range']]);
    var windowPosition      = self.getTargetPosition(100);
    var operationMode       = 'default';
    var temperatureDiff     = 0;
    var temperatureOpen     = thermostatSetpoint + self.toUnit(0.25);
    var temperatureClose    = thermostatSetpoint - self.toUnit(0.50);
    var now                 = new Date(Date.now());
    var presence            = self.getPresenceBoolean();

    // Warn about missing devices
    if (typeof(conditionDevice) === 'undefined'
        || typeof(forecastDevice) === 'undefined') {
        self.log('Forecast and condition device not found. Please install the WeatherUnderground or ForecastIO module to improve window operation');
    }
    if (typeof(presence) === 'undefined') {
        self.log('Presence device not found. Please install the Presence module to improve window operation');
    }

    // Calculate window open/close thresholds
    var temperatureChange;
    if (typeof(forecastDevice) !== 'undefined'
        && typeof(conditionDevice) !== 'undefined') {
        forecastLow = forecastDevice.get('metrics:low');
        forecastHigh = forecastDevice.get('metrics:high');
        temperatureChange = conditionDevice.get('metrics:temperatureChange');

        // TODO incorporate forecast
        // Try to guess forecast
    } else {
        var hour = now.getHour();
        temperatureChange = 'unchanged';
        if (hour >= 7 && hour <= 15) {
            temperatureChange = 'rise';
        } else if (hour >= 19 || hour <= 5) {
            temperatureChange = 'fall';
        }
    }

    // Low temperature mode for end of summer
    if (forecastLow < (minTemperature - self.toUnit(4))) {
        operationMode           = "low";
        temperatureOpen         = thermostatSetpoint + self.toUnit(1.25);
        temperatureClose        = thermostatSetpoint + self.toUnit(0.50);
        self.log('DEBUG: Low temp mode');
    // High temperature mode for heatwaves
    } else if (forecastHigh > (thermostatSetpoint + self.toUnit(4))
        && forecastLow > (thermostatSetpoint - self.toUnit(8))) {
        operationMode           = "high";
        var temperatureDelta    = forecastHigh - thermostatSetpoint;
        temperatureOpen         = temperatureOpen - (temperatureDelta/3);
        temperatureClose        = temperatureClose - (temperatureDelta/3);
        temperatureOpen         = Math.max(temperatureOpen,thermostatSetpoint - self.toUnit(2));
        temperatureClose        = Math.max(temperatureClose,thermostatSetpoint - self.toUnit(3));
        minTemperature          = minTemperature - self.toUnit(1);
        temperatureDiff         = temperatureDiff - self.toUnit(0.5);
        self.log('DEBUG: High temp mode');
    }

    // Evening mode
    if (now.getHours() >= 20) {
        temperatureDiff         = temperatureDiff + self.toUnit(1);
        self.log('DEBUG: Evening mode');
    // Night mode during warm days
    } else if (operationMode == "high" && now.getHours() <= 7) {
        minTemperature          = minTemperature - self.toUnit(0.5);
        temperatureDiff         = temperatureDiff + self.toUnit(0.5);
        temperatureOpen         = temperatureOpen - self.toUnit(0.5);
        temperatureClose        = temperatureClose - self.toUnit(0.5);
        self.log('DEBUG: Night mode');
    // Strong sun mode
    } else if (typeof(conditionDevice) !== 'undefined') {
        var uv = conditionDevice.get('metrics:uv');
        if (typeof(uv) !== 'undefined'
            && uv > 6) {
            temperatureDiff = temperatureDiff - self.toUnit(1);
            self.log('DEBUG: Strong sun mode');
        }
    }

    // Based on presence
    if (typeof(presence) !== 'undefined') {
        // Home and cool
        if (presence === true
            && temperatureOutside < thermostatSetpoint) {
            minTemperature      = minTemperature + self.toUnit(1);
            temperatureDiff     = temperatureDiff + self.toUnit(0.5);
            self.log('DEBUG: Home and cool mode');
        // Away and hot
        } else if (presence === false
            && operationMode === 'high') {
            temperatureOpen     = temperatureOpen - self.toUnit(0.5);
            temperatureClose    = temperatureClose - self.toUnit(0.5);
            temperatureDiff     = temperatureDiff - self.toUnit(0.5);
            self.log('DEBUG: Away and hot mode');
        // Home and heatwave
        } else if (presence === true
            && operationMode == "high"
            && forecastHigh > (thermostatSetpoint + self.toUnit(6))) {
            minTemperature      = minTemperature - self.toUnit(1);
            temperatureDiff     = temperatureDiff - self.toUnit(0.5);
            self.log('DEBUG: Home and heatwave mode');
        }
    }

    // Mode
    self.log(operationMode+' temperature windows mode (Open>='+temperatureOpen+', Close<'+temperatureClose+', Diff='+temperatureDiff+')');

    // Process zones
    _.each(self.config.zones,function(zone,index) {
        var temperatureInside           = self.getTemperatureZone(zone);
        var setpointDiff                = parseFloat(zone.setpointDiff || 0);
        var zoneOptimize                = zone.optimize || 'temperature';
        var zoneAction                  = 'keep';
        var zonePosition                = windowPosition;
        var zoneSetpoint                = thermostatSetpoint + setpointDiff;
        var zoneOpen                    = temperatureOpen + setpointDiff;
        var zoneClose                   = temperatureClose + setpointDiff;
        var zoneMinTemperature          = minTemperature;
        var temperatureInsideCompare    = temperatureInside + temperatureDiff;
        
        if (self.getLockedZone(zone)) {
            self.log('Zone '+index+' is locked. Not moving');
            return;
        }

        // Reduce movement (open later, close later)
        if (zoneOptimize === 'movement') {
            zoneOpen  = zoneOpen + self.toUnit(0.5);
            zoneClose  = zoneClose - self.toUnit(0.5);
            zoneMinTemperature = zoneMinTemperature - self.toUnit(0.5);
        }

        // Corridor
        if (temperatureOutside < zoneSetpoint
            && forecastLow < (zoneSetpoint - self.toUnit(5))
            && temperatureInside < (zoneSetpoint + self.toUnit(3))
            && temperatureOutside > zoneMinTemperature) {

            var corridor = Math.round((temperatureOutside - zoneMinTemperature) / (zoneSetpoint - zoneMinTemperature) * 100);
            self.log("Zone "+index+". DEBUG Corridor"+corridor+" - setpoint "+zoneSetpoint);
            corridor = Math.min(corridor,80);
            corridor = Math.max(corridor,20);
            zonePosition = Math.min(zonePosition,corridor);
            if (windowPosition !== zonePosition) {
                self.log("Zone "+index+". Position reduced to "+zonePosition+"% from "+windowPosition+"%");
            }
        }

        self.log("Zone "+index+". Inside="+temperatureInside+", Outside="+temperatureOutside+", Position="+zonePosition+", Diff="+temperatureDiff+", Min="+zoneMinTemperature);

        // Handle zero or negative position
        if (zonePosition <= 0) {
            zonePosition = 0;
            self.log("Zone "+inex+". Closing all windows (temperature corridor + pop)");
            zoneAction = "close";
        // Warmer inside -> open
        } else if (temperatureInside >= zoneOpen
            && (temperatureInsideCompare+self.toUnit(0.25)) >= temperatureOutside
            && temperatureOutside >= (zoneMinTemperature+self.toUnit(0.5))) {
            self.log("Zone "+index+". Opening all windows to "+zonePosition+"% (inside comp temperature "+temperatureInsideCompare+" above opening temperature "+zoneOpen+")");
            zoneAction = "open";
        // Cool inside -> close
        } else if (temperatureInside <= zoneClose) {
            self.log("Zone "+index+". Closing all windows (inside temperature "+temperatureInside+" below "+zoneClose+")");
            zoneAction = "close";
        // Warmer outside -> close
        } else if ((temperatureInsideCompare+self.toUnit(0.50)) <= temperatureOutside) {
            self.log("Zone "+index+". Closing all windows (outside temperature "+temperatureOutside+" above cmp inside temperature "+(temperatureInsideCompare+self.toUnit(0.50))+")");
            zoneAction = "close";
        // Too cold outside -> close
        } else if (temperatureOutside <= zoneMinTemperature) {
            self.log("Zone "+index+". Closing all windows (outside temperature "+temperatureOutside+" below min temperature "+zoneMinTemperature+")");
            zoneAction = "close";
        }

        if (zoneAction == "keep") {
            self.log("Zone "+index+". Not changing window status");
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

                // Close action
                if (zoneAction === 'close'
                    && deviceAuto === true
                    && deviceMode === 'summer') {
                    self.log("Zone "+index+". Closing window "+deviceObject.id);
                    deviceObject.performCommand('off');
                    deviceObject.set('metrics:windowMode','none');
                    deviceObject.set('metrics:auto',false);
                // Open action
                } else if (zoneAction === 'open'
                    && deviceAuto === false
                    && deviceMode === 'none') {
                    self.log("Zone "+index+". Opening window "+deviceObject.id);
                    deviceObject.performCommand('exact', { level: zonePosition });
                    deviceObject.set('metrics:windowMode','summer');
                    deviceObject.set('metrics:auto',true );
                // Modify action
                } else if ((zoneAction === 'open' || zoneAction === 'keep')
                    && deviceMode === 'summer'
                    && deviceAuto === true
                    && deviceLevel != zonePosition
                    && (zoneOptimize === 'temperature' || Math.abs(deviceLevel-zonePosition) >= 60)) {
                    self.log("Zone "+index+". Move window "+deviceObject.id);
                    deviceObject.performCommand('exact', { level: zonePosition });
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

    self.log('Check ventilation rules');
    // Ventilate zones
    _.each(self.config.zones,function(zoneConfig,zoneIndex) {
        self.processVentilateZone(zoneIndex);
    });
};

WindowControl.prototype.processVentilateZone = function(zoneIndex,args) {
    var self                = this;

    // Check wind & rain
    if (self.checkRain() || self.checkWind()) {
        self.log('Ignoring ventilation due to wind/rain');
        return 0;
    }

    args                    = args || {};
    var forceVentilate      = args.force || false;
    var duration            = args.duration;
    var lastVentilationDiff = args.last || self.config.ventilationRules.interval;
    lastVentilationDiff     = lastVentilationDiff * 60;
    var windowPosition      = self.getTargetPosition(args.position || self.config.ventilationRules.windowPosition || 75);
    var now                 = Math.floor(new Date().getTime() / 1000);
    var controlDevice       = self.ventilationControlDevices[zoneIndex];

    if (forceVentilate === false && self.getLockedZone(self.config.zones[zoneIndex])) {
        self.log('Zone '+zoneIndex+' is locked. Not moving');
        return 0;
    }

    // Calc duration
    if (typeof(duration) !== 'number') {
        var targetTemperature   = self.thermostatDevice.get('metrics:level') + parseFloat(self.config.zones[zoneIndex].setpointDiff || 0);
        var temperatureOutside  = self.getDeviceValue(self.config.temperatureOutsideSensorDevice);
        var temperatureInside   = self.getTemperatureZone(self.config.zones[zoneIndex]);
        var temperatureMin      = self.config.ventilationRules.minTemperatureOutside;
        var durationDiff        = self.config.ventilationRules.maxTime - self.config.ventilationRules.minTime;

        if (temperatureOutside < temperatureMin) {
            if (! forceVentilate) {
                return 0;
            }
            duration = 0;
        } else {
            var temperatureCompare = Math.min(temperatureInside,targetTemperature);
            var tempDiff = (temperatureOutside - temperatureMin);
            var tempGradient = (temperatureCompare - temperatureMin);
            var timeDiff = tempDiff / tempGradient;
            timeDiff = Math.min(Math.max(timeDiff,0),1);
            duration = timeDiff * durationDiff;
        }

        duration = self.config.ventilationRules.minTime + duration;
        self.log('Calculated ventilation duration '+duration+' minutes for zone '+zoneIndex);
    }
    var offTime = now + (duration * 60);

    // Check if we should ventilate at all
    if (forceVentilate === false) {
        var ventilating;
        var lastVentilation = [];

        // Get all window sensors
        self.processDeviceList(self.config.zones[zoneIndex].windowSensorDevices,function(deviceObject) {
            if (deviceObject.get('metrics:level') === 'on') {
                ventilating = true;
            } else {
                lastVentilation.push(deviceObject.get('metrics:modificationTime'));
            }
        });

        if (ventilating) {
            self.log('Zone '+zoneIndex+' is currently ventilated - sensor. Skipping');
            return 0;
        }

        // Get all window devices
        self.processDeviceList(self.config.zones[zoneIndex].windowDevices,function(deviceObject) {
            if (deviceObject.get('metrics:level') > 0) {
                ventilating = true;
            } else {
                lastVentilation.push(deviceObject.get('metrics:modificationTime'));
            }
        });

        if (ventilating) {
            self.log('Zone '+zoneIndex+' is currently ventilated - device. Skipping');
            return 0;
        }

        lastVentilation.sort(function(a,b) { return b-a; });
        var lastMinutes = parseInt(((new Date()).getTime() / 1000 - lastVentilation[0]) / 60,10);

        self.log('Last ventilation diff '+lastVentilationDiff+' - last minutes '+lastMinutes);
        if (lastMinutes < lastVentilationDiff) {
            self.log("Last ventilation in zone "+zoneIndex+" "+lastMinutes+" minutes ago. Skipping");
            return 0;
        }
    }

    self.log('Ventilate zone '+zoneIndex+' for '+duration+' minutes');

    var countAll    = 0;
    var countActive = 0;
    self.processDeviceList(self.config.zones[zoneIndex].windowDevices,function(deviceObject) {
        var deviceAuto  = deviceObject.get('metrics:auto') || false;
        var deviceLevel = deviceObject.get('metrics:level') || 0;
        var deviceMode  = deviceObject.get('metrics:windowMode') || 'none';

        countAll = countAll + 1;
        if ((deviceMode !== 'none' || deviceAuto === true) && deviceLevel > 0)  {
            self.log('Skipping window '+deviceObject.id+' in zone '+zoneIndex+' Current mode:'+ deviceMode+', Auto:'+deviceAuto);
            return;
        }

        countActive = countActive + 1;
        self.moveDevices(deviceObject,windowPosition,'ventilate',offTime);
    });

    if (countActive > 0) {
        controlDevice.set('metrics:offTime',offTime);
        controlDevice.set('metrics:level','on');
        controlDevice.set('metrics:icon',self.imagePath+"/icon_ventilate_on.png");

        setTimeout(_.bind(self.processStopVentilate,self,zoneIndex),(duration * 60 * 1000));
        return duration * 60;
    }
    return 0;
};

WindowControl.prototype.processStopVentilate = function(zoneIndex) {
    var self = this;
    self.log('Stop ventilate zone '+zoneIndex);
    var controlDevice = self.ventilationControlDevices[zoneIndex];

    self.processDeviceList(self.config.zones[zoneIndex].windowDevices,function(deviceObject) {
        if (deviceObject.get('metrics:windowMode') === 'ventilate'
            && deviceObject.get('metrics:level') > 0
            && deviceObject.get('metrics:auto') === true) {
            self.moveDevices(deviceObject,0,'none');
        }
    });

    controlDevice.set('metrics:offTime',undefined);
    controlDevice.set('metrics:icon',self.imagePath+"/icon_ventilate.png");
    controlDevice.set('metrics:level',"off");
};

WindowControl.prototype.commandModeDevice = function(type,command,args) {
    var self = this;

    var device = self[type+'Device'];
    if (command !== 'on' && command !== 'off')
        return;

    self.log('Turning '+command+' '+type+' window control');

    // Turn off other device
    if (command === 'on') {
        if (type === 'winter' && self.config.summerActive) {
            self.commandModeDevice('summer','off');
        } else if (type === 'summer' && self.config.winterActive) {
            self.commandModeDevice('winter','off');
        }
    } else {
        self.processDeviceList(self.windowDevices,function(deviceObject) {
            if (deviceObject.get('metrics:auto') === true
                && deviceObject.get('metrics:windowMode') === type) {
                self.log('Closing '+deviceObject.id+' after disabling '+type+' window control');
                self.moveDevices(deviceObject,0,'none');
            }
        });
    }

    device.set('metrics:level',command);
    device.set("metrics:icon", self.imagePath+"/icon_"+type+"_"+command+".png");
};

WindowControl.prototype.getTargetPosition = function(windowPosition) {
    var self            = this;
    var conditionDevice = self.getDevice([['probeType','=','condition']]);
    var windLevel       = self.getDeviceValue(self.config.windSensorDevice);
    var windMax         = self.config.maxWind;

    // Calculate window position based on POP
    if (typeof(conditionDevice) !== 'undefined') {
        var pop             = conditionDevice.get('metrics:pop');
        var condition       = conditionDevice.get('metrics:conditiongroup');
        if (pop > 50
            && condition !== 'fair') {
            windowPosition = Math.min(windowPosition,( 100 - pop + 30 ));
            self.log('DEBUG: Reduce window position to '+windowPosition+' due to POP');
        }
    }

    // Close on wind
    if (windLevel > windMax) {
        return 0;
    }

    // Calculate window position based on wind
    if (windLevel >= (windMax / 2)) {
        var maxPosition     = Math.round((windMax - windLevel) / (windMax / 2) * 100);
        maxPosition         = Math.max(25,maxPosition);
        maxPosition         = Math.min(100,maxPosition);
        windowPosition      = Math.min(windowPosition,maxPosition);
        self.log('DEBUG: Reduce window position to '+windowPosition+' due to wind');
    }

    // Not below 0
    windowPosition = Math.max(windowPosition,0);

    return windowPosition;
};

WindowControl.prototype.getLockedZone = function(zone) {
    var self = this;

    var lockDevice = self.getDevice(zone.lockDevice);
    if (typeof(lockDevice) !== 'undefined') {
        var lockLevel   = lockDevice.get('metrics:level');
        var lockType    = lockDevice.get('deviceType');
        if (
            (
                ((lockType === 'switchMultilevel' || lockType === 'sensorMultilevel') && parseInt(lockLevel,10) > 0)
                ||
                ((lockType === 'switchBinary' || lockType === 'sensorBinary') && lockLevel === 'on')
            )
        ) {
            return true;
        }
    }
    return false;
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
    // Get locations
    var locations = [];
    self.processDeviceList(zone.windowDevices,function(deviceObject) {
        locations.push( deviceObject.get('location') );
    });

    var temperatures = [];
    _.each(_.uniq(locations),function(location) {
        self.processDevices([
            ['location','=',location],
            ['probeType','=','temperature']
        ],function(deviceObject) {
            // TODO weight by location
            temperatures.push(deviceObject.get('metrics:level'));
        });
    });

    var sumTemperature = _.reduce(temperatures,function(memo, num){ return memo + num; }, 0);
    return sumTemperature / temperatures.length;
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
