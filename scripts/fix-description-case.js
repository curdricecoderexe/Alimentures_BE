/**
 * fix-description-case.js — convert ALL-CAPS product descriptions to sentence
 * case so the storefront catalogue reads consistently.
 *
 * Only descriptions that are (almost) entirely upper case are touched; text
 * already in normal case is left alone. Known proper nouns (grain / place
 * names) keep their capitals. A JSON backup of every changed value is written
 * before anything is saved.
 *
 *   node scripts/fix-description-case.js            # dry run — prints before → after
 *   node scripts/fix-description-case.js --apply    # write (backup in scripts/backups/)
 *   node scripts/fix-description-case.js --restore scripts/backups/<file>.json
 */
'use strict';

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const admin = require('../lib/firebaseAdmin');
const db = require('../config/firebase');

const APPLY = process.argv.includes('--apply');
const RESTORE = process.argv.includes('--restore') ? process.argv[process.argv.indexOf('--restore') + 1] : null;

// Words/phrases that keep capitals after conversion (matched case-insensitively).
const PROPER = [
  'Tamil Nadu', 'Sivappu Cholam', 'Karuppu Kavani', 'Kattu Yaanam', 'Mappillai Samba',
  'Ragi', 'Thinai', 'Kambu', 'Cholam', 'Varagu', 'Karunguruvai', 'Nattu Sakkarai', 'A2',
];

const isAllCaps = (s) => {
  const letters = String(s || '').replace(/[^A-Za-z]/g, '');
  return letters.length >= 4 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.8;
};

/** "TAMIL NADU HERITAGE RICE TRINITY" → "Tamil Nadu heritage rice trinity" */
function sentenceCase(text) {
  let out = String(text).toLowerCase();
  // Capitalise the first letter of each sentence.
  out = out.replace(/(^\s*|[.!?]\s+)([a-z])/g, (m, pre, ch) => pre + ch.toUpperCase());
  for (const name of PROPER) {
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    out = out.replace(re, name);
  }
  return out;
}

async function restore(file) {
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const r of rows) {
    await db.collection('products').doc(r.id).update({ description: r.before });
    console.log(`restored ${r.id}`);
  }
  console.log(`${rows.length} description(s) restored. Rebuild the storefront so pre-rendered pages update.`);
}

(async () => {
  if (RESTORE) return restore(RESTORE);

  const snap = await db.collection('products').get();
  const changes = [];
  snap.forEach((doc) => {
    const p = doc.data();
    if (!p.description || !isAllCaps(p.description)) return;
    const after = sentenceCase(p.description.trim());
    if (after !== p.description) changes.push({ id: doc.id, title: p.title || p.name || '', before: p.description, after });
  });

  console.log(`${snap.size} products, ${changes.length} ALL-CAPS description(s)${APPLY ? '' : ' (dry run — pass --apply to write)'}\n`);
  for (const c of changes) console.log(`• ${c.title}\n    ${c.before}\n  → ${c.after}\n`);
  if (!APPLY || !changes.length) return;

  const dir = path.join(__dirname, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `descriptions-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(changes, null, 2));
  console.log(`backup: ${path.relative(process.cwd(), file)}`);

  for (const c of changes) {
    await db.collection('products').doc(c.id).update({
      description: c.after,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  console.log(`${changes.length} description(s) updated. Rebuild the storefront so pre-rendered pages update.`);
})().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
