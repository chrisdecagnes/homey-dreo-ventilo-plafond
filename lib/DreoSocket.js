'use strict';

/**
 * Connexion WebSocket au cloud Dreo : réception des changements d'état en temps réel
 * et envoi des commandes ({ devicesn, method: 'control', params, timestamp }).
 *
 * Messages reçus : { devicesn, method, reported }
 *   - 'report' / 'control-report' / 'device-online' : état réel de l'appareil (deltas)
 *   - 'control-reply' : accusé de réception du serveur (pas un état !)
 *   - 'device-offline' : l'appareil a quitté le cloud
 */

const EventEmitter = require('events');

const PING_INTERVAL_MS = 15000;
const PING_MESSAGE = '2';
const ACK_TIMEOUT_MS = 2000;
const MAX_RETRIES = 2;
const QUEUE_TIMEOUT_MS = 20000;
const ACK_METHODS = new Set(['control-reply', 'control-report']);

function resolveWebSocket() {
  if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket;
  // eslint-disable-next-line global-require
  return require('ws');
}

class DreoCommandRejectedError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DreoCommandRejectedError';
    this.code = code;
  }
}

class DreoSocket extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('./DreoApi').DreoApi} opts.api
   * @param {Function} [opts.WebSocketImpl]
   * @param {Function} [opts.log]
   * @param {Function} [opts.error]
   */
  constructor({ api, WebSocketImpl, log, error } = {}) {
    super();
    this.api = api;
    this._WebSocket = WebSocketImpl || null;
    this.log = log || (() => {});
    this.error = error || (() => {});
    this._ws = null;
    this._pingTimer = null;
    this._reconnectTimer = null;
    this._reconnectDelay = 2000;
    this._stopped = true;
    this._connected = false;
    this._queue = [];
    this._inFlight = null;
    this._connectWaiters = [];
  }

  get connected() {
    return this._connected;
  }

  start() {
    this._stopped = false;
    this._connect();
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._reconnectTimer);
    this._clearPing();
    if (this._ws) {
      try { this._ws.close(); } catch (e) { /* ignore */ }
    }
    this._ws = null;
    this._connected = false;
    const err = new Error('Connexion Dreo arrêtée');
    for (const job of this._queue) job.reject(err);
    this._queue = [];
    if (this._inFlight) this._inFlight.reject(err);
    this._inFlight = null;
  }

  async _connect() {
    if (this._stopped) return;
    try {
      if (!this.api.token) await this.api.login();
    } catch (err) {
      this.error('Connexion Dreo impossible :', err.message);
      this._scheduleReconnect();
      return;
    }
    const WS = this._WebSocket || resolveWebSocket();
    let ws;
    try {
      ws = new WS(this.api.websocketUrl);
    } catch (err) {
      this.error('Ouverture WebSocket impossible :', err.message);
      this._scheduleReconnect();
      return;
    }
    this._ws = ws;
    const onOpen = () => {
      this.log('WebSocket Dreo connecté');
      this._connected = true;
      this._reconnectDelay = 2000;
      this._startPing();
      this.emit('connected');
      const waiters = this._connectWaiters;
      this._connectWaiters = [];
      waiters.forEach((w) => w());
      this._pump();
    };
    const onMessage = (evt) => {
      const raw = evt && evt.data !== undefined ? evt.data : evt;
      this._onMessage(typeof raw === 'string' ? raw : raw.toString());
    };
    const onClose = () => {
      if (this._ws !== ws) return;
      this._connected = false;
      this._clearPing();
      this._ws = null;
      this.emit('disconnected');
      if (!this._stopped) {
        this.log('WebSocket Dreo fermé, reconnexion programmée');
        this._scheduleReconnect(true);
      }
    };
    const onError = (err) => {
      this.error('Erreur WebSocket Dreo :', (err && err.message) || err);
    };
    if (typeof ws.on === 'function') {
      ws.on('open', onOpen);
      ws.on('message', onMessage);
      ws.on('close', onClose);
      ws.on('error', onError);
    } else {
      ws.addEventListener('open', onOpen);
      ws.addEventListener('message', onMessage);
      ws.addEventListener('close', onClose);
      ws.addEventListener('error', onError);
    }
  }

  _scheduleReconnect(refreshToken = false) {
    if (this._stopped) return;
    clearTimeout(this._reconnectTimer);
    const delay = this._reconnectDelay;
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, 120000);
    this._reconnectTimer = setTimeout(async () => {
      if (refreshToken && delay >= 8000) {
        // Après plusieurs échecs, le jeton a peut-être expiré
        this.api.token = null;
      }
      this._connect();
    }, delay);
  }

  _startPing() {
    this._clearPing();
    this._pingTimer = setInterval(() => {
      try { if (this._ws) this._ws.send(PING_MESSAGE); } catch (e) { /* ignore */ }
    }, PING_INTERVAL_MS);
  }

  _clearPing() {
    clearInterval(this._pingTimer);
    this._pingTimer = null;
  }

  _onMessage(text) {
    if (!text || text[0] !== '{') return; // pong / keepalive
    let msg;
    try { msg = JSON.parse(text); } catch (e) { return; }
    const sn = msg.devicesn;
    const method = msg.method;
    if (this._inFlight && sn === this._inFlight.sn && ACK_METHODS.has(method)) {
      const job = this._inFlight;
      this._inFlight = null;
      clearTimeout(job.timer);
      const reported = msg.reported;
      if (reported && typeof reported === 'object' && 'error_code' in reported) {
        job.reject(new DreoCommandRejectedError(
          `Commande refusée par Dreo : ${reported.error_msg || reported.error_code}`, reported.error_code,
        ));
      } else {
        job.resolve(true);
      }
      setImmediate(() => this._pump());
    }
    if (!sn) return;
    if (method === 'device-offline') {
      this.emit('device-offline', sn);
      return;
    }
    if (method === 'device-online') this.emit('device-online', sn);
    if (method === 'report' || method === 'control-report' || method === 'device-online') {
      if (msg.reported && typeof msg.reported === 'object') this.emit('report', sn, msg.reported);
    }
  }

  /**
   * Envoie une commande ; résout lorsque le serveur l'accuse (ou après les tentatives).
   * Les commandes sont sérialisées : une seule en vol à la fois (comme l'appli Dreo).
   */
  sendCommand(sn, params) {
    return new Promise((resolve, reject) => {
      const job = { sn, params, attempt: 0 };
      const queueTimer = setTimeout(() => {
        const idx = this._queue.indexOf(job);
        if (idx !== -1) {
          this._queue.splice(idx, 1);
          reject(new Error('Cloud Dreo injoignable (WebSocket non connecté)'));
        }
      }, QUEUE_TIMEOUT_MS);
      job.resolve = (v) => { clearTimeout(queueTimer); resolve(v); };
      job.reject = (e) => { clearTimeout(queueTimer); reject(e); };
      this._queue.push(job);
      if (!this._stopped && !this._ws) this._connect();
      this._pump();
    });
  }

  _pump() {
    if (this._inFlight || !this._connected || !this._ws || this._queue.length === 0) return;
    const job = this._queue.shift();
    this._inFlight = job;
    const payload = JSON.stringify({
      devicesn: job.sn,
      method: 'control',
      params: job.params,
      timestamp: String(Date.now()),
    });
    this.log('→ Dreo', job.sn, JSON.stringify(job.params));
    try {
      this._ws.send(payload);
    } catch (err) {
      this._inFlight = null;
      job.reject(err);
      setImmediate(() => this._pump());
      return;
    }
    job.timer = setTimeout(() => {
      if (this._inFlight !== job) return;
      this._inFlight = null;
      if (job.attempt < MAX_RETRIES) {
        job.attempt += 1;
        this.log(`Pas d'accusé Dreo, nouvelle tentative ${job.attempt}/${MAX_RETRIES}`);
        this._queue.unshift(job);
      } else {
        // Comme hass-dreo : on considère la commande partie ; l'état sera revérifié par REST.
        this.error('Aucun accusé de réception Dreo pour', JSON.stringify(job.params));
        job.resolve(false);
      }
      this._pump();
    }, ACK_TIMEOUT_MS);
  }
}

module.exports = { DreoSocket, DreoCommandRejectedError };
