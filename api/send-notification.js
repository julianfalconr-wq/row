// =============================================================
// Sends a web push notification to every stored subscription.
// Gated by DASHBOARD_SECRET — meant to be called by api/daily-checkin.js
// (the cron job), not exposed as a public button anywhere in the UI.
//
// Requires the web-push npm package (see package.json) and:
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY  — see api/push-subscribe.js's
//   header comment for how to generate these with
//   `npx web-push generate-vapid-keys`.
//   VAPID_SUBJECT (optional) — a "mailto:you@example.com" or
//   "https://your-site" contact string the push services (FCM/APNs/
//   Mozilla) may show if something's wrong with your usage. Defaults
//   to a placeholder below — set the env var to your own contact.
//
// POST /api/send-notification?secret=...  { title, body, url }
//   -> { ok: true, sent, failed, removed }
//   "url" is where a click on the notification should open (handled
//   by sw.js's notificationclick handler) — defaults to the chat panel.
//
// Subscriptions that the push service reports as gone (HTTP 404/410 —
// the user uninstalled, cleared data, etc.) are deleted from
// push_subscriptions so the list doesn't grow stale forever.
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  if (!checkAuth(req, res)) return;

  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
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

  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:you@example.com', publicKey, privateKey);

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
