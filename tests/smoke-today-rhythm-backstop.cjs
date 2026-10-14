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
].join('\n');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(block + '\nthis.applyRhythmBackstop = applyRhythmBackstop;', sandbox);
const applyRhythmBackstop = sandbox.applyRhythmBackstop;

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
      win.localStorage.setItem('dashboard:secret', 'test-secret');
      win.sessionStorage.setItem('dashboard:unlocked', '1');
      win.localStorage.setItem('po_coach_weekly_plan_v1', JSON.stringify({ weekStart: '2026-10-12', plan: WEEK_PLAN, generatedAt: new Date().toISOString() }));
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
