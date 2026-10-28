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
node tests/check-vercel-config.cjs    # vercel.json's buildCommand must have a matching outputDirectory (a past deploy broke on exactly this)
node tests/smoke-availability-rhythm-allowed.cjs # a weekly-rhythm placement always counts as allowed on its own day, regardless of the availability template
node tests/smoke-rebalance-backlog-named.cjs # backlog = capped by ahead-vs-remaining-target, always named; no generic "could not be placed"/"0 of 1" lines
node tests/smoke-rhythm-cap-golden.cjs # server/client long-run-cap cross-check across 31 weeks + golden sequence + preview header
node tests/smoke-fueling.cjs          # Fueling card — computeFueling golden cases, real page render, settings sanitizer
node tests/smoke-strength-core-extra.cjs # strength core (push/pull/legs) vs optional-extra (Explosive) rebalance priority — never dropped silently
node tests/smoke-activity-kind.cjs    # optional run/swim activity `kind` tag, used only for the layout strike-through (part 1 of 2 — the rebalancer is untouched)
node tests/smoke-today-card-staleness.cjs # Today's session card staleness — "Outdated" note after logging/retro-tagging, "Done for today", no AI call on its own
node tests/smoke-unplaced-backlog.cjs # a past-day session unplaced at plan generation still becomes backlog instead of silently vanishing
node tests/smoke-rebalance-same-discipline.cjs # the rebalancer never places two sessions of the SAME discipline on one day — different disciplines the same day stay allowed
node tests/smoke-rebalance-kind-claimed.cjs # a tagged activity's km claims its own kind-slot and is never ALSO double counted against an unrelated missed session
node tests/smoke-sync-merge.cjs # sync.js's push/pull merge — read-merge-CAS per key, never a blind whole-blob overwrite; a deleted item never reappears via a stale push from another device/tab
node tests/smoke-score-cardio-expected.cjs # score-lib.js's Training/cardio half — expected-so-far comes from plan.layout's own scheduled run/bike sessions, not a blind 1/7-per-day proration
node tests/smoke-strength-daytype-claim.cjs # a strength log claims its week's own same-day-type slot (gym.html's computeClaimedStrengthDaySlots), even when logged on a different day than that slot's own day — the layout strike-through, and Today's pick/Rest of week, never disagree with each other about it
```

## Fueling

gym.html's Today's session shows a per-session "Fueling" card (carbs during/before/after, fluid, sodium, gel count, a home gel recipe) for any session 60+ minutes, computed entirely in code from `FUELING_RULES` — no AI call, no new network request beyond the existing `general-settings` fetch for the editable rules. Settings (gel size, max g/h, body weight, and the full rules table) live in General Settings → Fueling, validated server-side in `api/sync-state.js`'s `sanitizeFuelingSettings`.

**Any change to `vercel.json` (buildCommand, outputDirectory, functions, etc.) must go through a Preview deployment first** — push it to a branch, confirm the Preview build succeeds and the live pages/API actually work on the preview URL, and only then merge to `main`. A deploy-config mistake doesn't show up in `npm run check` (it's a Vercel build/serving concern, not something jsdom can exercise) and breaks the LIVE site for everyone the moment `main` deploys — exactly what happened with commit 9b3de4d's missing `outputDirectory`.

## Build stamp

gym.html, main.html and plan.html each show a small muted "build &lt;commit&gt;, &lt;date&gt; &lt;time&gt;" line in their own footer. It's generated at deploy time: Vercel's build step runs `npm run build` (`scripts/generate-build-stamp.cjs`), which overwrites `build-stamp.js` with `VERCEL_GIT_COMMIT_SHA` (short hash) and the build time, read from Vercel's own System Environment Variables — no API call, no fetch at runtime. Locally (or if those variables are absent), `build-stamp.js` keeps the committed "dev" placeholder.
