// Smoke test — run this before every push touching Today's session
// card's staleness detection (computeTodayCardSignature /
// isLayoutDayFullyDone / showCachedTodayRecommendationOrPrompt /
// activitySave in gym.html).
//
//   node tests/smoke-today-card-staleness.cjs
//
// TODAY_REC_CACHE_KEY used to invalidate ONLY when the calendar date
// changed, never when new activity was logged — so the card kept
// showing whatever was cached from the last refresh all day. This
// never calls the AI on its own: a stale cache just shows a small
// "Outdated — tap refresh to update" note (computed, free) while
// still displaying the cached text, OR — if every one of today's real
// sessions is already done — a fully code-computed "Done for today!"
// state that outranks the cache entirely.
//
// Part 1: computeTodayCardSignature / isLayoutDayFullyDone, extracted
// verbatim — the signature only changes when it should, and "done"
// matches tpLayoutDays' own isDone definition exactly.
// Part 2: the real gym.html page — cache+same signature (no note),
// logging a new activity (note appears, no new network call), a
// retro-tag via "Set kind" (note appears), every session done ("Done
// for today!"), and a stale cached dateKey (dropped, as before).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROW_DIR = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROW_DIR, 'gym.html'), 'utf8');
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

// ---------------------------------------------------------------
// Part 1 — computeTodayCardSignature / isLayoutDayFullyDone, extracted.
// ---------------------------------------------------------------
function runPart1() {
  const sandbox = { activityEntries: [], window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROW_DIR, 'daylib.js'), 'utf8'), sandbox);
  sandbox.DayLib = sandbox.window.DayLib;
  sandbox.DayLib.loadProfile = () => ({});
  const block = [
    extractFn('dateKey'),
    extractFn('mondayOf'),
    extractFn('thisWeekMondayKey'),
    extractFn('computeTodayCardSignature'),
    extractFn('isLayoutDayFullyDone'),
  ].join('\n');
  vm.runInContext(
    block + '\nthis.computeTodayCardSignature = computeTodayCardSignature; this.isLayoutDayFullyDone = isLayoutDayFullyDone; this.disciplineForActivityType = function(id){ return id === "run1" ? "run" : null; };',
    sandbox
  );
  // thisWeekMondayKey calls DayLib.effectiveDateKey() with no args —
  // pin "now" the same way every real-page test in this suite does.
  sandbox.Date = class extends Date {
    constructor(...args) { return args.length ? new Date(...args) : new Date('2026-10-14T12:00:00Z'); }
    static now() { return new Date('2026-10-14T12:00:00Z').getTime(); }
  };

  const stored1 = { generatedAt: 'g1', plan: { rebalance: { computedForDateKey: '2026-10-14' } } };
  sandbox.activityEntries = [{ id: 'a1', dateKey: '2026-10-14', kind: 'easy' }];
  const sig1 = sandbox.computeTodayCardSignature(stored1);
  const sig1Again = sandbox.computeTodayCardSignature(stored1);
  if (sig1 !== sig1Again) fail('computeTodayCardSignature: identical inputs must produce identical signatures');
  else ok('computeTodayCardSignature: identical inputs produce identical signatures');

  sandbox.activityEntries = [{ id: 'a1', dateKey: '2026-10-14', kind: 'easy' }, { id: 'a2', dateKey: '2026-10-14', kind: 'pace' }];
  const sig2 = sandbox.computeTodayCardSignature(stored1);
  if (sig2 === sig1) fail('THE EXACT ASSERTION REQUESTED: logging a new activity must change the signature, got identical signatures');
  else ok('computeTodayCardSignature: a new logged activity changes the signature');

  sandbox.activityEntries = [{ id: 'a1', dateKey: '2026-10-14', kind: 'interval' }];
  const sig3 = sandbox.computeTodayCardSignature(stored1);
  if (sig3 === sig1) fail('THE EXACT ASSERTION REQUESTED: retro-tagging a kind must change the signature, got identical signatures');
  else ok('computeTodayCardSignature: retro-tagging an activity\'s kind changes the signature');

  sandbox.activityEntries = [{ id: 'a1', dateKey: '2026-10-14', kind: 'easy' }];
  const stored2 = { generatedAt: 'g1', plan: { rebalance: { computedForDateKey: '2026-10-15' } } };
  const sig4 = sandbox.computeTodayCardSignature(stored2);
  if (sig4 === sig1) fail('a rebalance/plan version change must change the signature, got identical signatures');
  else ok('computeTodayCardSignature: a plan/rebalance version change also changes the signature');

  const doneDay = { dateKey: '2026-10-14', sessions: [{ discipline: 'run', kind: 'easy' }] };
  const claimed = new Set([doneDay.sessions[0]]);
  if (!sandbox.isLayoutDayFullyDone(doneDay, claimed, {})) fail('isLayoutDayFullyDone: a claimed session must count as done');
  else ok('isLayoutDayFullyDone: a kind-claimed session counts as done');
  if (sandbox.isLayoutDayFullyDone(doneDay, new Set(), {})) fail('isLayoutDayFullyDone: an unclaimed, unlogged session must NOT count as done');
  else ok('isLayoutDayFullyDone: an unclaimed session correctly is not done');
  const strengthDay = { dateKey: '2026-10-14', sessions: [{ discipline: 'strength', kind: 'push' }] };
  if (!sandbox.isLayoutDayFullyDone(strengthDay, new Set(), { '2026-10-14': true })) fail('isLayoutDayFullyDone: strength must use doneDaysMap');
  else ok('isLayoutDayFullyDone: strength correctly checked via doneDaysMap');
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

// Two sessions today (run + swim) — so logging/tagging just the run
// leaves the day NOT fully done, cleanly exercising the "outdated
// note" path without it flipping into the "done for today" state.
const WEEK_PLAN = {
  targets: { run: { km: 20, activityTypeId: 'run1', activityName: 'Running' } },
  strength: { targetSessions: 0, focus: '' },
  cardio: { interval: { targetSessions: 0, targetMinutes: 0 }, longSession: {}, easyVolume: {} },
  layout: [
    { weekday: 'wednesday', dateKey: '2026-10-14', sessions: [
      { discipline: 'run', kind: 'easy', activityTypeId: 'run1', activityName: 'Running', targetAmount: 5, unit: 'km', estMinutes: 30 },
      { discipline: 'swim', kind: 'pace', activityTypeId: 'swim1', activityName: 'Swimming', targetAmount: 1000, unit: 'm', estMinutes: 30 },
    ] },
    { weekday: 'thursday', dateKey: '2026-10-15', sessions: [{ discipline: 'run', kind: 'pace', activityTypeId: 'run1', activityName: 'Running', targetAmount: 6, unit: 'km', estMinutes: 36 }] },
  ],
  unplaced: [], rationale: 'Week 1.',
};
// Case 4's own plan — a SINGLE session today, so logging it alone
// genuinely completes the whole day.
const WEEK_PLAN_SINGLE = {
  targets: { run: { km: 20, activityTypeId: 'run1', activityName: 'Running' } },
  strength: { targetSessions: 0, focus: '' },
  cardio: { interval: { targetSessions: 0, targetMinutes: 0 }, longSession: {}, easyVolume: {} },
  layout: [
    { weekday: 'wednesday', dateKey: '2026-10-14', sessions: [{ discipline: 'run', kind: 'easy', activityTypeId: 'run1', activityName: 'Running', targetAmount: 5, unit: 'km', estMinutes: 30 }] },
    { weekday: 'thursday', dateKey: '2026-10-15', sessions: [{ discipline: 'run', kind: 'pace', activityTypeId: 'run1', activityName: 'Running', targetAmount: 6, unit: 'km', estMinutes: 36 }] },
  ],
  unplaced: [], rationale: 'Week 1.',
};

async function loadPage(options) {
  const opts = options || {};
  const html = buildHtml();
  const consoleErrors = [];
  const fetchLog = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => consoleErrors.push('JSDOM: ' + (e.stack || e.message)));
  virtualConsole.on('error', (...args) => consoleErrors.push(args.map(String).join(' ')));
  const dom = new JSDOM(html, {
    url: 'https://row.test/gym.html', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(win) {
      pinClock(win, '2026-10-14T12:00:00Z'); // Wednesday, pinned regardless of actual wall-clock date
      win.localStorage.setItem('dashboard:secret', 'test-secret');
      win.sessionStorage.setItem('dashboard:unlocked', '1');
      win.localStorage.setItem('po_coach_weekly_plan_v1', JSON.stringify({ weekStart: '2026-10-12', plan: opts.plan || WEEK_PLAN, generatedAt: opts.generatedAt || 'g1' }));
      win.localStorage.setItem('po_coach_activities', JSON.stringify(opts.activities || []));
      if (opts.cache) win.localStorage.setItem('po_coach_today_recommendation_v1', JSON.stringify(opts.cache));
      win.fetch = (url) => {
        const u = String(url);
        fetchLog.push(u);
        let body = { ok: true };
        if (u.includes('resource=plans')) body = { ok: true, plans: [] };
        else if (u.includes('resource=activity-types')) body = { ok: true, types: [{ id: 'run1', name: 'Running', unit: 'km', unitKind: 'distance', recommendable: true }, { id: 'swim1', name: 'Swimming', unit: 'm', unitKind: 'distance', recommendable: true }] };
        else if (u.includes('resource=restrictions')) body = { ok: true, restrictions: [] };
        else if (u.includes('resource=weekly-rhythm')) body = { ok: true, rhythm: {} };
        else if (u.includes('mode=today')) body = { ok: true, recommendation: 'Fresh pick from the AI' };
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
  return { window, consoleErrors, fetchLog };
}

async function runPart2() {
  // --- Setup pass: load a page, click refresh once, capture the
  // REAL signature the app itself computed for this exact plan/
  // activity state (avoids hand-duplicating the formula). ---
  const { window: setupWin, consoleErrors: setupErrors } = await loadPage({ activities: [] });
  if (setupErrors.length) fail('setup: page load produced console error(s): ' + setupErrors.join(' | '));
  setupWin.document.getElementById('ttRefreshBtn').dispatchEvent(new setupWin.Event('click', { bubbles: true }));
  await wait(800);
  const writtenCache = JSON.parse(setupWin.localStorage.getItem('po_coach_today_recommendation_v1'));
  if (!writtenCache || !writtenCache.signature) {
    fail('setup: a refresh must write a cache entry with a signature, got ' + JSON.stringify(writtenCache));
  } else {
    ok('setup: a refresh writes a cache entry carrying a real signature');
  }
  if (setupWin.document.getElementById('ttOutdated').style.display !== 'none') {
    fail('setup: right after a fresh refresh, the outdated note must be hidden');
  } else {
    ok('setup: right after a fresh refresh, the outdated note is hidden');
  }
  // The signature's own plan-version component reads stored.generatedAt
  // and stored.plan.rebalance — captured here (rather than re-seeding
  // the static WEEK_PLAN fixture fresh) so cases 1-3 start from the
  // EXACT plan state the signature above was actually computed from.
  const finalStoredPlanRaw = JSON.parse(setupWin.localStorage.getItem('po_coach_weekly_plan_v1'));

  // --- Case 1 — a fresh page load with the SAME activities/plan the
  // cache was computed against -> no outdated note. ---
  {
    const { window, consoleErrors } = await loadPage({ activities: [], cache: writtenCache, plan: finalStoredPlanRaw.plan, generatedAt: finalStoredPlanRaw.generatedAt });
    if (consoleErrors.length) fail('Case 1: page load produced console error(s): ' + consoleErrors.join(' | '));
    if (window.document.getElementById('ttText').textContent !== writtenCache.recommendation) {
      fail('Case 1: the cached recommendation must still be shown, got ' + JSON.stringify(window.document.getElementById('ttText').textContent));
    }
    if (window.document.getElementById('ttOutdated').style.display !== 'none') {
      fail('THE EXACT ASSERTION REQUESTED: Case 1 — matching signature must show no outdated note, got display=' + window.document.getElementById('ttOutdated').style.display);
    } else {
      ok('Case 1: cache + matching signature -> no outdated note');
    }
  }

  // --- Case 2 — log a NEW activity via the manual form -> outdated
  // note appears; no new network/AI call fires (staleness detection
  // is code-only). ---
  {
    const { window, consoleErrors, fetchLog } = await loadPage({ activities: [], cache: writtenCache, plan: finalStoredPlanRaw.plan, generatedAt: finalStoredPlanRaw.generatedAt });
    if (consoleErrors.length) fail('Case 2: page load produced console error(s): ' + consoleErrors.join(' | '));
    const beforeCount = fetchLog.length;
    window.document.getElementById('runDistanceInput').value = '5';
    window.document.getElementById('runDurationInput').value = '30';
    window.document.getElementById('runSaveBtn').dispatchEvent(new window.Event('click', { bubbles: true }));
    await wait(300);
    if (window.document.getElementById('ttOutdated').style.display !== 'block') {
      fail('THE EXACT ASSERTION REQUESTED: Case 2 — logging a new activity must show the outdated note, got display=' + window.document.getElementById('ttOutdated').style.display);
    } else {
      ok('Case 2: logging a new activity shows the outdated note');
    }
    const newFetches = fetchLog.slice(beforeCount);
    if (newFetches.some((u) => u.includes('mode=today') || u.includes('anthropic'))) {
      fail('THE EXACT ASSERTION REQUESTED: Case 2 — staleness detection must never fire an AI/network call on its own, got ' + JSON.stringify(newFetches));
    } else {
      ok('Case 2: no mode=today/AI network call fired on its own (' + newFetches.length + ' unrelated request(s))');
    }
    // Fueling re-renders from the live, code-only session list — still
    // works regardless of the stale title text.
    if (!window.document.getElementById('ttFueling')) fail('Case 2: the Fueling container must still exist');
    else ok('Case 2: the code-only Fueling card is still present/updated');
  }

  // --- Case 3 — retro-tag a kind via the History list's "Set kind"
  // select -> outdated note appears. ---
  {
    const activities = [{ id: 'a1', dateKey: '2026-10-14', activityTypeId: 'run1', distanceKm: 5, durationMin: 30, effort: null, notes: '' }];
    const { window, consoleErrors } = await loadPage({ activities, cache: writtenCache, plan: finalStoredPlanRaw.plan, generatedAt: finalStoredPlanRaw.generatedAt });
    if (consoleErrors.length) fail('Case 3: page load produced console error(s): ' + consoleErrors.join(' | '));
    const kindSelect = window.document.querySelector('.th-kind-select[data-activity-id="a1"]');
    if (!kindSelect) {
      fail('Case 3: expected a "Set kind" select for activity a1');
    } else {
      kindSelect.value = 'easy';
      kindSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
      await wait(300);
      if (window.document.getElementById('ttOutdated').style.display !== 'block') {
        fail('THE EXACT ASSERTION REQUESTED: Case 3 — retro-tagging a kind must show the outdated note, got display=' + window.document.getElementById('ttOutdated').style.display);
      } else {
        ok('Case 3: retro-tagging a kind via "Set kind" shows the outdated note');
      }
    }
  }

  // --- Case 4 — every one of today's real sessions is already done
  // -> "Done for today!" state (code-only), mentioning tomorrow's
  // first session, regardless of whatever's cached. ---
  {
    const activities = [{ id: 'a1', dateKey: '2026-10-14', activityTypeId: 'run1', distanceKm: 5, durationMin: 30, effort: null, notes: '' }];
    const staleCache = Object.assign({}, writtenCache, { signature: 'definitely-not-matching' });
    const { window, consoleErrors } = await loadPage({ activities, cache: staleCache, plan: WEEK_PLAN_SINGLE });
    if (consoleErrors.length) fail('Case 4: page load produced console error(s): ' + consoleErrors.join(' | '));
    console.log('\n--- Case 4 "Done for today" text dump ---');
    console.log('ttText=' + JSON.stringify(window.document.getElementById('ttText').textContent) + ' ttOutdated.display=' + window.document.getElementById('ttOutdated').style.display);
    const text = window.document.getElementById('ttText').textContent;
    if (!/^Done for today!/.test(text)) {
      fail('THE EXACT ASSERTION REQUESTED: Case 4 — every session done must show "Done for today!", got ' + JSON.stringify(text));
    } else {
      ok('Case 4: "Done for today!" shown when every real session is done');
    }
    if (!/Tomorrow:/.test(text) || !/Pace/.test(text)) {
      fail('Case 4: the done state must mention tomorrow\'s first session (Run Pace), got ' + JSON.stringify(text));
    } else {
      ok('Case 4: tomorrow\'s first session is mentioned — ' + JSON.stringify(text));
    }
    if (window.document.getElementById('ttOutdated').style.display !== 'none') {
      fail('Case 4: the done state must not also show the outdated note, got display=' + window.document.getElementById('ttOutdated').style.display);
    } else {
      ok('Case 4: the done state hides the outdated note (it has already superseded the stale cache)');
    }
  }

  // --- Case 5 — a cached dateKey from a DIFFERENT day is dropped,
  // exactly as before this feature existed. ---
  {
    const staleDateCache = Object.assign({}, writtenCache, { dateKey: '2026-10-13' });
    const { window, consoleErrors } = await loadPage({ activities: [], cache: staleDateCache });
    if (consoleErrors.length) fail('Case 5: page load produced console error(s): ' + consoleErrors.join(' | '));
    console.log('\n--- Case 5 "stale date" text dump ---');
    console.log('ttText=' + JSON.stringify(window.document.getElementById('ttText').textContent));
    if (window.document.getElementById('ttText').textContent !== 'Tap refresh for today\'s pick.') {
      fail('THE EXACT ASSERTION REQUESTED: Case 5 — a cache from a different day must be dropped, got ' + JSON.stringify(window.document.getElementById('ttText').textContent));
    } else {
      ok('Case 5: a cached entry from a different day is dropped, same as before this feature existed');
    }
    if (window.document.getElementById('ttOutdated').style.display !== 'none') {
      fail('Case 5: no outdated note should show once the stale-dated cache is dropped entirely');
    } else {
      ok('Case 5: no outdated note shown once the stale-dated cache is dropped');
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
