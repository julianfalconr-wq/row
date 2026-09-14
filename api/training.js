// =============================================================
// Combined endpoint for gym.html's Training page AI features, plus
// main.html's "Plan my day" feature (mode=day-plan, added later —
// same file for the same reason). Three modes, one file — same
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
//   }
//   -> { ok: true, recommendation: String }
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
//     todayRecommendation: String | null,   // gym.html's cached mode=today result (Phase 1, padel-aware) — reused verbatim, NOT recomputed here
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
async function callClaude(apiKey, { system, userContent, maxTokens, effort }) {
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
    maxTokens: 800,
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

async function handleToday(req, res, apiKey, body) {
  const restrictions = sanitizeRestrictions(body.restrictions);
  const context = {
    weekPlan: body.weekPlan && typeof body.weekPlan === 'object' ? body.weekPlan : null,
    progress: body.progress && typeof body.progress === 'object' ? body.progress : null,
    strengthContext: body.strengthContext && typeof body.strengthContext === 'object' ? body.strengthContext : null,
    whoopToday: body.whoopToday && typeof body.whoopToday === 'object' ? body.whoopToday : null,
    whoopRecentStrain: Array.isArray(body.whoopRecentStrain) ? body.whoopRecentStrain.slice(0, 14) : null,
    todayCalendar: body.todayCalendar && typeof body.todayCalendar === 'object'
      ? { padelToday: !!body.todayCalendar.padelToday, padelEventTitle: typeof body.todayCalendar.padelEventTitle === 'string' ? body.todayCalendar.padelEventTitle.slice(0, 200) : null }
      : null,
    activeRestrictions: restrictions,
  };

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
    system: buildTodaySystemPrompt(restrictions),
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

function buildDayPlanSystemPrompt(restrictions) {
  return (
    'You are planning ONE user\'s day on a personal dashboard, producing a concrete schedule of time ' +
    'blocks that will be created as real Google Calendar events only after the user reviews and explicitly ' +
    'confirms them — nothing is created automatically, so propose a genuinely usable, non-overlapping plan.\n\n' +
    'FIXED, NON-NEGOTIABLE — never overlap these, and never move or omit them:\n' +
    '- fixedEvents: the user\'s ACTUAL existing calendar events for today and tomorrow (meetings, padel, ' +
    'appointments, etc. — already-booked real time). Every block you propose must fit strictly around these.\n' +
    '- wakeUpTime is already computed (the earlier of tomorrow\'s configured wake time and a buffer before ' +
    'tomorrow\'s earliest fixed commitment) — do NOT recalculate it yourself. Output a short "Wake up" ' +
    'block on tomorrowDateKey starting at wakeUpTime, and never schedule anything else on tomorrowDateKey ' +
    'before it.\n' +
    '- todayBedtime is today\'s already-configured sleep time (do NOT recalculate it) — output a ' +
    '"Wind-down" block on todayDateKey ending exactly at todayBedtime, using the exact given time, and ' +
    'never schedule anything else on todayDateKey after it.\n' +
    '- nowTime is the actual current wall-clock time this plan is being generated at, "HH:MM". EVERY block ' +
    'you propose on todayDateKey must start at or after nowTime — never propose a start time on todayDateKey ' +
    'that has already passed, even for a normally-morning item. If a default item like breakfast would only ' +
    'make sense before nowTime, use your judgment: shift it to a later, still-sensible slot and rename it if ' +
    'the new time no longer fits the original name (e.g. "Brunch" instead of "Breakfast" if nowTime is ' +
    'already midday), or omit it entirely if no reasonable later slot makes sense — but never output a ' +
    'todayDateKey block starting before nowTime. tomorrowDateKey blocks (the Wake up block) are unaffected ' +
    'by nowTime.\n\n' +
    'WHAT YOU DECIDE — fit these into whatever open time remains around the fixed items above, on ' +
    'todayDateKey unless noted:\n' +
    '1. Today\'s training session — todayRecommendation is the exact, already-decided session (it already ' +
    'accounts for WHOOP recovery and any padel commitment today — do not re-evaluate or change WHAT it ' +
    'says, just place it once, in a sensible open slot). If todayRecommendation is null, skip the training ' +
    'block entirely rather than inventing one.\n' +
    '2. One focused productivity/work block — a reasonable default length (about 1 hour) since no specific ' +
    'preference is configured.\n' +
    '3. Three generic meal blocks — "Breakfast", "Lunch", "Dinner" only, no recipes or macros — at ' +
    'reasonable times relative to todayWakeUpTime (today\'s already-configured wake time — do NOT ' +
    'recalculate it, just use it as the anchor for how early breakfast may start), the fixed events, and ' +
    'each other (breakfast shortly after todayWakeUpTime, lunch around midday, dinner in the evening; ' +
    'several hours apart; never overlapping the training block or a fixed event) — subject always to the ' +
    'nowTime rule above, which can override todayWakeUpTime\'s placement (e.g. skip or rename breakfast, per ' +
    'that rule, rather than starting it before nowTime).\n' +
    '4. A short post-meal walk (10-15 minutes) shortly after each of the three meal blocks (or after however ' +
    'many of them survive the nowTime rule above).\n\n' +
    'If whoopToday shows low recovery (recoveryPct below 34), keep the rest of the day light — do not add ' +
    'anything beyond the items above, and lean toward the shorter end of the work block\'s duration; the ' +
    'training recommendation itself is already adjusted for recovery, so do not second-guess it further ' +
    'here.\n\n' +
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
  const context = {
    todayDateKey,
    tomorrowDateKey,
    nowTime,
    todayRecommendation: typeof body.todayRecommendation === 'string' ? body.todayRecommendation.slice(0, 300) : null,
    whoopToday: body.whoopToday && typeof body.whoopToday === 'object' ? { recoveryPct: numOrNull(body.whoopToday.recoveryPct) } : null,
    fixedEvents: Array.isArray(body.fixedEvents) ? body.fixedEvents.slice(0, 40).map((e) => ({
      date: typeof (e && e.date) === 'string' ? e.date.slice(0, 10) : '',
      start: typeof (e && e.start) === 'string' ? e.start.slice(0, 5) : '',
      end: typeof (e && e.end) === 'string' ? e.end.slice(0, 5) : '',
      title: typeof (e && e.title) === 'string' ? e.title.slice(0, 200) : '',
      allDay: !!(e && e.allDay),
    })) : [],
    // TOMORROW's inferred wake time (from tomorrow's earliest fixed
    // commitment) — used only for the "Wake up" block on
    // tomorrowDateKey. Do not confuse with todayWakeUpTime/todayBedtime
    // below, both about TODAY's own configured schedule instead.
    wakeUpTime: typeof body.wakeUpTime === 'string' && HHMM_RE.test(body.wakeUpTime) ? body.wakeUpTime : '07:00',
    // TODAY's own already-configured wake/sleep times (Day Ring's
    // per-weekday dayRingSchedule, read client-side by TODAY's actual
    // weekday). todayWakeUpTime anchors how early breakfast may start;
    // todayBedtime is where tonight's Wind-down block ends. Defaults
    // match the Day Ring feature's own DAY_RING_DEFAULT_WAKE/_SLEEP if
    // the client omits either for any reason.
    todayWakeUpTime: typeof body.todayWakeUpTime === 'string' && HHMM_RE.test(body.todayWakeUpTime) ? body.todayWakeUpTime : '08:00',
    todayBedtime: typeof body.todayBedtime === 'string' && HHMM_RE.test(body.todayBedtime) ? body.todayBedtime : '00:00',
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method not allowed' });
  if (!checkAuth(req, res)) return;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ ok: false, error: 'Server not configured (missing ANTHROPIC_API_KEY env var).' });

  const mode = req.query && req.query.mode;
  if (mode !== 'plan' && mode !== 'today' && mode !== 'day-plan') {
    return res.status(400).json({ ok: false, error: 'mode must be "plan", "today", or "day-plan"' });
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
    return await handleToday(req, res, apiKey, body);
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Unexpected error: ' + (e && e.message) });
  }
}
