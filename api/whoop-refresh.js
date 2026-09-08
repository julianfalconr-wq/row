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
  // .trim() matters: WHOOP_CLIENT_ID/WHOOP_CLIENT_SECRET/WHOOP_REDIRECT_URI
  // have trailing whitespace in this project's actual Vercel env vars
  // (confirmed via debug logging when this same issue broke the initial
  // OAuth exchange in api/whoop-callback.js — fixed there but missed here).
  const clientId = (process.env.WHOOP_CLIENT_ID || '').trim();
  const clientSecret = (process.env.WHOOP_CLIENT_SECRET || '').trim();
  // WHOOP's own token endpoint returned "invalid_request" here even with a
  // live refresh token and correct client_id/secret, with an error_hint
  // pointing at redirect_uri whitelisting — WHOOP requires redirect_uri on
  // the refresh_token grant too, not just authorization_code, even though
  // that's not strictly required by the OAuth2 spec. api/whoop-callback.js
  // already sends this same (trimmed) value for the authorization_code
  // exchange; it was simply missing here.
  const redirectUri = (process.env.WHOOP_REDIRECT_URI || '').trim();
  if (!clientId || !clientSecret || !redirectUri) return res.status(500).json({ error: 'server not configured' });
  try {
    const form = new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: refresh, redirect_uri: redirectUri,
      client_id: clientId, client_secret: clientSecret, scope: 'offline',
    });
    const r = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    const text = await r.text();
    if (!r.ok) {
      // Logged explicitly (not just returned in the response body) so the
      // actual WHOOP error — e.g. invalid_grant for a dead/rotated refresh
      // token, vs. invalid_client for a credentials problem — is visible
      // in Vercel's function logs without having to inspect response
      // bodies. A dead refresh_token needs a real reconnect; nothing in
      // this file can recover from that on its own.
      console.error('[whoop-refresh] WHOOP token endpoint returned ' + r.status + ': ' + text);
      return res.status(500).json({ error: 'refresh failed: ' + text });
    }
    try { return res.status(200).json(JSON.parse(text)); }
    catch { return res.status(500).json({ error: 'non-JSON' }); }
  } catch (e) {
    return res.status(500).json({ error: 'fetch error: ' + (e.message || String(e)) });
  }
}
