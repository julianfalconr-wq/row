// =============================================================
// Pulls YOUR Cronometer diary/biometrics data using Cronometer's
// internal (UNOFFICIAL, undocumented) web-app API — the same
// endpoints their own website uses internally for its CSV export
// feature. Cronometer has no public developer API, so this mimics
// the requests the browser makes when you click "Export" on
// cronometer.com. Because it depends on undocumented internals:
//   - It WILL break if/when Cronometer updates their app (the
//     GWT_PERMUTATION / GWT_HEADER constants below go stale).
//   - It is outside Cronometer's intended/supported use.
//   - Cronometer caps exports at ~10/day per account — this
//     function counts against that budget every time it's called.
// Use at your own risk, for your own personal data only.
//
// Requires these env vars set in Vercel (Project Settings ->
// Environment Variables), then redeploy:
//   CRONOMETER_USERNAME   your Cronometer login email
//   CRONOMETER_PASSWORD   your Cronometer password
//   DASHBOARD_SECRET      any random string you make up — required
//                          as a query param so randoms who find this
//                          URL can't trigger logins against your
//                          account / burn your daily export quota.
//
// Call it as:
//   /api/cronometer-data?secret=YOUR_SECRET&type=dailySummary&days=7
//   type: dailySummary | servings | biometrics | exercises | notes
// Returns: raw CSV (text/csv) as Cronometer generates it.
// =============================================================

const LOGIN_PAGE_URL = 'https://cronometer.com/login/';
const LOGIN_URL = 'https://cronometer.com/login';
const GWT_URL = 'https://cronometer.com/cronometer/app';
const EXPORT_URL = 'https://cronometer.com/export';
const GWT_MODULE_BASE = 'https://cronometer.com/cronometer/';

// These two values come from Cronometer's own web-app bundle (found by
// inspecting a request from the site in devtools -> Network). They change
// whenever Cronometer ships a front-end update. If this endpoint starts
// failing at the "GWT authenticate" step, this is the first thing to
// refresh: open cronometer.com, log in, watch the Network tab for a
// POST to /cronometer/app, and copy the new x-gwt-permutation header
// value and the hash that appears right after your session nonce in
// the request body.
const GWT_PERMUTATION = '7B121DC5483BF272B1BC1916DA9FA963';
const GWT_HEADER = '2D6A926E3729946302DC68073CB0D550';

const ALLOWED_TYPES = ['dailySummary', 'servings', 'biometrics', 'exercises', 'notes'];

function gwtGenerateAuthToken(sesnonce, userId) {
  return (
    `7|0|8|${GWT_MODULE_BASE}|${GWT_HEADER}|com.cronometer.shared.rpc.CronometerService|generateAuthorizationToken` +
    `|java.lang.String/2004016611|I|com.cronometer.shared.user.AuthScope/2065601159|${sesnonce}|1|2|3|4|4|5|6|6|7|8|${userId}|3600|7|2|`
  );
}

const GWT_AUTHENTICATE =
  `7|0|5|${GWT_MODULE_BASE}|${GWT_HEADER}|com.cronometer.shared.rpc.CronometerService|authenticate|java.lang.Integer/3438268394|1|2|3|4|1|5|5|-300|`;

function getSetCookies(response) {
  if (typeof response.headers.getSetCookie === 'function') {
    return response.headers.getSetCookie();
  }
  const single = response.headers.get('set-cookie');
  return single ? [single] : [];
}

function mergeCookies(jar, setCookieHeaders) {
  for (const c of setCookieHeaders) {
    const m = c.match(/^([^=]+)=([^;]+)/);
    if (m) jar[m[1].trim()] = m[2].trim();
  }
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const dashboardSecret = process.env.DASHBOARD_SECRET;
  if (!dashboardSecret || (req.query && req.query.secret) !== dashboardSecret) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const username = process.env.CRONOMETER_USERNAME;
  const password = process.env.CRONOMETER_PASSWORD;
  if (!username || !password) {
    return res.status(500).json({ error: 'server not configured (missing CRONOMETER_USERNAME/CRONOMETER_PASSWORD env vars)' });
  }

  const type = (req.query && req.query.type) || 'dailySummary';
  if (!ALLOWED_TYPES.includes(type)) {
    return res.status(400).json({ error: 'invalid type, must be one of: ' + ALLOWED_TYPES.join(', ') });
  }
  const days = Math.max(1, Math.min(parseInt((req.query && req.query.days) || '7', 10) || 7, 90));
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);

  const jar = {};

  try {
    // 1. Load the login page and pull the anti-CSRF token out of the form.
    const loginPageRes = await fetch(LOGIN_PAGE_URL);
    mergeCookies(jar, getSetCookies(loginPageRes));
    const loginPageHtml = await loginPageRes.text();
    const csrfMatch = loginPageHtml.match(/name=["']anticsrf["'][^>]*value=["']([^"']+)["']/);
    if (!csrfMatch) {
      return res.status(502).json({ error: 'could not find anticsrf token on the Cronometer login page — they may have changed it' });
    }
    const anticsrf = csrfMatch[1];

    // 2. Log in with the stored credentials.
    const loginBody = new URLSearchParams({ anticsrf, username, password });
    const loginRes = await fetch(LOGIN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(jar) },
      body: loginBody.toString(),
    });
    mergeCookies(jar, getSetCookies(loginRes));
    let loginJson = null;
    try {
      loginJson = JSON.parse(await loginRes.text());
    } catch (e) {
      return res.status(502).json({ error: 'unexpected (non-JSON) login response from Cronometer' });
    }
    if (!loginJson || loginJson.error) {
      return res.status(401).json({ error: 'Cronometer login failed: ' + ((loginJson && loginJson.error) || 'unknown error') });
    }
    if (!jar.sesnonce) {
      return res.status(502).json({ error: 'login succeeded but no session cookie was returned' });
    }

    // 3. Authenticate against the GWT API to get a numeric user id.
    const authRes = await fetch(GWT_URL, {
      method: 'POST',
      headers: {
        'content-type': 'text/x-gwt-rpc; charset=UTF-8',
        'x-gwt-module-base': GWT_MODULE_BASE,
        'x-gwt-permutation': GWT_PERMUTATION,
        Cookie: cookieHeader(jar),
      },
      body: GWT_AUTHENTICATE,
    });
    mergeCookies(jar, getSetCookies(authRes));
    const authText = await authRes.text();
    const userMatch = authText.match(/OK\[(\d+),/);
    if (!userMatch) {
      return res.status(502).json({ error: 'GWT authenticate step failed — Cronometer likely changed their internal API (GWT_PERMUTATION/GWT_HEADER need updating)' });
    }
    const userId = userMatch[1];

    // 4. Generate a short-lived export auth token.
    const tokenRes = await fetch(GWT_URL, {
      method: 'POST',
      headers: {
        'content-type': 'text/x-gwt-rpc; charset=UTF-8',
        'x-gwt-module-base': GWT_MODULE_BASE,
        'x-gwt-permutation': GWT_PERMUTATION,
        Cookie: cookieHeader(jar),
      },
      body: gwtGenerateAuthToken(jar.sesnonce, userId),
    });
    const tokenText = await tokenRes.text();
    const tokenMatch = tokenText.match(/"([^"]+)"/);
    if (!tokenMatch) {
      return res.status(502).json({ error: 'could not generate an export token from Cronometer' });
    }
    const exportToken = tokenMatch[1];

    // 5. Request the actual CSV export.
    const exportUrl = new URL(EXPORT_URL);
    exportUrl.searchParams.set('nonce', exportToken);
    exportUrl.searchParams.set('generate', type);
    exportUrl.searchParams.set('start', fmtDate(start));
    exportUrl.searchParams.set('end', fmtDate(end));
    const csvRes = await fetch(exportUrl.toString(), { headers: { Cookie: cookieHeader(jar) } });
    const csvText = await csvRes.text();
    if (!csvRes.ok) {
      return res.status(502).json({ error: 'export request failed', status: csvRes.status, body: csvText.slice(0, 500) });
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(csvText);
  } catch (e) {
    return res.status(500).json({ error: 'unexpected error: ' + (e.message || String(e)) });
  }
}
