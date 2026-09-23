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
//   }
//   -> { ok: true, plan: {
//     strength: { targetSessions: Number, focus: String },
//     cardio: {
//       interval:    { activityTypeId: String|null, activityName: String, targetSessions: Number, targetMinutes: Number, description: String },
//       longSession: { activityTypeId: String|null, activityName: String, targetAmount: Number, unit: String, description: String },
//       easyVolume:  { activityTypeId: String|null, activityName: String, targetAmount: Number, unit: String, description: String },
//     },
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
//   }
//   -> { ok: true, blocks: [{ date, start, end, title, category }] }
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

function buildPlanSystemPrompt(restrictions, recommendableTypes) {
  const typesList = recommendableTypes.length
    ? JSON.stringify(recommendableTypes.map((t) => ({ id: t.id, name: t.name, unit: t.unit, unitKind: t.unitKind })), null, 2)
    : null;
  return (
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
    }, null, 2) +
    '\n\nEvery number must be concrete (sessions, distance/count amount, or minutes) — never vague advice ' +
    'like "do more cardio". If recent history is thin or empty, use sensible conservative defaults for ' +
    'someone building both VO2 max and aerobic capacity, and say so in the rationale.'
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

function normalizePlan(raw, restrictions, recommendableTypes) {
  const restricted = restrictedScopeSet(restrictions);
  const types = Array.isArray(recommendableTypes) ? recommendableTypes : [];
  const r = raw || {};
  const strength = r.strength || {};
  const cardio = r.cardio || {};
  // Strength side is completely untouched by this generalization — same
  // hard-override-to-0 enforcement as before.
  const strengthRestricted = restricted.has('strength');
  return {
    strength: {
      targetSessions: strengthRestricted ? 0 : Math.max(1, Math.round(num(strength.targetSessions, 3))),
      focus: typeof strength.focus === 'string' ? strength.focus.slice(0, 200) : '',
    },
    cardio: {
      interval: normalizeCardioInterval(cardio.interval, types, restricted),
      longSession: normalizeCardioVolume(cardio.longSession, types, restricted, 8),
      easyVolume: normalizeCardioVolume(cardio.easyVolume, types, restricted, 10),
    },
    rationale: typeof r.rationale === 'string' ? r.rationale.slice(0, 600) : '',
  };
}

async function handlePlan(req, res, apiKey, body) {
  const restrictions = sanitizeRestrictions(body.restrictions);
  const recommendableTypes = sanitizeActivityTypes(body.recommendableActivityTypes);
  const context = {
    recentStrengthSessions: Array.isArray(body.strengthSessions) ? body.strengthSessions.slice(0, 30) : [],
    recentExerciseNames: Array.isArray(body.recentExerciseNames) ? body.recentExerciseNames.slice(0, 30) : [],
    recentActivitySessions: Array.isArray(body.activitySessions) ? body.activitySessions.slice(0, 40) : [],
    whoop: body.whoop && typeof body.whoop === 'object' ? body.whoop : null,
    activeRestrictions: restrictions,
  };

  const text = await callClaude(apiKey, {
    system: buildPlanSystemPrompt(restrictions, recommendableTypes),
    userContent: 'Recent history:\n' + JSON.stringify(context, null, 2),
    // Confirmed via the [plan debug] log (not assumed): stop_reason
    // was 'max_tokens' with 327 of the 800-token budget spent on
    // thinking alone, and the remaining ~470 tokens weren't enough to
    // finish strength + all 3 cardio slots (each with its own
    // activityTypeId/activityName/amount/unit/description) + rationale
    // — the raw text was cut off mid-word. 800 was sized for this
    // output's shape from before activity types/restrictions/cardio-
    // slot logic were added; it never got re-sized as that output grew.
    // 2000 matches how day-plan (4000, ~9 blocks) and find-patterns
    // (2000) were each sized to their own actual output, with real
    // margin above the truncated example's own ~800-tokens-and-still-
    // incomplete size, not a shared generic default.
    maxTokens: 2000,
    debugLabel: 'plan', // TEMPORARY — see callClaude's own comment on this
  });
  const parsed = extractJson(text);
  if (!parsed) return res.status(502).json({ ok: false, error: 'Model did not return valid JSON.' });

  return res.status(200).json({ ok: true, plan: normalizePlan(parsed, restrictions, recommendableTypes) });
}

// ------------------------------------------------------------
// MODE: today
// ------------------------------------------------------------

function buildTodaySystemPrompt(restrictions) {
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
    'strength anyway if the weekly target is meaningfully behind and recovery allows it, keeping that ' +
    'framing to a couple trailing words at most (e.g. "Push anyway"). If strengthContext itself is ' +
    'missing or todaySplitDay is null, no split is configured — say that plainly rather than guessing.\n\n' +
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
function buildTomorrowSystemPrompt(restrictions) {
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
    'include strength anyway if the weekly target is meaningfully behind, keeping that framing to a couple ' +
    'trailing words at most (e.g. "Push anyway"). If strengthContext itself is missing or todaySplitDay is ' +
    'null, no split is configured — say that plainly rather than guessing.\n\n' +
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
  } else {
    context.todayCalendar = body.todayCalendar && typeof body.todayCalendar === 'object'
      ? { padelToday: !!body.todayCalendar.padelToday, padelEventTitle: typeof body.todayCalendar.padelEventTitle === 'string' ? body.todayCalendar.padelEventTitle.slice(0, 200) : null }
      : null;
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
    system: forTomorrow ? buildTomorrowSystemPrompt(restrictions) : buildTodaySystemPrompt(restrictions),
    userContent: 'Context:\n' + JSON.stringify(context, null, 2),
    maxTokens: 800,
    effort: 'low',
  });
  const parsed = extractJson(text);
  const recommendation = parsed && typeof parsed.recommendation === 'string' ? parsed.recommendation.trim() : '';
  if (!recommendation) return res.status(502).json({ ok: false, error: 'Model did not return valid JSON.' });

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
function buildDayPlanSystemPrompt(restrictions) {
  return (
    'You are planning ONE user\'s day on a personal dashboard, producing a concrete schedule of time ' +
    'blocks that will be created as real Google Calendar events only after the user reviews and explicitly ' +
    'confirms them — nothing is created automatically, so propose a genuinely usable, non-overlapping plan. ' +
    'planningDateKey tells you which day (todayDateKey or tomorrowDateKey) the main schedule below actually ' +
    'goes on — it may be either one.\n\n' +
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
    '"already passed" constraint at all (only the Wake up block\'s own timing still applies).\n\n' +
    'WHAT YOU DECIDE — fit these into whatever open time remains around the fixed items above, on ' +
    'planningDateKey:\n' +
    '1. Training session — planningRecommendation is the exact, already-decided session for planningDateKey ' +
    '(already accounts for whatever is actually known/relevant for that day — do not re-evaluate or change ' +
    'WHAT it says, just place it once, in a sensible open slot). If planningRecommendation is null, skip the ' +
    'training block entirely rather than inventing one.\n' +
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
    buildRestrictionsPromptSection(restrictions) +
    'Reply with ONLY valid JSON, no markdown fences, no commentary, in exactly this shape:\n' +
    JSON.stringify({
      blocks: [
        {
          date: 'YYYY-MM-DD (must be todayDateKey or tomorrowDateKey, whichever the block actually falls on)',
          start: 'HH:MM 24-hour',
          end: 'HH:MM 24-hour',
          title: 'short, e.g. "Training: Push + 5K run", "Wake up", "Breakfast", "Walk", "Wind-down"',
          category: 'one of: sleep, training, work, meal, walk',
        },
      ],
    }, null, 2) +
    '\n\nEvery block\'s start must be strictly before its end, blocks must not overlap each other or any ' +
    'fixedEvents entry, and the list should be in chronological order.'
  );
}

function numOrNull(v) {
  const n = Number(v);
  return isNaN(n) ? null : n;
}

const DAY_PLAN_CATEGORIES = ['sleep', 'training', 'work', 'meal', 'walk'];
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

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
    system: buildDayPlanSystemPrompt(restrictions),
    userContent: 'Context:\n' + JSON.stringify(context, null, 2),
    maxTokens: 4000,
    effort: 'medium',
  });
  const parsed = extractJson(text);
  if (!parsed) return res.status(502).json({ ok: false, error: 'Model did not return valid JSON.' });
  const blocks = normalizeDayPlanBlocks(parsed, todayDateKey, tomorrowDateKey, context.fixedEvents);
  if (!blocks.length) return res.status(502).json({ ok: false, error: 'Model did not return any usable blocks.' });

  return res.status(200).json({ ok: true, blocks });
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
    'strength, {date, km}/{date, minPerKm} for activities) — ONLY real logged points are included (no ' +
    'nulls/gaps), so a short list for a given domain means that domain simply doesn\'t have much real data ' +
    'in this range, not that you should fill in the blanks.\n\n' +
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
  };

  const totalPoints = context.score.length + context.habits.length + context.weight.length
    + context.nutrition.protein.length + context.nutrition.calories.length
    + context.whoop.recovery.length + context.whoop.sleep.length
    + context.strength.reduce((s, w) => s + (w.sessions > 0 ? 1 : 0), 0)
    + context.activities.distance.length + context.activities.pace.length;

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
