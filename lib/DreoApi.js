'use strict';

/**
 * Client REST du cloud Dreo.
 *
 * Protocole issu du projet open source hass-dreo (JeffSteinbok/hass-dreo, licence MIT),
 * lui-même obtenu par rétro-ingénierie de l'application mobile Dreo.
 *  - Authentification : POST /api/oauth/login (mot de passe haché en MD5)
 *  - Liste des appareils : GET /api/v2/user-device/device/list
 *  - État d'un appareil : GET /api/user-device/device/state?deviceSn=...
 *  - Effets RGBIC (scènes de l'anneau LED) : GET /api/device/rgb-effect/all/list
 *                                             POST /api/device/rgb-effect/edit/batch
 * Les commandes temps réel passent par le WebSocket (voir DreoSocket.js).
 */

const crypto = require('crypto');

const CLIENT_ID = '7de37c362ee54dcf9c4561812309347a';
const CLIENT_SECRET = '32dfa0764f25451d99f94e1693498791';
const HIMEI = 'faede31549d649f58864093158787ec9';

const AUTH_REGION_TO_API = { NA: 'us', EU: 'eu' };
const API_TIMEOUT_MS = 20000;

class DreoApiError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.name = 'DreoApiError';
    this.status = status;
    this.code = code;
  }
}

function md5(value) {
  return crypto.createHash('md5').update(String(value), 'utf8').digest('hex');
}

function timestamp() {
  return String(Date.now());
}

class DreoApi {
  /**
   * @param {object} opts
   * @param {string} opts.email
   * @param {string} [opts.password]      mot de passe en clair (jamais stocké)
   * @param {string} [opts.passwordHash]  MD5 du mot de passe (ce qui est stocké)
   * @param {string} [opts.region]        'EU' | 'NA' (détectée automatiquement au login)
   * @param {string} [opts.token]
   * @param {Function} [opts.fetch]       injection pour les tests
   * @param {Function} [opts.log]
   */
  constructor({ email, password, passwordHash, region = 'EU', token = null, fetch: fetchImpl, log } = {}) {
    this.email = email;
    this.passwordHash = passwordHash || (password ? md5(password) : null);
    this.region = AUTH_REGION_TO_API[region] ? region : 'EU';
    this.token = token;
    this._fetch = fetchImpl || globalThis.fetch;
    this.log = log || (() => {});
    this._loginPromise = null;
  }

  get apiRegion() {
    return AUTH_REGION_TO_API[this.region] || 'eu';
  }

  get baseUrl() {
    return `https://app-api-${this.apiRegion}.dreo-tech.com`;
  }

  get websocketUrl() {
    return `wss://wsb-${this.apiRegion}.dreo-tech.com/websocket?accessToken=${encodeURIComponent(this.token)}&timestamp=${timestamp()}`;
  }

  _headers() {
    const headers = {
      ua: 'dreo/2.8.2',
      lang: 'en',
      'content-type': 'application/json; charset=UTF-8',
      'user-agent': 'okhttp/4.9.1',
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    return headers;
  }

  async _request(method, path, { query = {}, body = null } = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries({ ...query, timestamp: timestamp() })) {
      url.searchParams.set(k, String(v));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    let res;
    try {
      res = await this._fetch(url.toString(), {
        method: method.toUpperCase(),
        headers: this._headers(),
        body: body === null ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new DreoApiError(`Erreur réseau vers le cloud Dreo : ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
    let json = null;
    const text = await res.text();
    if (text) {
      try { json = JSON.parse(text); } catch (e) { /* réponse non JSON */ }
    }
    if (res.status !== 200) {
      throw new DreoApiError(`Le cloud Dreo a répondu HTTP ${res.status}`, { status: res.status, code: json && json.code });
    }
    if (!json || json.code !== 0) {
      throw new DreoApiError(`Le cloud Dreo a refusé la requête : ${(json && json.msg) || 'réponse invalide'}`, {
        status: res.status,
        code: json && json.code,
      });
    }
    return json.data;
  }

  /** Requête authentifiée avec une nouvelle tentative après re-login sur 401. */
  async _authed(method, path, opts) {
    if (!this.token) await this.login();
    try {
      return await this._request(method, path, opts);
    } catch (err) {
      if (err.status === 401) {
        this.log('Jeton Dreo expiré, nouvelle connexion');
        this.token = null;
        await this.login();
        return this._request(method, path, opts);
      }
      throw err;
    }
  }

  /** Connexion ; gère la redirection automatique vers la bonne région (EU/NA). */
  async login() {
    if (this._loginPromise) return this._loginPromise;
    this._loginPromise = this._doLogin().finally(() => { this._loginPromise = null; });
    return this._loginPromise;
  }

  async _doLogin(depth = 0) {
    if (!this.email || !this.passwordHash) {
      throw new DreoApiError('Identifiants Dreo manquants');
    }
    this.token = null;
    const data = await this._request('post', '/api/oauth/login', {
      body: {
        acceptLanguage: 'en',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        email: this.email,
        encrypt: 'ciphertext',
        grant_type: 'email-password',
        himei: HIMEI,
        password: this.passwordHash,
        scope: 'all',
      },
    });
    const reportedRegion = data && data.region;
    if (reportedRegion && AUTH_REGION_TO_API[reportedRegion] && reportedRegion !== this.region && depth === 0) {
      this.log(`Compte Dreo dans la région ${reportedRegion}, reconnexion sur ce serveur`);
      this.region = reportedRegion;
      return this._doLogin(depth + 1);
    }
    if (!data || !data.access_token) throw new DreoApiError('Réponse de connexion Dreo sans jeton');
    this.token = data.access_token;
    return { token: this.token, region: this.region };
  }

  async getDevices() {
    const data = await this._authed('get', '/api/v2/user-device/device/list', {
      query: { acceptLanguage: 'en', method: 'devices', pageNo: 1, pageSize: 100 },
    });
    return (data && Array.isArray(data.list)) ? data.list.filter((d) => d && d.sn) : [];
  }

  /** Renvoie l'objet "mixed" : { clé: { state, timestamp } } */
  async getDeviceState(sn) {
    const data = await this._authed('get', '/api/user-device/device/state', { query: { deviceSn: sn } });
    return (data && data.mixed) || {};
  }

  async getRgbEffectCatalog(sn) {
    return (await this._authed('get', '/api/device/rgb-effect/all/list', { query: { devicesn: sn } })) || {};
  }

  /**
   * Applique un effet du catalogue (effet de base ou scène) à l'anneau LED.
   * @param {string} sn
   * @param {object} effect  entrée du catalogue (basicEffects[] ou sceneEffects[])
   */
  async applyRgbEffect(sn, effect) {
    if (!effect || !effect.id) throw new DreoApiError('Effet RGB inconnu');
    const item = {
      applyToDevice: true,
      devicesn: sn,
      effectType: effect.effectType || 0,
      id: effect.id,
      name: effect.name,
      subEffects: [{
        effectId: effect.referencedId || effect.id,
        layouts: JSON.parse(JSON.stringify(effect.layouts || [])),
      }],
    };
    if (effect.subRemoteEffect !== undefined && effect.subRemoteEffect !== null) {
      item.subRemoteEffect = effect.subRemoteEffect;
    }
    await this._authed('post', '/api/device/rgb-effect/edit/batch', { body: [item] });
    return true;
  }
}

module.exports = { DreoApi, DreoApiError, md5 };
