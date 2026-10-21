// Smoke test — run this before every push touching activity `kind`
// tagging (sanitizeActivityKind / computeClaimedKindSlots /
// suggestActivityKindForLog in gym.html) or the layout strike-through
// (tpLayoutDays / renderWeeklyProgress).
//
//   node tests/smoke-activity-kind.cjs
//
// Part 1 of 2 (part 2 is the rebalancer — explicitly untouched here).
// An activity's optional kind (run: easy|interval|pace|long; swim:
// technique|long|pace) is used ONLY for the "This week's layout"
// strike-through. A TAGGED activity only ever satisfies a SAME-KIND
// slot (same date preferred, else the earliest unmet same-kind slot
// this week, one activity per slot). An UNTAGGED activity keeps the
// exact pre-feature same-discipline-any-date behavior.
//
// Part 1: sanitizeActivityKind — extracted verbatim, invalid/foreign
// values stripped.
// Part 2: the real gym.html page — the live case (tagged interval),
// untagged (old behavior), tagged easy, two same-kind slots/one
// activity, and a retro-tag via the History list's "Set kind" select
// updating the strike-through after re-render.
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

// ---------------------------------------------------------------
// Part 1 — sanitizeActivityKind, extracted verbatim.
// ---------------------------------------------------------------
function runPart1() {
  const sandbox = {};
  vm.createContext(sandbox);
  const block = [extractConst('ACTIVITY_KIND_VALUES'), extractFn('sanitizeActivityKind')].join('\n');
  vm.runInContext(block + '\nthis.sanitizeActivityKind = sanitizeActivityKind;', sandbox);
  const { sanitizeActivityKind } = sandbox;

  if (sanitizeActivityKind('run', 'interval') !== 'interval') fail('sanitizeActivityKind: a valid run kind must pass through');
  else ok('sanitizeActivityKind: valid run kind (interval) passes through');
  if (sanitizeActivityKind('swim', 'technique') !== 'technique') fail('sanitizeActivityKind: a valid swim kind must pass through');
  else ok('sanitizeActivityKind: valid swim kind (technique) passes through');

  // THE EXACT ASSERTION REQUESTED — invalid/foreign values stripped.
  if (sanitizeActivityKind('run', 'technique') !== '') fail('sanitizeActivityKind: a swim-only kind on run must be stripped, got ' + JSON.stringify(sanitizeActivityKind('run', 'technique')));
  else ok('sanitizeActivityKind: a foreign-discipline kind (technique on run) is stripped');
  if (sanitizeActivityKind('run', 'sprint') !== '') fail('sanitizeActivityKind: a made-up kind must be stripped');
  else ok('sanitizeActivityKind: an unrecognized kind (sprint) is stripped');
  if (sanitizeActivityKind('strength', 'push') !== '') fail('sanitizeActivityKind: strength must never get a kind here (it already works by day-type), got ' + JSON.stringify(sanitizeActivityKind('strength', 'push')));
  else ok('sanitizeActivityKind: strength never gets a kind (already matched by day-type)');
  if (sanitizeActivityKind('run', null) !== '' || sanitizeActivityKind('run', undefined) !== '') fail('sanitizeActivityKind: null/undefined must strip to empty');
  else ok('sanitizeActivityKind: null/undefined strips to empty');
}

// ---------------------------------------------------------------
// Part 2 — the real gym.html page.
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

function addDaysKeyPlain(dateKeyStr, n) {
  const d = new Date(dateKeyStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function weekPlanWithRunLayout(sessionsByWeekday, weekMonday) {
  const monday = weekMonday || '2026-10-12';
  const WEEKDAY_OFFSET = { monday: 0, tuesday: 1, wednesday: 2, thursday: 3, friday: 4, saturday: 5, sunday: 6 };
  const DATE_KEYS = {};
  Object.keys(WEEKDAY_OFFSET).forEach((wd) => { DATE_KEYS[wd] = addDaysKeyPlain(monday, WEEKDAY_OFFSET[wd]); });
  const layout = Object.keys(sessionsByWeekday).map((wd) => ({
    weekday: wd, dateKey: DATE_KEYS[wd],
    sessions: sessionsByWeekday[wd].map((kind) => ({ discipline: 'run', kind, activityTypeId: 'run1', activityName: 'Running', targetAmount: 5, unit: 'km', estMinutes: 30 })),
  }));
  return {
    targets: { run: { km: 20, activityTypeId: 'run1', activityName: 'Running' } },
    strength: { targetSessions: 0, focus: '' },
    cardio: { interval: { targetSessions: 0, targetMinutes: 0 }, longSession: {}, easyVolume: {} },
    layout, unplaced: [], rationale: 'Week 1.',
  };
}

async function loadPage(weekPlan, activities, options) {
  const opts = options || {};
  const weekStart = opts.weekStart || '2026-10-12';
  const pinDate = opts.pinDate || '2026-10-14T12:00:00Z'; // Wednesday of that week, by default
  const html = buildHtml();
  const consoleErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => consoleErrors.push('JSDOM: ' + (e.stack || e.message)));
  virtualConsole.on('error', (...args) => consoleErrors.push(args.map(String).join(' ')));
  const dom = new JSDOM(html, {
    url: 'https://row.test/gym.html', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(win) {
      pinClock(win, pinDate); // pinned regardless of actual wall-clock date
      win.localStorage.setItem('dashboard:secret', 'test-secret');
      win.sessionStorage.setItem('dashboard:unlocked', '1');
      win.localStorage.setItem('po_coach_weekly_plan_v1', JSON.stringify({ weekStart, plan: weekPlan, generatedAt: new win.Date().toISOString() }));
      win.localStorage.setItem('po_coach_activities', JSON.stringify(activities));
      // Installed in beforeParse (BEFORE any inline <script> runs) —
      // fetchActivityTypes() is called from top-level, synchronous
      // script code at page load, so a window.fetch assigned only
      // AFTER `new JSDOM()` returns would miss that very first call.
      win.fetch = (url) => {
        const u = String(url);
        let body = { ok: true };
        if (u.includes('resource=plans')) body = { ok: true, plans: [] };
        else if (u.includes('resource=activity-types')) body = { ok: true, types: [{ id: 'run1', name: 'Running', unit: 'km', unitKind: 'distance', recommendable: true }] };
        else if (u.includes('resource=restrictions')) body = { ok: true, restrictions: [] };
        else if (u.includes('resource=weekly-rhythm')) body = { ok: true, rhythm: {} };
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) });
      };
      win.gatherTodayContext = async () => ({ availability: { configured: false }, calendar: { upcoming: [] } });
    },
  });
  const { window } = dom;
  window.console.warn = () => {};
  window.alert = () => {};
  window.addEventListener('error', (e) => consoleErrors.push('UNCAUGHT: ' + (e.error && (e.error.stack || e.error.message) || e.message)));
  await wait(1200);
  return { window, consoleErrors };
}

function sessionDoneMap(window) {
  const spans = [...window.document.querySelectorAll('#tpLayoutDays .tp-layout-session')];
  const map = {};
  spans.forEach((el) => { map[el.textContent.trim()] = el.classList.contains('is-done'); });
  return map;
}

async function runPart2() {
  // --- Case 1 (THE LIVE CASE) — Tue Interval 3km, Wed Easy 5km;
  // activity tagged 'interval' logged on Wed -> Tue Interval struck,
  // Wed Easy NOT struck. ---
  {
    const plan = weekPlanWithRunLayout({ tuesday: ['interval'], wednesday: ['easy'] });
    const activities = [{ id: 'a1', dateKey: '2026-10-14', activityTypeId: 'run1', distanceKm: 3, durationMin: 18, effort: null, notes: '', kind: 'interval' }];
    const { window, consoleErrors } = await loadPage(plan, activities);
    if (consoleErrors.length) fail('Case 1: page load produced console error(s): ' + consoleErrors.join(' | '));
    else ok('Case 1: page loaded with zero console errors');
    const doneMap = sessionDoneMap(window);
    console.log('\n--- Live case: "This week\'s layout" text dump ---');
    console.log(window.document.getElementById('tpLayoutDays').textContent.replace(/\s+/g, ' ').trim());
    const tueDone = Object.keys(doneMap).some((k) => /interval/i.test(k) && doneMap[k]);
    const wedDone = Object.keys(doneMap).some((k) => /easy/i.test(k) && doneMap[k]);
    if (!tueDone) fail('THE EXACT ASSERTION REQUESTED: Tue Interval must be struck (kind-matched), got ' + JSON.stringify(doneMap));
    else ok('Case 1 (live case): Tue Interval is struck — kind-matched to the tagged activity');
    if (wedDone) fail('THE EXACT ASSERTION REQUESTED: Wed Easy must NOT be struck, got ' + JSON.stringify(doneMap));
    else ok('Case 1 (live case): Wed Easy is NOT struck — a tagged activity never falls back to same-date-any-kind');
  }

  // --- Case 2 — same activity, untagged -> old behavior (Wed's own
  // run session struck; also proves old-format activities with no
  // `kind` key at all load and render without errors). ---
  {
    const plan = weekPlanWithRunLayout({ tuesday: ['interval'], wednesday: ['easy'] });
    const activities = [{ id: 'a1', dateKey: '2026-10-14', activityTypeId: 'run1', distanceKm: 3, durationMin: 18, effort: null, notes: '' }]; // no `kind` key at all
    const { window, consoleErrors } = await loadPage(plan, activities);
    if (consoleErrors.length) fail('Case 2: old-format (no kind) activity must load without errors, got: ' + consoleErrors.join(' | '));
    else ok('Case 2: old-format activity (no `kind` key) loads and renders with zero console errors');
    const doneMap = sessionDoneMap(window);
    const wedDone = Object.keys(doneMap).some((k) => /easy/i.test(k) && doneMap[k]);
    const tueDone = Object.keys(doneMap).some((k) => /interval/i.test(k) && doneMap[k]);
    if (!wedDone) fail('Case 2: untagged activity must strike Wed\'s own run session (old behavior), got ' + JSON.stringify(doneMap));
    else ok('Case 2: untagged activity -> old same-discipline-any-date behavior (Wed Easy struck)');
    if (tueDone) fail('Case 2: Tuesday has no activity logged on it, must not be struck, got ' + JSON.stringify(doneMap));
    else ok('Case 2: Tue Interval correctly NOT struck (nothing logged that day)');
  }

  // --- Case 3 — activity tagged 'easy' on Wed -> Wed Easy struck,
  // Tue Interval not. ---
  {
    const plan = weekPlanWithRunLayout({ tuesday: ['interval'], wednesday: ['easy'] });
    const activities = [{ id: 'a1', dateKey: '2026-10-14', activityTypeId: 'run1', distanceKm: 5, durationMin: 30, effort: null, notes: '', kind: 'easy' }];
    const { window, consoleErrors } = await loadPage(plan, activities);
    if (consoleErrors.length) fail('Case 3: page load produced console error(s): ' + consoleErrors.join(' | '));
    const doneMap = sessionDoneMap(window);
    const wedDone = Object.keys(doneMap).some((k) => /easy/i.test(k) && doneMap[k]);
    const tueDone = Object.keys(doneMap).some((k) => /interval/i.test(k) && doneMap[k]);
    if (!wedDone) fail('Case 3: Wed Easy must be struck (same date + same kind), got ' + JSON.stringify(doneMap));
    else ok('Case 3: activity tagged "easy" on Wed -> Wed Easy struck');
    if (tueDone) fail('Case 3: Tue Interval must NOT be struck, got ' + JSON.stringify(doneMap));
    else ok('Case 3: Tue Interval correctly NOT struck (different kind)');
  }

  // --- Case 4 — two same-kind slots (Wed Easy + Fri Easy), one
  // activity (tagged 'easy', logged Wed) -> only Wed's slot struck. ---
  {
    const plan = weekPlanWithRunLayout({ wednesday: ['easy'], friday: ['easy'] });
    const activities = [{ id: 'a1', dateKey: '2026-10-14', activityTypeId: 'run1', distanceKm: 5, durationMin: 30, effort: null, notes: '', kind: 'easy' }];
    const { window, consoleErrors } = await loadPage(plan, activities);
    if (consoleErrors.length) fail('Case 4: page load produced console error(s): ' + consoleErrors.join(' | '));
    const sessionEls = [...window.document.querySelectorAll('#tpLayoutDays .tp-layout-day')];
    const wedDay = sessionEls.find((d) => d.querySelector('.tp-layout-day-label').textContent === 'Wed');
    const friDay = sessionEls.find((d) => d.querySelector('.tp-layout-day-label').textContent === 'Fri');
    const wedDone = wedDay && wedDay.querySelector('.tp-layout-session').classList.contains('is-done');
    const friDone = friDay && friDay.querySelector('.tp-layout-session').classList.contains('is-done');
    if (!wedDone) fail('THE EXACT ASSERTION REQUESTED: Case 4 — Wed\'s easy slot (same date as the activity) must be struck');
    else ok('Case 4: Wed\'s easy slot (same date, preferred) is struck');
    if (friDone) fail('THE EXACT ASSERTION REQUESTED: Case 4 — Fri\'s easy slot must NOT also be struck (one activity per slot), got done=' + friDone);
    else ok('Case 4: Fri\'s easy slot stays unmet — one activity per slot, not both struck');
  }

  // --- Case 4b (THE LIVE CASE) — layout week Mon 2026-10-19..Sun
  // 2026-10-25, a Sunday Long slot, ZERO activities logged this week.
  // A `long`-tagged run from the PREVIOUS week (Sun 2026-10-18) must
  // never claim it. ---
  {
    const plan = weekPlanWithRunLayout({ sunday: ['long'] }, '2026-10-19');
    const activities = [{ id: 'a1', dateKey: '2026-10-18', activityTypeId: 'run1', distanceKm: 9, durationMin: 54, effort: null, notes: '', kind: 'long' }];
    const { window, consoleErrors } = await loadPage(plan, activities, { weekStart: '2026-10-19', pinDate: '2026-10-21T12:00:00Z' });
    if (consoleErrors.length) fail('Case 4b (live case): page load produced console error(s): ' + consoleErrors.join(' | '));
    else ok('Case 4b (live case): page loaded with zero console errors');
    console.log('\n--- Live case (cross-week): "This week\'s layout" text dump ---');
    console.log(window.document.getElementById('tpLayoutDays').textContent.replace(/\s+/g, ' ').trim());
    const sunDone = window.document.querySelector('#tpLayoutDays .tp-layout-session').classList.contains('is-done');
    if (sunDone) fail('THE EXACT ASSERTION REQUESTED: a previous week\'s long-tagged activity (2026-10-18) must NOT claim this week\'s Sunday Long slot, got struck=' + sunDone);
    else ok('Case 4b (live case): Sunday Long is NOT struck — last week\'s tagged activity never crosses the week boundary');
  }

  // --- Case 4c — same layout/week, the long run is logged ON this
  // week's own Sunday (2026-10-25) -> struck. ---
  {
    const plan = weekPlanWithRunLayout({ sunday: ['long'] }, '2026-10-19');
    const activities = [{ id: 'a1', dateKey: '2026-10-25', activityTypeId: 'run1', distanceKm: 9, durationMin: 54, effort: null, notes: '', kind: 'long' }];
    const { window, consoleErrors } = await loadPage(plan, activities, { weekStart: '2026-10-19', pinDate: '2026-10-21T12:00:00Z' });
    if (consoleErrors.length) fail('Case 4c: page load produced console error(s): ' + consoleErrors.join(' | '));
    const sunDone = window.document.querySelector('#tpLayoutDays .tp-layout-session').classList.contains('is-done');
    if (!sunDone) fail('Case 4c: a long run logged on this week\'s own Sunday (2026-10-25) must strike the Sunday Long slot, got struck=' + sunDone);
    else ok('Case 4c: a long run logged on this week\'s own Sunday strikes the Long slot');
  }

  // --- Case 4d — same layout/week, the long run is logged on a
  // DIFFERENT day THIS SAME WEEK (Wed 2026-10-21, no Wed slot exists)
  // -> falls back to this week's only unmet Long slot (Sunday), as
  // designed (the fallback is scoped to the week, not unbounded). ---
  {
    const plan = weekPlanWithRunLayout({ sunday: ['long'] }, '2026-10-19');
    const activities = [{ id: 'a1', dateKey: '2026-10-21', activityTypeId: 'run1', distanceKm: 9, durationMin: 54, effort: null, notes: '', kind: 'long' }];
    const { window, consoleErrors } = await loadPage(plan, activities, { weekStart: '2026-10-19', pinDate: '2026-10-21T12:00:00Z' });
    if (consoleErrors.length) fail('Case 4d: page load produced console error(s): ' + consoleErrors.join(' | '));
    const sunDone = window.document.querySelector('#tpLayoutDays .tp-layout-session').classList.contains('is-done');
    if (!sunDone) fail('THE EXACT ASSERTION REQUESTED: Case 4d — a same-week long run on a different day must fall back to this week\'s own unmet Long slot, got struck=' + sunDone);
    else ok('Case 4d: a same-week long run (different day, no slot of its own) falls back to this week\'s own Long slot');
  }

  // --- Case 4e — a `long`-tagged run from the week AFTER the layout
  // week (2026-11-01) must never claim it either. ---
  {
    const plan = weekPlanWithRunLayout({ sunday: ['long'] }, '2026-10-19');
    const activities = [{ id: 'a1', dateKey: '2026-11-01', activityTypeId: 'run1', distanceKm: 9, durationMin: 54, effort: null, notes: '', kind: 'long' }];
    const { window, consoleErrors } = await loadPage(plan, activities, { weekStart: '2026-10-19', pinDate: '2026-10-21T12:00:00Z' });
    if (consoleErrors.length) fail('Case 4e: page load produced console error(s): ' + consoleErrors.join(' | '));
    const sunDone = window.document.querySelector('#tpLayoutDays .tp-layout-session').classList.contains('is-done');
    if (sunDone) fail('THE EXACT ASSERTION REQUESTED: Case 4e — a long-tagged activity from the week AFTER must never claim this week\'s slot, got struck=' + sunDone);
    else ok('Case 4e: a long-tagged activity from the week AFTER never claims this week\'s slot');
  }

  // --- Case 5 — retro-tag via the History list's "Set kind" select:
  // starts untagged (old behavior, Wed Easy struck via same-date-any-
  // kind); after tagging it 'interval' and re-rendering, Wed Easy is
  // no longer struck and Tue Interval becomes struck instead. ---
  {
    const plan = weekPlanWithRunLayout({ tuesday: ['interval'], wednesday: ['easy'] });
    const activities = [{ id: 'a1', dateKey: '2026-10-14', activityTypeId: 'run1', distanceKm: 3, durationMin: 18, effort: null, notes: '' }];
    const { window, consoleErrors } = await loadPage(plan, activities);
    if (consoleErrors.length) fail('Case 5: page load produced console error(s): ' + consoleErrors.join(' | '));
    let doneMap = sessionDoneMap(window);
    const wedDoneBefore = Object.keys(doneMap).some((k) => /easy/i.test(k) && doneMap[k]);
    if (!wedDoneBefore) fail('Case 5 setup: Wed Easy should start struck (untagged, old behavior)');
    else ok('Case 5 setup: Wed Easy starts struck (untagged activity, old behavior)');

    const kindSelect = window.document.querySelector('.th-kind-select[data-activity-id="a1"]');
    if (!kindSelect) {
      fail('Case 5: expected a "Set kind" select (.th-kind-select) for activity a1 in the History list');
    } else {
      ok('Case 5: History list shows a "Set kind" select for the activity');
      kindSelect.value = 'interval';
      kindSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
      await wait(300);
      const stored = JSON.parse(window.localStorage.getItem('po_coach_activities'));
      if (!stored.some((a) => a.id === 'a1' && a.kind === 'interval')) {
        fail('THE EXACT ASSERTION REQUESTED: retro-tagging via "Set kind" must update the stored entry\'s kind, got ' + JSON.stringify(stored));
      } else {
        ok('Case 5: "Set kind" updated the stored entry\'s kind to "interval"');
      }
      doneMap = sessionDoneMap(window);
      const wedDoneAfter = Object.keys(doneMap).some((k) => /easy/i.test(k) && doneMap[k]);
      const tueDoneAfter = Object.keys(doneMap).some((k) => /interval/i.test(k) && doneMap[k]);
      if (wedDoneAfter) fail('THE EXACT ASSERTION REQUESTED: after retro-tagging to "interval", Wed Easy must no longer be struck, got ' + JSON.stringify(doneMap));
      else ok('Case 5: after retro-tagging, Wed Easy is no longer struck');
      if (!tueDoneAfter) fail('THE EXACT ASSERTION REQUESTED: after retro-tagging to "interval", Tue Interval must now be struck, got ' + JSON.stringify(doneMap));
      else ok('Case 5: after retro-tagging and re-render, Tue Interval becomes struck instead');
    }
  }
}

async function main() {
  runPart1();
  await runPart2();
  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
}

main();
