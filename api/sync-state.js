// =============================================================
// Generic endpoint for syncing compact, SUMMARIZED snapshots of
// gym / finance / Daily Stack data into the existing app_state
// table, so api/daily-checkin.js (which has no browser and can't
// read localStorage) has something to reason about for those areas.
// This is a cache for a daily proactive message, not a data
// warehouse — callers are expected to send small summaries, the
// same "summarized, not dumped" shape gatherTodayContext() already
// uses for the live chat.
//
// IMPORTANT — key collision avoidance: finance.html and health.html's
// Daily Stack section already write to this SAME app_state table via
// sync.js's generic initCloudSync(), under key='finance' and
// key='health' respectively — but for a completely different purpose
// (mirroring their RAW localStorage across devices, full fidelity).
// To avoid clobbering that existing feature, this endpoint does a
// MERGE upsert: it reads whatever's already in the target row and
// writes the new summary into a dedicated "dailyCheckinSummary"
// sub-field, leaving any existing top-level fields in that row
// untouched. daily-checkin.js reads row.data.dailyCheckinSummary
// specifically, not the whole row.
//
// Uses the same env vars every other server function here already
// does: SUPABASE_URL, SUPABASE_SERVICE_KEY, DASHBOARD_SECRET.
//
// POST /api/sync-state?secret=...  { key: "gym"|"finance"|"dailystack", data: {...} }
//   "key" must be exactly one of the three above — anything else is
//   rejected (400), so this can't be used to write arbitrary
//   app_state rows.
//
// -------------------------------------------------------------
// habit tracker (Part 2/3 of the daily-score feature) — folded into
// this file rather than a new api/habit-config.js, because Vercel's
// Hobby plan caps a project at 12 serverless functions and this repo
// is already at exactly 12 (see the other files in api/). Same
// consolidation call already made for api/push.js and
// api/google-callback.js earlier in this project. Dispatched by a
// `resource` param so the plain { key, data } shape above (used by
// gym.html/health.html/finance.html) is completely untouched.
//
// Requires these two NEW tables in Supabase (SQL editor) — the
// feature has no fallback if they don't exist yet, so create them
// before using it:
//   create table habit_config (
//     id text primary key,
//     data jsonb not null,
//     updated_at timestamptz not null default now()
//   );
//   create table daily_habits (
//     date text primary key,
//     entries jsonb not null,
//     updated_at timestamptz not null default now()
//   );
//
// GET  /api/sync-state?secret=...&resource=habit-config
//   -> { ok:true, config: {...} | null }  (null if never saved yet —
//      caller falls back to its own built-in defaults)
// POST /api/sync-state?secret=...  { resource: "habit-config", config: {...} }
//   -> upserts habit_config's single row (id: "config")
//
// GET  /api/sync-state?secret=...&resource=daily-habits&date=YYYY-MM-DD
//   -> { ok:true, entries: {...} | null }  one day's manual-habit entries
// GET  /api/sync-state?secret=...&resource=daily-habits&from=YYYY-MM-DD&to=YYYY-MM-DD
//   -> { ok:true, days: [{ date, entries }, ...] }  inclusive range,
//      for the weekly-cap running count and the weekly score
// POST /api/sync-state?secret=...  { resource: "daily-habits", date, entries }
//   -> upserts one daily_habits row (date must be YYYY-MM-DD; caller
//      is responsible for computing that key with LOCAL date logic,
//      not UTC — see main.html's activeDateKey())
//
// -------------------------------------------------------------
// general settings (day-end time + timezone + Level-1 category
// weights — see daylib.js and main.html's General Settings modal).
// Reuses the SAME habit_config table as a second row (id: "general",
// alongside habit-config's own id: "config") rather than a third new
// table — the schema (id/data/updated_at) is already generic enough,
// and this keeps the Supabase footprint from growing every time a new
// small settings blob is needed.
//
// GET  /api/sync-state?secret=...&resource=general-settings
//   -> { ok:true, settings: {...} | null }  (null if never saved —
//      caller falls back to daylib.js's DEFAULT_PROFILE)
// POST /api/sync-state?secret=...  { resource: "general-settings", settings: {...} }
//   -> upserts habit_config's "general" row
//
// -------------------------------------------------------------
// activity-types (Training/Activities generalization, Phase 1) — the
// configurable list of loggable cardio/other activity types (Running,
// Cycling, Swimming, ...), each with a unit/unitKind for its logging
// form and a "recommendable" toggle so This week's objectives/Today's
// session (api/training.js) know which types they're allowed to
// suggest. Reuses habit_config as a third row (id: "activityTypes"),
// same reasoning as general-settings reusing it as "general" — no new
// table needed, and this project is already at Vercel's Hobby-plan
// 12-function cap so this MUST live in this file, not a new one.
//
// Unlike habit-config/general-settings (a single object blob), this
// row's data is a plain ARRAY (the list itself), since there's no
// other per-user field to nest it under.
//
// GET  /api/sync-state?secret=...&resource=activity-types
//   -> { ok:true, types: [...] | null }  (null if never saved yet —
//      caller falls back to its own built-in default: just Running)
// POST /api/sync-state?secret=...  { resource: "activity-types", types: [...] }
//   -> upserts habit_config's "activityTypes" row
//
// -------------------------------------------------------------
// active_restrictions — lets the chat's propose_restriction tool (see
// api/chat.js) tell all three training AI features (weekly objectives,
// Today's session, Plan my day) about a temporary constraint ("no
// running this week", "no padel — recovering from a knee thing") once,
// instead of each needing to be told separately. A brand new small
// table, not folded into habit_config, since its shape (a date-ranged
// list, not a single blob) doesn't fit that table's id/data/updated_at
// generic-row model.
//
// Requires this NEW table in Supabase (SQL editor) — same as
// habit_config/daily_habits above, no fallback if it doesn't exist:
//   create table active_restrictions (
//     id text primary key,
//     text text not null,
//     scope text,
//     starts_on text not null,
//     ends_on text not null,
//     created_at timestamptz not null default now()
//   );
//
// "Active as of" is always a date the CLIENT computed (DayLib.
// effectiveDateKey()) and passes in — this file has no timezone
// concept of its own, matching daily-habits' date/from/to params
// above, so there's no new date-boundary logic to get wrong here.
//
// GET  /api/sync-state?secret=...&resource=restrictions&asOf=YYYY-MM-DD
//   -> { ok:true, restrictions: [{id,text,scope,starts_on,ends_on}, ...] }
//      only rows where starts_on <= asOf <= ends_on (a plain string
//      range filter — YYYY-MM-DD sorts and compares correctly as text)
// POST /api/sync-state?secret=...  { resource: "restrictions", action: "create", restriction: { text, scope, starts_on, ends_on } }
//   -> { ok:true, restriction: {...} }  (id generated server-side)
// POST /api/sync-state?secret=...  { resource: "restrictions", action: "end", id: "..." }
//   -> { ok:true }  deletes the row (ending early — no separate
//      "ended" state to track, and nothing in this feature reads
//      restriction history, so a delete is simpler than an update)
// =============================================================

const ALLOWED_KEYS = ['gym', 'finance', 'dailystack'];
const MAX_BODY_CHARS = 20000; // generous ceiling for a "summary" — guards against accidental raw dumps
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

async function readRow(key) {
  const r = await fetch(supabaseUrl('app_state?key=eq.' + encodeURIComponent(key) + '&select=data'), {
    headers: supabaseHeaders(),
  });
  if (!r.ok) throw new Error('Supabase read failed: ' + (await r.text()).slice(0, 300));
  const rows = await r.json();
  const existing = Array.isArray(rows) && rows[0] ? rows[0].data : null;
  return (existing && typeof existing === 'object') ? existing : {};
}

async function writeRow(key, data) {
  const r = await fetch(supabaseUrl('app_state?on_conflict=key'), {
    method: 'POST',
    headers: { ...supabaseHeaders(), Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify([{ key, data, updated_at: new Date().toISOString() }]),
  });
  if (!r.ok) throw new Error('Supabase write failed: ' + (await r.text()).slice(0, 300));
}

// ---------- habit_config (a generic id/data row store — used for both
// the habit list itself, id="config", and General Settings, id="general") ----------
async function getConfigRow(id) {
  const r = await fetch(supabaseUrl('habit_config?id=eq.' + encodeURIComponent(id) + '&select=data'), { headers: supabaseHeaders() });
  if (!r.ok) throw new Error('Supabase read failed: ' + (await r.text()).slice(0, 300));
  const rows = await r.json();
  return Array.isArray(rows) && rows[0] ? rows[0].data : null;
}
async function saveConfigRow(id, data) {
  const r = await fetch(supabaseUrl('habit_config?on_conflict=id'), {
    method: 'POST',
    headers: { ...supabaseHeaders(), Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify([{ id, data, updated_at: new Date().toISOString() }]),
  });
  if (!r.ok) throw new Error('Supabase write failed: ' + (await r.text()).slice(0, 300));
}
const getHabitConfig = () => getConfigRow('config');
const saveHabitConfig = (config) => saveConfigRow('config', config);
const getGeneralSettings = () => getConfigRow('general');
const saveGeneralSettings = (settings) => saveConfigRow('general', settings);
const getActivityTypes = () => getConfigRow('activityTypes');
const saveActivityTypes = (types) => saveConfigRow('activityTypes', types);

// ---------- daily_habits ----------
async function getDailyHabits(date) {
  const r = await fetch(supabaseUrl('daily_habits?date=eq.' + encodeURIComponent(date) + '&select=entries'), { headers: supabaseHeaders() });
  if (!r.ok) throw new Error('Supabase read failed: ' + (await r.text()).slice(0, 300));
  const rows = await r.json();
  return Array.isArray(rows) && rows[0] ? rows[0].entries : null;
}
async function getDailyHabitsRange(from, to) {
  const r = await fetch(
    supabaseUrl('daily_habits?date=gte.' + encodeURIComponent(from) + '&date=lte.' + encodeURIComponent(to) + '&select=date,entries&order=date.asc'),
    { headers: supabaseHeaders() }
  );
  if (!r.ok) throw new Error('Supabase read failed: ' + (await r.text()).slice(0, 300));
  const rows = await r.json();
  return Array.isArray(rows) ? rows : [];
}
async function saveDailyHabits(date, entries) {
  const r = await fetch(supabaseUrl('daily_habits?on_conflict=date'), {
    method: 'POST',
    headers: { ...supabaseHeaders(), Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify([{ date, entries, updated_at: new Date().toISOString() }]),
  });
  if (!r.ok) throw new Error('Supabase write failed: ' + (await r.text()).slice(0, 300));
}

// ---------- active_restrictions ----------
function makeRestrictionId() {
  return 'restr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}
async function getActiveRestrictions(asOf) {
  const r = await fetch(
    supabaseUrl('active_restrictions?starts_on=lte.' + encodeURIComponent(asOf) + '&ends_on=gte.' + encodeURIComponent(asOf) + '&select=id,text,scope,starts_on,ends_on&order=starts_on.asc'),
    { headers: supabaseHeaders() }
  );
  if (!r.ok) throw new Error('Supabase read failed: ' + (await r.text()).slice(0, 300));
  const rows = await r.json();
  return Array.isArray(rows) ? rows : [];
}
async function createRestriction(fields) {
  const row = { id: makeRestrictionId(), text: fields.text, scope: fields.scope || null, starts_on: fields.starts_on, ends_on: fields.ends_on };
  const r = await fetch(supabaseUrl('active_restrictions'), {
    method: 'POST',
    headers: { ...supabaseHeaders(), Prefer: 'return=representation' },
    body: JSON.stringify([row]),
  });
  if (!r.ok) throw new Error('Supabase write failed: ' + (await r.text()).slice(0, 300));
  const created = await r.json();
  return (Array.isArray(created) && created[0]) ? created[0] : row;
}
async function endRestriction(id) {
  const r = await fetch(supabaseUrl('active_restrictions?id=eq.' + encodeURIComponent(id)), {
    method: 'DELETE',
    headers: supabaseHeaders(),
  });
  if (!r.ok) throw new Error('Supabase delete failed: ' + (await r.text()).slice(0, 300));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-dashboard-secret');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const resource = req.query && req.query.resource;

  if (resource === 'habit-config' || resource === 'daily-habits' || resource === 'general-settings' || resource === 'restrictions' || resource === 'activity-types') {
    if (!checkAuth(req, res)) return;
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ error: 'missing SUPABASE_URL / SUPABASE_SERVICE_KEY' });
    }

    try {
      if (resource === 'habit-config') {
        if (req.method === 'GET') {
          const config = await getHabitConfig();
          return res.status(200).json({ ok: true, config });
        }
        if (req.method === 'POST') {
          let body = req.body;
          if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
          const config = body && body.config;
          if (!config || typeof config !== 'object' || Array.isArray(config)) {
            return res.status(400).json({ error: 'config must be a plain object' });
          }
          await saveHabitConfig(config);
          return res.status(200).json({ ok: true });
        }
        return res.status(405).json({ error: 'method not allowed' });
      }

      if (resource === 'general-settings') {
        if (req.method === 'GET') {
          const settings = await getGeneralSettings();
          return res.status(200).json({ ok: true, settings });
        }
        if (req.method === 'POST') {
          let body = req.body;
          if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
          const settings = body && body.settings;
          if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
            return res.status(400).json({ error: 'settings must be a plain object' });
          }
          await saveGeneralSettings(settings);
          return res.status(200).json({ ok: true });
        }
        return res.status(405).json({ error: 'method not allowed' });
      }

      if (resource === 'activity-types') {
        if (req.method === 'GET') {
          const types = await getActivityTypes();
          return res.status(200).json({ ok: true, types });
        }
        if (req.method === 'POST') {
          let body = req.body;
          if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
          const types = body && body.types;
          if (!Array.isArray(types)) {
            return res.status(400).json({ error: 'types must be an array' });
          }
          await saveActivityTypes(types);
          return res.status(200).json({ ok: true });
        }
        return res.status(405).json({ error: 'method not allowed' });
      }

      if (resource === 'restrictions') {
        if (req.method === 'GET') {
          const asOf = req.query && req.query.asOf;
          if (!asOf || !DATE_RE.test(asOf)) return res.status(400).json({ error: 'asOf (YYYY-MM-DD) is required' });
          const restrictions = await getActiveRestrictions(asOf);
          return res.status(200).json({ ok: true, restrictions });
        }
        if (req.method === 'POST') {
          let body = req.body;
          if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
          const action = body && body.action;
          if (action === 'create') {
            const rr = body.restriction || {};
            if (!rr.text || typeof rr.text !== 'string') return res.status(400).json({ error: 'restriction.text is required' });
            if (!DATE_RE.test(rr.starts_on) || !DATE_RE.test(rr.ends_on)) return res.status(400).json({ error: 'restriction.starts_on/ends_on must be YYYY-MM-DD' });
            if (rr.ends_on < rr.starts_on) return res.status(400).json({ error: 'ends_on must not be before starts_on' });
            const created = await createRestriction({
              text: rr.text.slice(0, 300),
              scope: typeof rr.scope === 'string' ? rr.scope.slice(0, 50) : null,
              starts_on: rr.starts_on,
              ends_on: rr.ends_on,
            });
            return res.status(200).json({ ok: true, restriction: created });
          }
          if (action === 'end') {
            const id = body.id;
            if (!id || typeof id !== 'string') return res.status(400).json({ error: 'id is required' });
            await endRestriction(id);
            return res.status(200).json({ ok: true });
          }
          return res.status(400).json({ error: 'action must be "create" or "end"' });
        }
        return res.status(405).json({ error: 'method not allowed' });
      }

      // resource === 'daily-habits'
      if (req.method === 'GET') {
        const { date, from, to } = req.query || {};
        if (date) {
          if (!DATE_RE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
          const entries = await getDailyHabits(date);
          return res.status(200).json({ ok: true, entries });
        }
        if (from && to) {
          if (!DATE_RE.test(from) || !DATE_RE.test(to)) return res.status(400).json({ error: 'from/to must be YYYY-MM-DD' });
          const days = await getDailyHabitsRange(from, to);
          return res.status(200).json({ ok: true, days });
        }
        return res.status(400).json({ error: 'GET requires either ?date= or ?from=&to=' });
      }
      if (req.method === 'POST') {
        let body = req.body;
        if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
        const date = body && body.date;
        const entries = body && body.entries;
        if (!date || !DATE_RE.test(date)) return res.status(400).json({ error: 'body.date must be YYYY-MM-DD' });
        if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
          return res.status(400).json({ error: 'body.entries must be a plain object' });
        }
        await saveDailyHabits(date, entries);
        return res.status(200).json({ ok: true });
      }
      return res.status(405).json({ error: 'method not allowed' });
    } catch (e) {
      return res.status(500).json({ error: e.message || String(e) });
    }
  }

  // ---------- original behavior, unchanged ----------
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  if (!checkAuth(req, res)) return;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'missing SUPABASE_URL / SUPABASE_SERVICE_KEY' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }

  const key = body && body.key;
  if (!ALLOWED_KEYS.includes(key)) {
    return res.status(400).json({ error: 'key must be one of: ' + ALLOWED_KEYS.join(', ') });
  }
  const summary = body && body.data;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    return res.status(400).json({ error: 'data must be a plain object' });
  }
  if (JSON.stringify(summary).length > MAX_BODY_CHARS) {
    return res.status(400).json({ error: 'data too large for a summary (max ' + MAX_BODY_CHARS + ' chars) — this endpoint is for compact snapshots, not raw history' });
  }

  try {
    const existing = await readRow(key);
    const merged = Object.assign({}, existing, {
      dailyCheckinSummary: summary,
      dailyCheckinSummaryUpdatedAt: new Date().toISOString(),
    });
    await writeRow(key, merged);
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}
