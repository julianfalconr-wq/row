#!/usr/bin/env node
// Build stamp (reported feature) — run by Vercel's build step (see
// vercel.json's buildCommand and package.json's "build" script) to
// overwrite build-stamp.js with the real deploy's short commit hash
// and build time, read from Vercel's own System Environment Variables
// (VERCEL_GIT_COMMIT_SHA — automatically available during the build,
// no secret/config needed). Running this locally (those variables
// absent) writes the same "dev" placeholder the file is committed
// with, so a local `npm run build` is harmless and idempotent.
//
// Deliberately never fails the build: any error here falls back to
// writing "dev" rather than risking the whole deployment over a
// cosmetic footer line.
const fs = require('fs');
const path = require('path');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function pad2(n) { return String(n).padStart(2, '0'); }

function computeStamp() {
  try {
    const sha = process.env.VERCEL_GIT_COMMIT_SHA;
    if (!sha) return 'dev';
    const short = sha.slice(0, 7);
    const now = new Date();
    return short + ', ' + pad2(now.getUTCDate()) + ' ' + MONTHS[now.getUTCMonth()] + ' ' + pad2(now.getUTCHours()) + ':' + pad2(now.getUTCMinutes()) + ' UTC';
  } catch (e) {
    return 'dev';
  }
}

try {
  const stamp = computeStamp();
  const outPath = path.join(__dirname, '..', 'build-stamp.js');
  const contents = "window.BUILD_STAMP = " + JSON.stringify(stamp) + ";\n";
  fs.writeFileSync(outPath, contents);
  console.log('[build-stamp] wrote build-stamp.js:', stamp);
} catch (e) {
  console.error('[build-stamp] failed, leaving the existing build-stamp.js untouched:', e && e.message);
}
process.exit(0);
