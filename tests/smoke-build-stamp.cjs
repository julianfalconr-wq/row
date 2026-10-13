// Smoke test — run this before every push touching the build-stamp
// footer (gym.html / main.html / plan.html's own small footer block,
// build-stamp.js, scripts/generate-build-stamp.cjs).
//
//   node tests/smoke-build-stamp.cjs
//
// For each of the three pages: loads the REAL page in jsdom with the
// REAL, committed build-stamp.js (the "dev" placeholder — exactly
// what a local/no-build run actually ships) and asserts the footer
// renders "build dev" with zero console errors; then reloads the SAME
// page with a fake build-stamp.js standing in for what Vercel's build
// step would have written (a real commit hash + time) and asserts
// the footer shows that exact text instead — proving the mechanism
// renders a real stamp when build-stamp.js actually has one, not just
// that it never crashes.
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROW_DIR = path.join(__dirname, '..');
const esc = (s) => s.replace(/<\/script/gi, '<\\/script');

const LOCAL_SCRIPTS = {
  'lock.js': 'lock.js',
  'daylib.js': 'daylib.js',
  'topbar.js" defer': 'topbar.js',
  'sync.js" defer': 'sync.js',
  'score-lib.js': 'score-lib.js',
};

function buildHtml(pageFile, fakeBuildStampJs) {
  let html = fs.readFileSync(path.join(ROW_DIR, pageFile), 'utf8');
  html = html.replace('<script src="lock.js"></script>', '<script>' + esc(fs.readFileSync(path.join(ROW_DIR, 'lock.js'), 'utf8')) + '</script>');
  html = html.replace('<script src="daylib.js"></script>', '<script>' + esc(fs.readFileSync(path.join(ROW_DIR, 'daylib.js'), 'utf8')) + '</script>');
  html = html.replace('<script src="topbar.js" defer></script>', '<script>' + esc(fs.readFileSync(path.join(ROW_DIR, 'topbar.js'), 'utf8')) + '</script>');
  if (html.includes('<script src="sync.js" defer></script>')) {
    html = html.replace('<script src="sync.js" defer></script>', '<script>' + esc(fs.readFileSync(path.join(ROW_DIR, 'sync.js'), 'utf8')) + '</script>');
  }
  if (html.includes('<script src="score-lib.js"></script>')) {
    html = html.replace('<script src="score-lib.js"></script>', '<script>' + esc(fs.readFileSync(path.join(ROW_DIR, 'score-lib.js'), 'utf8')) + '</script>');
  }
  html = html.replace('<script src="cronometer-lib.js" defer></script>', '<script>window.CronoLib = undefined;</script>');
  html = html.replace(/<script src="https:\/\/unpkg\.com\/lucide[^"]*"[^>]*><\/script>/, '<script>window.lucide = { createIcons: function(){} };</script>');
  html = html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js[^"]*"[^>]*><\/script>/, '<script>window.Chart = function(){};</script>');
  html = html.replace('<script src="row-charts.js"></script>', '<script>window.RowCharts = {};</script>');
  const supabaseStub = (
    '<script>window.supabase = { createClient: function() {' +
    'var chain = { select: function(){ return chain; }, eq: function(){ return chain; }, maybeSingle: function(){ return Promise.resolve({ data: null, error: null }); }, upsert: function(){ return Promise.resolve({ error: null }); } };' +
    'var channel = { on: function(){ return channel; }, subscribe: function(){ return channel; } };' +
    'return { auth: {}, from: function(){ return chain; }, channel: function(){ return channel; } }; } };</script>'
  );
  html = html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js[^"]*"><\/script>/, supabaseStub);
  // The build stamp itself — the one real local script THIS test
  // cares about — swapped between the real committed file and a fake
  // stand-in for what Vercel's build step would have written.
  html = html.replace('<script src="build-stamp.js"></script>', '<script>' + esc(fakeBuildStampJs) + '</script>');
  return html;
}

function mockFetch() {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }), text: () => Promise.resolve('{"ok":true}') });
}
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function checkPage(pageFile, buildStampJs, expectedText, label, failFn, okFn) {
  const html = buildHtml(pageFile, buildStampJs);
  const consoleErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => consoleErrors.push('JSDOM: ' + (e.stack || e.message)));
  virtualConsole.on('error', (...args) => consoleErrors.push(args.map(String).join(' ')));
  const dom = new JSDOM(html, {
    url: 'https://row.test/' + pageFile, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
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

  await wait(1000);

  const el = window.document.getElementById('buildStampFooter');
  if (!el) failFn(label + ': #buildStampFooter did not render at all');
  else if (el.textContent !== expectedText) failFn(label + ': expected footer text ' + JSON.stringify(expectedText) + ', got ' + JSON.stringify(el.textContent));
  else okFn(label + ': footer shows ' + JSON.stringify(el.textContent));

  if (consoleErrors.length) failFn(label + ': ' + consoleErrors.length + ' console error(s): ' + consoleErrors.join(' | '));
}

async function main() {
  let failures = 0;
  function fail(msg) { failures++; console.log('FAIL:', msg); }
  function ok(msg) { console.log('PASS:', msg); }

  const realBuildStampJs = fs.readFileSync(path.join(ROW_DIR, 'build-stamp.js'), 'utf8');
  if (!/window\.BUILD_STAMP\s*=\s*'dev'/.test(realBuildStampJs)) {
    fail('the committed build-stamp.js no longer defaults to \'dev\' — expected the placeholder, got: ' + realBuildStampJs);
  } else {
    ok('the committed build-stamp.js still defaults to \'dev\' (what a local/no-build run actually ships)');
  }

  const fakeRealStampJs = "window.BUILD_STAMP = '5290cea, 12 Oct 17:05 UTC';";

  for (const pageFile of ['gym.html', 'main.html', 'plan.html']) {
    await checkPage(pageFile, realBuildStampJs, 'build dev', pageFile + ' (variables missing / local build-stamp.js)', fail, ok);
    await checkPage(pageFile, fakeRealStampJs, 'build 5290cea, 12 Oct 17:05 UTC', pageFile + ' (real stamp present)', fail, ok);
  }

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
}

main();
