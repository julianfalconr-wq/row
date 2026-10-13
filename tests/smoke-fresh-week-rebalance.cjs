// Smoke test — run this before every push touching the rebalancer
// (computeOutstandingByDiscipline / buildRebalanceLayout /
// buildTodayRebalancePick in gym.html).
//
//   node tests/smoke-fresh-week-rebalance.cjs
//
// Reproduces the EXACT reported bug end-to-end on the real page:
// Monday of a fresh week, rhythm = Monday Strength(Push) only, runs
// Tue/Wed/Fri/Sun (3.9+4.6+4.6+6.9=20km), nothing logged yet. Clicks
// the real "Re-plan rest of week" and "Refresh" (Today's session)
// buttons and asserts on the real rendered DOM / real network request
// body: no phantom "Xkm moved to..." text when nothing is actually
// behind, the Rebalance section says "Nothing to rebalance yet this
// week", and rebalanceToday carries only today's own rhythm entry
// (Push) — never an invented cardio backlog chunk for sessions the
// rhythm hasn't even reached yet.
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROW_DIR = path.join(__dirname, '..');

function buildHtml() {
  let html = fs.readFileSync(path.join(ROW_DIR, 'gym.html'), 'utf8');
  const escapeForInlineScript = (s) => s.replace(/<\/script/gi, '<\\/script');
  const lockJs = escapeForInlineScript(fs.readFileSync(path.join(ROW_DIR, 'lock.js'), 'utf8'));
  const daylibJs = escapeForInlineScript(fs.readFileSync(path.join(ROW_DIR, 'daylib.js'), 'utf8'));
  const topbarJs = escapeForInlineScript(fs.readFileSync(path.join(ROW_DIR, 'topbar.js'), 'utf8'));
  html = html.replace('<script src="lock.js"></script>', '<script>' + lockJs + '</script>');
  html = html.replace('<script src="daylib.js"></script>', '<script>' + daylibJs + '</script>');
  html = html.replace('<script src="topbar.js" defer></script>', '<script>' + topbarJs + '</script>');
  html = html.replace(/<script src="https:\/\/unpkg\.com\/lucide[^"]*"[^>]*><\/script>/, '<script>window.lucide = { createIcons: function(){} };</script>');
  const supabaseStub = (
    '<script>' +
    'window.supabase = { createClient: function() {' +
    '  var chain = { select: function(){ return chain; }, eq: function(){ return chain; }, maybeSingle: function(){ return Promise.resolve({ data: null, error: null }); } };' +
    '  var channel = { on: function(){ return channel; }, subscribe: function(){ return channel; } };' +
    '  return { auth: {}, from: function(){ return chain; }, channel: function(){ return channel; } };' +
    '} };' +
    '</script>'
  );
  html = html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js[^"]*"><\/script>/, supabaseStub);
  return html;
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// The user's own real rhythm: Monday Strength(Push) only; runs
// Tue/Wed/Fri/Sun summing to the week's full 20km target.
const WEEK_PLAN = {
  targets: { run: { km: 20, activityTypeId: 'run1', activityName: 'Running' } },
  strength: { targetSessions: 3, focus: '' },
  cardio: { interval: { targetSessions: 0, targetMinutes: 0 }, longSession: {}, easyVolume: {} },
  layout: [
    { weekday: 'monday', dateKey: '2026-10-12', sessions: [{ discipline: 'strength', kind: 'push', estMinutes: 45 }] },
    { weekday: 'tuesday', dateKey: '2026-10-13', sessions: [{ discipline: 'run', kind: 'easy', activityTypeId: 'run1', activityName: 'Running', targetAmount: 3.9, unit: 'km', estMinutes: 23 }] },
    { weekday: 'wednesday', dateKey: '2026-10-14', sessions: [{ discipline: 'run', kind: 'easy', activityTypeId: 'run1', activityName: 'Running', targetAmount: 4.6, unit: 'km', estMinutes: 28 }] },
    { weekday: 'friday', dateKey: '2026-10-16', sessions: [{ discipline: 'run', kind: 'easy', activityTypeId: 'run1', activityName: 'Running', targetAmount: 4.6, unit: 'km', estMinutes: 28 }] },
    { weekday: 'sunday', dateKey: '2026-10-18', sessions: [{ discipline: 'run', kind: 'long', activityTypeId: 'run1', activityName: 'Running', targetAmount: 6.9, unit: 'km', estMinutes: 41 }] },
  ],
  unplaced: [],
  rationale: 'Week 1.',
};

async function main() {
  const html = buildHtml();
  const consoleErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => consoleErrors.push('JSDOM: ' + (e.stack || e.message)));
  virtualConsole.on('error', (...args) => consoleErrors.push(args.map(String).join(' ')));

  const dom = new JSDOM(html, {
    url: 'https://row.test/gym.html', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(win) {
      // BUG FIX (date drift) — this scenario is specifically "Monday
      // of a fresh week" and every dateKey in WEEK_PLAN/the mocked
      // fetch responses above is a hardcoded real Monday
      // (2026-10-12); relying on the ACTUAL wall-clock date to also
      // land on that same Monday is what broke this test the moment
      // the real date moved on — pin the page's own notion of "now"
      // instead, so this test stays deterministic regardless of
      // when it's actually run. Only the no-arg/Date.now() forms are
      // pinned; explicit date-string parsing (used throughout the
      // real page for every OTHER date) is untouched.
      const FIXED_NOW = new win.Date('2026-10-12T12:00:00Z');
      const RealDate = win.Date;
      class FixedDate extends RealDate {
        constructor(...args) { return args.length ? new RealDate(...args) : new RealDate(FIXED_NOW); }
        static now() { return FIXED_NOW.getTime(); }
      }
      win.Date = FixedDate;
      win.localStorage.setItem('dashboard:secret', 'test-secret');
      win.sessionStorage.setItem('dashboard:unlocked', '1');
      win.localStorage.setItem('po_coach_weekly_plan_v1', JSON.stringify({ weekStart: '2026-10-12', plan: WEEK_PLAN, generatedAt: FIXED_NOW.toISOString() }));
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
    if (u.includes('resource=plans')) {
      body = { ok: true, plans: [{ id: 'p1', status: 'active', startDate: '2026-10-12', weeklyCheckpoints: [{ weekNumber: 1, weekStartDate: '2026-10-12', disciplines: { run: { km: 20 }, strength: { sessions: 3 } } }] }] };
    } else if (u.includes('resource=activity-types')) body = { ok: true, types: [{ id: 'run1', name: 'Running', unit: 'km', unitKind: 'distance', recommendable: true }] };
    else if (u.includes('resource=restrictions')) body = { ok: true, restrictions: [] };
    else if (u.includes('resource=weekly-rhythm')) {
      body = { ok: true, rhythm: {
        monday: [{ discipline: 'strength', kind: 'push' }],
        tuesday: [{ discipline: 'run', kind: 'easy' }],
        wednesday: [{ discipline: 'run', kind: 'easy' }],
        friday: [{ discipline: 'run', kind: 'easy' }],
        sunday: [{ discipline: 'run', kind: 'long' }],
      } };
    } else if (u.includes('mode=plan')) body = { ok: true, plan: WEEK_PLAN }; // keeps a stale-fingerprint auto-rebuild consistent with this scenario, rather than racing it
    else if (u.includes('mode=today')) body = { ok: true, recommendation: 'Push' };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) });
  };

  await wait(1200);
  window.gatherTodayContext = async () => ({
    availability: { configured: true, today: { minutes: 90, disciplines: { run: true, bike: true, swim: true, strength: true } }, thisWeek: [], preferredLongDay: null },
    calendar: { upcoming: [] },
  });

  let failures = 0;
  function fail(msg) { failures++; console.log('FAIL:', msg); }
  function ok(msg) { console.log('PASS:', msg); }

  if (consoleErrors.length) {
    fail('page load produced ' + consoleErrors.length + ' console error(s):');
    consoleErrors.forEach((e) => console.log('   ', e));
  } else {
    ok('page loaded with zero console errors');
  }

  window.document.getElementById('tpRebalanceBtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await wait(800);

  const rebalanceText = window.document.getElementById('tpRebalanceSection').textContent;
  if (/moved to/i.test(rebalanceText)) fail('THE EXACT ASSERTION REQUESTED: "moved to" must never appear on a fresh Monday with nothing missed, got: ' + JSON.stringify(rebalanceText));
  else ok('no phantom "moved to" text in the Rebalance section');
  if (!rebalanceText.includes('Nothing to rebalance yet this week')) fail('THE EXACT ASSERTION REQUESTED: the Rebalance section should say "Nothing to rebalance yet this week", got: ' + JSON.stringify(rebalanceText));
  else ok('the Rebalance section correctly says "Nothing to rebalance yet this week"');

  const beforeTodayClick = fetchLog.length;
  window.document.getElementById('ttRefreshBtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await wait(800);
  const todayReq = fetchLog.slice(beforeTodayClick).find((f) => f.url.includes('mode=today'));
  if (!todayReq) {
    fail('no mode=today request fired at all');
  } else {
    const payload = JSON.parse(todayReq.body);
    const sessions = (payload.rebalanceToday && payload.rebalanceToday.sessions) || [];
    if (sessions.some((s) => s.discipline === 'run')) fail('THE EXACT ASSERTION REQUESTED: rebalanceToday must not carry a phantom run backlog chunk on a fresh Monday, got ' + JSON.stringify(sessions));
    else ok('rebalanceToday carries no run backlog chunk on a fresh Monday (pick is Push only), got ' + JSON.stringify(sessions));
  }

  if (consoleErrors.length) {
    fail('console/script errors appeared during the click flow (see above)');
  }

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
}

main();
