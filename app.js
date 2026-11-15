'use strict';

const Homey = require('homey');
const { DreoApi } = require('./lib/DreoApi');
const { DreoSocket } = require('./lib/DreoSocket');
const DreoFanHub = require('./lib/DreoFanHub');
const Scheduler = require('./lib/Scheduler');

const SETTINGS_KEY = 'dreoAccount';

class DreoCeilingFansApp extends Homey.App {

  async onInit() {
    this.hubs = new Map(); // numéro de série → DreoFanHub (partagé par ventilateur/lumière/anneau)
    this.api = null;
    this.socket = null;

    const account = this.homey.settings.get(SETTINGS_KEY);
    if (account && account.email && account.passwordHash) {
      this._startClient(account);
    }

    this._registerFlowCards();
    this.scheduler = new Scheduler({ app: this });
    this.scheduler.start();
    this.log('Application Dreo ventilateurs de plafond démarrée');
  }

  async onUninit() {
    if (this.scheduler) this.scheduler.stop();
    if (this.socket) this.socket.stop();
  }

  // ---------------------------------------------------------------------------
  // Compte Dreo
  // ---------------------------------------------------------------------------

  hasAccount() {
    return !!this.api;
  }

  /**
   * Vérifie des identifiants et, s'ils sont valides, les enregistre (le mot de passe est
   * stocké uniquement sous forme de hachage MD5, format exigé par l'API Dreo).
   */
  async login(email, password) {
    const candidate = new DreoApi({ email: email.trim(), password, log: this.log.bind(this) });
    await candidate.login();
    const account = {
      email: candidate.email,
      passwordHash: candidate.passwordHash,
      region: candidate.region,
      token: candidate.token,
    };
    this.homey.settings.set(SETTINGS_KEY, account);
    this._startClient(account);
    return true;
  }

  _startClient(account) {
    if (this.socket) this.socket.stop();
    this.api = new DreoApi({
      email: account.email,
      passwordHash: account.passwordHash,
      region: account.region,
      token: account.token,
      log: this.log.bind(this),
    });
    const origLogin = this.api.login.bind(this.api);
    this.api.login = async () => {
      const res = await origLogin();
      const saved = this.homey.settings.get(SETTINGS_KEY) || {};
      this.homey.settings.set(SETTINGS_KEY, { ...saved, token: this.api.token, region: this.api.region });
      return res;
    };
    this.socket = new DreoSocket({ api: this.api, log: this.log.bind(this), error: this.error.bind(this) });
    this.socket.on('report', (sn, reported) => {
      const hub = this.hubs.get(sn);
      if (hub) hub.onReport(reported);
    });
    this.socket.on('device-offline', (sn) => {
      const hub = this.hubs.get(sn);
      if (hub) hub.onOffline();
    });
    this.socket.on('device-online', (sn) => {
      const hub = this.hubs.get(sn);
      if (hub) hub.onOnline();
    });
    this.socket.on('connected', () => {
      // Après une reconnexion, on resynchronise tout par REST
      for (const hub of this.hubs.values()) hub.refreshState().catch(() => {});
    });
    this.socket.start();
  }

  getApi() {
    if (!this.api) throw new Error(this.homey.__('errors.no_account'));
    return this.api;
  }

  async sendCommand(sn, params) {
    if (!this.socket) throw new Error(this.homey.__('errors.no_account'));
    return this.socket.sendCommand(sn, params);
  }

  /** Hub partagé d'un ventilateur physique (créé à la demande). */
  getHub(sn, model) {
    let hub = this.hubs.get(sn);
    if (!hub) {
      hub = new DreoFanHub({ sn, model, app: this });
      this.hubs.set(sn, hub);
    }
    return hub;
  }

  releaseHub(sn, device) {
    const hub = this.hubs.get(sn);
    if (!hub) return;
    hub.detach(device);
    if (hub.devices.size === 0) this.hubs.delete(sn);
  }

  // ---------------------------------------------------------------------------
  // Page de réglages (programmation)
  // ---------------------------------------------------------------------------

  /** Ventilateurs physiques connus de Homey, regroupés par numéro de série. */
  listFans() {
    const fans = new Map();
    for (const role of ['fan', 'light', 'ring']) {
      let devices = [];
      try { devices = this.homey.drivers.getDriver(role).getDevices(); } catch (e) { /* pilote absent */ }
      for (const device of devices) {
        const sn = device.getData().id;
        if (!fans.has(sn)) {
          fans.set(sn, {
            sn, name: null, model: device.getStoreValue('model') || null, fan: false, light: false, ring: false, fanModes: null,
          });
        }
        const fan = fans.get(sn);
        fan[role] = true;
        const base = String(device.getName()).replace(/\s+[–-]\s+[^–-]+$/, '').trim();
        if (!fan.name || role === 'fan') fan.name = base || sn;
        if (role === 'fan' && device.hub) fan.fanModes = device.hub.fanModes;
      }
    }
    return [...fans.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  fanDisplayName(sn) {
    const fan = this.listFans().find((f) => f.sn === sn);
    return fan ? fan.name : sn;
  }

  async testScheduleRule(sn, rule) {
    return this.scheduler.run(sn, rule, 'test');
  }

  // ---------------------------------------------------------------------------
  // Cartes Flow (communes aux deux pilotes)
  // ---------------------------------------------------------------------------

  _registerFlowCards() {
    const action = (id, fn) => this.homey.flow.getActionCard(id).registerRunListener(fn);
    const condition = (id, fn) => this.homey.flow.getConditionCard(id).registerRunListener(fn);

    // Marche/arrêt, intensité et température du blanc : cartes Flow natives de Homey
    // (classes "fan" et "light"). Seules les fonctions propres à Dreo ont des cartes dédiées.
    action('fan_set_speed', ({ device, speed }) => device.hub.setFanSpeed(speed));
    action('fan_set_mode', ({ device, mode }) => device.hub.setFanMode(mode));
    action('ring_set_scene', ({ device, scene }) => device.hub.setRingScene(scene));

    condition('fan_mode_is', ({ device, mode }) => device.getCapabilityValue('dreo_fan_mode') === mode);

    // Programmation horaire : activer / désactiver le profil d'un ventilateur (ex. vacances)
    action('schedule_profile_set', ({ device, state }) => this.scheduler.setProfileEnabled(device.sn, state === 'enabled'));
    condition('schedule_profile_enabled', ({ device }) => this.scheduler.isProfileEnabled(device.sn));

    this.fanModeChangedTrigger = this.homey.flow.getDeviceTriggerCard('fan_mode_changed');
    this.fanSpeedChangedTrigger = this.homey.flow.getDeviceTriggerCard('fan_speed_changed');
    this.ringSceneChangedTrigger = this.homey.flow.getDeviceTriggerCard('ring_scene_changed');
  }

}

module.exports = DreoCeilingFansApp;
