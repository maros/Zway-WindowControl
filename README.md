# Zway-WindowControl

Automation module to handle window opener motors for achieving optimal
ventilation and temperature regulation. Three individual operation modes
are available

* Winter mode: Open windows whenever it is warmer outside than inside and
inside temperature is below target temperature.
* Summer mode: Open windows whenever it is colder outside and inside 
temperature is above selected target temperature. Summer mode will optimize
window opening based on weather forecast, time of day and presence state.
* Ventilation mode: Ensure regular ventilation - either manual or automated

For every enabled mode a control device will be created to temporarily 
activate/deactivate window actions. Furthermore WindowControl will close/not
open windows if rain or strong wind was detected.

# Configuration

## zones

Set multiple zones. Each zone must have at least one temperature sensor and
one window device.

## zone.windowSensorsDevices

Optional sensors to indicate manual ventilation.

## zone.temperatureSensorDevice

Temperature sensor to measure inside temperature

## zone.windowDevices

Window opener devices

## zone.setpointDiff

Optional value to indicate desired temperature difference to global
setpoint (eg. -1)

## zone.optimize

Option to set optimization for the zone: Either optimal temperature or 
minimal device movement (eg. for bedroom)

## summerActive

Flag that indicates if summer ventilation rules are active. A virtual
device to turn on/off winter mode will be created if this flag is active. This
mode is mutually exclusive with winter mode.

## summerRules

Options required by summer ventilation. Summer ventilation mode will try to
achieve optimal comfort temperature by opening windows when appropriate
(outside cooler than inside, when inside temperature is above desired 
temperature, ...)

## summerRules.minTemperatureOutside

Will not open windows if outside temperature is below this level.

## winterActive

Flag that indicates if winter ventilation rules are active. A virtual
device to turn on/off winter mode will be created if this flag is active. This
mode is mutally exclusive with summer mode.

## winterRules

Sets option required for winter ventilation. Winter ventilation will always
happen if outside temperature is higher than inside temperature (eg. during
foehn weather conditions)

## winterRules.maxOpenTime

Max window open time in minutes.

## winterRules.ventilationActive

Flag that indicates if time based ventilation rules are active. A virtual
device to turn on/off ventilation will be created if this flag is active.

## ventilationRules

Sets option required for time based ventilation. Automated ventilation will
happen if the last detected ventilation - either manual (detected via sensors)
or automated - is longer than n-minutes ago. Ventilation duration will be
calculated based on inside and outside temperature and ventilation settings.

## ventilationRules.windowPosition

## ventilationRules.minTemperatureOutside

Sets the minimum temperature. No ventilation will happen when the outside
temperature drops below this level.

## ventilationRules.minTime, ventilationRules.maxTime

Sets the minimum and maximum ventilation time. Actual ventilation time will
be between these two values, based on inside- and outside temperature.

## ventilationRules.interval

Maximum ventilation interval in minutes.

## ventilationRules.time

List of times (in HH:MM) when ventilation should be checked.

## unitTemperature

Temperature unit. Imperial or metric-

## maxWind

Maximum wind. Will close all windows if wind level measured by the
windSensorDevice are above this level.

## thermostatDevice

Optional thermostat device for setting the target temperature. If no 
thermostat is provided, a virtual thermostat will be created. This thermostat
is used to set the desired temperature for winter and summer modes.

## rainSensorDevice

Binary rain sensor. Can be a Virtual Rain sensor module.

## windSensorDevice

Outside wind sensor. Can be a virtual sensor created by ForecastIO,
WeatherUnderground or other weather modules.

## temperatureOutsideSensorDevice

Outside temperature sensor. Can be a virtual sensor created by ForecastIO,
WeatherUnderground or other weather modules.

# Events

No events are emitted.

Window controller always listens to security.smoke.alarm and
security.smoke.cancel events (these events are usually emitted by
( https://github.com/maros/Zway-SecurityZone ). In case of a smoke alarm all
windows managed by the controller are automatically closed.

# Virtual Devices

This module creates a virtual binary switch that enables/disabled window
control action.

# Installation

The prefered way of installing this module is via the "Zwave.me App Store"
available in 2.2.0 and higher. For stable module releases no access token is 
required. If you want to test the latest pre-releases use 'k1_beta' as 
app store access token.

For developers and users of older Zway versions installation via git is 
recommended.

```shell
cd /opt/z-way-server/automation/userModules
git clone https://github.com/maros/Zway-WindowControl.git WindowControl --branch latest
```

To update or install a specific version
```shell
cd /opt/z-way-server/automation/userModules/WindowControl
git fetch --tags
# For latest released version
git checkout tags/latest
# For a specific version
git checkout tags/1.02
# For development version
git checkout -b master --track origin/master
```

# License

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or any 
later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU General Public License for more details.
