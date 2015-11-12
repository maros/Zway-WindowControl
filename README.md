# Zway-WindowControl

TODO

# Configuration

TODO

# Events

No events are emitted.

Window controller always listens to security.smoke.alarm and 
security.smoke.cancel events (these events are usually emitted by 
( https://github.com/maros/Zway-SecurityZone ). In case of a smoke alarm all 
windows managed by the controller are automatically opened.

# Virtual Devices

This module creates a virtual binary switch that enables/disabled window
control action.

# Installation

```shell
cd /opt/z-way-server/automation/modules
git clone https://github.com/maros/Zway-WindowControl.git WindowControl --branch latest
```

To update or install a specific version
```shell
cd /opt/z-way-server/automation/modules/WindowControl
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
