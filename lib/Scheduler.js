'use strict';

/**
 * Programmation hebdomadaire par ventilateur (inspirée de « Homey Heating Scheduler ») :
 * pour chaque jour, une liste d'événements horaires.
 *
 * Réglage Homey `schedules` (écrit par la page de réglages de l'app) :
 * {
 *   "<numéro de série>": {
 *     "enabled": true,                     // profil actif ou non
 *     "week": {                            // 1 = lundi … 7 = dimanche
 *       "1": [{
 *         "id": "e1", "time": "07:30",     // heure locale de la Homey
 *         "target": "fan" | "light" | "ring",
 *         "action": "on" | "off",
 *         "speed": 1-12, "mode": "normal"…  // ventilateur (optionnels)
 *         "brightness": 1-100,               // lumière / anneau (optionnel, %)
 *         "temperature": 0-100,              // lumière (optionnel, % de blanc chaud)
 *         "scene": "firefly"…                // anneau (optionnel)
 *       }],
 *       "2": [], …
 *     }
 *   }
 * }
 * L'ancien format v0.3 ({ rules: [{ days: [..], time, … }] }) est converti automatiquement.
 */

const SETTINGS_KEY = 'schedules';
const LOG_KEY = 'scheduleLog';
const LOG_MAX = 30;
const TICK_MS = 20 * 1000;
const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

class Scheduler {
  /**
   * @param {object} opts
   * @param {object} opts.app     application Homey (hubs, homey, log, error)
   * @param {Function} [opts.now] horloge injectable pour les tests
   */
  constructor({ app, now }) {
    this.app = app;
    this.homey = app.homey;
    this.now = now || (() => new Date());
    this._timer = null;
    this._fired = new Set();
  }

  start() {
    this.stop();
    this._timer = this.homey.setInterval(() => this.tick().catch((err) => this.app.error('Programmation :', err)), TICK_MS);
  }

  stop() {
    if (this._timer) this.homey.clearInterval(this._timer);
    this._timer = null;
  }

  /** Convertit un profil (ancien ou nouveau format) en { enabled, week: {1..7: [événements]} }. */
  static normalizeProfile(profile) {
    const week = {};
    for (let d = 1; d <= 7; d++) week[d] = [];
    if (!profile || typeof profile !== 'object') return { enabled: false, week };
    if (profile.week && typeof profile.week === 'object') {
      for (let d = 1; d <= 7; d++) {
        const list = profile.week[d] || profile.week[String(d)];
        if (Array.isArray(list)) week[d] = list.filter((e) => e && typeof e === 'object');
      }
    } else if (Array.isArray(profile.rules)) {
      for (const rule of profile.rules) {
        if (!rule || rule.enabled === false || !Array.isArray(rule.days)) continue;
        const { days, enabled, ...event } = rule;
        for (const d of days.map(Number)) {
          if (week[d]) week[d].push({ ...event, id: `${rule.id || 'r'}-${d}` });
        }
      }
    }
    for (let d = 1; d <= 7; d++) week[d].sort((x, y) => String(x.time).localeCompare(String(y.time)));
    return { enabled: !!profile.enabled, week };
  }

  getProfiles() {
    const raw = this.homey.settings.get(SETTINGS_KEY) || {};
    const out = {};
    for (const [sn, p] of Object.entries(raw)) out[sn] = Scheduler.normalizeProfile(p);
    return out;
  }

  setProfileEnabled(sn, enabled) {
    const profiles = this.getProfiles();
    profiles[sn] = { ...(profiles[sn] || Scheduler.normalizeProfile(null)), enabled: !!enabled };
    this.homey.settings.set(SETTINGS_KEY, profiles);
  }

  isProfileEnabled(sn) {
    const p = this.getProfiles()[sn];
    return !!(p && p.enabled);
  }

  timezone() {
    try {
      return (this.homey.clock && this.homey.clock.getTimezone()) || 'Europe/Paris';
    } catch (e) {
      return 'Europe/Paris';
    }
  }

  /** Jour (1-7), heure "HH:MM" et date locale dans le fuseau de la Homey. */
  localTime(date = this.now()) {
    const parts = {};
    new Intl.DateTimeFormat('en-GB', {
      timeZone: this.timezone(),
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date).forEach((p) => { parts[p.type] = p.value; });
    return {
      day: WEEKDAYS[parts.weekday],
      time: `${parts.hour}:${parts.minute}`,
      date: `${parts.year}-${parts.month}-${parts.day}`,
    };
  }

  /** Règles à exécuter maintenant (au plus une fois par minute et par règle). */
  dueRules() {
    const { day, time, date } = this.localTime();
    const due = [];
    for (const [sn, profile] of Object.entries(this.getProfiles())) {
      if (!profile.enabled) continue;
      for (const rule of profile.week[day] || []) {
        if (rule.enabled === false || rule.time !== time) continue;
        const key = `${date}|${time}|${sn}|${rule.id}`;
        if (this._fired.has(key)) continue;
        this._fired.add(key);
        due.push({ sn, rule });
      }
    }
    // purge des clés des jours précédents
    for (const key of this._fired) if (!key.startsWith(date)) this._fired.delete(key);
    return due;
  }

  async tick() {
    for (const { sn, rule } of this.dueRules()) {
      await this.run(sn, rule, 'schedule');
    }
  }

  /** Exécute une règle (programmation ou bouton « Tester » des réglages). */
  async run(sn, rule, origin = 'schedule') {
    const hub = this.app.hubs.get(sn);
    const entry = {
      at: this.now().toISOString(),
      sn,
      name: this.app.fanDisplayName ? this.app.fanDisplayName(sn) : sn,
      target: rule.target,
      action: rule.action,
      origin,
      ok: true,
    };
    try {
      if (!hub) throw new Error(this.homey.__('errors.schedule_no_device'));
      const on = rule.action === 'on';
      const pct = (v) => (typeof v === 'number' && v > 0 ? Math.min(100, v) / 100 : undefined);
      if (rule.target === 'fan') {
        await hub.applyFan({ on, speed: rule.speed || undefined, mode: rule.mode || undefined });
      } else if (rule.target === 'light') {
        await hub.applyLight({
          on,
          brightness: pct(rule.brightness),
          temperature: typeof rule.temperature === 'number' ? Math.max(0, Math.min(100, rule.temperature)) / 100 : undefined,
        });
      } else if (rule.target === 'ring') {
        if (!hub.state.supportsRing) throw new Error(this.homey.__('errors.no_ring'));
        await hub.applyRing({ on, brightness: pct(rule.brightness), scene: rule.scene || undefined });
      } else {
        throw new Error(`Cible inconnue : ${rule.target}`);
      }
      this.app.log(`Programmation ${sn} : ${rule.target} ${rule.action} OK`);
    } catch (err) {
      entry.ok = false;
      entry.error = err.message;
      this.app.error(`Programmation ${sn} :`, err.message);
    }
    this._appendLog(entry);
    if (!entry.ok && origin === 'test') throw new Error(entry.error);
    return entry;
  }

  _appendLog(entry) {
    const log = this.homey.settings.get(LOG_KEY) || [];
    log.unshift(entry);
    this.homey.settings.set(LOG_KEY, log.slice(0, LOG_MAX));
  }
}

module.exports = Scheduler;
