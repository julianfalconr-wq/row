// =============================================================
// Combined endpoint for gym.html's Training page AI features, plus
// main.html's "Plan my day" feature (mode=day-plan) and trends.html's
// "Find Patterns" (mode=find-patterns) and "Ver mi semana" weekly
// review (mode=weekly-review) features, added later — same file for
// the same reason. Five modes, one file — same
// dual-mode-in-one-endpoint pattern api/cronometer-data.js already
// uses (there: presence/absence of a "type" param; here: an explicit
// "mode" param), kept as ONE file deliberately: Vercel's Hobby plan
// caps a deployment at 12 Serverless Functions, and this repo is
// already at that ceiling, so api/training-plan.js + api/training-
// today.js as two separate files pushed it over and broke a deploy
// once already. Do not split this back into separate files without
// first removing another function.
//
// All modes are stateless — the client gathers recent history/
// context client-side (including a live Whoop fetch, same pattern
// topbar.js's gatherTodayContext() already uses) and POSTs a compact
// summary; nothing is persisted server-side by this file.
//
// Gated by DASHBOARD_SECRET, same as every other endpoint here.
// Requires ANTHROPIC_API_KEY.
//
// All three modes below also accept:
//     restrictions: [{ text, scope }] | undefined,
//   — the CLIENT fetches whatever's active as of today
//   (GET /api/sync-state?resource=restrictions&asOf=<DayLib today>)
//   and forwards it here; this file never talks to Supabase itself,
//   same "client gathers context, server stays stateless" convention
//   every other input already follows. Set via the chat's
//   propose_restriction tool (api/chat.js) + saved through
//   api/sync-state.js's resource=restrictions. scope "strength" is
//   enforced in code (see normalizePlan) for the strength side; on the
//   cardio side (Phase 3 of the multi-activity-type generalization),
//   ANY scope is checked in code against whichever activity type a
//   cardio slot actually ends up using (matched by that type's id OR
//   name, since a restriction's scope is free text, e.g. "running" —
//   see isCardioTypeBlocked). Other scopes (e.g. "padel") still rely on
//   the model respecting buildRestrictionsPromptSection's instructions,
//   same as before.
//
// MODE 1 — POST /api/training?mode=plan&secret=...
//   Generates this week's strength + cardio objectives. Cardio (Phase 3
//   of the multi-activity-type generalization — previously hardcoded to
//   running) is now distributed across whichever of the user's
//   configured activity types are marked "recommendable"
//   (api/sync-state.js's resource=activity-types) — each of the three
//   cardio slots picks its own activity type, not necessarily the same
//   one, and not necessarily running.
//   Body: {
//     strengthSessions: [{ date, totalSets, exerciseCount }],   // last ~21 days
//     recentExerciseNames: ['Bench Press', 'DB Row', ...],      // distinct names actually logged
//     activitySessions: [{ activityTypeId, date, distanceKm, count, durationMin, pace, effort, notes }], // last ~21 days, any type
//     recommendableActivityTypes: [{ id, name, unit, unitKind }],  // recommendable:true only; empty array means no cardio is possible this week
//     whoop: { recentRecovery: [{date, recoveryPct}], recentStrain: [{date, strain}] } | null,
//     activeWeekDisciplines: {   // Phase 3.1 — gym.html's fetchActiveWeekDisciplines(): the CURRENT week's
//     // checkpoint `disciplines` from the user's own active long-term plan (plan.html's "plans" resource —
//     // a different thing from this week's po_coach_weekly_plan_v1 itself), when that plan/week/field
//     // exists at all. null (the common case for most users / most weeks) means exactly the pre-3.1
//     // behavior: the model invents all cardio numbers itself, same as always.
//       run: { km: Number, activityTypeId: String|null } | undefined,
//       bike: { km: Number, activityTypeId: String|null } | undefined,
//       swim: { sessions: Number, meters: Number, activityTypeId: String|null } | undefined,
//       strength: { sessions: Number } | undefined,
//     } | null,
//     capacity: {   // Phase 3.4 — gym.html's buildWeekCapacity(): this week's REAL remaining-day
//     // availability/calendar capacity, computed client-side (that's where Google Calendar access and
//     // logged-activity pace history live). configured:false (the only other shape) when no availability
//     // template exists — the response then has no capacityNote/layout/unplaced at all, byte-for-byte the
//     // pre-3.4 shape.
//       perDiscipline: {
//         run: { neededMin: Number, availableMin: Number, paceMinPerKm: Number } | undefined,
//         bike: { neededMin: Number, availableMin: Number, paceMinPerKm: Number } | undefined,
//         swim: { neededMin: Number, availableMin: Number, paceMinPer100m: Number, swimAllowedDaysCount: Number } | undefined,
//         strength: { neededMin: Number, availableMin: Number } | undefined,
//       },
//       perDay: [{ weekday: String, dateKey: String, availableMin: Number, allowedDisciplines: {swim,bike,run,strength: Boolean} }],
//       preferredLongDay: String | null,
//     } | undefined,
//   }
//   -> { ok: true, plan: {
//     strength: { targetSessions: Number, focus: String },
//     cardio: {
//       interval:    { activityTypeId: String|null, activityName: String, targetSessions: Number, targetMinutes: Number, description: String },
//       longSession: { activityTypeId: String|null, activityName: String, targetAmount: Number, unit: String, description: String },
//       easyVolume:  { activityTypeId: String|null, activityName: String, targetAmount: Number, unit: String, description: String },
//     },
//     // Phase 3.1 — present ONLY when activeWeekDisciplines was non-null; absent (not null) otherwise, so
//     // JSON.stringify drops the key and an unconfigured response is byte-for-byte what this endpoint
//     // already produced before this phase existed. Computed entirely in CODE from activeWeekDisciplines
//     // (see buildTargetsFromActiveWeek), never asked of the model — cardio.longSession/easyVolume above
//     // are DERIVED from these same numbers when targets is present (see deriveLegacyCardioFromTargets),
//     // so old renderers (main.html's teaser, score-lib.js — neither touched by this phase) keep seeing
//     // representative numbers in the shape they already expect, while gym.html's new per-discipline
//     // progress bars and Today's session feasibility candidates read `targets` itself.
//     targets: {
//       run: { activityTypeId: String|null, activityName: String, km: Number },
//       bike: { activityTypeId: String|null, activityName: String, km: Number },
//       swim: { activityTypeId: String|null, activityName: String, sessions: Number, meters: Number },
//       strength: { sessions: Number },
//     } | undefined,
//     // Phase 3.4 — capacityNote/layout/unplaced are ALL absent (not null) whenever targets or capacity
//     // isn't configured, so a legacy/unconfigured response stays byte-for-byte what this endpoint already
//     // produced before this phase existed. capacityNote is set only when applyCapacityBackstop actually
//     // had to reduce a discipline's number to fit the week's real free time (the deterministic, code-only
//     // guarantee behind "never present a target the week cannot hold" — targets above are already final).
//     capacityNote: String | undefined,
//     availableSummary: { totalFreeMin: Number, daysWithTimeCount: Number } | undefined,   // the card's
//     // "Available this week: 6h20 across 5 days" line — present whenever capacity was configured,
//     // trimmed or not.
//     // layout: each remaining day that received at least one session (days with nothing placed are
//     // simply absent, not an empty entry). Each session is pre-sized in code (buildSessionsToPlace) —
//     // the model only chose WHICH day; code re-validated every placement (budget, allowed discipline, no
//     // two hard:true sessions on adjacent dates) before this shape was built (buildFinalLayout).
//     layout: [{ weekday: String, dateKey: String, sessions: [{ id, discipline, kind, activityTypeId: String|null, activityName: String, targetAmount: Number|null, unit: String, estMinutes: Number }] }] | undefined,
//     // unplaced: every targets-mode session that could NOT be placed anywhere this week, each with a
//     // real reason — never silently dropped. Includes sessions seeded unplaceable before the model was
//     // even asked (e.g. a discipline with no allowed day at all this week) as well as ones the model
//     // failed to place or whose placement violated a constraint.
//     unplaced: [{ id: String, reason: String }] | undefined,
//     rationale: String,
//   } }
//
// MODE 2 — POST /api/training?mode=today&secret=...
//   Recommends one specific session for today, Whoop-adjusted. Phase 4
//   of the multi-activity-type generalization — reads weekPlan.cardio
//   (Phase 3's shape) instead of the old weekPlan.running, and can
//   recommend by whatever activity each cardio piece was actually
//   assigned (not just running). Reuses Phase 3's cardio-slot output
//   as-is rather than independently choosing an activity itself — this
//   mode only decides WHICH of the week's already-assigned pieces (if
//   any) is due today, same as it always only decided which of the
//   week's already-assigned running pieces was due.
//   Body: {
//     weekPlan: { strength: {...}, cardio: {...}, rationale } | null,   // from mode=plan (Phase 3 shape)
//     progress: {
//       strengthSessionsDone: Number, strengthSessionsTarget: Number,
//       cardioAmountDone: Number, cardioAmountTarget: Number, cardioUnit: String,
//       // Raw sessions logged since Monday, NOT pre-classified into
//       // interval/long-session/easy — the model infers which piece of
//       // the plan each one likely satisfied from its own activityTypeId
//       // + distance/duration/effort (a rule-based classifier here would
//       // be guesswork; the model reasoning over the same numbers isn't).
//       activitiesThisWeek: [{ dateKey, activityTypeId, distanceKm, count, durationMin, effort }],
//     } | null,
//     whoopToday: { recoveryPct: Number|null, strain: Number|null } | null,
//     whoopRecentStrain: [{ date, strain }] | null,
//     todayCalendar: { padelToday: Boolean, padelEventTitle: String|null } | null,
//     // padelToday is computed client-side (gym.html) from a live Google
//     // Calendar fetch (reusing topbar.js's gatherTodayContext(), not a
//     // second calendar-fetch implementation) filtered to the user's
//     // DayLib-effective "today" and matched case-insensitively against
//     // "padel"/"pádel". Treated as a high-intensity commitment, same
//     // spirit as low Whoop recovery — see buildTodaySystemPrompt's PADEL
//     // section.
//     feasibility: {   // Phase 2 (today) + Phase 3.2 (tomorrow, same shape): computed entirely
//     // client-side — gym.html's buildTodayFeasibility for today, main.html's buildTomorrowFeasibility
//     // (a generalization of the same arithmetic for an arbitrary target date) for forTomorrow — from the
//     // user's configured training-availability template/override (General Settings) and that day's REAL
//     // Google Calendar gaps before bedtime. Today's version additionally caps budgetMin by time actually
//     // remaining before bedtime RIGHT NOW (the day has already started); tomorrow's version does not
//     // (the whole day is still ahead) — see each function's own comments for the exact arithmetic
//     // (free-gap subtraction, duration estimation, the "after midnight" bedtime rule). Re-sanitized here
//     // (sanitizeFeasibility) and never trusted blindly — see buildFeasibilityPromptSection and the
//     // applyFeasibilityBackstop code-level re-check after the model responds, same "model picks among
//     // candidates code already proved feasible, code re-validates the pick" discipline as
//     // dropBlocksOverlappingFixedEvents/isCardioTypeBlocked.
//     configured: Boolean,   // false (the only other field) whenever no availability template exists or there's no
//     // weekPlan to draw candidates from — the prompt gets ZERO new feasibility section in that case, so
//     // an unconfigured user's output is byte-for-byte what this endpoint already produced before Phase 2.
//     budgetMin: Number | null, longestFreeBlockMin: Number,
//     allowedDisciplines: { swim: Boolean, bike: Boolean, run: Boolean, strength: Boolean },
//     candidates: [{ key: String, label: String, estMinutes: Number | null, feasible: Boolean }],
//   } | undefined,
//     forTomorrow: Boolean,   // main.html's "Plan my day" Tomorrow toggle — see below
//     todayRecommendation: String | null,   // forTomorrow ONLY: what was already decided/done TODAY, so the
//     // model can avoid stacking two demanding days back to back — see buildTomorrowSystemPrompt.
//   }
//   -> { ok: true, recommendation: String }
//   When forTomorrow is true, uses buildTomorrowSystemPrompt instead of buildTodaySystemPrompt — same
//   weekPlan/progress/strengthContext/activeRestrictions inputs, but WHOOP recovery is NOT treated as
//   predictive of the target day (today's whoopToday/whoopRecentStrain may still be sent and are used only
//   as general recent-trend background, never as a specific prediction) and there is no padel/calendar
//   input — reasons instead from the week's remaining objectives, general load-management judgment, and
//   todayRecommendation. Same reasoning api/chat.js's own QUESTIONS ABOUT A DIFFERENT DAY section already
//   established for this exact distinction.
//
// MODE 3 — POST /api/training?mode=day-plan&secret=...
//   Proposes a full day's schedule (main.html's "Plan my day"). Never
//   creates anything itself — returns a list of candidate blocks for
//   the client to render and the user to explicitly confirm before any
//   real Google Calendar event is created.
//   Body: {
//     todayDateKey: 'YYYY-MM-DD', tomorrowDateKey: 'YYYY-MM-DD',   // from DayLib.effectiveDateKey(), client-side
//     nowTime: 'HH:MM',   // REQUIRED — actual current wall-clock time, client-side. Without this the
//     // model has no way to know a plan generated mid-day shouldn't schedule things (like breakfast)
//     // that have already passed — see buildDayPlanSystemPrompt's FIXED section below and the bug this
//     // fixes (a 1:20pm request proposing a 7:30am breakfast block, since only the DATE was ever sent,
//     // never the time-of-day the request was actually made).
//     planningDateKey: 'YYYY-MM-DD',   // main.html's Today/Tomorrow toggle — must equal todayDateKey or
//     // tomorrowDateKey; defaults to todayDateKey (the ORIGINAL, only-ever-today behavior) if omitted or
//     // anything else, so an older/unmodified caller needs zero changes.
//     planningRecommendation: String | null,   // whichever training recommendation applies to
//     // planningDateKey — gym.html's cached mode=today result when planning today (Phase 1, padel-aware,
//     // reused verbatim, NOT recomputed here), or a mode=today?forTomorrow=true result when planning
//     // tomorrow (see that mode's own doc comment). Still accepted under the old name
//     // (todayRecommendation) too, for backward compatibility.
//     whoopToday: { recoveryPct: Number|null } | null,
//     fixedEvents: [{ date, start, end, title, allDay }],   // today + tomorrow's REAL existing Calendar events — immovable
//     wakeUpTime: 'HH:MM',   // pre-computed CLIENT-SIDE as the EARLIER of tomorrow's own configured Day
//     // Ring wake time (dayRingSchedule[tomorrowWeekday].wake) and a prep buffer before tomorrow's
//     // earliest TIMED fixedEvents entry, if any — not asked of the model — exact clock-arithmetic is a
//     // poor fit for an LLM to get reliably right, whereas fitting flexible blocks around fixed anchors
//     // is exactly the kind of judgment call worth spending a model call on. See
//     // buildDayPlanSystemPrompt's FIXED section below. (Previously this was ALWAYS derived from
//     // tomorrow's earliest fixed event alone, with no floor from the configured wake time — so a day
//     // whose only fixed event was in the afternoon [e.g. 2:15pm] produced a nonsensical afternoon
//     // "Wake up" block [1:30pm, 45min before it]. Taking the earlier of the two fixes that while still
//     // pulling wake-up earlier for a genuine early commitment, like a 6am flight.) ONLY used for
//     // tomorrow's "Wake up" block — do not confuse with todayWakeUpTime or todayBedtime below, both
//     // different things about TODAY.
//     todayWakeUpTime: 'HH:MM', todayBedtime: 'HH:MM',
//     // TODAY's own already-configured wake/sleep times, read client-side from General Settings' Day
//     // Ring per-weekday schedule (dayRingSchedule[todayWeekday].wake/.sleep — see main.html's Day Ring
//     // feature) by TODAY's actual weekday, NOT inferred from any calendar event. todayWakeUpTime is the
//     // anchor for how early today's morning-anchored blocks (breakfast) may start; todayBedtime is
//     // where tonight's "Wind-down" block ends. Neither is itself output as a block (todayWakeUpTime
//     // isn't output at all; todayBedtime is only ever the END time of the Wind-down block).
//     // (An earlier version of this endpoint instead inferred tonight's bedtime from tomorrow's
//     // wakeUpTime and a sleepTargetHours target — that ignored the user's actual configured sleep
//     // time entirely, the same class of bug already fixed for wake-up via todayWakeUpTime. Removed:
//     // nothing else read sleepTargetHours or that inferred bedtime once Wind-down uses todayBedtime.)
//     userActivities: [{ name, durationMin, preferredWindow }] | undefined,   // main.html's "+ Add
//     // activity" chips — user-specified items that MUST be placed on planningDateKey (or reported
//     // as unplaced with a reason), unlike the "WHAT YOU DECIDE" items which the model is free to
//     // omit/adjust. preferredWindow is one of PREFERRED_WINDOWS below or omitted. Capped at 10,
//     // durationMin clamped to 5-480 — see sanitizeUserActivities.
//     isRaceDay: Boolean | undefined,   // main.html computes this client-side (planningDateKey ===
//     // the active Plan's raceDate, via DayLib.effectiveDateKey()/plainDateKey() — same date-key
//     // convention as todayDateKey/tomorrowDateKey, no new date logic on the server) and forwards it
//     // here. When true, buildRaceDaySystemPrompt replaces the normal "WHAT YOU DECIDE" section
//     // (no training/work/meal/walk defaults at all) with race-logistics blocks instead — arrival,
//     // warmup, transition setup, post-race recovery/food. Everything else (fixedEvents, wake/bedtime,
//     // nowTime, userActivities, restrictions, the propose-then-confirm JSON shape, and every
//     // server-side safety check below) is completely unchanged — this only swaps which system
//     // prompt gets built, same branching style mode=today already uses for forTomorrow.
//   }
//   -> { ok: true, blocks: [{ date, start, end, title, category }], unplaced: [{ name, reason }] }
//   // unplaced lists any userActivities entry that genuinely couldn't be fit in (never silently
//   // dropped — see reconcileUserActivities, which also catches one the model forgot entirely or
//   // that got removed by dropBlocksOverlappingFixedEvents). Always present, [] when everything fit
//   // (including when userActivities itself was empty/omitted).
//
// MODE 4 — POST /api/training?mode=find-patterns&secret=...
//   trends.html's "Find Patterns" feature — on-demand only, never
//   triggered automatically. Looks for genuine cross-domain
//   correlations across the SAME historical data trends.html's own 7
//   charts already compute (Today's Score, habits %, body weight,
//   Cronometer protein/calories %, WHOOP recovery/sleep %, strength
//   sessions/week, activity distance/pace) — something no single
//   source app (Cronometer, WHOOP) could ever see on its own, since it
//   needs all of these in one place. Every series here is exactly what
//   trends.html's own loadScoreTrend/loadWeightTrend/etc. already
//   computed for their charts (see that file's own comment on why
//   those functions now also RETURN their computed series, not just
//   render them) — this endpoint does none of that computation itself,
//   only sends it to Claude and validates the response shape.
//   Body: {
//     fromKey, toKey: 'YYYY-MM-DD',   // the exact range currently selected on trends.html
//     days: Number,                    // informational — same currentDays trends.html already tracks
//     score: [{ date, value }],        // Today's Score, 0-100
//     habits: [{ date, value }],       // manual-habit completion %, 0-100
//     weight: [{ date, value }], weightUnit: String,
//     nutrition: { protein: [{ date, value }], calories: [{ date, value }] },   // % of target, 0-100+
//     whoop: { recovery: [{ date, value }], sleep: [{ date, value }] },          // %, 0-100
//     strength: [{ weekStart, sessions }],           // sessions completed that week
//     activities: { distance: [{ date, km }], pace: [{ date, minPerKm }] },     // per real logged session
//   }
//   Every series is pre-filtered to REAL logged values only (no nulls/
//   gaps sent at all — see trends.html's own comment) — compact, and
//   the model never has to guess what a null means.
//   -> { ok: true, findings: [String, ...] }   // 1-6 short, specific, data-grounded sentences;
//      may be a single honest "not enough data yet" sentence if the range is too sparse/short to
//      say anything reliable — see buildFindPatternsSystemPrompt's own instructions on why this is
//      required rather than optional.
//
// MODE 5 — POST /api/training?mode=weekly-review&secret=...
//   trends.html's "Ver mi semana" (Weekly Review) feature — on-demand
//   only, same as find-patterns. A holistic "how was my week" recap
//   across every domain at once, fixed to the most recent 7 days
//   (trends.html switches its own range tabs to 7D before gathering
//   this, so the charts above always agree with what's being
//   reviewed) — DIFFERENT from find-patterns (which hunts for cross-
//   domain correlations over a longer, user-selected window) and from
//   Plan's own weekly nudge (which only reviews progress toward one
//   specific active goal). Same series shapes as find-patterns' body
//   (see that mode's own doc above) PLUS:
//     finance: { available: Boolean, currency, netWorthTotal, subscriptionsCount,
//                subscriptionsMonthlyTotal, daysStale } | { available: false }
//   — a CURRENT SNAPSHOT (finance.html's own buildFinanceSummary(),
//   already synced to api/sync-state.js/app_state for
//   api/daily-checkin.js — trends.html reads that same row directly
//   via Supabase, see this mode's own handler comment), not a
//   week-over-week series; there is no daily/weekly finance history
//   anywhere in this app to send instead.
//   -> { ok: true, fromKey, toKey, summary: String, highlights: [String, ...] }
//      summary: 2-3 sentences, the week's overall shape (honestly mixed if it was).
//      highlights: 2-4 short, specific, number-grounded observations — never
//      generic encouragement, and explicit when a domain had too little logged
//      this week to say anything about — see buildWeeklyReviewSystemPrompt's
//      own instructions.
// =============================================================

const MAX_BODY_CHARS = 30000;

function checkAuth(req, res) {
  const expected = process.env.DASHBOARD_SECRET;
  if (!expected) {
    res.status(500).json({ ok: false, error: 'Server not configured (missing DASHBOARD_SECRET env var).' });
    return false;
  }
  const given = (req.query && req.query.secret) || req.headers['x-dashboard-secret'];
  if (!given || given !== expected) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return false;
  }
  return true;
}

function extractJson(text) {
  try { return JSON.parse(text); } catch (e) {}
  const m = /\{[\s\S]*\}/.exec(text);
  if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  return null;
}

// `effort` is optional and maps to Anthropic's output_config.effort
// (low/medium/high/xhigh/max) — claude-sonnet-5 uses adaptive thinking
// on by default at "high" effort (the API default when omitted), which
// can spend a large share of max_tokens on internal reasoning before
// ever writing output text. Omit `effort` to keep that default
// (handlePlan's multi-field weekly plan genuinely benefits from more
// headroom); pass 'low' for simple, short-output tasks like
// handleToday's one-line recommendation, where high-effort adaptive
// thinking was consuming the whole 800-token budget on reasoning and
// leaving a literal empty string for the actual answer.
async function callClaude(apiKey, { system, userContent, maxTokens, effort, debugLabel }) {
  const body = {
    model: 'claude-sonnet-5',
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: userContent }],
  };
  if (effort) body.output_config = { effort };
  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    throw new Error('Anthropic API error (' + anthropicRes.status + '): ' + errText.slice(0, 500));
  }
  const data = await anthropicRes.json();
  // Find the actual text block rather than assuming content[0] is it —
  // when thinking fires, the response's content array starts with a
  // thinking block, and content[0].text on that block is undefined. This
  // matches the pattern api/chat.js and api/daily-checkin.js already use.
  const textBlock = (data && data.content || []).find((b) => b && b.type === 'text');
  // TEMPORARY (diagnosing "Model did not return valid JSON" on
  // mode=plan) — logs to Vercel's function logs only, never sent to
  // the client. Same "high-effort adaptive thinking consumes the
  // max_tokens budget before any output text is written" failure
  // class already fixed for mode=today and the chat endpoint, but NOT
  // assumed here — handlePlan's own prompt has grown substantially
  // since effort was last tuned (activity types, restrictions,
  // cardio-slot logic all added later), so this logs stop_reason,
  // every content block's type, and the actual raw text (not just
  // whether it's empty) to tell that failure class apart from a
  // genuinely malformed/truncated JSON body instead — only gated by
  // debugLabel so it stays silent for every other mode's calls.
  // Remove once the real cause is confirmed and fixed.
  if (debugLabel) {
    const blockTypes = (data && data.content || []).map((b) => b && b.type);
    console.log(
      '[' + debugLabel + ' debug] stop_reason=' + (data && data.stop_reason),
      'blockTypes=' + JSON.stringify(blockTypes),
      'usage=' + JSON.stringify((data && data.usage) || null),
      'rawText=' + JSON.stringify(textBlock ? textBlock.text : null)
    );
  }
  return textBlock ? textBlock.text : '';
}

// ------------------------------------------------------------
// Active restrictions (see api/chat.js's propose_restriction tool +
// api/sync-state.js's resource=restrictions) — shared across all
// three modes below. The client fetches whatever's active as of
// today (DayLib-effective) and sends it in the request body, same
// "client gathers context, this endpoint stays stateless" convention
// every other input here already follows; this file never talks to
// Supabase itself.
// ------------------------------------------------------------

function sanitizeRestrictions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 20).map((r) => ({
    text: typeof (r && r.text) === 'string' ? r.text.slice(0, 300) : '',
    scope: typeof (r && r.scope) === 'string' ? r.scope.toLowerCase().slice(0, 50) : null,
  })).filter((r) => r.text);
}
function restrictedScopeSet(restrictions) {
  return new Set((restrictions || []).map((r) => r && r.scope).filter(Boolean));
}
// Appended to a system prompt when restrictions are present — kept as
// hard constraints in the model's instructions AND, where a
// restriction's scope maps directly onto a structured field (running/
// strength targets), enforced again in code afterward (see
// normalizePlan/restrictedScopeSet below) rather than trusting the
// model's compliance alone.
function buildRestrictionsPromptSection(restrictions) {
  if (!restrictions || !restrictions.length) return '';
  return (
    'ACTIVE RESTRICTIONS — the user explicitly told you about these via the chat (propose_restriction) and ' +
    'they are currently in effect; treat them as hard constraints, not soft preferences:\n' +
    JSON.stringify(restrictions, null, 2) + '\n' +
    'If a restriction\'s scope is "running", do not include or recommend ANY running today or this week ' +
    '(interval, long run, or easy volume all included) — treat it as fully off-limits for its duration. If ' +
    'scope is "strength", do not include or recommend strength training at all. If scope is "padel" or ' +
    'unset/other, use the restriction\'s own text to judge what it rules out. Never silently ignore an ' +
    'active restriction, and never suggest working around one creatively (e.g. proposing a "light run" when ' +
    'running is restricted).\n\n'
  );
}

// Phase 2 of the training-availability feature. Never trusts the
// client's feasibility object blindly (even though it's purely
// informational for the prompt, not itself a security boundary) —
// same "re-validate everything from the client" discipline this file
// already applies to restrictions/weekPlan/etc. Any malformed or
// missing field collapses to {configured:false}, which produces a
// prompt byte-for-byte identical to pre-Phase-2 behavior.
function sanitizeFeasibility(raw) {
  if (!raw || typeof raw !== 'object' || !raw.configured) return { configured: false };
  const rawAllowed = raw.allowedDisciplines && typeof raw.allowedDisciplines === 'object' ? raw.allowedDisciplines : {};
  const allowedDisciplines = {
    swim: rawAllowed.swim !== false,
    bike: rawAllowed.bike !== false,
    run: rawAllowed.run !== false,
    strength: rawAllowed.strength !== false,
  };
  const candidates = Array.isArray(raw.candidates)
    ? raw.candidates.slice(0, 10).map((c) => ({
        key: (c && typeof c.key === 'string') ? c.key.slice(0, 40) : '',
        label: (c && typeof c.label === 'string') ? c.label.slice(0, 80) : '',
        estMinutes: (c && typeof c.estMinutes === 'number' && isFinite(c.estMinutes)) ? c.estMinutes : null,
        feasible: !!(c && c.feasible),
      })).filter((c) => c.key && c.label)
    : [];
  return {
    configured: true,
    budgetMin: (typeof raw.budgetMin === 'number' && isFinite(raw.budgetMin)) ? raw.budgetMin : null,
    longestFreeBlockMin: (typeof raw.longestFreeBlockMin === 'number' && isFinite(raw.longestFreeBlockMin)) ? raw.longestFreeBlockMin : 0,
    allowedDisciplines,
    candidates,
  };
}
// Phase 4.1 — today's own slice of gym.html's client-computed
// buildRebalanceLayout() result (one {weekday,dateKey,sessions:[...]}
// entry, or absent/null when nothing is behind). This file never
// recomputes or validates the sizing/placement itself — it was
// already decided and capped in code client-side — only passes
// through enough for the model to describe it in words (see
// buildRebalanceTodayPromptSection). Anything malformed collapses to
// null, same as every other optional context field here.
function sanitizeRebalanceToday(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sessions)) return null;
  const sessions = raw.sessions.slice(0, 10).map((s) => ({
    discipline: (s && typeof s.discipline === 'string') ? s.discipline.slice(0, 20) : '',
    kind: (s && typeof s.kind === 'string') ? s.kind.slice(0, 20) : '',
    targetAmount: (s && typeof s.targetAmount === 'number' && isFinite(s.targetAmount)) ? s.targetAmount : null,
    unit: (s && typeof s.unit === 'string') ? s.unit.slice(0, 10) : '',
    estMinutes: (s && typeof s.estMinutes === 'number' && isFinite(s.estMinutes)) ? s.estMinutes : null,
    activityName: (s && typeof s.activityName === 'string') ? s.activityName.slice(0, 80) : '',
    // Phase 4.1 fix (reported contradiction) — a missed STRENGTH
    // day-type pick carries its own real day-type name + the weekday
    // it was missed, so the no-contradiction backstop below can build
    // a clean label ("Pull (missed Wednesday)") without parsing text
    // out of the free-form `reason` string.
    dayType: (s && typeof s.dayType === 'string') ? s.dayType.slice(0, 40) : '',
    weekday: (s && typeof s.weekday === 'string') ? s.weekday.slice(0, 20) : '',
  })).filter((s) => s.discipline);
  if (!sessions.length) return null;
  return { sessions };
}
// BUG FIX (reported) — today's own REAL, already-sized session from
// plan.layout (same sessions shape as rebalanceToday above, just a
// client-side lookup of today's existing day in the already-generated
// layout rather than a rebalance pick) — lets describeRhythmEntryForToday
// show the real size ("Run interval 3km") instead of trusting the
// model to mention, or correctly state, a number it was never given.
function sanitizeTodayLayoutEntry(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sessions)) return null;
  const sessions = raw.sessions.slice(0, 10).map((s) => ({
    discipline: (s && typeof s.discipline === 'string') ? s.discipline.slice(0, 20) : '',
    targetAmount: (s && typeof s.targetAmount === 'number' && isFinite(s.targetAmount)) ? s.targetAmount : null,
    unit: (s && typeof s.unit === 'string') ? s.unit.slice(0, 10) : '',
  })).filter((s) => s.discipline);
  if (!sessions.length) return null;
  return { sessions };
}

// Lists ONLY the already-feasible candidates (computed client-side in
// code, never asked of the model) and instructs the model to pick
// exclusively from them — or to say so briefly and recommend rest/a
// short alternative when none fit. Returns '' when feasibility isn't
// configured at all, so an unconfigured user's prompt is unchanged.
// dayLabel (Phase 3.2): defaults to 'today', so every pre-3.2 call
// site (buildTodaySystemPrompt) keeps the exact same STRUCTURE and
// MEANING — only "remaining"->"free" in two spots changed cosmetically
// so the wording also reads correctly for 'tomorrow' (nothing is
// "remaining" on a day that hasn't started). buildTomorrowSystemPrompt
// passes 'tomorrow' so the same feasibility SHAPE (budgetMin/
// longestFreeBlockMin/allowedDisciplines/candidates — computed
// client-side by main.html's own buildTomorrowFeasibility, a
// generalization of gym.html's Phase 2 buildTodayFeasibility for an
// arbitrary target date) reads naturally for either day without a
// second, nearly-identical prompt-section function.
function buildFeasibilityPromptSection(feasibility, dayLabel) {
  dayLabel = dayLabel || 'today';
  const dayLabelCap = dayLabel.charAt(0).toUpperCase() + dayLabel.slice(1);
  if (!feasibility || !feasibility.configured) return '';
  const feasible = feasibility.candidates.filter((c) => c.feasible);
  const infeasible = feasibility.candidates.filter((c) => !c.feasible);
  return (
    'AVAILABILITY & TIME BUDGET — computed in code from the user\'s configured training-availability ' +
    '(General Settings) and ' + dayLabel + '\'s REAL free Google Calendar gaps before bedtime; do not ' +
    'second-guess or recompute these numbers yourself. ' + dayLabelCap + '\'s time budget: ' +
    (feasibility.budgetMin != null ? feasibility.budgetMin + ' minutes' : 'not separately capped') +
    '. Longest single free block before bedtime: ' + feasibility.longestFreeBlockMin + ' minutes. Allowed ' +
    'disciplines ' + dayLabel + ': ' + JSON.stringify(feasibility.allowedDisciplines) + '.\n' +
    'Of this week\'s plan pieces, only the following have ALREADY been confirmed to fit ' + dayLabel + '\'s time and ' +
    'discipline constraints — combine your strength/cardio reasoning above with this list, and recommend ' +
    'ONLY from it (never recommend a plan piece not listed here as feasible, even if the sections above ' +
    'would otherwise suggest it):\n' +
    (feasible.length
      ? JSON.stringify(feasible.map((c) => ({ key: c.key, label: c.label, estMinutes: c.estMinutes })), null, 2)
      : '(none — nothing in this week\'s plan fits ' + dayLabel + '\'s free time or allowed disciplines)') + '\n' +
    (infeasible.length ? 'NOT feasible ' + dayLabel + ' (do not recommend these): ' + JSON.stringify(infeasible.map((c) => c.label)) + '.\n' : '') +
    'If the feasible list is empty, say so briefly and recommend rest or a short, generic alternative that ' +
    'genuinely fits the free time (e.g. "Rest — not enough free time ' + dayLabel + '", "Short easy walk only — ' +
    'limited time ' + dayLabel + '") instead of recommending anything from this week\'s plan.\n\n'
  );
}

// Final code-level re-check after the model responds (same discipline
// as dropBlocksOverlappingFixedEvents/isCardioTypeBlocked elsewhere in
// this project): the model was already told to pick only from the
// feasible list, but its text is re-validated anyway rather than
// trusted blindly. Keyword-matches the SAME discipline names
// feasibility.allowedDisciplines carries; if the recommendation names
// a discipline that's disallowed today, it's swapped for the most
// time-using feasible candidate (or a plain rest fallback if none).
const BACKSTOP_DISCIPLINE_PATTERNS = {
  swim: /swim/i,
  bike: /\b(bike|cycl|ride|spin)/i,
  run: /\b(run|jog)/i,
  strength: /\b(push|pull|legs|explosive|strength|upper[- ]?body|lower[- ]?body|full[- ]?body)\b/i,
};
function applyFeasibilityBackstop(recommendation, feasibility) {
  if (!feasibility || !feasibility.configured) return recommendation;
  const disallowed = Object.keys(BACKSTOP_DISCIPLINE_PATTERNS).filter((d) => feasibility.allowedDisciplines[d] === false);
  const violatesDiscipline = disallowed.some((d) => BACKSTOP_DISCIPLINE_PATTERNS[d].test(recommendation));
  if (!violatesDiscipline) return recommendation;
  const feasible = (feasibility.candidates || []).filter((c) => c.feasible).slice().sort((a, b) => (b.estMinutes || 0) - (a.estMinutes || 0));
  if (!feasible.length) return 'Rest — nothing in this week\'s plan fits today\'s available time/disciplines';
  return feasible[0].label;
}
// BUG FIX (reported) — todayLayoutEntry (optional — see
// sanitizeTodayLayoutEntry's own comment) is today's REAL,
// already-sized session from plan.layout; when present and it has a
// matching discipline, its real targetAmount/unit is appended (e.g.
// "Run interval 3km") instead of a bare kind name. The model is never
// told this number and can't be trusted to state or guess it, so this
// is the one place it's guaranteed to show up, independent of
// whatever the model actually wrote.
function describeRhythmEntryForToday(entry, todayLayoutEntry) {
  if (entry.discipline === 'rest') return 'Rest';
  if (entry.discipline === 'strength') {
    // A typed day shows its real name directly ("Push", "Explosive"),
    // matching the exact convention strengthContext.todaySplitDay
    // already uses elsewhere — never "Strength Push". 'auto' (or
    // unset) shows the generic "Strength", same as before this day-
    // type feature existed.
    return (entry.kind && entry.kind !== 'auto') ? (entry.kind.charAt(0).toUpperCase() + entry.kind.slice(1)) : 'Strength';
  }
  const disc = entry.discipline.charAt(0).toUpperCase() + entry.discipline.slice(1);
  const layoutSession = todayLayoutEntry && Array.isArray(todayLayoutEntry.sessions)
    ? todayLayoutEntry.sessions.find((s) => s.discipline === entry.discipline)
    : null;
  const sizeLabel = (layoutSession && layoutSession.targetAmount) ? (' ' + layoutSession.targetAmount + (layoutSession.unit || '')) : '';
  return disc + (entry.kind ? ' ' + entry.kind : '') + sizeLabel;
}
// Phase 4.1 fix (reported contradiction) — matches the model's own
// "Rest"/"nothing feasible" phrasing (buildTodaySystemPrompt's own
// FORMAT examples: "Rest — recovery is low", "Rest — padel today",
// applyFeasibilityBackstop's own canned "Rest — nothing in this
// week's plan fits..."). Used to detect when the model is CLAIMING
// nothing is feasible, so that claim can be checked against the same
// code-provable reasons as everything else in this backstop, rather
// than trusted blindly.
const REST_TEXT_RE = /^rest\b|nothing (is )?feasible/i;
// Builds the SAME short-label style the rest of this prompt already
// uses (describeRhythmEntryForToday's own convention, e.g. "Push
// (missed Monday)") from code's own already-validated rebalance pick
// — never from free text, and never restating a conflicting "Rest"
// claim alongside it.
function describeRebalanceTodayPick(sessions) {
  return sessions.map((s) => {
    if (s.discipline === 'strength') {
      const name = s.dayType ? (s.dayType.charAt(0).toUpperCase() + s.dayType.slice(1)) : 'Strength';
      return name + (s.weekday ? ' (missed ' + s.weekday + ')' : '');
    }
    const name = s.activityName || (s.discipline.charAt(0).toUpperCase() + s.discipline.slice(1));
    const amount = s.targetAmount ? (' ' + s.targetAmount + (s.unit || '')) : '';
    return name + amount;
  }).join(' + ');
}
// BUG FIX (reported) — the old fast path here only checked whether
// the rhythm's PRIMARY entry was mentioned SOMEWHERE in the
// recommendation string, then trusted the ENTIRE string verbatim —
// "Push + Running interval" mentions "Push" (the Monday rhythm entry)
// so it passed unchanged, silently keeping the invented "Running
// interval" clause the model tacked on (there is no interval, or any
// run at all, scheduled for Monday — the first run is Tuesday). This
// re-validates EVERY "+"-joined clause (the model's own convention,
// see buildTodaySystemPrompt's own example) against an explicit
// allowlist — today's rhythm entries plus any code-computed
// rebalanceToday catch-up session — and drops anything that matches
// neither, rather than trusting the model's pick blindly just because
// SOME part of it was right.
function clauseMatchesDescriptor(clause, discipline, kind) {
  const disciplinePattern = BACKSTOP_DISCIPLINE_PATTERNS[discipline];
  if (!disciplinePattern || !disciplinePattern.test(clause)) return false;
  if (!kind || kind === 'auto') return true;
  return new RegExp('\\b' + kind + '\\b', 'i').test(clause);
}
function buildAllowedRhythmDescriptors(rhythmForDay, rebalanceToday) {
  const allowed = (rhythmForDay || []).filter((e) => e.discipline !== 'rest').map((e) => ({ discipline: e.discipline, kind: e.kind }));
  if (rebalanceToday && Array.isArray(rebalanceToday.sessions)) {
    rebalanceToday.sessions.forEach((s) => {
      // A missed-strength-day-type pick carries the real day type in
      // `dayType` (see sanitizeRebalanceToday's own comment) — `kind`
      // itself is just the literal placeholder 'auto' for that case.
      const kind = (s.discipline === 'strength' && s.dayType) ? s.dayType : s.kind;
      allowed.push({ discipline: s.discipline, kind });
    });
  }
  return allowed;
}
// Only called once the recommendation has ALREADY been confirmed to
// mention the rhythm's primary entry (the caller's own fast-path
// condition). Every "+"-joined clause (the model's own convention) is
// checked independently against the allowlist; a single-clause
// recommendation is handled the exact same way (one clause to check).
// BUG FIX (reported) — the clause matching the PRIMARY rhythm entry is
// always REPLACED with describeRhythmEntryForToday's own canonical,
// sized description rather than kept as the model wrote it — the
// model is never told today's real size, so its own phrasing can't
// be trusted to include (or get) it; code already knows it from
// todayLayoutEntry. Any OTHER kept clause (a validated rebalanceToday
// catch-up session) is left exactly as the model wrote it — those are
// already told their own real numbers in the prompt.
function stripUnvalidatedRhythmClauses(recommendation, rhythmForDay, rebalanceToday, todayLayoutEntry) {
  const clauses = recommendation.split(/\s+\+\s+/).map((c) => c.trim()).filter(Boolean);
  const primaryEntry = rhythmForDay[0];
  const allowed = buildAllowedRhythmDescriptors(rhythmForDay, rebalanceToday);
  const dropped = [];
  const kept = clauses.filter((clause) => {
    const ok = allowed.some((d) => clauseMatchesDescriptor(clause, d.discipline, d.kind));
    if (!ok) dropped.push(clause);
    return ok;
  });
  const primaryIdx = kept.findIndex((clause) => clauseMatchesDescriptor(clause, primaryEntry.discipline, primaryEntry.kind));
  const canonicalPrimary = describeRhythmEntryForToday(primaryEntry, todayLayoutEntry);
  if (primaryIdx !== -1) kept[primaryIdx] = canonicalPrimary;
  const text = kept.length ? kept.join(' + ') : canonicalPrimary;
  return dropped.length ? text + ' (dropped unscheduled: ' + dropped.join(', ') + ')' : text;
}
// Phase 3.5 — the LAST-resort code check: the prompt already tells
// the model today's rhythm entry is the default and to only deviate
// for a short, specific list of checkable reasons (buildRhythm
// PromptSection). This re-verifies that at least ONE of those reasons
// is actually, verifiably true from the same inputs the prompt had —
// never from the model's own text, which could just assert a reason
// that isn't real. If the model's recommendation names a different
// discipline+kind AND none of those reasons check out, the rhythm
// entry wins outright — same "never trust the model's pick blindly"
// discipline as applyFeasibilityBackstop above.
function applyRhythmBackstop(recommendation, rhythmForDay, feasibility, restrictions, whoopToday, strengthContext, rebalanceToday, todayLayoutEntry) {
  if (!Array.isArray(rhythmForDay) || !rhythmForDay.length) return recommendation;
  const entry = rhythmForDay[0]; // a second same-day session, if any, is additive on top of the primary one this backstop concerns itself with
  if (entry.discipline === 'rest') return recommendation; // nothing to default to or compare against
  const disciplinePattern = BACKSTOP_DISCIPLINE_PATTERNS[entry.discipline];
  const mentionsDiscipline = disciplinePattern ? disciplinePattern.test(recommendation) : false;
  const mentionsKind = !entry.kind || entry.kind === 'auto' || new RegExp('\\b' + entry.kind + '\\b', 'i').test(recommendation);
  if (mentionsDiscipline && mentionsKind) return stripUnvalidatedRhythmClauses(recommendation, rhythmForDay, rebalanceToday, todayLayoutEntry); // matches the rhythm -- still validate every "+"-joined clause

  // Restriction scope values are "running"/"strength"/"padel" (see
  // api/chat.js's propose_restriction tool) — a different vocabulary
  // from the rhythm's own run/bike/swim/strength discipline keys, not
  // the same string. Bike/swim have no scope value of their own in
  // that enum at all (an injury affecting them would be logged with
  // scope omitted instead), so they can never match a restriction
  // here — consistent with the restriction system's own real
  // limitation, not something new this backstop invents.
  const RHYTHM_DISCIPLINE_TO_RESTRICTION_SCOPE = { run: 'running', strength: 'strength' };
  const restrictedScopes = restrictedScopeSet(restrictions);
  const isRestricted = restrictedScopes.has(RHYTHM_DISCIPLINE_TO_RESTRICTION_SCOPE[entry.discipline]);
  const feasibilityKillsIt = !!(feasibility && feasibility.configured && feasibility.allowedDisciplines && feasibility.allowedDisciplines[entry.discipline] === false);
  const recoveryPct = whoopToday && typeof whoopToday.recoveryPct === 'number' ? whoopToday.recoveryPct : null;
  const recoveryLow = recoveryPct != null && recoveryPct < 34 && RHYTHM_HARD_KINDS.has(entry.kind);
  const hasMissedCatchUp = entry.discipline === 'strength' && !!(strengthContext && Array.isArray(strengthContext.missedDayTypes) && strengthContext.missedDayTypes.length);
  if (isRestricted || feasibilityKillsIt || recoveryLow || hasMissedCatchUp) return recommendation; // a real, code-checkable reason exists -- trust the model's own call

  // Phase 4.1 fix (reported contradiction) — the model may answer
  // "Rest"/"nothing feasible" only for one of the code-provable
  // reasons just checked above. None of them actually applied here,
  // so if the model STILL said Rest, trust CODE's own already-
  // validated rebalance pick (missed strength day-type / backlog
  // chunk, already capacity- and cap-checked by buildRebalanceLayout)
  // instead of blindly restoring the raw rhythm entry — and never
  // phrase the override as "X (today's rhythm) — was: Rest", which
  // reads as self-contradictory (naming a real session right next to
  // the model's own "nothing is feasible" claim).
  if (REST_TEXT_RE.test(recommendation.trim())) {
    if (rebalanceToday && Array.isArray(rebalanceToday.sessions) && rebalanceToday.sessions.length) {
      return describeRebalanceTodayPick(rebalanceToday.sessions);
    }
    return describeRhythmEntryForToday(entry, todayLayoutEntry); // no contradictory "was: Rest" tail
  }

  return describeRhythmEntryForToday(entry, todayLayoutEntry) + ' (today\'s rhythm) — was: ' + recommendation;
}

// ------------------------------------------------------------
// MODE: plan
// ------------------------------------------------------------

// Fixed, real-world equipment constraint — not something the client
// needs to send every time. If this ever changes, edit it here.
const EQUIPMENT_NOTE =
  'Equipment reality: the user currently only has a flat/adjustable bench press setup and ONE dumbbell ' +
  'for strength training — no barbell, no rack, no second dumbbell, no machines. Every strength ' +
  'suggestion MUST be doable with just those two things (e.g. single-arm/unilateral dumbbell work, ' +
  'bench press variations, tempo/pause reps, or bodyweight movements to fill gaps). Never suggest ' +
  'exercises that require equipment the user does not have.';

// ------------------------------------------------------------
// Recommendable activity types (Phase 3 of the multi-activity-type
// generalization — see api/sync-state.js's resource=activity-types and
// Phase 1/2's client-side work in gym.html). The client sends only the
// types currently marked recommendable:true; this file never fetches
// or knows about the full configured list, same "client gathers
// context, server stays stateless" convention as restrictions above.
// Falls back to a single built-in "Running" candidate if the field is
// missing entirely (an older/uncached client), matching gym.html's own
// default-seed fallback — but an EXPLICIT empty array is left as-is
// (a real "nothing is recommendable right now" signal), not upgraded
// to the fallback.
// ------------------------------------------------------------

const DEFAULT_RECOMMENDABLE_TYPES = [{ id: 'running', name: 'Running', unit: 'km', unitKind: 'distance' }];
const UNIT_KINDS = ['distance', 'count', 'duration'];

function sanitizeActivityTypes(raw) {
  if (!Array.isArray(raw)) return DEFAULT_RECOMMENDABLE_TYPES;
  return raw.slice(0, 20).map((t) => ({
    id: typeof (t && t.id) === 'string' ? t.id.slice(0, 60) : '',
    name: typeof (t && t.name) === 'string' ? t.name.slice(0, 60) : '',
    unit: typeof (t && t.unit) === 'string' ? t.unit.slice(0, 20) : '',
    unitKind: UNIT_KINDS.indexOf(t && t.unitKind) !== -1 ? t.unitKind : 'duration',
  })).filter((t) => t.id && t.name);
}

function buildPlanSystemPrompt(restrictions, recommendableTypes, activeWeekDisciplines, realSessionKinds) {
  const typesList = recommendableTypes.length
    ? JSON.stringify(recommendableTypes.map((t) => ({ id: t.id, name: t.name, unit: t.unit, unitKind: t.unitKind })), null, 2)
    : null;
  // FEATURE (reported) — realSessionKinds is the exact set of session
  // kinds the WEEK LAYOUT will actually contain this week (already
  // decided in code from the user's own weekly rhythm/plan, same
  // sessionsToPlace the layout section below lists) — present only
  // when a real layout exists (capacity configured). The model's
  // rationale/interval-slot text used to be written blind to this
  // (it only ever saw sessionsNeedingModelPlacement, the subset still
  // missing a day), so it kept narrating a generic "one interval
  // session for VO2 max" even on a week whose real rhythm has no
  // interval session at all — the exact reported bug. See
  // normalizePlan's stripInventedKindMentions for the code-level
  // backstop on top of this prompt instruction.
  const realSessionsNote = (realSessionKinds && realSessionKinds.length)
    ? 'REAL SESSIONS THIS WEEK (already decided in code from the user\'s own plan/rhythm, read-only, ' +
      'covers every discipline) — the ONLY session kinds that will actually appear this week: ' +
      realSessionKinds.join(', ') + '. Your rationale must describe ONLY these — never claim or imply a ' +
      'session kind/type exists this week (e.g. "an interval session", "a tempo run") unless it is ' +
      'literally in this list. If "interval" is not in this list, do not mention an interval/VO2-max ' +
      'session anywhere in your rationale, even if you still fill cardio.interval\'s own fields below ' +
      '(that field is a separate legacy slot kept for backward compatibility and is not necessarily shown ' +
      'to the user as a real scheduled session).\n\n'
    : '';
  return (
    realSessionsNote +
    (activeWeekDisciplines
      ? 'THIS WEEK\'S VOLUME TARGETS ARE ALREADY FIXED — ' + describeActiveWeekDisciplinesForPrompt(activeWeekDisciplines, recommendableTypes) + '. These come from the user\'s own long-term training plan, not from you, and the server computes the real numbers in code from that plan — it will IGNORE whatever longSession.targetAmount/easyVolume.targetAmount/strength.targetSessions numbers you write for the disciplines listed above. Do NOT invent different volume numbers for them. Your job here is only: (1) ' + (realSessionKinds && realSessionKinds.length ? 'propose a concrete interval/VO2-max session ONLY if "interval" appears in REAL SESSIONS THIS WEEK above — otherwise leave cardio.interval\'s activityTypeId null and targetSessions 0, and do not describe one' : 'still propose ONE concrete interval/VO2-max session') + ' (activityTypeId from the recommendable list below, matching whichever of run/bike makes sense, or null if neither does) with real structure — the fixed targets above have no interval/intensity piece of their own; (2) write a one-sentence, concrete description for cardio.longSession and cardio.easyVolume (effort/pacing guidance for the run/bike volume above) and for strength.focus; (3) mention the swim target explicitly in the rationale even though it has no legacy slot of its own to sit in. Never contradict these fixed numbers anywhere in your rationale or descriptions — in particular, your longSession/easyVolume descriptions must NEVER state a distance/amount of their own at all (e.g. never write "run 9km" or mention any km/m/min figure for these two specifically); describe effort/pacing/structure only (e.g. "steady, conversational effort" or "keep the last 20% faster"), since the actual numbers shown to the user come from targets above, not from this text, and restating a different one anywhere would look like a contradiction even though it would be silently ignored.\n\n'
      : '') +
    'You are a training coach generating ONE week of concrete objectives for a personal dashboard. ' +
    'The user does two kinds of training: strength (equipment-limited, see below) and cardio. Cardio needs ' +
    'two distinct goals served every week, regardless of which specific activity fills them: improving VO2 ' +
    'max (needs genuine high-intensity interval/tempo work) and building aerobic capacity (needs a ' +
    'progressively longer session plus easy volume — standard periodization, not an ad-hoc guess). A real ' +
    'weekly cardio structure balances both: one interval/tempo session for VO2 max, one progressively-' +
    'longer session building endurance, and additional easy volume. Do not neglect either goal in favor of ' +
    'the other.\n\n' +
    (typesList
      ? 'RECOMMENDABLE ACTIVITY TYPES — choose ONE of these for EACH of the three cardio slots below ' +
        '(interval, longSession, easyVolume). A slot can reuse the same type as another slot, or use a ' +
        'different one — whichever makes the best training sense given what\'s available (e.g. running for ' +
        'the long session, cycling for easy volume, if both are listed). Genuinely distribute across what\'s ' +
        'available when that serves the training goals better; do not default everything to the first entry ' +
        'out of habit. NEVER invent a type or choose one not in this list:\n' + typesList + '\n\n'
      : 'No activity types are currently marked recommendable, so cardio cannot be planned this week. Set ' +
        'every cardio slot\'s numeric targets to 0, its activityTypeId to null and activityName to "", and ' +
        'explain why in the rationale (strength targets are unaffected).\n\n') +
    EQUIPMENT_NOTE + '\n\n' +
    buildRestrictionsPromptSection(restrictions) +
    'Use the recent history you are given (recent strength session frequency, recent activity sessions ' +
    'across whichever types have actually been logged, and recent Whoop recovery/strain trends if present) ' +
    'to calibrate — e.g. progress a distance-based long session gradually past whatever the recent longest ' +
    'session of that same type was, don\'t suddenly jump volume, and temper targets if strain has been ' +
    'consistently high or recovery consistently low.\n\n' +
    'Reply with ONLY valid JSON, no markdown code fences, no commentary before or after, in exactly this shape:\n' +
    JSON.stringify({
      strength: { targetSessions: 3, focus: 'short phrase, e.g. "full-body bench + single-dumbbell supersets"' },
      cardio: {
        interval: { activityTypeId: 'id from the list above, or null if none', activityName: 'that type\'s exact name, or ""', targetSessions: 1, targetMinutes: 30, description: 'concrete session, e.g. "6x3min hard w/ 2min easy recovery"' },
        longSession: { activityTypeId: 'id from the list above, or null', activityName: 'name, or ""', targetAmount: 8, unit: 'the chosen type\'s own unit, e.g. "km"', description: 'concrete guidance, e.g. "steady easy effort, first 20% slower"' },
        easyVolume: { activityTypeId: 'id from the list above, or null', activityName: 'name, or ""', targetAmount: 10, unit: 'the chosen type\'s own unit', description: 'concrete guidance, e.g. "2-3 easy sessions, conversational effort"' },
      },
      rationale: '1-3 sentences explaining the targets AND which activity type went where, given the recent history provided',
      assignments: [{ id: 'exact id from sessionsToPlace below, if any was given', dateKey: 'exact dateKey from feasibleDays below' }],
      unplaced: [{ id: 'exact id from sessionsToPlace that could not be placed', reason: 'short, specific reason' }],
    }, null, 2) +
    '\n\nEvery number must be concrete (sessions, distance/count amount, or minutes) — never vague advice ' +
    'like "do more cardio". If recent history is thin or empty, use sensible conservative defaults for ' +
    'someone building both VO2 max and aerobic capacity, and say so in the rationale. assignments/unplaced ' +
    'are ONLY relevant when the WEEK LAYOUT section below gives you a non-empty sessionsToPlace list — ' +
    'otherwise leave both as empty arrays.'
  );
}

function num(v, fallback) {
  const n = Number(v);
  return isNaN(n) ? fallback : n;
}

// FEATURE (reported) — code-level backstop on top of
// buildPlanSystemPrompt's REAL SESSIONS instruction: the model is
// asked not to narrate a session kind that isn't really scheduled
// this week, but prompt instructions are followed, not guaranteed —
// this strips any rationale SENTENCE that names a kind-specific
// phrase whose kind is absent from realSessionKinds, rather than
// trusting the model's compliance alone. Deliberately narrow (one
// regex per kind, matched against common ways a kind is actually
// described in prose) — a sentence that doesn't match any of these
// patterns at all is left untouched regardless of its content, same
// "never silently rewrite more than the specific reported problem"
// discipline as every other backstop in this file.
const RATIONALE_KIND_PATTERNS = {
  interval: /\binterval(s)?\b|\bVO2\s*max\b|\btempo\b/i,
  pace: /\bpace (run|session|effort)\b|\brace[- ]pace\b/i,
  long: /\blong run\b|\blong session\b/i,
  technique: /\btechnique (run|session|work)\b|\bdrills?\b/i,
  brick: /\bbrick (run|session|workout)\b/i,
};
function stripInventedKindMentions(rationale, realSessionKinds) {
  if (!rationale || !realSessionKinds) return rationale; // no real layout this request — untouched, see caller's own comment
  const present = new Set(realSessionKinds);
  // Split on sentence-ending punctuation, keeping the punctuation —
  // simple and matches this file's own truncateAtWordBoundary
  // precedent of not pulling in a real sentence tokenizer for prose
  // this short (a 1-3 sentence rationale, per the prompt's own spec).
  const sentences = rationale.match(/[^.!?]+[.!?]*/g) || [rationale];
  const kept = sentences.filter((sentence) => {
    for (const kind in RATIONALE_KIND_PATTERNS) {
      if (!present.has(kind) && RATIONALE_KIND_PATTERNS[kind].test(sentence)) return false;
    }
    return true;
  });
  const result = kept.join('').trim();
  // Never collapse to nothing — a wholly-invented rationale (every
  // sentence struck) falls back to a short, honest, code-generated
  // one rather than an empty card.
  return result || 'This week\'s sessions follow your plan/rhythm as scheduled.';
}

// BUG FIX (reported): normalizePlan's rationale used to be a bare
// `.slice(0, 600)` — a hard character cut with no regard for word
// boundaries, which is exactly what produced a rationale visibly cut
// off mid-word ("rather th"). NOT a max_tokens issue (that governs the
// model's own generation budget — already 3200, comfortably enough
// for a short rationale) — confirmed by reading this exact line.
// Raised to 900 (real margin above "1-3 sentences" now that Phase
// 3.4 also asks the model to mention a capacity trim here when one
// happened) AND switched to cut at the last whitespace before the
// limit, so a truncation (now rare) is at least a clean word break
// with a visible ellipsis, never a chopped word.
function truncateAtWordBoundary(s, maxLen) {
  if (!s || s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut).trim() + '…';
}

// A cardio slot's chosen type is blocked if either: (a) it isn't one of
// the types the model was actually offered (defense against
// noncompliance — same "verify, don't just trust the prompt"
// philosophy as the restriction check below and as strengthRestricted
// above), or (b) an active restriction's scope matches it. Restriction
// scope is free text (see api/sync-state.js's active_restrictions
// table) rather than tied to an activity-type id, so matching is done
// against BOTH the type's id and its name — this is what lets a
// restriction created before this generalization existed (scope:
// "running") still correctly block "running" no matter which of the
// three cardio slots the model tries to put it in, not just a single
// hardcoded field the way the old running-only version worked.
function isCardioTypeBlocked(type, types, restrictedScopes) {
  if (!type) return true;
  if (types.length && !types.some((t) => t.id === type.id)) return true;
  const idL = type.id.toLowerCase();
  const nameL = type.name.toLowerCase();
  return restrictedScopes.has(idL) || (!!nameL && restrictedScopes.has(nameL));
}
function resolveCardioType(activityTypeId, types) {
  if (!activityTypeId) return null;
  return types.find((t) => t.id === activityTypeId) || null;
}
function normalizeCardioInterval(raw, types, restrictedScopes) {
  const s = raw || {};
  const type = resolveCardioType(s.activityTypeId, types);
  const blocked = isCardioTypeBlocked(type, types, restrictedScopes);
  return {
    activityTypeId: blocked ? null : type.id,
    activityName: blocked ? '' : type.name,
    targetSessions: blocked ? 0 : Math.max(0, Math.round(num(s.targetSessions, 1))),
    targetMinutes: blocked ? 0 : Math.max(0, Math.round(num(s.targetMinutes, 25))),
    description: blocked ? '' : (typeof s.description === 'string' ? s.description.slice(0, 300) : ''),
  };
}
function normalizeCardioVolume(raw, types, restrictedScopes, defaultAmount) {
  const s = raw || {};
  const type = resolveCardioType(s.activityTypeId, types);
  const blocked = isCardioTypeBlocked(type, types, restrictedScopes);
  return {
    activityTypeId: blocked ? null : type.id,
    activityName: blocked ? '' : type.name,
    targetAmount: blocked ? 0 : Math.max(0, num(s.targetAmount, defaultAmount)),
    unit: blocked ? '' : type.unit,
    description: blocked ? '' : (typeof s.description === 'string' ? s.description.slice(0, 300) : ''),
  };
}

// ------------------------------------------------------------
// Phase 3.1 — per-discipline weekly targets, sourced from the user's
// OWN active long-term plan (plan.html's "plans" resource — a
// different thing from this week's po_coach_weekly_plan_v1), not
// invented by the model. The client resolves each discipline's
// activityTypeId itself (gym.html's resolveActivityTypeForDiscipline,
// Phase 2's name-matching heuristic run in reverse) and sends it
// already attached; this file only re-validates it the same way every
// other client-supplied activityTypeId here already is (isCardioTypeBlocked)
// — never trusts it blindly.
// ------------------------------------------------------------

function sanitizeDisciplineAmount(raw, numKeys) {
  if (!raw || typeof raw !== 'object') return null;
  const out = { activityTypeId: typeof raw.activityTypeId === 'string' ? raw.activityTypeId.slice(0, 60) : null };
  numKeys.forEach((k) => { out[k] = Math.max(0, num(raw[k], 0)); });
  return out;
}
// null (not {}) whenever there's nothing to act on at all — this is
// what lets handlePlan/buildPlanSystemPrompt tell "no active-plan
// disciplines were ever sent" (every old client; behavior must stay
// byte-identical) apart from "sent, but every discipline was empty"
// (treated the same way — no targets section, nothing to pass to the
// model, no `targets` key on the response).
function sanitizeActiveWeekDisciplines(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  const run = sanitizeDisciplineAmount(raw.run, ['km']);
  const bike = sanitizeDisciplineAmount(raw.bike, ['km']);
  const swim = sanitizeDisciplineAmount(raw.swim, ['sessions', 'meters']);
  if (run && run.km > 0) out.run = run;
  if (bike && bike.km > 0) out.bike = bike;
  if (swim && (swim.sessions > 0 || swim.meters > 0)) out.swim = swim;
  if (raw.strength && typeof raw.strength === 'object') {
    const sessions = Math.max(0, Math.round(num(raw.strength.sessions, 0)));
    if (sessions > 0) out.strength = { sessions };
  }
  return Object.keys(out).length ? out : null;
}

// Builds the response's `targets` key — the ACTUAL numbers, computed
// here in code from the user's own plan, never asked of the model
// (fixes the "generator invents numbers instead of following the
// user's plan" bug 3.1 was written to verify and close). A discipline
// whose resolved type is non-recommendable/restricted is zeroed, same
// isCardioTypeBlocked check the legacy cardio slots already enforce —
// re-validated here independently of whatever the client resolved,
// since recommendable/restricted status can change between gym.html
// resolving it and this request landing.
function buildTargetsFromActiveWeek(activeWeekDisciplines, types, restrictedScopes, strengthRestricted) {
  const out = {};
  ['run', 'bike'].forEach((disc) => {
    const d = activeWeekDisciplines[disc];
    if (!d) return;
    const type = resolveCardioType(d.activityTypeId, types);
    const blocked = isCardioTypeBlocked(type, types, restrictedScopes);
    out[disc] = {
      activityTypeId: blocked ? null : type.id,
      activityName: blocked ? '' : type.name,
      km: blocked ? 0 : Math.round(d.km * 10) / 10,
    };
  });
  if (activeWeekDisciplines.swim) {
    const d = activeWeekDisciplines.swim;
    const type = resolveCardioType(d.activityTypeId, types);
    const blocked = isCardioTypeBlocked(type, types, restrictedScopes);
    out.swim = {
      activityTypeId: blocked ? null : type.id,
      activityName: blocked ? '' : type.name,
      sessions: blocked ? 0 : Math.round(d.sessions),
      meters: blocked ? 0 : Math.round(d.meters),
    };
  }
  if (activeWeekDisciplines.strength) {
    out.strength = { sessions: strengthRestricted ? 0 : activeWeekDisciplines.strength.sessions };
  }
  return out;
}

// The legacy schema has exactly 2 distance-volume slots (longSession/
// easyVolume) — not enough to hold 3 independent disciplines (run/
// bike/swim), and swim's own {sessions,meters} shape doesn't map to a
// km-based slot at all. Rather than let the model re-invent these two
// slots' amounts (reopening the exact bug this sub-step fixes), they
// are DERIVED deterministically from `targets` — run then bike fill
// the two slots (in that priority; swim is simply not representable
// in this legacy shape and is left out of it, same as "nothing
// recommendable" already does today), keeping only the model's own
// free-text `description` for whichever slot it still lines up with.
// This is what keeps main.html's "Plan my day" Tomorrow teaser and the
// score engine (both read plan.cardio.longSession/easyVolume directly
// — verified before writing this, neither is touched) seeing *some*
// representative distance progress instead of a sudden blank, exactly
// as before this phase existed; `targets` is the new, actually-
// accurate source for anything discipline-aware.
// BUG FIX (reported) — code-level backstop for the prompt instruction
// above: even though the model is told never to restate a km/m/min
// figure in these two descriptions, nothing previously re-checked
// that it actually complied (same "never trust the prompt alone"
// discipline as every other validated field in this file). If a
// description still contains a number immediately followed by the
// slot's own unit that doesn't match targetAmount, it's a real
// contradiction (the display's actual number comes from targetAmount,
// not this text) — stripped rather than shown, since there's no safe
// way to tell the user's intended meaning from a lone wrong number.
function descriptionContradictsTarget(description, targetAmount, unit) {
  if (!description || targetAmount == null) return false;
  const match = description.match(new RegExp('(\\d+(?:\\.\\d+)?)\\s*' + unit, 'i'));
  if (!match) return false;
  return Math.abs(Number(match[1]) - Number(targetAmount)) > 0.05;
}
function deriveLegacyCardioFromTargets(targets, modelCardio) {
  const distanceDisciplines = ['run', 'bike'].filter((d) => targets[d] && targets[d].km > 0 && targets[d].activityTypeId);
  function volumeSlotFor(disc, modelSlot) {
    if (!disc) return { activityTypeId: null, activityName: '', targetAmount: 0, unit: '', description: '' };
    const t = targets[disc];
    let description = (modelSlot && typeof modelSlot.description === 'string') ? modelSlot.description.slice(0, 300) : '';
    if (descriptionContradictsTarget(description, t.km, 'km')) description = '';
    return {
      activityTypeId: t.activityTypeId,
      activityName: t.activityName,
      targetAmount: t.km,
      unit: 'km',
      description,
    };
  }
  return {
    longSession: volumeSlotFor(distanceDisciplines[0] || null, modelCardio && modelCardio.longSession),
    easyVolume: volumeSlotFor(distanceDisciplines[1] || null, modelCardio && modelCardio.easyVolume),
  };
}

// Human-readable summary injected into the prompt so the model can
// write a coherent rationale/descriptions around numbers it is told
// NOT to change — see buildPlanSystemPrompt's targets-mode section.
function describeActiveWeekDisciplinesForPrompt(activeWeekDisciplines, types) {
  const parts = [];
  ['run', 'bike'].forEach((disc) => {
    const d = activeWeekDisciplines[disc];
    if (!d) return;
    const type = resolveCardioType(d.activityTypeId, types);
    parts.push(disc + ': ' + d.km + 'km' + (type ? ' (' + type.name + ')' : ' — no matching recommendable activity type, will be zeroed'));
  });
  const swim = activeWeekDisciplines.swim;
  if (swim) {
    const type = resolveCardioType(swim.activityTypeId, types);
    parts.push('swim: ' + swim.sessions + ' sessions' + (swim.meters ? ' × ~' + swim.meters + 'm (~' + (swim.sessions * swim.meters) + 'm total)' : '') + (type ? ' (' + type.name + ')' : ' — no matching recommendable activity type, will be zeroed'));
  }
  if (activeWeekDisciplines.strength) parts.push('strength: ' + activeWeekDisciplines.strength.sessions + ' sessions');
  return parts.join('; ');
}

// ------------------------------------------------------------
// Phase 3.4 (amendment B) — capacity-aware targets + week layout.
// Capacity itself (perDay/perDiscipline, including the pace figures
// used to compute "needed" minutes) is computed CLIENT-SIDE
// (gym.html's buildWeekCapacity — that's where the real Google
// Calendar access and logged-activity pace history actually live);
// this server re-validates the shape defensively but does the
// capacity-vs-target ARITHMETIC itself from the numbers given, never
// asking the model to do it (same "all arithmetic in code" rule as
// everywhere else in this file).
// ------------------------------------------------------------

const WEEKDAY_SET = new Set(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']);
const CAPACITY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function sanitizeCapacityPerDiscipline(raw) {
  const out = {};
  ['run', 'bike'].forEach((disc) => {
    const d = raw && raw[disc];
    if (!d || typeof d !== 'object') return;
    out[disc] = {
      neededMin: Math.max(0, num(d.neededMin, 0)),
      availableMin: Math.max(0, num(d.availableMin, 0)),
      paceMinPerKm: num(d.paceMinPerKm, 6),
    };
  });
  if (raw && raw.swim && typeof raw.swim === 'object') {
    out.swim = {
      neededMin: Math.max(0, num(raw.swim.neededMin, 0)),
      availableMin: Math.max(0, num(raw.swim.availableMin, 0)),
      paceMinPer100m: num(raw.swim.paceMinPer100m, 2.5),
      swimAllowedDaysCount: Math.max(0, Math.round(num(raw.swim.swimAllowedDaysCount, 0))),
    };
  }
  if (raw && raw.strength && typeof raw.strength === 'object') {
    out.strength = {
      neededMin: Math.max(0, num(raw.strength.neededMin, 0)),
      availableMin: Math.max(0, num(raw.strength.availableMin, 0)),
      // BUG FIX (reported) — strength sessions can't stack on one day,
      // so total available MINUTES alone can look generous across just
      // 1-2 remaining days even when 3 targeted sessions physically
      // can't fit. Same day-count pattern swimAllowedDaysCount already
      // established for swim's own floor logic, used here as a ceiling.
      strengthAllowedDaysCount: Math.max(0, Math.round(num(raw.strength.strengthAllowedDaysCount, 0))),
    };
  }
  return out;
}
function sanitizeCapacityPerDay(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 7).map((d) => {
    const weekday = (d && typeof d.weekday === 'string' && WEEKDAY_SET.has(d.weekday)) ? d.weekday : null;
    const dateKey = (d && typeof d.dateKey === 'string' && CAPACITY_DATE_RE.test(d.dateKey)) ? d.dateKey : null;
    const rawDisc = (d && d.allowedDisciplines && typeof d.allowedDisciplines === 'object') ? d.allowedDisciplines : {};
    return {
      weekday, dateKey,
      availableMin: Math.max(0, Math.round(num(d && d.availableMin, 0))),
      allowedDisciplines: {
        swim: rawDisc.swim !== false, bike: rawDisc.bike !== false, run: rawDisc.run !== false, strength: rawDisc.strength !== false,
      },
    };
  }).filter((d) => d.weekday && d.dateKey);
}
// null (not {}) when nothing to act on — same "collapse to the
// pre-existing behavior" convention sanitizeActiveWeekDisciplines
// already established.
function sanitizeCapacity(raw) {
  if (!raw || typeof raw !== 'object' || !raw.configured) return { configured: false };
  return {
    configured: true,
    perDiscipline: sanitizeCapacityPerDiscipline(raw.perDiscipline),
    perDay: sanitizeCapacityPerDay(raw.perDay),
    preferredLongDay: (typeof raw.preferredLongDay === 'string' && WEEKDAY_SET.has(raw.preferredLongDay)) ? raw.preferredLongDay : null,
  };
}

// The ONE hard guarantee from the task spec — "never present a target
// the week cannot hold" — is enforced HERE, deterministically, not
// left to the model's compliance. Trim order: running first, then
// bike (per spec); swim is never trimmed below 2 sessions while swim
// is allowed on at least 2 days this week (also per spec) — if swim
// genuinely can't fit even at 2 sessions, that's buildUnplaceableSeed/
// the layout step's problem (reported as unplaced), not this
// function's: it only ever reduces swim's SESSION COUNT for capacity
// purposes down to the floor, never all the way to 0 on its own.
// Strength is included for completeness (spec: "apply the same logic
// if truly needed") but, at a flat 45min/session, rarely binds.
function applyCapacityBackstop(targets, capacity) {
  if (!capacity || !capacity.configured) return { targets, trimNote: null };
  const out = JSON.parse(JSON.stringify(targets));
  const notes = [];
  ['run', 'bike'].forEach((disc) => {
    const cap = capacity.perDiscipline[disc];
    const t = out[disc];
    if (!cap || !t || !t.km || !cap.paceMinPerKm) return;
    const estMin = t.km * cap.paceMinPerKm;
    if (cap.availableMin != null && estMin > cap.availableMin) {
      const maxKm = Math.max(0, cap.availableMin / cap.paceMinPerKm);
      const newKm = Math.round(maxKm * 10) / 10;
      if (newKm < t.km) {
        notes.push(disc + ' ' + t.km + 'km -> ' + newKm + 'km');
        t.km = newKm;
      }
    }
  });
  const swimCap = capacity.perDiscipline.swim;
  if (swimCap && out.swim && out.swim.sessions && swimCap.paceMinPer100m) {
    // BUG FIX (reported) — swim.meters is now standardized as PER
    // SESSION (matches the plan text, e.g. "2x~1400m" = 1400m each),
    // not a weekly total divided across sessions. This used to divide
    // by sessions AGAIN here, understating the real per-session volume
    // by a factor of sessions. Trimming the session COUNT never changes
    // the per-session distance itself, so meters is left untouched
    // below (previously overwritten as sessions * metersPerSession,
    // which silently shrank the per-session distance too).
    const metersPerSession = Number(out.swim.meters) || 0;
    const floor = swimCap.swimAllowedDaysCount >= 2 ? 2 : 0;
    const originalSessions = out.swim.sessions;
    let estMin = out.swim.sessions * (metersPerSession / 100) * swimCap.paceMinPer100m;
    while (swimCap.availableMin != null && estMin > swimCap.availableMin && out.swim.sessions > floor) {
      out.swim.sessions -= 1;
      estMin = out.swim.sessions * (metersPerSession / 100) * swimCap.paceMinPer100m;
    }
    if (out.swim.sessions < originalSessions) {
      notes.push('swim ' + originalSessions + ' -> ' + out.swim.sessions + ' sessions');
    }
  }
  const strengthCap = capacity.perDiscipline.strength;
  if (strengthCap && out.strength && out.strength.sessions) {
    const perSessionMin = 45;
    const originalSessions = out.strength.sessions;
    // BUG FIX (reported) — a strength session can't stack with another
    // one on the same day, so total available MINUTES alone could show
    // plenty of free time spread across just 1-2 remaining days and
    // wrongly report "no trim needed" for 3 targeted sessions. Capped
    // at the number of remaining days strength is actually allowed on
    // FIRST, regardless of how much total time those days hold, then
    // the existing minutes-based trim still applies on top of that.
    if (strengthCap.strengthAllowedDaysCount != null) {
      out.strength.sessions = Math.min(out.strength.sessions, strengthCap.strengthAllowedDaysCount);
    }
    while (strengthCap.availableMin != null && out.strength.sessions * perSessionMin > strengthCap.availableMin && out.strength.sessions > 0) {
      out.strength.sessions -= 1;
    }
    if (out.strength.sessions < originalSessions) notes.push('strength: ' + out.strength.sessions + ' of ' + originalSessions + ' can still fit this week');
  }
  return {
    targets: out,
    trimNote: notes.length ? ('Trimmed to fit this week\'s available time: ' + notes.join(', ') + '.') : null,
  };
}

// Informational only (the trim decision above is already final by
// the time this prompt section is built) — lets the model's own
// rationale mention the trim coherently instead of contradicting it.
function buildCapacityPromptSection(capacity, trimNote) {
  if (!capacity || !capacity.configured) return '';
  return (
    'CAPACITY (Phase 3.4) — this week\'s realistic free time has ALREADY been checked against the targets ' +
    'above in code, and any trim needed to make them fit has ALREADY been applied (see targets themselves — ' +
    'they are already the final, capacity-aware numbers). ' +
    (trimNote ? trimNote + ' ' : 'Nothing needed trimming this week — the targets above already fit. ') +
    'Mention this plainly in your rationale if a trim happened; do not re-propose different numbers or imply ' +
    'a different trim than the one already stated.\n\n'
  );
}

// ---------------------------------------------------------------
// Phase 3.4 — week layout. Each discipline's (already capacity-
// final) target is split into discrete, already-SIZED sessions in
// CODE (session count/sizing is a documented heuristic, not asked of
// the model); the model's only job is to ASSIGN each session's id to
// one feasible day, and code re-validates every assignment afterward
// — budget, allowed discipline, and no two "hard" sessions on
// adjacent calendar dates — dropping violations into `unplaced`
// rather than trusting placement blindly.
// ---------------------------------------------------------------

// ------------------------------------------------------------
// Phase 3.5 — fixed weekly rhythm. The user defines, per weekday,
// which discipline + kind of session happens (see api/sync-state.js's
// own "weekly-rhythm" doc comment for the stored shape). When the
// rhythm covers a discipline this week, EVERY session for that
// discipline is built AND PLACED from the rhythm (sized in code, day
// fixed to whatever the rhythm says) instead of the generic long/easy
// split below that then needs the model to pick a day. A discipline
// the rhythm says nothing about this week is untouched by any of
// this — it still goes through the exact pre-3.5 code path — which is
// what makes "no rhythm configured => output identical to before" and
// "a rhythm covering only some disciplines" both fall out of the same
// function rather than needing a separate branch.
// ------------------------------------------------------------
const RHYTHM_WEEKDAY_ORDER = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
// Same enums as api/sync-state.js's own RHYTHM_DISCIPLINES/_KINDS —
// duplicated per this project's established per-file small-
// duplication convention (the two files never share a module).
const RHYTHM_DISCIPLINE_VALUES = ['swim', 'run', 'strength', 'bike', 'rest'];
// Two SEPARATE kind vocabularies, same split as api/sync-state.js's
// own CARDIO_KINDS/STRENGTH_KINDS (duplicated per this project's per-
// file convention — the two files never share a module).
const RHYTHM_CARDIO_KIND_VALUES = ['easy', 'interval', 'long', 'technique', 'pace', 'brick'];
// 'auto' = let the existing Push/Pull/Legs rotation decide (the
// default, and what a legacy entry's old placeholder kind 'strength'
// now reads as). push/pull/legs/explosive are matched by NAME
// (case-insensitively) against gym.html's own state.days — never a
// fixed id, since a day added via "+ Add day" gets a timestamp-based
// one.
const RHYTHM_STRENGTH_KIND_VALUES = ['auto', 'push', 'pull', 'legs', 'explosive'];
function rhythmKindValuesFor(discipline) {
  return discipline === 'strength' ? RHYTHM_STRENGTH_KIND_VALUES : RHYTHM_CARDIO_KIND_VALUES;
}
// Two renames, both backward-compatible (same mapping as api/sync-
// state.js's own normalizeRhythmKindForCompat): a cardio 'endurance'
// -> 'long', and a strength entry's old placeholder kind 'strength'
// -> 'auto'. A stale client or an already-stored entry using either
// old name must keep working, never get rejected. Every reader of an
// entry's kind in this file goes through this first.
function normalizeRhythmKindForCompat(discipline, kind) {
  if (kind === 'endurance') return 'long';
  if (discipline === 'strength' && kind === 'strength') return 'auto';
  return kind;
}
function sanitizeRhythmEntries(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 3).map((e) => {
    if (!e || typeof e !== 'object' || !RHYTHM_DISCIPLINE_VALUES.includes(e.discipline)) return null;
    const out = { discipline: e.discipline };
    if (e.kind !== undefined && e.kind !== null) {
      const kind = normalizeRhythmKindForCompat(e.discipline, e.kind);
      if (rhythmKindValuesFor(e.discipline).includes(kind)) out.kind = kind;
    }
    return out;
  }).filter(Boolean);
}
// Deliberately simple, documented heuristic (not a real training-
// science model) for splitting a discipline's single weekly km target
// across HOWEVER MANY rhythm sessions exist for it this week: a "long"
// day takes the biggest share, "technique" the smallest, "pace" (a
// continuous fast effort at goal/race pace) a moderate share —
// comparable to "interval", clearly less than "long" — everything
// else close to even. Only run/bike use this — swim's target is
// already per-session (see applyCapacityBackstop's own comment) and
// strength has no distance to split at all. BUG FIX (reported
// feature) — this is now only the FALLBACK, used when no rhythm entry
// for this discipline carries an explicit per-session `km` at all
// (backward compatible: identical output to before this feature).
// See splitRhythmSessionsByShares below for the km-aware split.
const RHYTHM_KIND_WEIGHT = { long: 1.5, pace: 0.85, brick: 1.0, easy: 1.0, interval: 0.8, technique: 0.6 };
// Mirrors gym.html's own REBALANCE_MIN_SESSION_KM exactly (same "a
// session below this is not a real session on its own" floor) — the
// km-aware split below uses it to decide when a week's own target is
// too small to hold every rhythm session at a sane size.
const RHYTHM_SPLIT_MIN_SESSION_KM = 3;
// CHANGE (reported) — replaces the earlier proportional-shares split
// (every session grew/shrunk by the same percentage) with a fixed/
// growth-order model: 'interval'/'pace'/'technique'/'brick' entries
// are FIXED at their own reference-week km and never grow; only
// 'long' and 'easy' grow as the weekly target rises above the
// reference week, in that order — long absorbs growth first, up to
// `cap`, then any surplus goes to easy, which is never let within
// 1km of long. Below the reference week (deload/taper), ALL sessions
// (fixed ones too) scale down together proportionally — see the
// second half of this function.
const RHYTHM_LONG_RUN_CAP_DEFAULT_KM = 10;
// Per-week long-run cap: `rhythm.longRunCapKm` (or this default) with
// any `rhythm.longRunCapOverrides` date range covering `weekMondayKey`
// taking precedence (first match wins) — see api/sync-state.js's own
// header comment on the shape. weekMondayKey is this week's own
// canonical Monday (weekDates.monday, client-computed via DayLib) —
// matched by DATE, never a week number, so a restarted plan's
// checkpoints renumbering from 1 again never misresolves this.
function resolveLongRunCapForWeek(rhythm, weekMondayKey) {
  const defaultCap = (rhythm && Number(rhythm.longRunCapKm) > 0) ? Number(rhythm.longRunCapKm) : RHYTHM_LONG_RUN_CAP_DEFAULT_KM;
  if (!weekMondayKey || !rhythm || !Array.isArray(rhythm.longRunCapOverrides)) return defaultCap;
  const hit = rhythm.longRunCapOverrides.find((o) => o && o.from && o.to && weekMondayKey >= o.from && weekMondayKey <= o.to);
  return (hit && Number(hit.km) > 0) ? Number(hit.km) : defaultCap;
}
function round0_5(v) { return Math.round(v * 2) / 2; }
// entries: [{kind, km, dateKey}] in weekday order. firstWeekKm: the
// reference week's own total target for this discipline (see
// buildRhythmSessionsForDiscipline's own comment on firstWeekTargets).
// weekKm: THIS week's own target (whatever week is actually being
// generated). cap: this week's resolved long-run cap (see
// resolveLongRunCapForWeek). minSessionKm: the deload/taper merge
// floor (same meaning as before this change).
//
// Baselines (the reference week's own sizes) come straight from each
// entry's own `km` except 'long', which is expected to be left
// without one and absorbs whatever's left of firstWeekKm after every
// other entry's baseline — "Tue interval 3, Wed easy 5, Fri pace 5,
// Sun long (absorbs the rest) = 20" is the documented shape this is
// built for.
//
// weekKm >= firstWeekKm (GROWTH): fixed-kind entries stay at their
// baseline, unchanged. growthTotal = weekKm - firstWeekKm goes first
// to 'long' (up to `cap`), then any remainder to 'easy' (capped at
// long's own final size minus 1km, so easy never catches up to long).
// Whatever still doesn't fit is an explicit, reported `shortfall` —
// sizes are never pushed past these rules to force an exact match.
//
// weekKm < firstWeekKm (DELOAD/TAPER): every entry (fixed ones too)
// scales down together by weekKm/firstWeekKm, rounded to the nearest
// 0.5km with drift absorbed by the largest session — same "too small
// for every session" merge/drop mechanics as this function's
// predecessor (splitRhythmSessionsByShares): the smallest-BASELINE-
// share session folds into the rest, repeating until the week clears
// session-count × minSessionKm or only one session remains.
function splitRhythmSessionsFixedGrowth(entries, firstWeekKm, weekKm, cap, minSessionKm) {
  if (!entries || !entries.length || !(firstWeekKm > 0) || !(weekKm > 0)) return null;
  const longIdx = entries.findIndex((e) => e.kind === 'long');
  const easyIdx = entries.findIndex((e) => e.kind === 'easy');

  const baselines = entries.map((e) => Number(e.km) || 0);
  if (longIdx !== -1 && !(Number(entries[longIdx].km) > 0)) {
    const othersSum = baselines.reduce((s, v, i) => s + (i === longIdx ? 0 : v), 0);
    baselines[longIdx] = Math.max(0, round0_5(firstWeekKm - othersSum));
  }

  if (weekKm >= firstWeekKm) {
    let growthRemaining = weekKm - firstWeekKm;
    const sizes = baselines.slice();
    if (longIdx !== -1) {
      const room = Math.max(0, cap - baselines[longIdx]);
      const grow = Math.min(growthRemaining, room);
      sizes[longIdx] = round0_5(baselines[longIdx] + grow);
      growthRemaining -= grow;
    }
    if (easyIdx !== -1 && growthRemaining > 0) {
      const longFinal = longIdx !== -1 ? sizes[longIdx] : Infinity;
      const easyMax = Math.max(baselines[easyIdx], longFinal - 1);
      const room = Math.max(0, easyMax - baselines[easyIdx]);
      const grow = Math.min(growthRemaining, room);
      sizes[easyIdx] = round0_5(baselines[easyIdx] + grow);
      growthRemaining -= grow;
    }
    const placed = sizes.reduce((s, v) => s + v, 0);
    const shortfall = Math.max(0, Math.round((weekKm - placed) * 10) / 10);
    return {
      sessions: entries.map((e, i) => ({ kind: e.kind, dateKey: e.dateKey, weekday: e.weekday, km: sizes[i] })),
      dropped: [],
      shortfall,
      cap,
    };
  }

  const floor = minSessionKm > 0 ? minSessionKm : 3;
  let items = entries.map((e, i) => ({ kind: e.kind, dateKey: e.dateKey, weekday: e.weekday, share: firstWeekKm ? baselines[i] / firstWeekKm : 0 }));
  const dropped = [];
  while (items.length > 1 && weekKm <= items.length * floor) {
    let mi = 0;
    items.forEach((it, i) => { if (it.share < items[mi].share) mi = i; });
    dropped.push(items[mi].kind);
    const droppedShare = items[mi].share;
    items.splice(mi, 1);
    const remSum = items.reduce((s, it) => s + it.share, 0) || 1;
    items = items.map((it) => Object.assign({}, it, { share: it.share + droppedShare * (it.share / remSum) }));
  }
  const raw = items.map((it) => it.share * weekKm);
  const rounded = raw.map((v) => round0_5(v));
  const sum = round0_5(rounded.reduce((s, v) => s + v, 0));
  const drift = round0_5(weekKm - sum);
  if (drift !== 0 && rounded.length) {
    let bi = 0;
    rounded.forEach((v, i) => { if (v > rounded[bi]) bi = i; });
    rounded[bi] = round0_5(rounded[bi] + drift);
  }
  return {
    sessions: items.map((it, i) => ({ kind: it.kind, dateKey: it.dateKey, weekday: it.weekday, km: rounded[i] })),
    dropped,
    shortfall: 0,
    cap,
  };
}
// 'pace'/'interval'/'long' are hard cardio efforts; 'legs'/'explosive'
// are the strength-side equivalent (real leg load) — all five count
// as hard for the back-to-back-hard-days flag and the low-recovery
// downgrade rule. 'push'/'pull'/'auto' do not (upper-body work, or
// whatever the rotation already decided, isn't assumed demanding).
const RHYTHM_HARD_KINDS = new Set(['interval', 'long', 'pace', 'legs', 'explosive']);
function rhythmHasAnyEntries(rhythm) {
  return !!(rhythm && typeof rhythm === 'object' && RHYTHM_WEEKDAY_ORDER.some((wd) => Array.isArray(rhythm[wd]) && rhythm[wd].length));
}
// This week's rhythm entries for ONE discipline, in weekday order,
// each paired with its real dateKey (weekDates is client-computed via
// DayLib — this server has no date library of its own, same "server
// stays dumb about dates" discipline as api/sync-state.js). A weekday
// missing from weekDates is skipped defensively rather than guessed.
// rhythm entries arrive straight from the client's own weeklyRhythm
// object (mode=plan has no per-entry sanitizer of its own the way
// sanitizeRhythmEntries is for mode=today's rhythmForDay), so the
// compat mapping is applied here too, right at the one place every
// discipline's entries are actually read.
function rhythmEntriesForDiscipline(rhythm, weekDates, discipline) {
  const out = [];
  RHYTHM_WEEKDAY_ORDER.forEach((wd) => {
    const dateKey = weekDates && weekDates[wd];
    if (!dateKey) return;
    (rhythm[wd] || []).forEach((entry) => {
      if (entry.discipline !== discipline) return;
      out.push({ dateKey, weekday: wd, entry: entry.kind ? Object.assign({}, entry, { kind: normalizeRhythmKindForCompat(entry.discipline, entry.kind) }) : entry });
    });
  });
  return out;
}
// Returns the FULL list of sessions for `discipline` this week, sized
// and pre-placed (each carries its own dateKey already) — or null if
// the rhythm has nothing for this discipline this week, telling the
// caller to fall back to the pre-3.5 behavior for it. An empty array
// (not null) means the rhythm DOES cover it but there's no real
// target to size sessions from (never invents one).
function buildRhythmSessionsForDiscipline(discipline, targets, capacity, rhythm, weekDates, mismatchNotes, firstWeekTargets) {
  const entries = rhythmEntriesForDiscipline(rhythm, weekDates, discipline);
  if (!entries.length) return null;
  const t = targets[discipline];
  const perDiscipline = (capacity && capacity.configured) ? capacity.perDiscipline : {};
  if (discipline === 'run' || discipline === 'bike') {
    if (!t || !t.km || !t.activityTypeId) return [];
    const pace = (perDiscipline[discipline] && perDiscipline[discipline].paceMinPerKm) || 6;
    // FEATURE (reported) — the fixed/growth km-aware split only when
    // at least one entry actually has a real km set AND a real
    // firstWeekKm is available as the reference week's baseline;
    // otherwise the exact original RHYTHM_KIND_WEIGHT heuristic below,
    // byte-for-byte.
    const firstWeekKm = firstWeekTargets && firstWeekTargets[discipline] && Number(firstWeekTargets[discipline].km);
    const hasExplicitKm = entries.some((e) => e.entry.km != null && Number(e.entry.km) > 0);
    if (hasExplicitKm && firstWeekKm > 0) {
      const weekMondayKey = weekDates && weekDates.monday;
      const cap = resolveLongRunCapForWeek(rhythm, weekMondayKey);
      const split = splitRhythmSessionsFixedGrowth(
        entries.map((e) => ({ kind: e.entry.kind || 'easy', km: e.entry.km, dateKey: e.dateKey, weekday: e.weekday })),
        firstWeekKm, t.km, cap, RHYTHM_SPLIT_MIN_SESSION_KM
      );
      if (split) {
        if (split.dropped.length) {
          mismatchNotes.push(
            (discipline === 'run' ? 'Run' : 'Bike') + ': this week\'s target (' + t.km + 'km) is too small for every rhythm session — ' +
            split.dropped.join(', ') + (split.dropped.length === 1 ? ' was' : ' were') + ' merged into the remaining session(s).'
          );
        }
        if (split.shortfall > 0) {
          mismatchNotes.push(
            (discipline === 'run' ? 'Run' : 'Bike') + ': ' + split.shortfall + 'km short of this week\'s ' + t.km + 'km target — the long run is capped at ' + split.cap + 'km.'
          );
        }
        return split.sessions.map((s, i) => ({
          id: discipline + '-rhythm-' + i, discipline, kind: s.kind, activityTypeId: t.activityTypeId, activityName: t.activityName,
          targetAmount: s.km, unit: 'km', estMinutes: Math.round(s.km * pace), hard: RHYTHM_HARD_KINDS.has(s.kind), dateKey: s.dateKey, weekday: s.weekday,
        }));
      }
    }
    const weights = entries.map((e) => RHYTHM_KIND_WEIGHT[e.entry.kind] || 1);
    const weightSum = weights.reduce((s, w) => s + w, 0);
    return entries.map((e, i) => {
      const km = Math.max(0, Math.round((t.km * (weights[i] / weightSum)) * 10) / 10);
      return {
        id: discipline + '-rhythm-' + i, discipline, kind: e.entry.kind || 'easy', activityTypeId: t.activityTypeId, activityName: t.activityName,
        targetAmount: km, unit: 'km', estMinutes: Math.round(km * pace), hard: RHYTHM_HARD_KINDS.has(e.entry.kind), dateKey: e.dateKey, weekday: e.weekday,
      };
    });
  }
  if (discipline === 'swim') {
    if (!t || !t.sessions || !t.activityTypeId) return [];
    if (entries.length !== t.sessions) {
      mismatchNotes.push('Rhythm has ' + entries.length + ' swim session' + (entries.length === 1 ? '' : 's') + ' this week, but the plan targets ' + t.sessions + '.');
    }
    const pace = (perDiscipline.swim && perDiscipline.swim.paceMinPer100m) || 2.5;
    const metersPerSession = Number(t.meters) || 0; // already per-session (see applyCapacityBackstop's own comment)
    const est = Math.round((metersPerSession / 100) * pace);
    return entries.map((e, i) => ({
      id: 'swim-rhythm-' + i, discipline: 'swim', kind: e.entry.kind || 'session', activityTypeId: t.activityTypeId, activityName: t.activityName,
      targetAmount: metersPerSession, unit: 'm', estMinutes: est, hard: RHYTHM_HARD_KINDS.has(e.entry.kind), dateKey: e.dateKey, weekday: e.weekday,
    }));
  }
  if (discipline === 'strength') {
    if (!t || !t.sessions) return [];
    if (entries.length !== t.sessions) {
      mismatchNotes.push('Rhythm has ' + entries.length + ' strength session' + (entries.length === 1 ? '' : 's') + ' this week, but the plan targets ' + t.sessions + '.');
    }
    // BUG FIX (reported): kind used to be hardcoded to the literal
    // placeholder string 'strength' regardless of what the entry
    // actually said, and hard was hardcoded false — a typed legs/
    // explosive entry never showed its real day type and was never
    // flagged hard. kind now carries the real day type ('auto' if
    // unset), and hard follows RHYTHM_HARD_KINDS like every other
    // discipline.
    return entries.map((e, i) => ({
      id: 'strength-rhythm-' + i, discipline: 'strength', kind: e.entry.kind || 'auto', activityTypeId: null, activityName: 'Strength',
      targetAmount: null, unit: '', estMinutes: 45, hard: RHYTHM_HARD_KINDS.has(e.entry.kind), dateKey: e.dateKey, weekday: e.weekday,
    }));
  }
  return null;
}
// rhythm/weekDates/mismatchNotes are all optional — omitting them (as
// every caller did before Phase 3.5) reproduces the exact pre-3.5
// behavior byte-for-byte.
function buildSessionsToPlace(targets, capacity, rhythm, weekDates, mismatchNotes, firstWeekTargets) {
  const sessions = [];
  const perDiscipline = (capacity && capacity.configured) ? capacity.perDiscipline : {};
  const notes = mismatchNotes || [];
  ['run', 'bike'].forEach((disc) => {
    const rhythmSessions = rhythm ? buildRhythmSessionsForDiscipline(disc, targets, capacity, rhythm, weekDates, notes, firstWeekTargets) : null;
    if (rhythmSessions) { sessions.push(...rhythmSessions); return; }
    const t = targets[disc];
    if (!t || !t.km || !t.activityTypeId) return;
    const pace = (perDiscipline[disc] && perDiscipline[disc].paceMinPerKm) || 6;
    const longKm = Math.round(t.km * 0.6 * 10) / 10;
    const easyKm = Math.round((t.km - longKm) * 10) / 10;
    sessions.push({ id: disc + '-long', discipline: disc, kind: 'long', activityTypeId: t.activityTypeId, activityName: t.activityName, targetAmount: longKm, unit: 'km', estMinutes: Math.round(longKm * pace), hard: true });
    if (easyKm >= 1) sessions.push({ id: disc + '-easy', discipline: disc, kind: 'easy', activityTypeId: t.activityTypeId, activityName: t.activityName, targetAmount: easyKm, unit: 'km', estMinutes: Math.round(easyKm * pace), hard: false });
  });
  const swimRhythmSessions = rhythm ? buildRhythmSessionsForDiscipline('swim', targets, capacity, rhythm, weekDates, notes) : null;
  if (swimRhythmSessions) {
    sessions.push(...swimRhythmSessions);
  } else if (targets.swim && targets.swim.sessions > 0 && targets.swim.activityTypeId) {
    const pace = (perDiscipline.swim && perDiscipline.swim.paceMinPer100m) || 2.5;
    const metersPerSession = Number(targets.swim.meters) || 0; // already per-session (see applyCapacityBackstop's own comment)
    const est = Math.round((metersPerSession / 100) * pace);
    for (let i = 0; i < targets.swim.sessions; i++) {
      sessions.push({ id: 'swim-' + i, discipline: 'swim', kind: 'session', activityTypeId: targets.swim.activityTypeId, activityName: targets.swim.activityName, targetAmount: metersPerSession, unit: 'm', estMinutes: est, hard: false });
    }
  }
  const strengthRhythmSessions = rhythm ? buildRhythmSessionsForDiscipline('strength', targets, capacity, rhythm, weekDates, notes) : null;
  if (strengthRhythmSessions) {
    sessions.push(...strengthRhythmSessions);
  } else if (targets.strength && targets.strength.sessions > 0) {
    for (let i = 0; i < targets.strength.sessions; i++) {
      sessions.push({ id: 'strength-' + i, discipline: 'strength', kind: 'strength', activityTypeId: null, activityName: 'Strength', targetAmount: null, unit: '', estMinutes: 45, hard: false });
    }
  }
  return sessions;
}
// A discipline with a real target but NO day this week allows it at
// all is categorically unplaceable — not something a smarter
// placement could ever fix. Checked BEFORE ever asking the model, so
// "a no-swim-days week reports swim as unplaceable" is guaranteed by
// code, not dependent on model behavior.
// BUG FIX (reported) — sessionsToPlace (optional) lets this exempt a
// discipline that's already rhythm-fixed to a real day (carries its
// own dateKey — see buildRhythmSessionsForDiscipline) from "no day
// allows X" even when the client's own capacity.perDay says every
// OTHER day disallows it: the rhythm's own placement is what counts,
// per the same rule buildFinalLayout below applies per-session. Without
// sessionsToPlace (the normalizePlan call site, which seeds this
// BEFORE computing sessionsToPlace itself) this exemption simply never
// applies — identical to this function's own pre-existing behavior.
function buildUnplaceableSeed(targets, capacity, sessionsToPlace) {
  const seed = [];
  if (!capacity || !capacity.configured || !capacity.perDay.length) return seed;
  ['run', 'bike', 'swim', 'strength'].forEach((disc) => {
    const t = targets[disc];
    const hasTarget = (disc === 'swim' || disc === 'strength') ? (t && t.sessions > 0) : (t && t.km > 0);
    if (!hasTarget) return;
    const anyDayAllows = capacity.perDay.some((d) => d.allowedDisciplines[disc] !== false);
    const rhythmFixedThisDiscipline = Array.isArray(sessionsToPlace) && sessionsToPlace.some((s) => s.discipline === disc && s.dateKey);
    if (!anyDayAllows && !rhythmFixedThisDiscipline) seed.push({ id: disc, reason: 'No day this week allows ' + disc + '.' });
  });
  return seed;
}
function buildLayoutPromptSection(sessionsToPlace, capacity) {
  if (!sessionsToPlace.length || !capacity || !capacity.configured || !capacity.perDay.length) return '';
  return (
    'WEEK LAYOUT (Phase 3.4) — sessionsToPlace lists every session that needs a day this week, already ' +
    'sized (estMinutes) in code; feasibleDays (in capacity.perDay below) lists each remaining day\'s real ' +
    'availableMin and allowedDisciplines. Assign EVERY sessionsToPlace entry to exactly one feasibleDays ' +
    'dateKey such that: the day\'s allowedDisciplines allows that session\'s discipline; the sum of ' +
    'estMinutes for everything you assign to that day does not exceed its availableMin; and no two ' +
    'sessions with hard:true land on calendar-adjacent dates (e.g. not both Tuesday and Wednesday). Prefer ' +
    'capacity.preferredLongDay for a hard:true session when that day is actually feasible for it — a soft ' +
    'preference, not a hard requirement. If a session genuinely cannot be placed anywhere under these rules, ' +
    'do not force it — list its id in unplaced with a short, specific reason instead. Every sessionsToPlace ' +
    'id must end up EITHER in assignments OR in unplaced, never neither.\nsessionsToPlace:\n' +
    JSON.stringify(sessionsToPlace, null, 2) + '\n\n'
  );
}
const HARD_ADJACENT_MS = 86400000;
function sanitizeAssignments(raw, sessionsToPlace, perDay) {
  const validIds = new Set(sessionsToPlace.map((s) => s.id));
  const validDates = new Set(perDay.map((d) => d.dateKey));
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 20)
    .filter((a) => a && typeof a.id === 'string' && validIds.has(a.id) && typeof a.dateKey === 'string' && validDates.has(a.dateKey))
    .map((a) => ({ id: a.id, dateKey: a.dateKey }));
}
// The actual re-validation — never trusts a placement just because
// the model proposed it (same discipline as
// dropBlocksOverlappingFixedEvents elsewhere in this file): rebuilds
// each day's running total from scratch in assignment order, drops
// (into unplaced) anything that would blow the day's budget, land on
// a disallowed discipline, or stack a second hard:true session next
// to another one already placed on an adjacent date.
function buildFinalLayout(assignments, sessionsToPlace, perDay, unplacedSeed) {
  const sessionById = {};
  sessionsToPlace.forEach((s) => { sessionById[s.id] = s; });
  const dayByDate = {};
  perDay.forEach((d) => { dayByDate[d.dateKey] = { weekday: d.weekday, dateKey: d.dateKey, availableMin: d.availableMin, allowedDisciplines: d.allowedDisciplines, usedMin: 0, sessions: [] }; });
  const hardDates = new Set();
  const unplaced = unplacedSeed.slice();
  const seededIds = new Set(unplaced.map((u) => u.id));
  const placedIds = new Set();

  assignments.forEach((a) => {
    if (seededIds.has(a.id) || placedIds.has(a.id)) return; // already resolved (seeded-unplaceable, or a duplicate assignment for the same id)
    const session = sessionById[a.id];
    if (!session) return;
    let day = dayByDate[a.dateKey];
    if (!day) {
      // BUG FIX (reported) — capacity.perDay only ever covers TODAY
      // through Sunday (see buildWeekCapacity), so a rhythm-fixed
      // session (its own dateKey, set only by buildRhythmSessionsForDiscipline)
      // on a day strictly BEFORE today — e.g. Monday's Push, checked
      // on Tuesday — has no matching `day` here at all. This used to
      // fall all the way through to the generic, unnamed "Could not
      // be placed — no day both allowed this discipline and had
      // enough free time" catch-all below, even though capacity
      // never even considered that day. A past day has already
      // happened or not; capacity/availability don't apply to it
      // retroactively — place it directly, no validation, same spirit
      // as the hard-adjacency exemption a rhythm-fixed session
      // already gets. A model-placed session (no dateKey) can never
      // reach this branch at all — sanitizeAssignments already
      // restricts those to perDay's own validDates.
      if (!session.dateKey) return;
      day = { weekday: session.weekday || '', dateKey: a.dateKey, availableMin: Infinity, allowedDisciplines: {}, usedMin: 0, sessions: [] };
      dayByDate[a.dateKey] = day;
    }
    // BUG FIX (reported) — session.dateKey (set only by a rhythm-
    // sourced session — see buildRhythmSessionsForDiscipline) means
    // the USER already deliberately placed this discipline on this
    // exact day; per the rule applied consistently everywhere
    // availability is checked (gym.html's buildWeekCapacity/Today/
    // Tomorrow feasibility, main.html's rhythm-grid warnings), that
    // placement itself counts as allowed, same as the hard-adjacency
    // exemption a rhythm-fixed session already gets just below. The
    // client's own allowedDisciplines (computed from the SAME rule)
    // would already say true here in practice — this is the server's
    // own independent re-validation never trusting the client blindly.
    if (!session.dateKey && day.allowedDisciplines[session.discipline] === false) {
      unplaced.push({ id: a.id, reason: session.discipline + ' is not allowed on ' + day.weekday + '.' });
      return;
    }
    if (day.usedMin + session.estMinutes > day.availableMin) {
      unplaced.push({ id: a.id, reason: 'Does not fit ' + day.weekday + '\'s available time (' + day.availableMin + ' min).' });
      return;
    }
    if (session.hard) {
      const thisMs = Date.parse(a.dateKey);
      const adjacent = [...hardDates].some((hd) => Math.abs(Date.parse(hd) - thisMs) === HARD_ADJACENT_MS);
      // Phase 3.5 — session.dateKey (set only by a rhythm-sourced
      // session — see buildRhythmSessionsForDiscipline) means this
      // placement is the USER's own deliberate choice, not something
      // the model picked. Back-to-back hard days is a heuristic this
      // function uses to protect against the MODEL stacking fatigue by
      // accident; it was never meant to override a day the user fixed
      // on purpose (e.g. "Tuesday is always my interval day, Wednesday
      // is always my long day"), so a rhythm-fixed hard session is
      // never rejected for this reason. It still COUNTS toward
      // hardDates below, though — a model-placed hard session must
      // still avoid landing next to it.
      if (adjacent && !session.dateKey) {
        unplaced.push({ id: a.id, reason: 'Would stack two demanding sessions on back-to-back days.' });
        return;
      }
      hardDates.add(a.dateKey);
    }
    day.usedMin += session.estMinutes;
    day.sessions.push({ id: session.id, discipline: session.discipline, kind: session.kind, activityTypeId: session.activityTypeId, activityName: session.activityName, targetAmount: session.targetAmount, unit: session.unit, estMinutes: session.estMinutes });
    placedIds.add(a.id);
  });

  // Every sessionsToPlace id ends up EITHER placed OR in unplaced —
  // never silently dropped (same guarantee reconcileUserActivities
  // already provides for day-plan's userActivities elsewhere in this
  // file), covering both a session the model forgot to assign at all
  // and one whose assignment got dropped by the validation above.
  sessionsToPlace.forEach((s) => {
    if (!placedIds.has(s.id) && !seededIds.has(s.id) && !unplaced.some((u) => u.id === s.id)) {
      unplaced.push({ id: s.id, reason: 'Could not be placed — no day both allowed this discipline and had enough free time.' });
    }
  });

  const layout = Object.values(dayByDate)
    .filter((d) => d.sessions.length)
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey))
    .map((d) => ({ weekday: d.weekday, dateKey: d.dateKey, sessions: d.sessions }));
  return { layout, unplaced };
}

function normalizePlan(raw, restrictions, recommendableTypes, activeWeekDisciplines, capacity, rhythm, weekDates, firstWeekTargets) {
  const restricted = restrictedScopeSet(restrictions);
  const types = Array.isArray(recommendableTypes) ? recommendableTypes : [];
  const r = raw || {};
  const strength = r.strength || {};
  const cardio = r.cardio || {};
  // Strength side is completely untouched by this generalization — same
  // hard-override-to-0 enforcement as before.
  const strengthRestricted = restricted.has('strength');

  let targets = activeWeekDisciplines ? buildTargetsFromActiveWeek(activeWeekDisciplines, types, restricted, strengthRestricted) : null;
  // Phase 3.4 — capacity-aware trim, deterministic, applied BEFORE
  // anything downstream (legacy-slot mirror, layout session sizing)
  // ever sees `targets` — "never present a target the week cannot
  // hold" is a hard guarantee from code, not a model-compliance hope.
  let trimNote = null;
  if (targets) {
    const trimmed = applyCapacityBackstop(targets, capacity);
    targets = trimmed.targets;
    trimNote = trimmed.trimNote;
  }
  const legacyOverride = targets ? deriveLegacyCardioFromTargets(targets, cardio) : null;

  // Phase 3.4 — week layout: only meaningful when there's a real,
  // capacity-final `targets` to build sessions from AND real capacity
  // day-slots to place them into. sessionsToPlace/unplaceableSeed are
  // recomputed here (not trusted from earlier in the request) so they
  // always reflect the FINAL, trimmed targets.
  let layout = undefined;
  let unplaced = undefined;
  const rhythmMismatchNotes = [];
  // FEATURE (reported) — see buildPlanSystemPrompt's own comment;
  // null (not []) when there's no real layout at all this request,
  // which is what tells stripInventedKindMentions below to skip
  // entirely (an unconfigured/no-capacity week's rationale is
  // completely untouched, same as before this feature existed).
  let realSessionKinds = null;
  if (targets && capacity && capacity.configured && capacity.perDay.length) {
    const sessionsToPlace = buildSessionsToPlace(targets, capacity, rhythm, weekDates, rhythmMismatchNotes, firstWeekTargets);
    realSessionKinds = Array.from(new Set(sessionsToPlace.map((s) => s.kind).filter(Boolean)));
    const unplaceableSeed = buildUnplaceableSeed(targets, capacity, sessionsToPlace);
    const placeableSessions = sessionsToPlace.filter((s) => !unplaceableSeed.some((u) => u.id === s.discipline));
    // Phase 3.5 — a rhythm-sourced session already carries its own
    // dateKey; it's taken as a fixed assignment directly (never asked
    // of the model), then validated against capacity in
    // buildFinalLayout exactly like every other placement — "capacity
    // trimming still applies on top" of the rhythm, not instead of it.
    const rhythmAssignments = placeableSessions.filter((s) => s.dateKey).map((s) => ({ id: s.id, dateKey: s.dateKey }));
    const sessionsNeedingModelPlacement = placeableSessions.filter((s) => !s.dateKey);
    const modelAssignments = sanitizeAssignments(r.assignments, sessionsNeedingModelPlacement, capacity.perDay);
    const assignments = rhythmAssignments.concat(modelAssignments);
    const built = buildFinalLayout(assignments, placeableSessions, capacity.perDay, unplaceableSeed);
    layout = built.layout;
    unplaced = built.unplaced;
  }

  return {
    strength: {
      targetSessions: (targets && targets.strength) ? targets.strength.sessions : (strengthRestricted ? 0 : Math.max(1, Math.round(num(strength.targetSessions, 3)))),
      focus: typeof strength.focus === 'string' ? strength.focus.slice(0, 200) : '',
    },
    cardio: {
      interval: normalizeCardioInterval(cardio.interval, types, restricted),
      longSession: legacyOverride ? legacyOverride.longSession : normalizeCardioVolume(cardio.longSession, types, restricted, 8),
      easyVolume: legacyOverride ? legacyOverride.easyVolume : normalizeCardioVolume(cardio.easyVolume, types, restricted, 10),
    },
    // Absent (not null) when there's no active-plan disciplines data at
    // all — JSON.stringify drops an `undefined` key entirely, so an
    // unconfigured/legacy response is byte-for-byte what this endpoint
    // already produced before this sub-step existed.
    targets: targets || undefined,
    capacityNote: trimNote || undefined,
    // "Available this week: 6h20 across 5 days" — the card's own
    // one-line summary (spec's exact wording), computed straight from
    // the client-provided capacity totals, present only alongside a
    // real capacity computation.
    availableSummary: (capacity && capacity.configured) ? { totalFreeMin: capacity.perDay.reduce((s, d) => s + d.availableMin, 0), daysWithTimeCount: capacity.perDay.filter((d) => d.availableMin > 0).length } : undefined,
    layout,
    unplaced,
    // Phase 3.5 — "3 swims in a 2-swim week": surfaced so the card can
    // show it, never silently resolved either direction (the rhythm
    // isn't trimmed to match the target, nor is the target changed to
    // match the rhythm).
    rhythmMismatchNotes: rhythmMismatchNotes.length ? rhythmMismatchNotes : undefined,
    rationale: typeof r.rationale === 'string' ? stripInventedKindMentions(truncateAtWordBoundary(r.rationale.trim(), 900), realSessionKinds) : '',
  };
}

async function handlePlan(req, res, apiKey, body) {
  const restrictions = sanitizeRestrictions(body.restrictions);
  const recommendableTypes = sanitizeActivityTypes(body.recommendableActivityTypes);
  // Phase 3.1 — see this mode's own doc comment for the field's shape
  // and sanitizeActiveWeekDisciplines's own comment for why null (not
  // {}) means "nothing to do here, behave exactly as before".
  const activeWeekDisciplines = sanitizeActiveWeekDisciplines(body.activeWeekDisciplines);
  // FEATURE (reported) — the plan's FIRST checkpoint's own run/bike
  // target, resolved client-side (gym.html already walks the active
  // plan's checkpoints) and sent alongside activeWeekDisciplines
  // (THIS week's own target) — the fixed "reference week" a km-aware
  // rhythm split's shares are derived against, independent of which
  // week is actually being generated right now. Reuses the exact
  // same sanitizer; same shape. Optional — absent whenever no rhythm
  // entry sets an explicit km at all, or the client couldn't resolve
  // a first checkpoint, in which case the km-aware split never
  // triggers at all (see splitRhythmSessionsByShares's own guard).
  const firstWeekTargets = sanitizeActiveWeekDisciplines(body.firstWeekTargets);
  // Phase 3.4 — see sanitizeCapacity's own comment.
  const capacity = sanitizeCapacity(body.capacity);
  // Pre-compute the FINAL targets/trim/sessions BEFORE calling the
  // model, so the layout prompt section can list real feasible
  // sessions in the SAME call (one round trip, not two) — see
  // buildSessionsToPlace's own header comment on why sizing happens
  // in code rather than being asked of the model at all.
  const types = recommendableTypes;
  const restrictedScopes = restrictedScopeSet(restrictions);
  const strengthRestrictedForLayout = restrictedScopes.has('strength');
  let preTargets = activeWeekDisciplines ? buildTargetsFromActiveWeek(activeWeekDisciplines, types, restrictedScopes, strengthRestrictedForLayout) : null;
  let preTrimNote = null;
  if (preTargets) {
    const trimmed = applyCapacityBackstop(preTargets, capacity);
    preTargets = trimmed.targets;
    preTrimNote = trimmed.trimNote;
  }
  // Phase 3.5 — weeklyRhythm/weekDates are both optional (absent or
  // empty => every discipline falls back to the pre-3.5 sizing below,
  // byte-for-byte). weekDates maps weekday -> this week's real dateKey
  // (client-computed via DayLib); without it a rhythm entry can't be
  // placed at all and that discipline falls back the same way.
  const rhythm = (body.weeklyRhythm && typeof body.weeklyRhythm === 'object' && rhythmHasAnyEntries(body.weeklyRhythm)) ? body.weeklyRhythm : null;
  const weekDates = (body.weekDates && typeof body.weekDates === 'object') ? body.weekDates : null;
  const preMismatchNotes = [];
  const sessionsToPlace = preTargets ? buildSessionsToPlace(preTargets, capacity, rhythm, weekDates, preMismatchNotes, firstWeekTargets) : [];
  const unplaceableSeed = preTargets ? buildUnplaceableSeed(preTargets, capacity, sessionsToPlace) : [];
  const placeableSessions = sessionsToPlace.filter((s) => !unplaceableSeed.some((u) => u.id === s.discipline));
  // FEATURE (reported) — see buildPlanSystemPrompt's own comment on
  // realSessionKinds and normalizePlan's stripInventedKindMentions.
  // Only non-empty when a real layout exists at all (sessionsToPlace
  // is [] otherwise) — an unconfigured/no-capacity week is untouched,
  // same as every other layout-only code path in this file.
  const realSessionKinds = Array.from(new Set(sessionsToPlace.map((s) => s.kind).filter(Boolean)));
  // A rhythm-sourced session already has its own dateKey — the model
  // is NEVER asked to place it (only re-validated against capacity
  // further down, same as every other placement). Only the subset
  // still missing a day goes into the layout prompt at all.
  const sessionsNeedingModelPlacement = placeableSessions.filter((s) => !s.dateKey);

  const context = {
    recentStrengthSessions: Array.isArray(body.strengthSessions) ? body.strengthSessions.slice(0, 30) : [],
    recentExerciseNames: Array.isArray(body.recentExerciseNames) ? body.recentExerciseNames.slice(0, 30) : [],
    recentActivitySessions: Array.isArray(body.activitySessions) ? body.activitySessions.slice(0, 40) : [],
    whoop: body.whoop && typeof body.whoop === 'object' ? body.whoop : null,
    activeRestrictions: restrictions,
    activeWeekDisciplines,
  };

  const text = await callClaude(apiKey, {
    system: buildPlanSystemPrompt(restrictions, recommendableTypes, activeWeekDisciplines, realSessionKinds)
      + buildCapacityPromptSection(capacity, preTrimNote)
      + buildLayoutPromptSection(sessionsNeedingModelPlacement, capacity),
    userContent: 'Recent history:\n' + JSON.stringify(context, null, 2),
    // Confirmed via the [plan debug] log (not assumed): stop_reason
    // was 'max_tokens' with 327 of the 800-token budget spent on
    // thinking alone, and the remaining ~470 tokens weren't enough to
    // finish strength + all 3 cardio slots (each with its own
    // activityTypeId/activityName/amount/unit/description) + rationale
    // — the raw text was cut off mid-word. 800 was sized for this
    // output's shape from before activity types/restrictions/cardio-
    // slot logic were added; it never got re-sized as that output grew.
    // 2000 matched day-plan/find-patterns' own sizing at the time.
    // Phase 3.4 adds a potentially-large `assignments` array (one
    // entry per session, each session already described in the
    // prompt) on top of the unchanged plan/rationale output — 3200
    // keeps the same real margin above a plausible full-size response
    // (up to ~7 sessions in a typical week) that 2000 gave the
    // smaller pre-3.4 output.
    maxTokens: 3200,
    // BUG FIX (reported): this call never set `effort` at all before
    // Phase 3.4, defaulting to claude-sonnet-5's adaptive HIGH effort
    // — tolerable for the smaller pre-3.4 prompt, but Phase 3.4 added
    // two substantial new sections (capacity + the full sessionsToPlace/
    // feasibleDays layout instructions) on top of it, and high-effort
    // thinking on a now-much-bigger prompt is a real, documented
    // failure class already fixed this exact way for mode=today
    // (see that handler's own comment: "high-effort adaptive thinking
    // spending most/all of the budget on internal reasoning" — either
    // truncating the JSON output or, worse here with a 10s-class
    // Vercel function timeout, never returning in time at all, which
    // surfaces client-side as a request failure indistinguishable from
    // any other). 'medium' (not 'low', unlike mode=today's genuinely
    // trivial one-line output) — this task is real judgment (balancing
    // strength/cardio, an actual capacity trim narrative, placing
    // sessions into specific days) and shouldn't skip reasoning
    // entirely, just the runaway high-effort deliberation that risks
    // not finishing in time.
    effort: 'medium',
    debugLabel: 'plan', // TEMPORARY — see callClaude's own comment on this
  });
  const parsed = extractJson(text);
  if (!parsed) return res.status(502).json({ ok: false, error: 'Model did not return valid JSON.' });

  return res.status(200).json({ ok: true, plan: normalizePlan(parsed, restrictions, recommendableTypes, activeWeekDisciplines, capacity, rhythm, weekDates, firstWeekTargets) });
}

// ------------------------------------------------------------
// MODE: today
// ------------------------------------------------------------

function buildRhythmPromptSection(dayLabel, allowRecoveryDeviation) {
  const recoveryReason = allowRecoveryDeviation
    ? 'WHOOP recovery is low enough (per WHOOP-ADJUSTMENT) to downgrade a hard rhythm entry (interval/long/pace) to something easier or to rest; '
    : ''; // Tomorrow's own prompt already forbids reasoning from today's specific recovery number — see RECOVERY IS UNKNOWN FOR THIS DAY above
  return (
    'WEEKLY RHYTHM (Phase 3.5): if context.rhythmForDay is non-empty, the user has a FIXED weekly pattern ' +
    'and it already says which discipline + kind ' + dayLabel + ' is — that is the DEFAULT recommendation, ' +
    'not a suggestion to weigh against other ideas. Recommend exactly that discipline + kind unless one of ' +
    'these specific, checkable things says otherwise: an active restriction blocks that discipline; ' +
    recoveryReason +
    dayLabel + '\'s feasibility/calendar (an event, padel) rules that discipline out entirely; or a ' +
    'Phase-3.3 missed strength day-type legitimately takes priority over a rhythm strength day. For a ' +
    'strength entry specifically, kind IS the day type (e.g. "push", "legs", "explosive") — treat it exactly ' +
    'as authoritative as strengthContext.todaySplitDay (you may not pick a different day type) UNLESS kind ' +
    'is "auto", which means the rhythm has no opinion on WHICH day type and you follow ' +
    'strengthContext.todaySplitDay/the rotation exactly as you would with no rhythm at all. ' +
    'BUG FIX (reported) — never invent a session that is neither in rhythmForDay nor a code-computed ' +
    'rebalanceToday catch-up session — weekPlan\'s own cardio/volume targets are NOT by themselves a reason ' +
    'to add a session; a target being outstanding for the WEEK does not mean it belongs TODAY specifically ' +
    '(that is exactly what rhythmForDay/rebalanceToday already decide). No extra interval "just because". ' +
    'If you deviate from the rhythm for any of these reasons, say so in ONE short clause ' +
    'naming the real reason (e.g. "Easy run instead of interval — recovery 31%", "Pull instead of Legs — ' +
    'Monday\'s Push was missed"). If rhythmForDay is empty/absent, ignore this paragraph and decide as you ' +
    'would otherwise.\n\n'
  );
}
// Phase 4.1 — rebalanceToday is code-computed client-side (gym.html's
// buildRebalanceLayout), never model-chosen: if real past-day volume/
// sessions are behind this week's plan target, code already decided
// WHICH session(s), sized and dated for today specifically, belong
// today as catch-up. This section only tells the model to STATE the
// real reason in its existing output format -- it never overrides
// the rhythm default, restrictions, or the low-recovery downgrade
// elsewhere in this prompt, all of which still decide the final
// answer exactly as before.
function buildRebalanceTodayPromptSection(rebalanceToday) {
  if (!rebalanceToday || !Array.isArray(rebalanceToday.sessions) || !rebalanceToday.sessions.length) return '';
  return (
    'MISSED-SESSION REBALANCING (Phase 4.1) — rebalanceToday.sessions lists session(s) CODE has already ' +
    'decided belong today specifically, already in PRIORITY order (a missed STRENGTH day-type — ' +
    's.dayType/s.weekday — first, then a cardio backlog chunk, matching what you are told about this ' +
    'week so far), to catch up real volume/sessions missed on an EARLIER day this week (ground truth from ' +
    'logged activities vs the plan\'s own targets, not a guess). Prefer recommending these over today\'s ' +
    'plain rhythm default when they exist — still subject to every rule above (restrictions, WHOOP/padel ' +
    'downgrades) — and state the real reason briefly using the entry\'s own numbers/day-type, e.g. "Pull ' +
    '(missed Wednesday)" or "Run easy 6 km: 8.1 km behind this week" — never invent a different number or ' +
    'day. Do NOT answer "Rest" or "nothing feasible" when a session is listed here and none of the code-' +
    'checkable reasons above (restriction, low recovery, no free time) actually applies — that combination ' +
    'produces a contradictory answer. You may NOT add a session that isn\'t listed here, resize one that ' +
    'is, or move one to a different day.\n\n'
  );
}
// BUG FIX (reported) — weekPlan.cardio's legacy interval/longSession/
// easyVolume pieces are a WEEKLY summary (is this piece outstanding
// ACROSS the whole week), with no idea which specific day it belongs
// on. Once a real weekly rhythm is configured, rhythmForDay/
// rebalanceToday already decide that per-day placement exactly — the
// CARDIO section below used to run unconditionally regardless, which
// is how "Push + Running interval" got invented on a Monday whose
// rhythm is only Push (the first run isn't until Tuesday): the model
// correctly named Push from the rhythm, then ALSO added an interval
// session because weekPlan.cardio.interval still had a nonzero
// target for the week. See applyRhythmBackstop's own
// stripUnvalidatedRhythmClauses for the code-level backstop on top of
// this prompt-level fix.
function buildCardioLegacySkipNote(dayLabel) {
  return (
    'CARDIO — a weekly rhythm is configured, which is the sole source of truth for which cardio session ' +
    '(if any) belongs ' + dayLabel + '. IGNORE weekPlan.cardio\'s interval/longSession/easyVolume pieces ' +
    'entirely when deciding what to recommend ' + dayLabel + ' — a nonzero target there only means that ' +
    'piece is outstanding SOMEWHERE this week, never that it belongs ' + dayLabel + ' specifically; it is a ' +
    'legacy weekly summary only, never a reason to add, resize, or describe a session beyond what ' +
    'rhythmForDay/rebalanceToday above already give you.\n\n'
  );
}
function buildTodaySystemPrompt(restrictions, feasibility, rebalanceToday, rhythmConfigured) {
  return (
    'You recommend today\'s training on a personal dashboard. This week\'s plan (weekPlan) always covers ' +
    'BOTH strength and cardio — evaluate the two independently, then combine whichever pieces are ' +
    'actually outstanding and appropriate today into ONE recommendation (e.g. "Push + Cycling interval"). ' +
    'It is normal and expected for the answer to include both — do not default to naming only strength; ' +
    'check cardio\'s status with the same weight every time. ' +
    (rhythmConfigured ? 'A weekly rhythm is configured below — see its own section for how that changes this.' : '') + '\n\n' +
    buildRhythmPromptSection('today', true) +
    'WHOOP-ADJUSTMENT (match this app\'s existing convention exactly): recovery >=67% is high/well-' +
    'recovered — combining strength with even the hard interval piece today is fine if both are due. ' +
    '34-66% is moderate — combining is still fine for lighter pairings (e.g. strength + easy cardio ' +
    'volume), but avoid pairing strength with the interval piece; if both would be demanding, pick just ' +
    'one. Below 34% is low — pick AT MOST ONE light thing (easy Zone 2 cardio volume OR light strength) or ' +
    'recommend explicit rest; never combine two demanding sessions, and never recommend the interval ' +
    'piece. If Whoop is not connected (whoopToday is null), ignore recovery and decide purely from what\'s ' +
    'outstanding in the plan.\n\n' +
    'STRENGTH — strengthContext tells you the user\'s ACTUAL configured split; use it, don\'t invent a ' +
    'different one. strengthContext.todaySplitDay is today\'s real rotation day (e.g. "Push", "Pull", ' +
    '"Legs", or "Rest") from the split they set up themselves — NEVER name a different day, and never ' +
    'invent a generic structure like "full-body". strengthContext.exercisesConfiguredForToday is context ' +
    'for your own reasoning only (sanity-checking the day actually has exercises configured) — never ' +
    'repeat it in the output. progress.strengthSessionsDone vs progress.strengthSessionsTarget tells you ' +
    'whether strength is behind this week. If strengthContext.isRestDayInRotation is true, only include ' +
    'strength anyway if the weekly target is meaningfully behind and recovery allows it, and when you do, ' +
    'you MUST pick which day-type to name using strengthContext.rotationDayTypes (all the user\'s real, ' +
    'non-Rest day-types) minus strengthContext.daysTrainedThisWeek (day-types already trained since Monday, ' +
    'from actual logs) — always prefer a day-type NOT in daysTrainedThisWeek over repeating one that is, ' +
    'even though today\'s rotation slot is Rest. Only repeat an already-trained day-type if EVERY day-type ' +
    'in rotationDayTypes is already in daysTrainedThisWeek (training frequency exceeding the number of day- ' +
    'types is the only legitimate reason to repeat one within the same week). Keep the framing to a couple ' +
    'trailing words at most (e.g. "<day-type> anyway"). If strengthContext itself is missing or ' +
    'todaySplitDay is null, no split is configured — say that plainly rather than guessing.\n\n' +
    'MISSED DAY-TYPES (Phase 3.3) — strengthContext.missedDayTypes lists day-types the rotation assigned ' +
    'to an EARLIER day THIS week that the user never actually trained on that day (oldest first, each with ' +
    'its real weekday name, e.g. [{"dayType":"Push","weekday":"Monday"}]) — this is ground truth from ' +
    'actual logs, not a guess. If progress.strengthSessionsDone is less than progress.strengthSessionsTarget ' +
    '(strength is still behind this week) AND missedDayTypes is non-empty, prefer the OLDEST entry\'s ' +
    'dayType over today\'s own strengthContext.todaySplitDay, as long as WHOOP-ADJUSTMENT above and the ' +
    'feasibility section below both still allow a strength session today — this takes priority over ' +
    'today\'s normal rotation slot (even a non-Rest one, e.g. today says "Pull" but Monday\'s "Push" was ' +
    'skipped: recommend Push, not Pull). When you do this, name it briefly using the EXACT weekday the ' +
    'entry itself gives, e.g. "Push (missed Monday)" — never invent or guess a different weekday. Only ' +
    'catch up on ONE missed day-type at a time, and NEVER combine it with today\'s own rotation day-type or ' +
    'with the isRestDayInRotation catch-up logic above in the same recommendation — exactly one strength ' +
    'day-type per day, period. If missedDayTypes is empty, or strength is already on track this week, use ' +
    'todaySplitDay/the isRestDayInRotation logic above exactly as already described, unaffected by this.\n\n' +
    (rhythmConfigured ? buildCardioLegacySkipNote('today') :
    'CARDIO (Phase 3 of the multi-activity-type generalization — no longer always running) — ' +
    'weekPlan.cardio has three pieces, each already assigned its OWN activity by name when the weekly ' +
    'plan was generated: interval (activityTypeId/activityName + targetSessions/targetMinutes), ' +
    'longSession, and easyVolume (activityTypeId/activityName + targetAmount/unit each). Different pieces ' +
    'can be different activities (e.g. interval on Cycling, easyVolume on Swimming) — always recommend by ' +
    'whatever activityName that specific piece actually carries, never assume or default to "running". A ' +
    'piece with a zero/empty target (targetSessions 0, targetAmount 0, or activityTypeId null) has ' +
    'NOTHING to recommend — it was either never configured this week, or its activity is restricted/not ' +
    'recommendable right now (already enforced when the plan itself was generated) — skip it regardless ' +
    'of anything else, and never invent a replacement activity for it yourself. progress.activitiesThisWeek ' +
    'lists what has ACTUALLY been logged since Monday, NOT pre-labeled by piece — each entry carries its ' +
    'own activityTypeId; match it against a piece\'s activityTypeId first, then judge by relative amount/' +
    'effort among same-type sessions which piece it most likely satisfied (the largest-amount session of ' +
    'that type is probably the long session; a short, high-effort one is probably the interval piece; ' +
    'anything else is probably easy volume). Whichever piece(s) have a nonzero target AND have NOT clearly ' +
    'been satisfied yet are outstanding and worth recommending if recovery allows — never suggest a piece ' +
    'that\'s already been done this week. progress.cardioAmountDone vs progress.cardioAmountTarget ' +
    '(progress.cardioUnit gives the unit, e.g. "km") is a secondary volume signal only, not a substitute ' +
    'for checking which specific piece is still due. Even if weekPlan.cardio shows a nonzero target for a ' +
    'piece, do NOT recommend it if that piece\'s activityTypeId or activityName matches an entry in ' +
    'activeRestrictions below (checked by id or name) — a restriction can be added after the weekly plan ' +
    'was last generated, so this is a live, independent check, not just trusting weekPlan\'s own numbers.\n\n') +
    buildRebalanceTodayPromptSection(rebalanceToday) +
    'PADEL — todayCalendar tells you whether the user has a real padel session on their Google Calendar ' +
    'today (todayCalendar.padelToday, with the actual matched event title in ' +
    'todayCalendar.padelEventTitle when true). Padel is a genuinely demanding session physically — treat a ' +
    'padel day the same way you treat low WHOOP recovery (see WHOOP-ADJUSTMENT above): do NOT recommend ' +
    'strength or a cardio session on top of it. Prefer explicit rest, or at most very light active ' +
    'recovery (an easy walk, light mobility) — never combine padel with Explosiveness, the interval ' +
    'piece, a long/easy cardio session, or a full strength split, even if the weekly plan has those ' +
    'outstanding. If padel and low recovery both apply, that is an even stronger case for pure rest, not a ' +
    'reason to reconsider. If todayCalendar is missing or todayCalendar.padelToday is false, ignore padel ' +
    'entirely and reason from WHOOP/strength/cardio as usual.\n\n' +
    buildFeasibilityPromptSection(feasibility) +
    buildRestrictionsPromptSection(restrictions) +
    'FORMAT — this is the most important rule: the recommendation is a SHORT LABEL, not a paragraph. One ' +
    'line, naming only the split day and/or the specific cardio activity/distance from this week\'s plan — ' +
    'nothing else. Good examples: "Push", "Push + 5K run", "Push + Cycling interval", "10K long run", ' +
    '"Swim — easy volume", "Rest — recovery is low", "Easy Cycling + Legs", "Rest — padel today", "Easy ' +
    'walk only — padel today", "Push — cycling restricted". Bad (never do this): listing individual ' +
    'exercises, sets, reps, or weights; explaining "no prior weights logged, so start conservative"; ' +
    'multi-sentence reasoning. The exercise-by-exercise detail for whatever day you name is already ' +
    'visible on the Strength tab itself once the user gets there — your only job is telling them WHICH ' +
    'one(s) to do today, not repeating what\'s already on that page. A few trailing words of context are ' +
    'fine when genuinely needed (e.g. "— recovery is low"), but never more than that.\n\n' +
    'Reply with ONLY valid JSON, no markdown fences, no commentary, in exactly this shape:\n' +
    JSON.stringify({ recommendation: 'ONE short line naming only the split day and/or the specific cardio activity/distance, combined with "+" when both are due — e.g. "Push + Cycling interval" — never individual exercises, sets, weights, or multi-sentence explanations' }, null, 2)
  );
}

// buildTomorrowSystemPrompt — a training recommendation for a target
// day OTHER than today (main.html's "Plan my day" Tomorrow toggle).
// Deliberately a SEPARATE prompt function rather than branching inside
// buildTodaySystemPrompt, matching this file's own established
// per-mode-own-prompt-function convention (buildPlanSystemPrompt/
// buildTodaySystemPrompt/buildDayPlanSystemPrompt/etc. each get their
// own) — lower risk than conditionally rewriting the already-tuned
// TODAY prompt in place. Reuses buildTodaySystemPrompt's STRENGTH/
// CARDIO sections' structure (same weekPlan/progress/strengthContext
// shapes, same reasoning about what's outstanding this week) but
// drops WHOOP-ADJUSTMENT and PADEL entirely (both fundamentally about
// TODAY's own specific, already-known numbers) and replaces them with
// the same "don't pretend to know a future day's recovery" framing
// api/chat.js's own QUESTIONS ABOUT A DIFFERENT DAY section already
// established for this exact distinction — reason from the week's
// remaining objectives and general load-management principles
// instead (e.g. not stacking two hard days back to back).
function buildTomorrowSystemPrompt(restrictions, feasibility, rhythmConfigured) {
  return (
    'You recommend training for a day OTHER than today on a personal dashboard — main.html\'s "Plan my day" ' +
    'is being generated ahead of time for tomorrow. This week\'s plan (weekPlan) always covers BOTH strength ' +
    'and cardio — evaluate the two independently, then combine whichever pieces are actually outstanding and ' +
    'appropriate for that day into ONE recommendation (e.g. "Push + Cycling interval"). It is normal and ' +
    'expected for the answer to include both — do not default to naming only strength; check cardio\'s ' +
    'status with the same weight every time. ' +
    (rhythmConfigured ? 'A weekly rhythm is configured below — see its own section for how that changes this.' : '') + '\n\n' +
    buildRhythmPromptSection('tomorrow', false) +
    'RECOVERY IS UNKNOWN FOR THIS DAY — do NOT lead with or rely on today\'s specific WHOOP recovery/strain ' +
    'numbers as if they predict or describe tomorrow; a future day\'s recovery is fundamentally unknowable in ' +
    'advance, and presenting today\'s numbers as if they answer the question would be misleading. Reason ' +
    'instead from what IS knowable in advance: which weekPlan pieces are still outstanding, recent training ' +
    'load and volume progression, and general load-management judgment — most importantly, todayRecommendation ' +
    '(what was already decided/done TODAY) tells you whether today was already a hard day; if so, avoid ' +
    'stacking another demanding session immediately after it (e.g. two heavy strength days or two hard ' +
    'interval sessions back to back) — lean toward a lighter or complementary pairing instead, the same way ' +
    'you would if you already knew recovery would be low, without claiming to actually know that. If ' +
    'whoopRecentStrain shows a consistent multi-day pattern (not just today alone), it is fine to mention as ' +
    'general recent-trend background — never as a specific prediction for tomorrow itself.\n\n' +
    'STRENGTH — strengthContext tells you the ACTUAL configured split for that day; use it, don\'t invent a ' +
    'different one. strengthContext.todaySplitDay is that day\'s real rotation day (e.g. "Push", "Pull", ' +
    '"Legs", or "Rest") from the split the user set up themselves — NEVER name a different day, and never ' +
    'invent a generic structure like "full-body". progress.strengthSessionsDone vs progress.' +
    'strengthSessionsTarget tells you whether strength is behind this week (as of today — that day\'s own ' +
    'session, if you recommend one, would add to this). If strengthContext.isRestDayInRotation is true, only ' +
    'include strength anyway if the weekly target is meaningfully behind, and when you do, you MUST pick ' +
    'which day-type to name using strengthContext.rotationDayTypes (all the user\'s real, non-Rest day-' +
    'types) minus strengthContext.daysTrainedThisWeek (day-types already trained since Monday, from actual ' +
    'logs, through today) — always prefer a day-type NOT in daysTrainedThisWeek over repeating one that is. ' +
    'Only repeat an already-trained day-type if EVERY day-type in rotationDayTypes is already in ' +
    'daysTrainedThisWeek. Keep the framing to a couple trailing words at most (e.g. "<day-type> anyway"). ' +
    'If strengthContext itself is missing or todaySplitDay is null, no split is configured — say that ' +
    'plainly rather than guessing.\n\n' +
    (rhythmConfigured ? buildCardioLegacySkipNote('tomorrow') :
    'CARDIO (Phase 3 of the multi-activity-type generalization — no longer always running) — weekPlan.cardio ' +
    'has three pieces, each already assigned its OWN activity by name when the weekly plan was generated: ' +
    'interval, longSession, and easyVolume. Different pieces can be different activities (e.g. interval on ' +
    'Cycling, easyVolume on Swimming) — always recommend by whatever activityName that specific piece ' +
    'actually carries, never assume or default to "running". A piece with a zero/empty target has NOTHING to ' +
    'recommend — skip it, never invent a replacement. progress.activitiesThisWeek lists what has ACTUALLY ' +
    'been logged since Monday (through today) — match against each piece\'s activityTypeId to judge which ' +
    'piece(s) are still outstanding and worth recommending for that day.\n\n' +
    'Even if weekPlan.cardio shows a nonzero target for a piece, do NOT recommend it if that piece\'s ' +
    'activityTypeId or activityName matches an entry in activeRestrictions below.\n\n') +
    buildFeasibilityPromptSection(feasibility, 'tomorrow') +
    buildRestrictionsPromptSection(restrictions) +
    'FORMAT — this is the most important rule: the recommendation is a SHORT LABEL, not a paragraph. One ' +
    'line, naming only the split day and/or the specific cardio activity/distance from this week\'s plan — ' +
    'nothing else. Good examples: "Push", "Push + 5K run", "Easy Cycling — light after a hard training day", ' +
    '"Rest — today was already demanding". Bad (never do this): listing individual exercises, sets, reps, or ' +
    'weights; multi-sentence reasoning; presenting today\'s WHOOP numbers as if they describe tomorrow.\n\n' +
    'Reply with ONLY valid JSON, no markdown fences, no commentary, in exactly this shape:\n' +
    JSON.stringify({ recommendation: 'ONE short line naming only the split day and/or the specific cardio activity/distance, combined with "+" when both are due' }, null, 2)
  );
}

async function handleToday(req, res, apiKey, body) {
  // Accept both key names: the client is expected to send
  // `restrictions` (matching mode=plan's own body key), but a client
  // sending the context object's own internal field name
  // (`activeRestrictions`, used further below once sanitized) is
  // tolerated too, rather than silently dropping restrictions for
  // whichever caller gets the name wrong.
  const restrictions = sanitizeRestrictions(Array.isArray(body.restrictions) ? body.restrictions : body.activeRestrictions);
  const forTomorrow = !!body.forTomorrow;
  const context = {
    weekPlan: body.weekPlan && typeof body.weekPlan === 'object' ? body.weekPlan : null,
    progress: body.progress && typeof body.progress === 'object' ? body.progress : null,
    strengthContext: body.strengthContext && typeof body.strengthContext === 'object' ? body.strengthContext : null,
    whoopToday: body.whoopToday && typeof body.whoopToday === 'object' ? body.whoopToday : null,
    whoopRecentStrain: Array.isArray(body.whoopRecentStrain) ? body.whoopRecentStrain.slice(0, 14) : null,
    activeRestrictions: restrictions,
    // Phase 3.5 — the client resolves which weekday this request is
    // actually for (today, or tomorrow when forTomorrow) and sends
    // ONLY that day's rhythm entries, already picked out of the full
    // weekly rhythm — this file never needs a date library to know
    // "today" itself (same "server stays dumb about dates" discipline
    // as everywhere else here). Absent/empty means no rhythm is
    // configured, or nothing is set for this specific day.
    rhythmForDay: sanitizeRhythmEntries(body.rhythmForDay),
    // FEATURE (reported) — whether ANY day of the week has a real
    // rhythm entry configured (not just today/tomorrow specifically) —
    // see buildCardioLegacySkipNote's own comment on why the legacy
    // weekPlan.cardio section must be suppressed once this is true,
    // regardless of whether rhythmForDay itself is empty today (e.g.
    // a day the rhythm deliberately has nothing for).
    rhythmConfigured: !!body.rhythmConfigured,
  };
  if (forTomorrow) {
    // No padel/calendar input for this variant — out of scope (see
    // buildTomorrowSystemPrompt's own header comment on what's reused
    // vs deliberately dropped). todayRecommendation is the one NEW
    // input this variant needs: what was already decided for TODAY,
    // so the model can reason about not stacking two hard days.
    context.todayRecommendation = typeof body.todayRecommendation === 'string' ? body.todayRecommendation.slice(0, 300) : null;
    // Phase 3.2 — same feasibility SHAPE as Phase 2's today-only field,
    // just computed for tomorrow by main.html's own
    // buildTomorrowFeasibility (tomorrow's weekday template/override +
    // tomorrow's real calendar gaps) — see that function's own comment.
    context.feasibility = sanitizeFeasibility(body.feasibility);
  } else {
    context.todayCalendar = body.todayCalendar && typeof body.todayCalendar === 'object'
      ? { padelToday: !!body.todayCalendar.padelToday, padelEventTitle: typeof body.todayCalendar.padelEventTitle === 'string' ? body.todayCalendar.padelEventTitle.slice(0, 200) : null }
      : null;
    // Phase 2 of the training-availability feature — TODAY only (see
    // this mode's own doc comment on the feasibility field above).
    context.feasibility = sanitizeFeasibility(body.feasibility);
    // Phase 4.1 — TODAY only (see buildRebalanceTodayPromptSection's
    // own comment); Tomorrow deliberately gets no missed-session
    // signal, same spirit as it getting no padel/calendar input.
    context.rebalanceToday = sanitizeRebalanceToday(body.rebalanceToday);
    // BUG FIX (reported) — TODAY only (see sanitizeTodayLayoutEntry's
    // own comment). Read directly by the backstop below (the actual
    // guarantee that the final text shows the real size) — it's also
    // visible to the model as part of context (JSON.stringify'd below
    // like everything else here), but harmlessly so, since the model
    // is never asked to restate it itself.
    context.todayLayoutEntry = sanitizeTodayLayoutEntry(body.todayLayoutEntry);
  }

  if (!context.weekPlan) {
    return res.status(200).json({ ok: true, recommendation: 'Generate this week\'s objectives above first, then check back here for today\'s pick.' });
  }

  // maxTokens 800 (raised from 300 after an earlier truncation bug) plus
  // effort: 'low' (this task's actual root cause) — claude-sonnet-5's
  // adaptive thinking defaults to 'high' effort, which was spending most
  // or all of the budget on internal reasoning for this single-line
  // recommendation and leaving a literal empty string as the response
  // text. 'low' effort is Anthropic's own recommendation for exactly
  // this kind of simple, short-output, latency-sensitive task, and lets
  // the model skip thinking entirely on inputs this straightforward.
  const text = await callClaude(apiKey, {
    system: forTomorrow ? buildTomorrowSystemPrompt(restrictions, context.feasibility, context.rhythmConfigured) : buildTodaySystemPrompt(restrictions, context.feasibility, context.rebalanceToday, context.rhythmConfigured),
    userContent: 'Context:\n' + JSON.stringify(context, null, 2),
    maxTokens: 800,
    effort: 'low',
  });
  const parsed = extractJson(text);
  let recommendation = parsed && typeof parsed.recommendation === 'string' ? parsed.recommendation.trim() : '';
  if (!recommendation) return res.status(502).json({ ok: false, error: 'Model did not return valid JSON.' });
  // Phase 3.2: the backstop is the same re-check regardless of which
  // day this recommendation is for — applies to both now.
  recommendation = applyFeasibilityBackstop(recommendation, context.feasibility);
  // Phase 3.5 — applied AFTER the feasibility backstop so a rhythm
  // entry that feasibility has already ruled out never gets forced
  // back in; recoveryPct is only ever real for the TODAY variant
  // (Tomorrow's own prompt is told not to use it — see
  // buildTomorrowSystemPrompt's own comment), so forTomorrow passes
  // null there, same as the prompt's own recovery-blind framing.
  recommendation = applyRhythmBackstop(recommendation, context.rhythmForDay, context.feasibility, restrictions, forTomorrow ? null : context.whoopToday, context.strengthContext, context.rebalanceToday, forTomorrow ? null : context.todayLayoutEntry);

  return res.status(200).json({ ok: true, recommendation });
}

// ------------------------------------------------------------
// MODE: day-plan
// ------------------------------------------------------------

// planningDateKey (added for main.html's Today/Tomorrow toggle):
// which day the MAIN schedule (training/work/meals/walks) actually
// gets built for — either todayDateKey or tomorrowDateKey, client-
// chosen. Every rule below was ALREADY correctly scoped by DATE
// (todayDateKey vs tomorrowDateKey) rather than by semantic role, so
// almost nothing needed to change to parameterize this: the nowTime
// rule already only constrains "todayDateKey" blocks specifically, so
// it automatically stops applying on its own once the main schedule's
// blocks are dated tomorrowDateKey instead — no separate conditional
// needed. Only three things actually needed rewording: (1) which date
// the "WHAT YOU DECIDE" items get placed on, (2) which wake time
// anchors meal placement (planningWakeUpTime — todayWakeUpTime when
// planningDateKey is today, or wakeUpTime itself — tomorrow's own
// already-computed wake anchor — when planning tomorrow, so there's
// no second wake-time computation needed for that case), and (3) the
// low-recovery dampening below, which is about TODAY's specific real
// recovery number and must not be treated as predictive of tomorrow —
// same principle as api/chat.js's own QUESTIONS ABOUT A DIFFERENT DAY
// section and buildTomorrowSystemPrompt above.
// The FIXED, NON-NEGOTIABLE section — day-boundary safety constraints
// (fixedEvents, Wake up, Wind-down, nowTime) that apply on EVERY day
// this endpoint plans, race day included: shared verbatim between
// buildDayPlanSystemPrompt and buildRaceDaySystemPrompt rather than
// duplicated, so a future change to e.g. the nowTime rule can't drift
// between the two prompts. Only the "WHAT YOU DECIDE" section below
// this differs per prompt.
function buildFixedSectionPromptText() {
  return (
    'FIXED, NON-NEGOTIABLE — never overlap these, and never move or omit them:\n' +
    '- fixedEvents: the user\'s ACTUAL existing calendar events for today and tomorrow (meetings, padel, ' +
    'appointments, etc. — already-booked real time). Every block you propose must fit strictly around these.\n' +
    '- wakeUpTime is already computed (the earlier of tomorrow\'s configured wake time and a buffer before ' +
    'tomorrow\'s earliest fixed commitment) — do NOT recalculate it yourself. Output a short "Wake up" ' +
    'block on tomorrowDateKey starting at wakeUpTime, and never schedule anything else on tomorrowDateKey ' +
    'before it — this applies regardless of planningDateKey; if you are planning tomorrow\'s own main ' +
    'schedule, this IS that day\'s first block, so nothing else on tomorrowDateKey may come before it.\n' +
    '- todayBedtime is today\'s already-configured sleep time (do NOT recalculate it) — output a ' +
    '"Wind-down" block on todayDateKey ending exactly at todayBedtime, using the exact given time, and ' +
    'never schedule anything else on todayDateKey after it. This is ALWAYS about tonight specifically, ' +
    'regardless of planningDateKey — even when planning tomorrow\'s schedule, still output tonight\'s own ' +
    'Wind-down block on todayDateKey exactly as if planning today.\n' +
    '- nowTime is the actual current wall-clock time this plan is being generated at, "HH:MM". EVERY block ' +
    'you propose on todayDateKey must start at or after nowTime — never propose a start time on todayDateKey ' +
    'that has already passed, even for a normally-morning item. If a default item like breakfast would only ' +
    'make sense before nowTime, use your judgment: shift it to a later, still-sensible slot and rename it if ' +
    'the new time no longer fits the original name (e.g. "Brunch" instead of "Breakfast" if nowTime is ' +
    'already midday), or omit it entirely if no reasonable later slot makes sense — but never output a ' +
    'todayDateKey block starting before nowTime. tomorrowDateKey blocks are unaffected by nowTime — if ' +
    'planningDateKey is tomorrowDateKey, that means the WHOLE day you are scheduling is open, with no ' +
    '"already passed" constraint at all (only the Wake up block\'s own timing still applies).\n\n'
  );
}

// Shared "USER-REQUESTED ACTIVITIES" section — reused verbatim by both
// prompts (race day still honors "+ Add activity" chips exactly like a
// normal day does, per the feature's own "no new safety pattern
// needed, just different content logic" scope).
function buildUserActivitiesPromptSection(userActivities) {
  return (userActivities && userActivities.length ? (
    'USER-REQUESTED ACTIVITIES — these are REQUIRED, unlike the "WHAT YOU DECIDE" items above which you may ' +
    'adjust or omit: the user explicitly asked for each of these to happen on planningDateKey, using its ' +
    'exact name and exact duration:\n' +
    JSON.stringify(userActivities, null, 2) + '\n' +
    'For each one: fit it into a genuinely free gap around fixedEvents and the blocks above — the items YOU ' +
    'decided above may shift earlier or later to make room, but fixedEvents entries never move, no matter ' +
    'what. When preferredWindow is given, place it inside that window if at all possible: "morning" is ' +
    'roughly 6am-12pm, "afternoon" roughly 12pm-5pm, "evening" roughly 5pm until todayBedtime/Wind-down, ' +
    '"before dinner" any time before the Dinner block you place (if this is a normal day) or before the ' +
    'post-race meal block you place (if this is race day). Output each placed one as its own block with ' +
    'category "activity" and title EXACTLY equal to its given name — do not rename, abbreviate, translate, ' +
    'or add detail to it. On todayDateKey it is still subject to the nowTime rule above (cannot start before ' +
    'nowTime) exactly like everything else.\n' +
    'If — and only if — there is genuinely no free gap that fits an activity (respecting its preferredWindow ' +
    'when one was given), do not place it and do not force it into a conflict or shrink its duration — ' +
    'instead add it to the "unplaced" list below with a short, specific reason naming what\'s in the way ' +
    '(e.g. "no free 60-minute gap before your 6pm event", not just "no time"). Every userActivities entry ' +
    'must end up EITHER as a placed block OR in "unplaced" — never neither, and never both.\n\n'
  ) : '');
}

function buildDayPlanSystemPrompt(restrictions, userActivities) {
  return (
    'You are planning ONE user\'s day on a personal dashboard, producing a concrete schedule of time ' +
    'blocks that will be created as real Google Calendar events only after the user reviews and explicitly ' +
    'confirms them — nothing is created automatically, so propose a genuinely usable, non-overlapping plan. ' +
    'planningDateKey tells you which day (todayDateKey or tomorrowDateKey) the main schedule below actually ' +
    'goes on — it may be either one.\n\n' +
    buildFixedSectionPromptText() +
    'WHAT YOU DECIDE — fit these into whatever open time remains around the fixed items above, on ' +
    'planningDateKey:\n' +
    '1. Training session — planningRecommendation is the exact, already-decided session for planningDateKey ' +
    '(already accounts for whatever is actually known/relevant for that day — do not re-evaluate or change ' +
    'WHAT it says, just place it once). DEFAULT TO EARLY: place it shortly after planningWakeUpTime — as the ' +
    'first thing in the day, before breakfast/work — unless a fixedEvents entry actually occupies that slot, ' +
    'in which case fit it into the next open slot as close to planningWakeUpTime as still possible. Do not ' +
    'drift it later in the day (e.g. after breakfast or the work block) without an actual scheduling conflict ' +
    'forcing that — an early session right after waking is the expected default, not a mid-day or afternoon ' +
    'placement. If planningRecommendation is null, skip the training block entirely rather than inventing one.\n' +
    '2. One focused productivity/work block — a reasonable default length (about 1 hour) since no specific ' +
    'preference is configured.\n' +
    '3. Three generic meal blocks — "Breakfast", "Lunch", "Dinner" only, no recipes or macros — at ' +
    'reasonable times relative to planningWakeUpTime (planningDateKey\'s own already-configured wake time — ' +
    'do NOT recalculate it, just use it as the anchor for how early breakfast may start), the fixed events, ' +
    'and each other (breakfast shortly after planningWakeUpTime, lunch around midday, dinner in the evening; ' +
    'several hours apart; never overlapping the training block or a fixed event) — subject always to the ' +
    'nowTime rule above when planningDateKey is todayDateKey (it can override planningWakeUpTime\'s ' +
    'placement, e.g. skip or rename breakfast rather than starting it before nowTime); irrelevant when ' +
    'planningDateKey is tomorrowDateKey, since nothing on that day has "already passed" yet.\n' +
    '4. A short post-meal walk (10-15 minutes) shortly after each of the three meal blocks (or after however ' +
    'many of them survive the nowTime rule, when it applies).\n\n' +
    'If planningDateKey is todayDateKey AND whoopToday shows low recovery (recoveryPct below 34), keep the ' +
    'rest of the day light — do not add anything beyond the items above, and lean toward the shorter end of ' +
    'the work block\'s duration; the training recommendation itself is already adjusted for recovery, so do ' +
    'not second-guess it further here. If planningDateKey is tomorrowDateKey instead, do NOT apply this — ' +
    'today\'s specific whoopToday number does not predict tomorrow\'s recovery, and planningRecommendation ' +
    'for tomorrow has already reasoned about load-management appropriately on its own (see how it was ' +
    'generated); do not layer a second, today-based recovery adjustment on top of it.\n\n' +
    buildUserActivitiesPromptSection(userActivities) +
    buildRestrictionsPromptSection(restrictions) +
    'Reply with ONLY valid JSON, no markdown fences, no commentary, in exactly this shape:\n' +
    JSON.stringify({
      blocks: [
        {
          date: 'YYYY-MM-DD (must be todayDateKey or tomorrowDateKey, whichever the block actually falls on)',
          start: 'HH:MM 24-hour',
          end: 'HH:MM 24-hour',
          title: 'short, e.g. "Training: Push + 5K run", "Wake up", "Breakfast", "Walk", "Wind-down"',
          category: 'one of: sleep, training, work, meal, walk, activity',
        },
      ],
      unplaced: [
        { name: 'exact name from userActivities that could not be placed', reason: 'short, specific reason' },
      ],
    }, null, 2) +
    '\n\nEvery block\'s start must be strictly before its end, blocks must not overlap each other or any ' +
    'fixedEvents entry, and the list should be in chronological order. unplaced must be present (an empty ' +
    'array if everything fit, or if no userActivities were given at all).'
  );
}

// Race Day — used instead of buildDayPlanSystemPrompt when isRaceDay is
// true (planningDateKey matches the active Plan's raceDate — see this
// file's own MODE 3 doc comment). Reuses the exact same FIXED section,
// userActivities section, restrictions section, propose-then-confirm
// JSON shape, and every server-side safety check (normalizeDayPlanBlocks/
// dropBlocksOverlappingFixedEvents/reconcileUserActivities all run
// identically regardless of which prompt produced the raw blocks) — only
// the "WHAT YOU DECIDE" content differs: no training/strength/cardio/
// work/meal blocks at all, race-logistics blocks instead.
function buildRaceDaySystemPrompt(restrictions, userActivities) {
  return (
    'You are planning ONE user\'s RACE DAY on a personal dashboard — today is the exact date of their ' +
    'Sprint Triathlon (or similar single-event race), producing a concrete schedule of time blocks that ' +
    'will be created as real Google Calendar events only after the user reviews and explicitly confirms ' +
    'them — nothing is created automatically. planningDateKey tells you which day (todayDateKey or ' +
    'tomorrowDateKey) the main schedule below actually goes on — it may be either one.\n\n' +
    buildFixedSectionPromptText() +
    'WHAT YOU DECIDE — this is RACE DAY, so do NOT propose any normal training/strength/cardio session, ' +
    'work block, or the usual three-meals-plus-walks pattern a non-race day would get — none of those apply ' +
    'today. Instead, fit these race-logistics blocks into whatever open time remains around the fixed items ' +
    'above, on planningDateKey:\n' +
    '1. Race start time — FIRST check fixedEvents on planningDateKey for one that is plainly the race itself ' +
    '(its title names the race, or clearly reads as a race/event start — e.g. "Sprint Triathlon", ' +
    '"Triathlon race start"). If you find one, treat its start time as the actual race-start anchor for ' +
    'everything below. If there is no such fixedEvents entry, assume a reasonable, typical Sprint Triathlon ' +
    'wave-start time (commonly mid-morning, e.g. around 7:30-8:30am) as the anchor instead — use your ' +
    'judgment for the exact time, but do not pick anything wildly early (e.g. before 6am) or late (e.g. ' +
    'after 11am) without a concrete reason from the given context. Do NOT output the race start itself as a ' +
    'block (it is either already a fixedEvent, or has no calendar event at all) — it is only the anchor the ' +
    'blocks below are built around.\n' +
    '2. Arrival at the venue — a block ending shortly before transition setup begins (see #3), giving enough ' +
    'time to park/check in and get oriented. For a Sprint Triathlon, arriving roughly 90-120 minutes before ' +
    'the race-start anchor is typical — use your judgment within that range based on how much other fixed ' +
    'time exists that morning.\n' +
    '3. Transition setup — racking the bike and laying out gear (helmet, shoes, nutrition) in the transition ' +
    'area. Right after arrival, ending with enough buffer before warmup (#4) — roughly 30-45 minutes is ' +
    'typical.\n' +
    '4. Warmup — a short pre-race warmup (roughly 15-20 minutes), ending shortly before the race-start ' +
    'anchor from #1 (a few minutes\' buffer to get to the start line).\n' +
    '5. Post-race recovery/food — placed AFTER the race itself. Since the race\'s own finish time is not ' +
    'known precisely, estimate a plausible finish for a recreational Sprint Triathlon athlete (roughly ' +
    '1-2 hours after the race-start anchor from #1) and place this block shortly after that estimate — a ' +
    'block for refueling, hydration, and stretching/cooldown, roughly 30-45 minutes.\n\n' +
    'Do not add anything beyond the five items above (plus any userActivities below) — no work block, no ' +
    'separate breakfast/lunch/dinner blocks; the day is entirely structured around the race itself. Keep the ' +
    'rest of today genuinely light after the post-race block — this is a demanding physical day regardless ' +
    'of WHOOP recovery, so do not add training or work blocks even if whoopToday shows good recovery.\n\n' +
    buildUserActivitiesPromptSection(userActivities) +
    buildRestrictionsPromptSection(restrictions) +
    'Reply with ONLY valid JSON, no markdown fences, no commentary, in exactly this shape:\n' +
    JSON.stringify({
      blocks: [
        {
          date: 'YYYY-MM-DD (must be todayDateKey or tomorrowDateKey, whichever the block actually falls on)',
          start: 'HH:MM 24-hour',
          end: 'HH:MM 24-hour',
          title: 'short, e.g. "Arrive at venue", "Transition setup", "Warmup", "Post-race recovery", "Wake up", "Wind-down"',
          category: 'one of: sleep, race, activity',
        },
      ],
      unplaced: [
        { name: 'exact name from userActivities that could not be placed', reason: 'short, specific reason' },
      ],
    }, null, 2) +
    '\n\nUse category "race" for the four race-logistics blocks (arrival, transition setup, warmup, ' +
    'post-race recovery) — "sleep" is only for the Wake up/Wind-down blocks from the FIXED section above, ' +
    'and "activity" is only for placed userActivities entries.\n\n' +
    'Every block\'s start must be strictly before its end, blocks must not overlap each other or any ' +
    'fixedEvents entry, and the list should be in chronological order. unplaced must be present (an empty ' +
    'array if everything fit, or if no userActivities were given at all).'
  );
}

function numOrNull(v) {
  const n = Number(v);
  return isNaN(n) ? null : n;
}

const DAY_PLAN_CATEGORIES = ['sleep', 'training', 'work', 'meal', 'walk', 'activity', 'race'];
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// main.html's "+ Add activity" chips. preferredWindow is a fixed
// whitelist (not free text) so the prompt's morning/afternoon/evening/
// before-dinner definitions stay meaningful — an arbitrary string here
// would just be ignored by buildDayPlanSystemPrompt's own wording.
// Capped at 10 activities: comfortably above anything the chip UI would
// realistically accumulate in one sitting, same defensive-ceiling
// reasoning as e.g. sanitizePainSeries's 200-entry cap elsewhere in
// this file. durationMin clamped 5-480 (8 hours) — wide enough for any
// real single activity, narrow enough to reject garbage input.
const PREFERRED_WINDOWS = ['morning', 'afternoon', 'evening', 'before dinner'];
function sanitizeUserActivities(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 10).map((a) => {
    if (!a || typeof a.name !== 'string') return null;
    const name = a.name.trim().slice(0, 80);
    if (!name) return null;
    const durationMin = Number(a && a.durationMin);
    if (!Number.isFinite(durationMin) || durationMin < 5 || durationMin > 480) return null;
    const preferredWindow = PREFERRED_WINDOWS.indexOf(a.preferredWindow) !== -1 ? a.preferredWindow : null;
    return { name, durationMin: Math.round(durationMin), preferredWindow };
  }).filter(Boolean);
}

// Model-reported unplaced entries — kept only if they actually name one
// of the activities that was really requested (never trust the model to
// echo back exactly what was sent, same discipline as normalizeDayPlanBlocks
// not trusting date/category strings verbatim). The real backstop is
// reconcileUserActivities below, which runs regardless of what the model
// did or didn't report.
function sanitizeUnplaced(raw, userActivities) {
  if (!Array.isArray(raw)) return [];
  const validNames = new Set(userActivities.map((a) => a.name));
  return raw.slice(0, 10)
    .filter((u) => u && typeof u.name === 'string' && validNames.has(u.name))
    .map((u) => ({ name: u.name, reason: typeof u.reason === 'string' && u.reason.trim() ? u.reason.trim().slice(0, 200) : 'Could not fit.' }));
}

// The actual guarantee behind "never silently drop a requested
// activity" — same spirit as dropBlocksOverlappingFixedEvents being a
// real backstop rather than trusting the prompt alone. Runs AFTER
// normalizeDayPlanBlocks (so it sees the final, overlap-filtered block
// list) and reconciles it against what was actually requested: every
// userActivities entry ends up either matched to a surviving
// category:'activity' block with its exact title, or pushed into
// unplaced with a synthesized reason — covering both a userActivity the
// model forgot about entirely, and one it placed but that then got
// dropped by dropBlocksOverlappingFixedEvents for genuinely conflicting
// with a fixed event despite the prompt's instructions.
function reconcileUserActivities(blocks, unplaced, userActivities) {
  const outUnplaced = unplaced.slice();
  const unplacedNames = new Set(outUnplaced.map((u) => u.name));
  for (const activity of userActivities) {
    if (unplacedNames.has(activity.name)) continue;
    const placed = blocks.some((b) => b.category === 'activity' && b.title === activity.name);
    if (!placed) {
      outUnplaced.push({ name: activity.name, reason: 'Could not be scheduled — either no plan block was generated for it, or it was dropped for conflicting with a fixed calendar event.' });
    }
  }
  return outUnplaced;
}

// Half-open-interval overlap on the same calendar date — touching
// endpoints (one block ending exactly when another starts) do NOT
// count as overlapping. All-day fixedEvents have no clock time (see
// this file's own MODE 3 doc comment) so they're skipped here, same
// as the client already skips them for wake-time inference.
function blockOverlapsFixedEvent(block, event) {
  if (event.allDay || !event.start || !event.end || event.date !== block.date) return false;
  return block.start < event.end && event.start < block.end;
}

// Server-side backstop for "never overlap fixedEvents" — the prompt
// already says this emphatically (see buildDayPlanSystemPrompt's FIXED
// section), but nothing previously verified the model actually
// complied, unlike e.g. isCardioTypeBlocked's restriction enforcement
// elsewhere in this file. Dropping a violating block outright (rather
// than trying to trim/reschedule it) is the simpler, safer choice —
// trimming risks producing a degenerate (start>=end) or misleadingly
// short block the user never asked to review.
function dropBlocksOverlappingFixedEvents(blocks, fixedEvents) {
  return blocks.filter((b) => !fixedEvents.some((e) => blockOverlapsFixedEvent(b, e)));
}

function normalizeDayPlanBlocks(raw, todayDateKey, tomorrowDateKey, fixedEvents) {
  const blocks = Array.isArray(raw && raw.blocks) ? raw.blocks : [];
  const cleaned = blocks
    .map((b) => {
      b = b || {};
      const date = (b.date === todayDateKey || b.date === tomorrowDateKey) ? b.date : todayDateKey;
      const start = typeof b.start === 'string' ? b.start.slice(0, 5) : '';
      const end = typeof b.end === 'string' ? b.end.slice(0, 5) : '';
      const title = typeof b.title === 'string' ? b.title.trim().slice(0, 200) : '';
      const category = DAY_PLAN_CATEGORIES.indexOf(b.category) !== -1 ? b.category : 'other';
      return { date, start, end, title, category };
    })
    .filter((b) => b.title && HHMM_RE.test(b.start) && HHMM_RE.test(b.end) && b.start < b.end);
  return dropBlocksOverlappingFixedEvents(cleaned, fixedEvents)
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}

async function handleDayPlan(req, res, apiKey, body) {
  const todayDateKey = typeof body.todayDateKey === 'string' ? body.todayDateKey.slice(0, 10) : '';
  const tomorrowDateKey = typeof body.tomorrowDateKey === 'string' ? body.tomorrowDateKey.slice(0, 10) : '';
  // nowTime is REQUIRED (not defaulted like wakeUpTime/todayWakeUpTime/
  // todayBedtime below) — defaulting it to anything would silently
  // defeat Fix 1 (e.g. defaulting to '00:00' would never filter a
  // single already-passed block), so a missing/malformed value fails
  // loudly instead of quietly reproducing the original bug.
  const nowTime = typeof body.nowTime === 'string' && HHMM_RE.test(body.nowTime) ? body.nowTime : '';
  if (!todayDateKey || !tomorrowDateKey || !nowTime) {
    return res.status(400).json({ ok: false, error: 'todayDateKey, tomorrowDateKey (YYYY-MM-DD), and nowTime (HH:MM) are required' });
  }

  const restrictions = sanitizeRestrictions(body.restrictions);
  // planningDateKey defaults to todayDateKey — an older client that
  // never sends it (or main.html itself with "Today" selected) gets
  // EXACTLY the original behavior with zero change. Only accepted if
  // it actually matches one of the two real dates already given;
  // anything else falls back to todayDateKey rather than trusting an
  // arbitrary client-supplied date string.
  const planningDateKey = body.planningDateKey === tomorrowDateKey ? tomorrowDateKey : todayDateKey;
  const wakeUpTime = typeof body.wakeUpTime === 'string' && HHMM_RE.test(body.wakeUpTime) ? body.wakeUpTime : '07:00';
  const todayWakeUpTime = typeof body.todayWakeUpTime === 'string' && HHMM_RE.test(body.todayWakeUpTime) ? body.todayWakeUpTime : '08:00';
  const context = {
    todayDateKey,
    tomorrowDateKey,
    planningDateKey,
    nowTime,
    // planningRecommendation replaces the old todayRecommendation name
    // — same field, just no longer assumed to always be about today:
    // when planningDateKey is tomorrowDateKey, the client sends
    // whatever mode=today?forTomorrow=true produced instead (see that
    // mode's own doc comment above). Still accepted under the old
    // name too, for a caller that hasn't been updated — planningDateKey
    // would just be todayDateKey in that case anyway, so the meaning
    // is identical either way.
    planningRecommendation: typeof body.planningRecommendation === 'string' ? body.planningRecommendation.slice(0, 300)
      : typeof body.todayRecommendation === 'string' ? body.todayRecommendation.slice(0, 300) : null,
    whoopToday: body.whoopToday && typeof body.whoopToday === 'object' ? { recoveryPct: numOrNull(body.whoopToday.recoveryPct) } : null,
    fixedEvents: Array.isArray(body.fixedEvents) ? body.fixedEvents.slice(0, 40).map((e) => ({
      date: typeof (e && e.date) === 'string' ? e.date.slice(0, 10) : '',
      start: typeof (e && e.start) === 'string' ? e.start.slice(0, 5) : '',
      end: typeof (e && e.end) === 'string' ? e.end.slice(0, 5) : '',
      title: typeof (e && e.title) === 'string' ? e.title.slice(0, 200) : '',
      allDay: !!(e && e.allDay),
    })) : [],
    // TOMORROW's inferred wake time (from tomorrow's earliest fixed
    // commitment) — used for the "Wake up" block on tomorrowDateKey
    // (always), AND doubles as planningWakeUpTime below when
    // planningDateKey is tomorrowDateKey — tomorrow's own real wake
    // anchor, no second computation needed for that case.
    wakeUpTime,
    // TODAY's own already-configured wake/sleep times (Day Ring's
    // per-weekday dayRingSchedule, read client-side by TODAY's actual
    // weekday). todayBedtime is where tonight's Wind-down block ends —
    // ALWAYS today's, regardless of planningDateKey (see
    // buildDayPlanSystemPrompt's own comment). Defaults match the Day
    // Ring feature's own DAY_RING_DEFAULT_WAKE/_SLEEP if the client
    // omits either for any reason.
    todayWakeUpTime,
    todayBedtime: typeof body.todayBedtime === 'string' && HHMM_RE.test(body.todayBedtime) ? body.todayBedtime : '00:00',
    // The actual wake-time anchor for whichever day is being planned —
    // today's own (todayWakeUpTime) when planningDateKey is
    // todayDateKey, or tomorrow's already-computed wakeUpTime when
    // planning ahead. See buildDayPlanSystemPrompt's own header
    // comment on why this needed no separate "tomorrow's own wake
    // time" computation.
    planningWakeUpTime: planningDateKey === tomorrowDateKey ? wakeUpTime : todayWakeUpTime,
    activeRestrictions: restrictions,
  };
  const userActivities = sanitizeUserActivities(body.userActivities);
  context.userActivities = userActivities;
  const isRaceDay = body.isRaceDay === true;

  // Confirmed via the logged raw text: it came back as a literal empty
  // string, the same failure class as the earlier mode=today bug —
  // high-effort adaptive thinking (the API default when `effort` is
  // omitted, which this call was doing) consuming the entire max_tokens
  // budget before ever writing output text. callClaude() already finds
  // the actual type==="text" block rather than assuming content[0] (the
  // OTHER half of that earlier bug) — double-checked, that fix already
  // covers every caller in this file, so nothing to change there.
  //
  // Unlike handleToday's one-line recommendation, day-plan's own
  // reasoning is genuinely nontrivial (fitting up to ~9 blocks around
  // real fixed calendar events across two days with zero overlap,
  // exact wake/bed times, recovery-based adjustments, restrictions) —
  // dropping to effort:'low' the way handleToday did risks the model
  // skipping that reasoning and producing an overlapping/invalid
  // schedule. Per Anthropic's current effort guidance for claude-
  // sonnet-5 ("medium: cost-saving step-down from the default,
  // comparable to Sonnet 4.6 at high effort" — and their explicit
  // recommendation to set effort explicitly rather than rely on the
  // unpredictable default), this uses 'medium' instead: real reasoning
  // headroom without high effort's tendency to spend unboundedly. Paired
  // with a much larger max_tokens (thinking and the ~9-block JSON output
  // share the same budget), per Anthropic's own guidance to pair anything
  // above low effort with a large max_tokens ceiling.
  const text = await callClaude(apiKey, {
    system: isRaceDay ? buildRaceDaySystemPrompt(restrictions, userActivities) : buildDayPlanSystemPrompt(restrictions, userActivities),
    userContent: 'Context:\n' + JSON.stringify(context, null, 2),
    // Bumped from 4000: userActivities can add up to 10 more blocks
    // (or unplaced entries) on top of the original ~9, sharing the same
    // thinking+output budget at effort:'medium' — see the comment above
    // on why this mode needs a large ceiling in the first place.
    maxTokens: 6000,
    effort: 'medium',
  });
  const parsed = extractJson(text);
  if (!parsed) return res.status(502).json({ ok: false, error: 'Model did not return valid JSON.' });
  const blocks = normalizeDayPlanBlocks(parsed, todayDateKey, tomorrowDateKey, context.fixedEvents);
  if (!blocks.length) return res.status(502).json({ ok: false, error: 'Model did not return any usable blocks.' });
  const unplaced = reconcileUserActivities(blocks, sanitizeUnplaced(parsed && parsed.unplaced, userActivities), userActivities);

  return res.status(200).json({ ok: true, blocks, unplaced });
}

// ------------------------------------------------------------
// MODE: find-patterns
// ------------------------------------------------------------

// Generic sanitizer for the [{date, value}]-shaped series (score,
// habits, weight, nutrition.protein/calories, whoop.recovery/sleep) —
// same shape, same validation, reused across all of them rather than
// six near-identical copies. Caps at 200 entries (well above any
// realistic range trends.html's own 7/30/90-day tabs would ever send)
// as a defensive ceiling, not a real limit in practice. date must
// match YYYY-MM-DD (same DATE_RE convention api/sync-state.js already
// uses) — typeof 'string' alone would let a garbage date string
// through to the model as if it were a real one.
const FIND_PATTERNS_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function sanitizeDateValueSeries(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 200)
    .filter((e) => e && typeof e.date === 'string' && FIND_PATTERNS_DATE_RE.test(e.date) && typeof e.value === 'number' && isFinite(e.value))
    .map((e) => ({ date: e.date, value: Math.round(e.value * 100) / 100 }));
}
function sanitizeStrengthSeries(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 60)
    .filter((e) => e && typeof e.weekStart === 'string' && FIND_PATTERNS_DATE_RE.test(e.weekStart) && typeof e.sessions === 'number' && isFinite(e.sessions))
    .map((e) => ({ weekStart: e.weekStart, sessions: Math.max(0, Math.round(e.sessions)) }));
}
function sanitizeActivitySeries(raw, valueKey) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 200)
    .filter((e) => e && typeof e.date === 'string' && FIND_PATTERNS_DATE_RE.test(e.date) && typeof e[valueKey] === 'number' && isFinite(e[valueKey]))
    .map((e) => ({ date: e.date, [valueKey]: Math.round(e[valueKey] * 100) / 100 }));
}
// Pain/discomfort — habits.html's own nightly check-in (purely
// informational health tracking, never scored — see that page's own
// header comment on the reserved entries._pain key). find-patterns
// only, not weekly-review — this wasn't asked for there, and adding it
// unrequested to a second prompt is scope creep this file's own
// established discipline (see every other mode's own narrow, explicit
// inputs) argues against. area is free text capped at 40 chars (the
// client sends one of a fixed preset or a short "Other" description,
// but nothing here assumes which), severity is clamped to 1-5 — the
// client's own scale — rather than trusting whatever number arrives.
function sanitizePainSeries(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 200)
    .filter((e) => e && typeof e.date === 'string' && FIND_PATTERNS_DATE_RE.test(e.date) && typeof e.area === 'string' && e.area.trim())
    .map((e) => ({ date: e.date, area: e.area.trim().slice(0, 40), severity: Math.max(1, Math.min(5, Math.round(numOrNull(e.severity) || 1))) }));
}

// totalPoints across every domain — the honesty instructions below
// are calibrated against this, not just the date range, since a wide
// range with almost nothing actually logged is just as unreliable a
// basis for a "pattern" as a short one.
function buildFindPatternsSystemPrompt(days, totalPoints) {
  return (
    'You are analyzing one user\'s own historical health/fitness data from their personal dashboard (Row), ' +
    'covering the last ' + days + ' days, looking for GENUINE cross-domain correlations — patterns that ' +
    'span multiple different data sources (e.g. recovery vs. a habit, nutrition vs. training, weight vs. ' +
    'sleep) that no single source app (Cronometer, WHOOP) could ever see on its own, since each only has ' +
    'its own slice of this. This is exploratory analysis of the user\'s OWN real logged numbers, not general ' +
    'health advice — never suggest what they should do, only report what the data itself actually shows.\n\n' +
    'You will receive several series, each as a list of {date, value} (or {weekStart, sessions} for ' +
    'strength, {date, km}/{date, minPerKm} for activities, {date, area, severity 1-5} for pain/discomfort) — ' +
    'ONLY real logged points are included (no nulls/gaps), so a short list for a given domain means that ' +
    'domain simply doesn\'t have much real data in this range, not that you should fill in the blanks. ' +
    'pain is a genuinely different kind of signal from the rest — a day with NO entry in it is NOT "no pain ' +
    'confirmed", just nothing logged (the user only logs it when something\'s actually bothering them), so ' +
    'never treat its absence as evidence of anything; only ever reason from the pain days that ARE present, ' +
    'e.g. correlating them against training load/volume, WHOOP recovery, or which specific activity type was ' +
    'logged on/around that date — a real overuse-injury-relevant pattern here (e.g. "3 of your 4 logged knee ' +
    'pain days followed a long run the day before") is exactly the kind of cross-domain finding this feature ' +
    'exists for.\n\n' +
    'CRITICAL — DO NOT FABRICATE: only report a correlation you can point to SPECIFIC real numbers and ' +
    'dates for, from the data actually given to you. Every finding must cite at least one real number/date ' +
    'from the input (e.g. "your 3 highest-recovery days this range (82%, 79%, 77%) were all days you also ' +
    'hit your reading habit" — not "recovery tends to correlate with good habits"). If you cannot find a ' +
    'real correlation with enough supporting points to say something specific, DO NOT invent one to seem ' +
    'useful — say so plainly instead (e.g. "No clear cross-domain pattern stood out in this range" or ' +
    'naming which domains simply don\'t have enough logged data yet). A short, honest "nothing notable yet" ' +
    'response is the CORRECT output when that\'s what the data shows, not a failure.\n\n' +
    'SAMPLE SIZE HONESTY: this range has ' + totalPoints + ' total logged data points across every domain ' +
    'combined. Treat anything under roughly 10-14 points (under ~2 weeks of daily logging) as too little to ' +
    'draw a real conclusion from — say so explicitly rather than reporting a "pattern" built from 3-4 ' +
    'coincidental days. Even with more data, if a correlation is only weakly suggestive (a handful of ' +
    'overlapping days, not a clear repeated pattern), say that plainly (e.g. "a possible but weak link, only ' +
    '3 overlapping days") rather than presenting it with the same confidence as a strong one — never round a ' +
    'weak pattern up to sound more useful than it is.\n\n' +
    'Respond with ONLY this JSON shape, no markdown fences, no other text: ' +
    '{"findings": ["...", "..."]}. 1 to 6 findings. Each is a single plain-text sentence or two (no ' +
    'markdown, no emoji — the app adds its own icon), specific and grounded in the real data as described ' +
    'above. If the data genuinely shows nothing reliable, return exactly ONE finding saying so honestly — ' +
    'never pad with generic filler to reach a higher count.'
  );
}

function normalizeFindPatterns(raw) {
  if (!raw || !Array.isArray(raw.findings)) return [];
  return raw.findings
    .filter((f) => typeof f === 'string' && f.trim())
    .slice(0, 6)
    .map((f) => f.trim().slice(0, 500));
}

async function handleFindPatterns(req, res, apiKey, body) {
  const fromKey = typeof body.fromKey === 'string' ? body.fromKey.slice(0, 10) : '';
  const toKey = typeof body.toKey === 'string' ? body.toKey.slice(0, 10) : '';
  const days = Math.max(1, Math.min(3650, Math.round(numOrNull(body.days) || 30)));
  if (!fromKey || !toKey) return res.status(400).json({ ok: false, error: 'fromKey and toKey (YYYY-MM-DD) are required' });

  const nutrition = body.nutrition && typeof body.nutrition === 'object' ? body.nutrition : {};
  const whoop = body.whoop && typeof body.whoop === 'object' ? body.whoop : {};
  const activities = body.activities && typeof body.activities === 'object' ? body.activities : {};

  const context = {
    fromKey, toKey, days,
    score: sanitizeDateValueSeries(body.score),
    habits: sanitizeDateValueSeries(body.habits),
    weight: sanitizeDateValueSeries(body.weight),
    weightUnit: typeof body.weightUnit === 'string' ? body.weightUnit.slice(0, 10) : 'kg',
    nutrition: {
      protein: sanitizeDateValueSeries(nutrition.protein),
      calories: sanitizeDateValueSeries(nutrition.calories),
    },
    whoop: {
      recovery: sanitizeDateValueSeries(whoop.recovery),
      sleep: sanitizeDateValueSeries(whoop.sleep),
    },
    strength: sanitizeStrengthSeries(body.strength),
    activities: {
      distance: sanitizeActivitySeries(activities.distance, 'km'),
      pace: sanitizeActivitySeries(activities.pace, 'minPerKm'),
    },
    pain: sanitizePainSeries(body.pain),
  };

  const totalPoints = context.score.length + context.habits.length + context.weight.length
    + context.nutrition.protein.length + context.nutrition.calories.length
    + context.whoop.recovery.length + context.whoop.sleep.length
    + context.strength.reduce((s, w) => s + (w.sessions > 0 ? 1 : 0), 0)
    + context.activities.distance.length + context.activities.pace.length
    + context.pain.length;

  // This is genuinely open-ended cross-domain reasoning over up to ~10
  // series at once (not a single-field lookup like handleToday's), so
  // effort stays at the API default (omitted — see callClaude's own
  // comment on when that's the right call) rather than 'low', paired
  // with generous max_tokens for the same reason handleDayPlan uses
  // 'medium'+4000: real reasoning headroom, output that's still just a
  // few short strings.
  const text = await callClaude(apiKey, {
    system: buildFindPatternsSystemPrompt(days, totalPoints),
    userContent: 'Data:\n' + JSON.stringify(context, null, 2),
    maxTokens: 2000,
    effort: 'medium',
  });
  const parsed = extractJson(text);
  const findings = normalizeFindPatterns(parsed);
  if (!findings.length) return res.status(502).json({ ok: false, error: 'Model did not return any findings.' });

  return res.status(200).json({ ok: true, findings });
}

// ------------------------------------------------------------
// MODE: weekly-review
// ------------------------------------------------------------

// finance is a SNAPSHOT (net worth totals + subscription cost RIGHT
// NOW), not a week-over-week series — confirmed against finance.html's
// own buildFinanceSummary(), the exact compact shape it already syncs
// to api/sync-state.js for api/daily-checkin.js to read (no separate
// endpoint needed — trends.html reads the SAME app_state row directly
// via Supabase, same pattern topbar.js's own pushWaterMergedToSupabase
// already uses). No daily/weekly history exists for it anywhere in
// this app, so it's never treated as part of "this week" the way
// every other domain is — see buildWeeklyReviewSystemPrompt's own
// instructions on why.
function sanitizeFinanceSummary(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  if (!r.available) return { available: false };
  return {
    available: true,
    currency: typeof r.currency === 'string' ? r.currency.slice(0, 10) : null,
    netWorthTotal: typeof r.netWorthTotal === 'number' && isFinite(r.netWorthTotal) ? r.netWorthTotal : null,
    subscriptionsCount: typeof r.subscriptionsCount === 'number' && isFinite(r.subscriptionsCount) ? Math.round(r.subscriptionsCount) : null,
    subscriptionsMonthlyTotal: typeof r.subscriptionsMonthlyTotal === 'number' && isFinite(r.subscriptionsMonthlyTotal) ? r.subscriptionsMonthlyTotal : null,
    // Freshness matters more here than for the daily series above —
    // a snapshot synced weeks ago presented as "your finances" without
    // any caveat would be misleading in a way a missing daily point
    // isn't (that just shows as absent from a series; a stale
    // snapshot looks exactly like a current one unless labeled).
    daysStale: typeof r.daysStale === 'number' && isFinite(r.daysStale) ? Math.round(r.daysStale) : null,
  };
}

function buildWeeklyReviewSystemPrompt(fromKey, toKey, totalPoints) {
  return (
    'You are writing a holistic WEEKLY REVIEW for one user\'s personal dashboard (Row), covering ' + fromKey +
    ' through ' + toKey + ' (the most recent 7 days) — a general "how was my week" recap across EVERY domain ' +
    'at once (score, habits, weight, nutrition, WHOOP, strength, activities, and finance if available), not a ' +
    'search for cross-domain correlations (that\'s a separate feature) and not a check-in on one specific ' +
    'goal (that\'s a separate feature too) — just an honest, specific recap of this one week.\n\n' +
    'You will receive the same {date, value}-shaped series described for a cross-domain analysis (only real ' +
    'logged points, no nulls/gaps) — a short or empty list for a domain means that domain simply has little ' +
    'or no real data this week, not that you should invent some. finance, if present, is a CURRENT SNAPSHOT ' +
    '(net worth / subscriptions RIGHT NOW, not this week\'s change) — mention it as background context at ' +
    'most (e.g. current net worth, subscription cost), NEVER as if it were something that happened or ' +
    'changed "this week", and skip it entirely if finance.available is false or daysStale suggests it\'s old.\n\n' +
    'CRITICAL — GROUNDED, NOT GENERIC: every observation must cite a specific real number from the data given ' +
    '(e.g. "you hit 3 of 3 planned strength sessions and your recovery held above 65% all week" — not "great ' +
    'job staying consistent!"). This is one week of data (' + totalPoints + ' total logged points across every ' +
    'domain combined) — far too little to call anything an established trend or pattern; describe THIS WEEK ' +
    'specifically ("this week your protein averaged X%") rather than implying it repeats. Report what actually ' +
    'went well AND what didn\'t, honestly — do not manufacture positivity for a rough week, and do not ' +
    'manufacture criticism for a good one; say plainly when a domain has too little data this week to say ' +
    'anything about it at all, rather than filling space.\n\n' +
    'Respond with ONLY this JSON shape, no markdown fences, no other text: {"summary": "...", "highlights": ' +
    '["...", "..."]}. summary is 2-3 plain-text sentences giving the overall shape of the week (the honest ' +
    'mix of good/bad, or an honest "not much was logged this week" if that\'s the reality). highlights is 2 to ' +
    '3 short, specific, number-grounded observations (one sentence each, no markdown, no emoji — the app adds ' +
    'its own icon). If there is genuinely almost nothing logged this week, it is fine (and required) for ' +
    'summary to say so plainly and for highlights to be shorter or note that directly, rather than padding ' +
    'with generic filler.'
  );
}

function normalizeWeeklyReview(raw) {
  if (!raw || typeof raw.summary !== 'string' || !raw.summary.trim()) return null;
  const highlights = Array.isArray(raw.highlights)
    ? raw.highlights.filter((h) => typeof h === 'string' && h.trim()).slice(0, 4).map((h) => h.trim().slice(0, 400))
    : [];
  return { summary: raw.summary.trim().slice(0, 800), highlights };
}

async function handleWeeklyReview(req, res, apiKey, body) {
  const fromKey = typeof body.fromKey === 'string' ? body.fromKey.slice(0, 10) : '';
  const toKey = typeof body.toKey === 'string' ? body.toKey.slice(0, 10) : '';
  if (!fromKey || !toKey) return res.status(400).json({ ok: false, error: 'fromKey and toKey (YYYY-MM-DD) are required' });

  const nutrition = body.nutrition && typeof body.nutrition === 'object' ? body.nutrition : {};
  const whoop = body.whoop && typeof body.whoop === 'object' ? body.whoop : {};
  const activities = body.activities && typeof body.activities === 'object' ? body.activities : {};

  const context = {
    fromKey, toKey,
    score: sanitizeDateValueSeries(body.score),
    habits: sanitizeDateValueSeries(body.habits),
    weight: sanitizeDateValueSeries(body.weight),
    weightUnit: typeof body.weightUnit === 'string' ? body.weightUnit.slice(0, 10) : 'kg',
    nutrition: {
      protein: sanitizeDateValueSeries(nutrition.protein),
      calories: sanitizeDateValueSeries(nutrition.calories),
    },
    whoop: {
      recovery: sanitizeDateValueSeries(whoop.recovery),
      sleep: sanitizeDateValueSeries(whoop.sleep),
    },
    strength: sanitizeStrengthSeries(body.strength),
    activities: {
      distance: sanitizeActivitySeries(activities.distance, 'km'),
      pace: sanitizeActivitySeries(activities.pace, 'minPerKm'),
    },
    finance: sanitizeFinanceSummary(body.finance),
  };

  const totalPoints = context.score.length + context.habits.length + context.weight.length
    + context.nutrition.protein.length + context.nutrition.calories.length
    + context.whoop.recovery.length + context.whoop.sleep.length
    + context.strength.reduce((s, w) => s + (w.sessions > 0 ? 1 : 0), 0)
    + context.activities.distance.length + context.activities.pace.length;

  // Same reasoning as find-patterns' own comment: real cross-domain
  // synthesis over up to ~9 series, not a single-field lookup, so
  // effort stays at the API default rather than 'low'. maxTokens
  // smaller than find-patterns' 2000 — this output is one short
  // paragraph plus 2-4 one-line highlights, a genuinely smaller shape
  // — but still with real margin above that, not sized to the bare
  // minimum (see the mode=plan truncation bug this file already hit
  // from doing exactly that).
  const text = await callClaude(apiKey, {
    system: buildWeeklyReviewSystemPrompt(fromKey, toKey, totalPoints),
    userContent: 'Data:\n' + JSON.stringify(context, null, 2),
    maxTokens: 1200,
    effort: 'medium',
  });
  const parsed = extractJson(text);
  const review = normalizeWeeklyReview(parsed);
  if (!review) return res.status(502).json({ ok: false, error: 'Model did not return a valid review.' });

  return res.status(200).json({ ok: true, fromKey, toKey, summary: review.summary, highlights: review.highlights });
}

// ------------------------------------------------------------

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method not allowed' });
  if (!checkAuth(req, res)) return;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ ok: false, error: 'Server not configured (missing ANTHROPIC_API_KEY env var).' });

  const mode = req.query && req.query.mode;
  if (mode !== 'plan' && mode !== 'today' && mode !== 'day-plan' && mode !== 'find-patterns' && mode !== 'weekly-review') {
    return res.status(400).json({ ok: false, error: 'mode must be "plan", "today", "day-plan", "find-patterns", or "weekly-review"' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  if (!body || typeof body !== 'object') body = {};
  if (JSON.stringify(body).length > MAX_BODY_CHARS) {
    return res.status(400).json({ ok: false, error: 'request body too large — this endpoint expects a summarized history, not raw logs' });
  }

  try {
    if (mode === 'plan') return await handlePlan(req, res, apiKey, body);
    if (mode === 'day-plan') return await handleDayPlan(req, res, apiKey, body);
    if (mode === 'find-patterns') return await handleFindPatterns(req, res, apiKey, body);
    if (mode === 'weekly-review') return await handleWeeklyReview(req, res, apiKey, body);
    return await handleToday(req, res, apiKey, body);
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Unexpected error: ' + (e && e.message) });
  }
}
