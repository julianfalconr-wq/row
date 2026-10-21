// Smoke test — run this before every push touching buildRebalanceLayout's
// day-eligibility rules in gym.html.
//
//   node tests/smoke-rebalance-same-discipline.cjs
//
// Reproduces the EXACT reported bug: the rebalancer must never place two
// sessions of the SAME discipline on the same day — a backlog chunk of
// discipline D must skip any day that already has a session of D, whether
// that's a native rhythm/layout session, a session this same rebalance pass
// already placed, or a real logged ACTIVITY (any kind, tagged or not).
// Live example: Wed with a logged 5km run today + Wed's own native Run Easy
// 5km, yet the missed Tuesday interval used to get moved onto Wed too —
// two/three runs the same day.
//
// DIFFERENT disciplines the same day (even two hard ones, e.g. Run + Legs)
// are explicitly FINE and must stay allowed — this is a discipline-scoped
// rule, never a general hard-session-stacking rule.
//
// Part 1: buildRebalanceLayout, extracted verbatim from gym.html, against
// the task's own cases (native-rhythm exclusion, logged-activity exclusion,
// swim analogue, cross-discipline same-day allowed, strength logged-today
// exclusion, no-eligible-day cantFit naming).
// Part 2: the real gym.html page, the literal reported live case (today
// pinned to the real Wed 2026-10-21) — a run already logged today plus
// Wed's own native run must never get a second run stacked onto Wed.
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

function buildSandbox() {
  const sandbox = {
    activityEntries: [],
    disciplineForActivityType: () => null,
    thisWeekMondayKey: () => '2026-10-19',
    window: { PoCoach: { getDoneDays: () => ({}) } },
    recentAvgPaceMinPerKm: () => 6,
    recentAvgSwimPaceMinPer100m: () => 2,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROW_DIR, 'daylib.js'), 'utf8'), sandbox);
  sandbox.DayLib = sandbox.window.DayLib;
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
  return sandbox;
}

function perDayFrom(entries) {
  // entries: [{weekday, dateKey, availableMin, allowed}]
  return entries.map((e) => ({
    weekday: e.weekday, dateKey: e.dateKey, availableMin: e.availableMin,
    allowedDisciplines: e.allowed || { run: true, bike: true, swim: true, strength: true },
  }));
}
const capacityFrom = (perDay) => ({ configured: true, preferredLongDay: null, allEvents: [], perDay });
const NO_DISPLACEMENT = { displacedToday: null, skippedToday: null };

function runPart1() {
  // --- Case 1 — a backlog run chunk must skip a day with a NATIVE run
  // rhythm entry, landing on the nearest run-free day instead (it used to
  // PREFER that exact day, stacking two runs on it). ---
  {
    const sandbox = buildSandbox();
    const weeklyRhythm = { tuesday: [{ discipline: 'run', kind: 'easy' }] };
    const perDay = perDayFrom([
      { weekday: 'monday', dateKey: '2026-10-19', availableMin: 300 },
      { weekday: 'tuesday', dateKey: '2026-10-20', availableMin: 300 },
      { weekday: 'wednesday', dateKey: '2026-10-21', availableMin: 300 },
    ]);
    const outstanding = { run: { outstandingKm: 3, activityTypeId: 'run1', activityName: 'Running', missed: [{ dateKey: '2026-10-18', weekday: 'sunday', kind: 'interval', amount: 3 }] } };
    const result = sandbox.buildRebalanceLayout(outstanding, capacityFrom(perDay), weeklyRhythm, [], {}, false, NO_DISPLACEMENT, []);
    const tueDay = result.layout.find((d) => d.weekday === 'tuesday');
    if (tueDay) fail('Case 1: Tuesday already has a native run — the backlog chunk must never land there, got ' + JSON.stringify(tueDay));
    else ok('Case 1: the native-run day (Tuesday) is excluded, not preferred');
    const monDay = result.layout.find((d) => d.weekday === 'monday');
    if (!monDay || !monDay.sessions.some((s) => s.discipline === 'run' && s.targetAmount === 3)) {
      fail('Case 1: THE EXACT ASSERTION REQUESTED — the 3km interval must land on the nearest run-free day (Monday), got ' + JSON.stringify(result.layout));
    } else {
      ok('Case 1: the interval lands on the nearest day WITHOUT a run (Monday), not the native-run day');
    }
  }

  // --- Case 2 — a day with no native rhythm run but a real logged run
  // ACTIVITY today (any kind, tagged or not) is excluded exactly the same
  // way. A zero-room buffer day sits at "tomorrow" (perDay[1]) so the
  // unrelated tomorrow-cap mechanism (REBALANCE_TOMORROW_MAX_SHARE) never
  // confounds this assertion — this test is about same-discipline
  // exclusion only. ---
  {
    const sandbox = buildSandbox();
    sandbox.activityEntries = [{ dateKey: '2026-10-19', activityTypeId: 'run1' }];
    sandbox.disciplineForActivityType = (id) => (id === 'run1' ? 'run' : null);
    const perDay = perDayFrom([
      { weekday: 'sunday', dateKey: '2026-10-18', availableMin: 0 }, // today
      { weekday: 'monday', dateKey: '2026-10-19', availableMin: 300 }, // already has a logged run
      { weekday: 'tuesday', dateKey: '2026-10-20', availableMin: 300 },
    ]);
    const outstanding = { run: { outstandingKm: 3, activityTypeId: 'run1', activityName: 'Running', missed: [{ dateKey: '2026-10-17', weekday: 'saturday', kind: 'interval', amount: 3 }] } };
    const result = sandbox.buildRebalanceLayout(outstanding, capacityFrom(perDay), {}, [], {}, false, NO_DISPLACEMENT, []);
    const monDay = result.layout.find((d) => d.weekday === 'monday');
    if (monDay) fail('Case 2: Monday already has a LOGGED run (no native rhythm at all) — must still be excluded, got ' + JSON.stringify(monDay));
    else ok('Case 2: a day with a logged run activity (untagged, no native rhythm) is excluded just like a native-rhythm day');
    const tueDay = result.layout.find((d) => d.weekday === 'tuesday');
    if (!tueDay || !tueDay.sessions.some((s) => s.discipline === 'run' && s.targetAmount === 3)) {
      fail('Case 2: the interval must land on Tuesday (the only run-free day), got ' + JSON.stringify(result.layout));
    } else {
      ok('Case 2: the interval lands on Tuesday instead');
    }
  }

  // --- Case 3 — swim analogue: two missed swim sessions must skip a day
  // with a native swim, landing on two OTHER days instead. ---
  {
    const sandbox = buildSandbox();
    const weeklyRhythm = { wednesday: [{ discipline: 'swim', kind: 'technique' }] };
    const perDay = perDayFrom([
      { weekday: 'wednesday', dateKey: '2026-10-21', availableMin: 300 },
      { weekday: 'thursday', dateKey: '2026-10-22', availableMin: 300 },
      { weekday: 'friday', dateKey: '2026-10-23', availableMin: 300 },
    ]);
    const outstanding = {
      swim: {
        outstandingSessions: 2, perSessionMeters: 1000, activityTypeId: 'swim1', activityName: 'Swimming',
        missed: [{ dateKey: '2026-10-19', weekday: 'monday', kind: 'pace' }, { dateKey: '2026-10-20', weekday: 'tuesday', kind: 'pace' }],
      },
    };
    const result = sandbox.buildRebalanceLayout(outstanding, capacityFrom(perDay), weeklyRhythm, [], {}, false, NO_DISPLACEMENT, []);
    const wedDay = result.layout.find((d) => d.weekday === 'wednesday');
    if (wedDay) fail('Case 3: Wednesday already has a native swim — backlog swims must never land there, got ' + JSON.stringify(wedDay));
    else ok('Case 3: the native-swim day (Wednesday) is excluded from the swim backlog');
    const thuDay = result.layout.find((d) => d.weekday === 'thursday');
    const friDay = result.layout.find((d) => d.weekday === 'friday');
    if (!thuDay || !thuDay.sessions.some((s) => s.discipline === 'swim') || !friDay || !friDay.sessions.some((s) => s.discipline === 'swim')) {
      fail('Case 3: THE EXACT ASSERTION REQUESTED — both missed swims must land elsewhere (Thu + Fri), got ' + JSON.stringify(result.layout));
    } else {
      ok('Case 3: both missed swim sessions land on the two swim-free days (Thu, Fri) instead of stacking on Wednesday');
    }
  }

  // --- Case 4 — DIFFERENT disciplines the same day (run + strength) stay
  // fully allowed — this is a discipline-SCOPED rule, never a general
  // hard-session-stacking rule. A zero-room buffer day sits at "tomorrow"
  // (perDay[1]) so the unrelated tomorrow-cap mechanism never confounds
  // this assertion (a flat 45-min strength session can easily exceed a
  // small backlog's own 50% tomorrow-share otherwise). ---
  {
    const sandbox = buildSandbox();
    const perDay = perDayFrom([
      { weekday: 'saturday', dateKey: '2026-10-17', availableMin: 0 }, // today — window already closed
      { weekday: 'sunday', dateKey: '2026-10-18', availableMin: 0 }, // tomorrow — zero room, irrelevant buffer
      { weekday: 'monday', dateKey: '2026-10-19', availableMin: 300 },
    ]);
    const outstanding = { run: { outstandingKm: 3, activityTypeId: 'run1', activityName: 'Running', missed: [{ dateKey: '2026-10-16', weekday: 'friday', kind: 'easy', amount: 3 }] } };
    const todayStrengthDisplacement = { displacedToday: { dayType: 'Push', weekday: 'Friday' }, skippedToday: null };
    const result = sandbox.buildRebalanceLayout(outstanding, capacityFrom(perDay), {}, [], {}, false, todayStrengthDisplacement, []);
    const monDay = result.layout.find((d) => d.weekday === 'monday');
    const hasStrength = monDay && monDay.sessions.some((s) => s.discipline === 'strength');
    const hasRun = monDay && monDay.sessions.some((s) => s.discipline === 'run');
    if (!hasStrength || !hasRun) {
      fail('THE EXACT ASSERTION REQUESTED — Case 4: run + strength on the same day must both be allowed, got ' + JSON.stringify(monDay));
    } else {
      ok('Case 4: run + strength both land on Monday — different disciplines the same day are unaffected');
    }
  }

  // --- Case 5 — no eligible day exists this week (every remaining day
  // already has a run) -> the chunk is named in cantFit, never silently
  // dropped and never forced onto an already-occupied day. ---
  {
    const sandbox = buildSandbox();
    const weeklyRhythm = {
      tuesday: [{ discipline: 'run', kind: 'easy' }],
      wednesday: [{ discipline: 'run', kind: 'easy' }],
      thursday: [{ discipline: 'run', kind: 'easy' }],
    };
    const perDay = perDayFrom([
      { weekday: 'tuesday', dateKey: '2026-10-20', availableMin: 300 },
      { weekday: 'wednesday', dateKey: '2026-10-21', availableMin: 300 },
      { weekday: 'thursday', dateKey: '2026-10-22', availableMin: 300 },
    ]);
    const outstanding = { run: { outstandingKm: 3, activityTypeId: 'run1', activityName: 'Running', missed: [{ dateKey: '2026-10-19', weekday: 'monday', kind: 'interval', amount: 3 }] } };
    const result = sandbox.buildRebalanceLayout(outstanding, capacityFrom(perDay), weeklyRhythm, [], {}, false, NO_DISPLACEMENT, []);
    if (result.layout.length) fail('Case 5: nothing should be placed at all, got ' + JSON.stringify(result.layout));
    else ok('Case 5: nothing is placed — every remaining day already has a run');
    const runCantFit = result.cantFit.find((c) => c.discipline === 'run');
    if (!runCantFit || !/every remaining day already has a run/i.test(runCantFit.reason)) {
      fail('THE EXACT ASSERTION REQUESTED — Case 5: no eligible day must be named in cantFit with the "every remaining day already has a run" reason, got ' + JSON.stringify(result.cantFit));
    } else {
      ok('Case 5: named in cantFit — ' + JSON.stringify(runCantFit.reason));
    }
  }

  // --- Case 6 — strength: a day with no native rhythm strength but a
  // real logged ("done") strength workout today is excluded exactly the
  // same way as run/swim above. ---
  {
    const sandbox = buildSandbox();
    sandbox.window.PoCoach.getDoneDays = () => ({ '2026-10-19': new Date().toISOString() });
    const perDay = perDayFrom([
      { weekday: 'sunday', dateKey: '2026-10-18', availableMin: 0 }, // today — excluded from strength candidates anyway
      { weekday: 'monday', dateKey: '2026-10-19', availableMin: 300 }, // already logged "done" today
      { weekday: 'tuesday', dateKey: '2026-10-20', availableMin: 300 },
    ]);
    const todayStrengthDisplacement = { displacedToday: { dayType: 'Legs', weekday: 'Saturday' }, skippedToday: null };
    const result = sandbox.buildRebalanceLayout({}, capacityFrom(perDay), {}, [], {}, false, todayStrengthDisplacement, []);
    const monDay = result.layout.find((d) => d.weekday === 'monday');
    if (monDay) fail('Case 6: Monday already has a LOGGED strength workout — must be excluded, got ' + JSON.stringify(monDay));
    else ok('Case 6: a day with an already-logged strength workout is excluded from strength placement');
    const tueDay = result.layout.find((d) => d.weekday === 'tuesday');
    if (!tueDay || !tueDay.sessions.some((s) => s.discipline === 'strength')) {
      fail('Case 6: the displaced Legs session must land on Tuesday instead, got ' + JSON.stringify(result.layout));
    } else {
      ok('Case 6: the displaced strength session lands on Tuesday instead');
    }
  }
}

// ---------------------------------------------------------------
// Part 2 — the real gym.html page, the literal reported live case.
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

// The real reported week: Monday 2026-10-19 .. Sunday 2026-10-25, today
// pinned to the real Wednesday (2026-10-21) named in the report.
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
    { weekday: 'monday', dateKey: '2026-10-19', sessions: [{ discipline: 'strength', kind: 'push', estMinutes: 45 }] },
    { weekday: 'tuesday', dateKey: '2026-10-20', sessions: [{ discipline: 'run', kind: 'interval', activityTypeId: 'run1', activityName: 'Running', targetAmount: 3, unit: 'km', estMinutes: 20 }] },
    { weekday: 'wednesday', dateKey: '2026-10-21', sessions: [
      { discipline: 'run', kind: 'easy', activityTypeId: 'run1', activityName: 'Running', targetAmount: 5, unit: 'km', estMinutes: 30 },
      { discipline: 'swim', kind: 'pace', activityTypeId: 'swim1', activityName: 'Swimming', targetAmount: 1000, unit: 'm', estMinutes: 30 },
      { discipline: 'strength', kind: 'pull', estMinutes: 45 },
    ] },
    { weekday: 'thursday', dateKey: '2026-10-22', sessions: [{ discipline: 'strength', kind: 'explosive', estMinutes: 45 }] },
    { weekday: 'friday', dateKey: '2026-10-23', sessions: [{ discipline: 'run', kind: 'pace', activityTypeId: 'run1', activityName: 'Running', targetAmount: 5, unit: 'km', estMinutes: 30 }] },
    { weekday: 'saturday', dateKey: '2026-10-24', sessions: [
      { discipline: 'swim', kind: 'technique', activityTypeId: 'swim1', activityName: 'Swimming', targetAmount: 1000, unit: 'm', estMinutes: 30 },
      { discipline: 'strength', kind: 'legs', estMinutes: 45 },
    ] },
    { weekday: 'sunday', dateKey: '2026-10-25', sessions: [
      { discipline: 'run', kind: 'long', activityTypeId: 'run1', activityName: 'Running', targetAmount: 7, unit: 'km', estMinutes: 42 },
      { discipline: 'swim', kind: 'pace', activityTypeId: 'swim1', activityName: 'Swimming', targetAmount: 1000, unit: 'm', estMinutes: 30 },
    ] },
  ],
  unplaced: [], rationale: 'Week 1.',
};

async function runPart2() {
  const html = buildHtml();
  const consoleErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => consoleErrors.push('JSDOM: ' + (e.stack || e.message)));
  virtualConsole.on('error', (...args) => consoleErrors.push(args.map(String).join(' ')));
  const dom = new JSDOM(html, {
    url: 'https://row.test/gym.html', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(win) {
      pinClock(win, '2026-10-21T18:00:00Z'); // the real Wednesday named in the report, after today's own training
      win.localStorage.setItem('dashboard:secret', 'test-secret');
      win.sessionStorage.setItem('dashboard:unlocked', '1');
      win.localStorage.setItem('po_coach_weekly_plan_v1', JSON.stringify({ weekStart: '2026-10-19', plan: WEEK_PLAN, generatedAt: new win.Date().toISOString() }));
      // THE EXACT REPORTED SCENARIO — the user already logged a 5km run
      // today (Wed), on top of Wed's own native Run Easy 5km.
      win.localStorage.setItem('po_coach_activities', JSON.stringify([
        { id: 'logged-1', dateKey: '2026-10-21', activityTypeId: 'run1', distanceKm: 5, durationMin: 30 },
      ]));
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
    if (u.includes('resource=plans')) body = { ok: true, plans: [{ id: 'p1', status: 'active', startDate: '2026-10-19', weeklyCheckpoints: [{ weekNumber: 1, weekStartDate: '2026-10-19', disciplines: { run: { km: 20 }, strength: { sessions: 3 }, swim: { sessions: 3 } } }] }] };
    else if (u.includes('resource=activity-types')) body = { ok: true, types: [{ id: 'run1', name: 'Running', unit: 'km', unitKind: 'distance', recommendable: true }, { id: 'swim1', name: 'Swimming', unit: 'm', unitKind: 'distance', recommendable: true }] };
    else if (u.includes('resource=restrictions')) body = { ok: true, restrictions: [] };
    else if (u.includes('resource=weekly-rhythm')) body = { ok: true, rhythm: RHYTHM_BODY };
    else if (u.includes('mode=plan')) body = { ok: true, plan: WEEK_PLAN };
    else if (u.includes('mode=today')) body = { ok: true, recommendation: 'Running interval' };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) });
  };

  await wait(1200);
  window.gatherTodayContext = async () => ({
    availability: {
      configured: true,
      today: { minutes: 0, disciplines: { run: true, bike: true, swim: true, strength: true } }, // today's own window already closed
      thisWeek: ['thursday', 'friday', 'saturday', 'sunday'].map((weekday) => ({ weekday, minutes: 180, disciplines: { run: true, bike: true, swim: true, strength: true } })),
      preferredLongDay: null,
    },
    calendar: { upcoming: [] },
  });
  window.PoCoach.getSplitForDate = () => ({ name: null });

  if (consoleErrors.length) fail('page load produced ' + consoleErrors.length + ' console error(s): ' + consoleErrors.join(' | '));
  else ok('page loaded with zero console errors');

  window.document.getElementById('tpRebalanceBtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await wait(1000);

  const stored = JSON.parse(window.localStorage.getItem('po_coach_weekly_plan_v1'));
  const rb = stored.plan.rebalance;
  console.log('\n--- Live case (reported bug) "Rest of week" text dump ---');
  console.log('moved=' + JSON.stringify(rb.movedNote) + ' skipped=' + JSON.stringify(rb.skippedNote) + ' cantFit=' + JSON.stringify(rb.cantFit) + ' layout=' + JSON.stringify(rb.layout));

  const wedDay = rb.layout.find((d) => d.dateKey === '2026-10-21');
  const wedRunSessions = wedDay ? wedDay.sessions.filter((s) => s.discipline === 'run') : [];
  if (wedRunSessions.length) {
    fail('THE EXACT ASSERTION REQUESTED — the reported bug: Wednesday already has a logged run AND a native run; the rebalancer must never add a SECOND run session there, got ' + JSON.stringify(wedDay));
  } else {
    ok('THE EXACT ASSERTION REQUESTED — Wednesday gets no backlog run session on top of its logged run + native run (no stacking)');
  }

  // Every OTHER day that already has its own native run (Fri/Sun) must
  // also never receive a second, backlog one.
  ['2026-10-23', '2026-10-25'].forEach((dk) => {
    const d = rb.layout.find((x) => x.dateKey === dk);
    const runs = d ? d.sessions.filter((s) => s.discipline === 'run') : [];
    if (runs.length > 1) fail('A day with its own native run (' + dk + ') must never get a second, backlog run stacked on it, got ' + JSON.stringify(d));
  });
  if (!failures) ok('no day in the layout ever carries two run sessions');

  // The missed Tuesday interval must be accounted for — either placed
  // somewhere (never on a day that already has a run) or named in cantFit,
  // never silently dropped.
  const movedInterval = /interval/i.test(rb.movedNote || '');
  const cantFitInterval = (rb.cantFit || []).some((c) => c.discipline === 'run' && /interval/i.test(c.reason));
  if (!movedInterval && !cantFitInterval) {
    fail('THE EXACT ASSERTION REQUESTED — the missed Tuesday interval must be named, either moved or in cantFit, never silently dropped. moved=' + JSON.stringify(rb.movedNote) + ' cantFit=' + JSON.stringify(rb.cantFit));
  } else if (movedInterval) {
    const landedDay = rb.layout.find((d) => d.sessions.some((s) => s.discipline === 'run' && s.isBacklog));
    ok('the missed Tuesday interval is named and moved — landed on ' + (landedDay ? landedDay.weekday : '?') + ' (never Wed/Fri/Sun, which already have a run)');
  } else {
    ok('the missed Tuesday interval is named in cantFit (no eligible day/budget this week) — ' + JSON.stringify(rb.cantFit));
  }

  if (rb.movedNote !== undefined && rb.movedNote.includes('Pull (moved from Wed to Thu)')) {
    ok('Pull (today\'s own entry, evicted by Push) still moves to Thu, unaffected by this fix');
  }

  if (consoleErrors.length) fail('console/script errors appeared during the click flow (see above)');
}

async function main() {
  runPart1();
  await runPart2();
  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
}

main();
