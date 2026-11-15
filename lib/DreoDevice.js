'use strict';

const Homey = require('homey');

/**
 * Appareil Homey représentant UNE partie d'un ventilateur de plafond Dreo :
 * le ventilateur, la lumière centrale ou l'anneau LED (selon `static ROLE`).
 * L'état et les commandes sont délégués au hub partagé du ventilateur (DreoFanHub).
 */

// Capacité Homey de l'appareil  ←  clé produite par CeilingFanState.toCapabilities()
const ROLE_MAP = {
  fan: { onoff: 'onoff', dreo_fan_speed: 'dreo_fan_speed', dreo_fan_mode: 'dreo_fan_mode' },
  light: { onoff: 'onoff.light', dim: 'dim.light', light_temperature: 'light_temperature' },
  ring: { onoff: 'onoff.ring', dim: 'dim.ring', light_hue: 'hue.ring', light_saturation: 'saturation.ring' },
};

class DreoDevice extends Homey.Device {

  get role() {
    return this.constructor.ROLE;
  }

  async onInit() {
    this.sn = this.getData().id;
    this.hub = this.homey.app.getHub(this.sn, this.getStoreValue('model'));
    const storedModes = this.getStoreValue('fanModes');
    if (Array.isArray(storedModes) && storedModes.length) this.hub.fanModes = storedModes;

    const h = this.hub;
    if (this.role === 'fan') {
      this.registerCapabilityListener('onoff', (v) => h.setFanOn(v));
      this.registerCapabilityListener('dreo_fan_speed', (v) => h.setFanSpeed(v));
      this.registerCapabilityListener('dreo_fan_mode', (v) => h.setFanMode(v));
    } else if (this.role === 'light') {
      this.registerCapabilityListener('onoff', (v) => h.setLightOn(v));
      this.registerCapabilityListener('dim', (v) => h.setLightBrightness(v));
      if (this.hasCapability('light_temperature')) {
        this.registerCapabilityListener('light_temperature', (v) => h.setLightTemperature(v));
      }
    } else if (this.role === 'ring') {
      // Migration v0.2 → v0.3 : ajout de la couleur fixe
      for (const cap of ['light_hue', 'light_saturation']) {
        if (!this.hasCapability(cap)) await this.addCapability(cap).catch((err) => this.error(err));
      }
      this.registerMultipleCapabilityListener(['light_hue', 'light_saturation'], async (values) => {
        const hue = values.light_hue !== undefined ? values.light_hue : (this.getCapabilityValue('light_hue') || 0);
        const sat = values.light_saturation !== undefined ? values.light_saturation : (this.getCapabilityValue('light_saturation') ?? 1);
        await h.setRingColor(hue, sat);
      }, 500);
      this.registerCapabilityListener('onoff', (v) => h.setRingOn(v));
      this.registerCapabilityListener('dim', (v) => h.setRingBrightness(v));
      this.registerCapabilityListener('dreo_ring_scene', (v) => h.setRingScene(v));
    }

    await h.attach(this);
    this.onHubUpdate(h);
  }

  async onDeleted() {
    if (this.hub) this.homey.app.releaseHub(this.sn, this);
  }

  async onUninit() {
    if (this.hub) this.homey.app.releaseHub(this.sn, this);
  }

  /** Appelé par le hub à chaque changement d'état. */
  onHubUpdate(hub) {
    if (hub.available && !this.getAvailable()) this.setAvailable().catch(() => {});
    if (!hub.available && this.getAvailable()) this.setUnavailable(hub.unavailableReason).catch(() => {});

    const caps = hub.state.toCapabilities();
    const values = {};
    for (const [cap, source] of Object.entries(ROLE_MAP[this.role] || {})) {
      if (source in caps) values[cap] = caps[source];
    }
    if (this.role === 'ring' && hub.ringScene) values.dreo_ring_scene = hub.ringScene;

    for (const [cap, value] of Object.entries(values)) {
      if (!this.hasCapability(cap)) continue;
      const previous = this.getCapabilityValue(cap);
      if (previous === value) continue;
      this.setCapabilityValue(cap, value).catch((err) => this.error(`${cap} :`, err.message));
      this._fireTriggers(cap, value, previous);
    }
  }

  _fireTriggers(cap, value, previous) {
    if (previous === null || previous === undefined) return;
    const app = this.homey.app;
    if (cap === 'dreo_fan_mode' && app.fanModeChangedTrigger) {
      app.fanModeChangedTrigger.trigger(this, { mode: this.homey.__(`modes.${value}`) }).catch(this.error);
    } else if (cap === 'dreo_fan_speed' && app.fanSpeedChangedTrigger) {
      app.fanSpeedChangedTrigger.trigger(this, { speed: value }).catch(this.error);
    } else if (cap === 'dreo_ring_scene' && app.ringSceneChangedTrigger) {
      app.ringSceneChangedTrigger.trigger(this, { scene: this.homey.__(`scenes.${value}`) }).catch(this.error);
    }
  }

}

module.exports = DreoDevice;
