'use strict';

/**
 * Un "hub" par ventilateur physique (numéro de série Dreo).
 *
 * Chaque ventilateur apparaît dans Homey sous forme de 3 appareils (ventilateur, lumière,
 * anneau LED) qui partagent ce hub : un seul état, une seule logique de porte
 * d'alimentation, une seule relecture REST. Indispensable car allumer la lumière d'un
 * CF712S éteint peut nécessiter d'envoyer aussi fanon:false / atmon:false.
 */

const { CeilingFanState, RING_SCENES, MODEL_INFO } = require('./CeilingFanState');

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const VERIFY_DELAY_MS = 10 * 1000;
const VERIFY_MAX_STALE_RETRIES = 3;
const RING_WAKE_DELAY_MS = 600;
const CATALOG_TTL_MS = 60 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class DreoFanHub {
  /**
   * @param {object} opts
   * @param {string} opts.sn
   * @param {string} opts.model
   * @param {object} opts.app   application Homey (getApi, sendCommand, homey, log, error)
   */
  constructor({ sn, model, app }) {
    this.sn = sn;
    this.app = app;
    this.homey = app.homey;
    this.model = model || null;
    this.state = new CeilingFanState({ model });
    this.devices = new Set();
    this.fanModes = (MODEL_INFO[model] && MODEL_INFO[model].fanModes) || null;
    this.ringColor = null; // { hue, saturation } dernière couleur fixe demandée
    this.available = true;
    this.unavailableReason = null;
    this.ringScene = null;
    this._catalog = null;
    this._catalogAt = 0;
    this._verifyTimer = null;
    this._staleRetries = 0;
    this._pollTimer = null;
    this._initPromise = null;
  }

  log(...a) { this.app.log(`[${this.sn}]`, ...a); }

  error(...a) { this.app.error(`[${this.sn}]`, ...a); }

  attach(device) {
    this.devices.add(device);
    if (!this._pollTimer) {
      this._pollTimer = this.homey.setInterval(() => this.refreshState().catch(() => {}), POLL_INTERVAL_MS);
    }
    if (!this._initPromise) {
      this._initPromise = this.refreshState()
        .catch((err) => this.error('Lecture initiale impossible :', err.message))
        .then(() => (this.state.supportsRing ? this.syncSceneFromCatalog().catch(() => {}) : null));
    } else {
      // Appareil ajouté après coup : on lui pousse l'état connu
      this._initPromise.then(() => device.onHubUpdate(this));
    }
    return this._initPromise;
  }

  detach(device) {
    this.devices.delete(device);
    if (this.devices.size === 0) this.dispose();
  }

  dispose() {
    this.homey.clearInterval(this._pollTimer);
    this.homey.clearTimeout(this._verifyTimer);
    this._pollTimer = null;
    this._verifyTimer = null;
    this._initPromise = null;
  }

  _notify() {
    for (const device of this.devices) {
      try { device.onHubUpdate(this); } catch (err) { this.error(err); }
    }
  }

  _setAvailable(ok, reason = null) {
    this.available = ok;
    this.unavailableReason = reason;
  }

  // ---------------------------------------------------------------------------
  // Réception d'état
  // ---------------------------------------------------------------------------

  async refreshState() {
    let mixed;
    try {
      mixed = await this.app.getApi().getDeviceState(this.sn);
    } catch (err) {
      this._setAvailable(false, this.homey.__('errors.cloud_unreachable'));
      this._notify();
      throw err;
    }
    const stale = this.state.applyRest(mixed);
    if (this.state.values.connected === false) this._setAvailable(false, this.homey.__('errors.device_offline'));
    else this._setAvailable(true);
    this._notify();
    return stale;
  }

  onReport(reported) {
    const before = this.state.values.rgbeffectid;
    this.state.applyReport(reported);
    if (this.state.values.connected !== false) this._setAvailable(true);
    this._notify();
    if (this.state.supportsRing && reported.rgbeffectid !== undefined && reported.rgbeffectid !== before) {
      this.syncSceneFromCatalog(true).catch(() => {});
    }
  }

  onOffline() {
    this.state.values.connected = false;
    this._setAvailable(false, this.homey.__('errors.device_offline'));
    this._notify();
  }

  onOnline() {
    this.state.values.connected = true;
    this._setAvailable(true);
    this._notify();
  }

  // ---------------------------------------------------------------------------
  // Commandes
  // ---------------------------------------------------------------------------

  async send(params) {
    const command = this.state.buildCommand(params);
    this._notify();
    try {
      await this.app.sendCommand(this.sn, command);
    } finally {
      this._scheduleVerify(true);
    }
  }

  /** Relecture REST différée : le cloud Dreo a plusieurs secondes de retard sur l'appareil. */
  _scheduleVerify(reset = false) {
    if (reset) this._staleRetries = 0;
    this.homey.clearTimeout(this._verifyTimer);
    this._verifyTimer = this.homey.setTimeout(async () => {
      try {
        const stale = await this.refreshState();
        if (stale && this._staleRetries < VERIFY_MAX_STALE_RETRIES) {
          this._staleRetries += 1;
          this._scheduleVerify(false);
        } else if (stale) {
          this.state.lastLocalWrite = 0; // commande probablement perdue : le cloud fait foi
          await this.refreshState();
        }
      } catch (err) {
        this.error('Vérification d\'état échouée :', err.message);
      }
    }, VERIFY_DELAY_MS);
  }

  // --- ventilateur ---
  setFanOn(on) {
    if (on) {
      // vitesse dans la même commande : une vitesse envoyée juste après l'allumage est ignorée
      const params = { fanon: true };
      if (typeof this.state.values.windlevel === 'number') params.windlevel = this.state.values.windlevel;
      return this.send(params);
    }
    return this.send({ fanon: false });
  }

  setFanSpeed(speed) {
    const params = CeilingFanState.speedParam(speed);
    if (this.state.gated('fanon') !== true) params.fanon = true;
    return this.send(params);
  }

  async setFanMode(mode) {
    const param = CeilingFanState.modeParam(mode);
    if (Array.isArray(this.fanModes) && this.fanModes.length && !this.fanModes.includes(param.mode)) {
      throw new Error(this.homey.__('errors.mode_not_supported'));
    }
    return this.send(param);
  }

  // --- lumière ---
  setLightOn(on) {
    return this.send({ lighton: !!on });
  }

  setLightBrightness(dim) {
    if (dim <= 0) return this.setLightOn(false);
    const params = CeilingFanState.brightnessParam(dim);
    if (this.state.gated('lighton') !== true) params.lighton = true;
    return this.send(params);
  }

  setLightTemperature(temp) {
    return this.send(CeilingFanState.colorTempParam(temp));
  }

  // --- anneau LED ---
  setRingOn(on) {
    return this.send({ atmon: !!on });
  }

  setRingBrightness(dim) {
    if (dim <= 0) return this.setRingOn(false);
    const params = this.state.ringBrightnessParam(dim);
    if (this.state.gated('atmon') !== true) params.atmon = true;
    return this.send(params);
  }

  async _getCatalog(force = false) {
    if (!force && this._catalog && Date.now() - this._catalogAt < CATALOG_TTL_MS) return this._catalog;
    this._catalog = await this.app.getApi().getRgbEffectCatalog(this.sn);
    this._catalogAt = Date.now();
    return this._catalog;
  }

  static findEffect(catalog, dreoName) {
    const wanted = dreoName.toLowerCase();
    for (const list of [catalog.sceneEffects, catalog.basicEffects, catalog.remoteEffects]) {
      const hit = (list || []).find((e) => e && typeof e.name === 'string' && e.name.toLowerCase() === wanted);
      if (hit) return hit;
    }
    return null;
  }

  async setRingScene(scene) {
    const dreoName = RING_SCENES[scene];
    if (!dreoName) throw new Error(this.homey.__('errors.unknown_scene'));
    const catalog = await this._getCatalog();
    const effect = DreoFanHub.findEffect(catalog, dreoName);
    if (!effect) throw new Error(this.homey.__('errors.scene_not_in_catalog'));
    // 1) allumer l'anneau, 2) attendre ~600 ms comme l'appli Dreo, 3) appliquer la scène
    if (this.state.gated('atmon') !== true) {
      await this.send({ atmon: true });
      await sleep(RING_WAKE_DELAY_MS);
    }
    await this.app.getApi().applyRgbEffect(this.sn, effect);
    this.ringScene = scene;
    this._notify();
    return true;
  }

  /**
   * Couleur fixe de l'anneau (teinte/saturation Homey 0-1).
   *  - CF521S RGBIC (DR-HCF007S) et révisions qui rapportent "atmcolor" : clé atmcolor directe.
   *  - CF712S (DR-HCF002S récent) : effet RGBIC "Constant" avec une couleur unique pour tout l'anneau.
   */
  async setRingColor(hue, saturation) {
    const { int, hex } = CeilingFanState.hsToRgb(hue, saturation);
    const info = MODEL_INFO[this.model] || {};
    const direct = typeof this.state.values.atmcolor === 'number'
      || (info.ringColor === 'atmcolor')
      || (!info.ringColor && this.state.values.rgbeffectid === undefined);
    if (direct) {
      const params = { atmcolor: int };
      if (this.state.gated('atmon') !== true) params.atmon = true;
      await this.send(params);
    } else {
      const catalog = await this._getCatalog();
      const constant = DreoFanHub.findEffect(catalog, 'Constant');
      if (!constant) throw new Error(this.homey.__('errors.color_not_supported'));
      const effect = JSON.parse(JSON.stringify(constant));
      const layouts = (effect.layouts || []).filter((l) => l && typeof l === 'object' && 'wholeColorList' in l);
      if (!layouts.length) throw new Error(this.homey.__('errors.color_not_supported'));
      for (const l of layouts) {
        l.currentSelected = 'whole';
        l.wholeColorList = [hex];
      }
      if (this.state.gated('atmon') !== true) {
        await this.send({ atmon: true });
        await sleep(RING_WAKE_DELAY_MS);
      }
      await this.app.getApi().applyRgbEffect(this.sn, effect);
    }
    this.ringColor = { hue, saturation };
    this.ringScene = 'other';
    this._notify();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Commandes groupées (programmation horaire) : une seule commande par partie
  // ---------------------------------------------------------------------------

  /** @param {{on:boolean, speed?:number, mode?:string}} opts */
  async applyFan({ on, speed, mode }) {
    if (!on) return this.send({ fanon: false });
    const params = { fanon: true };
    if (speed) Object.assign(params, CeilingFanState.speedParam(speed));
    else if (typeof this.state.values.windlevel === 'number') params.windlevel = this.state.values.windlevel;
    if (mode) {
      const m = CeilingFanState.modeParam(mode);
      if (Array.isArray(this.fanModes) && this.fanModes.length && !this.fanModes.includes(m.mode)) {
        throw new Error(this.homey.__('errors.mode_not_supported'));
      }
      Object.assign(params, m);
    }
    return this.send(params);
  }

  /** @param {{on:boolean, brightness?:number, temperature?:number}} opts  brightness/temperature en 0-1 */
  async applyLight({ on, brightness, temperature }) {
    if (!on) return this.send({ lighton: false });
    const params = { lighton: true };
    if (brightness) Object.assign(params, CeilingFanState.brightnessParam(brightness));
    if (typeof temperature === 'number') Object.assign(params, CeilingFanState.colorTempParam(temperature));
    return this.send(params);
  }

  /** @param {{on:boolean, brightness?:number, scene?:string}} opts */
  async applyRing({ on, brightness, scene }) {
    if (!on) return this.send({ atmon: false });
    const params = { atmon: true };
    if (brightness) Object.assign(params, this.state.ringBrightnessParam(brightness));
    await this.send(params);
    if (scene) {
      await sleep(RING_WAKE_DELAY_MS);
      await this.setRingScene(scene);
    }
    return true;
  }

  /** Déduit la scène active à partir du catalogue (drapeau selected ou rgbeffectid). */
  async syncSceneFromCatalog(force = false) {
    const catalog = await this._getCatalog(force);
    const currentId = this.state.values.rgbeffectid;
    let current = null;
    for (const [homeyId, dreoName] of Object.entries(RING_SCENES)) {
      const eff = DreoFanHub.findEffect(catalog, dreoName);
      if (!eff) continue;
      if (eff.selected === true || (currentId && (eff.id === currentId || eff.referencedId === currentId))) {
        current = homeyId;
        break;
      }
    }
    this.ringScene = current || 'other';
    this._notify();
  }
}

module.exports = DreoFanHub;
