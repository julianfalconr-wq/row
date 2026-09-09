// =============================================================
// Merged from api/push-subscribe.js + api/send-notification.js into
// one file. Reason: Vercel's Hobby plan caps a deployment at 12
// Serverless Functions (see api/training.js's header comment for the
// same constraint hitting this project before) — adding the Google
// Calendar feature needed the one function slot this merge frees up.
// Behavior is unchanged for both original endpoints, just dispatched
// by method + ?action= instead of by file.
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
// env vars every other server function here already uses), the
// web-push npm package, plus:
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY  — generate a pair with:
//     npx web-push generate-vapid-keys
//   Paste the "Public Key" / "Private Key" it prints into Vercel env
//   vars. The private key must never reach the browser — this file
//   only ever hands out the public one, and only over GET.
//   VAPID_SUBJECT (optional) — a "mailto:you@example.com" or
//   "https://your-site" contact string the push services (FCM/APNs/
//   Mozilla) may show if something's wrong with your usage.
//
// GET  /api/push?secret=...
//   -> { ok: true, publicKey: <VAPID_PUBLIC_KEY or null> }
//   The frontend needs the public key to call pushManager.subscribe().
//   Returns publicKey: null (not an error) if VAPID keys aren't set
//   yet, so the frontend can skip the subscribe flow gracefully.
//   (Was: GET /api/push-subscribe)
//
// POST /api/push?secret=...&action=subscribe  <PushSubscription JSON>
//   -> { ok: true }
//   Body is exactly what PushSubscription.toJSON() produces in the
//   browser: { endpoint, keys: { p256dh, auth }, ... }.
//   (Was: POST /api/push-subscribe)
//
// POST /api/push?secret=...&action=send  { title, body, url }
//   -> { ok: true, sent, failed, removed }
//   Meant to be called by api/daily-checkin.js (the cron job), not
//   exposed as a public button anywhere in the UI. "url" is where a
//   click on the notification should open (handled by sw.js's
//   notificationclick handler) — defaults to the chat panel.
//   Subscriptions the push service reports as gone (HTTP 404/410 —
//   the user uninstalled, cleared data, etc.) are deleted from
//   push_subscriptions so the list doesn't grow stale forever.
//   (Was: POST /api/send-notification)
// =============================================================

import webpush from 'web-push';

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

async function handleGetPublicKey(req, res) {
  return res.status(200).json({ ok: true, publicKey: process.env.VAPID_PUBLIC_KEY || null });
}

async function handleSubscribe(req, res) {
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

async function listSubscriptions() {
  const r = await fetch(supabaseUrl('push_subscriptions?select=id,subscription'), { headers: supabaseHeaders() });
  if (!r.ok) throw new Error('Supabase read failed: ' + (await r.text()).slice(0, 300));
  return r.json();
}
async function deleteSubscription(id) {
  await fetch(supabaseUrl('push_subscriptions?id=eq.' + encodeURIComponent(id)), {
    method: 'DELETE', headers: supabaseHeaders(),
  });
}

async function handleSend(req, res) {
  // .trim() defensively — this project's Vercel env vars have twice now
  // (WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET) turned out to carry trailing
  // whitespace/newlines from being pasted into the dashboard, and
  // web-push's setVapidDetails() throws SYNCHRONOUSLY (uncaught, below)
  // if a key doesn't decode to exactly the expected byte length — which
  // a stray trailing newline would break.
  const publicKey = (process.env.VAPID_PUBLIC_KEY || '').trim();
  const privateKey = (process.env.VAPID_PRIVATE_KEY || '').trim();
  if (!publicKey || !privateKey) {
    return res.status(500).json({ error: 'missing VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY env vars — generate with `npx web-push generate-vapid-keys`' });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'missing SUPABASE_URL / SUPABASE_SERVICE_KEY' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const title = (body && body.title) || 'Row';
  const notifBody = (body && body.body) || '';
  const url = (body && body.url) || '/health.html?openChat=1';

  // Previously unguarded — a malformed VAPID key throws here synchronously,
  // outside every try/catch in this file, which crashes the whole function
  // with Vercel's own (non-JSON) error page instead of a JSON response.
  try {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:you@example.com', publicKey, privateKey);
  } catch (e) {
    return res.status(500).json({ error: 'invalid VAPID keys: ' + (e.message || String(e)) });
  }

  let rows;
  try {
    rows = await listSubscriptions();
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }

  let sent = 0, failed = 0, removed = 0;
  const payload = JSON.stringify({ title, body: notifBody, url });

  await Promise.all((Array.isArray(rows) ? rows : []).map(async (row) => {
    try {
      await webpush.sendNotification(row.subscription, payload);
      sent++;
    } catch (e) {
      failed++;
      if (e && (e.statusCode === 404 || e.statusCode === 410)) {
        removed++;
        try { await deleteSubscription(row.id); } catch (e2) {}
      }
    }
  }));

  return res.status(200).json({ ok: true, sent, failed, removed });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-dashboard-secret');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!checkAuth(req, res)) return;

  const action = req.query && req.query.action;

  if (req.method === 'GET' && !action) return handleGetPublicKey(req, res);
  if (req.method === 'POST' && action === 'subscribe') return handleSubscribe(req, res);
  if (req.method === 'POST' && action === 'send') return handleSend(req, res);

  return res.status(405).json({ error: 'method not allowed (GET for public key, POST ?action=subscribe or ?action=send)' });
}
