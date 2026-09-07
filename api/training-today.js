// =============================================================
// Generates "Today's recommended session" for gym.html's Training
// page — a short, specific, Whoop-adjusted recommendation for what
// to do today given this week's objectives (api/training-plan.js)
// and what's already been logged this week.
//
// Stateless, same shape as api/training-plan.js: gym.html gathers the
// Whoop reading itself (live fetch via /api/whoop-data + token refresh
// via /api/whoop-refresh — the same pattern topbar.js's
// gatherTodayContext() already uses, not re-implemented differently
// here) and this week's progress from localStorage, then POSTs a
// compact summary. Nothing is persisted server-side.
//
// Gated by DASHBOARD_SECRET, same as every other endpoint here.
// Requires ANTHROPIC_API_KEY.
//
// POST /api/training-today?secret=...
//   {
//     weekPlan: { strength: {...}, running: {...}, rationale } | null,   // from training-plan.js
//     progress: {
//       strengthSessionsDone: Number, strengthSessionsTarget: Number,
//       runningKmDone: Number, runningKmTarget: Number,
//       // Raw sessions logged since the start of this week, not
//       // pre-classified into interval/long-run/easy — the model infers
//       // which piece of the plan each one likely satisfied from its own
//       // distance/duration/effort (a rule-based classifier here would be
//       // guesswork; the model reasoning over the same numbers isn't).
//       runningSessionsThisWeek: [{ dateKey, distanceKm, durationMin, effort }],
//     } | null,
//     whoopToday: { recoveryPct: Number|null, strain: Number|null } | null,
//     whoopRecentStrain: [{ date, strain }] | null,
//   }
//   -> { ok: true, recommendation: String }
// =============================================================

const MAX_BODY_CHARS = 20000;

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

function buildSystemPrompt() {
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
    'Reply with ONLY valid JSON, no markdown fences, no commentary, in exactly this shape:\n' +
    JSON.stringify({ recommendation: 'one short, specific, actionable sentence or two — name the exact session type and a concrete number (km, minutes, or sessions), not vague advice' }, null, 2)
  );
}

function extractJson(text) {
  try { return JSON.parse(text); } catch (e) {}
  const m = /\{[\s\S]*\}/.exec(text);
  if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  return null;
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
    return res.status(400).json({ ok: false, error: 'request body too large — this endpoint expects a summarized status, not raw logs' });
  }

  const context = {
    weekPlan: body.weekPlan && typeof body.weekPlan === 'object' ? body.weekPlan : null,
    progress: body.progress && typeof body.progress === 'object' ? body.progress : null,
    whoopToday: body.whoopToday && typeof body.whoopToday === 'object' ? body.whoopToday : null,
    whoopRecentStrain: Array.isArray(body.whoopRecentStrain) ? body.whoopRecentStrain.slice(0, 14) : null,
  };

  if (!context.weekPlan) {
    return res.status(200).json({ ok: true, recommendation: 'Generate this week\'s objectives above first, then check back here for today\'s pick.' });
  }

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
        max_tokens: 300,
        system: buildSystemPrompt(),
        messages: [{ role: 'user', content: 'Context:\n' + JSON.stringify(context, null, 2) }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      return res.status(502).json({ ok: false, error: 'Anthropic API error (' + anthropicRes.status + '): ' + errText.slice(0, 500) });
    }

    const data = await anthropicRes.json();
    const text = (data && data.content && data.content[0] && data.content[0].text) || '';
    const parsed = extractJson(text);
    const recommendation = parsed && typeof parsed.recommendation === 'string' ? parsed.recommendation.trim() : '';
    if (!recommendation) return res.status(502).json({ ok: false, error: 'Model did not return valid JSON.' });

    return res.status(200).json({ ok: true, recommendation });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Unexpected error: ' + (e && e.message) });
  }
}
