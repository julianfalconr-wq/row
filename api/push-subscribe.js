// =============================================================
// Saves/serves browser push subscriptions for the daily proactive
// check-in (see api/daily-checkin.js + api/send-notification.js).
//
// Requires this table in Supabase (SQL editor):
//   create table push_subscriptions (
//     id text primary key,
//     subscription jsonb not null,
//     created_at timestamptz not null default now()
//   );
// "id" is the subscription's own endpoint URL — inherently unique
// per browser/device, so it's a natural primary key and doubles as
// idempotent upsert (re-subscribing the same browser overwrites its
// old row instead of duplicating it).
//
// Requires SUPABASE_URL, SUPABASE_SERVICE_KEY, DASHBOARD_SECRET (same
// env vars every other server function here already uses), plus:
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY  — generate a pair with:
//     npx web-push generate-vapid-keys
//   Paste the "Public Key" / "Private Key" it prints into Vercel env
//   vars. The private key must never reach the browser — this file
//   only ever hands out the public one, and only over GET.
//
// GET  /api/push-subscribe?secret=...
//   -> { ok: true, publicKey: <VAPID_PUBLIC_KEY or null> }
//   The frontend needs the public key to call pushManager.subscribe().
//   Returns publicKey: null (not an error) if VAPID keys aren't set
//   yet, so the frontend can skip the subscribe flow gracefully.
//
// POST /api/push-subscribe?secret=...  <PushSubscription JSON>
//   -> { ok: true }
//   Body is exactly what PushSubscription.toJSON() produces in the
//   browser: { endpoint, keys: { p256dh, auth }, ... }.
// =============================================================

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-dashboard-secret');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!checkAuth(req, res)) return;

  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, publicKey: process.env.VAPID_PUBLIC_KEY || null });
  }

  if (req.method === 'POST') {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ error: 'missing SUPABASE_URL / SUPABASE_SERVICE_KEY' });
    }
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const endpoint = body && body.endpoint;
    const keys = body && body.keys;
    if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
      return res.status(400).json({ error: 'expected a PushSubscription object (endpoint + keys.p256dh + keys.auth)' });
    }
    try {
      const r = await fetch(supabaseUrl('push_subscriptions?on_conflict=id'), {
        method: 'POST',
        headers: { ...supabaseHeaders(), Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify([{ id: endpoint, subscription: body }]),
      });
      if (!r.ok) throw new Error('Supabase write failed: ' + (await r.text()).slice(0, 300));
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message || String(e) });
    }
  }

  return res.status(405).json({ error: 'method not allowed' });
}
