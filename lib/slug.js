/**
 * slug.js — readable product URL slugs (/products/<slug>).
 *
 * A product's slug is its stored `slug` (admin-set) or, failing that, one
 * derived from its title. Derived slugs are made unique across the catalogue
 * deterministically: the oldest product keeps the plain slug, later ones get a
 * short id suffix. MUST stay in sync with slugify() in the frontend's
 * src/lib/seo.js.
 */
'use strict';

const slugify = (text) => String(text || '')
  .normalize('NFKD')
  .replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 80)
  .replace(/-+$/g, '');

const createdMs = (p) => {
  const t = p.createdAt;
  if (!t) return 0;
  if (typeof t.toMillis === 'function') return t.toMillis();
  if (t._seconds !== undefined) return t._seconds * 1000;
  return new Date(t).getTime() || 0;
};

/** Map of product id -> unique slug for a whole catalogue. */
const buildSlugMap = (products) => {
  const map = new Map();
  const taken = new Set();
  // Explicit slugs win first, then derived ones oldest-first.
  const explicit = products.filter((p) => p.slug && slugify(p.slug));
  const derived = products.filter((p) => !(p.slug && slugify(p.slug)))
    .sort((a, b) => createdMs(a) - createdMs(b) || String(a.id).localeCompare(String(b.id)));
  for (const p of explicit) {
    let s = slugify(p.slug);
    if (taken.has(s)) s = `${s}-${String(p.id).slice(0, 6).toLowerCase()}`;
    taken.add(s);
    map.set(p.id, s);
  }
  for (const p of derived) {
    let s = slugify(p.title || p.name) || String(p.id).toLowerCase();
    if (taken.has(s)) s = `${s}-${String(p.id).slice(0, 6).toLowerCase()}`;
    taken.add(s);
    map.set(p.id, s);
  }
  return map;
};

module.exports = { slugify, buildSlugMap };
