// =============================================================
// Starts the WHOOP OAuth flow. Visit /api/whoop-connect to begin —
// it redirects to WHOOP's login/consent screen. On approval, WHOOP
// redirects back to /api/whoop-callback with a one-time code.
//
// Requires these env vars set in Vercel (Project Settings -> Environment
// Variables), then redeploy:
//   WHOOP_CLIENT_ID
//   WHOOP_CLIENT_SECRET   (used by whoop-callback.js / whoop-refresh.js)
// =============================================================

const REDIRECT_URI = 'https://row-phi-six.vercel.app/api/whoop-callback';
const SCOPES = [
  'read:recovery',
  'read:cycles',
  'read:workout',
  'read:sleep',
  'read:profile',
  'read:body_measurement',
  'offline',
].join(' ');

function randomState(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

module.exports = (req, res) => {
  const clientId = process.env.WHOOP_CLIENT_ID;
  if (!clientId) {
    res.statusCode = 500;
    res.end('Missing WHOOP_CLIENT_ID env var on the server.');
    return;
  }

  const state = randomState(8);
  res.setHeader('Set-Cookie', `whoop_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);

  const url = new URL('https://api.prod.whoop.com/oauth/oauth2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', state);

  res.writeHead(302, { Location: url.toString() });
  res.end();
};
