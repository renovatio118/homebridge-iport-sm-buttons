const net = require('net');
const http = require('http');
const https = require('https');

console.log('Loading iPortSMButtons plugin');

class IPortSMButtonsPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;

    // network/config
    this.ip = this.config.ip || '192.168.2.12';
    this.port = this.config.port || 10001;
    this.timeout = this.config.timeout || 5000;
    this.reconnectDelay = this.config.reconnectDelay || 5000;
    this.triggerResetDelay = typeof this.config.triggerResetDelay === 'number' ? this.config.triggerResetDelay : 500;

    // runtime state
    this.buttonServices = [];           // stateless services on main accessory
    this.mappingSwitches = {};          // map uuidStr -> Switch service for mapping accessories
    this.buttonStates = Array.from({ length: 10 }, () => ({ state: 0, lastPress: 0 }));
    this.ledColor = { r: 255, g: 255, b: 255 };
    this.connected = false;
    this.socket = null;
    this.isShuttingDown = false;
    this.keepAliveInterval = null;
    this.eventQueue = [];
    this.lastRawData = null;

    // cache of accessories that Homebridge restored via configureAccessory
    this.accessoriesCache = {}; // uuidStr -> PlatformAccessory

    // color mapping
    this.modeColors = {
      yellow: { r: 255, g: 255, b: 0 },
      red: { r: 255, g: 0, b: 0 },
      blue: { r: 0, g: 0, b: 255 },
      green: { r: 0, g: 255, b: 0 },
      purple: { r: 255, g: 0, b: 255 },
      white: { r: 255, g: 255, b: 255 }
    };

    this.colorCycle = ['red', 'green', 'blue', 'yellow', 'purple', 'white'];
    this.currentColorIndex = 0;

    this.buttonMappings = this.config.buttonMappings || [];
    this.log(`Config loaded: ${JSON.stringify(this.config)}`);

    if (!this.api || !this.api.hap) {
      this.log('Error: Homebridge API or HAP is undefined');
      return;
    }

    this.log('IPortSMButtonsPlatform initialized');

    // start connection immediately
    this.connect();

    // After Homebridge restores cached accessories, this.api will call configureAccessory for each.
    // After that we run didFinishLaunching and create/register any missing accessories and remove stale ones.
    this.api.on('didFinishLaunching', () => {
      this.log('Homebridge finished launching');
      this.setupAndRegisterAccessories();
      this.processQueuedEvents();
    });

    // cleanup on shutdown
    this.api.on('shutdown', () => {
      this.isShuttingDown = true;
      this.log('Homebridge shutting down, closing socket');
      if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
      if (this.socket) this.socket.destroy();
    });
  }

  // -------------------------
  // Connection & parsing
  // -------------------------
  connect() {
    if (!this.ip) {
      this.log.error('No IP configured for iPort device');
      return;
    }

    this.log(`Connecting to ${this.ip}:${this.port}`);
    this.socket = new net.Socket();
    this.socket.setTimeout(this.timeout);

    this.socket.connect(this.port, this.ip, () => {
      this.log(`Connected to ${this.ip}:${this.port}`);
      this.connected = true;
      this.queryLED();
      if (this.accessory && this.accessory.updateReachability) this.accessory.updateReachability(true);
      if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = setInterval(() => {
        if (this.connected && !this.isShuttingDown) this.queryLED();
      }, 5000);
    });

    this.socket.on('data', (data) => {
      if (this.isShuttingDown) return;
      const str = data.toString().trim();
      this.lastRawData = str;

      try {
        const json = JSON.parse(str);
        if (json.led) this.parseAndSetLedFromString(String(json.led));
        if (json.events) {
          json.events.forEach((event) => {
            // original device event.label looks like "Key 1" etc.
            const keyNum = parseInt((event.label || '').split(' ')[1], 10) - 1;
            const state = parseInt(event.state, 10);
            if (!Number.isNaN(keyNum) && !Number.isNaN(state)) {
              this.queueOrHandleEvent(keyNum, state);
            }
          });
        }
      } catch (e) {
        // not JSON — parse legacy responses
        if (str.includes('led=')) {
          const ledValue = str.split('led=')[1]?.trim();
          if (ledValue) this.parseAndSetLedFromString(ledValue);
        } else {
          const possibleRGB = str.replace(/\r|\n/g, '').trim();
          if (/^\d{9}$/.test(possibleRGB)) this.parseAndSetLedFromString(possibleRGB);
        }
      }
    });

    this.socket.on('error', (err) => {
      this.log(`Socket error: ${err.message}`);
      try { this.socket.destroy(); } catch (e) {}
      this.connected = false;
      if (this.accessory && this.accessory.updateReachability) this.accessory.updateReachability(false);
      if (!this.isShuttingDown) setTimeout(() => this.connect(), this.reconnectDelay);
    });

    this.socket.on('close', () => {
      this.log('Connection closed');
      this.connected = false;
      if (this.accessory && this.accessory.updateReachability) this.accessory.updateReachability(false);
      if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
      if (!this.isShuttingDown) setTimeout(() => this.connect(), this.reconnectDelay);
    });

    this.socket.on('timeout', () => {
      try { this.socket.destroy(); } catch (e) {}
    });
  }

  parseAndSetLedFromString(ledValue) {
    try {
      const s = String(ledValue).trim();
      const padded = s.padStart(9, '0').substr(0, 9);
      const newR = parseInt(padded.substr(0, 3), 10);
      const newG = parseInt(padded.substr(3, 3), 10);
      const newB = parseInt(padded.substr(6, 3), 10);
      this.ledColor = { r: newR, g: newG, b: newB };
      this.updateLightCharacteristics();
    } catch (err) { /* ignore parse failures */ }
  }

  // -------------------------
  // Event queue / button handling
  // -------------------------
  queueOrHandleEvent(buttonIndex, state) {
    if (this.buttonServices.length === 0) {
      this.eventQueue.push({ buttonIndex, state });
    } else {
      this.handleButtonEvent(buttonIndex, state);
    }
  }

  processQueuedEvents() {
    while (this.eventQueue.length > 0) {
      const event = this.eventQueue.shift();
      this.handleButtonEvent(event.buttonIndex, event.state);
    }
  }

  handleButtonEvent(buttonIndex, state) {
    if (!this.connected || this.isShuttingDown) return;
    const service = this.buttonServices[buttonIndex];
    if (!service) return;
    const bs = this.buttonStates[buttonIndex];

    if (state === 1) {
      bs.state = 1;
      bs.lastPress = Date.now();
    } else if (state === 0 && bs.state === 1) {
      bs.state = 0;
      this.triggerButtonEvent(buttonIndex, 0);
    }
  }

  triggerButtonEvent(buttonIndex, eventType) {
    if (this.isShuttingDown) return;
    const service = this.buttonServices[buttonIndex];
    if (service) {
      try {
        service.updateCharacteristic(this.api.hap.Characteristic.ProgrammableSwitchEvent, eventType);
      } catch (e) { /* ignore */ }
    }
    if (eventType === 0) this.executeButtonAction(buttonIndex + 1);
  }

  // -------------------------
  // Actions execution
  // -------------------------
  executeButtonAction(buttonNumber) {
    if (buttonNumber === 10) {
      this.cycleLEDColor();
      return;
    }

    const actions = this.buttonMappings.filter(action => action.buttonNumber === buttonNumber);
    if (actions.length === 0) return;

    const currentMode = this.getCurrentMode();
    let actionToExecute = actions.find(a => a.modeColor === currentMode);
    if (!actionToExecute) actionToExecute = actions.find(a => a.modeColor === 'any');
    if (!actionToExecute) return;

    // determine mapping accessory UUID (deterministic)
    const mappingKey = this.getMappingKey(actionToExecute);
    const uuidStr = this.api.hap.uuid.generate(`iport-mapping-${mappingKey}`);
    const vSwitch = this.mappingSwitches[uuidStr];

    if (vSwitch) {
      // we have a virtual switch accessory to trigger
      this.triggerVirtualSwitch(vSwitch, mappingKey, actionToExecute);
      return;
    }

    if (actionToExecute.actionType === 'url') {
      this.executeUrlAction(actionToExecute);
    } else {
      this.executeHomeKitAction(actionToExecute);
    }
  }

  triggerVirtualSwitch(service, mappingKey, mapping) {
    try {
      service.updateCharacteristic(this.api.hap.Characteristic.On, true);
      setTimeout(() => {
        try { service.updateCharacteristic(this.api.hap.Characteristic.On, false); } catch (e) {}
      }, this.triggerResetDelay);
    } catch (e) {}
  }

  getMappingKey(mapping) {
    // keep same formatting as original to remain compatible with older configs
    return `btn${mapping.buttonNumber}-${mapping.modeColor}-${mapping.action}-${(mapping.targetName || '').replace(/\s+/g, '_')}`;
  }

  executeUrlAction(action) {
    if (!action.url) {
      this.log('No URL specified for url action');
      return;
    }
    try {
      const lib = action.url.startsWith('https') ? https : http;
      const method = (action.method || 'GET').toUpperCase();
      const options = new URL(action.url);
      options.method = method;

      const req = lib.request(options, (res) => {
        res.on('data', () => {});
        res.on('end', () => {});
      });

      req.on('error', (err) => this.log(`URL action error: ${err.message}`));

      if (method === 'POST' && action.body) {
        try {
          req.write(action.body);
        } catch (e) {
          this.log(`Error writing POST body: ${e.message}`);
        }
      }
      req.end();
      this.log(`Triggered URL: ${action.url} [${method}]`);
    } catch (err) {
      this.log(`Error executing URL action: ${err.message}`);
    }
  }

  // -------------------------
  // LED / color helpers
  // -------------------------
  cycleLEDColor() {
    this.currentColorIndex = (this.currentColorIndex + 1) % this.colorCycle.length;
    const colorName = this.colorCycle[this.currentColorIndex];
    const color = this.modeColors[colorName];
    this.setLED(color.r, color.g, color.b);
  }

  getCurrentMode() {
    let { r, g, b } = this.ledColor;
    if (r === 0 && g === 0 && b === 0) return 'off';
    const max = Math.max(r, g, b);
    r = Math.round((r / max) * 255);
    g = Math.round((g / max) * 255);
    b = Math.round((b / max) * 255);

    for (const mode in this.modeColors) {
      const mc = this.modeColors[mode];
      if (r === mc.r && g === mc.g && b === mc.b) return mode;
    }
    return 'unknown';
  }

  // -------------------------
  // HomeKit control helpers
  // -------------------------
  executeHomeKitAction(action) {
    if (!action.targetName) return;
    const targetAccessory = this.findAccessoryByName(action.targetName);
    if (!targetAccessory) return;

    let service = targetAccessory.getService(this.api.hap.Service.Switch) || targetAccessory.getService(this.api.hap.Service.Lightbulb);
    if (!service) return;
    const onCharacteristic = service.getCharacteristic(this.api.hap.Characteristic.On);
    if (!onCharacteristic) return;

    switch (action.action) {
      case 'toggle': {
        // value may be undefined — try to read from characteristic
        const currentState = onCharacteristic.value;
        try { onCharacteristic.setValue(!currentState); } catch (e) {}
        break;
      }
      case 'on':
        try { onCharacteristic.setValue(true); } catch (e) {}
        break;
      case 'off':
        try { onCharacteristic.setValue(false); } catch (e) {}
        break;
    }
  }

  findAccessoryByName(name) {
    try {
      // Best-effort: search Homebridge cached accessories
      const hbServer = this.api._homebridge || this.api.server;
      if (!hbServer || !hbServer.accessories || !hbServer.accessories.accessories) {
        // fallback: search our own cache
        for (const acc of Object.values(this.accessoriesCache)) {
          if (acc.displayName === name) return acc;
        }
        return null;
      }
      const accessoriesMap = hbServer.accessories.accessories;
      for (const acc of accessoriesMap.values()) {
        if (acc.displayName === name) return acc;
      }
      // fallback to our cache
      for (const acc of Object.values(this.accessoriesCache)) {
        if (acc.displayName === name) return acc;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  // -------------------------
  // iPort LED commands
  // -------------------------
  setLED(r, g, b) {
    if (!this.connected || this.isShuttingDown) return;
    const cmd = `\rled=${r.toString().padStart(3, '0')}${g.toString().padStart(3, '0')}${b.toString().padStart(3, '0')}\r`;
    try {
      this.socket.write(cmd);
      this.ledColor = { r, g, b };
    } catch (e) {}
  }

  queryLED() {
    if (!this.connected || this.isShuttingDown) return;
    try {
      this.socket.write('\rled=?\r');
    } catch (e) {}
  }

  updateLightCharacteristics() {
    if (!this.lightService || !this.connected || this.isShuttingDown) return;
    const hsv = this.rgbToHsv(this.ledColor.r, this.ledColor.g, this.ledColor.b);
    try {
      this.lightService
        .updateCharacteristic(this.api.hap.Characteristic.On, hsv.v > 0)
        .updateCharacteristic(this.api.hap.Characteristic.Hue, hsv.h)
        .updateCharacteristic(this.api.hap.Characteristic.Saturation, hsv.s)
        .updateCharacteristic(this.api.hap.Characteristic.Brightness, hsv.v);
    } catch (e) {}
  }

  // -------------------------
  // Color math helpers
  // -------------------------
  rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), v = max, d = max - min;
    const s = max === 0 ? 0 : d / max;
    let h;
    if (max === min) h = 0;
    else {
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        case b: h = (r - g) / d + 4; break;
      }
      h /= 6;
    }
    return { h: h * 360, s: s * 100, v: v * 100 };
  }

  hsvToRgb(h, s, v) {
    h /= 360; s /= 100; v /= 100;
    const i = Math.floor(h * 6), f = h * 6 - i;
    const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    let r, g, b;
    switch (i % 6) {
      case 0: r = v; g = t; b = p; break;
      case 1: r = q; g = v; b = p; break;
      case 2: r = p; g = v; b = t; break;
      case 3: r = p; g = q; b = v; break;
      case 4: r = t; g = p; b = v; break;
      case 5: r = v; g = p; b = q; break;
    }
    return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
  }

  // -------------------------
  // Accessories create / register / restore
  // -------------------------
  getMainUUID() {
    return this.api.hap.uuid.generate(this.config.name || 'iPort SM Buttons');
  }

  /**
   * Called by Homebridge to restore cached accessories
   */
  configureAccessory(accessory) {
    try {
      this.log(`configureAccessory: restoring ${accessory.displayName} (${accessory.UUID})`);
      // save to cache
      this.accessoriesCache[accessory.UUID] = accessory;

      // If it's the main accessory (by UUID)
      const mainUUID = this.getMainUUID();
      if (accessory.UUID === mainUUID) {
        this.accessory = accessory;
        if (this.accessory.updateReachability) this.accessory.updateReachability(this.connected);

        // rebuild buttonServices array and lightService reference
        this.buttonServices = [];
        accessory.services.forEach(service => {
          const sUUID = service.UUID;
          if (sUUID === this.api.hap.Service.StatelessProgrammableSwitch.UUID) {
            // try to parse subtype like "button1"
            if (service.subtype && service.subtype.startsWith('button')) {
              const idx = parseInt(service.subtype.replace('button', ''), 10) - 1;
              if (!Number.isNaN(idx)) this.buttonServices[idx] = service;
            } else {
              // fallback: push in order if subtype absent
              this.buttonServices.push(service);
            }
          } else if (sUUID === this.api.hap.Service.Lightbulb.UUID) {
            // consider it the LED service (displayName likely 'LED')
            this.lightService = service;
          }
        });

        // ensure array length 10
        if (this.buttonServices.length < 10) {
          // leave reconstruction to setupAndRegisterAccessories (which may add missing services)
        }
      } else {
        // likely a child mapping accessory
        const sw = accessory.getService(this.api.hap.Service.Switch);
        if (sw) {
          // store by UUID so we can trigger it later
          this.mappingSwitches[accessory.UUID] = sw;
          try { sw.updateCharacteristic(this.api.hap.Characteristic.On, false); } catch (e) {}
        }
      }

    } catch (e) {
      this.log(`Error in configureAccessory: ${e.message}`);
    }
  }

  /**
   * Build desired accessories and register / unregister differences with Homebridge.
   */
  setupAndRegisterAccessories() {
    const PlatformAccessory = this.api.platformAccessory;
    const desired = [];
    const desiredUUIDs = new Set();

    // 1) main accessory (LED + stateless buttons)
    const mainName = this.config.name || 'iPort SM Buttons';
    const mainUUID = this.getMainUUID();

    let mainAccessory = this.accessoriesCache[mainUUID];
    if (!mainAccessory) {
      this.log('Creating main accessory');
      mainAccessory = new PlatformAccessory(mainName, mainUUID);
      // add label namespace if available
      if (this.api.hap.Service.ServiceLabel) {
        mainAccessory.addService(this.api.hap.Service.ServiceLabel)
          .setCharacteristic(this.api.hap.Characteristic.ServiceLabelNamespace, 1);
      }
      // Add 10 stateless programmable switches
      for (let i = 1; i <= 10; i++) {
        const subtype = `button${i}`;
        const svc = mainAccessory.addService(this.api.hap.Service.StatelessProgrammableSwitch, `Button ${i}`, subtype);
        if (this.api.hap.Characteristic.ServiceLabelIndex) {
          try { svc.setCharacteristic(this.api.hap.Characteristic.ServiceLabelIndex, i); } catch (e) {}
        }
      }
      // Add LED light service (displayName "LED")
      const ledSvc = mainAccessory.addService(this.api.hap.Service.Lightbulb, 'LED', 'led');
      try { ledSvc.setCharacteristic(this.api.hap.Characteristic.On, true); } catch (e) {}
      // record
      this.accessoriesCache[mainUUID] = mainAccessory;
    } else {
      // ensure mainAccessory has the necessary services (10 stateless and LED)
      // add missing stateless services if not present
      const presentButtonIndices = [];
      mainAccessory.services.forEach(svc => {
        if (svc.UUID === this.api.hap.Service.StatelessProgrammableSwitch.UUID && svc.subtype && svc.subtype.startsWith('button')) {
          const idx = parseInt(svc.subtype.replace('button', ''), 10);
          if (!Number.isNaN(idx)) presentButtonIndices.push(idx);
        }
      });
      for (let i = 1; i <= 10; i++) {
        if (!presentButtonIndices.includes(i)) {
          const subtype = `button${i}`;
          mainAccessory.addService(this.api.hap.Service.StatelessProgrammableSwitch, `Button ${i}`, subtype);
        }
      }
      // ensure LED exists
      if (!mainAccessory.getService(this.api.hap.Service.Lightbulb)) {
        mainAccessory.addService(this.api.hap.Service.Lightbulb, 'LED', 'led');
      }
    }

    // rebuild runtime references for main accessory
    this.accessory = mainAccessory;
    this.buttonServices = [];
    mainAccessory.services.forEach(service => {
      if (service.UUID === this.api.hap.Service.StatelessProgrammableSwitch.UUID) {
        if (service.subtype && service.subtype.startsWith('button')) {
          const idx = parseInt(service.subtype.replace('button', ''), 10) - 1;
          if (!Number.isNaN(idx)) this.buttonServices[idx] = service;
        } else {
          // push to array if no subtype
          this.buttonServices.push(service);
        }
      } else if (service.UUID === this.api.hap.Service.Lightbulb.UUID) {
        this.lightService = service;
      }
    });

    desired.push(mainAccessory);
    desiredUUIDs.add(mainAccessory.UUID);

    // 2) child mapping accessories (one accessory per mapping)
    this.buttonMappings.forEach((mapping) => {
      const mappingKey = this.getMappingKey(mapping);
      const uuidStr = this.api.hap.uuid.generate(`iport-mapping-${mappingKey}`);
      desiredUUIDs.add(uuidStr);

      let childAccessory = this.accessoriesCache[uuidStr];
      const shortName = `B${mapping.buttonNumber} [${mapping.modeColor}]`;

      if (!childAccessory) {
        this.log(`Creating mapping accessory: ${shortName}`);
        childAccessory = new PlatformAccessory(shortName, uuidStr);
        // put the mapping object in the accessory context for reference
        childAccessory.context.mapping = mapping;
        const vSwitch = childAccessory.addService(this.api.hap.Service.Switch, shortName);
        vSwitch.getCharacteristic(this.api.hap.Characteristic.On).onSet((value) => {
          if (value) {
            setTimeout(() => {
              try { vSwitch.updateCharacteristic(this.api.hap.Characteristic.On, false); } catch (e) {}
            }, this.triggerResetDelay);
          }
        });
        this.accessoriesCache[uuidStr] = childAccessory;
      } else {
        // update displayName if needed and ensure switch service exists
        childAccessory.displayName = shortName;
        let vSwitch = childAccessory.getService(this.api.hap.Service.Switch);
        if (!vSwitch) {
          vSwitch = childAccessory.addService(this.api.hap.Service.Switch, shortName);
          vSwitch.getCharacteristic(this.api.hap.Characteristic.On).onSet((value) => {
            if (value) {
              setTimeout(() => {
                try { vSwitch.updateCharacteristic(this.api.hap.Characteristic.On, false); } catch (e) {}
              }, this.triggerResetDelay);
            }
          });
        }
        // update context mapping
        childAccessory.context.mapping = mapping;
      }

      // store service reference in runtime map so executeButtonAction can trigger it
      const svc = childAccessory.getService(this.api.hap.Service.Switch);
      if (svc) {
        this.mappingSwitches[uuidStr] = svc;
        try { svc.updateCharacteristic(this.api.hap.Characteristic.On, false); } catch (e) {}
      }

      desired.push(childAccessory);
    });

    // Determine which accessories to register (new ones) and which cached to remove
    const toRegister = [];
    for (const acc of desired) {
      if (!this.accessoriesCache[acc.UUID]) {
        toRegister.push(acc);
        // Add to cache so we don't treat it as stale below
        this.accessoriesCache[acc.UUID] = acc;
      }
    }

    const cachedUUIDs = Object.keys(this.accessoriesCache);
    const toRemove = [];
    for (const uuid of cachedUUIDs) {
      if (!desiredUUIDs.has(uuid)) {
        // remove it
        const acc = this.accessoriesCache[uuid];
        if (acc) toRemove.push(acc);
      }
    }

    if (toRegister.length > 0) {
      this.log(`Registering ${toRegister.length} new accessory(ies)`);
      try {
        this.api.registerPlatformAccessories('homebridge-iport-sm-buttons', 'IPortSMButtons', toRegister);
      } catch (e) {
        this.log(`Error registering accessories: ${e.message}`);
      }
    }

    if (toRemove.length > 0) {
      this.log(`Removing ${toRemove.length} stale accessory(ies)`);
      try {
        this.api.unregisterPlatformAccessories('homebridge-iport-sm-buttons', 'IPortSMButtons', toRemove);
        toRemove.forEach(acc => delete this.accessoriesCache[acc.UUID]);
      } catch (e) {
        this.log(`Error unregistering accessories: ${e.message}`);
      }
    }

    // update reachability
    if (this.accessory && this.accessory.updateReachability) this.accessory.updateReachability(this.connected);
  }
}

module.exports = (api) => {
  console.log('Registering IPortSMButtons platform');
  api.registerPlatform('homebridge-iport-sm-buttons', 'IPortSMButtons', IPortSMButtonsPlatform);
};
