// Smoke test — run this before every push touching the rebalancer's
// backlog definition (computeOutstandingByDiscipline in gym.html) or
// the server-side layout's placement of a rhythm-fixed past-day
// session (buildFinalLayout in api/training.js).
//
//   node tests/smoke-rebalance-backlog-named.cjs
//
// Reproduces the EXACT reported bug: Tuesday, rhythm = Tue interval,
// Wed easy+swim pace+Pull, Thu Explosive, Fri pace, Sat swim
// technique+Legs, Sun long+swim pace, Mon Push (missed, past,
// unlogged). Strength target is 3 and Wed Pull + Thu Explosive + Sat
// Legs are still ahead (3, already meeting the target), so Monday's
// missed Push must NOT become backlog — asserts the corrected
// definition (backlog = min(missed, max(0, remaining - ahead)))
// against all three of the report's own worked examples, extracted
// from the real function; and asserts on the real gym.html page that
// the generic, unnamed "Could not be placed"/"0 of 1 can fit this
// week" lines are gone.
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
function runExtractedChecks() {
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
    thisWeekMondayKey: () => '2026-10-12',
    resolveTodayBedtimeMs: () => Date.now() + 1000000, // today's window hasn't closed
    window: { PoCoach: { getDoneDays: () => ({}) } },
  };
  vm.createContext(sandbox);
  vm.runInContext(daylibSrc, sandbox);
  sandbox.DayLib = sandbox.window.DayLib;
  const block = [extractFn('dateKey'), extractFn('addDaysKey'), extractFn('computeOutstandingByDisciplineLegacy'), extractFn('computeOutstandingByDiscipline')].join('\n');
  vm.runInContext(block + '\nthis.computeOutstandingByDiscipline = computeOutstandingByDiscipline;', sandbox);
  const computeOutstandingByDiscipline = sandbox.computeOutstandingByDiscipline;

  const RHYTHM = {
    monday: [{ discipline: 'strength', kind: 'push' }],
    tuesday: [{ discipline: 'run', kind: 'interval' }],
    wednesday: [{ discipline: 'run', kind: 'easy' }, { discipline: 'swim', kind: 'pace' }, { discipline: 'strength', kind: 'pull' }],
    thursday: [{ discipline: 'strength', kind: 'explosive' }],
    friday: [{ discipline: 'run', kind: 'pace' }],
    saturday: [{ discipline: 'swim', kind: 'technique' }, { discipline: 'strength', kind: 'legs' }],
    sunday: [{ discipline: 'run', kind: 'long' }, { discipline: 'swim', kind: 'pace' }],
  };
  const DATE_KEYS = { monday: '2026-10-12', tuesday: '2026-10-13', wednesday: '2026-10-14', thursday: '2026-10-15', friday: '2026-10-16', saturday: '2026-10-17', sunday: '2026-10-18' };
  function layoutFor(rhythm) {
    return Object.keys(rhythm).map((wd) => ({
      weekday: wd, dateKey: DATE_KEYS[wd],
      sessions: rhythm[wd].map((e) => ({
        discipline: e.discipline, kind: e.kind,
        targetAmount: e.discipline === 'run' ? ({ interval: 3, easy: 5, pace: 5, long: 7 }[e.kind] || 0) : null,
      })),
    }));
  }
  const planLayout = layoutFor(RHYTHM);
  const activeWeekDisciplines = {
    run: { km: 20, activityTypeId: 'run1', activityName: 'Running' },
    swim: { sessions: 3, meters: 1000, activityTypeId: 'swim1', activityName: 'Swimming' },
    strength: { sessions: 3 },
  };

  // Scenario A (the exact reported bug) — Tuesday, Monday's Push
  // missed, but strength's 3 ahead sessions (Wed Pull, Thu Explosive,
  // Sat Legs) already meet the target of 3 -- NOT backlog.
  let out = computeOutstandingByDiscipline(activeWeekDisciplines, '2026-10-13', RHYTHM, planLayout, [{ dayType: 'Push', weekday: 'Monday' }]);
  if (Object.keys(out).length) fail('Tuesday scenario: outstanding must be completely empty (ahead covers the target), got ' + JSON.stringify(out));
  else ok('Tuesday scenario: no backlog at all — ahead (Wed Pull + Thu Explosive + Sat Legs = 3) already meets the strength target (3)');

  // Scenario B — Wednesday, Tuesday's missed interval (3km unlogged),
  // run's ahead (Wed easy 5 + Fri pace 5 + Sun long 7 = 17) falls
  // short of the 20km target by exactly 3 -- backlog = 3km, named.
  out = computeOutstandingByDiscipline(activeWeekDisciplines, '2026-10-14', RHYTHM, planLayout, []);
  if (!out.run || out.run.outstandingKm !== 3) fail('Wednesday scenario: expected a 3km run backlog, got ' + JSON.stringify(out.run));
  else ok('Wednesday scenario: run backlog is exactly 3km (ahead 17 falls short of the 20km target by 3, capped at the missed amount)');
  if (!out.run || !Array.isArray(out.run.missed) || out.run.missed[0].kind !== 'interval' || out.run.missed[0].weekday !== 'tuesday' || out.run.missed[0].amount !== 3) {
    fail('Wednesday scenario: backlog must be NAMED (kind/weekday/amount of the original missed session), got ' + JSON.stringify(out.run && out.run.missed));
  } else ok('Wednesday scenario: backlog is named — interval, missed tuesday, 3km');

  // Scenario C — strength target 3, only 2 sessions ahead (no Sat
  // Legs this time), Monday's Push missed -- shortfall = 1, backlog =
  // min(missed=1, shortfall=1) = 1, named.
  const rhythmC = Object.assign({}, RHYTHM, { saturday: [{ discipline: 'swim', kind: 'technique' }] });
  const planLayoutC = planLayout.map((d) => d.weekday === 'saturday' ? Object.assign({}, d, { sessions: d.sessions.filter((s) => s.discipline !== 'strength') }) : d);
  out = computeOutstandingByDiscipline(activeWeekDisciplines, '2026-10-13', rhythmC, planLayoutC, [{ dayType: 'Push', weekday: 'Monday' }]);
  if (!out.strength || out.strength.outstandingSessions !== 1) fail('strength-2-ahead scenario: expected a backlog of exactly 1 session, got ' + JSON.stringify(out.strength));
  else ok('strength-2-ahead scenario: backlog is exactly 1 session (target 3, only 2 ahead, shortfall 1)');
  if (!out.strength || !Array.isArray(out.strength.missed) || out.strength.missed[0].dayType !== 'Push' || out.strength.missed[0].weekday !== 'Monday') {
    fail('strength-2-ahead scenario: backlog must be NAMED (day-type/weekday), got ' + JSON.stringify(out.strength && out.strength.missed));
  } else ok('strength-2-ahead scenario: backlog is named — Push, missed Monday');

  // Scenario D — no rhythm at all => computeOutstandingByDisciplineLegacy,
  // completely unaffected by any of the above.
  out = computeOutstandingByDiscipline(activeWeekDisciplines, '2026-10-13', {}, [], []);
  if (!out.run || out.run.outstandingKm !== 20) fail('no rhythm => unchanged behavior: expected the legacy whole-target-minus-logged run backlog (20km), got ' + JSON.stringify(out.run));
  else ok('no rhythm => unchanged behavior: falls back to computeOutstandingByDisciplineLegacy exactly as before (20km, the whole target, nothing logged)');
}

// ---------------------------------------------------------------
// Part 2 — the real gym.html page, the exact reported scenario.
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

async function runRealPageCheck() {
  const html = buildHtml();
  const consoleErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => consoleErrors.push('JSDOM: ' + (e.stack || e.message)));
  virtualConsole.on('error', (...args) => consoleErrors.push(args.map(String).join(' ')));
  const dom = new JSDOM(html, {
    url: 'https://row.test/gym.html', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(win) {
      pinClock(win, '2026-10-13T12:00:00Z'); // Tuesday, pinned regardless of actual wall-clock date
      win.localStorage.setItem('dashboard:secret', 'test-secret');
      win.sessionStorage.setItem('dashboard:unlocked', '1');
      win.localStorage.setItem('po_coach_weekly_plan_v1', JSON.stringify({ weekStart: '2026-10-12', plan: WEEK_PLAN, generatedAt: new win.Date().toISOString() }));
    },
  });
  const { window } = dom;
  window.console.warn = () => {};
  window.alert = () => {};
  window.addEventListener('error', (e) => consoleErrors.push('UNCAUGHT: ' + (e.error && (e.error.stack || e.error.message) || e.message)));

  const RHYTHM_BODY = {
    monday: [{ discipline: 'strength', kind: 'push' }],
    tuesday: [{ discipline: 'run', kind: 'interval' }],
    wednesday: [{ discipline: 'run', kind: 'easy' }, { discipline: 'swim', kind: 'pace' }, { discipline: 'strength', kind: 'pull' }],
    thursday: [{ discipline: 'strength', kind: 'explosive' }],
    friday: [{ discipline: 'run', kind: 'pace' }],
    saturday: [{ discipline: 'swim', kind: 'technique' }, { discipline: 'strength', kind: 'legs' }],
    sunday: [{ discipline: 'run', kind: 'long' }, { discipline: 'swim', kind: 'pace' }],
  };
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
    else if (u.includes('mode=today')) body = { ok: true, recommendation: 'Running interval' };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) });
  };

  await wait(1200);
  window.gatherTodayContext = async () => ({
    availability: { configured: true, today: { minutes: 90, disciplines: { run: true, bike: true, swim: true, strength: true } }, thisWeek: [], preferredLongDay: null },
    calendar: { upcoming: [] },
  });

  if (consoleErrors.length) fail('page load produced ' + consoleErrors.length + ' console error(s): ' + consoleErrors.join(' | '));
  else ok('page loaded with zero console errors');

  const beforeRebalanceClick = fetchLog.length;
  window.document.getElementById('tpRebalanceBtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await wait(800);

  const rebalanceText = window.document.getElementById('tpRebalanceSection').textContent;
  if (/0 of 1 can fit|could not be placed/i.test(rebalanceText)) {
    fail('THE EXACT ASSERTION REQUESTED: the Tuesday scenario must produce no "can\'t fit" lines and no "0 of 1", got rebalance section text: ' + JSON.stringify(rebalanceText));
  } else {
    ok('Tuesday scenario: no "0 of 1 can fit"/"could not be placed" lines in the Rebalance section');
  }

  const layoutText = window.document.getElementById('tpLayoutSection') ? window.document.getElementById('tpLayoutSection').textContent : '';
  if (/could not be placed/i.test(layoutText)) {
    fail('Monday\'s Push must not appear as an unnamed "could not be placed" line in THIS WEEK\'S LAYOUT, got: ' + JSON.stringify(layoutText));
  } else {
    ok('THIS WEEK\'S LAYOUT shows no generic "could not be placed" text for Monday\'s Push');
  }

  const beforeTodayClick = fetchLog.length;
  window.document.getElementById('ttRefreshBtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await wait(800);
  const todayReq = fetchLog.slice(beforeTodayClick).find((f) => f.url.includes('mode=today'));
  if (!todayReq) {
    fail('no mode=today request fired at all');
  } else {
    const payload = JSON.parse(todayReq.body);
    const layoutSession = payload.todayLayoutEntry && payload.todayLayoutEntry.sessions && payload.todayLayoutEntry.sessions[0];
    if (!layoutSession || layoutSession.discipline !== 'run' || layoutSession.targetAmount !== 3) {
      fail('THE EXACT ASSERTION REQUESTED: mode=today request must send todayLayoutEntry with today\'s real sized session (Run interval 3km), got ' + JSON.stringify(payload.todayLayoutEntry));
    } else {
      ok('mode=today request sends todayLayoutEntry with today\'s real sized session (run interval, 3km)');
    }
  }

  if (consoleErrors.length) fail('console/script errors appeared during the click flow (see above)');
}

async function main() {
  runExtractedChecks();
  await runRealPageCheck();
  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
}

main();
