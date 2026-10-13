# Personal Dashboard

A set of small, self-contained HTML apps that share a top bar.

## Deploy your own copy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FRowanThistlebrooke%2FYTdashh1)

One click → Vercel signs you in, copies the repo to your GitHub, and deploys it. ~30 seconds to a live URL.

## How to use

Open any `.html` file directly in your browser — no build step, no install.

| File | What it is |
|---|---|
| [index.html](index.html) | Goals tracker (Day Ring, Goal Ticker, To Do list) — the home page |
| [health.html](health.html) | Supplement / daily stack tracker |
| [po-water.html](po-water.html) | Water intake tracker |
| [finance.html](finance.html) | Finances |
| [gym.html](gym.html) | Progressive overload gym tracker |
| [topbar.js](topbar.js) | Shared top bar — auto-injected into pages that `<script src="topbar.js">` |

Each app stores its own state in browser `localStorage`. No accounts, no server.

## Building from scratch

[BUILD_DASHBOARD.md](BUILD_DASHBOARD.md) is the prompt I gave Claude to generate `index.html` — paste it into Claude if you want to rebuild that page yourself.

## Development checks

Run `npm install` once — this also wires up a git pre-push hook (via the `prepare` script, `git config core.hooksPath .githooks`) that automatically blocks a push if any check below fails, with a message naming which one.

To run all checks by hand:

```
npm run check
```

Or individually:

```
node tests/lint-gym-html.cjs          # top-level-TDZ lint — gym.html, plan.html, main.html, sync.js
node tests/smoke-refresh-buttons.cjs  # real-page click-through smoke test — gym.html's 3 refresh buttons
node tests/smoke-main-todo.cjs        # real-page click-through smoke test — main.html's To Do list (add/check/uncheck/delete/push)
node tests/smoke-weekly-plan-card.cjs # real-page render check — gym.html's weekly objectives card (layout naming, no phantom interval card, rationale placement, capacity line)
node tests/smoke-fresh-week-rebalance.cjs # real-page rebalancer check — fresh Monday with a weekly rhythm never shows a phantom backlog
node tests/smoke-rhythm-split.cjs     # km-aware weekly-rhythm run/bike split — api/training.js's splitRhythmSessionsByShares
node tests/smoke-today-rhythm-backstop.cjs # Today's/Tomorrow's session never invents an unscheduled session when a rhythm exists
node tests/smoke-rhythm-cap-preview.cjs # weekly-rhythm long-run cap settings + "Next weeks" preview table — main.html
node tests/smoke-build-stamp.cjs      # footer build stamp — gym.html/main.html/plan.html
```

## Build stamp

gym.html, main.html and plan.html each show a small muted "build &lt;commit&gt;, &lt;date&gt; &lt;time&gt;" line in their own footer. It's generated at deploy time: Vercel's build step runs `npm run build` (`scripts/generate-build-stamp.cjs`), which overwrites `build-stamp.js` with `VERCEL_GIT_COMMIT_SHA` (short hash) and the build time, read from Vercel's own System Environment Variables — no API call, no fetch at runtime. Locally (or if those variables are absent), `build-stamp.js` keeps the committed "dev" placeholder.
