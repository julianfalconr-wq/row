// Smoke test — run this before every push that touches gym.html.
//
//   node tests/smoke-refresh-buttons.cjs
//
// Loads the REAL gym.html in jsdom with mocked API responses, clicks
// each of the 3 refresh buttons in the weekly objectives / today's
// session cards, and fails on any console error/uncaught exception,
// or a click that fires zero network requests.
//
// That last check is the regression this test exists to catch: a
// synchronous error anywhere in gym.html's top-level script body (not
// inside a function — those only throw when actually called) aborts
// the ENTIRE enclosing IIFE the instant the page loads, silently
// skipping every click-handler wiring call below it in the file with
// no visible error, spinner, or alert (see commit 1bbee85's own
// regression: a `const` referenced before its declaration a few
// hundred lines later threw "Cannot access '...' before
// initialization" at load time and unwired tpGenerateBtn,
// tpRebalanceBtn AND ttRefreshBtn all at once).
//
// Requires the `jsdom` devDependency (`npm install`).
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROW_DIR = path.join(__dirname, '..');

function buildHtml() {
  let html = fs.readFileSync(path.join(ROW_DIR, 'gym.html'), 'utf8');
  // Inline the local external scripts (lock.js/daylib.js/topbar.js) so
  // jsdom never needs real network/file resource loading at all, and
  // escape any literal "</script" their own comments happen to
  // contain (topbar.js discusses <script> tags in its doc comments)
  // so the HTML parser doesn't treat it as the end of the synthetic
  // inline <script> element and spill the rest of the file as text.
  const escapeForInlineScript = (s) => s.replace(/<\/script/gi, '<\\/script');
  const lockJs = escapeForInlineScript(fs.readFileSync(path.join(ROW_DIR, 'lock.js'), 'utf8'));
  const daylibJs = escapeForInlineScript(fs.readFileSync(path.join(ROW_DIR, 'daylib.js'), 'utf8'));
  const topbarJs = escapeForInlineScript(fs.readFileSync(path.join(ROW_DIR, 'topbar.js'), 'utf8'));
  html = html.replace('<script src="lock.js"></script>', '<script>' + lockJs + '</script>');
  html = html.replace('<script src="daylib.js"></script>', '<script>' + daylibJs + '</script>');
  html = html.replace('<script src="topbar.js" defer></script>', '<script>' + topbarJs + '</script>');
  // CDN scripts -> harmless local stubs, no network.
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

function mockFetch(log) {
  return (url, opts) => {
    const u = String(url);
    log.push({ url: u, method: (opts && opts.method) || 'GET' });
    const cardioVolume = { activityTypeId: null, activityName: '', targetAmount: 0, unit: '', description: '' };
    const cardioInterval = { activityTypeId: null, activityName: '', targetSessions: 0, targetMinutes: 0, description: '' };
    let body = { ok: true };
    if (u.includes('resource=plans')) body = { ok: true, plans: [] };
    else if (u.includes('resource=activity-types')) body = { ok: true, types: [] };
    else if (u.includes('resource=restrictions')) body = { ok: true, restrictions: [] };
    else if (u.includes('resource=weekly-rhythm')) body = { ok: true, rhythm: {} };
    // Must match the REAL normalizePlan() shape in api/training.js
    // (plan.strength.targetSessions, plan.cardio.interval/longSession/
    // easyVolume as full objects — NEVER raw null) — a plausible-
    // looking but wrong mock shape here previously masked a real
    // crash-on-click behind an unrelated "mock fidelity" error.
    else if (u.includes('mode=plan')) body = { ok: true, plan: { strength: { targetSessions: 3, focus: '' }, cardio: { interval: cardioInterval, longSession: cardioVolume, easyVolume: cardioVolume }, targets: undefined, rationale: 'Mocked plan for smoke test.' } };
    else if (u.includes('mode=today')) body = { ok: true, recommendation: 'Rest' };
    else if (u.includes('whoop')) body = { ok: true, connected: false };
    else if (u.includes('resource=events') || u.includes('calendar')) body = { ok: true, events: [] };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) });
  };
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function main() {
  const html = buildHtml();
  const consoleErrors = [];
  const fetchLog = [];

  // A top-level error DURING a <script> tag's own initial synchronous
  // execution (e.g. the exact TDZ "Cannot access 'X' before
  // initialization" this test exists to catch) is reported by jsdom
  // as a 'jsdomError' on the VirtualConsole, NOT always as a window
  // 'error' event — both are wired here so neither class of failure
  // slips through as a false "page loaded with zero console errors".
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => { consoleErrors.push('JSDOM/SCRIPT ERROR: ' + (e.stack || e.message)); });
  virtualConsole.on('error', (...args) => { consoleErrors.push(args.map(String).join(' ')); });

  const dom = new JSDOM(html, { url: 'https://row.test/gym.html', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  window.console.warn = () => {};
  window.alert = () => {};
  window.addEventListener('error', (e) => {
    consoleErrors.push('UNCAUGHT: ' + (e.error && (e.error.stack || e.error.message) || e.message));
  });
  window.fetch = mockFetch(fetchLog);
  try { window.localStorage.setItem('dashboard:secret', 'test-secret'); } catch (e) {}
  try { window.sessionStorage.setItem('dashboard:unlocked', '1'); } catch (e) {}

  await wait(1500);

  let failures = 0;
  function fail(msg) { failures++; console.log('FAIL:', msg); }

  if (consoleErrors.length) {
    fail('page load produced ' + consoleErrors.length + ' console error(s)/uncaught exception(s):');
    consoleErrors.forEach((e) => console.log('   ', e));
  } else {
    console.log('PASS: page loaded with zero console errors');
  }

  const buttons = [
    { id: 'tpGenerateBtn', label: 'objectives generate' },
    { id: 'tpRebalanceBtn', label: 're-plan rest of week' },
    { id: 'ttRefreshBtn', label: "today's session refresh" },
  ];

  for (const { id, label } of buttons) {
    const btn = window.document.getElementById(id);
    if (!btn) { fail(id + ' (' + label + ') not found in the DOM at all'); continue; }
    consoleErrors.length = 0;
    const before = fetchLog.length;
    try {
      btn.dispatchEvent(new window.Event('click', { bubbles: true }));
    } catch (e) {
      fail(id + ' (' + label + ') threw synchronously on click: ' + (e.stack || e.message));
      continue;
    }
    await wait(1500);
    const fired = fetchLog.length - before;
    if (fired === 0) {
      fail(id + ' (' + label + ') click produced ZERO network requests — the exact "does nothing" regression shape (listener never wired, or an early silent return)');
    } else {
      console.log('PASS: ' + id + ' (' + label + ') click fired ' + fired + ' request(s)');
    }
    if (consoleErrors.length) {
      fail(id + ' (' + label + ') click produced ' + consoleErrors.length + ' console error(s):');
      consoleErrors.forEach((e) => console.log('   ', e));
    }
  }

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
}

main();
