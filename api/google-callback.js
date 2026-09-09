// =============================================================
// Google Calendar OAuth callback + refresh + calendar proxy, merged
// into ONE file. Two reasons for the merge, not just one:
//   1. The redirect URI registered in Google Cloud Console is fixed
//      to exactly https://row-phi-six.vercel.app/api/google-callback
//      (must match byte-for-byte), so the OAuth landing MUST live at
//      this literal file path — Vercel's file-based routing maps it
//      directly, no way to alias it elsewhere.
//   2. Vercel's Hobby plan caps a deployment at 12 Serverless
//      Functions (see api/training.js and api/push.js's header
//      comments for the same constraint hitting this project twice
//      already). Since the OAuth-landing file is fixed at this path
//      anyway, folding refresh + the calendar proxy in here (instead
//      of 3 separate files, which is what mirroring WHOOP's literal
//      file layout would need) keeps the new Google feature to a
//      single new function.
// Despite being one file, this mirrors WHOOP's OAuth structure and
// its hard-won lessons exactly: every env var is .trim()'d from the
// start (not discovered the hard way like WHOOP_CLIENT_ID/
// WHOOP_REDIRECT_URI's trailing whitespace), client_secret goes in
// the POST body (client_secret_post) matching WHOOP's final working
// method, and every parameter name below was confirmed directly
// against Google's own current OAuth2 + Calendar API docs rather than
// assumed from WHOOP's shape — importantly, Google's refresh_token
// grant does NOT take redirect_uri (unlike WHOOP's, which surprised
// us once already), so it is deliberately omitted from the refresh
// request below.
//
// Requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (Vercel env vars,
// already set). The redirect URI itself has no env var — it's a
// literal constant here (matching the one hardcoded client-side in
// main.html's OAuth URL builder) since Google requires an exact
// byte-for-byte match and there's nothing to gain from routing it
// through an env var that could pick up the same kind of trailing
// whitespace WHOOP_REDIRECT_URI once had.
//
// MODE 0 — GET /api/google-callback?action=client-id&secret=...
//   -> { ok: true, clientId: <GOOGLE_CLIENT_ID or null> }
//   Lets main.html build the OAuth authorize URL client-side (see
//   Mode 1) without the literal client_id ever being hardcoded in the
//   page source — client_id is not a secret, this is gated by
//   DASHBOARD_SECRET only for consistency with api/push.js's GET.
//
// MODE 1 — GET /api/google-callback?code=...
//   Google's own OAuth redirect lands here with an authorization code.
//   Exchanges it for tokens, then redirects to
//   /main.html#google_access=...&google_refresh=...&google_expires=...
//   (same hash-handoff pattern api/whoop-callback.js uses for
//   health.html) so the token never appears in server logs or a GET
//   query string on the client side.
//
// MODE 2 — POST /api/google-callback?action=refresh  { refresh_token }
//   -> the raw Google token response (access_token, expires_in, ...)
//   Mirrors api/whoop-refresh.js's contract exactly.
//
// MODE 3 — GET /api/google-callback?action=list&timeMin=...&timeMax=...
//   Header: Authorization: Bearer <access_token>
//   Proxies to GET .../calendars/primary/events with singleEvents=true
//   and orderBy=startTime always applied server-side (so the client
//   only needs to supply the time bounds) — mirrors api/whoop-data.js's
//   generic-proxy shape (forward the bearer token, return the raw
//   response) rather than reimplementing calendar-specific logic here.
//
// MODE 4 — POST /api/google-callback?action=create
//   Header: Authorization: Bearer <access_token>
//   Body: { summary, description, start, end } — start/end are
//   {dateTime, timeZone} or {date} exactly as the client already
//   builds them (see main.html), passed straight through.
//   Proxies to POST .../calendars/primary/events.
// =============================================================

const GOOGLE_REDIRECT_URI = 'https://row-phi-six.vercel.app/api/google-callback';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

function getClientCreds() {
  return {
    clientId: (process.env.GOOGLE_CLIENT_ID || '').trim(),
    clientSecret: (process.env.GOOGLE_CLIENT_SECRET || '').trim(),
  };
}

function checkDashboardSecret(req, res) {
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

// ---------- MODE 0: expose the (non-secret) client_id ----------
// client_id is meant to be public per the OAuth spec — it appears in
// the plain-text authorization URL regardless — but main.html builds
// that URL client-side (matching health.html's WHOOP connect button,
// which does the same rather than round-tripping through a server
// redirect endpoint) and never received the literal value, only
// confirmation that GOOGLE_CLIENT_ID is set in Vercel. Gated by
// DASHBOARD_SECRET anyway, matching api/push.js's GET (which exposes
// the similarly non-secret VAPID public key the same way) for
// consistency rather than because client_id strictly needs it.
async function handleClientId(req, res) {
  if (!checkDashboardSecret(req, res)) return;
  const { clientId } = getClientCreds();
  return res.status(200).json({ ok: true, clientId: clientId || null });
}

// ---------- MODE 1: OAuth callback ----------
async function handleOAuthCallback(req, res) {
  const code = req.query && req.query.code;
  if (req.query && req.query.error) return res.status(400).send('Google auth error: ' + req.query.error);
  if (!code) return res.status(400).send('Missing code parameter.');

  const { clientId, clientSecret } = getClientCreds();
  if (!clientId || !clientSecret) {
    return res.status(500).send('Server not configured (missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env vars).');
  }

  try {
    // Confirmed against Google's OAuth2 web-server docs: client_secret
    // in the body (not Basic auth), redirect_uri REQUIRED here (must
    // match the value used in the authorization request exactly).
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: GOOGLE_REDIRECT_URI,
      client_id: clientId,
      client_secret: clientSecret,
    });
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const text = await tokenRes.text();
    if (!tokenRes.ok) {
      console.error('[google-callback] token exchange failed: ' + tokenRes.status + ': ' + text);
      return res.status(500).send('Google token exchange failed: ' + text);
    }
    let json;
    try { json = JSON.parse(text); } catch { return res.status(500).send('Non-JSON: ' + text); }

    const access = json.access_token || '';
    const refresh = json.refresh_token || '';
    const expiresIn = json.expires_in || 3600;
    if (!refresh) {
      // Google only returns a refresh_token on the FIRST consent for a
      // given client+scope combination unless prompt=consent forces it
      // every time — main.html's connect URL always sets prompt=consent
      // specifically so this shouldn't happen, but if it does, surface
      // it clearly rather than silently caching an access-only session
      // that goes dead in an hour with no way to refresh.
      console.error('[google-callback] no refresh_token in response — prompt=consent may be missing from the connect URL');
    }
    const hash = new URLSearchParams({
      google_access: access,
      google_refresh: refresh,
      google_expires: String(Date.now() + expiresIn * 1000),
    }).toString();
    res.writeHead(302, { Location: '/main.html#' + hash });
    res.end();
  } catch (e) {
    res.status(500).send('Unexpected: ' + (e.message || String(e)));
  }
}

// ---------- MODE 2: refresh ----------
async function handleRefresh(req, res) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const refresh = body && body.refresh_token;
  if (!refresh) return res.status(400).json({ error: 'refresh_token required' });

  const { clientId, clientSecret } = getClientCreds();
  if (!clientId || !clientSecret) return res.status(500).json({ error: 'server not configured' });

  try {
    // Confirmed against Google's docs: NO redirect_uri on this grant
    // type (unlike WHOOP's refresh, which surprisingly does need it —
    // do not copy that quirk here without re-checking, the two
    // providers genuinely differ on this point).
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: clientId,
      client_secret: clientSecret,
    });
    const r = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    const text = await r.text();
    if (!r.ok) {
      console.error('[google-callback refresh] Google token endpoint returned ' + r.status + ': ' + text);
      return res.status(500).json({ error: 'refresh failed: ' + text });
    }
    try { return res.status(200).json(JSON.parse(text)); }
    catch { return res.status(500).json({ error: 'non-JSON' }); }
  } catch (e) {
    return res.status(500).json({ error: 'fetch error: ' + (e.message || String(e)) });
  }
}

// ---------- MODE 3: list events (proxy) ----------
async function handleListEvents(req, res) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'missing bearer token' });

  const timeMin = (req.query && req.query.timeMin) || new Date().toISOString();
  const timeMax = req.query && req.query.timeMax;
  const params = new URLSearchParams({ timeMin, singleEvents: 'true', orderBy: 'startTime', maxResults: '50' });
  if (timeMax) params.set('timeMax', timeMax);

  try {
    const r = await fetch(CALENDAR_EVENTS_URL + '?' + params.toString(), {
      headers: { Authorization: auth, Accept: 'application/json' },
    });
    const text = await r.text();
    res.status(r.status).setHeader('Content-Type', 'application/json');
    return res.send(text);
  } catch (e) {
    return res.status(500).json({ error: 'proxy fetch failed: ' + (e.message || String(e)) });
  }
}

// ---------- MODE 4: create event (proxy) ----------
async function handleCreateEvent(req, res) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'missing bearer token' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const summary = body && body.summary;
  const start = body && body.start;
  const end = body && body.end;
  if (!summary || !start || !end) {
    return res.status(400).json({ error: 'expected { summary, start, end } — start/end are {dateTime, timeZone} or {date}' });
  }
  const eventBody = { summary, start, end };
  if (body.description) eventBody.description = body.description;

  try {
    const r = await fetch(CALENDAR_EVENTS_URL, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(eventBody),
    });
    const text = await r.text();
    res.status(r.status).setHeader('Content-Type', 'application/json');
    return res.send(text);
  } catch (e) {
    return res.status(500).json({ error: 'proxy fetch failed: ' + (e.message || String(e)) });
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const action = req.query && req.query.action;

  // No ?action and a `code` param -> this is Google's own OAuth redirect,
  // not a normal API call, so it gets no CORS/auth gate beyond Google's
  // own code — matches api/whoop-callback.js exactly.
  if (req.method === 'GET' && !action) return handleOAuthCallback(req, res);
  if (req.method === 'GET' && action === 'client-id') return handleClientId(req, res);
  if (req.method === 'POST' && action === 'refresh') return handleRefresh(req, res);
  if (req.method === 'GET' && action === 'list') return handleListEvents(req, res);
  if (req.method === 'POST' && action === 'create') return handleCreateEvent(req, res);

  return res.status(405).json({ error: 'method not allowed' });
}
