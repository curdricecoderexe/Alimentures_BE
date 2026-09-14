/**
 * locationService.js — India state/UT + city lookup.
 *
 * Data comes from a trimmed, committed JSON file (`data/indiaLocations.json`,
 * ~49 KB) generated from `country-state-city`. Re-run
 * `node scripts/gen-india-locations.js` to refresh it.
 *
 * The frontend never bundles this; it calls `/api/delivery/locations/*`.
 */
'use strict';

const data = require('../data/indiaLocations.json');

const STATE_NAMES = data.states.map((s) => s.name);
const STATE_SET = new Set(STATE_NAMES);
const CITY_MAP = data.cities; // { "Tamil Nadu": ["Chennai", ...], ... }

// case-insensitive city membership per state
const CITY_SET_BY_STATE = Object.fromEntries(
  Object.entries(CITY_MAP).map(([st, list]) => [st, new Set(list.map((c) => c.toLowerCase()))]),
);

/** All Indian states + union territories, alphabetical. */
function listStates() {
  return STATE_NAMES;
}

function isValidState(state) {
  return typeof state === 'string' && STATE_SET.has(state.trim());
}

/**
 * Cities for a state, optionally filtered by a search prefix/substring and
 * capped. Returns [] for an unknown state.
 */
function listCities(state, { q = '', limit = 100 } = {}) {
  const st = typeof state === 'string' ? state.trim() : '';
  const all = CITY_MAP[st];
  if (!all) return [];
  const query = String(q || '').trim().toLowerCase();
  const filtered = query ? all.filter((c) => c.toLowerCase().includes(query)) : all;
  return filtered.slice(0, Math.max(1, Math.min(500, Number(limit) || 100)));
}

/** True when `city` belongs to `state` (case-insensitive). */
function cityBelongsToState(city, state) {
  const st = typeof state === 'string' ? state.trim() : '';
  const set = CITY_SET_BY_STATE[st];
  if (!set) return false;
  return set.has(String(city || '').trim().toLowerCase());
}

module.exports = { listStates, isValidState, listCities, cityBelongsToState };
