'use strict';

/**
 * Test de bout en bout avec un faux SDK Homey, un faux cloud REST et un faux WebSocket :
 * appairage → ajout d'un CF712S → commandes depuis les capacités et les Flows.
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');
const EventEmitter = require('events');

// ---------- faux module "homey" ----------
const stubPath = path.join(__dirname, '__homey_stub__.js');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === 'homey') return stubPath;
  return origResolve.call(this, request, ...rest);
};
const fr = require('../locales/fr.json');

const homeyDevices = {};
function makeHomey() {
  const settings = new Map();
  const cards = new Map();
  const card = (id) => {
    if (!cards.has(id)) {
      cards.set(id, {
        id, listener: null, triggered: [],
        registerRunListener(fn) { this.listener = fn; return this; },
        async trigger(device, tokens) { this.triggered.push(tokens); },
      });
    }
    return cards.get(id);
  };
  return {
    cards,
    settings: { get: (k) => settings.get(k), set: (k, v) => settings.set(k, v) },
    flow: { getActionCard: card, getConditionCard: card, getDeviceTriggerCard: card },
    __: (key) => key.split('.').reduce((o, k) => (o ? o[k] : undefined), fr) || key,
    setInterval, clearInterval, setTimeout, clearTimeout,
    clock: { getTimezone: () => 'Europe/Paris' },
    drivers: { getDriver: (id) => ({ getDevices: () => (homeyDevices[id] || []) }) },
  };
}

class Base {
  log() {}

  error() {}
}
class Device extends Base {
  constructor({ homey, data, store }) {
    super();
    this.homey = homey;
    this._data = data;
    this._store = store;
    this._caps = {};
    this._listeners = {};
    this._available = true;
  }

  getData() { return this._data; }

  getStoreValue(k) { return this._store[k]; }

  hasCapability(c) { return c in this._caps; }

  getCapabilityValue(c) { return this._caps[c]; }

  async setCapabilityValue(c, v) { this._caps[c] = v; }

  registerCapabilityListener(c, fn) { this._listeners[c] = fn; }

  registerMultipleCapabilityListener(caps, fn) { caps.forEach((c) => { this._listeners[c] = (v) => fn({ [c]: v }); }); }

  async addCapability(c) { this._caps[c] = null; }

  getName() { return this._name || 'Chambre – Ventilateur'; }

  getAvailable() { return this._available; }

  async setAvailable() { this._available = true; }

  async setUnavailable() { this._available = false; }

  // simulation de l'UI Homey
  async ui(c, v) { await this._listeners[c](v); this._caps[c] = v; }
}
require.cache[stubPath] = {
  id: stubPath, filename: stubPath, loaded: true, exports: { App: Base, Driver: Base, Device },
};

// ---------- faux cloud Dreo ----------
const SN = 'SN-712';
const catalog = {
  basicEffects: [{
    id: 'B1', name: 'Constant', effectType: 0, referencedId: 'R1',
    layouts: [{ effectParamKey: 'colors', colorList: ['#FF0000'], wholeColorList: ['#FFFFFF'], currentSelected: 'segment' }],
  }],
  sceneEffects: ['Wave', 'Cherry Blossom', 'Christmas', 'Halloween', 'Birthday Party', 'Firefly']
    .map((name, i) => ({ id: `S${i}`, name, effectType: 3, referencedId: `S${i}`, layouts: [], selected: name === 'Halloween' })),
};
const restState = {
  poweron: { state: false, timestamp: 1 },
  fanon: { state: false, timestamp: 1 },
  lighton: { state: false, timestamp: 1 },
  atmon: { state: true, timestamp: 1 },
  windlevel: { state: 3, timestamp: 1 },
  mode: { state: 1, timestamp: 1 },
  brightness: { state: 10, timestamp: 1 },
  colortemp: { state: 100, timestamp: 1 },
  atmbri: { state: 40, timestamp: 1 },
  rgbeffectid: { state: '123', timestamp: 1 },
  connected: { state: true, timestamp: 1 },
};
const restCalls = [];
globalThis.fetch = async (url, init) => {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : null;
  restCalls.push({ path: u.pathname, body });
  let data = null;
  if (u.pathname === '/api/oauth/login') data = { region: 'EU', access_token: 'tok' };
  else if (u.pathname === '/api/v2/user-device/device/list') {
    data = {
      list: [
        { sn: SN, model: 'DR-HCF002S', deviceName: 'Chambre', seriesName: 'CF712S',
          controlsConf: { control: [{ type: 'CFFan', items: [{ value: 1 }, { value: 2 }, { value: 3 }, { value: 5 }] }] } },
        { sn: 'SN-521', model: 'DR-HCF521S', deviceName: 'Salon' },
        { sn: 'SN-TOWER', model: 'DR-HTF001S', deviceName: 'Tour' },
      ],
    };
  } else if (u.pathname === '/api/user-device/device/state') {
    data = { mixed: u.searchParams.get('deviceSn') === SN ? restState : { fanon: { state: false }, lighton: { state: true } } };
  } else if (u.pathname === '/api/device/rgb-effect/all/list') data = catalog;
  else if (u.pathname === '/api/device/rgb-effect/edit/batch') data = null;
  return { status: 200, text: async () => JSON.stringify({ code: 0, msg: 'OK', data }) };
};

class FakeWS extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.sent = [];
    FakeWS.last = this;
    setImmediate(() => this.emit('open'));
  }

  send(data) {
    if (data === '2') return;
    const msg = JSON.parse(data);
    this.sent.push(msg.params);
    setImmediate(() => this.emit('message', JSON.stringify({ devicesn: msg.devicesn, method: 'control-report', reported: msg.params })));
  }

  close() { this.emit('close'); }
}
globalThis.WebSocket = undefined; // force le repli sur le module "ws" (simulé ici)
Module._resolveFilename = ((prev) => function resolve(request, ...rest) {
  if (request === 'ws') return path.join(__dirname, '__ws_stub__.js');
  return prev.call(this, request, ...rest);
})(Module._resolveFilename);
const wsStub = path.join(__dirname, '__ws_stub__.js');
require.cache[wsStub] = { id: wsStub, filename: wsStub, loaded: true, exports: FakeWS };

const App = require('../app');
const FanDriver = require('../drivers/fan/driver');
const LightDriver = require('../drivers/light/driver');
const RingDriver = require('../drivers/ring/driver');
const FanDevice = require('../drivers/fan/device');
const LightDevice = require('../drivers/light/device');
const RingDevice = require('../drivers/ring/device');

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function makeDevice(Cls, homey, found, caps) {
  const d = new Cls({ homey, data: found.data, store: { ...found.store } });
  caps.forEach((c) => { d._caps[c] = null; });
  return d;
}

test('3 appareils (ventilateur, lumière, anneau) partageant un CF712S', async () => {
  const homey = makeHomey();
  const app = new App();
  app.homey = homey;
  homey.app = app;
  await app.onInit();

  // --- appairage : connexion via le pilote "ventilateur" ---
  const fanDriver = new FanDriver();
  fanDriver.homey = homey;
  const handlers = {};
  await fanDriver.onPair({ setHandler: (n, fn) => { handlers[n] = fn; }, showView: async () => {} });
  assert.strictEqual(await handlers.login({ username: 'moi@exemple.fr', password: 'x' }), true);
  const fans = await handlers.list_devices();
  assert.deepStrictEqual(fans.map((d) => d.data.id), [SN, 'SN-521']);
  assert.strictEqual(fans[0].name, 'Chambre – Ventilateur');
  assert.deepStrictEqual(fans[0].store.fanModes, [1, 2, 3, 5]);

  const lightDriver = new LightDriver();
  lightDriver.homey = homey;
  const lights = await lightDriver._listDevices();
  assert.deepStrictEqual(lights.map((d) => d.data.id), [SN, 'SN-521']);
  const ringDriver = new RingDriver();
  ringDriver.homey = homey;
  const rings = await ringDriver._listDevices();
  assert.deepStrictEqual(rings.map((d) => d.data.id), [SN], 'le CLF521S n\'a pas d\'anneau');
  assert.strictEqual(rings[0].name, 'Chambre – Anneau LED');

  // --- les trois appareils du CF712S ---
  const fan = makeDevice(FanDevice, homey, fans[0], ['onoff', 'dreo_fan_speed', 'dreo_fan_mode']);
  const light = makeDevice(LightDevice, homey, lights[0], ['onoff', 'dim', 'light_temperature']);
  const ring = makeDevice(RingDevice, homey, rings[0], ['onoff', 'dim', 'dreo_ring_scene']); // appareil v0.2 (sans couleur)
  homeyDevices.fan = [fan];
  homeyDevices.light = [light];
  homeyDevices.ring = [ring];
  await fan.onInit();
  await light.onInit();
  await ring.onInit();
  await tick();
  assert.strictEqual(app.hubs.size, 1, 'un seul hub pour les 3 appareils');
  assert.strictEqual(fan.getCapabilityValue('onoff'), false);
  assert.strictEqual(fan.getCapabilityValue('dreo_fan_speed'), 3);
  assert.strictEqual(light.getCapabilityValue('dim'), 0.1);
  assert.strictEqual(light.getCapabilityValue('light_temperature'), 0);
  assert.strictEqual(ring.getCapabilityValue('onoff'), false);
  assert.strictEqual(ring.getCapabilityValue('dim'), 0.4);
  assert.strictEqual(ring.getCapabilityValue('dreo_ring_scene'), 'halloween');

  const ws = FakeWS.last;
  assert.ok(ws.url.startsWith('wss://wsb-eu.dreo-tech.com/websocket?accessToken=tok'));

  // allumer la lumière seule : porte ouverte, autres charges forcées à false
  await light.ui('onoff', true);
  assert.deepStrictEqual(ws.sent.at(-1), { lighton: true, poweron: true, fanon: false, atmon: false });
  assert.strictEqual(ring.getCapabilityValue('onoff'), false);

  await fan.ui('dreo_fan_speed', 7);
  assert.deepStrictEqual(ws.sent.at(-1), { windlevel: 7, fanon: true });
  assert.strictEqual(fan.getCapabilityValue('onoff'), true);

  await homey.cards.get('fan_set_mode').listener({ device: fan, mode: 'sleep' });
  assert.deepStrictEqual(ws.sent.at(-1), { mode: 3 });
  await tick();
  assert.deepStrictEqual(homey.cards.get('fan_mode_changed').triggered.at(-1), { mode: 'Sommeil' });

  await light.ui('light_temperature', 1);
  assert.deepStrictEqual(ws.sent.at(-1), { colortemp: 0 });

  await ring.ui('dim', 0.75);
  assert.deepStrictEqual(ws.sent.at(-1), { atmbri: 75, atmon: true });
  assert.strictEqual(ring.getCapabilityValue('onoff'), true);

  await homey.cards.get('ring_set_scene').listener({ device: ring, scene: 'firefly' });
  const batch = restCalls.filter((c) => c.path === '/api/device/rgb-effect/edit/batch').at(-1);
  assert.strictEqual(batch.body[0].name, 'Firefly');
  assert.strictEqual(batch.body[0].effectType, 3);
  assert.strictEqual(ring.getCapabilityValue('dreo_ring_scene'), 'firefly');
  await tick();
  assert.deepStrictEqual(homey.cards.get('ring_scene_changed').triggered.at(-1), { scene: 'Luciole' });

  // couleur fixe (CF712S : effet RGBIC "Constant" avec couleur unique)
  assert.ok(ring.hasCapability('light_hue'), 'migration : capacité couleur ajoutée');
  await ring.ui('light_hue', 0);
  await ring.ui('light_saturation', 1);
  const colorBatch = restCalls.filter((c) => c.path === '/api/device/rgb-effect/edit/batch').at(-1);
  assert.strictEqual(colorBatch.body[0].name, 'Constant');
  assert.deepStrictEqual(colorBatch.body[0].subEffects[0].layouts[0].wholeColorList, ['#FF0000']);
  assert.strictEqual(colorBatch.body[0].subEffects[0].layouts[0].currentSelected, 'whole');
  assert.strictEqual(ring.getCapabilityValue('dreo_ring_scene'), 'other');

  // mode auto (CF712S)
  await homey.cards.get('fan_set_mode').listener({ device: fan, mode: 'auto' });
  assert.deepStrictEqual(ws.sent.at(-1), { mode: 5 });
  await assert.rejects(fan.hub.setFanMode('reverse'), /pas pris en charge/);

  // réglages : liste des ventilateurs et règle de programmation testée
  const fansForSettings = app.listFans();
  assert.deepStrictEqual(fansForSettings.map((f) => [f.sn, f.name, f.fan, f.light, f.ring]), [[SN, 'Chambre', true, true, true]]);
  const api = require('../api');
  await api.testRule({ homey, body: { sn: SN, rule: { target: 'fan', action: 'on', speed: 4, mode: 'natural' } } });
  assert.deepStrictEqual(ws.sent.at(-1), { fanon: true, windlevel: 4, mode: 2 });
  await homey.cards.get('schedule_profile_set').listener({ device: fan, state: 'enabled' });
  assert.strictEqual(await homey.cards.get('schedule_profile_enabled').listener({ device: fan }), true);

  await light.ui('onoff', false);
  await ring.ui('onoff', false);
  await fan.ui('onoff', false);
  assert.deepStrictEqual(ws.sent.at(-1), { fanon: false, poweron: false }, 'dernière charge => porte fermée');


  // rapport temps réel venant de la télécommande : les 3 appareils sont mis à jour
  ws.emit('message', JSON.stringify({ devicesn: SN, method: 'report', reported: { windlevel: 2, poweron: true, lighton: true } }));
  await tick();
  assert.strictEqual(fan.getCapabilityValue('dreo_fan_speed'), 2);
  assert.strictEqual(light.getCapabilityValue('onoff'), true);

  ws.emit('message', JSON.stringify({ devicesn: SN, method: 'device-offline' }));
  assert.strictEqual(fan.getAvailable(), false);
  assert.strictEqual(light.getAvailable(), false);
  assert.strictEqual(ring.getAvailable(), false);

  await fan.onUninit();
  await light.onUninit();
  assert.strictEqual(app.hubs.size, 1);
  await ring.onUninit();
  assert.strictEqual(app.hubs.size, 0, 'hub libéré quand ses 3 appareils sont retirés');
  await app.onUninit();
});
