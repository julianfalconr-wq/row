// Smoke test — run this before every push touching availability vs.
// weekly-rhythm "is this discipline allowed on this day" checks
// (main.html's computeRhythmFlags/defaultAvailabilityDay, gym.html's
// buildWeekCapacity/buildTodayFeasibility, api/training.js's
// buildFinalLayout/buildUnplaceableSeed).
//
//   node tests/smoke-availability-rhythm-allowed.cjs
//
// Reproduces the EXACT reported bug (main.html's rhythm grid flagging
// "<discipline> isn't an allowed discipline on <day>" on every day
// despite a fully-configured availability template) and asserts the
// fix's actual rule end to end: a discipline the weekly rhythm places
// on a day counts as allowed THAT day regardless of the template; the
// template still supplies the minutes budget; a day over its minutes
// budget still warns; no rhythm configured leaves the template's own
// disciplines fully in control (unchanged behavior); and gym.html's
// real Today's-session request reflects the same rule (a day the
// template disallows entirely still returns the rhythm's own pick,
// never overridden/warned, because the real network request's own
// feasibility.allowedDisciplines already says true for it).
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROW_DIR = path.join(__dirname, '..');
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

let failures = 0;
function fail(msg) { failures++; console.log('FAIL:', msg); }
function ok(msg) { console.log('PASS:', msg); }

// ---------------------------------------------------------------
// Part 1 — main.html's weekly-rhythm settings grid
// ---------------------------------------------------------------
function buildMainHtml() {
  let html = fs.readFileSync(path.join(ROW_DIR, 'main.html'), 'utf8');
  const esc = (s) => s.replace(/<\/script/gi, '<\\/script');
  html = html.replace('<script src="lock.js"></script>', '<script>' + esc(fs.readFileSync(path.join(ROW_DIR, 'lock.js'), 'utf8')) + '</script>');
  html = html.replace('<script src="daylib.js"></script>', '<script>' + esc(fs.readFileSync(path.join(ROW_DIR, 'daylib.js'), 'utf8')) + '</script>');
  html = html.replace('<script src="topbar.js" defer></script>', '<script>' + esc(fs.readFileSync(path.join(ROW_DIR, 'topbar.js'), 'utf8')) + '</script>');
  html = html.replace('<script src="sync.js" defer></script>', '<script>' + esc(fs.readFileSync(path.join(ROW_DIR, 'sync.js'), 'utf8')) + '</script>');
  html = html.replace('<script src="score-lib.js"></script>', '<script>' + esc(fs.readFileSync(path.join(ROW_DIR, 'score-lib.js'), 'utf8')) + '</script>');
  html = html.replace('<script src="cronometer-lib.js" defer></script>', '<script>window.CronoLib = undefined;</script>');
  html = html.replace(/<script src="https:\/\/unpkg\.com\/lucide[^"]*"[^>]*><\/script>/, '<script>window.lucide = { createIcons: function(){} };</script>');
  const supabaseStub = (
    '<script>window.supabase = { createClient: function() {' +
    'var chain = { select: function(){ return chain; }, eq: function(){ return chain; }, maybeSingle: function(){ return Promise.resolve({ data: null, error: null }); }, upsert: function(){ return Promise.resolve({ error: null }); } };' +
    'var channel = { on: function(){ return channel; }, subscribe: function(){ return channel; } };' +
    'return { auth: {}, from: function(){ return chain; }, channel: function(){ return channel; } }; } };</script>'
  );
  html = html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js[^"]*"><\/script>/, supabaseStub);
  return html;
}

// Monday: template disallows EVERY discipline, no minutes cap.
// Tuesday: template allows everything, but only a 20min budget — too
// small for a 45min strength session (RHYTHM_KIND_EST_MINUTES.strength).
const TEMPLATE = {
  preferredLongDay: null,
  monday: { minutes: null, disciplines: { swim: false, bike: false, run: false, strength: false } },
  tuesday: { minutes: 20, disciplines: { swim: true, bike: true, run: true, strength: true } },
  wednesday: { minutes: null, disciplines: { swim: true, bike: true, run: true, strength: true } },
  thursday: { minutes: null, disciplines: { swim: true, bike: true, run: true, strength: true } },
  friday: { minutes: null, disciplines: { swim: true, bike: true, run: true, strength: true } },
  saturday: { minutes: null, disciplines: { swim: true, bike: true, run: true, strength: true } },
  sunday: { minutes: null, disciplines: { swim: true, bike: true, run: true, strength: true } },
};
const RHYTHM = {
  monday: [{ discipline: 'strength', kind: 'push' }], // placed despite Monday disallowing everything
  tuesday: [{ discipline: 'strength', kind: 'pull' }], // allowed, but 45min > the 20min budget
};

async function runMainHtmlCheck() {
  const html = buildMainHtml();
  const consoleErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => consoleErrors.push('JSDOM: ' + (e.stack || e.message)));
  virtualConsole.on('error', (...args) => consoleErrors.push(args.map(String).join(' ')));
  const dom = new JSDOM(html, {
    url: 'https://row.test/main.html', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(win) {
      win.localStorage.setItem('dashboard:secret', 'test-secret');
      win.sessionStorage.setItem('dashboard:unlocked', '1');
    },
  });
  const { window } = dom;
  window.console.warn = () => {};
  window.alert = () => {};
  window.confirm = () => true;
  window.addEventListener('error', (e) => consoleErrors.push('UNCAUGHT: ' + (e.error && (e.error.stack || e.error.message) || e.message)));
  window.fetch = (url) => {
    const u = String(url);
    let body = { ok: true };
    if (u.includes('resource=plans')) body = { ok: true, plans: [] };
    else if (u.includes('resource=activity-types')) body = { ok: true, types: [] };
    else if (u.includes('resource=restrictions')) body = { ok: true, restrictions: [] };
    else if (u.includes('resource=training-availability-override')) body = { ok: true, override: null };
    else if (u.includes('resource=training-availability')) body = { ok: true, template: TEMPLATE };
    else if (u.includes('resource=weekly-rhythm')) body = { ok: true, rhythm: RHYTHM };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) });
  };

  await wait(1200);
  if (consoleErrors.length) fail('main.html page load produced ' + consoleErrors.length + ' console error(s): ' + consoleErrors.join(' | '));
  else ok('main.html page loaded with zero console errors');

  window.document.getElementById('generalSettingsGearBtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await wait(600);

  const gridText = window.document.getElementById('gsRhythmGrid').textContent;
  if (/isn't an allowed discipline/i.test(gridText)) {
    fail('THE EXACT ASSERTION REQUESTED: no "isn\'t an allowed discipline" warning may appear once a discipline is rhythm-placed, got grid text: ' + JSON.stringify(gridText));
  } else {
    ok('no "isn\'t an allowed discipline" warning anywhere — Monday (template disallows everything) and Tuesday (template allows it) both show no such warning for their rhythm-placed strength session');
  }

  if (/exceeds the 20 min budget/i.test(gridText)) {
    ok('Tuesday\'s minutes-exceeded warning still renders (45min strength > 20min budget) — minutes checks are unaffected by the discipline-allowed fix');
  } else {
    fail('THE EXACT ASSERTION REQUESTED: a day over its minutes budget must still warn, got grid text: ' + JSON.stringify(gridText));
  }

  if (consoleErrors.length) fail('main.html: console/script errors appeared during the click flow (see above)');
}

// ---------------------------------------------------------------
// Part 2 — gym.html's real Today's-session request + recommendation
// ---------------------------------------------------------------
function buildGymHtml() {
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

// Monday: rhythm = Strength(Push) only. The template disallows
// strength EVERY day (not just Monday) — the strongest version of
// the reported scenario: nothing but the rhythm itself says Monday's
// Push is fine.
const GYM_WEEK_PLAN = {
  targets: { run: { km: 20, activityTypeId: 'run1', activityName: 'Running' } },
  strength: { targetSessions: 3, focus: '' },
  cardio: { interval: { targetSessions: 0, targetMinutes: 0 }, longSession: {}, easyVolume: {} },
  layout: [{ weekday: 'monday', dateKey: '2026-10-12', sessions: [{ discipline: 'strength', kind: 'push', estMinutes: 45 }] }],
  unplaced: [], rationale: 'Week 1.',
};

async function runGymHtmlCheck() {
  const html = buildGymHtml();
  const consoleErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => consoleErrors.push('JSDOM: ' + (e.stack || e.message)));
  virtualConsole.on('error', (...args) => consoleErrors.push(args.map(String).join(' ')));
  const dom = new JSDOM(html, {
    url: 'https://row.test/gym.html', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(win) {
      pinClock(win, '2026-10-12T12:00:00Z'); // a real Monday, pinned regardless of actual wall-clock date
      win.localStorage.setItem('dashboard:secret', 'test-secret');
      win.sessionStorage.setItem('dashboard:unlocked', '1');
      win.localStorage.setItem('po_coach_weekly_plan_v1', JSON.stringify({ weekStart: '2026-10-12', plan: GYM_WEEK_PLAN, generatedAt: new win.Date().toISOString() }));
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
    if (u.includes('resource=plans')) body = { ok: true, plans: [{ id: 'p1', status: 'active', startDate: '2026-10-12', weeklyCheckpoints: [{ weekNumber: 1, weekStartDate: '2026-10-12', disciplines: { run: { km: 20 }, strength: { sessions: 3 } } }] }] };
    else if (u.includes('resource=activity-types')) body = { ok: true, types: [{ id: 'run1', name: 'Running', unit: 'km', unitKind: 'distance', recommendable: true }] };
    else if (u.includes('resource=restrictions')) body = { ok: true, restrictions: [] };
    else if (u.includes('resource=weekly-rhythm')) body = { ok: true, rhythm: { monday: [{ discipline: 'strength', kind: 'push' }] } };
    else if (u.includes('mode=plan')) body = { ok: true, plan: GYM_WEEK_PLAN };
    else if (u.includes('mode=today')) body = { ok: true, recommendation: 'Push' };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) });
  };

  await wait(1200);
  // Template disallows strength EVERY day — the strongest version of
  // the reported scenario: nothing but the rhythm's own Monday
  // placement says strength is fine today.
  window.gatherTodayContext = async () => ({
    availability: {
      configured: true,
      today: { minutes: 90, disciplines: { run: true, bike: true, swim: true, strength: false } },
      thisWeek: ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].map((weekday) => ({ weekday, minutes: 90, disciplines: { run: true, bike: true, swim: true, strength: false } })),
      preferredLongDay: null,
    },
    calendar: { upcoming: [] },
  });

  if (consoleErrors.length) fail('gym.html page load produced ' + consoleErrors.length + ' console error(s): ' + consoleErrors.join(' | '));
  else ok('gym.html page loaded with zero console errors');

  window.document.getElementById('ttRefreshBtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await wait(800);

  const todayReq = fetchLog.find((f) => f.url.includes('mode=today'));
  if (!todayReq) {
    fail('no mode=today request fired at all');
  } else {
    const payload = JSON.parse(todayReq.body);
    const allowed = payload.feasibility && payload.feasibility.allowedDisciplines;
    if (!allowed || allowed.strength !== true) {
      fail('THE EXACT ASSERTION REQUESTED: feasibility.allowedDisciplines.strength must be true for Monday (the rhythm places Push there) even though the template disallows strength every day, got ' + JSON.stringify(allowed));
    } else {
      ok('mode=today request\'s feasibility.allowedDisciplines.strength is true on Monday despite the template disallowing strength every day (the rhythm\'s own placement wins)');
    }
  }

  const recommendation = window.document.getElementById('ttText').textContent;
  if (recommendation !== 'Push') {
    fail('THE EXACT ASSERTION REQUESTED: Today\'s session must return "Push" unmodified (no backstop override/warning), got ' + JSON.stringify(recommendation));
  } else {
    ok('Today\'s session returns "Push" unmodified — no backstop override or "not allowed" contradiction');
  }

  if (consoleErrors.length) fail('gym.html: console/script errors appeared during the click flow (see above)');
}

// ---------------------------------------------------------------
// Part 3 — api/training.js's buildFinalLayout/buildUnplaceableSeed
// (the server-side layout) — extracted-function checks against the
// real source.
// ---------------------------------------------------------------
function runServerLayoutChecks() {
  const vm = require('vm');
  const src = fs.readFileSync(path.join(ROW_DIR, 'api', 'training.js'), 'utf8');
  function extractFn(name) {
    const start = src.indexOf('function ' + name + '(');
    const braceStart = src.indexOf('{', start);
    let depth = 0, end = -1;
    for (let j = braceStart; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
    }
    return src.slice(start, end);
  }
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(
    [extractFn('sanitizeAssignments'), 'const HARD_ADJACENT_MS = 86400000;', extractFn('buildFinalLayout'), extractFn('buildUnplaceableSeed')].join('\n') +
    '\nthis.buildFinalLayout = buildFinalLayout; this.buildUnplaceableSeed = buildUnplaceableSeed;',
    sandbox
  );
  const buildFinalLayout = sandbox.buildFinalLayout;
  const buildUnplaceableSeed = sandbox.buildUnplaceableSeed;

  const perDay = [{ weekday: 'monday', dateKey: '2026-10-12', availableMin: 90, allowedDisciplines: { strength: false, run: true, bike: true, swim: true } }];

  // A rhythm-fixed session (carries its own dateKey) must be placed
  // even though the day's allowedDisciplines says false.
  const rhythmFixedSession = { id: 'strength-rhythm-0', discipline: 'strength', kind: 'push', estMinutes: 45, dateKey: '2026-10-12' };
  let result = buildFinalLayout([{ id: 'strength-rhythm-0', dateKey: '2026-10-12' }], [rhythmFixedSession], perDay, []);
  if (result.unplaced.some((u) => u.id === 'strength-rhythm-0')) {
    fail('a rhythm-fixed session must never be rejected for "not allowed" on its own day, got unplaced: ' + JSON.stringify(result.unplaced));
  } else if (!result.layout.some((d) => (d.sessions || []).some((s) => s.id === 'strength-rhythm-0'))) {
    fail('a rhythm-fixed session must be placed on its own day, got layout: ' + JSON.stringify(result.layout));
  } else {
    ok('a rhythm-fixed session (its own dateKey) is placed even though the day\'s allowedDisciplines says false');
  }

  // No rhythm => unchanged behavior: a MODEL-placed session (no
  // dateKey) on a disallowed day must still be rejected, exactly as
  // before this fix.
  const modelPlacedSession = { id: 'strength-model-0', discipline: 'strength', kind: 'auto', estMinutes: 45 };
  result = buildFinalLayout([{ id: 'strength-model-0', dateKey: '2026-10-12' }], [modelPlacedSession], perDay, []);
  if (!result.unplaced.some((u) => u.id === 'strength-model-0')) {
    fail('no rhythm (a plain model-placed session) must still be rejected on a disallowed day — unchanged behavior, got layout: ' + JSON.stringify(result.layout));
  } else {
    ok('no rhythm => unchanged behavior: a model-placed (non-rhythm) session is still rejected on a disallowed day');
  }

  // buildUnplaceableSeed: a discipline no day allows is still globally
  // seeded as unplaceable UNLESS a rhythm-fixed session for it already
  // exists.
  const capacityAllNo = { configured: true, perDay: [{ weekday: 'monday', dateKey: '2026-10-12', allowedDisciplines: { strength: false } }] };
  const targets = { strength: { sessions: 1 } };
  let seed = buildUnplaceableSeed(targets, capacityAllNo, []);
  if (!seed.some((s) => s.id === 'strength')) fail('no rhythm => unchanged behavior: a discipline no day allows must still be seeded as globally unplaceable, got ' + JSON.stringify(seed));
  else ok('no rhythm => unchanged behavior: a discipline no day allows (and no rhythm-fixed session for it) is still seeded as globally unplaceable');

  seed = buildUnplaceableSeed(targets, capacityAllNo, [rhythmFixedSession]);
  if (seed.some((s) => s.id === 'strength')) fail('a discipline with an already-rhythm-fixed session must NOT be seeded as globally unplaceable even if the template disallows it every day, got ' + JSON.stringify(seed));
  else ok('a discipline with an already-rhythm-fixed session is never seeded as globally unplaceable, even if the template disallows it every day');
}

async function main() {
  await runMainHtmlCheck();
  await runGymHtmlCheck();
  runServerLayoutChecks();
  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
}

main();
