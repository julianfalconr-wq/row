// Smoke test — run this before every push touching
// computeOutstandingByDiscipline's kind-aware consumption pool, or
// computeClaimedKindSlots itself (gym.html).
//
//   node tests/smoke-rebalance-kind-claimed.cjs
//
// Reproduces the EXACT reported bug (part 2 of 2 — part 1 was the
// layout's own kind-aware strike-through, computeClaimedKindSlots,
// already shipped and untouched here): the backlog/remaining-target
// math was kind-BLIND — it consumed a logged activity's km oldest-
// missed-first regardless of which slot the activity's own `kind` tag
// actually claims on the layout. Live case, Wed 2026-10-21: target Run
// 22km, logged 5km tagged `pace` (claims Friday's native Pace slot,
// same as the layout strike-through already shows it struck). Before
// this fix, computeOutstandingByDiscipline instead spent that whole
// 5km against the OLDEST missed session (Tuesday's Interval, 3km),
// fully covering it with 2km to spare — so out.run never even got
// set: CONFIRMED by direct extraction, see runPart1's own live-case
// block below for the exact before/after numbers.
//
// Part 1: computeOutstandingByDiscipline, extracted verbatim (now
// including computeClaimedKindSlots, which it calls internally) —
// the live case (tagged pace claims Friday, Tuesday interval still
// missed), the same case UNTAGGED (old flat behavior unchanged), a
// tagged easy run claiming Wednesday's own slot (Tuesday still
// missed), a tagged interval run claiming Tuesday's own slot directly
// (no backlog at all), and a previous-week tagged activity (never
// claims — week-scoped, same bound as 2e77a95).
// Part 2: the real gym.html page, the literal live case end-to-end —
// a text dump of "Rest of week".
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROW_DIR = path.join(__dirname, '..');
let failures = 0;
function fail(msg) { failures++; console.log('FAIL:', msg); }
function ok(msg) { console.log('PASS:', msg); }

// ---------------------------------------------------------------
// Part 1 — computeOutstandingByDiscipline, extracted from the real
// gym.html source (not a reimplementation).
// ---------------------------------------------------------------
function buildSandbox() {
  const src = fs.readFileSync(path.join(ROW_DIR, 'gym.html'), 'utf8');
  const daylibSrc = fs.readFileSync(path.join(ROW_DIR, 'daylib.js'), 'utf8');
  function extractFn(name) {
    const start = src.indexOf('function ' + name + '(');
    if (start === -1) throw new Error('could not find ' + name + ' in gym.html — test extraction markers are stale');
    const braceStart = src.indexOf('{', start);
    let depth = 0, end = -1;
    for (let j = braceStart; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
    }
    return src.slice(start, end);
  }
  const sandbox = {
    activityEntries: [],
    disciplineForActivityType: (id) => (id === 'run1' ? 'run' : (id === 'swim1' ? 'swim' : null)),
    thisWeekMondayKey: () => '2026-10-19',
    resolveTodayBedtimeMs: () => Date.now() + 1000000, // today's window hasn't closed — "ahead" includes today onward
    window: { PoCoach: { getDoneDays: () => ({}) } },
  };
  vm.createContext(sandbox);
  vm.runInContext(daylibSrc, sandbox);
  sandbox.DayLib = sandbox.window.DayLib;
  const block = [
    extractFn('dateKey'),
    extractFn('addDaysKey'),
    extractFn('mondayOf'),
    extractFn('computeClaimedKindSlots'),
    extractFn('computeOutstandingByDisciplineLegacy'),
    extractFn('computeOutstandingByDiscipline'),
  ].join('\n');
  vm.runInContext(block + '\nthis.computeOutstandingByDiscipline = computeOutstandingByDiscipline;', sandbox);
  return sandbox;
}

// THE LIVE CASE's own rhythm — Mon Push, Tue Run Interval 3km, Wed Run
// Easy 5km + Swim Pace + Pull, Thu Explosive, Fri Run Pace 5km, Sat
// Swim Technique + Legs, Sun Run Long 9km + Swim Pace.
const RHYTHM = {
  monday: [{ discipline: 'strength', kind: 'push' }],
  tuesday: [{ discipline: 'run', kind: 'interval', km: 3 }],
  wednesday: [{ discipline: 'run', kind: 'easy', km: 5 }, { discipline: 'swim', kind: 'pace' }, { discipline: 'strength', kind: 'pull' }],
  thursday: [{ discipline: 'strength', kind: 'explosive' }],
  friday: [{ discipline: 'run', kind: 'pace', km: 5 }],
  saturday: [{ discipline: 'swim', kind: 'technique' }, { discipline: 'strength', kind: 'legs' }],
  sunday: [{ discipline: 'run', kind: 'long', km: 9 }, { discipline: 'swim', kind: 'pace' }],
};
const DATE_KEYS = { monday: '2026-10-19', tuesday: '2026-10-20', wednesday: '2026-10-21', thursday: '2026-10-22', friday: '2026-10-23', saturday: '2026-10-24', sunday: '2026-10-25' };
// THE LIVE CASE's own layout — every native session actually placed
// (no unplaced entries here at all; that's a different, already-fixed
// mechanism — smoke-unplaced-backlog.cjs).
const planLayout = [
  { weekday: 'monday', dateKey: DATE_KEYS.monday, sessions: [{ discipline: 'strength', kind: 'push' }] },
  { weekday: 'tuesday', dateKey: DATE_KEYS.tuesday, sessions: [{ discipline: 'run', kind: 'interval', targetAmount: 3 }] },
  { weekday: 'wednesday', dateKey: DATE_KEYS.wednesday, sessions: [{ discipline: 'run', kind: 'easy', targetAmount: 5 }, { discipline: 'swim', kind: 'pace', targetAmount: 1300 }, { discipline: 'strength', kind: 'pull' }] },
  { weekday: 'thursday', dateKey: DATE_KEYS.thursday, sessions: [{ discipline: 'strength', kind: 'explosive' }] },
  { weekday: 'friday', dateKey: DATE_KEYS.friday, sessions: [{ discipline: 'run', kind: 'pace', targetAmount: 5 }] },
  { weekday: 'saturday', dateKey: DATE_KEYS.saturday, sessions: [{ discipline: 'swim', kind: 'technique', targetAmount: 1300 }, { discipline: 'strength', kind: 'legs' }] },
  { weekday: 'sunday', dateKey: DATE_KEYS.sunday, sessions: [{ discipline: 'run', kind: 'long', targetAmount: 9 }, { discipline: 'swim', kind: 'pace', targetAmount: 1300 }] },
];
const activeWeekDisciplines = { run: { km: 22, activityTypeId: 'run1', activityName: 'Running' } };

function runPart1() {
  // --- THE LIVE CASE — a 5km run logged TODAY (Wed), tagged `pace`,
  // claims the EARLIEST unmet same-kind slot (Friday's native Pace —
  // no same-date Pace slot exists on Wednesday itself). Friday's slot
  // is now done, excluded from the "ahead" pool, and — critically —
  // the activity's own 5km is excluded from the generic oldest-missed
  // consumption pool, so it never also pays off Tuesday's Interval. ---
  {
    const sandbox = buildSandbox();
    sandbox.activityEntries = [{ id: 'a1', dateKey: '2026-10-21', activityTypeId: 'run1', distanceKm: 5, kind: 'pace' }];
    const out = sandbox.computeOutstandingByDiscipline(activeWeekDisciplines, '2026-10-21', RHYTHM, planLayout, []);
    if (!out.run || out.run.outstandingKm !== 3) {
      fail('THE EXACT ASSERTION REQUESTED: live case — expected a 3km run backlog (Tuesday interval, not absorbed by the Friday-claiming logged run), got ' + JSON.stringify(out.run));
    } else {
      ok('Live case: tagged pace run claims Friday — Tuesday interval still becomes a 3km backlog');
    }
    if (!out.run || !out.run.missed || out.run.missed[0].kind !== 'interval' || out.run.missed[0].weekday !== 'tuesday' || out.run.missed[0].amount !== 3) {
      fail('Live case: backlog must be NAMED (interval, missed tuesday, 3km), got ' + JSON.stringify(out.run && out.run.missed));
    } else {
      ok('Live case: backlog is named — interval, missed tuesday, 3km');
    }
    // Totals: 5 (logged, claims Friday) + 9 (Sunday long, still ahead) + 3 (backlog) + 5 (Wednesday easy, still ahead) = 22.
    if (out.run && (out.run.doneKm + 3 + 5 + 9 !== 22)) {
      fail('Live case: totals must reconcile to the 22km target (done 5 + Wed easy 5 + Sun long 9 + backlog 3), got doneKm=' + out.run.doneKm);
    } else {
      ok('Live case: 5 (done, claims Fri) + 5 (Wed easy) + 9 (Sun long) + 3 (backlog) = 22, nothing lost or double-counted');
    }
  }

  // --- Same case, UNTAGGED — computeClaimedKindSlots never claims a
  // kind-less activity (its own `if (!s.kind) return` / entries filter
  // upstream), so the OLD flat oldest-first behavior is unchanged: the
  // logged 5km still pays off Tuesday's interval (3km) in full, with
  // 2km to spare and never any run backlog at all. ---
  {
    const sandbox = buildSandbox();
    sandbox.activityEntries = [{ id: 'a1', dateKey: '2026-10-21', activityTypeId: 'run1', distanceKm: 5 }]; // no kind
    const out = sandbox.computeOutstandingByDiscipline(activeWeekDisciplines, '2026-10-21', RHYTHM, planLayout, []);
    if (out.run) {
      fail('THE EXACT ASSERTION REQUESTED: untagged — old flat behavior must be unchanged (no backlog, the logged 5km pays off the 3km interval with room to spare), got ' + JSON.stringify(out.run));
    } else {
      ok('Untagged run: old flat oldest-first behavior unchanged — no backlog at all (backward compatible)');
    }
  }

  // --- A tagged `easy` run on Wednesday claims WEDNESDAY's own native
  // Easy slot (same date AND same kind) -> Tuesday's interval is still
  // untouched by it -> still a 3km backlog. ---
  {
    const sandbox = buildSandbox();
    sandbox.activityEntries = [{ id: 'a1', dateKey: '2026-10-21', activityTypeId: 'run1', distanceKm: 5, kind: 'easy' }];
    const out = sandbox.computeOutstandingByDiscipline(activeWeekDisciplines, '2026-10-21', RHYTHM, planLayout, []);
    if (!out.run || out.run.outstandingKm !== 3 || out.run.missed[0].weekday !== 'tuesday') {
      fail('THE EXACT ASSERTION REQUESTED: tagged easy run claims Wednesday\'s own slot — Tuesday interval must still be a 3km backlog, got ' + JSON.stringify(out.run));
    } else {
      ok('Tagged easy run claims Wednesday\'s own Easy slot — Tuesday interval is still missed, 3km backlog');
    }
  }

  // --- A tagged `interval` run on Wednesday claims TUESDAY's own
  // Interval slot directly (earliest unmet same-kind — no same-date
  // Interval slot exists on Wednesday) -> Tuesday's session is DONE,
  // removed from the past-missed pool entirely -> no backlog for it
  // at all (the only past session was Tuesday's, now claimed). ---
  {
    const sandbox = buildSandbox();
    sandbox.activityEntries = [{ id: 'a1', dateKey: '2026-10-21', activityTypeId: 'run1', distanceKm: 3, kind: 'interval' }];
    const out = sandbox.computeOutstandingByDiscipline(activeWeekDisciplines, '2026-10-21', RHYTHM, planLayout, []);
    if (out.run) {
      fail('THE EXACT ASSERTION REQUESTED: tagged interval run claims Tuesday\'s own slot directly — no backlog must result, got ' + JSON.stringify(out.run));
    } else {
      ok('Tagged interval run claims Tuesday\'s own Interval slot directly — no backlog for it, Wednesday\'s Easy stays pending');
    }
  }

  // --- A previous-week tagged activity never claims anything —
  // week-scoped (computeClaimedKindSlots' own weekMin/weekMax bound,
  // 2e77a95). Outside soFar's own date range anyway, so this also
  // confirms the new claimed-pool logic introduces no new way for a
  // stale activity to leak in. ---
  {
    const sandbox = buildSandbox();
    sandbox.activityEntries = [{ id: 'a0', dateKey: '2026-10-12', activityTypeId: 'run1', distanceKm: 5, kind: 'pace' }]; // the week BEFORE
    const out = sandbox.computeOutstandingByDiscipline(activeWeekDisciplines, '2026-10-21', RHYTHM, planLayout, []);
    if (!out.run || out.run.outstandingKm !== 3 || out.run.doneKm !== 0) {
      fail('THE EXACT ASSERTION REQUESTED: a previous-week tagged activity must never claim anything this week, got ' + JSON.stringify(out.run));
    } else {
      ok('Previous-week tagged activity never claims (week-scoped) — nothing logged this week, full 3km interval backlog, doneKm 0');
    }
  }
}

// ---------------------------------------------------------------
// Part 2 — the real gym.html page, THE LIVE CASE end-to-end.
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

const WEEK_PLAN = {
  targets: { run: { km: 22, activityTypeId: 'run1', activityName: 'Running' } },
  strength: { targetSessions: 3, focus: '' },
  cardio: { interval: { targetSessions: 0, targetMinutes: 0 }, longSession: {}, easyVolume: {} },
  layout: [
    { weekday: 'monday', dateKey: '2026-10-19', sessions: [{ discipline: 'strength', kind: 'push', estMinutes: 45 }] },
    { weekday: 'tuesday', dateKey: '2026-10-20', sessions: [{ discipline: 'run', kind: 'interval', activityTypeId: 'run1', activityName: 'Running', targetAmount: 3, unit: 'km', estMinutes: 20 }] },
    { weekday: 'wednesday', dateKey: '2026-10-21', sessions: [
      { discipline: 'run', kind: 'easy', activityTypeId: 'run1', activityName: 'Running', targetAmount: 5, unit: 'km', estMinutes: 30 },
      { discipline: 'swim', kind: 'pace', activityTypeId: 'swim1', activityName: 'Swimming', targetAmount: 1300, unit: 'm', estMinutes: 33 },
      { discipline: 'strength', kind: 'pull', estMinutes: 45 },
    ] },
    { weekday: 'thursday', dateKey: '2026-10-22', sessions: [{ discipline: 'strength', kind: 'explosive', estMinutes: 45 }] },
    { weekday: 'friday', dateKey: '2026-10-23', sessions: [{ discipline: 'run', kind: 'pace', activityTypeId: 'run1', activityName: 'Running', targetAmount: 5, unit: 'km', estMinutes: 30 }] },
    { weekday: 'saturday', dateKey: '2026-10-24', sessions: [{ discipline: 'swim', kind: 'technique', activityTypeId: 'swim1', activityName: 'Swimming', targetAmount: 1300, unit: 'm', estMinutes: 33 }, { discipline: 'strength', kind: 'legs', estMinutes: 45 }] },
    { weekday: 'sunday', dateKey: '2026-10-25', sessions: [{ discipline: 'run', kind: 'long', activityTypeId: 'run1', activityName: 'Running', targetAmount: 9, unit: 'km', estMinutes: 54 }, { discipline: 'swim', kind: 'pace', activityTypeId: 'swim1', activityName: 'Swimming', targetAmount: 1300, unit: 'm', estMinutes: 33 }] },
  ],
  unplaced: [],
  rationale: 'Week 1.',
};
const RHYTHM_BODY = {
  monday: [{ discipline: 'strength', kind: 'push' }],
  tuesday: [{ discipline: 'run', kind: 'interval' }],
  wednesday: [{ discipline: 'run', kind: 'easy' }, { discipline: 'swim', kind: 'pace' }, { discipline: 'strength', kind: 'pull' }],
  thursday: [{ discipline: 'strength', kind: 'explosive' }],
  friday: [{ discipline: 'run', kind: 'pace' }],
  saturday: [{ discipline: 'swim', kind: 'technique' }, { discipline: 'strength', kind: 'legs' }],
  sunday: [{ discipline: 'run', kind: 'long' }, { discipline: 'swim', kind: 'pace' }],
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
      pinClock(win, '2026-10-21T13:44:00Z'); // the real reported Wednesday, 13:44
      win.localStorage.setItem('dashboard:secret', 'test-secret');
      win.sessionStorage.setItem('dashboard:unlocked', '1');
      win.localStorage.setItem('po_coach_weekly_plan_v1', JSON.stringify({ weekStart: '2026-10-19', plan: WEEK_PLAN, generatedAt: new win.Date().toISOString() }));
      // THE EXACT REPORTED SCENARIO — a 5km run logged today, tagged
      // `pace`, which claims Friday's native Pace slot (not today's
      // own Easy slot — different kind).
      win.localStorage.setItem('po_coach_activities', JSON.stringify([
        { id: 'logged-1', dateKey: '2026-10-21', activityTypeId: 'run1', distanceKm: 5, durationMin: 28, kind: 'pace' },
      ]));
      win.fetch = (url) => {
        const u = String(url);
        let body = { ok: true };
        if (u.includes('resource=plans')) body = { ok: true, plans: [{ id: 'p1', status: 'active', startDate: '2026-10-19', weeklyCheckpoints: [{ weekNumber: 1, weekStartDate: '2026-10-19', disciplines: { run: { km: 22 }, strength: { sessions: 3 } } }] }] };
        else if (u.includes('resource=activity-types')) body = { ok: true, types: [{ id: 'run1', name: 'Running', unit: 'km', unitKind: 'distance', recommendable: true }, { id: 'swim1', name: 'Swimming', unit: 'm', unitKind: 'distance', recommendable: true }] };
        else if (u.includes('resource=restrictions')) body = { ok: true, restrictions: [] };
        else if (u.includes('resource=weekly-rhythm')) body = { ok: true, rhythm: RHYTHM_BODY };
        else if (u.includes('mode=plan')) body = { ok: true, plan: WEEK_PLAN };
        else if (u.includes('mode=today')) body = { ok: true, recommendation: 'Running easy' };
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) });
      };
    },
  });
  const { window } = dom;
  window.console.warn = () => {};
  window.alert = () => {};
  window.addEventListener('error', (e) => consoleErrors.push('UNCAUGHT: ' + (e.error && (e.error.stack || e.error.message) || e.message)));

  await wait(1200);
  window.gatherTodayContext = async () => ({
    availability: {
      configured: true,
      today: { minutes: 90, disciplines: { run: true, bike: true, swim: true, strength: true } },
      thisWeek: ['thursday', 'friday', 'saturday', 'sunday'].map((weekday) => ({ weekday, minutes: 180, disciplines: { run: true, bike: true, swim: true, strength: true } })),
      preferredLongDay: null,
    },
    calendar: { upcoming: [] },
  });
  if (consoleErrors.length) fail('page load produced ' + consoleErrors.length + ' console error(s): ' + consoleErrors.join(' | '));
  else ok('page loaded with zero console errors');

  window.document.getElementById('tpRebalanceBtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await wait(800);

  const stored = JSON.parse(window.localStorage.getItem('po_coach_weekly_plan_v1'));
  const rb = stored.plan.rebalance;
  console.log('\n--- Live case (reported bug, part 2) "Rest of week" text dump ---');
  console.log('moved=' + JSON.stringify(rb.movedNote) + ' skipped=' + JSON.stringify(rb.skippedNote) + ' cantFit=' + JSON.stringify(rb.cantFit) + ' layout=' + JSON.stringify(rb.layout));

  if (!/interval 3km \(missed Tue\)/.test(rb.movedNote)) {
    fail('THE EXACT ASSERTION REQUESTED: Rest of week must show the missed Tuesday interval 3km, named, got moved=' + JSON.stringify(rb.movedNote));
  } else {
    ok('Rest of week names and places the missed Tuesday interval 3km (no longer silently absorbed by the Friday-claiming logged run)');
  }
  const runDays = rb.layout.filter((d) => d.sessions.some((s) => s.discipline === 'run'));
  if (runDays.some((d) => d.dateKey === '2026-10-21' || d.dateKey === '2026-10-23' || d.dateKey === '2026-10-25')) {
    fail('the backlog interval must never land on a day that already has a run (Wed/Fri/Sun), got ' + JSON.stringify(rb.layout));
  } else {
    ok('the backlog interval lands on a run-free day (not Wed/Fri/Sun) — same-discipline exclusion still holds');
  }
  if ((rb.cantFit || []).length) {
    fail('cantFit should be empty — the interval fits this week, got ' + JSON.stringify(rb.cantFit));
  } else {
    ok('cantFit is empty — the interval fits');
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
