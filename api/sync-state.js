// =============================================================
// Generic endpoint for syncing compact, SUMMARIZED snapshots of
// gym / finance / Daily Stack data into the existing app_state
// table, so api/daily-checkin.js (which has no browser and can't
// read localStorage) has something to reason about for those areas.
// This is a cache for a daily proactive message, not a data
// warehouse — callers are expected to send small summaries, the
// same "summarized, not dumped" shape gatherTodayContext() already
// uses for the live chat.
//
// IMPORTANT — key collision avoidance: finance.html and health.html's
// Daily Stack section already write to this SAME app_state table via
// sync.js's generic initCloudSync(), under key='finance' and
// key='health' respectively — but for a completely different purpose
// (mirroring their RAW localStorage across devices, full fidelity).
// To avoid clobbering that existing feature, this endpoint does a
// MERGE upsert: it reads whatever's already in the target row and
// writes the new summary into a dedicated "dailyCheckinSummary"
// sub-field, leaving any existing top-level fields in that row
// untouched. daily-checkin.js reads row.data.dailyCheckinSummary
// specifically, not the whole row.
//
// Uses the same env vars every other server function here already
// does: SUPABASE_URL, SUPABASE_SERVICE_KEY, DASHBOARD_SECRET.
//
// POST /api/sync-state?secret=...  { key: "gym"|"finance"|"dailystack", data: {...} }
//   "key" must be exactly one of the three above — anything else is
//   rejected (400), so this can't be used to write arbitrary
//   app_state rows.
// =============================================================

const ALLOWED_KEYS = ['gym', 'finance', 'dailystack'];
const MAX_BODY_CHARS = 20000; // generous ceiling for a "summary" — guards against accidental raw dumps

function supabaseHeaders() {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}
function supabaseUrl(path) {
  return `${process.env.SUPABASE_URL}/rest/v1/${path}`;
}

function checkAuth(req, res) {
  const expected = process.env.DASHBOARD_SECRET;
  if (!expected) {
    res.status(500).json({ error: 'Server not configured (missing DASHBOARD_SECRET env var).' });
    return false;
  }
  const given = (req.query && req.query.secret) || req.headers['x-dashboard-secret'];
  if (!given || given !== expected) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

async function readRow(key) {
  const r = await fetch(supabaseUrl('app_state?key=eq.' + encodeURIComponent(key) + '&select=data'), {
    headers: supabaseHeaders(),
  });
  if (!r.ok) throw new Error('Supabase read failed: ' + (await r.text()).slice(0, 300));
  const rows = await r.json();
  const existing = Array.isArray(rows) && rows[0] ? rows[0].data : null;
  return (existing && typeof existing === 'object') ? existing : {};
}

async function writeRow(key, data) {
  const r = await fetch(supabaseUrl('app_state?on_conflict=key'), {
    method: 'POST',
    headers: { ...supabaseHeaders(), Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify([{ key, data, updated_at: new Date().toISOString() }]),
  });
  if (!r.ok) throw new Error('Supabase write failed: ' + (await r.text()).slice(0, 300));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-dashboard-secret');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  if (!checkAuth(req, res)) return;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'missing SUPABASE_URL / SUPABASE_SERVICE_KEY' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }

  const key = body && body.key;
  if (!ALLOWED_KEYS.includes(key)) {
    return res.status(400).json({ error: 'key must be one of: ' + ALLOWED_KEYS.join(', ') });
  }
  const summary = body && body.data;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    return res.status(400).json({ error: 'data must be a plain object' });
  }
  if (JSON.stringify(summary).length > MAX_BODY_CHARS) {
    return res.status(400).json({ error: 'data too large for a summary (max ' + MAX_BODY_CHARS + ' chars) — this endpoint is for compact snapshots, not raw history' });
  }

  try {
    const existing = await readRow(key);
    const merged = Object.assign({}, existing, {
      dailyCheckinSummary: summary,
      dailyCheckinSummaryUpdatedAt: new Date().toISOString(),
    });
    await writeRow(key, merged);
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}
