// Smoke test — run this before every push touching score-lib.js's
// Training/cardio scoring (computeCardioCategory / combineTrainingFraction).
//
//   node tests/smoke-score-cardio-expected.cjs
//
// Reproduces the EXACT reported bug: Mon 2026-10-26, rhythm Monday =
// Strength (Push) only, weekly run target 24km, first run Tuesday.
// Push done, 0 km logged. The OLD "expected" was a blind calendar-day
// proration (kmTarget * (dayIdx+1)/7 = 24/7 ≈ 3.43), so Cardio scored
// 0/1 even though nothing was actually due yet — Training 12.5/25
// instead of 25/25. expectedCardioKmFromLayout (score-lib.js) now
// sums plan.layout's own already-scheduled run/bike sessions through
// today instead, so a day with nothing scheduled correctly expects 0
// km (triggering the EXISTING expected>0?...:1 fallback for full
// credit) — never a 1/7 share of the week's total.
const fs = require('fs');
const vm = require('vm');

const ROW_DIR = '/Users/julian.fr/row';
let failures = 0;
function fail(msg) { failures++; console.log('FAIL:', msg); }
function ok(msg) { console.log('PASS:', msg); }

function buildSandbox() {
  const sandbox = { window: {}, console, JSON, Object, Array, Number, Math, Set, String };
  sandbox.localStorage = (() => {
    const store = {};
    return {
      getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem(k, v) { store[k] = String(v); },
      removeItem(k) { delete store[k]; },
    };
  })();
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(ROW_DIR + '/daylib.js', 'utf8'), sandbox);
  sandbox.DayLib = sandbox.window.DayLib;
  vm.runInContext(fs.readFileSync(ROW_DIR + '/score-lib.js', 'utf8'), sandbox);
  return sandbox;
}
function seed(sandbox, { splitRotation, splitAnchor, doneDays, activities, plan }) {
  sandbox.localStorage.setItem('po_coach_v1', JSON.stringify({ splitRotation, splitAnchor }));
  sandbox.localStorage.setItem('po_coach_workout_done', JSON.stringify(doneDays || {}));
  sandbox.localStorage.setItem('po_coach_activities', JSON.stringify(activities || []));
  if (plan !== undefined) sandbox.localStorage.setItem('po_coach_weekly_plan_v1', JSON.stringify(plan));
  else sandbox.localStorage.removeItem('po_coach_weekly_plan_v1');
}

// Monday 2026-10-26 .. Sunday 2026-11-01. splitRotation anchored so
// Monday='Push', Tuesday='Rest' (irrelevant to cardio, only used by
// the strength-half tests below).
const SPLIT = { splitRotation: ['Push', 'Rest', 'Pull', 'Rest', 'Legs', 'Rest', 'Rest'], splitAnchor: { date: '2026-10-26', index: 0 } };
const MON = '2026-10-26', TUE = '2026-10-27', WED = '2026-10-28';
const WEEK_PLAN_CARDIO = { longSession: { activityTypeId: 'run1', targetAmount: 15 }, easyVolume: { activityTypeId: 'run1', targetAmount: 9 } }; // 24km total
function planWithLayout(layoutDays) {
  return { weekStart: MON, plan: { cardio: WEEK_PLAN_CARDIO, layout: layoutDays } };
}

// --- Case 1 (THE LIVE CASE) — Monday, layout has Push only (no run/
// bike that day) -> expected = 0 -> full cardio credit -> Training
// 25/25 (this user's own configured training weight). ---
{
  const sandbox = buildSandbox();
  seed(sandbox, {
    ...SPLIT,
    doneDays: { [MON]: true },
    activities: [],
    plan: planWithLayout([
      { dateKey: MON, sessions: [{ discipline: 'strength', kind: 'push' }] },
      { dateKey: TUE, sessions: [{ discipline: 'run', kind: 'interval', activityTypeId: 'run1', targetAmount: 3, unit: 'km' }] },
    ]),
  });
  const S = sandbox.window.ScoreLib;
  const strength = S.computeStrengthCategory(MON);
  const cardio = S.computeCardioCategory(MON, MON);
  const training = S.combineTrainingFraction(strength, cardio, null);
  if (!strength.available || strength.fraction !== 1) fail('Case 1: strength must be available and done, got ' + JSON.stringify(strength));
  else ok('Case 1: strength half — Push done (fraction 1)');
  if (!cardio.available || cardio.fraction !== 1) fail('THE EXACT ASSERTION REQUESTED: Case 1 (live case) — Monday with nothing scheduled must score full cardio credit, got ' + JSON.stringify(cardio));
  else ok('Case 1: cardio half — nothing scheduled on Monday, expected=0 -> full credit (fraction 1)');
  const pts = Math.round(training.fraction * 25 * 10) / 10;
  if (pts !== 25) fail('THE EXACT ASSERTION REQUESTED: Case 1 — Training must be 25/25, got ' + pts + '/25');
  else ok('Case 1 (THE LIVE CASE): Training ' + pts + '/25 — "' + (strength.label + ': ' + strength.detail + ' · ' + cardio.label + ': ' + cardio.detail) + '"');
}

// --- Case 2 — Tuesday, layout has Interval 3km scheduled: 0 km done
// -> cardio half 0 (expected=3, kmDone=0). ---
{
  const sandbox = buildSandbox();
  seed(sandbox, {
    ...SPLIT,
    activities: [],
    plan: planWithLayout([
      { dateKey: MON, sessions: [{ discipline: 'strength', kind: 'push' }] },
      { dateKey: TUE, sessions: [{ discipline: 'run', kind: 'interval', activityTypeId: 'run1', targetAmount: 3, unit: 'km' }] },
    ]),
  });
  const cardio = sandbox.window.ScoreLib.computeCardioCategory(TUE, MON);
  if (!cardio.available || cardio.fraction !== 0) fail('THE EXACT ASSERTION REQUESTED: Case 2 — Tuesday, 3km scheduled, 0 done -> cardio fraction must be 0, got ' + JSON.stringify(cardio));
  else ok('Case 2: Tuesday, interval 3km scheduled, 0km done -> cardio fraction 0 (' + cardio.detail + ')');
}

// --- Case 3 — Wednesday, layout has Tue Interval 3km + Wed Easy 5km
// (expected=8, summed across days). Activities logged on Tuesday
// (NOT Wednesday itself, so the "logged today" short-circuit never
// fires) -- exercises the real multi-day SUM. done 8 -> full; done 4
// -> 0.5. ---
{
  const layout = [
    { dateKey: MON, sessions: [{ discipline: 'strength', kind: 'push' }] },
    { dateKey: TUE, sessions: [{ discipline: 'run', kind: 'interval', activityTypeId: 'run1', targetAmount: 3, unit: 'km' }] },
    { dateKey: WED, sessions: [{ discipline: 'run', kind: 'easy', activityTypeId: 'run1', targetAmount: 5, unit: 'km' }] },
  ];
  {
    const sandbox = buildSandbox();
    seed(sandbox, { ...SPLIT, activities: [{ dateKey: TUE, activityTypeId: 'run1', distanceKm: 8 }], plan: planWithLayout(layout) });
    const cardio = sandbox.window.ScoreLib.computeCardioCategory(WED, MON);
    if (!cardio.available || cardio.fraction !== 1) fail('THE EXACT ASSERTION REQUESTED: Case 3a — Wed, 3+5=8km scheduled, 8km done -> full credit, got ' + JSON.stringify(cardio));
    else ok('Case 3a: Wednesday, 8km scheduled (Tue 3 + Wed 5), 8km done -> full credit (' + cardio.detail + ')');
  }
  {
    const sandbox = buildSandbox();
    seed(sandbox, { ...SPLIT, activities: [{ dateKey: TUE, activityTypeId: 'run1', distanceKm: 4 }], plan: planWithLayout(layout) });
    const cardio = sandbox.window.ScoreLib.computeCardioCategory(WED, MON);
    if (!cardio.available || cardio.fraction !== 0.5) fail('THE EXACT ASSERTION REQUESTED: Case 3b — Wed, 8km scheduled, 4km done -> fraction 0.5, got ' + JSON.stringify(cardio));
    else ok('Case 3b: Wednesday, 8km scheduled, 4km done -> fraction 0.5 (' + cardio.detail + ')');
  }
}

// --- Case 4 — kmDone above expected -> capped at 1, never > 1. ---
{
  const sandbox = buildSandbox();
  seed(sandbox, {
    ...SPLIT,
    activities: [{ dateKey: TUE, activityTypeId: 'run1', distanceKm: 20 }],
    plan: planWithLayout([{ dateKey: MON, sessions: [] }, { dateKey: TUE, sessions: [{ discipline: 'run', kind: 'interval', activityTypeId: 'run1', targetAmount: 3, unit: 'km' }] }]),
  });
  const cardio = sandbox.window.ScoreLib.computeCardioCategory(TUE, MON);
  if (!cardio.available || cardio.fraction !== 1) fail('THE EXACT ASSERTION REQUESTED: Case 4 — 20km done vs 3km expected must cap at fraction 1, got ' + JSON.stringify(cardio));
  else ok('Case 4: 20km done vs 3km expected -> capped at fraction 1, never exceeds it');
}

// --- Case 5 (REGRESSION) — no plan.layout for the week -> old blind
// 1/7-per-day proration, unchanged. Same numbers as the live case's
// OWN pre-fix behavior (Monday, 24km target, 0 done -> 24/7≈3.43 -> 0). ---
{
  const sandbox = buildSandbox();
  seed(sandbox, { ...SPLIT, activities: [], plan: { weekStart: MON, plan: { cardio: WEEK_PLAN_CARDIO } } }); // no `layout` key at all
  const cardio = sandbox.window.ScoreLib.computeCardioCategory(MON, MON);
  if (!cardio.available || cardio.fraction !== 0) fail('THE EXACT ASSERTION REQUESTED: Case 5 (regression) — no plan.layout must fall back to the OLD blind proration, got ' + JSON.stringify(cardio));
  else ok('Case 5 (regression): no plan.layout for the week -> old blind 1/7-per-day proration still applies (fraction 0, ' + cardio.detail + ')');
}

// --- Case 6 — rest day / no strength scheduled: strength half stays
// unavailable, unaffected by this fix. ---
{
  const sandbox = buildSandbox();
  seed(sandbox, { ...SPLIT, doneDays: {}, activities: [], plan: planWithLayout([{ dateKey: TUE, sessions: [{ discipline: 'run', kind: 'interval', activityTypeId: 'run1', targetAmount: 3, unit: 'km' }] }]) });
  const strength = sandbox.window.ScoreLib.computeStrengthCategory(TUE); // Tuesday = 'Rest' in SPLIT rotation
  if (strength.available) fail('Case 6: a rest day must leave strength unavailable, got ' + JSON.stringify(strength));
  else ok('Case 6: rest day -> strength half unavailable (unchanged by this fix)');
}

// --- Case 7 (REGRESSION) — a date in a DIFFERENT week -> cardio
// unavailable, exactly as before (the weekStart gate runs BEFORE any
// of this fix's own code). ---
{
  const sandbox = buildSandbox();
  seed(sandbox, { ...SPLIT, activities: [], plan: planWithLayout([{ dateKey: MON, sessions: [] }]) });
  const cardio = sandbox.window.ScoreLib.computeCardioCategory('2026-11-02', '2026-11-02'); // a Monday the NEXT week
  if (cardio.available) fail('Case 7 (regression): a different week\'s date must stay unavailable, got ' + JSON.stringify(cardio));
  else ok('Case 7 (regression): a date in a different week -> cardio unavailable, unchanged');
}

// --- Case 8 — swim sessions in the layout are NOT added to the km
// expected (swim's own unit is meters, never mixed into run/bike km). ---
{
  const sandbox = buildSandbox();
  seed(sandbox, {
    ...SPLIT,
    activities: [],
    plan: planWithLayout([
      { dateKey: MON, sessions: [{ discipline: 'swim', kind: 'pace', activityTypeId: 'swim1', targetAmount: 1300, unit: 'm' }] },
    ]),
  });
  const cardio = sandbox.window.ScoreLib.computeCardioCategory(MON, MON);
  // expected must be 0 (the swim session is excluded) -> full credit, same as "nothing scheduled" — NOT 1300 bleeding into a km figure.
  if (!cardio.available || cardio.fraction !== 1 || !/0 \/ 0 km so far/.test(cardio.detail)) {
    fail('THE EXACT ASSERTION REQUESTED: Case 8 — a swim session must never be added to the cardio km expected, got ' + JSON.stringify(cardio));
  } else {
    ok('Case 8: a swim-only day (1300m) correctly expects 0 run/bike km, never mixes swim meters into km (' + cardio.detail + ')');
  }
}

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS'));
process.exit(failures ? 1 : 0);
