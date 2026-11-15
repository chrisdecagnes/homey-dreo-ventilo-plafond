'use strict';

const test = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('events');
const { DreoApi, md5 } = require('../lib/DreoApi');
const { DreoSocket, DreoCommandRejectedError } = require('../lib/DreoSocket');

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const { status = 200, json } = handler(new URL(url), init, calls.length);
    return { status, text: async () => JSON.stringify(json) };
  };
  fn.calls = calls;
  return fn;
}

test('login : MD5, redirection de région EU, jeton', async () => {
  const fetch = fakeFetch((url) => {
    if (url.hostname === 'app-api-us.dreo-tech.com') return { json: { code: 0, data: { region: 'EU', access_token: 'wrong' } } };
    return { json: { code: 0, data: { region: 'EU', access_token: 'tok-eu' } } };
  });
  const api = new DreoApi({ email: 'a@b.c', password: 'secret', region: 'NA', fetch });
  await api.login();
  assert.strictEqual(api.token, 'tok-eu');
  assert.strictEqual(api.region, 'EU');
  assert.strictEqual(fetch.calls.length, 2);
  assert.strictEqual(fetch.calls[1].body.password, md5('secret'));
  assert.strictEqual(fetch.calls[1].body.grant_type, 'email-password');
  assert.match(api.websocketUrl, /^wss:\/\/wsb-eu\.dreo-tech\.com\/websocket\?accessToken=tok-eu&timestamp=\d+$/);
});

test('re-login automatique sur 401', async () => {
  let n = 0;
  const fetch = fakeFetch((url) => {
    if (url.pathname === '/api/oauth/login') return { json: { code: 0, data: { region: 'EU', access_token: `t${++n}` } } };
    if (n === 1) return { status: 401, json: { code: 401 } };
    return { json: { code: 0, data: { list: [{ sn: 'SN1', model: 'DR-HCF002S' }, { model: 'x' }] } } };
  });
  const api = new DreoApi({ email: 'a', passwordHash: 'h', region: 'EU', fetch });
  const list = await api.getDevices();
  assert.deepStrictEqual(list.map((d) => d.sn), ['SN1']);
  assert.strictEqual(api.token, 't2');
});

test('applyRgbEffect : charge utile au format de l\'appli', async () => {
  const fetch = fakeFetch(() => ({ json: { code: 0, data: null } }));
  const api = new DreoApi({ email: 'a', passwordHash: 'h', token: 'tok', fetch });
  await api.applyRgbEffect('SN1', { id: 'S1', name: 'Firefly', effectType: 3, referencedId: 'S1', layouts: [] });
  const call = fetch.calls[0];
  assert.strictEqual(new URL(call.url).pathname, '/api/device/rgb-effect/edit/batch');
  assert.strictEqual(call.init.headers.authorization, 'Bearer tok');
  assert.deepStrictEqual(call.body, [{
    applyToDevice: true, devicesn: 'SN1', effectType: 3, id: 'S1', name: 'Firefly',
    subEffects: [{ effectId: 'S1', layouts: [] }],
  }]);
});

class FakeWS extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.sent = [];
    FakeWS.last = this;
    setImmediate(() => this.emit('open'));
  }

  send(data) { this.sent.push(data); if (this.onSend) this.onSend(data); }

  close() { this.emit('close'); }

  push(obj) { this.emit('message', Buffer.from(JSON.stringify(obj))); }
}

test('socket : commande + accusé, rapports d\'état, rejet', async () => {
  const api = { token: 'tok', websocketUrl: 'wss://x', login: async () => {} };
  const sock = new DreoSocket({ api, WebSocketImpl: FakeWS });
  const reports = [];
  sock.on('report', (sn, rep) => reports.push([sn, rep]));
  sock.start();
  await new Promise((r) => sock.once('connected', r));
  const ws = FakeWS.last;
  ws.onSend = (data) => {
    if (data === '2') return;
    const msg = JSON.parse(data);
    setImmediate(() => {
      if (msg.params.mode === 99) ws.push({ devicesn: msg.devicesn, method: 'control-reply', reported: { error_code: 500003, error_msg: 'instruction validate failed' } });
      else ws.push({ devicesn: msg.devicesn, method: 'control-report', reported: msg.params });
    });
  };
  assert.strictEqual(await sock.sendCommand('SN1', { fanon: true }), true);
  assert.deepStrictEqual(reports, [['SN1', { fanon: true }]]);
  const sent = JSON.parse(ws.sent[0]);
  assert.strictEqual(sent.method, 'control');
  assert.strictEqual(sent.devicesn, 'SN1');
  await assert.rejects(sock.sendCommand('SN1', { mode: 99 }), DreoCommandRejectedError);
  ws.push({ devicesn: 'SN1', method: 'control-reply', reported: { lighton: true } });
  assert.strictEqual(reports.length, 1, 'control-reply n\'est pas un état');
  sock.stop();
});
