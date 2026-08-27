/**
 * analytics-retention.js — delete raw analytics documents older than
 * ANALYTICS_RETENTION_DAYS (default 90). Run on a daily schedule.
 *
 *   node scripts/analytics-retention.js            # delete
 *   node scripts/analytics-retention.js --dry-run  # count only
 *
 * Bounded per run (MAX_DELETES) so it never blows a function timeout; the daily
 * cron catches up over a few runs if there is a large backlog. The aggregated
 * collections (analytics_sales_*, analytics_products_lifetime, analytics_consents)
 * are intentionally NOT purged.
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const admin = require('firebase-admin');

if (!admin.apps.length) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) });
  } else {
    admin.initializeApp(); // application default credentials
  }
}
const db = admin.firestore();

const DRY_RUN = process.argv.includes('--dry-run');
const RETENTION_DAYS = Number(process.env.ANALYTICS_RETENTION_DAYS) || 90;
const MAX_DELETES = Number(process.env.ANALYTICS_RETENTION_MAX_DELETES) || 5000;
const COLLECTIONS = [
  'analytics_pageviews',
  'analytics_events',
  'analytics_sessions',
  'analytics_performance',
];

async function purgeCollection(name, cutoffMs, budget) {
  let deleted = 0;
  while (deleted < budget) {
    const snap = await db.collection(name)
      .where('timestamp', '<', cutoffMs)
      .orderBy('timestamp', 'asc')
      .limit(Math.min(450, budget - deleted))
      .get();
    if (snap.empty) break;
    if (DRY_RUN) { deleted += snap.size; if (snap.size < 450) break; continue; }
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    deleted += snap.size;
    if (snap.size < 450) break;
  }
  return deleted;
}

(async () => {
  const cutoffMs = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Purging analytics older than ${RETENTION_DAYS}d (before ${new Date(cutoffMs).toISOString()})`);
  let total = 0;
  for (const c of COLLECTIONS) {
    if (total >= MAX_DELETES) break;
    const n = await purgeCollection(c, cutoffMs, MAX_DELETES - total);
    console.log(`  ${c}: ${n} ${DRY_RUN ? 'would be removed' : 'removed'}`);
    total += n;
  }
  console.log(`Done. ${total} document(s) ${DRY_RUN ? 'matched' : 'deleted'}.`);
  process.exit(0);
})().catch((err) => {
  console.error('analytics-retention failed:', err);
  process.exit(1);
});
