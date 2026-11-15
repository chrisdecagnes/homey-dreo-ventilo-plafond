'use strict';

/**
 * Mini "Homey Compose" : régénère app.json à partir de .homeycompose/ et drivers/*.
 * (La CLI officielle `homey app build` / `homey app run` fait la même chose ; ce script
 * permet de produire app.json sans la CLI.)
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const listJson = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : []);

const app = read(path.join(root, '.homeycompose/app.json'));

const capDir = path.join(root, '.homeycompose/capabilities');
const caps = {};
for (const f of listJson(capDir)) caps[path.basename(f, '.json')] = read(path.join(capDir, f));
if (Object.keys(caps).length) app.capabilities = caps;

const flow = {};
for (const kind of ['triggers', 'conditions', 'actions']) {
  const dir = path.join(root, '.homeycompose/flow', kind);
  const cards = listJson(dir).map((f) => ({ id: path.basename(f, '.json'), ...read(path.join(dir, f)) }));
  if (cards.length) flow[kind] = cards;
}
if (Object.keys(flow).length) app.flow = flow;

const driversDir = path.join(root, 'drivers');
app.drivers = fs.readdirSync(driversDir).sort().filter((id) => fs.existsSync(path.join(driversDir, id, 'driver.compose.json')))
  .map((id) => {
    const text = fs.readFileSync(path.join(driversDir, id, 'driver.compose.json'), 'utf8')
      .replace(/{{driverAssetsPath}}/g, `/drivers/${id}/assets`);
    return { id, ...JSON.parse(text) };
  });

const header = { _comment: 'This file is generated. Please edit .homeycompose/app.json instead.' };
fs.writeFileSync(path.join(root, 'app.json'), `${JSON.stringify({ ...header, ...app }, null, 2)}\n`);
console.log('app.json généré :', app.drivers.length, 'pilotes,', Object.keys(caps).length, 'capacités,',
  Object.values(flow).reduce((n, l) => n + l.length, 0), 'cartes Flow');
