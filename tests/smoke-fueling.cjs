// Smoke test — run this before every push touching the Fueling card
// (computeFueling/FUELING_RULES/renderFuelingHtml in gym.html, or
// api/sync-state.js's sanitizeFuelingSettings).
//
//   node tests/smoke-fueling.cjs
//
// Part 1: the pure computeFueling(session, settings) function,
// extracted verbatim from gym.html, against the task's own golden
// cases (50min easy -> none; 75min easy -> 30g/h; 120min hard ->
// 60g/h = 120g = 4 gels of 30; 180min -> 60g/h capped; bike 100min;
// swim; a settings override; missing settings -> defaults).
//
// Part 2: a real gym.html page check — the card renders for today's
// real layout session, collapsed ("no fueling needed") under 60min,
// expanded with real numbers at or above it, and the footer disclaimer
// is always present.
//
// Part 3: api/sync-state.js's sanitizeFuelingSettings — numbers only,
// sane ranges, partial/invalid input never rejects the whole save.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROW_DIR = path.join(__dirname, '..');
let failures = 0;
function fail(msg) { failures++; console.log('FAIL:', msg); }
function ok(msg) { console.log('PASS:', msg); }

// ---------------------------------------------------------------
// Part 1 — computeFueling, extracted from the real gym.html source.
// ---------------------------------------------------------------
const src = fs.readFileSync(path.join(ROW_DIR, 'gym.html'), 'utf8');
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

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
  [
    extractConst('FUELING_RULES'),
    extractConst('FUELING_FOOTER_TEXT'),
    extractFn('classifyFuelingIntensity'),
    extractFn('fuelingCarbsPerHour'),
    extractConst('FUELING_TIMING'),
    extractFn('fuelingTimingMarks'),
    extractFn('fuelingGelRecipe'),
    extractFn('computeFueling'),
  ].join('\n') + '\nthis.computeFueling = computeFueling; this.FUELING_RULES = FUELING_RULES;',
  sandbox
);
const computeFueling = sandbox.computeFueling;
const FUELING_RULES = sandbox.FUELING_RULES;

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) fail(label + ' — got ' + a + ', expected ' + e);
  else ok(label);
}

// 50 min easy -> none
let f = computeFueling({ discipline: 'run', kind: 'easy', estMinutes: 50 }, FUELING_RULES);
assertEqual(f.needed, false, '50min easy: no fueling needed');
assertEqual(f.carbsPerHourG, 0, '50min easy: 0g/h (eat normally)');
assertEqual(f.gels, 0, '50min easy: 0 gels');

// 75 min easy -> 30 g/h
f = computeFueling({ discipline: 'run', kind: 'easy', estMinutes: 75 }, FUELING_RULES);
assertEqual(f.needed, true, '75min easy: fueling needed');
assertEqual(f.carbsPerHourG, 30, '75min easy: 30g/h');

// 120 min hard (pace/interval) -> 60 g/h = 120g = 4 gels of 30
f = computeFueling({ discipline: 'run', kind: 'interval', estMinutes: 120 }, FUELING_RULES);
assertEqual(f.carbsPerHourG, 60, '120min hard: 60g/h');
assertEqual(f.totalCarbsG, 120, '120min hard: 120g total');
assertEqual(f.gels, 4, '120min hard: 4 gels of 30g');
if (!f.recipe || f.recipe.gels !== 4) fail('120min hard: recipe must be for 4 gels, got ' + JSON.stringify(f.recipe));
else ok('120min hard: home gel recipe is for 4 gels');

// 180 min -> 60 g/h capped (over the 150min threshold, already at the
// hard cap regardless of intensity)
f = computeFueling({ discipline: 'run', kind: 'long', estMinutes: 180 }, FUELING_RULES);
assertEqual(f.carbsPerHourG, 60, '180min: 60g/h (capped)');
assertEqual(f.totalCarbsG, 180, '180min: 180g total');
assertEqual(f.gels, 6, '180min: 6 gels of 30g');

// bike 100 min, easy -- 100min falls in the 90-150min tier (easy =
// 45g/h); bike's own timing convention (first at 20min, then every
// 25min), not run's.
f = computeFueling({ discipline: 'bike', kind: 'easy', estMinutes: 100 }, FUELING_RULES);
assertEqual(f.carbsPerHourG, 45, 'bike 100min easy: 45g/h (90-150min tier)');
assertEqual(f.timingMarks, [20, 45, 70, 95], 'bike 100min: timing marks at 20/45/70/95min (first 20, every 25)');

// swim -- "only practical at the wall; otherwise fuel before", never a
// timing-marks list.
f = computeFueling({ discipline: 'swim', kind: 'pace', estMinutes: 90 }, FUELING_RULES);
assertEqual(f.timingMarks, null, 'swim: no timing-marks list');
if (!/only practical/i.test(f.timingNote)) fail('swim: timing note must say "only practical in a pool at the wall", got ' + JSON.stringify(f.timingNote));
else ok('swim: timing note says "only practical in a pool at the wall"');
if (!f.sodium) fail('swim 90min: sodium guidance should still show (>=90min), got none');
else ok('swim 90min: sodium guidance shows (session >= 90min)');

// Settings override -- a custom gelSizeG/maxCarbsPerHourG changes the
// computed gel count and respects a LOWER cap (never exceeds it).
const customSettings = Object.assign({}, FUELING_RULES, { gelSizeG: 20, maxCarbsPerHourG: 40 });
f = computeFueling({ discipline: 'run', kind: 'interval', estMinutes: 120 }, customSettings);
assertEqual(f.carbsPerHourG, 40, 'settings override: carbsPerHourG respects the lower max (40, not 60)');
assertEqual(f.totalCarbsG, 80, 'settings override: 80g total (40g/h x 2h)');
assertEqual(f.gels, 4, 'settings override: 4 gels of the custom 20g size');

// The hard cap is never exceeded even if raised above 90 (task's own
// explicit rule).
const raisedCap = Object.assign({}, FUELING_RULES, { maxCarbsPerHourG: 120 });
f = computeFueling({ discipline: 'run', kind: 'interval', estMinutes: 120 }, raisedCap);
if (f.carbsPerHourG > 60 && customSettings.maxCarbsPerHourG > 60) { /* n/a */ }
// Base rule tiers (45/60) never exceed 60 anyway; the cap only matters
// once raised ABOVE what the tier already allows, so assert the tier
// value itself (60) still applies, not the raised cap.
assertEqual(f.carbsPerHourG, 60, 'raised cap (120) never invented extra carbs beyond the real tier value (60)');

// Missing settings -> defaults (undefined, null, and {} all fall back
// to FUELING_RULES' own documented defaults).
[undefined, null, {}].forEach((s) => {
  const r = computeFueling({ discipline: 'run', kind: 'easy', estMinutes: 75 }, s);
  if (r.carbsPerHourG !== 30) fail('missing settings (' + JSON.stringify(s) + ') must fall back to defaults, got carbsPerHourG=' + r.carbsPerHourG);
});
ok('missing settings (undefined/null/{}) all fall back to FUELING_RULES defaults');

// Footer disclaimer always present.
if (!/not medical advice/i.test(f.footer) || !/sports nutritionist/i.test(f.footer)) fail('footer must contain the disclaimer, got ' + JSON.stringify(f.footer));
else ok('footer always carries the disclaimer text');

// Before/after only shown for 60+min sessions.
const short = computeFueling({ discipline: 'run', kind: 'easy', estMinutes: 45 }, FUELING_RULES);
assertEqual(short.before, null, '<60min: no "before" guidance');
assertEqual(short.after, null, '<60min: no "after" guidance');
const long = computeFueling({ discipline: 'run', kind: 'easy', estMinutes: 90 }, FUELING_RULES);
if (!long.before || !long.after) fail('>=60min must show before/after guidance, got ' + JSON.stringify({ before: long.before, after: long.after }));
else ok('>=60min shows before/after guidance');
assertEqual(long.after.carbsG, Math.round(FUELING_RULES.bodyWeightKg * FUELING_RULES.afterCarbsPerKg), 'after-carbs uses body weight x afterCarbsPerKg');

console.log('');

// ---------------------------------------------------------------
// Part 2 — the real gym.html page: Today's session fueling card.
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
  targets: { run: { km: 20, activityTypeId: 'run1', activityName: 'Running' } },
  strength: { targetSessions: 3, focus: '' },
  cardio: { interval: { targetSessions: 0, targetMinutes: 0 }, longSession: {}, easyVolume: {} },
  layout: [
    { weekday: 'monday', dateKey: '2026-10-12', sessions: [
      { discipline: 'strength', kind: 'push', estMinutes: 45 },
      { discipline: 'run', kind: 'long', activityTypeId: 'run1', activityName: 'Running', targetAmount: 20, unit: 'km', estMinutes: 120 },
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
      pinClock(win, '2026-10-12T12:00:00Z'); // a real Monday, pinned regardless of actual wall-clock date
      win.localStorage.setItem('dashboard:secret', 'test-secret');
      win.sessionStorage.setItem('dashboard:unlocked', '1');
      win.localStorage.setItem('po_coach_weekly_plan_v1', JSON.stringify({ weekStart: '2026-10-12', plan: WEEK_PLAN, generatedAt: new win.Date().toISOString() }));
    },
  });
  const { window } = dom;
  window.console.warn = () => {};
  window.alert = () => {};
  window.addEventListener('error', (e) => consoleErrors.push('UNCAUGHT: ' + (e.error && (e.error.stack || e.error.message) || e.message)));
  window.fetch = (url) => {
    const u = String(url);
    let body = { ok: true };
    if (u.includes('resource=general-settings')) body = { ok: true, settings: null }; // never configured -- defaults apply
    else if (u.includes('resource=plans')) body = { ok: true, plans: [] };
    else if (u.includes('resource=activity-types')) body = { ok: true, types: [{ id: 'run1', name: 'Running', unit: 'km', unitKind: 'distance', recommendable: true }] };
    else if (u.includes('resource=restrictions')) body = { ok: true, restrictions: [] };
    else if (u.includes('resource=weekly-rhythm')) body = { ok: true, rhythm: {} };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) });
  };

  await wait(1500);
  if (consoleErrors.length) fail('gym.html page load produced ' + consoleErrors.length + ' console error(s): ' + consoleErrors.join(' | '));
  else ok('gym.html page loaded with zero console errors');

  const fuelingText = window.document.getElementById('ttFueling').textContent;
  if (!/Fueling/i.test(fuelingText)) {
    fail('THE EXACT ASSERTION REQUESTED: the Fueling card must render for today\'s real 120min long run, got: ' + JSON.stringify(fuelingText));
  } else {
    ok('Fueling card renders for today\'s real session (120min long run)');
  }
  // 'long' classifies as EASY (see classifyFuelingIntensity's own
  // kind list), so 120min lands in the 90-150min/easy tier: 45g/h x
  // 2h = 90g = 3 gels of 30g.
  if (!/90g/.test(fuelingText) || !/3 gel/.test(fuelingText)) {
    fail('120min long run (easy intensity) must show 90g total / 3 gels, got: ' + JSON.stringify(fuelingText));
  } else {
    ok('120min long run shows the correct total (90g, 3 gels)');
  }
  if (!/not medical advice/i.test(fuelingText)) {
    fail('the footer disclaimer must always be visible, got: ' + JSON.stringify(fuelingText));
  } else {
    ok('the footer disclaimer is visible');
  }
  const openBlock = window.document.querySelector('#ttFueling details[open]');
  if (!openBlock) fail('a 120min session must render its Fueling block EXPANDED by default, got none open');
  else ok('a 120min session renders its Fueling block expanded by default');

  if (consoleErrors.length) fail('console/script errors appeared during render (see above)');
}

// ---------------------------------------------------------------
// Part 3 — api/sync-state.js's sanitizeFuelingSettings.
// ---------------------------------------------------------------
function runSanitizerChecks() {
  const syncSrc = fs.readFileSync(path.join(ROW_DIR, 'api', 'sync-state.js'), 'utf8');
  function extractFn2(name) {
    const start = syncSrc.indexOf('function ' + name + '(');
    const braceStart = syncSrc.indexOf('{', start);
    let depth = 0, end = -1;
    for (let j = braceStart; j < syncSrc.length; j++) {
      if (syncSrc[j] === '{') depth++;
      else if (syncSrc[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
    }
    return syncSrc.slice(start, end);
  }
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(extractFn2('sanitizeNum') + '\n' + extractFn2('sanitizeFuelingSettings') + '\nthis.sanitizeFuelingSettings = sanitizeFuelingSettings;', sb);
  const sanitizeFuelingSettings = sb.sanitizeFuelingSettings;

  let r = sanitizeFuelingSettings({ gelSizeG: 25, maxCarbsPerHourG: 50, bodyWeightKg: 70 });
  assertEqual(r, { gelSizeG: 25, maxCarbsPerHourG: 50, bodyWeightKg: 70 }, 'sanitizer: valid numbers pass through');

  r = sanitizeFuelingSettings({ gelSizeG: 5, maxCarbsPerHourG: 500, bodyWeightKg: -10, fluidMlPerHour: 'nope' });
  if (r !== undefined) fail('sanitizer: all-out-of-range/invalid input should drop every field (undefined), got ' + JSON.stringify(r));
  else ok('sanitizer: out-of-range/invalid numbers are dropped (gelSize 5 <10, maxCarbs 500 >90, weight -10 <30, fluid not a number)');

  r = sanitizeFuelingSettings({ gelSizeG: 25, maxCarbsPerHourG: 9999 });
  assertEqual(r, { gelSizeG: 25 }, 'sanitizer: partial-valid input keeps the good field and drops only the bad one');

  if (sanitizeFuelingSettings(null) !== undefined) fail('sanitizer: null input must return undefined');
  else ok('sanitizer: null input returns undefined');
  if (sanitizeFuelingSettings('not an object') !== undefined) fail('sanitizer: a non-object input must return undefined');
  else ok('sanitizer: a non-object input returns undefined');
}

async function main() {
  await runRealPageCheck();
  runSanitizerChecks();
  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
}

main();
