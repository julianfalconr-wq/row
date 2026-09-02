// =============================================================
// Stores / returns Cronometer diary data that the user exported
// themselves from Cronometer's own "Export Data" feature and
// uploaded as CSV in cronometer.html. There is no login automation
// here — this never talks to Cronometer's servers or handles a
// Cronometer password. It only stores the already-parsed rows the
// browser sends it.
//
// Gated by a DASHBOARD_SECRET so only this dashboard's owner can
// read or write this data, even though the underlying Supabase key
// used to persist it is a public "publishable" key (same one the
// rest of the dashboard already uses).
//
// Requires a DASHBOARD_SECRET env var (Vercel -> Settings ->
// Environment Variables). Every request must send it back as:
//   x-dashboard-secret: <value>
//
// POST { rows: [...], headers: [...], source: 'export.csv' }
//   -> stores it, returns { ok: true, count }
// GET
//   -> returns the last stored payload: { ok: true, data, updated_at }
// =============================================================

const SUPABASE_URL = 'https://dfxjlneohhgfdussomou.supabase.co';
const SUPABASE_KEY = 'sb_publishable_9a1GD4OaqszZSnXW80PFTA_JvHi533e';
const APP_KEY = 'cronometer';
const MAX_ROWS = 20000;

function checkAuth(req, res) {
  const expected = process.env.DASHBOARD_SECRET;
  if (!expected) {
    res.status(500).json({ error: 'Server not configured (missing DASHBOARD_SECRET env var).' });
    return false;
  }
  const given = req.headers['x-dashboard-secret'];
  if (!given || given !== expected) {
    res.status(401).json({ error: 'Missing or invalid x-dashboard-secret header.' });
    return false;
  }
  return true;
}

async function readStored() {
  const r = await fetch(
    SUPABASE_URL + '/rest/v1/app_state?key=eq.' + APP_KEY + '&select=data,updated_at',
    { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY } }
  );
  const rows = await r.json();
  return (Array.isArray(rows) && rows[0]) || null;
}

async function writeStored(data) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/app_state?on_conflict=key', {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ key: APP_KEY, data, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error('Supabase write failed: ' + (await r.text()));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-dashboard-secret');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!checkAuth(req, res)) return;

  if (req.method === 'GET') {
    try {
      const stored = await readStored();
      return res.status(200).json({
        ok: true,
        data: stored ? stored.data : null,
        updated_at: stored ? stored.updated_at : null,
      });
    } catch (e) {
      return res.status(500).json({ error: 'read failed: ' + (e.message || String(e)) });
    }
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    const rows = Array.isArray(body && body.rows) ? body.rows : null;
    if (!rows) return res.status(400).json({ error: 'Body must include a "rows" array (parsed CSV rows).' });
    if (rows.length > MAX_ROWS) return res.status(400).json({ error: 'Too many rows (max ' + MAX_ROWS + ').' });

    const payload = {
      rows,
      headers: Array.isArray(body.headers) ? body.headers : (rows[0] ? Object.keys(rows[0]) : []),
      source: typeof body.source === 'string' ? body.source.slice(0, 200) : null,
      syncedAt: new Date().toISOString(),
    };

    try {
      await writeStored(payload);
      return res.status(200).json({ ok: true, count: rows.length });
    } catch (e) {
      return res.status(500).json({ error: 'write failed: ' + (e.message || String(e)) });
    }
  }

  return res.status(405).json({ error: 'method not allowed' });
}
