'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { CeilingFanState } = require('../lib/CeilingFanState');

// Extraits d'états réels publiés dans les tests de hass-dreo (MIT)
const CF712S_STATE = {
  poweron: { state: false, timestamp: 1780303264 },
  fanon: { state: false, timestamp: 1780064221 },
  lighton: { state: false, timestamp: 1780064221 },
  atmon: { state: true, timestamp: 1780064221 },
  windlevel: { state: 3, timestamp: 1780064221 },
  mode: { state: 1, timestamp: 1780064592 },
  brightness: { state: 10, timestamp: 1780064221 },
  colortemp: { state: 100, timestamp: 1780064221 },
  atmbri: { state: 1, timestamp: 1780064221 },
  rgbeffectid: { state: '2060365036332777472', timestamp: 1780134811 },
  connected: { state: true, timestamp: 1780064221 },
};
const CLF521S_STATE = {
  fanon: { state: false, timestamp: 1 },
  lighton: { state: false, timestamp: 1 },
  windlevel: { state: 6, timestamp: 1 },
  mode: { state: 1, timestamp: 1 },
  brightness: { state: 75, timestamp: 1 },
  colortemp: { state: 50, timestamp: 1 },
  connected: { state: true, timestamp: 1 },
};

test('CF712S : capacités Homey avec porte fermée', () => {
  const s = new CeilingFanState({ model: 'DR-HCF002S' });
  s.applyRest(CF712S_STATE);
  const caps = s.toCapabilities();
  assert.strictEqual(caps.onoff, false);
  assert.strictEqual(caps['onoff.ring'], false, 'atmon mémorisé mais porte fermée => éteint');
  assert.strictEqual(caps.dreo_fan_speed, 3);
  assert.strictEqual(caps.dreo_fan_mode, 'normal');
  assert.strictEqual(caps['dim.light'], 0.1);
  assert.strictEqual(caps.light_temperature, 0, 'colortemp 100 (froid) => 0 côté Homey');
  assert.strictEqual(caps['dim.ring'], 0.01);
});

test('CF712S : allumer la lumière porte fermée ouvre la porte et éteint les autres charges', () => {
  const s = new CeilingFanState({ model: 'DR-HCF002S' });
  s.applyRest(CF712S_STATE);
  const cmd = s.buildCommand({ lighton: true });
  assert.deepStrictEqual(cmd, { lighton: true, poweron: true, fanon: false, atmon: false });
  const caps = s.toCapabilities();
  assert.strictEqual(caps['onoff.light'], true);
  assert.strictEqual(caps['onoff.ring'], false);
  assert.strictEqual(caps.onoff, false);
});

test('CF712S : éteindre la dernière charge referme la porte', () => {
  const s = new CeilingFanState({ model: 'DR-HCF002S' });
  s.applyRest(CF712S_STATE);
  s.buildCommand({ fanon: true });
  const cmd = s.buildCommand({ fanon: false });
  assert.deepStrictEqual(cmd, { fanon: false, poweron: false });
});

test('CF712S : deux charges allumées, en éteindre une ne ferme pas la porte', () => {
  const s = new CeilingFanState({ model: 'DR-HCF002S' });
  s.applyRest(CF712S_STATE);
  s.buildCommand({ fanon: true });
  assert.deepStrictEqual(s.buildCommand({ lighton: true }), { lighton: true });
  assert.deepStrictEqual(s.buildCommand({ fanon: false }), { fanon: false });
});

test('CLF521S : pas de porte, commandes brutes', () => {
  const s = new CeilingFanState({ model: 'DR-HCF521S' });
  s.applyRest(CLF521S_STATE);
  assert.strictEqual(s.hasGate, false);
  assert.strictEqual(s.supportsRing, false);
  assert.deepStrictEqual(s.buildCommand({ fanon: true, windlevel: 6 }), { fanon: true, windlevel: 6 });
  assert.deepStrictEqual(s.buildCommand({ fanon: false }), { fanon: false });
  const caps = s.toCapabilities();
  assert.strictEqual(caps.light_temperature, 0.5);
  assert.strictEqual(caps['onoff.ring'], undefined);
});

test('REST obsolète ignorée pour les charges après une écriture locale', () => {
  const s = new CeilingFanState({ model: 'DR-HCF002S' });
  s.applyRest(CF712S_STATE);
  s.buildCommand({ fanon: true });
  const stale = s.applyRest({ ...CF712S_STATE, windlevel: { state: 5, timestamp: 1 } });
  assert.strictEqual(stale, true);
  assert.strictEqual(s.values.fanon, true);
  assert.strictEqual(s.values.poweron, true);
  assert.strictEqual(s.values.windlevel, 5, 'les autres clés sont appliquées');
  const fresh = Date.now() / 1000 + 5;
  const stale2 = s.applyRest({ ...CF712S_STATE, fanon: { state: false, timestamp: fresh }, poweron: { state: false, timestamp: fresh } });
  assert.strictEqual(stale2, true, 'atmon/lighton restent contradictoires et anciens');
  assert.strictEqual(s.values.fanon, false, 'changement externe récent accepté');
});

test('Conversions', () => {
  assert.deepStrictEqual(CeilingFanState.speedParam(13), { windlevel: 12 });
  assert.deepStrictEqual(CeilingFanState.brightnessParam(0.004), { brightness: 1 });
  assert.deepStrictEqual(CeilingFanState.colorTempParam(1), { colortemp: 0 });
  assert.deepStrictEqual(CeilingFanState.modeParam('sleep'), { mode: 3 });
  assert.throws(() => CeilingFanState.modeParam('turbo'));
  const s = new CeilingFanState({ model: 'DR-HCF007S' });
  assert.deepStrictEqual(s.ringBrightnessParam(0.5), { atmbri: 50 });
  const legacy = new CeilingFanState({ model: 'DR-HCF002S' });
  legacy.applyRest({ atmon: { state: true } });
  assert.deepStrictEqual(legacy.ringBrightnessParam(1), { atmbri: 5 });
});
