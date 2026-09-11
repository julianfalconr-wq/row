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
//   api/sync-state.js's resource=restrictions. scope "running" or
//   "strength" is enforced in code (see normalizePlan), not just
//   requested in the prompt; other scopes rely on the model
//   respecting buildRestrictionsPromptSection's instructions, same as
//   how padel is already handled in mode=today.
//
// MODE 1 — POST /api/training?mode=plan&secret=...
//   Generates this week's strength + running objectives.
//   Body: {
//     strengthSessions: [{ date, totalSets, exerciseCount }],   // last ~21 days
//     recentExerciseNames: ['Bench Press', 'DB Row', ...],      // distinct names actually logged
//     runningSessions: [{ date, distanceKm, durationMin, pace, effort, notes }], // last ~21 days
//     whoop: { recentRecovery: [{date, recoveryPct}], recentStrain: [{date, strain}] } | null,
//   }
//   -> { ok: true, plan: {
//     strength: { targetSessions: Number, focus: String },
//     running: {
//       interval:    { targetSessions: Number, targetMinutes: Number, description: String },
//       longRun:     { targetKm: Number, description: String },
//       easyVolume:  { targetKm: Number, description: String },
//     },
//     rationale: String,
//   } }
//
// MODE 2 — POST /api/training?mode=today&secret=...
//   Recommends one specific session for today, Whoop-adjusted.
//   Body: {
//     weekPlan: { strength: {...}, running: {...}, rationale } | null,   // from mode=plan
//     progress: {
//       strengthSessionsDone: Number, strengthSessionsTarget: Number,
//       runningKmDone: Number, runningKmTarget: Number,
//       // Raw sessions logged since Monday, NOT pre-classified into
//       // interval/long-run/easy — the model infers which piece of the
//       // plan each one likely satisfied from its own distance/duration/
//       // effort (a rule-based classifier here would be guesswork; the
//       // model reasoning over the same numbers isn't).
//       runningSessionsThisWeek: [{ dateKey, distanceKm, durationMin, effort }],
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
//     todayRecommendation: String | null,   // gym.html's cached mode=today result (Phase 1, padel-aware) — reused verbatim, NOT recomputed here
//     whoopToday: { recoveryPct: Number|null } | null,
//     fixedEvents: [{ date, start, end, title, allDay }],   // today + tomorrow's REAL existing Calendar events — immovable
//     sleepTargetHours: Number,   // default 8 (no configurable setting for this yet — see main.html's comment)
//     wakeUpTime: 'HH:MM', bedtime: 'HH:MM',
//     // Both pre-computed CLIENT-SIDE (plain arithmetic on tomorrow's
//     // earliest fixedEvents entry, not by this endpoint) rather than
//     // asked of the model — exact clock-arithmetic is a poor fit for an
//     // LLM to get reliably right, whereas fitting flexible blocks
//     // (training/work/meals/walks) around fixed anchors is exactly the
//     // kind of judgment call worth spending a model call on. See
//     // buildDayPlanSystemPrompt's FIXED section below.
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

function buildPlanSystemPrompt(restrictions) {
  return (
    'You are a training coach generating ONE week of concrete objectives for a personal dashboard. ' +
    'The user does two kinds of training: strength (equipment-limited, see below) and running, with two ' +
    'distinct running goals that both need to be served every week: improving VO2 max (needs genuine ' +
    'high-intensity interval/tempo work) and building distance capacity past 10km (needs progressively ' +
    'longer runs plus easy aerobic volume — standard run periodization, not an ad-hoc guess). ' +
    'A real weekly running structure balances both: one interval/tempo session for VO2 max, one ' +
    'progressively-longer long run building toward and past 10km, and additional easy Zone 2 volume. ' +
    'Do not neglect either goal in favor of the other.\n\n' +
    EQUIPMENT_NOTE + '\n\n' +
    buildRestrictionsPromptSection(restrictions) +
    'Use the recent history you are given (recent strength session frequency, recent running distances/' +
    'paces/effort, and recent Whoop recovery/strain trends if present) to calibrate — e.g. progress the ' +
    'long run distance gradually past whatever the recent longest run was, don\'t suddenly jump volume, ' +
    'and temper targets if strain has been consistently high or recovery consistently low.\n\n' +
    'Reply with ONLY valid JSON, no markdown code fences, no commentary before or after, in exactly this shape:\n' +
    JSON.stringify({
      strength: { targetSessions: 3, focus: 'short phrase, e.g. "full-body bench + single-dumbbell supersets"' },
      running: {
        interval: { targetSessions: 1, targetMinutes: 30, description: 'concrete session, e.g. "6x3min hard w/ 2min easy jog recovery"' },
        longRun: { targetKm: 8, description: 'concrete guidance, e.g. "steady easy pace, first 2km slower"' },
        easyVolume: { targetKm: 10, description: 'concrete guidance, e.g. "2-3 easy runs, conversational pace"' },
      },
      rationale: '1-3 sentences explaining the targets given the recent history provided',
    }, null, 2) +
    '\n\nEvery number must be a concrete number (sessions, km, or minutes) — never vague advice like ' +
    '"run more" or "increase distance". If recent history is thin or empty, use sensible conservative ' +
    'defaults for someone building both VO2 max and distance capacity, and say so in the rationale.'
  );
}

function num(v, fallback) {
  const n = Number(v);
  return isNaN(n) ? fallback : n;
}

function normalizePlan(raw, restrictions) {
  const restricted = restrictedScopeSet(restrictions);
  const r = raw || {};
  const strength = r.strength || {};
  const running = r.running || {};
  const interval = running.interval || {};
  const longRun = running.longRun || {};
  const easyVolume = running.easyVolume || {};
  // Enforced here in code, not just requested in the prompt above — a
  // hard override to exactly 0 (same pattern as runningRestricted
  // below), not merely a relaxed floor: an earlier version of this
  // only dropped the normal Math.max(1, ...) floor to 0 without
  // actually zeroing a noncompliant model's own number, so a model
  // that ignored the restriction and returned targetSessions:4 sailed
  // straight through. Caught by testing a deliberately noncompliant
  // mocked response before trusting this.
  const strengthRestricted = restricted.has('strength');
  const runningRestricted = restricted.has('running');
  return {
    strength: {
      targetSessions: strengthRestricted ? 0 : Math.max(1, Math.round(num(strength.targetSessions, 3))),
      focus: typeof strength.focus === 'string' ? strength.focus.slice(0, 200) : '',
    },
    running: {
      interval: {
        targetSessions: runningRestricted ? 0 : Math.max(0, Math.round(num(interval.targetSessions, 1))),
        targetMinutes: runningRestricted ? 0 : Math.max(0, Math.round(num(interval.targetMinutes, 25))),
        description: typeof interval.description === 'string' ? interval.description.slice(0, 300) : '',
      },
      longRun: {
        targetKm: runningRestricted ? 0 : Math.max(0, num(longRun.targetKm, 8)),
        description: typeof longRun.description === 'string' ? longRun.description.slice(0, 300) : '',
      },
      easyVolume: {
        targetKm: runningRestricted ? 0 : Math.max(0, num(easyVolume.targetKm, 10)),
        description: typeof easyVolume.description === 'string' ? easyVolume.description.slice(0, 300) : '',
      },
    },
    rationale: typeof r.rationale === 'string' ? r.rationale.slice(0, 600) : '',
  };
}

async function handlePlan(req, res, apiKey, body) {
  const restrictions = sanitizeRestrictions(body.restrictions);
  const context = {
    recentStrengthSessions: Array.isArray(body.strengthSessions) ? body.strengthSessions.slice(0, 30) : [],
    recentExerciseNames: Array.isArray(body.recentExerciseNames) ? body.recentExerciseNames.slice(0, 30) : [],
    recentRunningSessions: Array.isArray(body.runningSessions) ? body.runningSessions.slice(0, 30) : [],
    whoop: body.whoop && typeof body.whoop === 'object' ? body.whoop : null,
    activeRestrictions: restrictions,
  };

  const text = await callClaude(apiKey, {
    system: buildPlanSystemPrompt(restrictions),
    userContent: 'Recent history:\n' + JSON.stringify(context, null, 2),
    maxTokens: 800,
  });
  const parsed = extractJson(text);
  if (!parsed) return res.status(502).json({ ok: false, error: 'Model did not return valid JSON.' });

  return res.status(200).json({ ok: true, plan: normalizePlan(parsed, restrictions) });
}

// ------------------------------------------------------------
// MODE: today
// ------------------------------------------------------------

function buildTodaySystemPrompt(restrictions) {
  return (
    'You recommend today\'s training on a personal dashboard. This week\'s plan (weekPlan) always covers ' +
    'BOTH strength and running — evaluate the two independently, then combine whichever pieces are ' +
    'actually outstanding and appropriate today into ONE recommendation (e.g. "Push + 5K run"). It is ' +
    'normal and expected for the answer to include both — do not default to naming only strength; check ' +
    'running\'s status with the same weight every time.\n\n' +
    'WHOOP-ADJUSTMENT (match this app\'s existing convention exactly): recovery >=67% is high/well-' +
    'recovered — combining strength with even the hard interval session today is fine if both are due. ' +
    '34-66% is moderate — combining is still fine for lighter pairings (e.g. strength + an easy run), but ' +
    'avoid pairing strength with the interval session; if both would be demanding, pick just one. Below ' +
    '34% is low — pick AT MOST ONE light thing (an easy Zone 2 run OR light strength) or recommend ' +
    'explicit rest; never combine two demanding sessions, and never recommend the interval session. If ' +
    'Whoop is not connected (whoopToday is null), ignore recovery and decide purely from what\'s ' +
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
    'RUNNING — weekPlan.running has three pieces, each with its own target: interval (VO2max/tempo), ' +
    'longRun, and easyVolume. progress.runningSessionsThisWeek lists what has ACTUALLY been logged since ' +
    'Monday, NOT pre-labeled by type — infer from each session\'s own distance/duration/effort which ' +
    'piece it most likely satisfied (the longest-distance session is probably the long run; a short, ' +
    'high-effort, fast-paced session is probably the interval one; anything else is probably easy ' +
    'volume). Whichever piece(s) have NOT clearly been satisfied yet are outstanding and worth ' +
    'recommending if recovery allows — never suggest a piece that\'s already been done this week. ' +
    'progress.runningKmDone vs progress.runningKmTarget is a secondary volume signal only, not a ' +
    'substitute for checking which specific piece is still due.\n\n' +
    'PADEL — todayCalendar tells you whether the user has a real padel session on their Google Calendar ' +
    'today (todayCalendar.padelToday, with the actual matched event title in ' +
    'todayCalendar.padelEventTitle when true). Padel is a genuinely demanding session physically — treat a ' +
    'padel day the same way you treat low WHOOP recovery (see WHOOP-ADJUSTMENT above): do NOT recommend ' +
    'strength or a running session on top of it. Prefer explicit rest, or at most very light active ' +
    'recovery (an easy walk, light mobility) — never combine padel with Explosiveness, the interval ' +
    'session, a long run, or a full strength split, even if the weekly plan has those outstanding. If ' +
    'padel and low recovery both apply, that is an even stronger case for pure rest, not a reason to ' +
    'reconsider. If todayCalendar is missing or todayCalendar.padelToday is false, ignore padel entirely ' +
    'and reason from WHOOP/strength/running as usual.\n\n' +
    buildRestrictionsPromptSection(restrictions) +
    'FORMAT — this is the most important rule: the recommendation is a SHORT LABEL, not a paragraph. One ' +
    'line, naming only the split day and/or the run type/distance from this week\'s plan — nothing else. ' +
    'Good examples: "Push", "Push + 5K run", "Push + long run", "10K long run", "Rest — recovery is low", ' +
    '"Easy 5K + Legs", "Rest — padel today", "Easy walk only — padel today", "Push — running restricted". Bad (never do this): listing individual exercises, sets, reps, or weights; ' +
    'explaining "no prior weights logged, so start conservative"; multi-sentence reasoning. The exercise-' +
    'by-exercise detail for whatever day you name is already visible on the Strength tab itself once the ' +
    'user gets there — your only job is telling them WHICH one(s) to do today, not repeating what\'s ' +
    'already on that page. A few trailing words of context are fine when genuinely needed (e.g. "— ' +
    'recovery is low"), but never more than that.\n\n' +
    'Reply with ONLY valid JSON, no markdown fences, no commentary, in exactly this shape:\n' +
    JSON.stringify({ recommendation: 'ONE short line naming only the split day and/or run type/distance, combined with "+" when both are due — e.g. "Push + 5K run" — never individual exercises, sets, weights, or multi-sentence explanations' }, null, 2)
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
    '- wakeUpTime and bedtime are already computed (from tomorrow\'s earliest fixed commitment and the ' +
    'user\'s sleep-duration target) — do NOT recalculate them yourself. Output a short "Wake up" block on ' +
    'tomorrowDateKey starting at wakeUpTime, and a "Wind-down" block on todayDateKey ending exactly at ' +
    'bedtime, using the exact given times. Never schedule anything else between bedtime and wakeUpTime.\n\n' +
    'WHAT YOU DECIDE — fit these into whatever open time remains around the fixed items above, on ' +
    'todayDateKey unless noted:\n' +
    '1. Today\'s training session — todayRecommendation is the exact, already-decided session (it already ' +
    'accounts for WHOOP recovery and any padel commitment today — do not re-evaluate or change WHAT it ' +
    'says, just place it once, in a sensible open slot). If todayRecommendation is null, skip the training ' +
    'block entirely rather than inventing one.\n' +
    '2. One focused productivity/work block — a reasonable default length (about 1 hour) since no specific ' +
    'preference is configured.\n' +
    '3. Three generic meal blocks — "Breakfast", "Lunch", "Dinner" only, no recipes or macros — at ' +
    'reasonable times relative to wake-up, the fixed events, and each other (breakfast shortly after ' +
    'waking, lunch around midday, dinner in the evening; several hours apart; never overlapping the ' +
    'training block or a fixed event).\n' +
    '4. A short post-meal walk (10-15 minutes) shortly after each of the three meal blocks.\n\n' +
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

function normalizeDayPlanBlocks(raw, todayDateKey, tomorrowDateKey) {
  const blocks = Array.isArray(raw && raw.blocks) ? raw.blocks : [];
  return blocks
    .map((b) => {
      b = b || {};
      const date = (b.date === todayDateKey || b.date === tomorrowDateKey) ? b.date : todayDateKey;
      const start = typeof b.start === 'string' ? b.start.slice(0, 5) : '';
      const end = typeof b.end === 'string' ? b.end.slice(0, 5) : '';
      const title = typeof b.title === 'string' ? b.title.trim().slice(0, 200) : '';
      const category = DAY_PLAN_CATEGORIES.indexOf(b.category) !== -1 ? b.category : 'other';
      return { date, start, end, title, category };
    })
    .filter((b) => b.title && HHMM_RE.test(b.start) && HHMM_RE.test(b.end) && b.start < b.end)
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}

async function handleDayPlan(req, res, apiKey, body) {
  const todayDateKey = typeof body.todayDateKey === 'string' ? body.todayDateKey.slice(0, 10) : '';
  const tomorrowDateKey = typeof body.tomorrowDateKey === 'string' ? body.tomorrowDateKey.slice(0, 10) : '';
  if (!todayDateKey || !tomorrowDateKey) {
    return res.status(400).json({ ok: false, error: 'todayDateKey and tomorrowDateKey (YYYY-MM-DD) are required' });
  }

  const restrictions = sanitizeRestrictions(body.restrictions);
  const context = {
    todayDateKey,
    tomorrowDateKey,
    todayRecommendation: typeof body.todayRecommendation === 'string' ? body.todayRecommendation.slice(0, 300) : null,
    whoopToday: body.whoopToday && typeof body.whoopToday === 'object' ? { recoveryPct: numOrNull(body.whoopToday.recoveryPct) } : null,
    fixedEvents: Array.isArray(body.fixedEvents) ? body.fixedEvents.slice(0, 40).map((e) => ({
      date: typeof (e && e.date) === 'string' ? e.date.slice(0, 10) : '',
      start: typeof (e && e.start) === 'string' ? e.start.slice(0, 5) : '',
      end: typeof (e && e.end) === 'string' ? e.end.slice(0, 5) : '',
      title: typeof (e && e.title) === 'string' ? e.title.slice(0, 200) : '',
      allDay: !!(e && e.allDay),
    })) : [],
    sleepTargetHours: Math.max(4, Math.min(12, numOrNull(body.sleepTargetHours) || 8)),
    wakeUpTime: typeof body.wakeUpTime === 'string' && HHMM_RE.test(body.wakeUpTime) ? body.wakeUpTime : '07:00',
    bedtime: typeof body.bedtime === 'string' && HHMM_RE.test(body.bedtime) ? body.bedtime : '23:00',
    activeRestrictions: restrictions,
  };

  const text = await callClaude(apiKey, {
    system: buildDayPlanSystemPrompt(restrictions),
    userContent: 'Context:\n' + JSON.stringify(context, null, 2),
    maxTokens: 1500,
  });
  const parsed = extractJson(text);
  if (!parsed) return res.status(502).json({ ok: false, error: 'Model did not return valid JSON.' });
  const blocks = normalizeDayPlanBlocks(parsed, todayDateKey, tomorrowDateKey);
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
