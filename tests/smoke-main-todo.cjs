// Smoke test — run this before every push touching main.html (or
// sync.js, which main.html's To Do list depends on for cloud sync).
//
//   node tests/smoke-main-todo.cjs
//
// Loads the REAL main.html in jsdom with mocked Supabase/network
// calls, then exercises add, check, uncheck, delete, and "Push
// remaining to tomorrow" on the real To Do list — failing on any
// console error or a step that doesn't visibly take effect. This is
// the regression the reported bug fell into: a click that updates
// storage but produces no visible effect (or gets silently reverted
// moments later by a stale sync pull) is exactly what this test
// would have caught.
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROW_DIR = path.join(__dirname, '..');

function buildHtml() {
  let html = fs.readFileSync(path.join(ROW_DIR, 'main.html'), 'utf8');
  const escapeForInlineScript = (s) => s.replace(/<\/script/gi, '<\\/script');
  const lockJs = escapeForInlineScript(fs.readFileSync(path.join(ROW_DIR, 'lock.js'), 'utf8'));
  const daylibJs = escapeForInlineScript(fs.readFileSync(path.join(ROW_DIR, 'daylib.js'), 'utf8'));
  const topbarJs = escapeForInlineScript(fs.readFileSync(path.join(ROW_DIR, 'topbar.js'), 'utf8'));
  const syncJs = escapeForInlineScript(fs.readFileSync(path.join(ROW_DIR, 'sync.js'), 'utf8'));
  const scoreLibJs = escapeForInlineScript(fs.readFileSync(path.join(ROW_DIR, 'score-lib.js'), 'utf8'));

  html = html.replace('<script src="lock.js"></script>', '<script>' + lockJs + '</script>');
  html = html.replace('<script src="daylib.js"></script>', '<script>' + daylibJs + '</script>');
  html = html.replace('<script src="topbar.js" defer></script>', '<script>' + topbarJs + '</script>');
  html = html.replace('<script src="sync.js" defer></script>', '<script>' + syncJs + '</script>');
  html = html.replace('<script src="score-lib.js"></script>', '<script>' + scoreLibJs + '</script>');
  html = html.replace('<script src="cronometer-lib.js" defer></script>', '<script>window.CronoLib = undefined;</script>');
  html = html.replace(/<script src="https:\/\/unpkg\.com\/lucide[^"]*"[^>]*><\/script>/, '<script>window.lucide = { createIcons: function(){} };</script>');

  const supabaseStub = (
    '<script>' +
    'window.supabase = { createClient: function() {' +
    '  var chain = { select: function(){ return chain; }, eq: function(){ return chain; }, maybeSingle: function(){ return Promise.resolve({ data: null, error: null }); }, upsert: function(){ return Promise.resolve({ error: null }); } };' +
    '  var channel = { on: function(){ return channel; }, subscribe: function(){ return channel; } };' +
    '  return { auth: {}, from: function(){ return chain; }, channel: function(){ return channel; } };' +
    '} };' +
    '</script>'
  );
  html = html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js[^"]*"><\/script>/, supabaseStub);

  return html;
}

function mockFetch(url) {
  const u = String(url);
  let body = { ok: true };
  if (u.includes('resource=plans')) body = { ok: true, plans: [] };
  else if (u.includes('resource=activity-types')) body = { ok: true, types: [] };
  else if (u.includes('resource=restrictions')) body = { ok: true, restrictions: [] };
  else if (u.includes('resource=weekly-rhythm')) body = { ok: true, rhythm: {} };
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
    fail('page load produced ' + consoleErrors.length + ' console error(s)/uncaught exception(s):');
    consoleErrors.forEach((e) => console.log('   ', e));
  } else {
    ok('page loaded with zero console errors');
  }

  function progressNum() { return window.document.getElementById('gmProgressNum').textContent; }
  function todayRows() { return Array.from(window.document.querySelectorAll('#goalList .gm-row')); }

  // --- Add ---
  consoleErrors.length = 0;
  const input = window.document.getElementById('goalInput');
  input.value = 'Smoke test task';
  window.document.getElementById('goalAddBtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await wait(150);
  const rowsAfterAdd = todayRows();
  const newRow = rowsAfterAdd.find((r) => r.querySelector('.gm-text') && r.querySelector('.gm-text').textContent === 'Smoke test task');
  if (!newRow) fail('Add: the new task does not appear in #goalList after clicking goalAddBtn');
  else ok('Add: the new task appears in #goalList, progress now reads "' + progressNum() + ' / ' + rowsAfterAdd.length + '"');

  // --- Check ---
  consoleErrors.length = 0;
  const progressBeforeCheck = progressNum();
  const checkbox = newRow && newRow.querySelector('.gm-check');
  if (checkbox) {
    checkbox.checked = true;
    checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(150);
    const progressAfterCheck = progressNum();
    if (progressAfterCheck === progressBeforeCheck) fail('Check: clicking the checkbox did not visibly update the progress count (still "' + progressAfterCheck + '") — the exact reported "clicking does nothing visible" shape');
    else ok('Check: progress updated from "' + progressBeforeCheck + '" to "' + progressAfterCheck + '" after checking the box');
  } else {
    fail('Check: could not find the new row\'s checkbox at all');
  }

  // --- Uncheck ---
  consoleErrors.length = 0;
  if (checkbox) {
    const progressBeforeUncheck = progressNum();
    checkbox.checked = false;
    checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(150);
    const progressAfterUncheck = progressNum();
    if (progressAfterUncheck === progressBeforeUncheck) fail('Uncheck: clicking the checkbox again did not visibly update the progress count');
    else ok('Uncheck: progress updated from "' + progressBeforeUncheck + '" to "' + progressAfterUncheck + '" after unchecking the box');
  }

  // --- Delete ---
  consoleErrors.length = 0;
  const rowsBeforeDelete = todayRows().length;
  const delBtn = window.document.querySelector('#goalList .goal-delete');
  if (delBtn) {
    delBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
    await wait(150);
    const rowsAfterDelete = todayRows().length;
    if (rowsAfterDelete !== rowsBeforeDelete - 1) fail('Delete: row count did not decrease by 1 (was ' + rowsBeforeDelete + ', now ' + rowsAfterDelete + ')');
    else ok('Delete: row count decreased from ' + rowsBeforeDelete + ' to ' + rowsAfterDelete);
  } else {
    fail('Delete: could not find a .goal-delete button to click');
  }

  // --- Push remaining to tomorrow ---
  consoleErrors.length = 0;
  input.value = 'Unchecked task for push test';
  window.document.getElementById('goalAddBtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await wait(150);
  const tomorrowCountBefore = Array.from(window.document.querySelectorAll('#tomorrowList .gm-row')).length;
  const pushBtn = window.document.getElementById('gmPushBtn');
  if (pushBtn.style.display === 'none') {
    fail('Push: gmPushBtn is hidden even though an unchecked task exists');
  } else {
    pushBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
    await wait(150);
    const tomorrowCountAfter = Array.from(window.document.querySelectorAll('#tomorrowList .gm-row')).length;
    const stillInToday = todayRows().some((r) => r.querySelector('.gm-text') && r.querySelector('.gm-text').textContent === 'Unchecked task for push test');
    if (tomorrowCountAfter <= tomorrowCountBefore) fail('Push: tomorrow\'s list did not gain a row (before=' + tomorrowCountBefore + ', after=' + tomorrowCountAfter + ')');
    else ok('Push: tomorrow\'s list gained a row (' + tomorrowCountBefore + ' -> ' + tomorrowCountAfter + ')');
    if (stillInToday) fail('Push: the pushed task is still showing in today\'s list');
    else ok('Push: the pushed task no longer shows in today\'s list');
  }

  if (consoleErrors.length) {
    fail('console/script errors appeared during the click flow:');
    consoleErrors.forEach((e) => console.log('   ', e));
  }

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
}

main();
