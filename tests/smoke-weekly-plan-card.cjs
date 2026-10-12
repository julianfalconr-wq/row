// Smoke test — run this before every push touching gym.html's weekly
// objectives card (renderWeeklyProgress / the plan-item cards / the
// week layout / the rebalance section).
//
//   node tests/smoke-weekly-plan-card.cjs
//
// Loads the REAL gym.html, seeds a stored weekly plan matching the
// reported scenario (run 3.9+4.6+4.6+6.9=20km across 4 sessions, swim
// 3x1300m, strength on Mon/Wed/Thu/Sat = 4 sessions vs a target of 3
// — the real rhythm-mismatch case — plus a legacy plan.cardio.interval
// field the rhythm does NOT actually have a session for), and asserts
// on the real rendered DOM:
//   - no "Interval / VO2 max" card when the rhythm has no interval
//   - each layout line names its real kind / strength day-type
//   - the rationale renders in its own place, never inside the
//     Rebalance section's own text
//   - the capacity line is present
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

// The EXACT reported scenario: week 1 of a new plan, Mon 2026-10-12.
const WEEK_PLAN = {
  targets: {
    run: { km: 20, activityTypeId: 'run1', activityName: 'Running' },
    swim: { sessions: 3, meters: 1300, activityTypeId: 'swim1', activityName: 'Swimming' },
  },
  strength: { targetSessions: 3, focus: '' },
  // A legacy generator field the rhythm does NOT have a session for —
  // must NEVER produce a card once this fix is in place.
  cardio: {
    interval: { targetSessions: 1, targetMinutes: 30, activityTypeId: 'run1', activityName: 'Running', description: 'Phantom legacy interval' },
    longSession: { targetAmount: 0, unit: 'km', activityTypeId: null, activityName: '', description: '' },
    easyVolume: { targetAmount: 0, unit: 'km', activityTypeId: null, activityName: '', description: '' },
  },
  layout: [
    { weekday: 'monday', dateKey: '2026-10-12', sessions: [
      { discipline: 'run', kind: 'easy', activityTypeId: 'run1', activityName: 'Running', targetAmount: 3.9, unit: 'km', estMinutes: 23 },
      { discipline: 'strength', kind: 'push', activityTypeId: null, activityName: 'Strength', targetAmount: null, unit: '', estMinutes: 45 },
    ] },
    { weekday: 'wednesday', dateKey: '2026-10-14', sessions: [
      { discipline: 'run', kind: 'easy', activityTypeId: 'run1', activityName: 'Running', targetAmount: 4.6, unit: 'km', estMinutes: 28 },
      { discipline: 'swim', kind: 'long', activityTypeId: 'swim1', activityName: 'Swimming', targetAmount: 1300, unit: 'm', estMinutes: 33 },
      { discipline: 'strength', kind: 'pull', activityTypeId: null, activityName: 'Strength', targetAmount: null, unit: '', estMinutes: 45 },
    ] },
    { weekday: 'thursday', dateKey: '2026-10-15', sessions: [
      { discipline: 'run', kind: 'easy', activityTypeId: 'run1', activityName: 'Running', targetAmount: 4.6, unit: 'km', estMinutes: 28 },
      { discipline: 'strength', kind: 'explosive', activityTypeId: null, activityName: 'Strength', targetAmount: null, unit: '', estMinutes: 45 },
    ] },
    { weekday: 'saturday', dateKey: '2026-10-17', sessions: [
      { discipline: 'run', kind: 'long', activityTypeId: 'run1', activityName: 'Running', targetAmount: 6.9, unit: 'km', estMinutes: 41 },
      { discipline: 'swim', kind: 'technique', activityTypeId: 'swim1', activityName: 'Swimming', targetAmount: 1300, unit: 'm', estMinutes: 33 },
      { discipline: 'strength', kind: 'legs', activityTypeId: null, activityName: 'Strength', targetAmount: null, unit: '', estMinutes: 45 },
    ] },
    { weekday: 'sunday', dateKey: '2026-10-18', sessions: [
      { discipline: 'swim', kind: 'pace', activityTypeId: 'swim1', activityName: 'Swimming', targetAmount: 1300, unit: 'm', estMinutes: 33 },
    ] },
  ],
  unplaced: [],
  // The real rhythm-mismatch case: 4 strength sessions placed (the
  // rhythm's own real Mon/Wed/Thu/Sat), target is 3 -- expected,
  // user-acknowledged, not a bug to "fix" away.
  rhythmMismatchNotes: ['Rhythm has 4 strength sessions this week, but the plan targets 3.'],
  rationale: 'This week ramps run volume steadily toward the race goal while keeping the swim technique day light.',
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
      win.localStorage.setItem('dashboard:secret', 'test-secret');
      win.sessionStorage.setItem('dashboard:unlocked', '1');
      win.localStorage.setItem('po_coach_weekly_plan_v1', JSON.stringify({
        weekStart: '2026-10-12', plan: WEEK_PLAN, generatedAt: new Date().toISOString(),
      }));
    },
  });
  const { window } = dom;
  window.console.warn = () => {};
  window.alert = () => {};
  window.addEventListener('error', (e) => consoleErrors.push('UNCAUGHT: ' + (e.error && (e.error.stack || e.error.message) || e.message)));
  window.fetch = (url) => {
    const u = String(url);
    let body = { ok: true };
    if (u.includes('resource=plans')) body = { ok: true, plans: [] };
    else if (u.includes('resource=activity-types')) body = { ok: true, types: [] };
    else if (u.includes('resource=restrictions')) body = { ok: true, restrictions: [] };
    else if (u.includes('resource=weekly-rhythm')) body = { ok: true, rhythm: {} };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) });
  };

  await wait(1200);

  // Override gatherTodayContext (topbar.js's real one depends on a
  // real Google Calendar connection) with a minimal, real-shaped,
  // fully-configured availability context so the capacity line has
  // something real to compute from.
  window.gatherTodayContext = async () => ({
    availability: {
      configured: true,
      today: { minutes: 90, disciplines: { run: true, bike: true, swim: true, strength: true } },
      thisWeek: [],
      preferredLongDay: null,
    },
    calendar: { upcoming: [] },
  });
  window.__refreshWeeklyPlanCard();
  await wait(800);

  let failures = 0;
  function fail(msg) { failures++; console.log('FAIL:', msg); }
  function ok(msg) { console.log('PASS:', msg); }

  if (consoleErrors.length) {
    fail('page load produced ' + consoleErrors.length + ' console error(s)/uncaught exception(s):');
    consoleErrors.forEach((e) => console.log('   ', e));
  } else {
    ok('page loaded and re-rendered with zero console errors');
  }

  const planGridText = window.document.getElementById('tpPlanItemsGrid').textContent;
  if (/interval/i.test(planGridText)) fail('THE EXACT ASSERTION REQUESTED: no interval card without a rhythm interval, but the plan grid mentions "interval": ' + JSON.stringify(planGridText));
  else ok('no "Interval / VO2 max" card renders despite the legacy plan.cardio.interval field being populated');

  const layoutText = window.document.getElementById('tpLayoutDays').textContent;
  ['Push', 'Pull', 'Explosive', 'Legs'].forEach((dayType) => {
    if (!layoutText.includes(dayType)) fail('THE EXACT ASSERTION REQUESTED: layout includes the strength day-type "' + dayType + '", got layout text: ' + JSON.stringify(layoutText));
  });
  if (!/Easy/.test(layoutText) || !/Long/.test(layoutText)) fail('layout is missing the run kind labels (Easy/Long), got: ' + JSON.stringify(layoutText));
  if (!/Technique/.test(layoutText) || !/Pace/.test(layoutText)) fail('layout is missing the swim kind labels (Technique/Pace), got: ' + JSON.stringify(layoutText));
  if (failures === 0) ok('layout names every session\'s real kind and, for strength, its real day-type');

  const rationaleEl = window.document.getElementById('tpRationale');
  if (rationaleEl.textContent !== WEEK_PLAN.rationale) fail('tpRationale does not contain the plan\'s own rationale text, got: ' + JSON.stringify(rationaleEl.textContent));
  else ok('the rationale renders with the real plan text');

  const rebalanceSectionEl = window.document.getElementById('tpRebalanceSection');
  if (rebalanceSectionEl.textContent.includes(WEEK_PLAN.rationale)) fail('THE EXACT ASSERTION REQUESTED: the rebalanced section must never contain the rationale, but it does');
  else ok('the rebalanced section never contains the rationale text');

  // DOM order: the rationale element should come BEFORE the rebalance
  // title/section, not after it (point 3's own "render it in its own
  // place", grouped with the weekly plan's own content).
  const rebalanceTitleEl = window.document.getElementById('tpRebalanceTitle');
  if (!(rationaleEl.compareDocumentPosition(rebalanceTitleEl) & window.Node.DOCUMENT_POSITION_FOLLOWING)) {
    fail('the rationale no longer sits BEFORE the Rebalance section in DOM order');
  } else {
    ok('the rationale sits before the Rebalance section in DOM order, not after it');
  }

  const capacityLineEl = window.document.getElementById('tpCapacityLine');
  if (capacityLineEl.style.display === 'none' || !window.document.getElementById('tpCapacityText').textContent) {
    fail('THE EXACT ASSERTION REQUESTED: the capacity line is present ("Available this week: ..."), got display=' + capacityLineEl.style.display + ' text="' + window.document.getElementById('tpCapacityText').textContent + '"');
  } else {
    ok('the capacity line is present: "' + window.document.getElementById('tpCapacityText').textContent + '"');
  }

  if (consoleErrors.length > (failures ? consoleErrors.length : 0)) { /* already reported above */ }

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
}

main();
