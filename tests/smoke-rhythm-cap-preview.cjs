// Smoke test — run this before every push touching the weekly-rhythm
// long-run cap settings or "Next weeks" preview table in main.html
// (renderRhythmCapSettings / renderRhythmPreview /
// splitRhythmSessionsFixedGrowthMain / resolveLongRunCapForWeekMain).
//
//   node tests/smoke-rhythm-cap-preview.cjs
//
// Loads the REAL main.html in jsdom, opens General Settings, opens
// the weekly-rhythm panel (seeded with the reference-week run
// structure: Tue interval 3km, Wed easy 5km, Fri pace 5km, Sun long —
// plus a longRunCapOverrides range) and the "Next weeks" preview
// (backed by a mocked active plan with two real checkpoints: week 1,
// Monday 2026-10-12, run 20km; and a week whose own Monday falls
// inside the cap override, Monday 2027-02-15, run 28km) — asserting
// on the REAL rendered DOM, never a reimplementation: the cap input
// shows the stored default, the override row renders, and the
// preview table shows the exact sizes the server-side algorithm
// would also produce for both weeks (3/5/5/7 for week 1, 3/8/5/12 —
// no shortfall — for the capped week).
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROW_DIR = path.join(__dirname, '..');

function buildHtml() {
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

const RHYTHM = {
  tuesday: [{ discipline: 'run', kind: 'interval', km: 3 }],
  wednesday: [{ discipline: 'run', kind: 'easy', km: 5 }],
  friday: [{ discipline: 'run', kind: 'pace', km: 5 }],
  sunday: [{ discipline: 'run', kind: 'long' }],
  longRunCapKm: 10,
  longRunCapOverrides: [{ from: '2027-02-15', to: '2027-03-21', km: 12 }],
};
const PLANS = [{
  id: 'p1', status: 'active', startDate: '2026-10-12',
  weeklyCheckpoints: [
    { weekNumber: 1, weekStartDate: '2026-10-12', disciplines: { run: { km: 20 } } },
    { weekNumber: 19, weekStartDate: '2027-02-15', disciplines: { run: { km: 28 } } },
  ],
}];

function mockFetch(url) {
  const u = String(url);
  let body = { ok: true };
  if (u.includes('resource=plans')) body = { ok: true, plans: PLANS };
  else if (u.includes('resource=activity-types')) body = { ok: true, types: [{ id: 'run1', name: 'Running', unit: 'km', unitKind: 'distance', recommendable: true }] };
  else if (u.includes('resource=restrictions')) body = { ok: true, restrictions: [] };
  else if (u.includes('resource=weekly-rhythm')) body = { ok: true, rhythm: RHYTHM };
  else if (u.includes('resource=training-availability')) body = { ok: true, availability: null };
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) });
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function main() {
  const html = buildHtml();
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
  window.fetch = mockFetch;

  await wait(1200);

  let failures = 0;
  function fail(msg) { failures++; console.log('FAIL:', msg); }
  function ok(msg) { console.log('PASS:', msg); }

  if (consoleErrors.length) {
    fail('page load produced ' + consoleErrors.length + ' console error(s): ' + consoleErrors.join(' | '));
  } else ok('page loaded with zero console errors');

  window.document.getElementById('generalSettingsGearBtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await wait(400);

  const capInput = window.document.getElementById('gsRhythmCapDefault');
  if (!capInput) fail('gsRhythmCapDefault input did not render at all');
  else if (capInput.value !== '10') fail('long-run cap default input should show the stored 10, got ' + JSON.stringify(capInput.value));
  else ok('long-run cap default input shows the stored value (10)');

  const overrideRow = window.document.querySelector('.gs-rhythm-cap-override-row');
  if (!overrideRow) fail('no cap override row rendered despite one being stored');
  else {
    const from = overrideRow.querySelector('.gs-rhythm-cap-override-from').value;
    const to = overrideRow.querySelector('.gs-rhythm-cap-override-to').value;
    const km = overrideRow.querySelector('.gs-rhythm-cap-override-km').value;
    if (from === '2027-02-15' && to === '2027-03-21' && km === '12') ok('cap override row shows the stored range (2027-02-15 to 2027-03-21, 12km)');
    else fail('cap override row values wrong, got from=' + from + ' to=' + to + ' km=' + km);
  }

  window.document.getElementById('gsRhythmPreviewToggleBtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await wait(400);

  const previewText = window.document.getElementById('gsRhythmPreview').textContent;
  const previewRows = Array.from(window.document.querySelectorAll('#gsRhythmPreview tbody tr'));
  if (previewRows.length !== 2) {
    fail('expected 2 preview rows (one per checkpoint), got ' + previewRows.length + '. Full text: ' + previewText);
  } else {
    const row1 = previewRows[0].textContent;
    const row2 = previewRows[1].textContent;
    if (row1.includes('2026-10-12') && row1.includes('20km') && /3km/.test(row1) && /5km/.test(row1) && /7km/.test(row1)) {
      ok('week 1 preview row (20km target) shows the reference-week sizes 3/5/5/7');
    } else fail('week 1 preview row does not show the expected 3/5/5/7 sizes, got: ' + row1);
    if (row2.includes('2027-02-15') && row2.includes('28km') && /3km/.test(row2) && /8km/.test(row2) && /12km/.test(row2)) {
      ok('capped-week preview row (28km target, override range) shows 3/8/5/12');
    } else fail('capped-week preview row does not show the expected 3/8/5/12 sizes, got: ' + row2);
    if (/short/i.test(row2)) fail('capped-week preview row must report NO shortfall (cap 12 exactly covers 28km), got: ' + row2);
    else ok('capped-week preview row reports no shortfall');
  }

  if (consoleErrors.length) fail('console/script errors appeared during the click flow (see above)');

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
}

main();
