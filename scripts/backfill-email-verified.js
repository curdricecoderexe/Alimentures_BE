/**
 * backfill-email-verified.js — one-off, run once when deploying email
 * verification enforcement.
 *
 * Every existing account already proved its email: registration and every
 * sign-in require a code sent to that address. This copies that fact into the
 * `emailVerified` flags the API now checks, so nobody is locked out.
 *
 *   node scripts/backfill-email-verified.js            # dry run (counts only)
 *   node scripts/backfill-email-verified.js --apply    # write
 */
'use strict';

require('dotenv').config({ quiet: true });
const admin = require('../lib/firebaseAdmin');
const db = require('../config/firebase');

const APPLY = process.argv.includes('--apply');

(async () => {
  const snap = await db.collection('users').get();
  const pending = snap.docs.filter((d) => d.data().emailVerified !== true);
  console.log(`${snap.size} users, ${pending.length} without emailVerified${APPLY ? '' : ' (dry run — pass --apply to write)'}`);
  if (!APPLY) process.exit(0);

  let done = 0;
  for (const doc of pending) {
    await doc.ref.set({ emailVerified: true }, { merge: true });
    await admin.auth().updateUser(doc.id, { emailVerified: true }).catch((err) => {
      console.warn(`  auth flag not updated for ${doc.id}: ${err.code || err.message}`);
    });
    done += 1;
  }
  console.log(`marked ${done} account(s) verified`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
