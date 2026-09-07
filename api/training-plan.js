// =============================================================
// Generates the week's training objectives (strength + running) for
// gym.html's "Training" page. Stateless — gym.html gathers recent
// history from its own localStorage (+ a live Whoop fetch, same
// pattern topbar.js's gatherTodayContext() already uses) and POSTs a
// compact summary here; this endpoint asks Claude for concrete
// weekly targets and returns them for the client to store and render.
//
// Nothing is persisted server-side by this file — the client is the
// only place the resulting plan is saved (localStorage), same as
// every other per-page feature in this app.
//
// Gated by DASHBOARD_SECRET, same as every other endpoint here.
// Requires ANTHROPIC_API_KEY.
//
// POST /api/training-plan?secret=...
//   {
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

// Fixed, real-world equipment constraint — not something the client
// needs to send every time. If this ever changes, edit it here.
const EQUIPMENT_NOTE =
  'Equipment reality: the user currently only has a flat/adjustable bench press setup and ONE dumbbell ' +
  'for strength training — no barbell, no rack, no second dumbbell, no machines. Every strength ' +
  'suggestion MUST be doable with just those two things (e.g. single-arm/unilateral dumbbell work, ' +
  'bench press variations, tempo/pause reps, or bodyweight movements to fill gaps). Never suggest ' +
  'exercises that require equipment the user does not have.';

function buildSystemPrompt() {
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

function extractJson(text) {
  try { return JSON.parse(text); } catch (e) {}
  const m = /\{[\s\S]*\}/.exec(text);
  if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  return null;
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method not allowed' });
  if (!checkAuth(req, res)) return;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ ok: false, error: 'Server not configured (missing ANTHROPIC_API_KEY env var).' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  if (!body || typeof body !== 'object') body = {};
  if (JSON.stringify(body).length > MAX_BODY_CHARS) {
    return res.status(400).json({ ok: false, error: 'request body too large — this endpoint expects a summarized history, not raw logs' });
  }

  const context = {
    recentStrengthSessions: Array.isArray(body.strengthSessions) ? body.strengthSessions.slice(0, 30) : [],
    recentExerciseNames: Array.isArray(body.recentExerciseNames) ? body.recentExerciseNames.slice(0, 30) : [],
    recentRunningSessions: Array.isArray(body.runningSessions) ? body.runningSessions.slice(0, 30) : [],
    whoop: body.whoop && typeof body.whoop === 'object' ? body.whoop : null,
  };

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 800,
        system: buildSystemPrompt(),
        messages: [{ role: 'user', content: 'Recent history:\n' + JSON.stringify(context, null, 2) }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      return res.status(502).json({ ok: false, error: 'Anthropic API error (' + anthropicRes.status + '): ' + errText.slice(0, 500) });
    }

    const data = await anthropicRes.json();
    const text = (data && data.content && data.content[0] && data.content[0].text) || '';
    const parsed = extractJson(text);
    if (!parsed) return res.status(502).json({ ok: false, error: 'Model did not return valid JSON.' });

    return res.status(200).json({ ok: true, plan: normalizePlan(parsed) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Unexpected error: ' + (e && e.message) });
  }
}
