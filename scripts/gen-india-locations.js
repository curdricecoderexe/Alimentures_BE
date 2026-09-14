/**
 * gen-india-locations.js — one-off generator.
 *
 * Extracts the India-only state/UT + city dataset from `country-state-city`
 * (a devDependency) into a trimmed, committed JSON file so the running server
 * never has to load the full ~6 MB multi-country dataset into memory.
 *
 * Re-run after bumping `country-state-city` to refresh the data:
 *   node scripts/gen-india-locations.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { State, City } = require('country-state-city');

const OUT = path.join(__dirname, '..', 'data', 'indiaLocations.json');

const states = State.getStatesOfCountry('IN')
  .map((s) => ({ code: s.isoCode, name: s.name }))
  .sort((a, b) => a.name.localeCompare(b.name));

const cities = {};
let total = 0;
for (const st of states) {
  const list = [...new Set(
    City.getCitiesOfState('IN', st.code)
      .map((c) => c.name.trim())
      .filter(Boolean),
  )].sort((a, b) => a.localeCompare(b));
  cities[st.name] = list;
  total += list.length;
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), states, cities }, null, 0));

console.log(`Wrote ${OUT}`);
console.log(`  ${states.length} states/UTs, ${total} cities, ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
