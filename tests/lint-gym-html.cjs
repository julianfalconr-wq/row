// Lint check — run this before every push touching gym.html, plan.html
// or main.html.
//
//   node tests/lint-gym-html.cjs
//
// Extracts each inline <script> block from every file in TARGET_FILES
// below (skipping any <script src="..."> that loads an external file
// — those are a separate top-level scope, out of scope for this
// check) and runs ESLint against each one with:
//   - the stock `no-undef` rule (parse-time-ish sanity: catches an
//     obviously misspelled/removed identifier), and
//   - the custom local/no-top-level-tdz rule (tests/eslint-rules/
//     no-top-level-tdz.cjs) — the actual point of this script: a
//     top-level const/let read eagerly before its own declaration,
//     the exact shape behind 3 real regressions in gym.html this
//     session (each one threw "Cannot access 'X' before
//     initialization" at page-load time and silently unwired every
//     click handler below it in the file, with no visible error).
//     plan.html and main.html share the same "big IIFE per <script>
//     block, const-heavy" structure and the same risk, even though
//     neither has hit this specific bug yet.
//
// `no-undef` needs a rough picture of these files' real globals
// (DayLib, window.*, etc.) to avoid drowning the real signal in
// "X is not defined" noise for things that ARE defined, just not
// visible to a bare per-block lint pass — see GLOBALS below.
const fs = require('fs');
const path = require('path');
const { ESLint } = require('eslint');

const ROW_DIR = path.join(__dirname, '..');
const noTopLevelTdz = require('./eslint-rules/no-top-level-tdz.cjs');

// Every file this check covers, run before any push that touches any
// of them. An .html file has its inline <script> blocks extracted and
// linted one at a time; a .js file is linted whole, as a single block
// (sync.js — a SHARED module several pages load, same IIFE-per-file,
// const-heavy structure and risk as the .html files, and the one this
// script's own fix touched directly). A file with no inline <script>
// content (an .html file with only external <script src> tags) is
// skipped, not an error — add a new file here, not a separate script,
// if another page/module later needs the same check.
const TARGET_FILES = ['gym.html', 'plan.html', 'main.html', 'sync.js'];

// Real external globals these files' inline scripts reference,
// defined in a DIFFERENT <script> tag (daylib.js, lock.js, topbar.js)
// or by the browser itself — not exhaustive, just enough that
// `no-undef` stays useful instead of noisy. Each inline <script>
// block is linted in isolation, so a symbol one block defines and a
// LATER block in the SAME file reads via `window.X` also needs
// listing here (cross-block/window access is a legitimate, different
// pattern this script doesn't check).
const GLOBALS = [
  'window', 'document', 'localStorage', 'sessionStorage', 'fetch', 'console',
  'alert', 'confirm', 'prompt', 'navigator', 'location', 'history',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'Image', 'Blob', 'FileReader', 'URL', 'URLSearchParams',
  'FormData', 'CustomEvent', 'Event', 'MutationObserver', 'IntersectionObserver',
  'DayLib', 'lucide', 'supabase', 'Chart',
];

function extractInlineScripts(html) {
  const scripts = [];
  const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/.test(attrs)) continue; // external — separate top-level scope, out of scope here
    scripts.push({ code: m[2], index: scripts.length });
  }
  return scripts;
}

async function main() {
  const globalsConfig = {};
  GLOBALS.forEach((g) => { globalsConfig[g] = 'readonly'; });

  const eslint = new ESLint({
    cwd: ROW_DIR,
    overrideConfigFile: true,
    baseConfig: [{
      languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: globalsConfig },
      plugins: { local: { rules: { 'no-top-level-tdz': noTopLevelTdz } } },
      rules: {
        'local/no-top-level-tdz': 'error',
        'no-undef': 'warn', // informational only -- cross-block window.* access legitimately looks undefined per-block
      },
    }],
  });

  let failures = 0;
  for (const fileName of TARGET_FILES) {
    const filePath = path.join(ROW_DIR, fileName);
    if (!fs.existsSync(filePath)) { console.log('SKIP: ' + fileName + ' does not exist'); continue; }
    const content = fs.readFileSync(filePath, 'utf8');
    const scripts = fileName.endsWith('.js') ? [{ code: content, index: 0 }] : extractInlineScripts(content);
    if (!scripts.length) { console.log('SKIP: ' + fileName + ' has no inline <script> content'); continue; }

    console.log('--- ' + fileName + ' (' + scripts.length + ' inline <script> block(s)) ---');
    for (const { code, index } of scripts) {
      const results = await eslint.lintText(code, { filePath: fileName + '-inline-script-' + index + '.js' });
      const messages = results[0].messages;
      const errors = messages.filter((m) => m.severity === 2);
      const warnings = messages.filter((m) => m.severity === 1);
      if (errors.length) {
        failures += errors.length;
        console.log('FAIL: ' + fileName + ' <script> block ' + index + ' — ' + errors.length + ' error(s):');
        errors.forEach((e) => console.log('   line ' + e.line + ': ' + e.message));
      } else {
        console.log('PASS: ' + fileName + ' <script> block ' + index + ' — no top-level-TDZ issues');
      }
      if (warnings.length) {
        console.log('  (' + warnings.length + ' no-undef warning(s), informational — cross-block window.* access is expected)');
      }
    }
  }

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
}

main();
