// Smoke test — run this before every push touching the km-aware
// weekly-rhythm run/bike split (splitRhythmSessionsByShares /
// buildRhythmSessionsForDiscipline in api/training.js).
//
//   node tests/smoke-rhythm-split.cjs
//
// Extracts the REAL functions verbatim from api/training.js (source
// slice, not a reimplementation — a change to the real algorithm is
// what this test exercises) and asserts the exact scenarios from the
// feature report: week 1 (20km) = 3/5/5/7 with kinds interval/easy/
// pace/long; week 2 (22km) keeps the same shares and sums to exactly
// 22; deload week 4 (18km) keeps the long run longer than easy/pace
// with no session dropped; week 31 (5km) merges the shortest-share
// sessions down to one, reporting what was dropped; and — the
// backward-compatibility guarantee — no `km` set on any entry falls
// back to the original RHYTHM_KIND_WEIGHT heuristic, byte-for-byte.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'training.js'), 'utf8');

const startMarker = "const RHYTHM_WEEKDAY_ORDER = ['monday'";
const start = src.indexOf(startMarker);
if (start === -1) throw new Error('could not find RHYTHM_WEEKDAY_ORDER in api/training.js — test extraction markers are stale');
const endMarker = '\nfunction buildSessionsToPlace(';
const end = src.indexOf(endMarker, start);
if (end === -1) throw new Error('could not find buildSessionsToPlace in api/training.js — test extraction markers are stale');
const block = src.slice(start, end);

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
  block + '\nthis.splitRhythmSessionsByShares = splitRhythmSessionsByShares; this.buildRhythmSessionsForDiscipline = buildRhythmSessionsForDiscipline;',
  sandbox
);
const split = sandbox.splitRhythmSessionsByShares;
const buildRhythmSessionsForDiscipline = sandbox.buildRhythmSessionsForDiscipline;

// stripInventedKindMentions lives in a separate, non-contiguous part
// of the file (right after buildPlanSystemPrompt) — extracted on its
// own.
const stripStart = src.indexOf('const RATIONALE_KIND_PATTERNS');
if (stripStart === -1) throw new Error('could not find RATIONALE_KIND_PATTERNS in api/training.js — test extraction markers are stale');
const stripFnStart = src.indexOf('function stripInventedKindMentions', stripStart);
const stripFnBraceStart = src.indexOf('{', stripFnStart);
let stripDepth = 0, stripEnd = -1;
for (let j = stripFnBraceStart; j < src.length; j++) {
  if (src[j] === '{') stripDepth++;
  else if (src[j] === '}') { stripDepth--; if (stripDepth === 0) { stripEnd = j + 1; break; } }
}
const stripBlock = src.slice(stripStart, stripEnd);
const stripSandbox = {};
vm.createContext(stripSandbox);
vm.runInContext(stripBlock + '\nthis.stripInventedKindMentions = stripInventedKindMentions;', stripSandbox);
const stripInventedKindMentions = stripSandbox.stripInventedKindMentions;

let failures = 0;
function fail(msg) { failures++; console.log('FAIL:', msg); }
function ok(msg) { console.log('PASS:', msg); }
function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) fail(label + ' — got ' + a + ', expected ' + e);
  else ok(label);
}

// The user's own week-1 structure: Tue interval 3km, Wed easy 5km,
// Fri pace 5km, Sun long (no km — takes the remainder of 20).
const week1Entries = [
  { kind: 'interval', km: 3, dateKey: '2026-tue' },
  { kind: 'easy', km: 5, dateKey: '2026-wed' },
  { kind: 'pace', km: 5, dateKey: '2026-fri' },
  { kind: 'long', km: null, dateKey: '2026-sun' },
];

// Week 1: shares derived against itself as the reference week.
let r = split(week1Entries, 20, 20, 3);
assertEqual(r.sessions.map((s) => s.kind), ['interval', 'easy', 'pace', 'long'], 'week 1 keeps interval/easy/pace/long order');
assertEqual(r.sessions.map((s) => s.km), [3, 5, 5, 7], 'week 1 (20km, reference week) = exactly 3/5/5/7');
assertEqual(r.dropped, [], 'week 1 drops nothing');

// Week 2: 22km, same shares (15/25/25/35%) as derived from week 1 —
// must sum to exactly 22, every time, regardless of rounding drift.
r = split(week1Entries, 20, 22, 3);
const week2Sum = r.sessions.reduce((s, x) => s + x.km, 0);
if (Math.abs(week2Sum - 22) > 1e-9) fail('week 2 (22km) must sum to exactly 22, got ' + week2Sum);
else ok('week 2 (22km) sums to exactly 22');
assertEqual(r.dropped, [], 'week 2 drops nothing');

// Deload week 4: 18km, scaled down together — long must stay the
// longest session, never shorter than easy/pace, and nothing drops
// (18km >= 4 sessions x the 3km floor = 12km).
r = split(week1Entries, 20, 18, 3);
const byKind4 = {}; r.sessions.forEach((s) => { byKind4[s.kind] = s.km; });
if (!(byKind4.long > byKind4.easy && byKind4.long > byKind4.pace)) {
  fail('deload week 4 (18km) must keep long > easy and long > pace, got ' + JSON.stringify(byKind4));
} else ok('deload week 4 (18km) keeps the long run longer than easy/pace');
assertEqual(r.dropped, [], 'deload week 4 (18km) drops nothing (18 >= 4 x 3km floor)');
const week4Sum = r.sessions.reduce((s, x) => s + x.km, 0);
if (Math.abs(week4Sum - 18) > 1e-9) fail('deload week 4 must sum to exactly 18, got ' + week4Sum);
else ok('deload week 4 sums to exactly 18');

// Week 31 (taper): 5km — too small for 4 sessions at a 3km floor
// (5 < 4x3=12); must progressively merge the smallest-share sessions
// down to one and REPORT what was merged, never print tiny sessions.
r = split(week1Entries, 20, 5, 3);
if (r.sessions.some((s) => s.km > 0 && s.km < 1)) fail('week 31 (5km) must not print a near-zero session, got ' + JSON.stringify(r.sessions));
else ok('week 31 (5km) prints no near-zero sessions');
if (!r.dropped.length) fail('week 31 (5km) must report dropped/merged kinds, got none');
else ok('week 31 (5km) reports merged kinds: ' + r.dropped.join(', '));
const week31Sum = r.sessions.reduce((s, x) => s + x.km, 0);
if (Math.abs(week31Sum - 5) > 1e-9) fail('week 31 must sum to exactly 5, got ' + week31Sum);
else ok('week 31 sums to exactly 5');

// Backward compatibility: no entry sets `km` at all => the km-aware
// split never triggers (hasExplicitKm is false) => output must be
// byte-for-byte the old RHYTHM_KIND_WEIGHT heuristic.
const weekDates = { monday: null, tuesday: '2026-10-13', wednesday: '2026-10-14', thursday: null, friday: '2026-10-16', saturday: null, sunday: '2026-10-18' };
const rhythmNoKm = {
  monday: [], tuesday: [{ discipline: 'run', kind: 'interval' }], wednesday: [{ discipline: 'run', kind: 'easy' }],
  thursday: [], friday: [{ discipline: 'run', kind: 'pace' }], saturday: [], sunday: [{ discipline: 'run', kind: 'long' }],
};
const targets = { run: { km: 20, activityTypeId: 'run1', activityName: 'Running' } };
const sessionsNoKm = buildRhythmSessionsForDiscipline('run', targets, {}, rhythmNoKm, weekDates, [], undefined);
// Weight-based: long=1.5, pace=0.85, interval=0.8, easy=1.0 -> sum 4.15
const weightSum = 1.5 + 0.85 + 0.8 + 1.0;
const expectedKm = {
  interval: Math.max(0, Math.round((20 * (0.8 / weightSum)) * 10) / 10),
  easy: Math.max(0, Math.round((20 * (1.0 / weightSum)) * 10) / 10),
  pace: Math.max(0, Math.round((20 * (0.85 / weightSum)) * 10) / 10),
  long: Math.max(0, Math.round((20 * (1.5 / weightSum)) * 10) / 10),
};
let backCompatOk = true;
sessionsNoKm.forEach((s) => { if (Math.abs(s.targetAmount - expectedKm[s.kind]) > 1e-9) backCompatOk = false; });
if (!backCompatOk) fail('no km set anywhere must fall back to the original RHYTHM_KIND_WEIGHT split unchanged, got ' + JSON.stringify(sessionsNoKm));
else ok('no km set anywhere falls back to the original RHYTHM_KIND_WEIGHT split, unchanged');

// Hard-day flags: interval/pace/long are hard; easy is not — must
// hold for km-aware sessions exactly like the weight-based fallback.
const rhythmWithKm = {
  monday: [], tuesday: [{ discipline: 'run', kind: 'interval', km: 3 }], wednesday: [{ discipline: 'run', kind: 'easy', km: 5 }],
  thursday: [], friday: [{ discipline: 'run', kind: 'pace', km: 5 }], saturday: [], sunday: [{ discipline: 'run', kind: 'long' }],
};
const firstWeekTargets = { run: { km: 20 } };
const sessionsWithKm = buildRhythmSessionsForDiscipline('run', targets, {}, rhythmWithKm, weekDates, [], firstWeekTargets);
const hardByKind = {}; sessionsWithKm.forEach((s) => { hardByKind[s.kind] = s.hard; });
assertEqual(hardByKind, { interval: true, easy: false, pace: true, long: true }, 'hard-day flags unaffected by the km-aware split (interval/pace/long hard, easy not)');
assertEqual(sessionsWithKm.map((s) => s.targetAmount), [3, 5, 5, 7], 'km-aware split wired through buildRhythmSessionsForDiscipline end-to-end = 3/5/5/7');

// Rationale-invention fix (point 4 of the feature report): a
// rationale sentence naming a kind absent from the real week (e.g.
// "one interval session for VO2 max" when the rhythm has none) must
// be stripped; sentences about kinds that ARE real must survive
// untouched; and with no real layout at all (realSessionKinds=null)
// the rationale must be completely unchanged.
const inventedRationale = "This week builds aerobic base with an easy run and a long session on Sunday. We'll also add one interval session for VO2 max to sharpen speed. Strength stays at 3 sessions.";
const stripped = stripInventedKindMentions(inventedRationale, ['easy', 'long', 'auto']);
if (/interval|VO2/i.test(stripped)) fail('rationale must not mention interval/VO2max when absent from the real week, got: ' + stripped);
else ok('rationale strips the invented interval/VO2max sentence');
if (!stripped.includes('long session on Sunday')) fail('rationale must keep real sentences untouched, got: ' + stripped);
else ok('rationale keeps real sentences (easy/long) untouched');
const untouchedNoLayout = stripInventedKindMentions(inventedRationale, null);
assertEqual(untouchedNoLayout, inventedRationale, 'no real layout at all (null realSessionKinds) leaves the rationale completely unchanged');

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS'));
process.exit(failures ? 1 : 0);
