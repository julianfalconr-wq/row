// =============================================================
// Refreshes the stored WHOOP access token using the saved
// refresh_token. WHOOP access tokens expire quickly (~1hr), so
// call this (from a page, or a Vercel Cron hitting this URL)
// before making WHOOP API requests whenever the stored token is
// close to expiry.
//
// GET /api/whoop-refresh -> { ok: true, expires_at }
// =============================================================

const TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const SUPABASE_URL = 'https://dfxjlneohhgfdussomou.supabase.co';
const SUPABASE_KEY = 'sb_publishable_9a1GD4OaqszZSnXW80PFTA_JvHi533e';

async function loadTokens() {
  const res = await fetch(
    SUPABASE_URL + '/rest/v1/app_state?key=eq.whoop_tokens&select=data',
    { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY } }
  );
  const rows = await res.json();
  return rows && rows[0] && rows[0].data;
}

async function storeTokens(tokens) {
  const expiresAt = Date.now() + (tokens.expires_in || 0) * 1000;
  const data = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: expiresAt,
  };
  await fetch(SUPABASE_URL + '/rest/v1/app_state?on_conflict=key', {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ key: 'whoop_tokens', data, updated_at: new Date().toISOString() }),
  });
  return expiresAt;
}

module.exports = async (req, res) => {
  const clientId = process.env.WHOOP_CLIENT_ID;
  const clientSecret = process.env.WHOOP_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: 'Missing WHOOP_CLIENT_ID / WHOOP_CLIENT_SECRET env vars.' }));
    return;
  }

  try {
    const current = await loadTokens();
    if (!current || !current.refresh_token) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: 'No stored WHOOP tokens yet — visit /api/whoop-connect first.' }));
      return;
    }

    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: current.refresh_token,
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'offline',
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.access_token) {
      res.statusCode = 502;
      res.end(JSON.stringify({ ok: false, error: 'WHOOP refresh failed', detail: tokens }));
      return;
    }

    const expiresAt = await storeTokens(tokens);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, expires_at: expiresAt }));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: e && e.message }));
  }
};
