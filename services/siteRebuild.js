/**
 * siteRebuild.js — rebuilds the storefront after catalogue changes, so the
 * pre-rendered product/category pages, sitemap and redirects stay current.
 *
 *   SITE_REBUILD_COMMAND    same-server deploys (VPS): a shell command to run,
 *                           e.g. "bash /var/www/alimenture/deploy/rebuild-frontend.sh"
 *   NETLIFY_BUILD_HOOK_URL  Netlify deploys: the site's build hook URL
 *
 * Calls are debounced so a burst of admin edits produces one build; a build
 * already running queues one follow-up. With neither variable set: a no-op.
 */
'use strict';

const { spawn } = require('child_process');
const log = require('../lib/logger');

const DEBOUNCE_MS = Number(process.env.SITE_REBUILD_DEBOUNCE_MS) || 3 * 60 * 1000;

let timer = null;
let reasons = new Set();

let running = false;
let rerun = false;

function runCommand(cmd, why) {
  running = true;
  const started = Date.now();
  const child = spawn(cmd, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, REBUILD_REASON: why } });
  let tail = '';
  const keep = (d) => { tail = (tail + d.toString()).slice(-4000); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.on('close', (code) => {
    running = false;
    if (code === 0) log.info('site_rebuild.done', { reasons: why, ms: Date.now() - started });
    else log.error('site_rebuild.failed', { reasons: why, code, err: new Error(tail) });
    if (rerun) { rerun = false; runCommand(cmd, 'queued changes'); }
  });
}

const fire = async () => {
  const cmd = process.env.SITE_REBUILD_COMMAND;
  const url = process.env.NETLIFY_BUILD_HOOK_URL;
  const why = [...reasons].join(', ');
  timer = null;
  reasons = new Set();
  if (cmd) {
    if (running) { rerun = true; return; }
    runCommand(cmd, why);
    return;
  }
  if (!url) return;
  try {
    const res = await fetch(`${url}?trigger_title=${encodeURIComponent(`catalogue: ${why}`.slice(0, 120))}`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    log.info('site_rebuild.triggered', { reasons: why });
  } catch (err) {
    log.error('site_rebuild.failed', { err });
  }
};

/** Schedule a (debounced) storefront rebuild. */
exports.requestSiteRebuild = (reason) => {
  if (!process.env.SITE_REBUILD_COMMAND && !process.env.NETLIFY_BUILD_HOOK_URL) return;
  reasons.add(reason);
  if (timer) clearTimeout(timer);
  timer = setTimeout(fire, DEBOUNCE_MS);
  timer.unref?.();
};
