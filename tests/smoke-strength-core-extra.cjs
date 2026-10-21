// Smoke test — run this before every push touching strength rebalance
// priority (classifyWeeklyStrengthRhythm / missedDayTypesThisWeek /
// buildRebalanceLayout's STRENGTH block / todayStrengthDisplacement in
// gym.html's rebalanceRestOfWeek).
//
//   node tests/smoke-strength-core-extra.cjs
//
// CORE (push/pull/legs, or whatever isn't Explosive) vs OPTIONAL EXTRA
// (Explosive, or any core-kind day beyond the week's own strength
// target): the extra is never counted as missed if skipped, and a
// displaced core session (today's own rhythm entry, bumped by a
// missed-catch-up pick elsewhere) always gets a new slot this week —
// first the extra's own day (dropping it, never missed), otherwise
// the next genuinely free day, otherwise it's named in cantFit, never
// silently dropped.
//
// Part 1: classifyWeeklyStrengthRhythm + missedDayTypesThisWeek,
// extracted verbatim from gym.html — an Explosive day never appears
// in the missed list even when unlogged.
// Part 2: buildRebalanceLayout, extracted verbatim, against the
// task's own four cases (A/B/C/D).
// Part 3: the real gym.html page, Case A end-to-end — a text dump of
// "Today's session" (todayPick) and "Rest of week" (rb) via the
// actual tpRebalanceBtn click flow.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROW_DIR = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROW_DIR, 'gym.html'), 'utf8');
let failures = 0;
function fail(msg) { failures++; console.log('FAIL:', msg); }
function ok(msg) { console.log('PASS:', msg); }

function extractConst(name) {
  const start = src.indexOf('const ' + name);
  if (start === -1) throw new Error('could not find const ' + name + ' — test extraction markers are stale');
  let i = src.indexOf('=', start) + 1;
  while (/\s/.test(src[i])) i++;
  if (src[i] === '{' || src[i] === '[') {
    const open = src[i], close = open === '{' ? '}' : ']';
    let depth = 0, end = -1;
    for (let j = i; j < src.length; j++) {
      if (src[j] === open) depth++;
      else if (src[j] === close) { depth--; if (depth === 0) { end = j + 1; break; } }
    }
    return src.slice(start, end) + ';';
  }
  return src.slice(start, src.indexOf(';', start) + 1);
}
function extractFn(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('could not find function ' + name + ' — test extraction markers are stale');
  const braceStart = src.indexOf('{', start);
  let depth = 0, end = -1;
  for (let j = braceStart; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  return src.slice(start, end);
}

const DAYS = [{ id: 'd1', name: 'Push' }, { id: 'd2', name: 'Pull' }, { id: 'd3', name: 'Legs' }, { id: 'd4', name: 'Explosive' }];

function buildSandbox() {
  const sandbox = {
    activityEntries: [],
    disciplineForActivityType: () => null,
    thisWeekMondayKey: () => '2026-10-12',
    window: { PoCoach: { getDoneDays: () => ({}), getSplitForDate: () => ({ name: null }) } },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROW_DIR, 'daylib.js'), 'utf8'), sandbox);
  sandbox.DayLib = sandbox.window.DayLib;
  return sandbox;
}

// ---------------------------------------------------------------
// Part 1 — classifyWeeklyStrengthRhythm + missedDayTypesThisWeek.
// ---------------------------------------------------------------
function runPart1() {
  const sandbox = buildSandbox();
  sandbox.resolveTodayBedtimeMs = () => Date.now() - 1000000; // today's window has closed, for determinism
  const block = [
    extractConst('RHYTHM_WEEKDAY_NAMES_LOWER'),
    extractConst('WEEKDAY_LABELS_FULL'),
    extractConst('WEEK_DATES_WEEKDAY_ORDER'),
    extractFn('dateKey'),
    extractFn('resolveRhythmStrengthDayType'),
    extractFn('classifyWeeklyStrengthRhythm'),
    extractFn('missedDayTypesThisWeek'),
  ].join('\n');
  vm.runInContext(block + '\nthis.classifyWeeklyStrengthRhythm = classifyWeeklyStrengthRhythm;\nthis.missedDayTypesThisWeek = missedDayTypesThisWeek;', sandbox);
  const { classifyWeeklyStrengthRhythm, missedDayTypesThisWeek } = sandbox;

  const RHYTHM = {
    monday: [{ discipline: 'strength', kind: 'push' }],
    wednesday: [{ discipline: 'strength', kind: 'pull' }],
    thursday: [{ discipline: 'strength', kind: 'explosive' }],
    saturday: [{ discipline: 'strength', kind: 'legs' }],
  };

  let cls = classifyWeeklyStrengthRhythm(RHYTHM, DAYS, 3);
  const explosiveEntry = cls.find((e) => e.dayType === 'Explosive');
  if (!explosiveEntry || !explosiveEntry.isExtra) fail('classifyWeeklyStrengthRhythm: Explosive must classify as isExtra:true, got ' + JSON.stringify(cls));
  else ok('classifyWeeklyStrengthRhythm: Explosive classifies as the optional extra');
  if (cls.filter((e) => !e.isExtra).length !== 3) fail('classifyWeeklyStrengthRhythm: expected exactly 3 core entries (Push/Pull/Legs), got ' + JSON.stringify(cls));
  else ok('classifyWeeklyStrengthRhythm: Push/Pull/Legs classify as core (target 3, no overflow)');

  // Overflow: target 2 -> only 2 core slots; the 3rd core-kind entry
  // (latest weekday, Legs@Saturday) also becomes an optional extra.
  cls = classifyWeeklyStrengthRhythm(RHYTHM, DAYS, 2);
  const legsEntry = cls.find((e) => e.dayType === 'Legs');
  if (!legsEntry || !legsEntry.isExtra) fail('classifyWeeklyStrengthRhythm: with target 2, the 3rd core day (Legs) must overflow to isExtra:true, got ' + JSON.stringify(cls));
  else ok('classifyWeeklyStrengthRhythm: a core day beyond the week\'s own target also becomes optional extra');

  // Wednesday today — Monday's Push is missed; Explosive (Thursday,
  // future) is never checked at all (missedDayTypesThisWeek only
  // looks at days strictly before today) — this just confirms the
  // existing scope boundary still holds with the new param present.
  let missed = missedDayTypesThisWeek({ days: DAYS, exercises: [], routines: [], logs: {} }, '2026-10-12', '2026-10-14', RHYTHM, 3);
  if (missed.length !== 1 || missed[0].dayType !== 'Push' || missed[0].weekday !== 'Monday') {
    fail('missedDayTypesThisWeek: expected exactly [Push missed Monday], got ' + JSON.stringify(missed));
  } else ok('missedDayTypesThisWeek: Monday\'s Push is missed (Wednesday today)');

  // THE EXACT ASSERTION REQUESTED (point 5 / point 1) — checking on a
  // day AFTER Explosive's own day (Friday), an unlogged Thursday
  // Explosive must NEVER appear in missed — it's optional, dropped
  // without counting as missed if skipped.
  missed = missedDayTypesThisWeek({ days: DAYS, exercises: [], routines: [], logs: {} }, '2026-10-12', '2026-10-16', RHYTHM, 3);
  if (missed.some((m) => m.dayType === 'Explosive')) {
    fail('THE EXACT ASSERTION REQUESTED: an unlogged optional-extra (Explosive) must never appear in missed, got ' + JSON.stringify(missed));
  } else {
    ok('missedDayTypesThisWeek: an unlogged Explosive (optional extra) never counts as missed');
  }
  if (!missed.some((m) => m.dayType === 'Push') || !missed.some((m) => m.dayType === 'Pull')) {
    fail('missedDayTypesThisWeek: Monday\'s Push and Wednesday\'s Pull (both core) must still be missed, got ' + JSON.stringify(missed));
  } else {
    ok('missedDayTypesThisWeek: core misses (Push, Pull) are still reported');
  }
}

// ---------------------------------------------------------------
// Part 2 — buildRebalanceLayout, extracted verbatim.
// ---------------------------------------------------------------
function runPart2() {
  const sandbox = buildSandbox();
  sandbox.recentAvgPaceMinPerKm = () => 6.25; // 45min budget = exactly 7.2km, matching the reported live case
  sandbox.recentAvgSwimPaceMinPer100m = () => null;
  const block = [
    extractConst('WEEK_DATES_WEEKDAY_ORDER'),
    extractConst('PLAN_CARD_WEEKDAY_SHORT'),
    extractConst('DEFAULT_SESSION_MINUTES'),
    extractConst('REBALANCE_MAX_EXTRA_MIN_PER_DAY'),
    extractConst('REBALANCE_TOMORROW_MAX_SHARE'),
    extractConst('REBALANCE_PADEL_MAX_EXTRA_MIN'),
    extractConst('REBALANCE_MIN_SESSION_KM'),
    extractConst('GENERIC_FALLBACK_PACE_MIN_PER_KM'),
    extractConst('BASIC_SWIMMER_PACE_MIN_PER_100M'),
    extractConst('PADEL_RE'),
    extractFn('dateKey'),
    extractFn('dayHasPadel'),
    extractFn('resolveRhythmStrengthDayType'),
    extractFn('classifyWeeklyStrengthRhythm'),
    extractConst('REBALANCE_HARD_KINDS'),
    extractFn('rhythmMinutesForDay'),
    extractFn('restrictionBlocksDiscipline'),
    extractFn('describeOutstanding'),
    extractFn('dayHasLoggedActivity'),
    extractFn('buildRebalanceLayout'),
  ].join('\n');
  vm.runInContext(block + '\nthis.buildRebalanceLayout = buildRebalanceLayout;', sandbox);
  const buildRebalanceLayout = sandbox.buildRebalanceLayout;

  function perDayFrom(dateKeys) {
    return Object.keys(dateKeys).map((wd) => ({ weekday: wd, dateKey: dateKeys[wd], availableMin: 300, allowedDisciplines: { run: true, bike: true, swim: true, strength: true } }));
  }
  const capacityFrom = (perDay) => ({ configured: true, preferredLongDay: null, allEvents: [], perDay });

  // --- Case A — Wed today, Mon Push missed, Wed Pull (today's own
  // entry) evicted -> moves to Thu, dropping Explosive (skipped, not
  // missed). Sat Legs untouched. ---
  {
    const RHYTHM = {
      monday: [{ discipline: 'strength', kind: 'push' }],
      wednesday: [{ discipline: 'strength', kind: 'pull' }],
      thursday: [{ discipline: 'strength', kind: 'explosive' }],
      saturday: [{ discipline: 'strength', kind: 'legs' }],
    };
    const perDay = perDayFrom({ wednesday: '2026-10-14', thursday: '2026-10-15', friday: '2026-10-16', saturday: '2026-10-17', sunday: '2026-10-18' });
    const outstanding = { strength: { targetSessions: 3, doneSessions: 0, outstandingSessions: 1, missed: [{ dayType: 'Push', weekday: 'Monday' }] } };
    const todayStrengthDisplacement = { displacedToday: { dayType: 'Pull', weekday: 'Wednesday' }, skippedToday: null };
    const strengthClassification = sandbox.classifyWeeklyStrengthRhythm(RHYTHM, DAYS, 3);
    const result = buildRebalanceLayout(outstanding, capacityFrom(perDay), RHYTHM, [], {}, false, todayStrengthDisplacement, strengthClassification);

    if (result.movedNote !== 'Pull (moved from Wed to Thu)') fail('Case A: expected movedNote "Pull (moved from Wed to Thu)", got ' + JSON.stringify(result.movedNote));
    else ok('Case A: Pull (today\'s own entry, evicted by Push) moves to Thu — "Pull (moved from Wed to Thu)"');
    if (result.skippedNote !== 'Explosive skipped: weekly strength target covered') fail('Case A: expected skippedNote for Explosive, got ' + JSON.stringify(result.skippedNote));
    else ok('Case A: Explosive is dropped as a neutral skip, never missed — "Explosive skipped: weekly strength target covered"');
    if (result.cantFit.length) fail('Case A: expected no cantFit, got ' + JSON.stringify(result.cantFit));
    else ok('Case A: nothing left unplaced');
    const satSession = (result.layout.find((d) => d.weekday === 'saturday') || { sessions: [] }).sessions;
    if (satSession.length) fail('Case A: Saturday\'s Legs must be untouched (no rebalance addition there), got ' + JSON.stringify(satSession));
    else ok('Case A: Saturday\'s Legs stays untouched');
  }

  // --- Case B — nothing missed/displaced at all -> unchanged (early
  // return, no layout/moved/skipped/cantFit). ---
  {
    const result = buildRebalanceLayout({}, capacityFrom([]), {}, [], {}, false, { displacedToday: null, skippedToday: null }, []);
    if (result.layout.length || result.cantFit.length || result.movedNote || result.skippedNote) {
      fail('Case B: nothing missed must leave the rebalancer completely empty, got ' + JSON.stringify(result));
    } else {
      ok('Case B: nothing missed -> rebalancer produces nothing (rhythm stays exactly as configured)');
    }
  }

  // --- Case C — Thu today, Mon Push + Wed Pull both missed. Today's
  // own entry (Explosive) is the extra -> dropped directly (no
  // displacement attempt). Push -> today (handled elsewhere, not this
  // function). Pull -> next free day (Fri), with a note. ---
  {
    const RHYTHM = {
      monday: [{ discipline: 'strength', kind: 'push' }],
      wednesday: [{ discipline: 'strength', kind: 'pull' }],
      thursday: [{ discipline: 'strength', kind: 'explosive' }],
      saturday: [{ discipline: 'strength', kind: 'legs' }],
    };
    const perDay = perDayFrom({ thursday: '2026-10-15', friday: '2026-10-16', saturday: '2026-10-17', sunday: '2026-10-18' });
    const outstanding = { strength: { targetSessions: 3, doneSessions: 0, outstandingSessions: 2, missed: [{ dayType: 'Push', weekday: 'Monday' }, { dayType: 'Pull', weekday: 'Wednesday' }] } };
    const todayStrengthDisplacement = { displacedToday: null, skippedToday: { dayType: 'Explosive', weekday: 'Thursday' } };
    const strengthClassification = sandbox.classifyWeeklyStrengthRhythm(RHYTHM, DAYS, 3);
    const result = buildRebalanceLayout(outstanding, capacityFrom(perDay), RHYTHM, [], {}, false, todayStrengthDisplacement, strengthClassification);

    if (result.movedNote !== 'Pull (moved from Wed to Fri)') fail('Case C: expected movedNote "Pull (moved from Wed to Fri)", got ' + JSON.stringify(result.movedNote));
    else ok('Case C: Pull (missed Wed, not today\'s pick) moves to Fri — "Pull (moved from Wed to Fri)"');
    if (result.skippedNote !== 'Explosive skipped: weekly strength target covered') fail('Case C: expected skippedNote for Explosive (today\'s own entry, dropped directly), got ' + JSON.stringify(result.skippedNote));
    else ok('Case C: today\'s own Explosive is dropped as a neutral skip (today\'s slot goes to missed Push instead)');
    if (result.cantFit.length) fail('Case C: expected no cantFit, got ' + JSON.stringify(result.cantFit));
    else ok('Case C: nothing left unplaced');
  }

  // --- Case D — Wed today, every remaining day already has a CORE
  // (non-extra) rhythm session -> Pull (displaced from today) has
  // nowhere to go -> named in cantFit, never silently dropped. ---
  {
    const RHYTHM = {
      monday: [{ discipline: 'strength', kind: 'push' }],
      wednesday: [{ discipline: 'strength', kind: 'pull' }],
      thursday: [{ discipline: 'strength', kind: 'legs' }],
      friday: [{ discipline: 'strength', kind: 'push' }],
      saturday: [{ discipline: 'strength', kind: 'legs' }],
      sunday: [{ discipline: 'strength', kind: 'pull' }],
    };
    const perDay = perDayFrom({ wednesday: '2026-10-14', thursday: '2026-10-15', friday: '2026-10-16', saturday: '2026-10-17', sunday: '2026-10-18' });
    const outstanding = { strength: { targetSessions: 6, doneSessions: 0, outstandingSessions: 2, missed: [{ dayType: 'Push', weekday: 'Monday' }] } };
    const todayStrengthDisplacement = { displacedToday: { dayType: 'Pull', weekday: 'Wednesday' }, skippedToday: null };
    const strengthClassification = sandbox.classifyWeeklyStrengthRhythm(RHYTHM, DAYS, 6);
    const result = buildRebalanceLayout(outstanding, capacityFrom(perDay), RHYTHM, [], {}, false, todayStrengthDisplacement, strengthClassification);

    if (!result.cantFit.length || !/Pull \(from Wed\)/.test(result.cantFit[0].reason)) {
      fail('THE EXACT ASSERTION REQUESTED: a displaced core session with no free slot must be named in cantFit, got ' + JSON.stringify(result.cantFit));
    } else {
      ok('Case D: Pull (displaced from today, no free day left) is named in cantFit, never silently dropped — ' + JSON.stringify(result.cantFit[0].reason));
    }
    if (result.movedNote) fail('Case D: expected no movedNote (nothing could actually move), got ' + JSON.stringify(result.movedNote));
    else ok('Case D: no movedNote (nothing could actually move)');
  }

  // --- Case E (THE LIVE CASE) — Wed today (its own window already
  // closed), Mon Push missed, Wed Pull evicted by Push -> needs a new
  // slot. SAME day, an 8km run backlog (interval 3km missed Tue, easy
  // 5km missed Wed) also wants Thursday. Before the fix, cardio ran
  // first and consumed the whole day (45min = 7.2km) before strength
  // ever got a chance, so Pull had nowhere left and went to cantFit.
  // After the fix: Pull claims Thu (Explosive's slot) FIRST; cardio
  // then correctly sees less room there and shrinks/spills onto Fri
  // instead of monopolizing the day. ---
  {
    const RHYTHM = {
      monday: [{ discipline: 'strength', kind: 'push' }],
      wednesday: [{ discipline: 'strength', kind: 'pull' }],
      thursday: [{ discipline: 'strength', kind: 'explosive' }],
      saturday: [{ discipline: 'strength', kind: 'legs' }],
    };
    // Wednesday's own window is already closed (0 min left today) —
    // "after the day's training," matching the live case; every other
    // day is wide open.
    const perDay = [
      { weekday: 'wednesday', dateKey: '2026-10-14', availableMin: 0, allowedDisciplines: { run: true, bike: true, swim: true, strength: true } },
      { weekday: 'thursday', dateKey: '2026-10-15', availableMin: 300, allowedDisciplines: { run: true, bike: true, swim: true, strength: true } },
      { weekday: 'friday', dateKey: '2026-10-16', availableMin: 300, allowedDisciplines: { run: true, bike: true, swim: true, strength: true } },
      { weekday: 'saturday', dateKey: '2026-10-17', availableMin: 300, allowedDisciplines: { run: true, bike: true, swim: true, strength: true } },
      { weekday: 'sunday', dateKey: '2026-10-18', availableMin: 300, allowedDisciplines: { run: true, bike: true, swim: true, strength: true } },
    ];
    const outstanding = {
      strength: { targetSessions: 3, doneSessions: 0, outstandingSessions: 1, missed: [{ dayType: 'Push', weekday: 'Monday' }] },
      run: {
        targetKm: 20, doneKm: 0, outstandingKm: 8, activityTypeId: 'run1', activityName: 'Running',
        missed: [{ dateKey: '2026-10-13', weekday: 'tuesday', kind: 'interval', amount: 3 }, { dateKey: '2026-10-14', weekday: 'wednesday', kind: 'easy', amount: 5 }],
      },
    };
    const todayStrengthDisplacement = { displacedToday: { dayType: 'Pull', weekday: 'Wednesday' }, skippedToday: null };
    const strengthClassification = sandbox.classifyWeeklyStrengthRhythm(RHYTHM, DAYS, 3);
    const result = buildRebalanceLayout(outstanding, capacityFrom(perDay), RHYTHM, [], {}, false, todayStrengthDisplacement, strengthClassification);

    console.log('\n--- Case E (live case) Rest of week text dump ---');
    console.log('moved=' + JSON.stringify(result.movedNote) + ' skipped=' + JSON.stringify(result.skippedNote) + ' cantFit=' + JSON.stringify(result.cantFit) + ' layout=' + JSON.stringify(result.layout));

    if (!result.movedNote.includes('Pull (moved from Wed to Thu)')) {
      fail('THE EXACT ASSERTION REQUESTED: Case E — Pull must still be placed in Thu/Explosive\'s slot despite the run backlog also wanting it, got ' + JSON.stringify(result.movedNote));
    } else {
      ok('Case E: Pull is placed in Thu (Explosive\'s slot) despite the competing run backlog');
    }
    if (result.skippedNote !== 'Explosive skipped: weekly strength target covered') {
      fail('Case E: expected Explosive skipped, got ' + JSON.stringify(result.skippedNote));
    } else {
      ok('Case E: Explosive is still dropped as a neutral skip');
    }
    const thuDay = result.layout.find((d) => d.weekday === 'thursday');
    const thuRunSession = thuDay && thuDay.sessions.find((s) => s.discipline === 'run');
    if (!thuRunSession || thuRunSession.targetAmount >= 7.2) {
      fail('THE EXACT ASSERTION REQUESTED: Case E — the run backlog on Thu must shrink below its old 7.2km (cardio no longer monopolizes the day), got ' + JSON.stringify(thuRunSession));
    } else {
      ok('Case E: the run backlog on Thu shrinks to ' + thuRunSession.targetAmount + 'km instead of monopolizing the day (was 7.2km before the fix)');
    }
    const friDay = result.layout.find((d) => d.weekday === 'friday');
    const friRunSession = friDay && friDay.sessions.find((s) => s.discipline === 'run');
    if (!friRunSession) {
      fail('THE EXACT ASSERTION REQUESTED: Case E — the rest of the run backlog must spill onto Friday, got no Friday run session');
    } else {
      ok('Case E: the rest of the run backlog spills onto Friday — ' + friRunSession.targetAmount + 'km');
    }
    const totalRunKm = (thuRunSession ? thuRunSession.targetAmount : 0) + (friRunSession ? friRunSession.targetAmount : 0);
    if (Math.abs(totalRunKm - 8) > 0.01) {
      fail('Case E: the full 8km backlog should be accounted for (placed + cantFit), got ' + totalRunKm + 'km placed and cantFit=' + JSON.stringify(result.cantFit));
    } else {
      ok('Case E: the full 8km run backlog is accounted for — nothing lost, nothing silent (' + totalRunKm + 'km placed, cantFit=' + JSON.stringify(result.cantFit) + ')');
    }
  }
}

// ---------------------------------------------------------------
// Part 3 — the real gym.html page, Case A end-to-end.
// ---------------------------------------------------------------
function buildHtml() {
  let html = fs.readFileSync(path.join(ROW_DIR, 'gym.html'), 'utf8');
  const esc = (s) => s.replace(/<\/script/gi, '<\\/script');
  html = html.replace('<script src="lock.js"></script>', '<script>' + esc(fs.readFileSync(path.join(ROW_DIR, 'lock.js'), 'utf8')) + '</script>');
  html = html.replace('<script src="daylib.js"></script>', '<script>' + esc(fs.readFileSync(path.join(ROW_DIR, 'daylib.js'), 'utf8')) + '</script>');
  html = html.replace('<script src="topbar.js" defer></script>', '<script>' + esc(fs.readFileSync(path.join(ROW_DIR, 'topbar.js'), 'utf8')) + '</script>');
  html = html.replace(/<script src="https:\/\/unpkg\.com\/lucide[^"]*"[^>]*><\/script>/, '<script>window.lucide = { createIcons: function(){} };</script>');
  const supabaseStub = (
    '<script>window.supabase = { createClient: function() {' +
    'var chain = { select: function(){ return chain; }, eq: function(){ return chain; }, maybeSingle: function(){ return Promise.resolve({ data: null, error: null }); } };' +
    'var channel = { on: function(){ return channel; }, subscribe: function(){ return channel; } };' +
    'return { auth: {}, from: function(){ return chain; }, channel: function(){ return channel; } }; } };</script>'
  );
  html = html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js[^"]*"><\/script>/, supabaseStub);
  return html;
}
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function pinClock(win, isoString) {
  const FIXED_NOW = new win.Date(isoString);
  const RealDate = win.Date;
  class FixedDate extends RealDate {
    constructor(...args) { return args.length ? new RealDate(...args) : new RealDate(FIXED_NOW); }
    static now() { return FIXED_NOW.getTime(); }
  }
  win.Date = FixedDate;
}

const RHYTHM_BODY = {
  monday: [{ discipline: 'strength', kind: 'push' }],
  tuesday: [{ discipline: 'run', kind: 'interval' }],
  wednesday: [{ discipline: 'run', kind: 'easy' }, { discipline: 'swim', kind: 'pace' }, { discipline: 'strength', kind: 'pull' }],
  thursday: [{ discipline: 'strength', kind: 'explosive' }],
  friday: [{ discipline: 'run', kind: 'pace' }],
  saturday: [{ discipline: 'swim', kind: 'technique' }, { discipline: 'strength', kind: 'legs' }],
  sunday: [{ discipline: 'run', kind: 'long' }, { discipline: 'swim', kind: 'pace' }],
};
const WEEK_PLAN = {
  targets: { run: { km: 20, activityTypeId: 'run1', activityName: 'Running' }, strength: { sessions: 3 }, swim: { sessions: 3, meters: 1000, activityTypeId: 'swim1', activityName: 'Swimming' } },
  strength: { targetSessions: 3, focus: '' },
  cardio: { interval: { targetSessions: 0, targetMinutes: 0 }, longSession: {}, easyVolume: {} },
  layout: [
    { weekday: 'monday', dateKey: '2026-10-12', sessions: [{ discipline: 'strength', kind: 'push', estMinutes: 45 }] },
    { weekday: 'tuesday', dateKey: '2026-10-13', sessions: [{ discipline: 'run', kind: 'interval', activityTypeId: 'run1', activityName: 'Running', targetAmount: 3, unit: 'km', estMinutes: 20 }] },
    { weekday: 'wednesday', dateKey: '2026-10-14', sessions: [
      { discipline: 'run', kind: 'easy', activityTypeId: 'run1', activityName: 'Running', targetAmount: 5, unit: 'km', estMinutes: 30 },
      { discipline: 'swim', kind: 'pace', activityTypeId: 'swim1', activityName: 'Swimming', targetAmount: 1000, unit: 'm', estMinutes: 30 },
      { discipline: 'strength', kind: 'pull', estMinutes: 45 },
    ] },
    { weekday: 'thursday', dateKey: '2026-10-15', sessions: [{ discipline: 'strength', kind: 'explosive', estMinutes: 45 }] },
    { weekday: 'friday', dateKey: '2026-10-16', sessions: [{ discipline: 'run', kind: 'pace', activityTypeId: 'run1', activityName: 'Running', targetAmount: 5, unit: 'km', estMinutes: 30 }] },
    { weekday: 'saturday', dateKey: '2026-10-17', sessions: [
      { discipline: 'swim', kind: 'technique', activityTypeId: 'swim1', activityName: 'Swimming', targetAmount: 1000, unit: 'm', estMinutes: 30 },
      { discipline: 'strength', kind: 'legs', estMinutes: 45 },
    ] },
    { weekday: 'sunday', dateKey: '2026-10-18', sessions: [
      { discipline: 'run', kind: 'long', activityTypeId: 'run1', activityName: 'Running', targetAmount: 7, unit: 'km', estMinutes: 42 },
      { discipline: 'swim', kind: 'pace', activityTypeId: 'swim1', activityName: 'Swimming', targetAmount: 1000, unit: 'm', estMinutes: 30 },
    ] },
  ],
  unplaced: [], rationale: 'Week 1.',
};

async function runPart3() {
  const html = buildHtml();
  const consoleErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => consoleErrors.push('JSDOM: ' + (e.stack || e.message)));
  virtualConsole.on('error', (...args) => consoleErrors.push(args.map(String).join(' ')));
  const dom = new JSDOM(html, {
    url: 'https://row.test/gym.html', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(win) {
      pinClock(win, '2026-10-14T12:00:00Z'); // Wednesday, pinned regardless of actual wall-clock date
      win.localStorage.setItem('dashboard:secret', 'test-secret');
      win.sessionStorage.setItem('dashboard:unlocked', '1');
      win.localStorage.setItem('po_coach_weekly_plan_v1', JSON.stringify({ weekStart: '2026-10-12', plan: WEEK_PLAN, generatedAt: new win.Date().toISOString() }));
    },
  });
  const { window } = dom;
  window.console.warn = () => {};
  window.alert = () => {};
  window.addEventListener('error', (e) => consoleErrors.push('UNCAUGHT: ' + (e.error && (e.error.stack || e.error.message) || e.message)));

  const fetchLog = [];
  window.fetch = (url, opts) => {
    const u = String(url);
    fetchLog.push({ url: u, body: opts && opts.body });
    let body = { ok: true };
    if (u.includes('resource=plans')) body = { ok: true, plans: [{ id: 'p1', status: 'active', startDate: '2026-10-12', weeklyCheckpoints: [{ weekNumber: 1, weekStartDate: '2026-10-12', disciplines: { run: { km: 20 }, strength: { sessions: 3 }, swim: { sessions: 3 } } }] }] };
    else if (u.includes('resource=activity-types')) body = { ok: true, types: [{ id: 'run1', name: 'Running', unit: 'km', unitKind: 'distance', recommendable: true }, { id: 'swim1', name: 'Swimming', unit: 'm', unitKind: 'distance', recommendable: true }] };
    else if (u.includes('resource=restrictions')) body = { ok: true, restrictions: [] };
    else if (u.includes('resource=weekly-rhythm')) body = { ok: true, rhythm: RHYTHM_BODY };
    else if (u.includes('mode=plan')) body = { ok: true, plan: WEEK_PLAN };
    else if (u.includes('mode=today')) body = { ok: true, recommendation: 'Push' };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) });
  };

  await wait(1200);
  // Generous, explicit availability for EVERY day this week (today
  // through Sunday) so Thu/Fri/Sun — which have no rhythm placement
  // of their own — are genuinely free candidates, not defaulted to
  // "nothing allowed" by the template.
  window.gatherTodayContext = async () => ({
    availability: {
      configured: true,
      today: { minutes: 180, disciplines: { run: true, bike: true, swim: true, strength: true } },
      thisWeek: ['thursday', 'friday', 'saturday', 'sunday'].map((weekday) => ({ weekday, minutes: 180, disciplines: { run: true, bike: true, swim: true, strength: true } })),
      preferredLongDay: null,
    },
    calendar: { upcoming: [] },
  });
  // Days with no TYPED strength rhythm entry (Tuesday here) fall back
  // to the user's own strength ROTATION (missedDayTypesThisWeek's
  // documented fallback) — a real, separate feature, out of scope for
  // this test. Neutralize it so only this test's own RHYTHM_BODY
  // decides what each day's strength day-type is.
  window.PoCoach.getSplitForDate = () => ({ name: null });

  if (consoleErrors.length) fail('page load produced ' + consoleErrors.length + ' console error(s): ' + consoleErrors.join(' | '));
  else ok('page loaded with zero console errors');

  window.document.getElementById('tpRebalanceBtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await wait(1000);

  const stored = JSON.parse(window.localStorage.getItem('po_coach_weekly_plan_v1'));
  const rb = stored.plan.rebalance;
  console.log('\n--- Case A text dump ---');
  console.log('Today\'s session (todayPick): ' + JSON.stringify(rb.todayPick, null, 2));
  console.log('Rest of week (rb): moved=' + JSON.stringify(rb.movedNote) + ' skipped=' + JSON.stringify(rb.skippedNote) + ' cantFit=' + JSON.stringify(rb.cantFit) + ' layout=' + JSON.stringify(rb.layout));

  if (!rb.movedNote.includes('Pull (moved from Wed to Thu)')) {
    fail('THE EXACT ASSERTION REQUESTED: Case A real-page movedNote must include "Pull (moved from Wed to Thu)", got ' + JSON.stringify(rb.movedNote));
  } else {
    ok('Case A (real page): Rest of week shows "Pull (moved from Wed to Thu)"');
  }
  if (rb.skippedNote !== 'Explosive skipped: weekly strength target covered') {
    fail('THE EXACT ASSERTION REQUESTED: Case A real-page skippedNote must report Explosive skipped, got ' + JSON.stringify(rb.skippedNote));
  } else {
    ok('Case A (real page): Rest of week shows "Explosive skipped: weekly strength target covered"');
  }
  const skippedEl = window.document.getElementById('tpRebalanceSkipped');
  if (!skippedEl || skippedEl.style.display !== 'block' || skippedEl.textContent !== rb.skippedNote) {
    fail('Case A: #tpRebalanceSkipped must render the skipped note, got display=' + (skippedEl && skippedEl.style.display) + ' text=' + (skippedEl && skippedEl.textContent));
  } else {
    ok('Case A: #tpRebalanceSkipped renders the skipped note in the UI');
  }

  if (consoleErrors.length) fail('console/script errors appeared during the click flow (see above)');
}

async function main() {
  runPart1();
  runPart2();
  await runPart3();
  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
}

main();
