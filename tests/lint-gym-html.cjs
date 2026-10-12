// Lint check — run this before every push touching gym.html.
//
//   node tests/lint-gym-html.cjs
//
// Extracts each inline <script> block from gym.html (skipping any
// <script src="..."> that loads an external file — those are a
// separate top-level scope, out of scope for this check) and runs
// ESLint against each one with:
//   - the stock `no-undef` rule (parse-time-ish sanity: catches an
//     obviously misspelled/removed identifier), and
//   - the custom local/no-top-level-tdz rule (tests/eslint-rules/
//     no-top-level-tdz.cjs) — the actual point of this script: a
//     top-level const/let read eagerly before its own declaration,
//     the exact shape behind 3 real regressions this session (each
//     one threw "Cannot access 'X' before initialization" at
//     page-load time and silently unwired every click handler below
//     it in the file, with no visible error).
//
// `no-undef` needs a rough picture of this file's real globals
// (DayLib, window.*, etc.) to avoid drowning the real signal in
// "X is not defined" noise for things that ARE defined, just not
// visible to a bare per-block lint pass — see GLOBALS below.
const fs = require('fs');
const path = require('path');
const { ESLint } = require('eslint');

const ROW_DIR = path.join(__dirname, '..');
const noTopLevelTdz = require('./eslint-rules/no-top-level-tdz.cjs');

// Real external globals gym.html's inline scripts reference, defined
// in a DIFFERENT <script> tag (daylib.js, lock.js, topbar.js) or by
// the browser itself — not exhaustive, just enough that `no-undef`
// stays useful instead of noisy. Each inline <script> block is linted
// in isolation, so a symbol one block defines and a LATER block reads
// via `window.X` also needs listing here (cross-block/window access
// is a legitimate, different pattern this script doesn't check).
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
  const html = fs.readFileSync(path.join(ROW_DIR, 'gym.html'), 'utf8');
  const scripts = extractInlineScripts(html);

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
  for (const { code, index } of scripts) {
    const results = await eslint.lintText(code, { filePath: 'gym-inline-script-' + index + '.js' });
    const messages = results[0].messages;
    const errors = messages.filter((m) => m.severity === 2);
    const warnings = messages.filter((m) => m.severity === 1);
    if (errors.length) {
      failures += errors.length;
      console.log('FAIL: <script> block ' + index + ' — ' + errors.length + ' error(s):');
      errors.forEach((e) => console.log('   line ' + e.line + ': ' + e.message));
    } else {
      console.log('PASS: <script> block ' + index + ' — no top-level-TDZ issues');
    }
    if (warnings.length) {
      console.log('  (' + warnings.length + ' no-undef warning(s), informational — cross-block window.* access is expected)');
    }
  }

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
}

main();
