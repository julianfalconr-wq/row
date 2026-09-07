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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
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
          tools: [{ type: 'memory_20250818', name: 'memory' }, PROPOSE_OBJECTIVES_TOOL],
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
        const result = await handleMemoryCommand(toolUse.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result.content,
          is_error: !!result.is_error,
        });
      }
      messages.push({ role: 'user', content: toolResults });

      if (proposedObjectives) {
        const textBlock = (data.content || []).find((b) => b.type === 'text');
        return res.status(200).json({ reply: textBlock ? textBlock.text : '', history: messages, proposedObjectives });
      }
    }

    return res.status(504).json({ error: 'too many tool iterations, aborted' });
  } catch (e) {
    return res.status(500).json({ error: 'unexpected error: ' + (e.message || String(e)) });
  }
}
