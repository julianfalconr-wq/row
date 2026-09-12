// =============================================================
// Nutrition chat endpoint. Takes a user message + today's context
// (macros/micros from Cronometer, goals, recent food scans) and
// answers using Claude, with cross-conversation memory backed by
// your Supabase project via Anthropic's memory tool.
//
// Requires these env vars in Vercel:
//   ANTHROPIC_API_KEY     from console.anthropic.com -> API Keys
//   DASHBOARD_SECRET      same secret used by the other endpoints
//   SUPABASE_URL          your Supabase project URL
//   SUPABASE_SERVICE_KEY  Supabase "service_role" key (Settings ->
//                         API in your Supabase project) — NOT the
//                         anon/publishable key already used in the
//                         browser. This one must stay server-side
//                         only, it bypasses row-level security.
//
// Requires this table in Supabase (SQL editor):
//   create table ai_memory (
//     path text primary key,
//     content text not null default '',
//     updated_at timestamptz not null default now()
//   );
//
// Call it as: POST /api/chat?secret=YOUR_SECRET
//   body: {
//     "message": "...",
//     "history": [{ "role": "user"|"assistant", "content": "..." }, ...],
//     "todayContext": {
//       "macros": {...}, "micros": {...}, "goals": {...},
//       "recentScans": [{ "description": "...", "nutrients": {...} }]
//     }
//   }
// Returns: { reply, history }  (history = the full updated array,
//   the frontend should store it and send it back on the next call
//   — reset it to [] whenever the day changes, so it never grows
//   across days; memory across days is handled by the memory tool
//   below, not by the conversation history).
// =============================================================

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-5';
const MAX_TOOL_ITERATIONS = 6;
const MEMORY_ROOT = '/memories';

// ---------- propose_training_objectives tool ----------
// Lets Claude propose a concrete weekly training plan after negotiating
// it conversationally (padel days, recovery, time constraints — the
// same back-and-forth the user described having with a coach before),
// instead of the Training page's one-click "Generate" button being the
// only way to set objectives. The input schema mirrors the exact plan
// shape api/training.js's normalizePlan() already produces and
// gym.html's "Generate" flow already stores — same fields, same
// meaning — so the frontend can save it under the identical
// po_coach_weekly_plan_v1 key with zero changes to how the Training
// page reads or renders it.
const PROPOSE_OBJECTIVES_TOOL = {
  name: 'propose_training_objectives',
  description:
    'Propose a concrete weekly training plan (strength + running) for the user to review. This does ' +
    'NOT save anything by itself — the user sees the proposal in the chat and explicitly chooses to save ' +
    'it or not. Only call this once you have gathered enough from the conversation to give specific ' +
    'numbers (padel/other commitments this week, how recovery has been, time available) — do not call it ' +
    'on the first message about training if you do not have that context yet; ask first. Equipment reality: ' +
    'the user currently only has a flat/adjustable bench press setup and ONE dumbbell for strength — no ' +
    'barbell, no rack, no second dumbbell, no machines, so every strength suggestion must be doable with ' +
    'just those two things. Running should balance VO2 max (interval/tempo work) and building distance ' +
    'capacity past 10km (a progressively longer long run plus easy Zone 2 volume) — standard periodization, ' +
    'not an ad-hoc guess.',
  input_schema: {
    type: 'object',
    properties: {
      strength: {
        type: 'object',
        properties: {
          targetSessions: { type: 'integer', description: 'Number of strength sessions this week' },
          focus: { type: 'string', description: 'Short phrase, e.g. "full-body bench + single-dumbbell supersets"' },
        },
        required: ['targetSessions', 'focus'],
      },
      running: {
        type: 'object',
        properties: {
          interval: {
            type: 'object',
            properties: {
              targetSessions: { type: 'integer' },
              targetMinutes: { type: 'integer' },
              description: { type: 'string', description: 'Concrete session, e.g. "6x3min hard w/ 2min easy jog recovery"' },
            },
            required: ['targetSessions', 'targetMinutes', 'description'],
          },
          longRun: {
            type: 'object',
            properties: {
              targetKm: { type: 'number' },
              description: { type: 'string' },
            },
            required: ['targetKm', 'description'],
          },
          easyVolume: {
            type: 'object',
            properties: {
              targetKm: { type: 'number' },
              description: { type: 'string' },
            },
            required: ['targetKm', 'description'],
          },
        },
        required: ['interval', 'longRun', 'easyVolume'],
      },
      rationale: { type: 'string', description: '1-3 sentences explaining the plan given what the user told you' },
    },
    required: ['strength', 'running', 'rationale'],
  },
};

// ---------- propose_calendar_event tool ----------
// Lets the user ask the chat to schedule something on Google Calendar
// conversationally (matching the old-coach-negotiation spirit
// propose_training_objectives already established) instead of only
// ever using the manual "+ Add event" form in main.html's Calendar
// card. Input schema deliberately mirrors that manual form's own raw
// fields (title/date/startTime/endTime/description) rather than
// Google's {dateTime, timeZone} event shape directly — the model has
// no reliable way to know the user's IANA timezone, but the browser
// does (Intl.DateTimeFormat().resolvedOptions().timeZone), so the
// frontend does the exact same date+time -> {dateTime, timeZone}
// conversion here that it already does for the manual form, and both
// paths end up calling api/google-callback.js's ?action=create with
// an identical body shape.
const PROPOSE_CALENDAR_EVENT_TOOL = {
  name: 'propose_calendar_event',
  description:
    'Propose a specific calendar event (title, date, start/end time) for the user to review. This does ' +
    'NOT create anything by itself — the user sees the proposal in the chat and explicitly chooses to ' +
    'create it or not. Only call this once you have a concrete date and start/end time to propose — ask ' +
    'a brief clarifying question first if the request is too vague (e.g. "sometime this week" with ' +
    'nothing else to go on), but do not ask unnecessary questions if there is already enough to work ' +
    'with. ALWAYS check calendar.upcoming in TODAY\'S DATA for conflicts before proposing a time — never ' +
    'propose a time that overlaps an existing event; if the time the user asked for conflicts, say so and ' +
    'propose a nearby free slot instead of silently ignoring the conflict.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'Event title' },
      description: { type: 'string', description: 'Optional short description' },
      date: { type: 'string', description: 'YYYY-MM-DD, resolved from TODAY\'S DATA\'s current date for relative terms like "tomorrow" or "Friday"' },
      startTime: { type: 'string', description: 'HH:MM, 24-hour, local time' },
      endTime: { type: 'string', description: 'HH:MM, 24-hour, local time' },
    },
    required: ['summary', 'date', 'startTime', 'endTime'],
  },
};

// ---------- propose_restriction tool ----------
// Lets the user tell the chat about a temporary training constraint
// ("no running this week", "no padel — knee recovery") ONCE and have
// it apply everywhere instead of repeating it to each feature: saved
// restrictions are fetched and respected by all three training AI
// surfaces (api/training.js's mode=plan and mode=today, plus
// main.html's Plan my day) via the shared active_restrictions table
// (see api/sync-state.js's resource=restrictions). This endpoint only
// proposes — same explicit-confirmation pattern as
// propose_training_objectives/propose_calendar_event, nothing is
// saved until the user taps Save on the card.
const PROPOSE_RESTRICTION_TOOL = {
  name: 'propose_restriction',
  description:
    'Propose a temporary training restriction (e.g. "no running this week", "no padel — recovering from a ' +
    'knee thing") for the user to review. This does NOT save anything by itself — the user sees the ' +
    'proposal in the chat and explicitly chooses to save it or not. Once saved, this week\'s objectives, ' +
    'Today\'s session, and Plan my day will all respect it automatically until it expires or the user ends ' +
    'it early — they do not need to repeat it to each feature separately. Ask clarifying questions first if ' +
    'the request is vague about WHAT is restricted or for HOW LONG (e.g. "no running" — for how many days? ' +
    'just this week? until they say otherwise?) — never guess a duration or scope. Resolve relative dates ' +
    '("this week", "a few days") against TODAY\'S DATA\'s own "date" field, never guess today\'s date.',
  input_schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Short human-readable summary, e.g. "No running this week" or "No padel — knee recovery"' },
      scope: { type: 'string', description: 'One of: running, strength, padel — only when the restriction clearly maps to one of these. Omit entirely for anything else (a general/other restriction) rather than forcing a bad fit.' },
      starts_on: { type: 'string', description: 'YYYY-MM-DD, usually today' },
      ends_on: { type: 'string', description: 'YYYY-MM-DD, inclusive — the last day the restriction still applies' },
    },
    required: ['text', 'starts_on', 'ends_on'],
  },
};

// ---------- propose_today_session tool ----------
// Lets the user directly override what Training's "Today's session"
// card currently recommends — e.g. "today I want to run 10km instead,
// I have great recovery" — without that request being misread as a
// calendar-scheduling ask (propose_calendar_event) or a weekly-
// objectives change (propose_training_objectives). On confirm, this
// overwrites the exact same localStorage cache
// (po_coach_today_recommendation_v1) gym.html's Training page reads
// from — the same "generate once, cache until tapped" entry Phase 1's
// caching fix introduced — so the card updates without the user
// needing to tap Regenerate, and topbar.js's save handler also
// updates the live DOM directly in case Training is the page
// currently open.
const PROPOSE_TODAY_SESSION_TOOL = {
  name: 'propose_today_session',
  description:
    'Propose a replacement for TODAY\'S specific Training recommendation (the "Today\'s session" card) — ' +
    'e.g. the user says "today I want to run 10km instead", "put Push + 5K in today\'s session", "my knee ' +
    'feels fine now, change today\'s pick to Legs". This is DIFFERENT from propose_calendar_event (which ' +
    'creates a new timed calendar event) and propose_training_objectives (which sets this WEEK\'s targets, ' +
    'not a specific day\'s pick) — use this one specifically when the user wants to change what Training ' +
    'itself currently shows as today\'s recommended session. This does NOT overwrite anything by itself — ' +
    'the user sees the proposal in the chat and explicitly chooses to replace it or not.',
  input_schema: {
    type: 'object',
    properties: {
      recommendation: { type: 'string', description: 'Short label, same style Training itself uses, e.g. "10K run", "Push + 5K run", "Rest" — never a paragraph or a list of exercises' },
      sub: { type: 'string', description: 'Optional short context line shown under the recommendation, e.g. "User-requested — great recovery today"' },
    },
    required: ['recommendation'],
  },
  // Last tool in the tools array -> caches every tool definition up to
  // and including this one (see the prompt-caching note in the handler
  // below). Tool definitions never change between requests, so this is
  // a pure win with no behavior difference.
  cache_control: { type: 'ephemeral' },
};

// Same defensive normalization api/training.js's normalizePlan() applies
// to Claude's other training-plan output — duplicated rather than
// imported (this repo's established pattern for small per-file config,
// see e.g. the NUTRIENTS list shared between api/food-scan.js and
// health.html), since these are separate serverless functions with no
// shared-module setup. Guarantees the frontend always gets the exact
// shape it expects regardless of how closely the model followed the
// input_schema.
function numOr(v, fallback) {
  const n = Number(v);
  return isNaN(n) ? fallback : n;
}
function normalizeProposedPlan(raw) {
  const r = raw || {};
  const strength = r.strength || {};
  const running = r.running || {};
  const interval = running.interval || {};
  const longRun = running.longRun || {};
  const easyVolume = running.easyVolume || {};
  return {
    strength: {
      targetSessions: Math.max(1, Math.round(numOr(strength.targetSessions, 3))),
      focus: typeof strength.focus === 'string' ? strength.focus.slice(0, 200) : '',
    },
    running: {
      interval: {
        targetSessions: Math.max(0, Math.round(numOr(interval.targetSessions, 1))),
        targetMinutes: Math.max(0, Math.round(numOr(interval.targetMinutes, 25))),
        description: typeof interval.description === 'string' ? interval.description.slice(0, 300) : '',
      },
      longRun: {
        targetKm: Math.max(0, numOr(longRun.targetKm, 8)),
        description: typeof longRun.description === 'string' ? longRun.description.slice(0, 300) : '',
      },
      easyVolume: {
        targetKm: Math.max(0, numOr(easyVolume.targetKm, 10)),
        description: typeof easyVolume.description === 'string' ? easyVolume.description.slice(0, 300) : '',
      },
    },
    rationale: typeof r.rationale === 'string' ? r.rationale.slice(0, 600) : '',
  };
}

// Defensive normalization for propose_calendar_event, same spirit as
// normalizeProposedPlan above — guarantees the frontend always gets
// the exact {summary, description, date, startTime, endTime} shape it
// expects (matching main.html's manual "+ Add event" form fields
// exactly) regardless of how closely the model followed the schema.
function normalizeProposedEvent(raw) {
  const r = raw || {};
  return {
    summary: typeof r.summary === 'string' ? r.summary.slice(0, 200) : '',
    description: typeof r.description === 'string' ? r.description.slice(0, 1000) : '',
    date: typeof r.date === 'string' ? r.date.slice(0, 10) : '',
    startTime: typeof r.startTime === 'string' ? r.startTime.slice(0, 5) : '',
    endTime: typeof r.endTime === 'string' ? r.endTime.slice(0, 5) : '',
  };
}

// Defensive normalization for propose_restriction, same spirit as the
// two above — guarantees the frontend always gets the exact
// {text, scope, starts_on, ends_on} shape api/sync-state.js's
// resource=restrictions POST (action:"create") expects.
function normalizeProposedRestriction(raw) {
  const r = raw || {};
  const scope = typeof r.scope === 'string' ? r.scope.trim().toLowerCase().slice(0, 50) : '';
  return {
    text: typeof r.text === 'string' ? r.text.slice(0, 300) : '',
    scope: scope || null,
    starts_on: typeof r.starts_on === 'string' ? r.starts_on.slice(0, 10) : '',
    ends_on: typeof r.ends_on === 'string' ? r.ends_on.slice(0, 10) : '',
  };
}

// Defensive normalization for propose_today_session, same spirit as
// the three above — guarantees the frontend always gets the exact
// {recommendation, sub} shape topbar.js's save handler expects when
// writing gym.html's po_coach_today_recommendation_v1 cache entry.
function normalizeProposedTodaySession(raw) {
  const r = raw || {};
  return {
    recommendation: typeof r.recommendation === 'string' ? r.recommendation.slice(0, 200) : '',
    sub: typeof r.sub === 'string' ? r.sub.slice(0, 200) : '',
  };
}

// ---------- Supabase-backed memory store ----------

function supabaseHeaders() {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

function supabaseUrl(path) {
  return `${process.env.SUPABASE_URL}/rest/v1/${path}`;
}

async function dbGet(path) {
  const res = await fetch(supabaseUrl(`ai_memory?path=eq.${encodeURIComponent(path)}&select=path,content,updated_at`), {
    headers: supabaseHeaders(),
  });
  const rows = await res.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function dbListByPrefix(prefix) {
  const like = encodeURIComponent(prefix.endsWith('/') ? prefix + '%' : prefix + '/%');
  const res = await fetch(supabaseUrl(`ai_memory?path=like.${like}&select=path,content`), {
    headers: supabaseHeaders(),
  });
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

async function dbUpsert(path, content) {
  await fetch(supabaseUrl('ai_memory?on_conflict=path'), {
    method: 'POST',
    headers: { ...supabaseHeaders(), Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify([{ path, content, updated_at: new Date().toISOString() }]),
  });
}

async function dbDelete(pathOrPrefix, recursive) {
  const filter = recursive
    ? `path=like.${encodeURIComponent(pathOrPrefix + '%')}`
    : `path=eq.${encodeURIComponent(pathOrPrefix)}`;
  await fetch(supabaseUrl(`ai_memory?${filter}`), { method: 'DELETE', headers: supabaseHeaders() });
}

// ---------- Path safety ----------

function normalizePath(p) {
  if (typeof p !== 'string' || !p.startsWith(MEMORY_ROOT)) return null;
  if (p.includes('..') || p.includes('%2e%2e')) return null;
  return p.replace(/\/+/g, '/').replace(/\/$/, '') || MEMORY_ROOT;
}

function humanSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'K';
  return (bytes / (1024 * 1024)).toFixed(1) + 'M';
}

// ---------- Memory tool command handlers ----------

async function handleMemoryCommand(input) {
  const { command } = input;

  if (command === 'view') {
    const path = normalizePath(input.path);
    if (!path) return { content: `The path ${input.path} does not exist. Please provide a valid path.`, is_error: true };

    if (path === MEMORY_ROOT || (await dbListByPrefix(path)).length > 0) {
      // Treat as directory: list children.
      const rows = await dbListByPrefix(path === MEMORY_ROOT ? '' : path);
      const fileRow = await dbGet(path);
      if (!fileRow && rows.length === 0 && path !== MEMORY_ROOT) {
        return { content: `The path ${path} does not exist. Please provide a valid path.`, is_error: true };
      }
      const lines = [`Here're the files and directories up to 2 levels deep in ${path}, excluding hidden items and node_modules:`];
      lines.push(`${humanSize(0)}\t${path}`);
      const seen = new Set();
      for (const row of rows) {
        const rel = row.path.slice(path.length === MEMORY_ROOT.length ? MEMORY_ROOT.length : path.length).replace(/^\//, '');
        const first = rel.split('/')[0];
        if (!first || seen.has(first)) continue;
        seen.add(first);
        lines.push(`${humanSize(row.content ? row.content.length : 0)}\t${path}/${first}`);
      }
      return { content: lines.join('\n') };
    }

    const row = await dbGet(path);
    if (!row) return { content: `The path ${path} does not exist. Please provide a valid path.`, is_error: true };
    let text = row.content || '';
    let lines = text.split('\n');
    if (Array.isArray(input.view_range)) {
      const [startLine, endLine] = input.view_range;
      const end = endLine === -1 ? lines.length : endLine;
      lines = lines.slice(Math.max(0, startLine - 1), end);
      var offset = startLine;
    } else {
      var offset = 1;
    }
    const numbered = lines.map((l, i) => `${String(i + offset).padStart(6, ' ')}\t${l}`).join('\n');
    return { content: `Here's the content of ${path} with line numbers:\n${numbered}` };
  }

  if (command === 'create') {
    const path = normalizePath(input.path);
    if (!path) return { content: `Invalid path: ${input.path}`, is_error: true };
    await dbUpsert(path, input.file_text || '');
    return { content: `File created successfully at: ${path}` };
  }

  if (command === 'str_replace') {
    const path = normalizePath(input.path);
    if (!path) return { content: `Invalid path: ${input.path}`, is_error: true };
    const row = await dbGet(path);
    if (!row) return { content: `Error: The path ${path} does not exist. Please provide a valid path.`, is_error: true };
    const occurrences = row.content.split(input.old_str).length - 1;
    if (occurrences === 0) {
      return { content: `No replacement was performed, old_str \`${input.old_str}\` did not appear verbatim in ${path}.`, is_error: true };
    }
    if (occurrences > 1) {
      return { content: `No replacement was performed. Multiple occurrences of old_str \`${input.old_str}\` found in ${path}. Please ensure it is unique`, is_error: true };
    }
    const newContent = row.content.replace(input.old_str, input.new_str || '');
    await dbUpsert(path, newContent);
    const snippet = newContent.split('\n').slice(0, 20).map((l, i) => `${String(i + 1).padStart(6, ' ')}\t${l}`).join('\n');
    return { content: `The memory file has been edited.\n${snippet}` };
  }

  if (command === 'insert') {
    const path = normalizePath(input.path);
    if (!path) return { content: `Invalid path: ${input.path}`, is_error: true };
    const row = await dbGet(path);
    if (!row) return { content: `Error: The path ${path} does not exist`, is_error: true };
    const lines = row.content.split('\n');
    const insertLine = input.insert_line;
    if (insertLine < 0 || insertLine > lines.length) {
      return { content: `Error: Invalid insert_line parameter: ${insertLine}. It should be within the range of lines of the file: [0, ${lines.length}]`, is_error: true };
    }
    lines.splice(insertLine, 0, (input.insert_text || '').replace(/\n$/, ''));
    await dbUpsert(path, lines.join('\n'));
    return { content: `The file ${path} has been edited.` };
  }

  if (command === 'delete') {
    const path = normalizePath(input.path);
    if (!path) return { content: `Invalid path: ${input.path}`, is_error: true };
    if (path === MEMORY_ROOT) return { content: `Error: cannot delete the memory root directory`, is_error: true };
    const row = await dbGet(path);
    const children = await dbListByPrefix(path);
    if (!row && children.length === 0) return { content: `Error: The path ${path} does not exist`, is_error: true };
    await dbDelete(path, true);
    if (row) await dbDelete(path, false);
    return { content: `Successfully deleted ${path}` };
  }

  if (command === 'rename') {
    const oldPath = normalizePath(input.old_path);
    const newPath = normalizePath(input.new_path);
    if (!oldPath || !newPath) return { content: `Invalid path`, is_error: true };
    if (oldPath === MEMORY_ROOT) return { content: `Error: cannot rename the memory root directory`, is_error: true };
    const row = await dbGet(oldPath);
    if (!row) return { content: `Error: The path ${oldPath} does not exist`, is_error: true };
    const existing = await dbGet(newPath);
    if (existing) return { content: `Error: The destination ${newPath} already exists`, is_error: true };
    await dbUpsert(newPath, row.content);
    await dbDelete(oldPath, false);
    return { content: `Successfully renamed ${oldPath} to ${newPath}` };
  }

  return { content: `Unknown memory command: ${command}`, is_error: true };
}

// ---------- System prompt ----------

// Split into a STATIC part (identical on every call, regardless of
// todayContext) and a DYNAMIC part (today's actual numbers) so the
// request can cache_control the static part separately — see the
// "system" array built in the handler below. Order matters for
// caching: cacheable content must come first in the prefix, so the
// static instructions are block 1 and todayContext is block 2, not
// interleaved the way the single-string version used to read.
function buildStaticSystemPrompt() {
  return (
    'You are a nutrition and health assistant embedded in the user\'s personal dashboard (Row). ' +
    'Give practical, specific advice based on the data provided below (after these instructions). ' +
    'Keep answers concise and actionable. You are not a doctor; for medical concerns, suggest they ' +
    'consult a professional.\n\n' +
    'MEMORY TOOL — use it sparingly, not as a routine first step. Only VIEW/check memory when the ' +
    'conversation itself gives you a reason to — the user references something from a past ' +
    'conversation, asks whether you remember something, or you are about to give advice that would ' +
    'genuinely benefit from a preference they may have told you before. Do not open or list memory ' +
    'on ordinary questions just to check. Only WRITE to memory when the user states something ' +
    'actually durable and worth keeping across days — an explicit preference ("I don\'t do barbell ' +
    'work", "I prefer running in the mornings") or a pattern you\'ve now clearly seen repeat. Do NOT ' +
    'write memory for routine or transactional exchanges — in particular, negotiating or adjusting ' +
    'this week\'s training objectives is not itself memory-worthy (that plan already lives on the ' +
    'Training page once saved; it doesn\'t need a duplicate memory entry). Never write the raw numbers ' +
    'in TODAY\'S DATA either — those change daily and are already provided fresh next time. When in ' +
    'doubt, skip the tool entirely; most messages need zero memory calls.\n\n' +
    'WEEKLY TRAINING OBJECTIVES: the user can also set up this week\'s training plan by talking it through ' +
    'with you, the way they used to negotiate a weekly plan back-and-forth with a coach — mentioning things ' +
    'like padel days, how recovery has been, or how much time they actually have this week. When the user ' +
    'brings up setting up or discussing this week\'s training, do NOT immediately propose a plan on the ' +
    'first message. Ask clarifying questions first if you don\'t already have enough to be specific — in ' +
    'particular: any padel or other commitments this week, how recovery/energy has felt lately, and any ' +
    'time constraints. Use the gym/whoop data already in TODAY\'S DATA as a starting point (it already ' +
    'covers recent strength sessions and recovery trend), but that data says nothing about padel or upcoming ' +
    'time constraints, so still ask about those. Only once you have enough to give concrete numbers should ' +
    'you call the propose_training_objectives tool — never call it speculatively or as a first response. ' +
    'When you do call it, also say a short summary sentence of the plan in your normal reply text (the ' +
    'proposal itself is shown to the user as a card with its own Save button, so don\'t repeat every number ' +
    'in prose — just enough that the message reads fine on its own).\n\n' +
    'CALENDAR: the user can also ask you to schedule something on their Google Calendar — they\'ll ' +
    'describe what they want (e.g. "put a gym session on my calendar tomorrow evening") and may mention ' +
    'constraints like preferred time of day. TODAY\'S DATA includes calendar.connected and ' +
    'calendar.upcoming (their actual scheduled events for the next few days, each with title/start/end) ' +
    'when Google Calendar is connected. ALWAYS check calendar.upcoming before proposing a time — never ' +
    'propose something that overlaps an existing event; if the time they asked for conflicts, say so ' +
    'and propose a nearby free slot instead of silently ignoring the conflict. If calendar.connected is ' +
    'false, tell them to connect Google Calendar on the main dashboard first rather than proposing ' +
    'anything. Ask a brief clarifying question if the request is too vague to pick a specific day/time, ' +
    'but don\'t ask unnecessary questions if there\'s already enough to work with — resolve relative ' +
    'terms like "tomorrow" or "Friday" against TODAY\'S DATA\'s own "date" field, never guess today\'s ' +
    'date. Only call propose_calendar_event once you have a concrete date and start/end time — never ' +
    'call it speculatively. When you do call it, also say a short summary sentence in your normal reply ' +
    'text (the proposal is shown as its own card with a Create button, so don\'t repeat every detail in ' +
    'prose).\n\n' +
    'RESTRICTIONS: the user can tell you about a temporary training constraint — an injury, "no running ' +
    'this week", a padel tournament, anything that should make the OTHER training AI features (this ' +
    'week\'s objectives, Today\'s session, Plan my day) back off a specific activity for a while. Ask what ' +
    'exactly is restricted and for how long if either is unclear — never guess a duration or scope. Once ' +
    'you have both, call propose_restriction with a concrete starts_on/ends_on (resolve relative terms ' +
    'like "this week" or "a few days" against TODAY\'S DATA\'s own "date" field, never guess today\'s ' +
    'date). Only set scope to "running", "strength", or "padel" when the restriction clearly maps to one ' +
    'of those; leave it unset for anything else (e.g. an injury affecting several activities at once) ' +
    'rather than forcing a bad fit. When you do call it, also say a short summary sentence in your normal ' +
    'reply text (the proposal is shown as its own card with a Save button).\n\n' +
    'TODAY\'S SESSION OVERRIDE: the user can also directly override what Training\'s "Today\'s session" ' +
    'card currently recommends — e.g. "today I want to run 10km instead, I have great recovery", "put Push ' +
    '+ 5K in today\'s session", "my knee feels fine now, change today\'s pick to Legs". This is a DIFFERENT ' +
    'request from scheduling a calendar event (propose_calendar_event — creates a new timed event) and from ' +
    'setting this week\'s targets (propose_training_objectives — weekly, not a specific day); watch for this ' +
    'distinction carefully; do not default to calendar or objectives just because training is mentioned. ' +
    'Call propose_today_session when the user wants to change what Training itself shows as today\'s ' +
    'recommended session. Keep the recommendation in Training\'s own short-label style (e.g. "10K run", ' +
    '"Push + 5K run", "Rest") — never a paragraph or a list of exercises; a brief sub line is fine when it ' +
    'adds real context (e.g. "User-requested — great recovery today"). When you do call it, also say a ' +
    'short summary sentence in your normal reply text (the proposal is shown as its own card with a Replace ' +
    'button).\n\n' +
    'CHARTS: when a chart would clearly help — trends over time, comparisons between days or ' +
    'metrics — you may include, inside your normal reply text, exactly one fenced block like this:\n' +
    '```chart\n' +
    '{ "type": "line", "labels": ["Mon", "Tue", "Wed"], "datasets": [{ "label": "Strain", "data": [8.2, 10.1, 6.4] }] }\n' +
    '```\n' +
    'Only "line" or "bar" for "type". Only chart data you can actually ground in TODAY\'S DATA ' +
    '(or in what the user just told you) — never invent numbers to fill a chart. Put any ' +
    'explanation in the surrounding text, not inside the JSON. Most replies won\'t need a chart at ' +
    'all — use one only when it\'s clearly more useful than a sentence.'
  );
}

function buildTodayContextPrompt(todayContext) {
  return 'TODAY\'S DATA (from Cronometer sync + goals + recent AI food scans):\n' + JSON.stringify(todayContext || {}, null, 2);
}

// ---------- Handler ----------

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // GET ?mode=export-memory — read-only dump of every ai_memory row, for
  // the "Export my data" feature (topbar.js). The anon/publishable Supabase
  // key used elsewhere in the browser can't read this table (RLS blocks it,
  // confirmed by a direct curl test), so this goes through the service key
  // like the memory tool itself does. Everything else about this endpoint
  // (the POST chat flow below) is unchanged.
  if (req.method === 'GET' && req.query && req.query.mode === 'export-memory') {
    const dashboardSecret = process.env.DASHBOARD_SECRET;
    if (!dashboardSecret || req.query.secret !== dashboardSecret) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ error: 'missing SUPABASE_URL / SUPABASE_SERVICE_KEY' });
    }
    try {
      const rows = await dbListByPrefix('');
      return res.status(200).json({ ok: true, memories: rows });
    } catch (e) {
      return res.status(500).json({ error: e.message || String(e) });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const dashboardSecret = process.env.DASHBOARD_SECRET;
  if (!dashboardSecret || (req.query && req.query.secret) !== dashboardSecret) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'missing ANTHROPIC_API_KEY' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'missing SUPABASE_URL / SUPABASE_SERVICE_KEY' });
  }

  const { message, history, todayContext } = req.body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'missing "message" in request body' });
  }

  const messages = [...(Array.isArray(history) ? history : []), { role: 'user', content: message }];

  // Built once per request (not once per loop iteration) — todayContext
  // is fixed for the whole request, so this is byte-identical across
  // every tool-loop iteration below. Two separate blocks, each with its
  // own cache_control: the static instructions (block 1) are identical
  // across every request regardless of todayContext, so they can also
  // cache-hit across separate user messages within the TTL window; the
  // todayContext block (block 2) only stays identical within this one
  // request's tool loop, but caching it there still avoids re-billing
  // it on every iteration when the loop runs more than once.
  const systemBlocks = [
    { type: 'text', text: buildStaticSystemPrompt(), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: buildTodayContextPrompt(todayContext), cache_control: { type: 'ephemeral' } },
  ];

  try {
    let iterations = 0;
    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations++;
      const anthropicRes = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1024,
          system: systemBlocks,
          messages,
          tools: [{ type: 'memory_20250818', name: 'memory' }, PROPOSE_OBJECTIVES_TOOL, PROPOSE_CALENDAR_EVENT_TOOL, PROPOSE_RESTRICTION_TOOL, PROPOSE_TODAY_SESSION_TOOL],
        }),
      });

      if (!anthropicRes.ok) {
        const errText = await anthropicRes.text();
        return res.status(502).json({ error: 'Anthropic API request failed', status: anthropicRes.status, body: errText.slice(0, 500) });
      }

      const data = await anthropicRes.json();
      // TEMPORARY — remove once caching savings are confirmed (task step
      // "Verification"). Logs to Vercel's function logs, not the client.
      if (data && data.usage) {
        console.log('[chat usage] iter=' + iterations, JSON.stringify(data.usage));
      }
      messages.push({ role: 'assistant', content: data.content });

      const toolUses = (data.content || []).filter((b) => b.type === 'tool_use');
      if (toolUses.length === 0) {
        const textBlock = (data.content || []).find((b) => b.type === 'text');
        return res.status(200).json({ reply: textBlock ? textBlock.text : '', history: messages });
      }

      // propose_training_objectives is terminal from this endpoint's point
      // of view — it's a proposal for the USER to accept or dismiss client-
      // side, not something Claude needs to react to further. Every
      // tool_use still needs a matching tool_result pushed onto `messages`
      // (the Anthropic API requires it for the next turn to be valid), but
      // we answer the acknowledgment ourselves instead of looping back for
      // another model turn once a proposal is found.
      let proposedObjectives = null;
      let proposedCalendarEvent = null;
      let proposedRestriction = null;
      let proposedTodaySession = null;
      const toolResults = [];
      for (const toolUse of toolUses) {
        if (toolUse.name === 'propose_training_objectives') {
          proposedObjectives = normalizeProposedPlan(toolUse.input);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: 'Proposal shown to the user in the chat UI for review. Not saved automatically — only the user can save it.',
          });
          continue;
        }
        if (toolUse.name === 'propose_calendar_event') {
          proposedCalendarEvent = normalizeProposedEvent(toolUse.input);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: 'Proposal shown to the user in the chat UI for review. Not created automatically — only the user can create it.',
          });
          continue;
        }
        if (toolUse.name === 'propose_restriction') {
          proposedRestriction = normalizeProposedRestriction(toolUse.input);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: 'Proposal shown to the user in the chat UI for review. Not saved automatically — only the user can save it.',
          });
          continue;
        }
        if (toolUse.name === 'propose_today_session') {
          proposedTodaySession = normalizeProposedTodaySession(toolUse.input);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: 'Proposal shown to the user in the chat UI for review. Training\'s cached recommendation is not overwritten automatically — only the user can replace it.',
          });
          continue;
        }
        const result = await handleMemoryCommand(toolUse.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result.content,
          is_error: !!result.is_error,
        });
      }
      messages.push({ role: 'user', content: toolResults });

      if (proposedObjectives || proposedCalendarEvent || proposedRestriction || proposedTodaySession) {
        const textBlock = (data.content || []).find((b) => b.type === 'text');
        const responseBody = { reply: textBlock ? textBlock.text : '', history: messages };
        if (proposedObjectives) responseBody.proposedObjectives = proposedObjectives;
        if (proposedCalendarEvent) responseBody.proposedCalendarEvent = proposedCalendarEvent;
        if (proposedRestriction) responseBody.proposedRestriction = proposedRestriction;
        if (proposedTodaySession) responseBody.proposedTodaySession = proposedTodaySession;
        return res.status(200).json(responseBody);
      }
    }

    return res.status(504).json({ error: 'too many tool iterations, aborted' });
  } catch (e) {
    return res.status(500).json({ error: 'unexpected error: ' + (e.message || String(e)) });
  }
}
