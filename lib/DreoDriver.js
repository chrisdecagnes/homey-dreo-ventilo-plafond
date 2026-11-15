'use strict';

const Homey = require('homey');
const { MODEL_INFO, unwrap } = require('./CeilingFanState');

/**
 * Pilote commun. Chaque ventilateur de plafond Dreo (préfixe de modèle DR-HCF) est
 * proposé par trois pilotes, selon `static ROLE` :
 *  - 'fan'   : le ventilateur (tous les modèles)
 *  - 'light' : la lumière centrale (modèles avec clé "lighton")
 *  - 'ring'  : l'anneau LED RGBIC (modèles avec clé "atmon")
 */
class DreoDriver extends Homey.Driver {

  get role() {
    return this.constructor.ROLE;
  }

  async onInit() {
    this.log(`Pilote ${this.id} prêt`);
  }

  async onPair(session) {
    const app = this.homey.app;

    session.setHandler('showView', async (viewId) => {
      // Compte déjà configuré : on saute directement à la liste des appareils
      if (viewId === 'login_credentials' && app.hasAccount()) {
        await session.showView('list_devices');
      }
    });

    session.setHandler('login', async ({ username, password }) => {
      try {
        return await app.login(username, password);
      } catch (err) {
        this.error('Connexion Dreo refusée :', err.message);
        throw new Error(this.homey.__('errors.login_failed'));
      }
    });

    session.setHandler('list_devices', async () => this._listDevices());
  }

  async onRepair(session) {
    session.setHandler('login', async ({ username, password }) => {
      try {
        return await this.homey.app.login(username, password);
      } catch (err) {
        throw new Error(this.homey.__('errors.login_failed'));
      }
    });
  }

  async _listDevices() {
    const api = this.homey.app.getApi();
    const devices = await api.getDevices();
    const result = [];
    for (const dev of devices) {
      const model = dev.model || '';
      if (!model.startsWith('DR-HCF')) continue;
      let state = {};
      try {
        state = await api.getDeviceState(dev.sn);
      } catch (err) {
        this.error(`État illisible pour ${dev.sn} :`, err.message);
      }
      const info = MODEL_INFO[model];
      const hasRing = typeof unwrap(state.atmon) === 'boolean' || (info && info.rgbic === true);
      const hasLight = typeof unwrap(state.lighton) === 'boolean' || !!info;
      if (this.role === 'ring' && !hasRing) continue;
      if (this.role === 'light' && !hasLight) continue;
      const baseName = dev.deviceName || (info ? `Dreo ${info.commercial}` : `Dreo ${model}`);
      result.push({
        name: `${baseName} – ${this.homey.__(`roles.${this.role}`)}`,
        data: { id: dev.sn },
        store: {
          model,
          productName: dev.productName || null,
          seriesName: dev.seriesName || (info && info.commercial) || null,
          fanModes: this._parseFanModes(dev),
        },
        settings: {
          model: `${model}${dev.seriesName ? ` (${dev.seriesName})` : ''}`,
        },
      });
    }
    return result;
  }

  _parseFanModes(dev) {
    try {
      const controls = (dev.controlsConf && dev.controlsConf.control) || [];
      const fan = controls.find((c) => c.type === 'CFFan');
      return fan ? fan.items.map((i) => i.value).filter((v) => typeof v === 'number') : null;
    } catch (e) {
      return null;
    }
  }

}

module.exports = DreoDriver;
