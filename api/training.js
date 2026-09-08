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

async function callClaude(apiKey, { system, userContent, maxTokens }) {
  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    throw new Error('Anthropic API error (' + anthropicRes.status + '): ' + errText.slice(0, 500));
  }
  const data = await anthropicRes.json();
  return (data && data.content && data.content[0] && data.content[0].text) || '';
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
    'You recommend ONE specific training session for today on a personal dashboard, given this week\'s ' +
    'objectives, what has already been logged this week, and today\'s Whoop recovery if available.\n\n' +
    'Whoop-adjustment principle (match this app\'s existing convention exactly): recovery >=67% counts as ' +
    'high/well-recovered — normal or harder work (including the interval session) is fine. 34-66% is ' +
    'moderate — favor easier/shorter work, or strength over a hard interval session. Below 34% is low — ' +
    'recommend an easy Zone 2 run, light/no strength, or explicit rest; do not recommend the interval ' +
    'session on a low-recovery day. If Whoop is not connected (whoopToday is null), ignore recovery and ' +
    'decide purely from this week\'s objectives and what is still outstanding.\n\n' +
    'progress.runningSessionsThisWeek lists what has actually been logged since Monday, NOT pre-labeled ' +
    'by type — infer from each session\'s own distance/duration/effort which piece of the weekly running ' +
    'structure (interval/tempo, long run, or easy volume) it most likely satisfied (e.g. the longest-' +
    'distance session is probably the long run; a short, high-effort, fast-paced session is probably the ' +
    'interval/tempo one). Then prioritize whichever piece of this week\'s plan is still outstanding and ' +
    'appropriate for today\'s recovery: if the interval/tempo session hasn\'t happened yet this week and ' +
    'recovery is good, that\'s usually today\'s answer; if the long run is still due and recovery is fine, ' +
    'that can be today\'s answer instead; if strength sessions are behind target and recovery is low, ' +
    'suggest strength over running (lower systemic fatigue) or vice versa depending on which is more ' +
    'overdue. Use judgment, but always land on ONE concrete recommendation.\n\n' +
    'strengthContext tells you the user\'s ACTUAL configured strength split — use it to decide whether ' +
    'strength fits today and, if so, which real day it is (strengthContext.todaySplitDay, e.g. "Push", ' +
    '"Pull", "Legs", or "Rest") — NEVER invent a day/structure like "full-body" that doesn\'t match ' +
    'strengthContext.todaySplitDay, and never name a day other than the real one. strengthContext.' +
    'exercisesConfiguredForToday exists so you can sanity-check that today\'s split actually has exercises ' +
    'configured (and to inform your judgment on whether strength is worth doing at all today) — it is ' +
    'context for YOUR reasoning only, not something to repeat in the output. If ' +
    'strengthContext.isRestDayInRotation is true, do not recommend strength unless this week\'s strength ' +
    'target is meaningfully behind and recovery is good, and if so keep the "anyway" framing to a couple ' +
    'trailing words at most (e.g. "Push anyway"), never a full sentence explaining it. If strengthContext ' +
    'itself is missing or todaySplitDay is null, no split has been configured — say that plainly and ' +
    'briefly instead of naming a day.\n\n' +
    'FORMAT — this is the most important rule: the recommendation is a SHORT LABEL, not a paragraph. One ' +
    'line, naming only the split day and/or the run type/distance from this week\'s plan — nothing else. ' +
    'Good examples: "Push", "Push + 5K run", "10K long run", "Rest — recovery is low", "Easy 5K + Legs". ' +
    'Bad (never do this): listing individual exercises, sets, reps, or weights; explaining "no prior ' +
    'weights logged, so start conservative"; multi-sentence reasoning. The exercise-by-exercise detail for ' +
    'whatever day you name is already visible on the Strength tab itself once the user gets there — your ' +
    'only job is telling them WHICH one to do today, not repeating what\'s already on that page. A few ' +
    'trailing words of context are fine when genuinely needed (e.g. "— recovery is low"), but never more ' +
    'than that.\n\n' +
    'Reply with ONLY valid JSON, no markdown fences, no commentary, in exactly this shape:\n' +
    JSON.stringify({ recommendation: 'ONE short line naming only the split day and/or run type/distance — e.g. "Push + 5K run" — never individual exercises, sets, weights, or multi-sentence explanations' }, null, 2)
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

  // Was 300 — confirmed via temporary logging that this prompt's reasoning
  // (Whoop thresholds, inferring session type from raw logged runs) was
  // sometimes eating the whole budget before the JSON closed, producing a
  // truncated response extractJson() correctly couldn't parse. Matches
  // handlePlan's 800 now.
  const text = await callClaude(apiKey, {
    system: buildTodaySystemPrompt(),
    userContent: 'Context:\n' + JSON.stringify(context, null, 2),
    maxTokens: 800,
  });
  const parsed = extractJson(text);
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
