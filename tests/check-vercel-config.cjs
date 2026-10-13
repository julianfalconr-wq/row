// Check — run as part of npm run check / the pre-push hook.
//
//   node tests/check-vercel-config.cjs
//
// BUG FIX (reported) — commit 9b3de4d added vercel.json's own
// buildCommand (to generate the build stamp) without an
// outputDirectory, which broke the live deploy: once a custom
// buildCommand is set, Vercel stops assuming the repo root is the
// static output (this project's own zero-config default, used
// because its site files live at the repo root, not in a framework's
// own build-output folder) and looks for a "public" directory
// instead, failing with "No Output Directory named 'public' found".
// This guards against that exact regression happening again — a
// buildCommand without an explicit outputDirectory is never valid for
// this project, regardless of what the buildCommand actually does.
const fs = require('fs');
const path = require('path');

const VERCEL_JSON_PATH = path.join(__dirname, '..', 'vercel.json');

let failures = 0;
function fail(msg) { failures++; console.log('FAIL:', msg); }
function ok(msg) { console.log('PASS:', msg); }

let raw;
try {
  raw = fs.readFileSync(VERCEL_JSON_PATH, 'utf8');
} catch (e) {
  fail('could not read vercel.json: ' + (e && e.message));
  console.log('\n' + failures + ' FAILURE(S)');
  process.exit(1);
}

let config;
try {
  config = JSON.parse(raw);
} catch (e) {
  fail('vercel.json is not valid JSON: ' + (e && e.message));
  console.log('\n' + failures + ' FAILURE(S)');
  process.exit(1);
}
ok('vercel.json is valid JSON');

if (config.buildCommand && !config.outputDirectory) {
  fail('vercel.json sets buildCommand ("' + config.buildCommand + '") without outputDirectory — this project\'s site files live at the repo root, not a framework\'s own build-output folder, so Vercel needs outputDirectory:"." set explicitly once any buildCommand exists (see this file\'s own header comment for the exact regression this caught).');
} else if (config.buildCommand) {
  ok('vercel.json sets buildCommand and a matching outputDirectory ("' + config.outputDirectory + '")');
} else {
  ok('vercel.json sets no buildCommand — outputDirectory is not required');
}

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS'));
process.exit(failures ? 1 : 0);
