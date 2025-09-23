// index.js
const net = require('net');
const http = require('http');
const https = require('https');

console.log('Loading iPortSMButtons plugin');

class IPortSMButtonsPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.hap = api?.hap;

    // network/config
    this.ip = this.config.ip || '192.168.2.12';
    this.port = this.config.port || 10001;
    this.timeout = this.config.timeout || 5000;
    this.reconnectDelay = this.config.reconnectDelay || 5000;
    this.triggerResetDelay = typeof this.config.triggerResetDelay === 'number' ? this.config.triggerResetDelay : 500;

    // runtime
    this.accessoriesCache = {};   // UUID -> PlatformAccessory (restored or registered)
    this.buttonServices = [];     // stateless services on main accessory
    this.mappingSwitches = {};    // uuidStr -> Switch Service (child mapping accessories)
    this.buttonStates = Array.from({ length: 10 }, () => ({ state: 0, lastPress: 0 }));
    this.ledColor = { r: 255, g: 255, b: 255 };
    this.connected = false;
    this.socket = null;
    this.isShuttingDown = false;
    this.keepAliveInterval = null;
    this.eventQueue = [];
    this.lastRawData = null;

    // color mapping
    this.modeColors = {
      yellow: { r: 255, g: 255, b: 0 },
      red: { r: 255, g: 0, b: 0 },
      blue: { r: 0, g: 0, b: 255 },
      green: { r: 0, g: 255, b: 0 },
      purple: { r: 255, g: 0, b: 255 },
      white: { r: 255, g: 255, b: 255 },
    };

    this.colorCycle = ['red', 'green', 'blue', 'yellow', 'purple', 'white'];
    this.currentColorIndex = 0;

    this.buttonMappings = this.config.buttonMappings || [];
    this.log(`Config loaded: ${JSON.stringify(this.config)}`);

    if (!this.api || !this.hap) {
      this.log('Error: Homebridge API or HAP is undefined');
      return;
    }

    // start device connection
    this.connect();

    // Homebridge life-cycle
    this.api.on('didFinishLaunching', () => {
      this.log('Homebridge didFinishLaunching - building/registering accessories');
      try {
        this.buildAndRegisterAccessories();
        this.processQueuedEvents();
      } catch (e) {
        this.log(`Error during didFinishLaunching: ${e.message}`);
      }
    });

    this.api.on('shutdown', () => {
      this.isShuttingDown = true;
      this.log('Homebridge shutdown - closing socket');
      if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
      if (this.socket) try { this.socket.destroy(); } catch (e) {}
    });
  }

  // -------------------------
  // TCP connect & parsing
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
      if (this.accessory?.updateReachability) this.accessory.updateReachability(true);
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
            const keyNum = parseInt((event.label || '').split(' ')[1], 10) - 1;
            const state = parseInt(event.state, 10);
            if (!Number.isNaN(keyNum) && !Number.isNaN(state)) this.queueOrHandleEvent(keyNum, state);
          });
        }
      } catch (e) {
        // legacy parsing
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
      if (this.accessory?.updateReachability) this.accessory.updateReachability(false);
      if (!this.isShuttingDown) setTimeout(() => this.connect(), this.reconnectDelay);
    });

    this.socket.on('close', () => {
      this.log('Connection closed');
      this.connected = false;
      if (this.accessory?.updateReachability) this.accessory.updateReachability(false);
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
    } catch (err) { /* ignore */ }
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
      const ev = this.eventQueue.shift();
      this.handleButtonEvent(ev.buttonIndex, ev.state);
    }
  }

  handleButtonEvent(buttonIndex, state) {
    if (!this.connected || this.isShuttingDown) return;
    const svc = this.buttonServices[buttonIndex];
    if (!svc) return;
    const bs = this.buttonStates[buttonIndex];

    if (state === 1) {
      bs.state = 1;
      bs.lastPress = Date.now();
    } else if (state === 0 && bs.state === 1) {
      bs.state = 0;
      // send a ProgrammableSwitchEvent (single press)
      try { svc.updateCharacteristic(this.hap.Characteristic.ProgrammableSwitchEvent, 0); } catch (e) {}
      this.executeButtonAction(buttonIndex + 1);
    }
  }

  triggerButtonEventFromHomeKit(buttonNumber) {
    // optionally allow HomeKit to trigger actions (stateless) - not used now
    this.executeButtonAction(buttonNumber);
  }

  // -------------------------
  // Actions execution
  // -------------------------
  executeButtonAction(buttonNumber) {
    if (buttonNumber === 10) {
      this.cycleLEDColor();
      return;
    }

    const actions = this.buttonMappings.filter(m => m.buttonNumber === buttonNumber);
    if (!actions || actions.length === 0) return;

    const currentMode = this.getCurrentMode();
    let actionToExecute = actions.find(a => a.modeColor === currentMode);
    if (!actionToExecute) actionToExecute = actions.find(a => a.modeColor === 'any');
    if (!actionToExecute) return;

    const mappingKey = this.getMappingKey(actionToExecute);
    const uuidStr = this.hap.uuid.generate(`iport-mapping-${mappingKey}`);
    const vSwitch = this.mappingSwitches[uuidStr];
    if (vSwitch) {
      this.triggerVirtualSwitch(vSwitch);
      return;
    }

    if (actionToExecute.actionType === 'url') {
      this.executeUrlAction(actionToExecute);
    } else {
      this.executeHomeKitAction(actionToExecute);
    }
  }

  triggerVirtualSwitch(service) {
    try {
      service.updateCharacteristic(this.hap.Characteristic.On, true);
      setTimeout(() => {
        try { service.updateCharacteristic(this.hap.Characteristic.On, false); } catch (e) {}
      }, this.triggerResetDelay);
    } catch (e) { /* ignore */ }
  }

  getMappingKey(mapping) {
    // deterministic key for mapping accessories
    const t = (mapping.targetName || '').replace(/\s+/g, '_');
    return `btn${mapping.buttonNumber}-${mapping.modeColor}-${mapping.actionType}-${t}`;
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
        try { req.write(action.body); } catch (e) { this.log(`Error writing POST body: ${e.message}`); }
      }
      req.end();
      this.log(`Triggered URL: ${action.url} [${method}]`);
    } catch (err) {
      this.log(`Error executing URL action: ${err.message}`);
    }
  }

  // -------------------------
  // LED helpers
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
  // HomeKit helpers
  // -------------------------
  executeHomeKitAction(action) {
    if (!action.targetName) return;
    const targetAccessory = this.findAccessoryByName(action.targetName);
    if (!targetAccessory) return;

    const service = targetAccessory.getService(this.hap.Service.Switch) || targetAccessory.getService(this.hap.Service.Lightbulb);
    if (!service) return;
    const onChar = service.getCharacteristic(this.hap.Characteristic.On);
    if (!onChar) return;

    switch (action.action) {
      case 'toggle': {
        const current = onChar.value;
        try { onChar.setValue(!current); } catch (e) {}
        break;
      }
      case 'on':
        try { onChar.setValue(true); } catch (e) {}
        break;
      case 'off':
        try { onChar.setValue(false); } catch (e) {}
        break;
      default:
        break;
    }
  }

  findAccessoryByName(name) {
    try {
      // search cached accessories restored by configureAccessory first
      for (const uuid of Object.keys(this.accessoriesCache)) {
        const acc = this.accessoriesCache[uuid];
        if (acc && acc.displayName === name) return acc;
      }

      // fallback: try to read from homebridge internal map (best-effort)
      const hbServer = this.api._homebridge || this.api.server;
      if (hbServer && hbServer.accessories && hbServer.accessories.accessories) {
        for (const acc of hbServer.accessories.accessories.values()) {
          if (acc.displayName === name) return acc;
        }
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
    } catch (e) { /* ignore */ }
  }

  queryLED() {
    if (!this.connected || this.isShuttingDown) return;
    try { this.socket.write('\rled=?\r'); } catch (e) {}
  }

  updateLightCharacteristics() {
    if (!this.lightService || !this.connected || this.isShuttingDown) return;
    const hsv = this.rgbToHsv(this.ledColor.r, this.ledColor.g, this.ledColor.b);
    try {
      this.lightService
        .updateCharacteristic(this.hap.Characteristic.On, hsv.v > 0)
        .updateCharacteristic(this.hap.Characteristic.Hue, hsv.h)
        .updateCharacteristic(this.hap.Characteristic.Saturation, hsv.s)
        .updateCharacteristic(this.hap.Characteristic.Brightness, hsv.v);
    } catch (e) { /* ignore */ }
  }

  // -------------------------
  // Color math
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
  // Accessories: configure / create / register
  // -------------------------
  /**
   * Homebridge calls this to restore cached accessories
   */
  configureAccessory(accessory) {
    try {
      this.log(`configureAccessory: restoring ${accessory.displayName} (${accessory.UUID})`);
      this.accessoriesCache[accessory.UUID] = accessory;

      // If it's main accessory, rebuild references:
      const mainUUID = this.hap.uuid.generate(this.config.name || 'iPort SM Buttons');
      if (accessory.UUID === mainUUID) {
        this.accessory = accessory;
        if (this.accessory.updateReachability) this.accessory.updateReachability(this.connected);

        // build buttonServices array and lightService
        this.buttonServices = [];
        accessory.services.forEach(svc => {
          if (svc.UUID === this.hap.Service.StatelessProgrammableSwitch.UUID) {
            if (svc.subtype && svc.subtype.startsWith('button')) {
              const idx = parseInt(svc.subtype.replace('button', ''), 10) - 1;
              if (!Number.isNaN(idx)) this.buttonServices[idx] = svc;
            } else {
              this.buttonServices.push(svc);
            }
          } else if (svc.UUID === this.hap.Service.Lightbulb.UUID) {
            this.lightService = svc;
          }
        });
      } else {
        // child mapping accessory: pick up its Switch service
        const sw = accessory.getService(this.hap.Service.Switch);
        if (sw) {
          this.mappingSwitches[accessory.UUID] = sw;
          try { sw.updateCharacteristic(this.hap.Characteristic.On, false); } catch (e) {}
          // ensure onSet exists to auto-reset if user uses accessory directly
          try {
            sw.getCharacteristic(this.hap.Characteristic.On).onSet((value) => {
              if (value) {
                setTimeout(() => {
                  try { sw.updateCharacteristic(this.hap.Characteristic.On, false); } catch (e) {}
                }, this.triggerResetDelay);
              }
            });
          } catch (e) {}
        }
      }
    } catch (e) {
      this.log(`configureAccessory error: ${e.message}`);
    }
  }

  /**
   * Build desired accessories, register new ones, and remove stale cached ones.
   */
  buildAndRegisterAccessories() {
    const PlatformAccessory = this.api.platformAccessory;
    const desiredUUIDs = new Set();
    const desiredAccessories = [];

    // --- Main accessory ---
    const mainName = this.config.name || 'iPort SM Buttons';
    const mainUUID = this.hap.uuid.generate(mainName);
    desiredUUIDs.add(mainUUID);

    let mainAccessory = this.accessoriesCache[mainUUID];
    if (!mainAccessory) {
      this.log('Creating main accessory (LED + 10 stateless buttons)');
      mainAccessory = new PlatformAccessory(mainName, mainUUID);
      // add stateless buttons
      for (let i = 1; i <= 10; i++) {
        const subtype = `button${i}`;
        const svc = mainAccessory.addService(this.hap.Service.StatelessProgrammableSwitch, `Button ${i}`, subtype);
        if (this.hap.Characteristic.ServiceLabelIndex) {
          try { svc.setCharacteristic(this.hap.Characteristic.ServiceLabelIndex, i); } catch (e) {}
        }
      }
      // LED service
      mainAccessory.addService(this.hap.Service.Lightbulb, 'LED', 'led');
      this.accessoriesCache[mainUUID] = mainAccessory;
      desiredAccessories.push(mainAccessory);
    } else {
      // ensure LED and 10 stateless programmable exist - if not, add them
      const presentButtons = [];
      mainAccessory.services.forEach(svc => {
        if (svc.UUID === this.hap.Service.StatelessProgrammableSwitch.UUID && svc.subtype && svc.subtype.startsWith('button')) {
          const idx = parseInt(svc.subtype.replace('button', ''), 10);
          if (!Number.isNaN(idx)) presentButtons.push(idx);
        }
      });
      for (let i = 1; i <= 10; i++) {
        if (!presentButtons.includes(i)) {
          mainAccessory.addService(this.hap.Service.StatelessProgrammableSwitch, `Button ${i}`, `button${i}`);
        }
      }
      if (!mainAccessory.getService(this.hap.Service.Lightbulb)) {
        mainAccessory.addService(this.hap.Service.Lightbulb, 'LED', 'led');
      }
      desiredAccessories.push(mainAccessory);
    }

    // rebuild runtime references from mainAccessory
    this.accessory = mainAccessory;
    this.buttonServices = [];
    mainAccessory.services.forEach(service => {
      if (service.UUID === this.hap.Service.StatelessProgrammableSwitch.UUID) {
        if (service.subtype && service.subtype.startsWith('button')) {
          const idx = parseInt(service.subtype.replace('button', ''), 10) - 1;
          if (!Number.isNaN(idx)) this.buttonServices[idx] = service;
        } else {
          this.buttonServices.push(service);
        }
      } else if (service.UUID === this.hap.Service.Lightbulb.UUID) {
        this.lightService = service;
      }
    });

    // --- Mapping (child) accessories ---
    this.buttonMappings.forEach(mapping => {
      const mappingKey = this.getMappingKey(mapping);
      const uuidStr = this.hap.uuid.generate(`iport-mapping-${mappingKey}`);
      desiredUUIDs.add(uuidStr);

      const shortName = `B${mapping.buttonNumber} [${mapping.modeColor}]`;

      let childAccessory = this.accessoriesCache[uuidStr];
      if (!childAccessory) {
        this.log(`Creating mapping accessory: ${shortName}`);
        childAccessory = new PlatformAccessory(shortName, uuidStr);
        childAccessory.context.mapping = mapping;
        // add switch service
        const sw = childAccessory.addService(this.hap.Service.Switch, shortName);
        try {
          sw.getCharacteristic(this.hap.Characteristic.On).onSet((value) => {
            if (value) {
              setTimeout(() => {
                try { sw.updateCharacteristic(this.hap.Characteristic.On, false); } catch (e) {}
              }, this.triggerResetDelay);
            }
          });
        } catch (e) {}
        this.accessoriesCache[uuidStr] = childAccessory;
        desiredAccessories.push(childAccessory);
      } else {
        // ensure service exists and displayName matches
        childAccessory.displayName = shortName;
        let sw = childAccessory.getService(this.hap.Service.Switch);
        if (!sw) {
          sw = childAccessory.addService(this.hap.Service.Switch, shortName);
          try {
            sw.getCharacteristic(this.hap.Characteristic.On).onSet((value) => {
              if (value) {
                setTimeout(() => {
                  try { sw.updateCharacteristic(this.hap.Characteristic.On, false); } catch (e) {}
                }, this.triggerResetDelay);
              }
            });
          } catch (e) {}
        }
        childAccessory.context.mapping = mapping;
        desiredAccessories.push(childAccessory);
      }

      // store switch service reference for triggering
      const svc = this.accessoriesCache[uuidStr].getService(this.hap.Service.Switch);
      if (svc) {
        this.mappingSwitches[uuidStr] = svc;
        try { svc.updateCharacteristic(this.hap.Characteristic.On, false); } catch (e) {}
      }
    });

    // Compare cache -> determine register / unregister lists
    const toRegister = [];
    for (const acc of desiredAccessories) {
      if (!this.api._homebridge || !this.api._homebridge.accessories || !this.api._homebridge.accessories.accessories || !this.api._homebridge.accessories.accessories[acc.UUID]) {
        // If not already known in homebridge internal cache, we should register
        // But safest approach: if we don't have this UUID present in the top-level accessoriesCache BEFORE this call, ensure we register.
      }
      // Register any accessory that we just created (exists in accesssoriesCache but not registered previously)
      // We'll register all desiredAccessories that do not appear to be previously registered in the platform cache we maintain.
      if (!this.api.registeredPlatformAccessories || !this.api.registeredPlatformAccessories.some?.(a => a.UUID === acc.UUID)) {
        // We cannot rely on internal methods; instead, we mark those created during this run (they have context.mapping for child accessories or not in original cache)
      }
      // Simpler: push all desiredAccessories that are not present in the original cache BEFORE this function (so those created above)
      // We'll consider accessoriesCacheHold as snapshot of cache at function start; to keep it simple we treat child accessories that we created above (no previous cache entry) as new.
    }

    // Identify which accessories were in the cache before (restored) vs which we created now.
    const createdNow = [];
    const cacheBefore = Object.assign({}, this.accessoriesCache); // note: accessoriesCache has new entries too; but those created above will have been added
    // To find created now, iterate desiredAccessories and check if accessory had services we added and no prior restore call flagged it as restored.
    // Easiest approach: register all desiredAccessories that are *not* currently present in Homebridge's internal accessory registry.
    const notRegistered = [];
    try {
      const hb = this.api._homebridge || this.api.server;
      const hbMap = hb && hb.accessories && hb.accessories.accessories ? hb.accessories.accessories : null;
      desiredAccessories.forEach(acc => {
        let known = false;
        if (hbMap) {
          // hbMap is a Map in some homebridge versions
          if (typeof hbMap.get === 'function') {
            known = hbMap.get(acc.UUID) ? true : false;
          } else if (hbMap[acc.UUID]) {
            known = true;
          } else {
            // try other shapes
            for (const v of Object.values(hbMap)) {
              if (v && v.UUID === acc.UUID) known = true;
            }
          }
        }
        if (!known) notRegistered.push(acc);
      });
    } catch (e) {
      // fallback - register any accessory that we created in this run that has no context.mapping? We'll handle below
    }

    // Pared down approach: register accessory objects that we created in this run (where context.mapping exists OR the main accessory was not in cache originally).
    const toRegisterFinal = [];
    desiredAccessories.forEach(acc => {
      // if this accessory was not present in the cache when configureAccessory was called earlier, its UUID will have been added above but configureAccessory would not have been called for it.
      // So we check if its UUID mapping had been present earlier (we don't have a full snapshot). Simpler: if acc.UUID not present in process.env or if acc has context.mapping then it's new.
      if (!this._restoredUUIDs) this._restoredUUIDs = new Set(Object.keys(this.accessoriesCache || {}));
      // if this accessory was NOT part of restored set at startup, it is new
      if (!this._restoredUUIDs.has(acc.UUID)) {
        toRegisterFinal.push(acc);
        // mark as restored for future runs
        this._restoredUUIDs.add(acc.UUID);
      }
    });

    if (toRegisterFinal.length > 0) {
      this.log(`Registering ${toRegisterFinal.length} new accessory(ies)`);
      try {
        this.api.registerPlatformAccessories('homebridge-iport-sm-buttons', 'IPortSMButtons', toRegisterFinal);
      } catch (e) {
        this.log(`Error registering accessories: ${e.message}`);
      }
    } else {
      this.log('No new accessories to register');
    }

    // Remove stale accessories: any accessory in accessoriesCache that is not in desiredUUIDs
    const toRemove = [];
    for (const uuid of Object.keys(this.accessoriesCache)) {
      if (!desiredUUIDs.has(uuid)) {
        const acc = this.accessoriesCache[uuid];
        if (acc) toRemove.push(acc);
      }
    }
    if (toRemove.length > 0) {
      this.log(`Removing ${toRemove.length} stale accessory(ies)`);
      try {
        this.api.unregisterPlatformAccessories('homebridge-iport-sm-buttons', 'IPortSMButtons', toRemove);
        toRemove.forEach(acc => { delete this.accessoriesCache[acc.UUID]; });
      } catch (e) {
        this.log(`Error unregistering accessories: ${e.message}`);
      }
    }

    // Finally ensure mappingSwitches map includes all mapping services (restored or newly created)
    for (const uuid of Object.keys(this.accessoriesCache)) {
      const acc = this.accessoriesCache[uuid];
      if (!acc) continue;
      const sw = acc.getService && acc.getService(this.hap.Service.Switch);
      if (sw && acc.UUID !== mainUUID) {
        this.mappingSwitches[acc.UUID] = sw;
        try { sw.updateCharacteristic(this.hap.Characteristic.On, false); } catch (e) {}
      }
    }

    // ensure mainAccessory reachability updated
    if (this.accessory && this.accessory.updateReachability) this.accessory.updateReachability(this.connected);

    this.log('Accessory setup complete');
  }
}

module.exports = (api) => {
  console.log('Registering IPortSMButtons platform');
  api.registerPlatform('homebridge-iport-sm-buttons', 'IPortSMButtons', IPortSMButtonsPlatform);
};
