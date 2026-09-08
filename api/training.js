// =============================================================
// Combined endpoint for gym.html's Training page AI features.
// Two modes, one file — same dual-mode-in-one-endpoint pattern
// api/cronometer-data.js already uses (there: presence/absence of a
// "type" param; here: an explicit "mode" param), kept as ONE file
// deliberately: Vercel's Hobby plan caps a deployment at 12
// Serverless Functions, and this repo is already at that ceiling, so
// api/training-plan.js + api/training-today.js as two separate files
// pushed it over and broke the last deployment. Do not split this
// back into two files without first removing another function.
//
// Both modes are stateless — gym.html gathers recent history
// client-side (including a live Whoop fetch, same pattern topbar.js's
// gatherTodayContext() already uses) and POSTs a compact summary;
// nothing is persisted server-side by this file.
//
// Gated by DASHBOARD_SECRET, same as every other endpoint here.
// Requires ANTHROPIC_API_KEY.
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
//   }
//   -> { ok: true, recommendation: String }
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

function buildPlanSystemPrompt() {
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

function normalizePlan(raw) {
  const r = raw || {};
  const strength = r.strength || {};
  const running = r.running || {};
  const interval = running.interval || {};
  const longRun = running.longRun || {};
  const easyVolume = running.easyVolume || {};
  return {
    strength: {
      targetSessions: Math.max(1, Math.round(num(strength.targetSessions, 3))),
      focus: typeof strength.focus === 'string' ? strength.focus.slice(0, 200) : '',
    },
    running: {
      interval: {
        targetSessions: Math.max(0, Math.round(num(interval.targetSessions, 1))),
        targetMinutes: Math.max(0, Math.round(num(interval.targetMinutes, 25))),
        description: typeof interval.description === 'string' ? interval.description.slice(0, 300) : '',
      },
      longRun: {
        targetKm: Math.max(0, num(longRun.targetKm, 8)),
        description: typeof longRun.description === 'string' ? longRun.description.slice(0, 300) : '',
      },
      easyVolume: {
        targetKm: Math.max(0, num(easyVolume.targetKm, 10)),
        description: typeof easyVolume.description === 'string' ? easyVolume.description.slice(0, 300) : '',
      },
    },
    rationale: typeof r.rationale === 'string' ? r.rationale.slice(0, 600) : '',
  };
}

async function handlePlan(req, res, apiKey, body) {
  const context = {
    recentStrengthSessions: Array.isArray(body.strengthSessions) ? body.strengthSessions.slice(0, 30) : [],
    recentExerciseNames: Array.isArray(body.recentExerciseNames) ? body.recentExerciseNames.slice(0, 30) : [],
    recentRunningSessions: Array.isArray(body.runningSessions) ? body.runningSessions.slice(0, 30) : [],
    whoop: body.whoop && typeof body.whoop === 'object' ? body.whoop : null,
  };

  const text = await callClaude(apiKey, {
    system: buildPlanSystemPrompt(),
    userContent: 'Recent history:\n' + JSON.stringify(context, null, 2),
    maxTokens: 800,
  });
  const parsed = extractJson(text);
  if (!parsed) return res.status(502).json({ ok: false, error: 'Model did not return valid JSON.' });

  return res.status(200).json({ ok: true, plan: normalizePlan(parsed) });
}

// ------------------------------------------------------------
// MODE: today
// ------------------------------------------------------------

function buildTodaySystemPrompt() {
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
    'NOT TRACKED YET: padel (or anything else outside this app) is not tracked anywhere in this data — ' +
    'do not mention padel, assume a padel day, or factor it into the recommendation in any way. Reason ' +
    'only from weekPlan, progress, strengthContext, and Whoop.\n\n' +
    'FORMAT — this is the most important rule: the recommendation is a SHORT LABEL, not a paragraph. One ' +
    'line, naming only the split day and/or the run type/distance from this week\'s plan — nothing else. ' +
    'Good examples: "Push", "Push + 5K run", "Push + long run", "10K long run", "Rest — recovery is low", ' +
    '"Easy 5K + Legs". Bad (never do this): listing individual exercises, sets, reps, or weights; ' +
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
  const context = {
    weekPlan: body.weekPlan && typeof body.weekPlan === 'object' ? body.weekPlan : null,
    progress: body.progress && typeof body.progress === 'object' ? body.progress : null,
    strengthContext: body.strengthContext && typeof body.strengthContext === 'object' ? body.strengthContext : null,
    whoopToday: body.whoopToday && typeof body.whoopToday === 'object' ? body.whoopToday : null,
    whoopRecentStrain: Array.isArray(body.whoopRecentStrain) ? body.whoopRecentStrain.slice(0, 14) : null,
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
    system: buildTodaySystemPrompt(),
    userContent: 'Context:\n' + JSON.stringify(context, null, 2),
    maxTokens: 800,
    effort: 'low',
  });
  // TEMPORARY — the strength+running combined-reasoning rewrite made this
  // prompt meaningfully more involved than the one 'low' effort was
  // originally verified against; confirm 'low' still produces real output
  // (not another empty string) before trusting it, same discipline as the
  // last two rounds of debugging this endpoint. Remove once confirmed.
  console.log('[training mode=today] raw text:', JSON.stringify(text));
  const parsed = extractJson(text);
  console.log('[training mode=today] recommendation:', parsed && parsed.recommendation);
  const recommendation = parsed && typeof parsed.recommendation === 'string' ? parsed.recommendation.trim() : '';
  if (!recommendation) return res.status(502).json({ ok: false, error: 'Model did not return valid JSON.' });

  return res.status(200).json({ ok: true, recommendation });
}

// ------------------------------------------------------------

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method not allowed' });
  if (!checkAuth(req, res)) return;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ ok: false, error: 'Server not configured (missing ANTHROPIC_API_KEY env var).' });

  const mode = req.query && req.query.mode;
  if (mode !== 'plan' && mode !== 'today') {
    return res.status(400).json({ ok: false, error: 'mode must be "plan" or "today"' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  if (!body || typeof body !== 'object') body = {};
  if (JSON.stringify(body).length > MAX_BODY_CHARS) {
    return res.status(400).json({ ok: false, error: 'request body too large — this endpoint expects a summarized history, not raw logs' });
  }

  try {
    if (mode === 'plan') return await handlePlan(req, res, apiKey, body);
    return await handleToday(req, res, apiKey, body);
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Unexpected error: ' + (e && e.message) });
  }
}
