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
  strength: /\b(push|pull|legs|strength|upper[- ]?body|lower[- ]?body|full[- ]?body)\b/i,
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

function buildPlanSystemPrompt(restrictions, recommendableTypes, activeWeekDisciplines) {
  const typesList = recommendableTypes.length
    ? JSON.stringify(recommendableTypes.map((t) => ({ id: t.id, name: t.name, unit: t.unit, unitKind: t.unitKind })), null, 2)
    : null;
  return (
    (activeWeekDisciplines
      ? 'THIS WEEK\'S VOLUME TARGETS ARE ALREADY FIXED — ' + describeActiveWeekDisciplinesForPrompt(activeWeekDisciplines, recommendableTypes) + '. These come from the user\'s own long-term training plan, not from you, and the server computes the real numbers in code from that plan — it will IGNORE whatever longSession.targetAmount/easyVolume.targetAmount/strength.targetSessions numbers you write for the disciplines listed above. Do NOT invent different volume numbers for them. Your job here is only: (1) still propose ONE concrete interval/VO2-max session (activityTypeId from the recommendable list below, matching whichever of run/bike makes sense, or null if neither does) with real structure — the fixed targets above have no interval/intensity piece of their own; (2) write a one-sentence, concrete description for cardio.longSession and cardio.easyVolume (effort/pacing guidance for the run/bike volume above) and for strength.focus; (3) mention the swim target explicitly in the rationale even though it has no legacy slot of its own to sit in. Never contradict these fixed numbers anywhere in your rationale or descriptions.\n\n'
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
function deriveLegacyCardioFromTargets(targets, modelCardio) {
  const distanceDisciplines = ['run', 'bike'].filter((d) => targets[d] && targets[d].km > 0 && targets[d].activityTypeId);
  function volumeSlotFor(disc, modelSlot) {
    if (!disc) return { activityTypeId: null, activityName: '', targetAmount: 0, unit: '', description: '' };
    const t = targets[disc];
    return {
      activityTypeId: t.activityTypeId,
      activityName: t.activityName,
      targetAmount: t.km,
      unit: 'km',
      description: (modelSlot && typeof modelSlot.description === 'string') ? modelSlot.description.slice(0, 300) : '',
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
    parts.push('swim: ' + swim.sessions + ' sessions' + (swim.meters ? ' (~' + swim.meters + 'm total)' : '') + (type ? ' (' + type.name + ')' : ' — no matching recommendable activity type, will be zeroed'));
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
    out.strength = { neededMin: Math.max(0, num(raw.strength.neededMin, 0)), availableMin: Math.max(0, num(raw.strength.availableMin, 0)) };
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
    const metersPerSession = out.swim.sessions ? out.swim.meters / out.swim.sessions : 0;
    const floor = swimCap.swimAllowedDaysCount >= 2 ? 2 : 0;
    const originalSessions = out.swim.sessions;
    let estMin = out.swim.sessions * (metersPerSession / 100) * swimCap.paceMinPer100m;
    while (swimCap.availableMin != null && estMin > swimCap.availableMin && out.swim.sessions > floor) {
      out.swim.sessions -= 1;
      estMin = out.swim.sessions * (metersPerSession / 100) * swimCap.paceMinPer100m;
    }
    if (out.swim.sessions < originalSessions) {
      out.swim.meters = Math.round(out.swim.sessions * metersPerSession);
      notes.push('swim ' + originalSessions + ' -> ' + out.swim.sessions + ' sessions');
    }
  }
  const strengthCap = capacity.perDiscipline.strength;
  if (strengthCap && out.strength && out.strength.sessions) {
    const perSessionMin = 45;
    const originalSessions = out.strength.sessions;
    while (strengthCap.availableMin != null && out.strength.sessions * perSessionMin > strengthCap.availableMin && out.strength.sessions > 0) {
      out.strength.sessions -= 1;
    }
    if (out.strength.sessions < originalSessions) notes.push('strength ' + originalSessions + ' -> ' + out.strength.sessions + ' sessions');
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

function buildSessionsToPlace(targets, capacity) {
  const sessions = [];
  const perDiscipline = (capacity && capacity.configured) ? capacity.perDiscipline : {};
  ['run', 'bike'].forEach((disc) => {
    const t = targets[disc];
    if (!t || !t.km || !t.activityTypeId) return;
    const pace = (perDiscipline[disc] && perDiscipline[disc].paceMinPerKm) || 6;
    const longKm = Math.round(t.km * 0.6 * 10) / 10;
    const easyKm = Math.round((t.km - longKm) * 10) / 10;
    sessions.push({ id: disc + '-long', discipline: disc, kind: 'long', activityTypeId: t.activityTypeId, activityName: t.activityName, targetAmount: longKm, unit: 'km', estMinutes: Math.round(longKm * pace), hard: true });
    if (easyKm >= 1) sessions.push({ id: disc + '-easy', discipline: disc, kind: 'easy', activityTypeId: t.activityTypeId, activityName: t.activityName, targetAmount: easyKm, unit: 'km', estMinutes: Math.round(easyKm * pace), hard: false });
  });
  if (targets.swim && targets.swim.sessions > 0 && targets.swim.activityTypeId) {
    const pace = (perDiscipline.swim && perDiscipline.swim.paceMinPer100m) || 2.5;
    const metersPerSession = Math.round((Number(targets.swim.meters) || 0) / targets.swim.sessions);
    const est = Math.round((metersPerSession / 100) * pace);
    for (let i = 0; i < targets.swim.sessions; i++) {
      sessions.push({ id: 'swim-' + i, discipline: 'swim', kind: 'session', activityTypeId: targets.swim.activityTypeId, activityName: targets.swim.activityName, targetAmount: metersPerSession, unit: 'm', estMinutes: est, hard: false });
    }
  }
  if (targets.strength && targets.strength.sessions > 0) {
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
function buildUnplaceableSeed(targets, capacity) {
  const seed = [];
  if (!capacity || !capacity.configured || !capacity.perDay.length) return seed;
  ['run', 'bike', 'swim', 'strength'].forEach((disc) => {
    const t = targets[disc];
    const hasTarget = (disc === 'swim' || disc === 'strength') ? (t && t.sessions > 0) : (t && t.km > 0);
    if (!hasTarget) return;
    const anyDayAllows = capacity.perDay.some((d) => d.allowedDisciplines[disc] !== false);
    if (!anyDayAllows) seed.push({ id: disc, reason: 'No day this week allows ' + disc + '.' });
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
    const day = dayByDate[a.dateKey];
    if (!session || !day) return;
    if (day.allowedDisciplines[session.discipline] === false) {
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
      if (adjacent) {
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

function normalizePlan(raw, restrictions, recommendableTypes, activeWeekDisciplines, capacity) {
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
  if (targets && capacity && capacity.configured && capacity.perDay.length) {
    const sessionsToPlace = buildSessionsToPlace(targets, capacity);
    const unplaceableSeed = buildUnplaceableSeed(targets, capacity);
    const placeableSessions = sessionsToPlace.filter((s) => !unplaceableSeed.some((u) => u.id === s.discipline));
    const assignments = sanitizeAssignments(r.assignments, placeableSessions, capacity.perDay);
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
    rationale: typeof r.rationale === 'string' ? r.rationale.slice(0, 600) : '',
  };
}

async function handlePlan(req, res, apiKey, body) {
  const restrictions = sanitizeRestrictions(body.restrictions);
  const recommendableTypes = sanitizeActivityTypes(body.recommendableActivityTypes);
  // Phase 3.1 — see this mode's own doc comment for the field's shape
  // and sanitizeActiveWeekDisciplines's own comment for why null (not
  // {}) means "nothing to do here, behave exactly as before".
  const activeWeekDisciplines = sanitizeActiveWeekDisciplines(body.activeWeekDisciplines);
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
  const sessionsToPlace = preTargets ? buildSessionsToPlace(preTargets, capacity) : [];
  const unplaceableSeed = preTargets ? buildUnplaceableSeed(preTargets, capacity) : [];
  const placeableSessions = sessionsToPlace.filter((s) => !unplaceableSeed.some((u) => u.id === s.discipline));

  const context = {
    recentStrengthSessions: Array.isArray(body.strengthSessions) ? body.strengthSessions.slice(0, 30) : [],
    recentExerciseNames: Array.isArray(body.recentExerciseNames) ? body.recentExerciseNames.slice(0, 30) : [],
    recentActivitySessions: Array.isArray(body.activitySessions) ? body.activitySessions.slice(0, 40) : [],
    whoop: body.whoop && typeof body.whoop === 'object' ? body.whoop : null,
    activeRestrictions: restrictions,
    activeWeekDisciplines,
  };

  const text = await callClaude(apiKey, {
    system: buildPlanSystemPrompt(restrictions, recommendableTypes, activeWeekDisciplines)
      + buildCapacityPromptSection(capacity, preTrimNote)
      + buildLayoutPromptSection(placeableSessions, capacity),
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
    debugLabel: 'plan', // TEMPORARY — see callClaude's own comment on this
  });
  const parsed = extractJson(text);
  if (!parsed) return res.status(502).json({ ok: false, error: 'Model did not return valid JSON.' });

  return res.status(200).json({ ok: true, plan: normalizePlan(parsed, restrictions, recommendableTypes, activeWeekDisciplines, capacity) });
}

// ------------------------------------------------------------
// MODE: today
// ------------------------------------------------------------

function buildTodaySystemPrompt(restrictions, feasibility) {
  return (
    'You recommend today\'s training on a personal dashboard. This week\'s plan (weekPlan) always covers ' +
    'BOTH strength and cardio — evaluate the two independently, then combine whichever pieces are ' +
    'actually outstanding and appropriate today into ONE recommendation (e.g. "Push + Cycling interval"). ' +
    'It is normal and expected for the answer to include both — do not default to naming only strength; ' +
    'check cardio\'s status with the same weight every time.\n\n' +
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
    'was last generated, so this is a live, independent check, not just trusting weekPlan\'s own numbers.\n\n' +
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
function buildTomorrowSystemPrompt(restrictions, feasibility) {
  return (
    'You recommend training for a day OTHER than today on a personal dashboard — main.html\'s "Plan my day" ' +
    'is being generated ahead of time for tomorrow. This week\'s plan (weekPlan) always covers BOTH strength ' +
    'and cardio — evaluate the two independently, then combine whichever pieces are actually outstanding and ' +
    'appropriate for that day into ONE recommendation (e.g. "Push + Cycling interval"). It is normal and ' +
    'expected for the answer to include both — do not default to naming only strength; check cardio\'s ' +
    'status with the same weight every time.\n\n' +
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
    'CARDIO (Phase 3 of the multi-activity-type generalization — no longer always running) — weekPlan.cardio ' +
    'has three pieces, each already assigned its OWN activity by name when the weekly plan was generated: ' +
    'interval, longSession, and easyVolume. Different pieces can be different activities (e.g. interval on ' +
    'Cycling, easyVolume on Swimming) — always recommend by whatever activityName that specific piece ' +
    'actually carries, never assume or default to "running". A piece with a zero/empty target has NOTHING to ' +
    'recommend — skip it, never invent a replacement. progress.activitiesThisWeek lists what has ACTUALLY ' +
    'been logged since Monday (through today) — match against each piece\'s activityTypeId to judge which ' +
    'piece(s) are still outstanding and worth recommending for that day.\n\n' +
    'Even if weekPlan.cardio shows a nonzero target for a piece, do NOT recommend it if that piece\'s ' +
    'activityTypeId or activityName matches an entry in activeRestrictions below.\n\n' +
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
  const restrictions = sanitizeRestrictions(body.restrictions);
  const forTomorrow = !!body.forTomorrow;
  const context = {
    weekPlan: body.weekPlan && typeof body.weekPlan === 'object' ? body.weekPlan : null,
    progress: body.progress && typeof body.progress === 'object' ? body.progress : null,
    strengthContext: body.strengthContext && typeof body.strengthContext === 'object' ? body.strengthContext : null,
    whoopToday: body.whoopToday && typeof body.whoopToday === 'object' ? body.whoopToday : null,
    whoopRecentStrain: Array.isArray(body.whoopRecentStrain) ? body.whoopRecentStrain.slice(0, 14) : null,
    activeRestrictions: restrictions,
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
    system: forTomorrow ? buildTomorrowSystemPrompt(restrictions, context.feasibility) : buildTodaySystemPrompt(restrictions, context.feasibility),
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
