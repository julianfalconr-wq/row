// Smoke test — run this before every push touching the weekly-rhythm
// run/bike split (splitRhythmSessionsFixedGrowth / resolveLongRunCapForWeek /
// buildRhythmSessionsForDiscipline in api/training.js).
//
//   node tests/smoke-rhythm-split.cjs
//
// Extracts the REAL functions verbatim from api/training.js (source
// slice, not a reimplementation — a change to the real algorithm is
// what this test exercises) and asserts the exact scenarios from both
// feature reports: fixed (interval/pace never grow) vs growth (long
// first up to its cap, then easy, easy always >=1km below long);
// deload/taper scaling all sessions proportionally with merge/drop
// when too small; date-ranged long-run cap overrides; the rationale-
// invention strip; and the backward-compatibility guarantee (no `km`
// set on any entry falls back to the original RHYTHM_KIND_WEIGHT
// heuristic, byte-for-byte).
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
  block + '\nthis.splitRhythmSessionsFixedGrowth = splitRhythmSessionsFixedGrowth; this.resolveLongRunCapForWeek = resolveLongRunCapForWeek; this.buildRhythmSessionsForDiscipline = buildRhythmSessionsForDiscipline;',
  sandbox
);
const split = sandbox.splitRhythmSessionsFixedGrowth;
const resolveCap = sandbox.resolveLongRunCapForWeek;
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
function sizesOf(r) { return r.sessions.map((s) => s.km); }

// The user's own reference-week structure: Tue interval 3km (FIXED),
// Wed easy 5km, Fri pace 5km (FIXED), Sun long (no km — absorbs the
// rest: 20-3-5-5=7).
const refEntries = [
  { kind: 'interval', km: 3, dateKey: 'tue' },
  { kind: 'easy', km: 5, dateKey: 'wed' },
  { kind: 'pace', km: 5, dateKey: 'fri' },
  { kind: 'long', km: null, dateKey: 'sun' },
];

let r = split(refEntries, 20, 20, 10, 3);
assertEqual(r.sessions.map((s) => s.kind), ['interval', 'easy', 'pace', 'long'], 'reference week keeps interval/easy/pace/long order');
assertEqual(sizesOf(r), [3, 5, 5, 7], 'week 1 (20km, reference week, cap 10) = exactly 3/5/5/7');
assertEqual(r.shortfall, 0, 'week 1 has no shortfall');

r = split(refEntries, 20, 22, 10, 3);
assertEqual(sizesOf(r), [3, 5, 5, 9], 'week 2 (22km): interval/pace FIXED, growth goes to long only -> 3/5/5/9');

r = split(refEntries, 20, 24, 10, 3);
assertEqual(sizesOf(r), [3, 6, 5, 10], 'week 3 (24km): long hits its cap(10), surplus overflows to easy -> 3/6/5/10');

r = split(refEntries, 20, 26, 10, 3);
assertEqual(sizesOf(r), [3, 8, 5, 10], 'week 11 (26km): long capped at 10, easy absorbs the rest -> 3/8/5/10');

r = split(refEntries, 20, 28, 10, 3);
assertEqual(sizesOf(r), [3, 9, 5, 10], 'week 19 (28km, cap 10): easy stops 1km below long(10) -> 3/9/5/10');
assertEqual(r.shortfall, 1, 'week 19 (28km, cap 10) reports a 1km shortfall (27 placed of 28)');

r = split(refEntries, 20, 21, 10, 3);
assertEqual(sizesOf(r), [3, 5, 5, 8], 'week 20 (21km): a small target between 20 and long\'s cap only grows long -> 3/5/5/8');

// Deload (week 4, 18km < reference 20km): ALL sessions scale down
// together proportionally, long always the longest, nothing dropped
// (18km >= 4 sessions x the 3km floor = 12km).
r = split(refEntries, 20, 18, 10, 3);
assertEqual(sizesOf(r), [2.5, 4.5, 4.5, 6.5], 'deload week 4 (18km) scales every session proportionally -> 2.5/4.5/4.5/6.5');
assertEqual(r.dropped, [], 'deload week 4 (18km) drops nothing');
const week4Sum = r.sessions.reduce((s, x) => s + x.km, 0);
if (Math.abs(week4Sum - 18) > 1e-9) fail('deload week 4 must sum to exactly 18, got ' + week4Sum);
else ok('deload week 4 sums to exactly 18');

// Week 30 (12km): exactly at the 4x3km floor -- too small to keep all
// four sessions at a sane size, must merge/drop and report it.
r = split(refEntries, 20, 12, 10, 3);
if (!r.dropped.length) fail('week 30 (12km, exactly at the floor) must report a merge, got none');
else ok('week 30 (12km) merges/drops: ' + r.dropped.join(', '));
const week30Sum = r.sessions.reduce((s, x) => s + x.km, 0);
if (Math.abs(week30Sum - 12) > 1e-9) fail('week 30 must sum to exactly 12, got ' + week30Sum);
else ok('week 30 sums to exactly 12');

// Week 31 (5km): too small for four sessions -- cascades down to one.
r = split(refEntries, 20, 5, 10, 3);
if (r.sessions.some((s) => s.km > 0 && s.km < 1)) fail('week 31 (5km) must not print a near-zero session, got ' + JSON.stringify(r.sessions));
else ok('week 31 (5km) prints no near-zero sessions');
if (!r.dropped.length) fail('week 31 (5km) must report dropped/merged kinds, got none');
else ok('week 31 (5km) reports merged kinds: ' + r.dropped.join(', '));
const week31Sum = r.sessions.reduce((s, x) => s + x.km, 0);
if (Math.abs(week31Sum - 5) > 1e-9) fail('week 31 must sum to exactly 5, got ' + week31Sum);
else ok('week 31 sums to exactly 5');

// ---- date-ranged long-run cap overrides ----
const rhythmWithOverride = { longRunCapKm: 10, longRunCapOverrides: [{ from: '2027-02-15', to: '2027-03-21', km: 12 }] };
assertEqual(resolveCap(rhythmWithOverride, '2027-02-15'), 12, 'cap override: week 19\'s own Monday (2027-02-15, range start) resolves to 12');
assertEqual(resolveCap(rhythmWithOverride, '2027-03-21'), 12, 'cap override: week 23\'s own Monday (2027-03-21, range end) resolves to 12');
assertEqual(resolveCap(rhythmWithOverride, '2027-03-22'), 10, 'cap override: the week right after the range (2027-03-22) falls back to the default 10');
assertEqual(resolveCap(rhythmWithOverride, '2027-02-08'), 10, 'cap override: the week right before the range (2027-02-08) stays at the default 10');
assertEqual(resolveCap({}, '2027-02-15'), 10, 'no longRunCapKm/overrides at all -> the built-in default (10)');

r = split(refEntries, 20, 28, resolveCap(rhythmWithOverride, '2027-02-15'), 3);
assertEqual(sizesOf(r), [3, 8, 5, 12], 'week 19 (28km) under the cap-12 override -> 3/8/5/12, no shortfall');
assertEqual(r.shortfall, 0, 'week 19 under the cap-12 override has no shortfall');

r = split(refEntries, 20, 26, 12, 3);
assertEqual(sizesOf(r), [3, 6, 5, 12], 'week 21 (26km) under cap 12 -> 3/6/5/12');

r = split(refEntries, 20, 21, 12, 3);
assertEqual(sizesOf(r), [3, 5, 5, 8], 'week 20 (21km) under cap 12 — growth too small to reach either cap -> unchanged from cap 10');

// Backward compatibility: no entry sets `km` at all => the km-aware
// split never triggers (hasExplicitKm is false) => output must be
// byte-for-byte the old RHYTHM_KIND_WEIGHT heuristic.
const weekDates = { monday: '2026-10-12', tuesday: '2026-10-13', wednesday: '2026-10-14', thursday: null, friday: '2026-10-16', saturday: null, sunday: '2026-10-18' };
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
// hold for the fixed/growth split exactly like the weight-based
// fallback, and must be unaffected by a cap override.
const rhythmWithKm = {
  monday: [], tuesday: [{ discipline: 'run', kind: 'interval', km: 3 }], wednesday: [{ discipline: 'run', kind: 'easy', km: 5 }],
  thursday: [], friday: [{ discipline: 'run', kind: 'pace', km: 5 }], saturday: [], sunday: [{ discipline: 'run', kind: 'long' }],
  longRunCapKm: 10, longRunCapOverrides: [{ from: '2027-02-15', to: '2027-03-21', km: 12 }],
};
const firstWeekTargets = { run: { km: 20 } };
const sessionsWithKm = buildRhythmSessionsForDiscipline('run', targets, {}, rhythmWithKm, weekDates, [], firstWeekTargets);
const hardByKind = {}; sessionsWithKm.forEach((s) => { hardByKind[s.kind] = s.hard; });
assertEqual(hardByKind, { interval: true, easy: false, pace: true, long: true }, 'hard-day flags unaffected by the fixed/growth split (interval/pace/long hard, easy not)');
assertEqual(sessionsWithKm.map((s) => s.targetAmount), [3, 5, 5, 7], 'fixed/growth split wired through buildRhythmSessionsForDiscipline end-to-end (week 1, weekDates.monday outside the override) = 3/5/5/7');

const overrideWeekDates = Object.assign({}, weekDates, { monday: '2027-02-15' });
const targets28 = { run: { km: 28, activityTypeId: 'run1', activityName: 'Running' } };
const sessionsOverrideWeek = buildRhythmSessionsForDiscipline('run', targets28, {}, rhythmWithKm, overrideWeekDates, [], firstWeekTargets);
assertEqual(sessionsOverrideWeek.map((s) => s.targetAmount), [3, 8, 5, 12], 'a week whose own Monday falls inside longRunCapOverrides resolves the overridden cap end-to-end (28km -> 3/8/5/12)');

// Rationale-invention fix (unrelated to this change, still covered
// here since it lives in the same file): a rationale sentence naming
// a kind absent from the real week must be stripped; sentences about
// real kinds survive; no real layout at all leaves it untouched.
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
