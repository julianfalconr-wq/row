// Smoke test — run this before every push touching how a past-day
// session that was UNPLACED at plan-generation time (plan.unplaced)
// is folded into backlog (computeOutstandingByDiscipline/
// pastRhythmSessions in gym.html, or buildFinalLayout in
// api/training.js, which now carries discipline/kind/targetAmount/
// dateKey on each unplaced entry instead of just id/reason).
//
//   node tests/smoke-unplaced-backlog.cjs
//
// Reproduces the EXACT reported bug: Wed 2026-10-21, Tue Run Interval
// 3km never made it into plan.layout at all (unplaced — "does not fit
// Tuesday's available time (0 min)"), so the old pastRhythmSessions
// (layout-only) saw nothing missed and the 22km target vs 19km of
// still-scheduled sessions (Wed/Fri/Sun) never became a 3km backlog.
//
// Part 1: computeOutstandingByDiscipline, extracted verbatim — the
// live case (new-format unplaced entry), an old-format entry with no
// fields at all (id/reason-only, fallback derives it from
// weeklyRhythm), a future-day entry (ignored), and a day already
// covered by a real layout session (never double counted).
// Part 2: the real gym.html page, end-to-end — a text dump of "Rest
// of week" for the live case.
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
function runPart1() {
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
  function extractConst(name) {
    const start = src.indexOf('const ' + name);
    if (start === -1) throw new Error('could not find const ' + name + ' — test extraction markers are stale');
    return src.slice(start, src.indexOf(';', start) + 1);
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
    extractConst('AVAIL_WEEKDAY_NAMES'),
    extractFn('dateKey'),
    extractFn('addDaysKey'),
    extractFn('computeOutstandingByDisciplineLegacy'),
    extractFn('computeOutstandingByDiscipline'),
  ].join('\n');
  vm.runInContext(block + '\nthis.computeOutstandingByDiscipline = computeOutstandingByDiscipline;', sandbox);
  const computeOutstandingByDiscipline = sandbox.computeOutstandingByDiscipline;

  // THE LIVE CASE's own rhythm — Mon Push, Tue Run Interval 3km, Wed
  // Run Easy 5km + Swim Pace 1300 + Pull, Thu Explosive, Fri Run Pace
  // 5km, Sat Swim Technique + Legs, Sun Run Long 9km + Swim Pace.
  // entry.km is the real, user-editable reference-week field
  // (main.html's gs-rhythm-entry-km) — fixed kinds (interval/pace)
  // never change week to week, so it's also this week's real answer.
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
  // THE EXACT LIVE CASE — Tuesday's run interval is NOT in the layout
  // at all (it was unplaced at generation time).
  const planLayout = [
    { weekday: 'monday', dateKey: DATE_KEYS.monday, sessions: [{ discipline: 'strength', kind: 'push' }] },
    { weekday: 'wednesday', dateKey: DATE_KEYS.wednesday, sessions: [{ discipline: 'run', kind: 'easy', targetAmount: 5 }, { discipline: 'swim', kind: 'pace', targetAmount: 1300 }, { discipline: 'strength', kind: 'pull' }] },
    { weekday: 'thursday', dateKey: DATE_KEYS.thursday, sessions: [{ discipline: 'strength', kind: 'explosive' }] },
    { weekday: 'friday', dateKey: DATE_KEYS.friday, sessions: [{ discipline: 'run', kind: 'pace', targetAmount: 5 }] },
    { weekday: 'saturday', dateKey: DATE_KEYS.saturday, sessions: [{ discipline: 'swim', kind: 'technique', targetAmount: 1300 }, { discipline: 'strength', kind: 'legs' }] },
    { weekday: 'sunday', dateKey: DATE_KEYS.sunday, sessions: [{ discipline: 'run', kind: 'long', targetAmount: 9 }, { discipline: 'swim', kind: 'pace', targetAmount: 1300 }] },
  ];
  const activeWeekDisciplines = { run: { km: 22, activityTypeId: 'run1', activityName: 'Running' } };

  // --- Live case — new-format unplaced entry (the fix shipping
  // forward). ---
  {
    const unplaced = [{
      id: 'run-rhythm-1', discipline: 'run', kind: 'interval', targetAmount: 3, unit: 'km', dateKey: '2026-10-20',
      reason: 'interval 3km — does not fit tuesday\'s available time (0 min).',
    }];
    const out = computeOutstandingByDiscipline(activeWeekDisciplines, '2026-10-21', RHYTHM, planLayout, [], unplaced);
    if (!out.run || out.run.outstandingKm !== 3) {
      fail('THE EXACT ASSERTION REQUESTED: live case — expected a 3km run backlog (22 target - 19 still-scheduled), got ' + JSON.stringify(out.run));
    } else {
      ok('Live case: the unplaced Tuesday interval (new-format) produces exactly a 3km run backlog');
    }
    if (!out.run || !out.run.missed || out.run.missed[0].kind !== 'interval' || out.run.missed[0].weekday !== 'tuesday' || out.run.missed[0].amount !== 3) {
      fail('Live case: backlog must be NAMED (interval, missed tuesday, 3km), got ' + JSON.stringify(out.run && out.run.missed));
    } else {
      ok('Live case: backlog is named — interval, missed tuesday, 3km');
    }
  }

  // --- Old-format unplaced entry — no fields at all (id/reason only,
  // exactly as saved before this fix shipped). Fallback must derive
  // discipline (from the id's own "run-rhythm-" prefix) and the date
  // (from the reason text's own weekday mention), then the amount
  // (from weeklyRhythm's own Tuesday interval entry, km:3). ---
  {
    const unplaced = [{ id: 'run-rhythm-1', reason: 'Does not fit tuesday\'s available time (0 min).' }];
    const out = computeOutstandingByDiscipline(activeWeekDisciplines, '2026-10-21', RHYTHM, planLayout, [], unplaced);
    if (!out.run || out.run.outstandingKm !== 3) {
      fail('THE EXACT ASSERTION REQUESTED: old-format entry — fallback must still derive a 3km backlog from weeklyRhythm[tuesday], got ' + JSON.stringify(out.run));
    } else {
      ok('Old-format unplaced entry (no fields): fallback derives interval 3km from weeklyRhythm[tuesday]');
    }
  }

  // --- Old-format entry whose discipline/weekday can't be parsed at
  // all (no recognizable id prefix, no weekday in the reason) — never
  // guessed; simply ignored (not silently turned into a wrong number). ---
  {
    const unplaced = [{ id: 'mystery-session-7', reason: 'Could not be placed.' }];
    const out = computeOutstandingByDiscipline(activeWeekDisciplines, '2026-10-21', RHYTHM, planLayout, [], unplaced);
    if (out.run) {
      fail('an unparseable old-format entry must never be guessed into backlog, got ' + JSON.stringify(out.run));
    } else {
      ok('an unparseable old-format entry (no id prefix, no weekday in reason) is correctly ignored, not guessed');
    }
  }

  // --- Unplaced entry for a FUTURE day -> ignored (not backlog yet). ---
  {
    const unplaced = [{ id: 'run-rhythm-2', discipline: 'run', kind: 'long', targetAmount: 9, unit: 'km', dateKey: '2026-10-25' }]; // Sunday, still ahead
    const out = computeOutstandingByDiscipline(activeWeekDisciplines, '2026-10-21', RHYTHM, planLayout, [], unplaced);
    if (out.run) {
      fail('THE EXACT ASSERTION REQUESTED: a future-day unplaced entry must never become backlog yet, got ' + JSON.stringify(out.run));
    } else {
      ok('a future-day (Sunday) unplaced entry is correctly ignored — not backlog yet');
    }
  }

  // --- Unplaced entry whose day is already covered by a REAL layout
  // session (same discipline, same date) -> never double counted. ---
  {
    const layoutWithTuesday = planLayout.concat([{ weekday: 'tuesday', dateKey: '2026-10-20', sessions: [{ discipline: 'run', kind: 'interval', targetAmount: 3 }] }]);
    const unplaced = [{ id: 'run-rhythm-1', discipline: 'run', kind: 'interval', targetAmount: 3, unit: 'km', dateKey: '2026-10-20' }];
    const out = computeOutstandingByDiscipline(activeWeekDisciplines, '2026-10-21', RHYTHM, layoutWithTuesday, [], unplaced);
    if (!out.run || out.run.missed.length !== 1) {
      fail('THE EXACT ASSERTION REQUESTED: a day already covered by a real layout session must not be double counted, got ' + JSON.stringify(out.run && out.run.missed));
    } else {
      ok('a day already covered by a real layout session is never double counted — exactly 1 missed entry, not 2');
    }
  }

  // --- Swim analogue — a past swim session unplaced at generation
  // time still counts as one missed SESSION (swim needs no amount at
  // all, so there's no "unresolved" case for it). ---
  {
    const swimDisciplines = { swim: { sessions: 3, meters: 1300, activityTypeId: 'swim1', activityName: 'Swimming' } };
    const layoutNoWedSwim = planLayout.map((d) => d.dateKey === '2026-10-21' ? Object.assign({}, d, { sessions: d.sessions.filter((s) => s.discipline !== 'swim') }) : d);
    const unplaced = [{ id: 'swim-rhythm-0', discipline: 'swim', kind: 'pace', targetAmount: 1300, unit: 'm', dateKey: '2026-10-21' }];
    // Checked on Thursday (not Wednesday itself) so Wednesday is
    // unambiguously past regardless of today's-window-open status.
    const out = computeOutstandingByDiscipline(swimDisciplines, '2026-10-22', RHYTHM, layoutNoWedSwim, [], unplaced);
    if (!out.swim || out.swim.outstandingSessions !== 1 || out.swim.missed[0].kind !== 'pace') {
      fail('THE EXACT ASSERTION REQUESTED: swim analogue — an unplaced Wednesday swim session must count as 1 missed session, got ' + JSON.stringify(out.swim));
    } else {
      ok('Swim analogue: an unplaced past swim session counts as 1 missed session, named (pace)');
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

// THE EXACT LIVE CASE'S own week plan — Tuesday's interval is NOT in
// the layout (unplaced at generation time), carrying the new fields.
const WEEK_PLAN = {
  targets: { run: { km: 22, activityTypeId: 'run1', activityName: 'Running' } },
  strength: { targetSessions: 3, focus: '' },
  cardio: { interval: { targetSessions: 0, targetMinutes: 0 }, longSession: {}, easyVolume: {} },
  layout: [
    { weekday: 'monday', dateKey: '2026-10-19', sessions: [{ discipline: 'strength', kind: 'push', estMinutes: 45 }] },
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
  unplaced: [{
    id: 'run-rhythm-1', discipline: 'run', kind: 'interval', targetAmount: 3, unit: 'km', dateKey: '2026-10-20',
    reason: 'interval 3km — does not fit tuesday\'s available time (0 min).',
  }],
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
      pinClock(win, '2026-10-21T12:00:00Z'); // Wednesday, pinned regardless of actual wall-clock date
      win.localStorage.setItem('dashboard:secret', 'test-secret');
      win.sessionStorage.setItem('dashboard:unlocked', '1');
      win.localStorage.setItem('po_coach_weekly_plan_v1', JSON.stringify({ weekStart: '2026-10-19', plan: WEEK_PLAN, generatedAt: new win.Date().toISOString() }));
      win.fetch = (url) => {
        const u = String(url);
        let body = { ok: true };
        if (u.includes('resource=plans')) body = { ok: true, plans: [{ id: 'p1', status: 'active', startDate: '2026-10-19', weeklyCheckpoints: [{ weekNumber: 1, weekStartDate: '2026-10-19', disciplines: { run: { km: 22 }, strength: { sessions: 3 } } }] }] };
        else if (u.includes('resource=activity-types')) body = { ok: true, types: [{ id: 'run1', name: 'Running', unit: 'km', unitKind: 'distance', recommendable: true }, { id: 'swim1', name: 'Swimming', unit: 'm', unitKind: 'distance', recommendable: true }] };
        else if (u.includes('resource=restrictions')) body = { ok: true, restrictions: [] };
        else if (u.includes('resource=weekly-rhythm')) body = { ok: true, rhythm: RHYTHM_BODY };
        else if (u.includes('mode=plan')) body = { ok: true, plan: WEEK_PLAN };
        else if (u.includes('mode=today')) body = { ok: true, recommendation: 'Pull' };
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) });
      };
    },
  });
  const { window } = dom;
  window.console.warn = () => {};
  window.alert = () => {};
  window.addEventListener('error', (e) => consoleErrors.push('UNCAUGHT: ' + (e.error && (e.error.stack || e.error.message) || e.message)));

  await wait(1200);
  // Set AFTER the initial load (not in beforeParse): topbar.js defines
  // its own real window.gatherTodayContext synchronously during page
  // parse, which would otherwise overwrite an earlier stub.
  window.gatherTodayContext = async () => ({
    availability: { configured: true, today: { minutes: 90, disciplines: { run: true, bike: true, swim: true, strength: true } }, thisWeek: [], preferredLongDay: null },
    calendar: { upcoming: [] },
  });
  if (consoleErrors.length) fail('page load produced ' + consoleErrors.length + ' console error(s): ' + consoleErrors.join(' | '));
  else ok('page loaded with zero console errors');

  window.document.getElementById('tpRebalanceBtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await wait(800);

  const stored = JSON.parse(window.localStorage.getItem('po_coach_weekly_plan_v1'));
  const rb = stored.plan.rebalance;
  console.log('\n--- Live case: "Rest of week" text dump ---');
  console.log('moved=' + JSON.stringify(rb.movedNote) + ' skipped=' + JSON.stringify(rb.skippedNote) + ' cantFit=' + JSON.stringify(rb.cantFit) + ' layout=' + JSON.stringify(rb.layout));

  if (!/interval 3km/.test(rb.movedNote) && !rb.layout.some((d) => d.sessions.some((s) => s.discipline === 'run' && s.kind === 'interval'))) {
    fail('THE EXACT ASSERTION REQUESTED: Rest of week must show the missed Tuesday interval 3km placed somewhere, got moved=' + JSON.stringify(rb.movedNote) + ' layout=' + JSON.stringify(rb.layout));
  } else {
    ok('Rest of week shows the missed Tuesday interval 3km placed');
  }
  if (!/Pull \(moved from Wed to Thu\)/.test(rb.movedNote)) {
    fail('Rest of week must still show Pull moved to Thu alongside the interval, got ' + JSON.stringify(rb.movedNote));
  } else {
    ok('Rest of week still shows Pull (moved from Wed to Thu) alongside the recovered interval');
  }
  if (rb.skippedNote !== 'Explosive skipped: weekly strength target covered') {
    fail('Explosive must still be shown as skipped, got ' + JSON.stringify(rb.skippedNote));
  } else {
    ok('Explosive is still shown as skipped');
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
