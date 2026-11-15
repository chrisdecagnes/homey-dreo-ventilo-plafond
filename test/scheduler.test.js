'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Scheduler = require('../lib/Scheduler');
const { CeilingFanState } = require('../lib/CeilingFanState');

function makeApp(now, profiles) {
  const settings = new Map([['schedules', profiles]]);
  const calls = [];
  const hub = {
    state: { supportsRing: true },
    applyFan: async (o) => calls.push(['fan', o]),
    applyLight: async (o) => calls.push(['light', o]),
    applyRing: async (o) => calls.push(['ring', o]),
  };
  const app = {
    hubs: new Map([['SN1', hub]]),
    homey: {
      settings: { get: (k) => settings.get(k), set: (k, v) => settings.set(k, v) },
      clock: { getTimezone: () => 'Europe/Paris' },
      __: (k) => k,
      setInterval, clearInterval,
    },
    log() {},
    error() {},
  };
  const scheduler = new Scheduler({ app, now: () => now.value });
  return { scheduler, calls, settings };
}

test('déclenche à l\'heure locale (Europe/Paris), une seule fois par minute, jours respectés', async () => {
  // dimanche 15/11/2026 07:30 à Paris = 06:30 UTC
  const now = { value: new Date('2026-11-15T06:30:10Z') };
  const { scheduler, calls, settings } = makeApp(now, {
    SN1: {
      enabled: true,
      rules: [
        { id: 'a', enabled: true, days: [7], time: '07:30', target: 'light', action: 'on', brightness: 60, temperature: 80 },
        { id: 'b', enabled: true, days: [1, 2, 3, 4, 5], time: '07:30', target: 'fan', action: 'on' }, // pas le dimanche
        { id: 'c', enabled: false, days: [7], time: '07:30', target: 'ring', action: 'off' }, // désactivée
        { id: 'd', enabled: true, days: [7], time: '07:31', target: 'fan', action: 'off' },
      ],
    },
  });
  assert.deepStrictEqual(scheduler.localTime(), { day: 7, time: '07:30', date: '2026-11-15' });
  await scheduler.tick();
  await scheduler.tick(); // même minute : pas de doublon
  assert.deepStrictEqual(calls, [['light', { on: true, brightness: 0.6, temperature: 0.8 }]]);
  now.value = new Date('2026-11-15T06:31:05Z');
  await scheduler.tick();
  assert.deepStrictEqual(calls.at(-1), ['fan', { on: false, speed: undefined, mode: undefined }]);
  const log = settings.get('scheduleLog');
  assert.strictEqual(log.length, 2);
  assert.strictEqual(log[0].ok, true);
});

test('profil désactivé : rien ne se déclenche ; activation par Flow', async () => {
  const now = { value: new Date('2026-11-16T17:00:00Z') }; // lundi 18:00 Paris
  const { scheduler, calls } = makeApp(now, {
    SN1: { enabled: false, rules: [{ id: 'a', days: [1], time: '18:00', target: 'ring', action: 'on', scene: 'firefly' }] },
  });
  await scheduler.tick();
  assert.strictEqual(calls.length, 0);
  scheduler.setProfileEnabled('SN1', true);
  assert.strictEqual(scheduler.isProfileEnabled('SN1'), true);
  now.value = new Date('2026-11-23T17:00:00Z'); // lundi suivant
  await scheduler.tick();
  assert.deepStrictEqual(calls, [['ring', { on: true, brightness: undefined, scene: 'firefly' }]]);
});

test('heure d\'été : 07:00 à Paris en juillet = 05:00 UTC', () => {
  const now = { value: new Date('2026-07-06T05:00:00Z') };
  const { scheduler } = makeApp(now, {});
  assert.deepStrictEqual(scheduler.localTime(), { day: 1, time: '07:00', date: '2026-07-06' });
});

test('erreur journalisée si le ventilateur n\'a pas d\'appareil Homey ; le test la remonte', async () => {
  const now = { value: new Date() };
  const { scheduler, settings } = makeApp(now, {});
  await assert.rejects(scheduler.run('INCONNU', { target: 'fan', action: 'on' }, 'test'), /schedule_no_device/);
  assert.strictEqual(settings.get('scheduleLog')[0].ok, false);
});

test('couleurs : conversions teinte/saturation ↔ RGB', () => {
  assert.deepStrictEqual(CeilingFanState.hsToRgb(0, 1), { rgb: [255, 0, 0], int: 0xff0000, hex: '#FF0000' });
  assert.strictEqual(CeilingFanState.hsToRgb(1 / 3, 1).hex, '#00FF00');
  assert.strictEqual(CeilingFanState.hsToRgb(0.5, 0).hex, '#FFFFFF');
  assert.deepStrictEqual(CeilingFanState.rgbIntToHs(0x0000ff), { hue: 0.67, saturation: 1 });
});

test('format hebdomadaire v0.4 : événements par jour, migration de l\'ancien format', async () => {
  const now = { value: new Date('2026-11-17T21:30:00Z') }; // mardi 22:30 Paris
  const { scheduler, calls } = makeApp(now, {
    SN1: {
      enabled: true,
      week: {
        2: [{ id: 'x', time: '22:30', target: 'fan', action: 'on', speed: 3, mode: 'sleep' }],
        3: [{ id: 'y', time: '22:30', target: 'light', action: 'off' }],
      },
    },
  });
  await scheduler.tick();
  assert.deepStrictEqual(calls, [['fan', { on: true, speed: 3, mode: 'sleep' }]]);

  const migrated = Scheduler.normalizeProfile({
    enabled: true,
    rules: [{ id: 'r', enabled: true, days: [1, 7], time: '08:00', target: 'light', action: 'on' },
      { id: 's', enabled: false, days: [1], time: '09:00', target: 'fan', action: 'on' }],
  });
  assert.strictEqual(migrated.enabled, true);
  assert.deepStrictEqual(migrated.week[1].map((e) => e.time), ['08:00']);
  assert.deepStrictEqual(migrated.week[7].map((e) => e.target), ['light']);
  assert.deepStrictEqual(migrated.week[3], []);

  scheduler.setProfileEnabled('SN1', false);
  assert.strictEqual(scheduler.getProfiles().SN1.week[2].length, 1, 'désactiver conserve les horaires');
});
