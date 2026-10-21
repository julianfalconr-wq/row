// Smoke test — run this before every push touching Today's/Tomorrow's
// session recommendation when a weekly rhythm is configured
// (applyRhythmBackstop / buildTodaySystemPrompt / buildTodayFeasibility
// in api/training.js and gym.html).
//
//   node tests/smoke-today-rhythm-backstop.cjs
//
// Reproduces the EXACT reported bug: Monday rhythm = Strength (Push)
// only, first run is Tuesday, nothing logged. The model combined the
// correct Push pick with an invented "Running interval" (fed by the
// legacy weekPlan.cardio.interval slot, which has a nonzero WEEKLY
// target with no idea which day it belongs on). Checks both layers of
// the fix: (1) applyRhythmBackstop strips any "+"-joined clause that
// isn't one of today's real rhythm entries or a code-computed
// rebalanceToday session, and (2) gym.html's real page never sends a
// run/interval candidate in feasibility.candidates for mode=today when
// a rhythm is configured but today's own rhythm has no cardio entry.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROW_DIR = path.join(__dirname, '..');
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
function extractConst(name) {
  const start = src.indexOf('const ' + name);
  return src.slice(start, src.indexOf(';', start) + 1);
}

const block = [
  extractConst('BACKSTOP_DISCIPLINE_PATTERNS'),
  extractFn('describeRhythmEntryForToday'),
  extractFn('clauseMatchesDescriptor'),
  extractFn('buildAllowedRhythmDescriptors'),
  extractFn('stripUnvalidatedRhythmClauses'),
  extractFn('applyRhythmBackstop'),
  extractConst('RHYTHM_HARD_KINDS'),
  extractConst('REST_TEXT_RE'),
  extractFn('describeRebalanceTodayPick'),
  extractFn('restrictedScopeSet'),
  extractFn('buildExhaustiveTodaySessionDescriptors'),
  extractFn('ensureExhaustiveTodaySessions'),
].join('\n');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(block + '\nthis.applyRhythmBackstop = applyRhythmBackstop; this.ensureExhaustiveTodaySessions = ensureExhaustiveTodaySessions;', sandbox);
const applyRhythmBackstop = sandbox.applyRhythmBackstop;
const ensureExhaustiveTodaySessions = sandbox.ensureExhaustiveTodaySessions;
// Same two-step pipeline the mode=today handler itself runs (api/
// training.js's one call site): the backstop first (anti-invention,
// unchanged), then this feature strictly after it (exhaustiveness,
// append-only).
function todayTitle(recommendation, rhythmForDay, rebalanceToday, todayLayoutEntry) {
  const backstopped = applyRhythmBackstop(recommendation, rhythmForDay, { configured: false }, [], null, null, rebalanceToday, todayLayoutEntry);
  return ensureExhaustiveTodaySessions(backstopped, rhythmForDay, rebalanceToday, todayLayoutEntry);
}

let failures = 0;
function fail(msg) { failures++; console.log('FAIL:', msg); }
function ok(msg) { console.log('PASS:', msg); }

const rhythmMonday = [{ discipline: 'strength', kind: 'push' }];
const rhythmTuesday = [{ discipline: 'run', kind: 'interval' }];

let r = applyRhythmBackstop('Push', rhythmMonday, { configured: false }, [], null, null, null);
if (r !== 'Push') fail('Monday Push-only, nothing logged: expected pick = Push only, got ' + JSON.stringify(r));
else ok('Monday Push-only, nothing logged: pick = Push only');

// BUG FIX (reported) — the primary entry's own clause is always
// replaced with describeRhythmEntryForToday's canonical phrasing
// ("Run interval", capitalized discipline name) rather than kept
// verbatim as the model wrote it ("Running interval") — this is what
// guarantees the real size shows up below, independent of whatever
// the model happened to phrase.
r = applyRhythmBackstop('Running interval', rhythmTuesday, { configured: false }, [], null, null, null);
if (r !== 'Run interval') fail('Tuesday run entry: expected pick = that run only (canonical "Run interval"), got ' + JSON.stringify(r));
else ok('Tuesday run entry: pick = that run only ("Run interval")');

// Point 4 (reported) — Today's session title shows the SIZE of the
// rhythm entry, taken from todayLayoutEntry (today's real,
// already-sized plan.layout session), never from the model's own
// (untold, untrustworthy) guess.
const todayLayoutEntryTue = { sessions: [{ discipline: 'run', targetAmount: 3, unit: 'km' }] };
r = applyRhythmBackstop('Running interval', rhythmTuesday, { configured: false }, [], null, null, null, todayLayoutEntryTue);
if (r !== 'Run interval 3km') fail('THE EXACT ASSERTION REQUESTED: today\'s session title must show the rhythm entry\'s real size, got ' + JSON.stringify(r));
else ok('today\'s session title shows the real size: "Run interval 3km"');

r = applyRhythmBackstop('Push + Running interval', rhythmMonday, { configured: false }, [], null, null, null);
const mainClause = r.split(' (dropped')[0];
if (/interval/i.test(mainClause) || mainClause !== 'Push') fail('model returns "Push + Running interval": backstop must strip the interval, got ' + JSON.stringify(r));
else ok('model returns "Push + Running interval": backstop strips the interval -> ' + JSON.stringify(r));

r = applyRhythmBackstop('Push + Running interval', [], { configured: false }, [], null, null, null);
if (r !== 'Push + Running interval') fail('no rhythm => must be unchanged, got ' + JSON.stringify(r));
else ok('no rhythm => unchanged behavior');

const rebalanceToday = { sessions: [{ discipline: 'run', kind: 'easy', targetAmount: 6, unit: 'km', activityName: 'Running' }] };
r = applyRhythmBackstop('Push + Running easy 6km', rhythmMonday, { configured: false }, [], null, null, rebalanceToday);
if (r !== 'Push + Running easy 6km') fail('a real rebalanceToday catch-up session must survive untouched, got ' + JSON.stringify(r));
else ok('a real rebalanceToday catch-up session survives untouched: ' + JSON.stringify(r));

// ---- exhaustive title (FEATURE, reported) — the title must list
// every session in today's layout entry, same sources Fueling reads. ----
// THE EXACT LIVE CASE: Wed rhythm = Pull (strength, primary) + Run
// easy + Swim pace; Pull is evicted by a missed Monday Push catch-up
// (strengthContext.missedDayTypes), so the backstop's own code-
// checkable "hasMissedCatchUp" bypass trusts the model's text as-is —
// "Push (missed Monday) + Swim pace 1300m" — leaving Run entirely
// unmentioned. ensureExhaustiveTodaySessions must append it.
const rhythmWedLive = [{ discipline: 'strength', kind: 'pull' }, { discipline: 'run', kind: 'easy' }, { discipline: 'swim', kind: 'pace' }];
const rebalanceTodayLive = { sessions: [{ discipline: 'strength', kind: 'auto', dayType: 'Push', weekday: 'Monday' }] };
const todayLayoutEntryLive = { sessions: [{ discipline: 'run', targetAmount: 5, unit: 'km' }, { discipline: 'swim', targetAmount: 1300, unit: 'm' }] };
const strengthContextLive = { missedDayTypes: [{ dayType: 'Push', weekday: 'Monday' }] };

r = applyRhythmBackstop('Push (missed Monday) + Swim pace 1300m', rhythmWedLive, { configured: false }, [], null, strengthContextLive, rebalanceTodayLive, todayLayoutEntryLive);
if (r !== 'Push (missed Monday) + Swim pace 1300m') fail('setup: the backstop itself must trust this text as-is (hasMissedCatchUp bypass), got ' + JSON.stringify(r));
else ok('setup: backstop trusts "Push (missed Monday) + Swim pace 1300m" as-is (missed catch-up bypass)');

r = ensureExhaustiveTodaySessions(r, rhythmWedLive, rebalanceTodayLive, todayLayoutEntryLive);
if (r !== 'Push (missed Monday) + Swim pace 1300m + Run easy 5km') {
  fail('THE EXACT ASSERTION REQUESTED (live case): title must become exhaustive, got ' + JSON.stringify(r));
} else {
  ok('live case: title becomes exhaustive — ' + JSON.stringify(r));
}

// Title already complete -> unchanged (no duplicate appended).
r = ensureExhaustiveTodaySessions('Push (missed Monday) + Swim pace 1300m + Run easy 5km', rhythmWedLive, rebalanceTodayLive, todayLayoutEntryLive);
if (r !== 'Push (missed Monday) + Swim pace 1300m + Run easy 5km') fail('an already-complete title must be unchanged, got ' + JSON.stringify(r));
else ok('an already-complete title is left unchanged (no duplicate appended)');

// A title mentioning a session NOT in the layout must still be
// stripped by the EXISTING backstop (anti-invention rule, untouched);
// the exhaustiveness pass runs after and must not reintroduce it or
// interfere with the strip.
const rhythmRunOnly = [{ discipline: 'run', kind: 'easy' }];
r = todayTitle('Run easy 5km + Bike ride 10km', rhythmRunOnly, null, { sessions: [{ discipline: 'run', targetAmount: 5, unit: 'km' }] });
if (!/^Run easy 5km \(dropped unscheduled: Bike ride 10km\)$/.test(r)) {
  fail('THE EXACT ASSERTION REQUESTED: an invented session (Bike ride) must still be stripped by the backstop (named only in the dropped tail, never as a live clause), got ' + JSON.stringify(r));
} else {
  ok('an invented session not in today\'s layout is still stripped by the backstop: ' + JSON.stringify(r));
}

// Rest day -> unchanged.
r = todayTitle('Rest', [{ discipline: 'rest' }], null, null);
if (r !== 'Rest') fail('a rest day must be left unchanged, got ' + JSON.stringify(r));
else ok('a rest day is left unchanged: ' + JSON.stringify(r));

// ---- real-page half: gym.html must never OFFER an unscheduled
// cardio candidate to the model in the first place when a rhythm is
// configured (the other half of the fix, on top of the backstop).
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
// BUG FIX (reported) — this test's own comments assume "today" is
// Monday (WEEK_PLAN's Monday session, rhythm's Push-only day) but
// never pinned the clock, relying on the real wall-clock date. Once
// real time moved off Monday, "today" silently became whatever
// weekday it actually was — the assertions happened to still pass
// (candidateKeys legitimately excluded run/interval either way) but
// for a drifted reason, no longer the scenario this test documents.
// Same pinClock/FixedDate technique as every other real-page test in
// this suite that depends on "today" being a specific day.
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
  targets: { run: { km: 20, activityTypeId: 'run1', activityName: 'Running' } },
  strength: { targetSessions: 3, focus: '' },
  cardio: {
    interval: { targetSessions: 1, targetMinutes: 30, activityTypeId: 'run1', activityName: 'Running' },
    longSession: { activityTypeId: '', activityName: '' }, easyVolume: { activityTypeId: '', activityName: '' },
  },
  layout: [
    { weekday: 'monday', dateKey: '2026-10-12', sessions: [{ discipline: 'strength', kind: 'push', estMinutes: 45 }] },
    { weekday: 'tuesday', dateKey: '2026-10-13', sessions: [{ discipline: 'run', kind: 'interval', activityTypeId: 'run1', activityName: 'Running', targetAmount: 3, unit: 'km', estMinutes: 23 }] },
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
      pinClock(win, '2026-10-12T12:00:00Z'); // Monday, pinned regardless of actual wall-clock date
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
    if (u.includes('resource=plans')) body = { ok: true, plans: [{ id: 'p1', status: 'active', startDate: '2026-10-12', weeklyCheckpoints: [{ weekNumber: 1, weekStartDate: '2026-10-12', disciplines: { run: { km: 20 }, strength: { sessions: 3 } } }] }] };
    else if (u.includes('resource=activity-types')) body = { ok: true, types: [{ id: 'run1', name: 'Running', unit: 'km', unitKind: 'distance', recommendable: true }] };
    else if (u.includes('resource=restrictions')) body = { ok: true, restrictions: [] };
    else if (u.includes('resource=weekly-rhythm')) {
      body = { ok: true, rhythm: { monday: [{ discipline: 'strength', kind: 'push' }], tuesday: [{ discipline: 'run', kind: 'interval' }] } };
    } else if (u.includes('mode=plan')) body = { ok: true, plan: WEEK_PLAN };
    else if (u.includes('mode=today')) body = { ok: true, recommendation: 'Push' };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) });
  };

  await wait(1200);
  window.gatherTodayContext = async () => ({
    availability: { configured: true, today: { minutes: 90, disciplines: { run: true, bike: true, swim: true, strength: true } }, thisWeek: [], preferredLongDay: null },
    calendar: { upcoming: [] },
  });

  if (consoleErrors.length) {
    fail('page load produced ' + consoleErrors.length + ' console error(s): ' + consoleErrors.join(' | '));
  } else ok('page loaded with zero console errors');

  const beforeClick = fetchLog.length;
  window.document.getElementById('ttRefreshBtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await wait(800);
  const todayReq = fetchLog.slice(beforeClick).find((f) => f.url.includes('mode=today'));
  if (!todayReq) {
    fail('no mode=today request fired at all');
  } else {
    const payload = JSON.parse(todayReq.body);
    if (!payload.rhythmConfigured) fail('mode=today request must send rhythmConfigured:true when a rhythm exists, got ' + JSON.stringify(payload.rhythmConfigured));
    else ok('mode=today request sends rhythmConfigured:true');
    const candidateKeys = (payload.feasibility && payload.feasibility.candidates || []).map((c) => c.key);
    const hasUnscheduledRun = candidateKeys.some((k) => k === 'run' || k === 'interval');
    if (hasUnscheduledRun) fail('THE EXACT ASSERTION REQUESTED: feasibility.candidates must never offer an unscheduled run/interval candidate on Monday (rhythm is Push only), got ' + JSON.stringify(candidateKeys));
    else ok('feasibility.candidates offers no unscheduled run/interval candidate on Monday, got ' + JSON.stringify(candidateKeys));
  }

  if (consoleErrors.length) fail('console/script errors appeared during the click flow (see above)');
}

runRealPageCheck().then(() => {
  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
}).catch((e) => {
  fail('unexpected error: ' + (e && e.stack || e));
  console.log('\n' + failures + ' FAILURE(S)');
  process.exit(1);
});
