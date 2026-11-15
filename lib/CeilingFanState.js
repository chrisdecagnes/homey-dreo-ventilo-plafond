'use strict';

/**
 * Modèle d'état d'un ventilateur de plafond Dreo + "porte d'alimentation".
 *
 * Comportement observé sur le matériel (documenté par hass-dreo, DR-HCF002S / CF712S) :
 *   charge_allumée = poweron ET <charge>on      (charges : fanon, lighton, atmon)
 *  - Les clés de charge sont MÉMORISÉES quand poweron passe à false.
 *  - Une commande de charge envoyée porte fermée est ignorée physiquement : pour réveiller
 *    une seule charge il faut, dans la même commande, ouvrir la porte et forcer les
 *    autres charges à false (sinon poweron:true rallume tout ce qui était mémorisé).
 *  - L'appareil ne referme jamais la porte seul : éteindre la dernière charge doit aussi
 *    envoyer poweron:false.
 * Les modèles sans clé poweron (ex. CLF521S / DR-HCF521S) n'ont pas de porte.
 */

const LOAD_KEYS = ['fanon', 'lighton', 'atmon'];

// fanModes : valeurs "mode" proposées par l'appli Dreo (controlsConf) pour chaque modèle.
// ringColor : 'atmcolor' = couleur directe (clé atmcolor), 'effect' = effet RGBIC "Constant".
const MODEL_INFO = {
  'DR-HCF002S': { commercial: 'CF712S (RGBIC)', rgbic: true, fanModes: [1, 2, 3, 5], ringColor: 'effect' },
  'DR-HCF007S': { commercial: 'CF521S (RGBIC)', rgbic: true, fanModes: [1, 2, 3, 4], ringColor: 'atmcolor' },
  'DR-HCF521S': { commercial: 'CLF521S', rgbic: false, fanModes: [1, 2, 3, 4] },
};

/** Modes de ventilation (clé "mode"). Valeurs issues de controlsConf de l'appli Dreo. */
const FAN_MODES = {
  normal: 1, // "device_fans_mode_straight" – Normal
  natural: 2, // "device_fans_mode_natural" – Naturel / doux
  sleep: 3, // "device_control_mode_sleep" – Sommeil
  reverse: 4, // "base_reverse" – rotation inversée (mode hiver) – CF521S, CLF521S
  auto: 5, // "base_auto" – automatique – CF712S
};

/** Scènes de l'anneau LED : identifiant Homey → nom dans le catalogue Dreo (sceneEffects). */
const RING_SCENES = {
  wave: 'Wave',
  cherry_blossom: 'Cherry Blossom',
  christmas: 'Christmas',
  halloween: 'Halloween',
  birthday_party: 'Birthday Party',
  firefly: 'Firefly',
};

function unwrap(entry) {
  if (entry && typeof entry === 'object' && !Array.isArray(entry) && 'state' in entry) return entry.state;
  return entry;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

class CeilingFanState {
  constructor({ model } = {}) {
    this.model = model || null;
    this.values = {}; // dernières valeurs connues (clé Dreo → valeur)
    this.lastLocalWrite = 0; // secondes epoch
  }

  get hasGate() {
    return typeof this.values.poweron === 'boolean';
  }

  get supportsRing() {
    return typeof this.values.atmon === 'boolean';
  }

  /** Plage de luminosité de l'anneau : 1-100 sur les révisions RGBIC (rgbeffectid), 1-5 sinon. */
  get ringBrightnessRange() {
    if (this.model === 'DR-HCF007S' || this.values.rgbeffectid !== undefined) return [1, 100];
    return [1, 5];
  }

  gated(load) {
    const v = this.values[load];
    if (typeof v !== 'boolean') return null;
    if (!this.hasGate) return v;
    return this.values.poweron && v;
  }

  /**
   * Applique un état REST complet ("mixed": { clé: {state, timestamp} }).
   * Une valeur de porte/charge qui contredit notre dernière écriture et dont l'horodatage
   * est antérieur à celle-ci est ignorée (latence du cloud Dreo).
   * @returns {boolean} vrai si au moins une valeur a été ignorée car obsolète
   */
  applyRest(mixed) {
    let stale = false;
    for (const [key, entry] of Object.entries(mixed || {})) {
      const value = unwrap(entry);
      if (value === null || value === undefined) continue;
      if (key === 'poweron' || LOAD_KEYS.includes(key)) {
        const ts = entry && typeof entry === 'object' ? entry.timestamp : null;
        if (this.values[key] !== undefined && this.values[key] !== value
          && this.lastLocalWrite && typeof ts === 'number' && ts < this.lastLocalWrite) {
          stale = true;
          continue;
        }
      }
      this.values[key] = value;
    }
    return stale;
  }

  /** Applique un delta WebSocket ("reported"). */
  applyReport(reported) {
    for (const [key, value] of Object.entries(reported || {})) {
      if (value === null || value === undefined) continue;
      this.values[key] = value;
    }
  }

  /** Mise à jour optimiste avec ce que l'on envoie. */
  applyOptimistic(params) {
    for (const [key, value] of Object.entries(params)) this.values[key] = value;
    this.lastLocalWrite = Date.now() / 1000;
  }

  /**
   * Prépare une commande : applique l'optimisme puis ajoute les clés de porte nécessaires.
   * Doit être appelée avec l'état AVANT application (on capture la porte d'origine).
   */
  buildCommand(params) {
    const gateBefore = this.values.poweron;
    const batchLoads = LOAD_KEYS.filter((k) => k in params);
    this.applyOptimistic(params);
    if (batchLoads.length === 0 || 'poweron' in params || typeof gateBefore !== 'boolean') {
      return { ...params };
    }
    const anyOnInBatch = batchLoads.some((k) => params[k] === true);
    if (gateBefore === false && anyOnInBatch) {
      const final = { ...params, poweron: true };
      for (const k of LOAD_KEYS) {
        if (!(k in params) && typeof this.values[k] === 'boolean') final[k] = false;
      }
      this.applyOptimistic(final);
      return final;
    }
    if (gateBefore === true && !LOAD_KEYS.some((k) => this.values[k] === true)) {
      const final = { ...params, poweron: false };
      this.applyOptimistic(final);
      return final;
    }
    return { ...params };
  }

  // ---------------------------------------------------------------------------
  // Conversion vers les capacités Homey
  // ---------------------------------------------------------------------------

  toCapabilities() {
    const v = this.values;
    const caps = {};
    const fanOn = this.gated('fanon');
    if (fanOn !== null) caps.onoff = fanOn;
    if (typeof v.windlevel === 'number') caps.dreo_fan_speed = clamp(v.windlevel, 1, 12);
    if (typeof v.mode === 'number') {
      const mode = Object.keys(FAN_MODES).find((m) => FAN_MODES[m] === v.mode);
      if (mode) caps.dreo_fan_mode = mode;
    }
    const lightOn = this.gated('lighton');
    if (lightOn !== null) caps['onoff.light'] = lightOn;
    if (typeof v.brightness === 'number') caps['dim.light'] = clamp(v.brightness, 1, 100) / 100;
    if (typeof v.colortemp === 'number') {
      // Dreo : 0 = chaud (2700 K) … 100 = froid (6500 K) ; Homey : 0 = froid … 1 = chaud
      caps.light_temperature = Math.round((1 - clamp(v.colortemp, 0, 100) / 100) * 100) / 100;
    }
    if (typeof v.atmcolor === 'number') {
      const { hue, saturation } = CeilingFanState.rgbIntToHs(v.atmcolor);
      caps['hue.ring'] = hue;
      caps['saturation.ring'] = saturation;
    }
    const ringOn = this.gated('atmon');
    if (ringOn !== null) caps['onoff.ring'] = ringOn;
    if (typeof v.atmbri === 'number') {
      const [lo, hi] = this.ringBrightnessRange;
      caps['dim.ring'] = Math.round((clamp(v.atmbri, lo, hi) / hi) * 100) / 100;
    }
    return caps;
  }

  static speedParam(speed) {
    return { windlevel: clamp(Math.round(speed), 1, 12) };
  }

  static brightnessParam(dim) {
    return { brightness: clamp(Math.round(dim * 100), 1, 100) };
  }

  static colorTempParam(homeyTemp) {
    return { colortemp: clamp(Math.round((1 - homeyTemp) * 100), 0, 100) };
  }

  ringBrightnessParam(dim) {
    const [lo, hi] = this.ringBrightnessRange;
    return { atmbri: clamp(Math.round(dim * hi), lo, hi) };
  }

  /** Couleur de l'anneau : teinte/saturation Homey (0-1) → entier 0xRRGGBB et "#RRGGBB". */
  static hsToRgb(hue, saturation) {
    const h = ((hue % 1) + 1) % 1 * 6;
    const s = clamp(saturation, 0, 1);
    const c = s;
    const x = c * (1 - Math.abs((h % 2) - 1));
    const m = 1 - c;
    const [r1, g1, b1] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h) % 6];
    const rgb = [r1, g1, b1].map((v) => Math.round((v + m) * 255));
    const int = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
    const hex = `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
    return { rgb, int, hex };
  }

  static rgbIntToHs(int) {
    const r = ((int >> 16) & 255) / 255;
    const g = ((int >> 8) & 255) / 255;
    const b = (int & 255) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
    }
    h = ((h / 6) + 1) % 1;
    return { hue: Math.round(h * 100) / 100, saturation: max ? Math.round((d / max) * 100) / 100 : 0 };
  }

  static modeParam(mode) {
    if (!(mode in FAN_MODES)) throw new Error(`Mode de ventilation inconnu : ${mode}`);
    return { mode: FAN_MODES[mode] };
  }
}

module.exports = {
  CeilingFanState, LOAD_KEYS, MODEL_INFO, FAN_MODES, RING_SCENES, unwrap,
};
