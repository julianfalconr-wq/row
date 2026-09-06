export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const refresh = body && body.refresh_token;
  if (!refresh) return res.status(400).json({ error: 'refresh_token required' });
  // .trim() matters: WHOOP_CLIENT_ID/WHOOP_CLIENT_SECRET have trailing
  // whitespace in this project's actual Vercel env vars (confirmed via
  // debug logging when this same issue broke the initial OAuth exchange
  // in api/whoop-callback.js — fixed there but missed here, which is why
  // token refresh silently failed every time the access token expired).
  const clientId = (process.env.WHOOP_CLIENT_ID || '').trim();
  const clientSecret = (process.env.WHOOP_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) return res.status(500).json({ error: 'server not configured' });
  try {
    const form = new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: refresh,
      client_id: clientId, client_secret: clientSecret, scope: 'offline',
    });
    const r = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    const text = await r.text();
    if (!r.ok) return res.status(500).json({ error: 'refresh failed: ' + text });
    try { return res.status(200).json(JSON.parse(text)); }
    catch { return res.status(500).json({ error: 'non-JSON' }); }
  } catch (e) {
    return res.status(500).json({ error: 'fetch error: ' + (e.message || String(e)) });
  }
}
