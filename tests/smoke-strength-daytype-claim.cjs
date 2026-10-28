// Smoke test — run this before every push touching strength's own
// week-scoped day-type claim (computeClaimedStrengthDaySlots / the
// strength branch of tpLayoutDays+isLayoutDayFullyDone's isDone, and
// buildTodayRebalancePick's Priority 3 skip) in gym.html.
//
//   node tests/smoke-strength-daytype-claim.cjs
//
// BUG FIX (reported): the layout strike-through only ever struck a
// strength slot when "Mark workout done" was pressed on that EXACT
// calendar date (doneDaysMap[day.dateKey]) — never when a strength
// log's real day-type (Push/Pull/Legs/Explosive, derived the same way
// missedDayTypesThisWeek already derives it) was logged on a
// DIFFERENT day this week. Live case: rhythm Mon Push, Wed Pull, Thu
// Explosive (extra), Sat Legs; the user does Mon Push (marked done +
// logged) and logs a Pull on Tuesday (early) — Wed's own Pull slot
// never struck, and if Wednesday then arrives, its native Pull entry
// got recommended AGAIN by Today's pick / Rest of week, despite
// already being done.
//
// Part 1: computeClaimedStrengthDaySlots, extracted verbatim —
// same-date claim, early-log claim, two-logs-one-slot, previous-week
// never claims, an unclaimed Explosive slot is untouched.
// Part 2: buildTodayRebalancePick's new Priority 3 skip, extracted
// verbatim — a day-type already claimed this week is never
// recommended again; an unclaimed day-type (or no claim set at all,
// old call sites) is unaffected.
// Part 3: the real gym.html page, THE LIVE CASE — "This week's
// layout" text dump, Tuesday (today), Mon Push + Wed Pull struck, Thu
// Explosive + Sat Legs not.
// Part 4: the real gym.html page, same week, pinned to Wednesday
// (today) — "Today's session"/"Rest of week" text dump via the real
// tpRebalanceBtn click flow: Pull is recommended nowhere.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROW_DIR = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROW_DIR, 'gym.html'), 'utf8');
const daylibSrc = fs.readFileSync(path.join(ROW_DIR, 'daylib.js'), 'utf8');
let failures = 0;
function fail(msg) { failures++; console.log('FAIL:', msg); }
function ok(msg) { console.log('PASS:', msg); }

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

const DAYS = [{ id: 'd1', name: 'Push' }, { id: 'd2', name: 'Pull' }, { id: 'd3', name: 'Legs' }, { id: 'd4', name: 'Explosive' }];
const EXERCISES = [{ id: 'ex_push', day: 'd1' }, { id: 'ex_pull', day: 'd2' }, { id: 'ex_legs', day: 'd3' }, { id: 'ex_explosive', day: 'd4' }];

// LAYOUT — Monday 2026-10-26's week: Mon Push, Wed Pull, Thu
// Explosive (extra), Sat Legs — the live case's own rhythm.
const LAYOUT = [
  { dateKey: '2026-10-26', sessions: [{ discipline: 'strength', kind: 'push' }] },
  { dateKey: '2026-10-28', sessions: [{ discipline: 'strength', kind: 'pull' }] },
  { dateKey: '2026-10-29', sessions: [{ discipline: 'strength', kind: 'explosive' }] },
  { dateKey: '2026-10-31', sessions: [{ discipline: 'strength', kind: 'legs' }] },
];

function buildSandbox() {
  // Forces DayLib's effectiveDateKey onto UTC regardless of the host
  // machine's own timezone, so a bare 'YYYY-MM-DD' log.date resolves
  // to that exact plain date deterministically in CI.
  const sandbox = { window: {}, localStorage: { getItem: (k) => (k === 'dashboard:general_settings' ? JSON.stringify({ timezone: 'UTC' }) : null) } };
  vm.createContext(sandbox);
  vm.runInContext(daylibSrc, sandbox);
  sandbox.DayLib = sandbox.window.DayLib;
  const block = [
    extractFn('dateKey'),
    extractFn('addDaysKey'),
    extractFn('mondayOf'),
    extractFn('resolveRhythmStrengthDayType'),
    extractFn('computeClaimedStrengthDaySlots'),
  ].join('\n');
  vm.runInContext(block + '\nthis.computeClaimedStrengthDaySlots = computeClaimedStrengthDaySlots;', sandbox);
  return sandbox.computeClaimedStrengthDaySlots;
}

function stateWith(logs) {
  return { days: DAYS, exercises: EXERCISES, routines: [], logs: logs || {} };
}

// ---------------------------------------------------------------
// Part 1 — computeClaimedStrengthDaySlots, extracted verbatim.
// ---------------------------------------------------------------
function runPart1() {
  const computeClaimedStrengthDaySlots = buildSandbox();

  // THE LIVE CASE — Pull logged Tuesday (early) claims Wed's own Pull
  // slot; nothing else is claimed (Mon Push / Thu Explosive / Sat
  // Legs are untouched by this function — doneDaysMap handles Mon
  // separately, unaffected by this fix).
  {
    const state = stateWith({ ex_pull: [{ date: '2026-10-27', weight: 50, reps: 8 }] });
    const { sessions, dayTypes } = computeClaimedStrengthDaySlots(LAYOUT, state);
    const wedPull = LAYOUT[1].sessions[0];
    const monPush = LAYOUT[0].sessions[0];
    if (!sessions.has(wedPull)) fail('THE EXACT ASSERTION REQUESTED: Pull logged Tuesday must claim Wed\'s own Pull slot, got ' + sessions.size + ' claimed');
    else ok('live case: a Pull logged Tuesday (early) claims Wed\'s own Pull slot');
    if (sessions.has(monPush)) fail('live case: Mon Push must never be claimed by this function (doneDaysMap handles it separately)');
    else ok('live case: Mon Push is untouched by this function');
    if (sessions.size !== 1) fail('live case: expected exactly 1 claimed slot, got ' + sessions.size);
    else ok('live case: exactly one slot claimed');
    if (!dayTypes.has('Pull') || dayTypes.size !== 1) fail('live case: expected claimed dayTypes = {Pull}, got ' + JSON.stringify([...dayTypes]));
    else ok('live case: claimed dayTypes = {Pull}');
  }

  // Pull logged ON its own day (Wed) -> struck as before (same-date match).
  {
    const state = stateWith({ ex_pull: [{ date: '2026-10-28', weight: 50, reps: 8 }] });
    const { sessions } = computeClaimedStrengthDaySlots(LAYOUT, state);
    if (!sessions.has(LAYOUT[1].sessions[0])) fail('Pull-on-its-own-day: Wed\'s Pull slot must still be claimed by a same-date log');
    else ok('Pull logged on its own day (Wed) claims Wed\'s own slot, same as before');
  }

  // Legs logged Tuesday (early) -> claims Sat's Legs slot.
  {
    const state = stateWith({ ex_legs: [{ date: '2026-10-27', weight: 100, reps: 5 }] });
    const { sessions, dayTypes } = computeClaimedStrengthDaySlots(LAYOUT, state);
    if (!sessions.has(LAYOUT[3].sessions[0])) fail('THE EXACT ASSERTION REQUESTED: Legs logged Tuesday (early) must claim Sat\'s Legs slot');
    else ok('Legs logged Tuesday (early) claims Sat\'s Legs slot');
    if (!dayTypes.has('Legs')) fail('Legs early claim: expected dayTypes to contain Legs');
    else ok('Legs early claim: dayTypes contains Legs');
  }

  // Two Pull logs (Tue + Thu), one Pull slot (Wed) -> only one slot
  // claimed; the extra log claims nothing further.
  {
    const state = stateWith({ ex_pull: [{ date: '2026-10-27', weight: 50, reps: 8 }, { date: '2026-10-29', weight: 52, reps: 8 }] });
    const { sessions, dayTypes } = computeClaimedStrengthDaySlots(LAYOUT, state);
    if (sessions.size !== 1) fail('THE EXACT ASSERTION REQUESTED: two Pull logs against one Pull slot must claim only that one slot, got ' + sessions.size);
    else ok('two Pull logs, one Pull slot -> only one slot claimed');
    if (dayTypes.size !== 1) fail('two Pull logs: claimed dayTypes must still be a single-entry set, got ' + JSON.stringify([...dayTypes]));
    else ok('two Pull logs: claimed dayTypes stays a single entry (Pull)');
  }

  // Previous-week Pull log -> never claims (week-scoped, same bound as computeClaimedKindSlots).
  {
    const state = stateWith({ ex_pull: [{ date: '2026-10-19', weight: 50, reps: 8 }] });
    const { sessions, dayTypes } = computeClaimedStrengthDaySlots(LAYOUT, state);
    if (sessions.size) fail('THE EXACT ASSERTION REQUESTED: a previous-week Pull log must never claim this week\'s Pull slot, got ' + sessions.size + ' claimed');
    else ok('a previous-week Pull log never claims this week\'s slot');
    if (dayTypes.size) fail('previous-week log: claimed dayTypes must be empty, got ' + JSON.stringify([...dayTypes]));
    else ok('previous-week log: claimed dayTypes stays empty');
  }

  // Nothing logged for Explosive -> its slot stays unclaimed (it
  // remains optional/extra, handled by classifyWeeklyStrengthRhythm —
  // untouched here, this function makes no exception for it).
  {
    const state = stateWith({ ex_pull: [{ date: '2026-10-27', weight: 50, reps: 8 }] });
    const { sessions } = computeClaimedStrengthDaySlots(LAYOUT, state);
    if (sessions.has(LAYOUT[2].sessions[0])) fail('an unlogged Explosive slot must never be claimed by anything');
    else ok('Explosive (unlogged) stays unclaimed — remains optional/extra as before');
  }
}

// ---------------------------------------------------------------
// Part 2 — buildTodayRebalancePick's Priority 3 skip, extracted verbatim.
// ---------------------------------------------------------------
function buildPart2Sandbox() {
  const sandbox = {};
  vm.createContext(sandbox);
  const block = [
    extractConst('DEFAULT_SESSION_MINUTES'),
    extractConst('REBALANCE_TODAY_PRIORITY_ORDER'),
    extractConst('REBALANCE_MAX_EXTRA_MIN_PER_DAY'),
    extractConst('REBALANCE_TODAY_BUDGET_MIN'),
    extractFn('resolveRhythmStrengthDayType'),
    extractFn('buildTodayRebalancePick'),
  ].join('\n');
  vm.runInContext(block + '\nthis.buildTodayRebalancePick = buildTodayRebalancePick;', sandbox);
  return sandbox.buildTodayRebalancePick;
}
function runPart2() {
  const buildTodayRebalancePick = buildPart2Sandbox();
  const rhythmForDay = [{ discipline: 'strength', kind: 'pull' }];
  const targetsNotYetMet = { strength: { targetSessions: 3, doneSessions: 2, outstandingSessions: 1 } };

  // THE EXACT ASSERTION REQUESTED — Pull already claimed this week (a
  // Tuesday early log) -> Wednesday's native Pull entry is never
  // recommended again.
  {
    const claimedStrengthDayTypes = new Set(['Pull']);
    const pick = buildTodayRebalancePick([], null, rhythmForDay, targetsNotYetMet, claimedStrengthDayTypes, DAYS);
    if (pick.sessions.some((s) => s.discipline === 'strength') || pick.extras.some((e) => e.discipline === 'strength') || pick.cantFit.some((c) => c.discipline === 'strength')) {
      fail('THE EXACT ASSERTION REQUESTED: a claimed day-type (Pull) must not appear in sessions/extras/cantFit at all, got ' + JSON.stringify(pick));
    } else {
      ok('a day-type already claimed this week (Pull) is silently omitted from Today\'s pick — not recommended, not even as extra/cantFit');
    }
  }

  // Regression — nothing claimed (empty Set) -> old behavior
  // unchanged: today's native rhythm entry still joins the main pick.
  {
    const pick = buildTodayRebalancePick([], null, rhythmForDay, targetsNotYetMet, new Set(), DAYS);
    const entry = pick.sessions.find((s) => s.discipline === 'strength');
    if (!entry || entry.priority !== 'rhythmEntry') fail('regression: with nothing claimed, today\'s native rhythm entry must still be recommended as before, got ' + JSON.stringify(pick));
    else ok('regression: with nothing claimed this week, today\'s native rhythm entry is recommended exactly as before');
  }

  // Regression — no claimedStrengthDayTypes argument at all (every
  // pre-existing call site/test) -> behaves exactly as before this
  // feature existed.
  {
    const pick = buildTodayRebalancePick([], null, rhythmForDay, targetsNotYetMet);
    const entry = pick.sessions.find((s) => s.discipline === 'strength');
    if (!entry || entry.priority !== 'rhythmEntry') fail('regression: omitting the new params entirely must behave exactly as before, got ' + JSON.stringify(pick));
    else ok('regression: omitting the new claimedStrengthDayTypes/days params entirely behaves exactly as before');
  }

  // A claim for a DIFFERENT day-type (Legs) must never affect Pull.
  {
    const pick = buildTodayRebalancePick([], null, rhythmForDay, targetsNotYetMet, new Set(['Legs']), DAYS);
    const entry = pick.sessions.find((s) => s.discipline === 'strength');
    if (!entry) fail('a claim for a different day-type (Legs) must not suppress Pull\'s own recommendation, got ' + JSON.stringify(pick));
    else ok('a claim for an unrelated day-type (Legs) never suppresses Pull\'s own recommendation');
  }
}

// ---------------------------------------------------------------
// Parts 3/4 — the real gym.html page.
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
  wednesday: [{ discipline: 'strength', kind: 'pull' }],
  thursday: [{ discipline: 'strength', kind: 'explosive' }],
  saturday: [{ discipline: 'strength', kind: 'legs' }],
};
const WEEK_PLAN = {
  targets: {},
  strength: { targetSessions: 3, focus: '' },
  cardio: { interval: { targetSessions: 0, targetMinutes: 0 }, longSession: {}, easyVolume: {} },
  layout: [
    { weekday: 'monday', dateKey: '2026-10-26', sessions: [{ discipline: 'strength', kind: 'push', estMinutes: 45 }] },
    { weekday: 'wednesday', dateKey: '2026-10-28', sessions: [{ discipline: 'strength', kind: 'pull', estMinutes: 45 }] },
    { weekday: 'thursday', dateKey: '2026-10-29', sessions: [{ discipline: 'strength', kind: 'explosive', estMinutes: 45 }] },
    { weekday: 'saturday', dateKey: '2026-10-31', sessions: [{ discipline: 'strength', kind: 'legs', estMinutes: 45 }] },
  ],
  unplaced: [], rationale: 'Week 1.',
};
// THE LIVE CASE — Mon Push (marked done AND logged), Pull logged
// today (Tuesday, early) — nothing else logged/done this week.
const PC_STATE = {
  units: 'kg', gyms: [{ id: 'g1', name: 'Gym' }], days: DAYS, _explosiveDaySeeded: true,
  exercises: EXERCISES,
  logs: {
    ex_push: [{ date: '2026-10-26T09:00:00.000Z', weight: 80, reps: 5 }],
    ex_pull: [{ date: '2026-10-27T17:54:00.000Z', weight: 50, reps: 8 }],
  },
  routines: [],
  filterGym: 'g1', filterDay: 'd1',
  splitRotation: ['Push', 'Pull', 'Legs', 'Rest'],
  splitAnchor: { date: '2026-10-26', index: 0 },
};
const DONE_DAYS = { '2026-10-26': '2026-10-26T09:05:00.000Z', '2026-10-27': '2026-10-27T17:55:00.000Z' };

async function loadPage(pinDate) {
  const html = buildHtml();
  const consoleErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => consoleErrors.push('JSDOM: ' + (e.stack || e.message)));
  virtualConsole.on('error', (...args) => consoleErrors.push(args.map(String).join(' ')));
  const dom = new JSDOM(html, {
    url: 'https://row.test/gym.html', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(win) {
      pinClock(win, pinDate);
      win.localStorage.setItem('dashboard:secret', 'test-secret');
      win.sessionStorage.setItem('dashboard:unlocked', '1');
      win.localStorage.setItem('po_coach_weekly_plan_v1', JSON.stringify({ weekStart: '2026-10-26', plan: WEEK_PLAN, generatedAt: new win.Date().toISOString() }));
      win.localStorage.setItem('po_coach_v1', JSON.stringify(PC_STATE));
      win.localStorage.setItem('po_coach_workout_done', JSON.stringify(DONE_DAYS));
    },
  });
  const { window } = dom;
  window.console.warn = () => {};
  window.alert = () => {};
  window.addEventListener('error', (e) => consoleErrors.push('UNCAUGHT: ' + (e.error && (e.error.stack || e.error.message) || e.message)));

  const fetchLog = [];
  window.fetch = (url) => {
    const u = String(url);
    fetchLog.push(u);
    let body = { ok: true };
    if (u.includes('resource=plans')) body = { ok: true, plans: [{ id: 'p1', status: 'active', startDate: '2026-10-26', weeklyCheckpoints: [{ weekNumber: 1, weekStartDate: '2026-10-26', disciplines: { strength: { sessions: 3 } } }] }] };
    else if (u.includes('resource=activity-types')) body = { ok: true, types: [] };
    else if (u.includes('resource=restrictions')) body = { ok: true, restrictions: [] };
    else if (u.includes('resource=weekly-rhythm')) body = { ok: true, rhythm: RHYTHM_BODY };
    else if (u.includes('mode=plan')) body = { ok: true, plan: WEEK_PLAN };
    else if (u.includes('mode=today')) body = { ok: true, recommendation: 'Push' };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) });
  };
  window.gatherTodayContext = async () => ({
    availability: { configured: true, today: { minutes: 180, disciplines: { strength: true } }, thisWeek: [], preferredLongDay: null },
    calendar: { upcoming: [] },
  });

  await wait(1200);
  return { window, consoleErrors };
}

function sessionDoneMap(window) {
  const days = [...window.document.querySelectorAll('#tpLayoutDays .tp-layout-day')];
  const map = {};
  days.forEach((d) => {
    const label = d.querySelector('.tp-layout-day-label').textContent.trim();
    const span = d.querySelector('.tp-layout-session');
    map[label] = { text: span ? span.textContent.trim() : null, done: span ? span.classList.contains('is-done') : null };
  });
  return map;
}

// --- Part 3 — THE LIVE CASE, pinned to Tuesday (today). ---
async function runPart3() {
  const { window, consoleErrors } = await loadPage('2026-10-27T18:00:00Z');
  if (consoleErrors.length) fail('Part 3: page load produced console error(s): ' + consoleErrors.join(' | '));
  else ok('Part 3: page loaded with zero console errors');

  const doneMap = sessionDoneMap(window);
  console.log('\n--- THE LIVE CASE — "This week\'s layout" text dump (Tuesday) ---');
  console.log(JSON.stringify(doneMap));

  if (!doneMap.Mon || !doneMap.Mon.done) fail('THE EXACT ASSERTION REQUESTED: Mon Push must be struck, got ' + JSON.stringify(doneMap.Mon));
  else ok('live case: Mon Push is struck');
  if (!doneMap.Wed || !doneMap.Wed.done) fail('THE EXACT ASSERTION REQUESTED: Wed Pull must be struck (claimed by Tuesday\'s early log), got ' + JSON.stringify(doneMap.Wed));
  else ok('live case: Wed Pull is struck — claimed by today\'s (Tuesday\'s) early Pull log');
  if (!doneMap.Thu || doneMap.Thu.done) fail('THE EXACT ASSERTION REQUESTED: Thu Explosive must stay unstruck, got ' + JSON.stringify(doneMap.Thu));
  else ok('live case: Thu Explosive stays unstruck');
  if (!doneMap.Sat || doneMap.Sat.done) fail('THE EXACT ASSERTION REQUESTED: Sat Legs must stay unstruck, got ' + JSON.stringify(doneMap.Sat));
  else ok('live case: Sat Legs stays unstruck');

  if (consoleErrors.length) fail('Part 3: console/script errors appeared (see above)');
}

// --- Part 4 — same week, pinned to Wednesday (today). ---
async function runPart4() {
  const { window, consoleErrors } = await loadPage('2026-10-28T08:00:00Z');
  if (consoleErrors.length) fail('Part 4: page load produced console error(s): ' + consoleErrors.join(' | '));
  else ok('Part 4: page loaded with zero console errors');

  window.document.getElementById('tpRebalanceBtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await wait(1000);

  const stored = JSON.parse(window.localStorage.getItem('po_coach_weekly_plan_v1'));
  const rb = stored.plan.rebalance;
  console.log('\n--- Wednesday follow-on — "Today\'s session"/"Rest of week" text dump ---');
  console.log('todayPick: ' + JSON.stringify(rb.todayPick));
  console.log('Rest of week: moved=' + JSON.stringify(rb.movedNote) + ' skipped=' + JSON.stringify(rb.skippedNote) + ' cantFit=' + JSON.stringify(rb.cantFit) + ' layout=' + JSON.stringify(rb.layout));

  const mentionsPull = (x) => JSON.stringify(x).toLowerCase().includes('pull');
  if (rb.todayPick.sessions.some((s) => s.discipline === 'strength')) {
    fail('THE EXACT ASSERTION REQUESTED: Wednesday\'s Today pick must not recommend Pull again, got ' + JSON.stringify(rb.todayPick.sessions));
  } else {
    ok('Wednesday: Today\'s pick does not recommend Pull again — already claimed by Tuesday\'s early log');
  }
  if (mentionsPull(rb.movedNote) || mentionsPull(rb.skippedNote) || mentionsPull(rb.cantFit) || mentionsPull(rb.layout)) {
    fail('THE EXACT ASSERTION REQUESTED: Rest of week must not list Pull as missed or displaced, got moved=' + JSON.stringify(rb.movedNote) + ' skipped=' + JSON.stringify(rb.skippedNote) + ' cantFit=' + JSON.stringify(rb.cantFit) + ' layout=' + JSON.stringify(rb.layout));
  } else {
    ok('Wednesday: Rest of week has no Pull entry or note at all');
  }

  if (consoleErrors.length) fail('Part 4: console/script errors appeared (see above)');
}

async function main() {
  runPart1();
  runPart2();
  await runPart3();
  await runPart4();
  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
}

main();
