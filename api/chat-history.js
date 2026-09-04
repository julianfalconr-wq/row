// =============================================================
// Persistent chat history archive. Supabase becomes the source of
// truth for past days; localStorage (chat_history_v1, in topbar.js)
// stays as today's fast local cache only.
//
// Requires this table in Supabase (SQL editor):
//   create table chat_history (
//     date text primary key,
//     messages jsonb not null,
//     updated_at timestamptz not null default now()
//   );
//
// Uses the same env vars as the rest of the app's server functions:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY, DASHBOARD_SECRET
//
// Auth: DASHBOARD_SECRET as either header x-dashboard-secret or a
// ?secret= query param (same as api/chat.js and the Cronometer/food
// endpoints).
//
// GET  /api/chat-history?secret=...                  -> list of past
//   days: [{ date, messageCount, preview }, ...], most recent first.
//   "preview" is the first ~80 chars of the first real user message
//   that day (skipping memory-tool plumbing turns).
// GET  /api/chat-history?secret=...&date=YYYY-MM-DD   -> that day's
//   full messages array, verbatim as stored (same raw Anthropic
//   content shape topbar.js already knows how to render).
// POST /api/chat-history?secret=...  { date, messages }  -> upsert.
// =============================================================

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

// Same convention topbar.js's contentToText() uses: pull the display
// text out of either a plain string (user turns) or an Anthropic
// content-block array (assistant turns) — skip tool_result plumbing.
function turnText(turn) {
  if (!turn) return '';
  if (typeof turn.content === 'string') return turn.content;
  if (Array.isArray(turn.content)) {
    const block = turn.content.find((b) => b && b.type === 'text');
    return block ? block.text : '';
  }
  return '';
}

function buildPreview(messages) {
  const firstUser = (messages || []).find((t) => t.role === 'user' && typeof t.content === 'string');
  const text = firstUser ? firstUser.content : ((messages || []).map(turnText).find((t) => t) || '');
  return text.length > 80 ? text.slice(0, 80) + '…' : text;
}

async function listDays() {
  const res = await fetch(
    supabaseUrl('chat_history?select=date,messages&order=date.desc&limit=200'),
    { headers: supabaseHeaders() }
  );
  if (!res.ok) throw new Error('Supabase list failed: ' + (await res.text()).slice(0, 300));
  const rows = await res.json();
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    date: r.date,
    messageCount: Array.isArray(r.messages) ? r.messages.length : 0,
    preview: buildPreview(r.messages),
  }));
}

async function getDay(date) {
  const res = await fetch(
    supabaseUrl('chat_history?date=eq.' + encodeURIComponent(date) + '&select=messages'),
    { headers: supabaseHeaders() }
  );
  if (!res.ok) throw new Error('Supabase read failed: ' + (await res.text()).slice(0, 300));
  const rows = await res.json();
  return Array.isArray(rows) && rows[0] ? rows[0].messages : [];
}

async function upsertDay(date, messages) {
  const res = await fetch(supabaseUrl('chat_history?on_conflict=date'), {
    method: 'POST',
    headers: { ...supabaseHeaders(), Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify([{ date, messages, updated_at: new Date().toISOString() }]),
  });
  if (!res.ok) throw new Error('Supabase write failed: ' + (await res.text()).slice(0, 300));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-dashboard-secret');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!checkAuth(req, res)) return;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'missing SUPABASE_URL / SUPABASE_SERVICE_KEY' });
  }

  if (req.method === 'GET') {
    const date = req.query && req.query.date;
    try {
      if (date) {
        const messages = await getDay(date);
        return res.status(200).json({ ok: true, date, messages });
      }
      const days = await listDays();
      return res.status(200).json({ ok: true, days });
    } catch (e) {
      return res.status(500).json({ error: e.message || String(e) });
    }
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const date = body && body.date;
    const messages = body && body.messages;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'body.date must be YYYY-MM-DD' });
    }
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: 'body.messages must be an array' });
    }
    try {
      await upsertDay(date, messages);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message || String(e) });
    }
  }

  return res.status(405).json({ error: 'method not allowed' });
}
