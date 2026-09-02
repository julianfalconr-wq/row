// =============================================================
// WHOOP OAuth callback. WHOOP redirects here with ?code=...&state=...
// after the user approves access. This exchanges the code for an
// access_token + refresh_token server-side (the client_secret never
// reaches the browser) and stores them in the same Supabase
// app_state table the rest of the app already syncs through.
//
// Requires WHOOP_CLIENT_ID + WHOOP_CLIENT_SECRET env vars (see
// whoop-connect.js for where those come from).
// =============================================================

const REDIRECT_URI = 'https://row-phi-six.vercel.app/api/whoop-callback';
const TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';

// Same Supabase project already used by topbar.js / sync.js / gym.html.
const SUPABASE_URL = 'https://dfxjlneohhgfdussomou.supabase.co';
const SUPABASE_KEY = 'sb_publishable_9a1GD4OaqszZSnXW80PFTA_JvHi533e';

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i === -1) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
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
}

module.exports = async (req, res) => {
  const clientId = process.env.WHOOP_CLIENT_ID;
  const clientSecret = process.env.WHOOP_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    res.statusCode = 500;
    res.end('Missing WHOOP_CLIENT_ID / WHOOP_CLIENT_SECRET env vars on the server.');
    return;
  }

  const url = new URL(req.url, 'https://' + req.headers.host);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookies = parseCookies(req.headers.cookie);

  if (!code) {
    res.statusCode = 400;
    res.end('Missing ?code from WHOOP.');
    return;
  }
  if (!state || state !== cookies.whoop_oauth_state) {
    res.statusCode = 400;
    res.end('State mismatch — possible CSRF, or the login link expired. Try /api/whoop-connect again.');
    return;
  }

  try {
    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: REDIRECT_URI,
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.access_token) {
      res.statusCode = 502;
      res.end('WHOOP token exchange failed: ' + JSON.stringify(tokens));
      return;
    }

    await storeTokens(tokens);

    res.setHeader('Set-Cookie', 'whoop_oauth_state=; Path=/; HttpOnly; Max-Age=0');
    res.writeHead(302, { Location: '/index.html?whoop=connected' });
    res.end();
  } catch (e) {
    res.statusCode = 500;
    res.end('WHOOP callback error: ' + (e && e.message));
  }
};
