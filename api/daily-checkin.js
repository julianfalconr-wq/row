// =============================================================
// Daily proactive check-in. Triggered once a day by Vercel Cron
// (see vercel.json) — gathers what context it can, asks Claude for a
// brief insight, and pushes it as a notification via
// api/send-notification.js.
//
// IMPORTANT CONSTRAINT: there is no browser in a cron job, so this
// cannot call the client-side window.gatherTodayContext() (topbar.js)
// that the chat panel uses — that function reads localStorage (gym
// logs, finance, Daily Stack, WHOOP tokens) which only exists on the
// user's own device and is never synced to a server anywhere in this
// app. The only data this function can actually see is whatever has
// been synced to Supabase:
//   - app_state (key='cronometer') — the Cronometer nutrition cache
//     (via api/cronometer-data.js's manual "Sync now").
//   - chat_history — past conversations (via api/chat-history.js,
//     Part 1), used here only for light continuity, not as a data
//     source.
// Workouts, body weight, net worth, and today's Daily Stack
// completion are NOT visible here — they live only in the browser.
// If you want the daily check-in to reason about those too, the fix
// is upstream: sync them to Supabase from their respective pages the
// same way Cronometer/chat history already are, not something this
// file can work around on its own.
//
// Auth: Vercel automatically sends `Authorization: Bearer
// <CRON_SECRET>` on cron-triggered requests when a CRON_SECRET env
// var is set in the project — set one and this checks it. As a
// manual-testing fallback (so you can trigger this yourself between
// cron runs), a request with the usual ?secret=DASHBOARD_SECRET is
// also accepted.
//
// Requires: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY,
// DASHBOARD_SECRET (existing env vars), optionally CRON_SECRET (new —
// Vercel Project Settings -> Environment Variables; Vercel's Cron UI
// picks it up automatically once set, no extra config needed there).
// =============================================================

const SEND_NOTIFICATION_URL = 'https://row-phi-six.vercel.app/api/send-notification';

function supabaseHeaders() {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return { apikey: key, Authorization: `Bearer ${key}` };
}
function supabaseUrl(path) {
  return `${process.env.SUPABASE_URL}/rest/v1/${path}`;
}

function checkAuth(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers['authorization'] || '';
  if (cronSecret && authHeader === 'Bearer ' + cronSecret) return true;

  const dashboardSecret = process.env.DASHBOARD_SECRET;
  const given = (req.query && req.query.secret) || req.headers['x-dashboard-secret'];
  if (dashboardSecret && given === dashboardSecret) return true;

  res.status(401).json({ error: 'unauthorized' });
  return false;
}

async function loadCronometerCache() {
  try {
    const r = await fetch(supabaseUrl('app_state?key=eq.cronometer&select=data,updated_at'), { headers: supabaseHeaders() });
    if (!r.ok) return null;
    const rows = await r.json();
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch (e) { return null; }
}

async function loadRecentChatDay() {
  try {
    const r = await fetch(supabaseUrl('chat_history?select=date,messages&order=date.desc&limit=1'), { headers: supabaseHeaders() });
    if (!r.ok) return null;
    const rows = await r.json();
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch (e) { return null; }
}

function turnText(turn) {
  if (!turn) return '';
  if (typeof turn.content === 'string') return turn.content;
  if (Array.isArray(turn.content)) {
    const b = turn.content.find((x) => x && x.type === 'text');
    return b ? b.text : '';
  }
  return '';
}

async function askClaudeForInsight(context) {
  const system =
    'You write a single short proactive push-notification message for a personal health dashboard ' +
    '(Row). Given the context below, write ONE brief, warm, specific insight or nudge — 1-2 sentences, ' +
    'under 160 characters total, no greeting, no sign-off, plain text only (no markdown, no emoji ' +
    'required). If the context is too thin to say anything specific and useful, write a short generic ' +
    'friendly nudge to log today\'s data instead of inventing numbers you don\'t have.\n\n' +
    'CONTEXT:\n' + JSON.stringify(context, null, 2);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 200,
      system,
      messages: [{ role: 'user', content: 'Write today\'s check-in message.' }],
    }),
  });
  if (!res.ok) throw new Error('Anthropic API error (' + res.status + '): ' + (await res.text()).slice(0, 300));
  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  return textBlock ? textBlock.text.trim() : null;
}

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'missing ANTHROPIC_API_KEY' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'missing SUPABASE_URL / SUPABASE_SERVICE_KEY' });
  }
  if (!process.env.DASHBOARD_SECRET) return res.status(500).json({ error: 'missing DASHBOARD_SECRET' });

  try {
    const [cronoRow, chatRow] = await Promise.all([loadCronometerCache(), loadRecentChatDay()]);

    const context = {
      cronometerLastSynced: cronoRow ? cronoRow.updated_at : null,
      cronometerRowCount: cronoRow && cronoRow.data && Array.isArray(cronoRow.data.rows) ? cronoRow.data.rows.length : 0,
      recentChatDate: chatRow ? chatRow.date : null,
      recentChatLastUserMessage: chatRow
        ? (chatRow.messages || []).filter((t) => t.role === 'user' && typeof t.content === 'string').slice(-1).map((t) => t.content)[0] || null
        : null,
      note: 'Workouts, body weight, net worth, and Daily Stack completion are not available here — see this file\'s header comment.',
    };

    const message = await askClaudeForInsight(context);
    if (!message) return res.status(502).json({ error: 'Claude returned no insight text' });

    const sendRes = await fetch(SEND_NOTIFICATION_URL + '?secret=' + encodeURIComponent(process.env.DASHBOARD_SECRET), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Row', body: message, url: '/health.html?openChat=1' }),
    });
    const sendJson = await sendRes.json().catch(() => ({}));

    return res.status(200).json({ ok: true, message, sendResult: sendJson });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}
