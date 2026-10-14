// Smoke test — run this before every push touching the weekly-rhythm
// long-run cap (resolveLongRunCapForWeek/resolveLongRunCapForWeekMain,
// splitRhythmSessionsFixedGrowth/splitRhythmSessionsFixedGrowthMain in
// api/training.js and main.html, or the "Next weeks" preview header).
//
//   node tests/smoke-rhythm-cap-golden.cjs
//
// Two things, both against the REAL extracted functions:
//
// 1. Cross-checks the server and client implementations against each
//    other for all 31 weeks, under two scenarios (a real cap with a
//    single-week override, and an entirely empty/unset cap) — fails
//    on ANY divergence between the two copies, standing in for "one
//    shared implementation" since this project duplicates small
//    pieces of logic per file by established convention.
//
// 2. The golden sequence of long-run sizes for weeks 1-31 of the
//    active plan's own real weekly targets (mirrors plan.html's own
//    PLAN_BACKFILL_DISCIPLINES table, weeks 4-34 original numbering =
//    this restarted plan's weeks 1-31 — see that file's own "PLAN
//    RESTART PREP" comments), with cap 15 and a ONE-WEEK-ONLY
//    override of 14 for the week of Mon 2027-02-15 (week 19) — and,
//    separately, with NO cap configured at all, asserting the long
//    run is capped at the documented default (10) starting week 3.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROW_DIR = path.join(__dirname, '..');
let failures = 0;
function fail(msg) { failures++; console.log('FAIL:', msg); }
function ok(msg) { console.log('PASS:', msg); }

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('could not find ' + name + ' — test extraction markers are stale');
  const braceStart = src.indexOf('{', start);
  let depth = 0, end = -1;
  for (let j = braceStart; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  return src.slice(start, end);
}

const srcTraining = fs.readFileSync(path.join(ROW_DIR, 'api', 'training.js'), 'utf8');
const srcMain = fs.readFileSync(path.join(ROW_DIR, 'main.html'), 'utf8');

const serverSandbox = {};
vm.createContext(serverSandbox);
vm.runInContext(
  'const RHYTHM_LONG_RUN_CAP_DEFAULT_KM = 10;\n' +
  extractFn(srcTraining, 'round0_5') + '\n' +
  extractFn(srcTraining, 'resolveLongRunCapForWeek') + '\n' +
  extractFn(srcTraining, 'splitRhythmSessionsFixedGrowth') +
  '\nthis.resolveLongRunCapForWeek = resolveLongRunCapForWeek; this.splitRhythmSessionsFixedGrowth = splitRhythmSessionsFixedGrowth;',
  serverSandbox
);
const clientSandbox = {};
vm.createContext(clientSandbox);
vm.runInContext(
  'const RHYTHM_LONG_RUN_CAP_DEFAULT_KM_MAIN = 10;\n' +
  extractFn(srcMain, 'resolveLongRunCapForWeekMain') + '\n' +
  extractFn(srcMain, 'round0_5Main') + '\n' +
  extractFn(srcMain, 'splitRhythmSessionsFixedGrowthMain') +
  '\nthis.resolveLongRunCapForWeekMain = resolveLongRunCapForWeekMain; this.splitRhythmSessionsFixedGrowthMain = splitRhythmSessionsFixedGrowthMain;',
  clientSandbox
);

const REF_ENTRIES = [{ kind: 'interval', km: 3 }, { kind: 'easy', km: 5 }, { kind: 'pace', km: 5 }, { kind: 'long', km: null }];
const FIRST_WEEK_KM = 20;
const MIN_SESSION_KM = 3;

// Weekly run targets, weeks 1-31 of the active plan (this restarted
// plan's own numbering — see the header comment above).
const TARGETS = [20, 22, 24, 18, 22, 24, 24, 18, 22, 24, 26, 20, 24, 26, 26, 20, 24, 26, 28, 21, 26, 28, 28, 21, 26, 26, 26, 20, 18, 12, 5];
function addWeeksKey(mondayKey, n) {
  const d = new Date(mondayKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n * 7);
  return d.toISOString().slice(0, 10);
}
const MONDAYS = [];
for (let i = 0; i < 31; i++) MONDAYS.push(addWeeksKey('2026-10-12', i));
if (MONDAYS[18] !== '2027-02-15') fail('test setup: week 19\'s own Monday should be 2027-02-15, got ' + MONDAYS[18]);

// Golden expected long-run size per week (point 3 of the report),
// cap 15 with a single-week override of 14 at week 19 only.
// 'merged' means the week is too small to hold every session at a
// sane size (weeks 30/31 taper/race week).
const GOLDEN_WITH_CAP = [7, 9, 11, 6.5, 9, 11, 11, 6.5, 9, 11, 13, 7, 11, 13, 13, 7, 11, 13, 14, 8, 13, 15, 15, 8, 13, 13, 13, 7, 6.5, 'merged', 'merged'];
const GOLDEN_WEEK19_EASY = 6; // "14 (with easy 6)" — the surplus overflow after long hits the override cap of 14

function runScenario(rhythm, golden, label) {
  console.log('\n--- ' + label + ' ---');
  let allMatch = true;
  let crossCheckOk = true;
  for (let i = 0; i < 31; i++) {
    const weekKm = TARGETS[i];
    const monday = MONDAYS[i];
    const capServer = serverSandbox.resolveLongRunCapForWeek(rhythm, monday);
    const capClient = clientSandbox.resolveLongRunCapForWeekMain(rhythm, monday);
    if (capServer !== capClient) { crossCheckOk = false; console.log('  cap mismatch week' + (i + 1) + ': server=' + capServer + ' client=' + capClient); }
    const splitServer = serverSandbox.splitRhythmSessionsFixedGrowth(REF_ENTRIES.map((e) => Object.assign({}, e)), FIRST_WEEK_KM, weekKm, capServer, MIN_SESSION_KM);
    const splitClient = clientSandbox.splitRhythmSessionsFixedGrowthMain(REF_ENTRIES.map((e) => Object.assign({}, e)), FIRST_WEEK_KM, weekKm, capClient, MIN_SESSION_KM);
    const serverKms = JSON.stringify(splitServer.sessions.map((s) => s.km));
    const clientKms = JSON.stringify(splitClient.sessions.map((s) => s.km));
    if (serverKms !== clientKms || JSON.stringify(splitServer.dropped) !== JSON.stringify(splitClient.dropped)) {
      crossCheckOk = false;
      console.log('  split mismatch week' + (i + 1) + ': server=' + serverKms + ' client=' + clientKms);
    }
    const longSession = splitServer.sessions.find((s) => s.kind === 'long');
    const got = splitServer.dropped.length ? 'merged' : (longSession ? longSession.km : null);
    if (JSON.stringify(got) !== JSON.stringify(golden[i])) {
      allMatch = false;
      console.log('  week' + (i + 1) + ' (target ' + weekKm + 'km, cap ' + capServer + 'km): expected long=' + JSON.stringify(golden[i]) + ', got ' + JSON.stringify(got));
    }
    if (i === 18 && golden === GOLDEN_WITH_CAP) {
      const easySession = splitServer.sessions.find((s) => s.kind === 'easy');
      if (!easySession || easySession.km !== GOLDEN_WEEK19_EASY) {
        allMatch = false;
        console.log('  week19 easy mismatch: expected ' + GOLDEN_WEEK19_EASY + ', got ' + (easySession && easySession.km));
      }
    }
  }
  if (crossCheckOk) ok(label + ': server and client implementations match exactly across all 31 weeks');
  else fail(label + ': server/client implementations diverged on at least one week (see above)');
  if (allMatch) ok(label + ': the golden long-run sequence for weeks 1-31 matches exactly');
  else fail(label + ': the golden long-run sequence diverged on at least one week (see above)');
}

runScenario({ longRunCapKm: 15, longRunCapOverrides: [{ from: '2027-02-15', to: '2027-02-15', km: 14 }] }, GOLDEN_WITH_CAP, 'cap=15, single-week override 14 @ week 19 (Mon 2027-02-15)');

// Golden sequence with NO cap configured at all -- resolves to the
// documented default (10) everywhere, capped from week 3 onward.
const GOLDEN_EMPTY_CAP = GOLDEN_WITH_CAP.map((v, i) => {
  if (typeof v !== 'number') return v;
  const target = TARGETS[i];
  const baseline = 7; // long's own reference-week baseline
  if (target < FIRST_WEEK_KM) return v; // deload/taper weeks are unaffected by the cap at all
  const grow = Math.min(target - FIRST_WEEK_KM, 10 - baseline);
  return Math.round((baseline + grow) * 2) / 2;
});
runScenario({}, GOLDEN_EMPTY_CAP, 'EMPTY cap (no longRunCapKm set at all) -- must resolve to the documented default (10)');
if (GOLDEN_EMPTY_CAP[2] !== 10) fail('test setup: week 3 should be exactly capped at 10 with an empty cap, got ' + GOLDEN_EMPTY_CAP[2]);
else ok('empty-cap scenario: week 3 is exactly capped at the documented default (10), confirming "capped from week 3"');

// ---------------------------------------------------------------
// Part 2 — the preview table's header shows the effective cap and
// any date overrides (point 2 of the report), on the real main.html
// page.
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
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

const RHYTHM = {
  tuesday: [{ discipline: 'run', kind: 'interval', km: 3 }],
  wednesday: [{ discipline: 'run', kind: 'easy', km: 5 }],
  friday: [{ discipline: 'run', kind: 'pace', km: 5 }],
  sunday: [{ discipline: 'run', kind: 'long' }],
  longRunCapKm: 15,
  longRunCapOverrides: [{ from: '2027-02-15', to: '2027-02-15', km: 14 }],
};
const PLANS = [{
  id: 'p1', status: 'active', startDate: '2026-10-12',
  weeklyCheckpoints: [{ weekNumber: 1, weekStartDate: '2026-10-12', disciplines: { run: { km: 20 } } }],
}];

async function runHeaderCheck() {
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
    if (u.includes('resource=plans')) body = { ok: true, plans: PLANS };
    else if (u.includes('resource=activity-types')) body = { ok: true, types: [{ id: 'run1', name: 'Running', unit: 'km', unitKind: 'distance', recommendable: true }] };
    else if (u.includes('resource=restrictions')) body = { ok: true, restrictions: [] };
    else if (u.includes('resource=weekly-rhythm')) body = { ok: true, rhythm: RHYTHM };
    else if (u.includes('resource=training-availability')) body = { ok: true, availability: null };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) });
  };

  await wait(1200);
  if (consoleErrors.length) { fail('header check: page load produced ' + consoleErrors.length + ' console error(s): ' + consoleErrors.join(' | ')); return; }

  window.document.getElementById('generalSettingsGearBtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await wait(400);
  window.document.getElementById('gsRhythmPreviewToggleBtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await wait(400);

  const headerEl = window.document.querySelector('.gs-rhythm-preview-header');
  if (!headerEl) { fail('THE EXACT ASSERTION REQUESTED: the "Next weeks" table header must show the effective cap and overrides, but no header element rendered at all'); return; }
  const headerText = headerEl.textContent;
  if (!/15km/.test(headerText)) fail('header must show the effective default cap (15km), got: ' + JSON.stringify(headerText));
  else ok('header shows the effective default cap (15km)');
  if (!/2027-02-15/.test(headerText) || !/14km/.test(headerText)) fail('header must show the configured override (2027-02-15, 14km), got: ' + JSON.stringify(headerText));
  else ok('header shows the configured override (2027-02-15 = 14km)');

  if (consoleErrors.length) fail('header check: console/script errors appeared during the click flow (see above)');
}

async function main() {
  await runHeaderCheck();
  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
}

main();
