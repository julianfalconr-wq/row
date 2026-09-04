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

function buildSystemPrompt(todayContext) {
  return (
    'You are a nutrition and health assistant embedded in the user\'s personal dashboard (Row). ' +
    'Give practical, specific advice based on the data below. Keep answers concise and actionable. ' +
    'You are not a doctor; for medical concerns, suggest they consult a professional.\n\n' +
    'TODAY\'S DATA (from Cronometer sync + goals + recent AI food scans):\n' +
    JSON.stringify(todayContext || {}, null, 2) +
    '\n\nYou also have a memory tool. Use it to remember durable facts about the user across ' +
    'conversations (preferences, recurring patterns, things they\'ve told you before) — not the ' +
    'raw numbers above, those change daily and are already provided fresh again next time.\n\n' +
    'CHARTS: when a chart would clearly help — trends over time, comparisons between days or ' +
    'metrics — you may include, inside your normal reply text, exactly one fenced block like this:\n' +
    '```chart\n' +
    '{ "type": "line", "labels": ["Mon", "Tue", "Wed"], "datasets": [{ "label": "Strain", "data": [8.2, 10.1, 6.4] }] }\n' +
    '```\n' +
    'Only "line" or "bar" for "type". Only chart data you can actually ground in the data provided ' +
    'above (or in what the user just told you) — never invent numbers to fill a chart. Put any ' +
    'explanation in the surrounding text, not inside the JSON. Most replies won\'t need a chart at ' +
    'all — use one only when it\'s clearly more useful than a sentence.'
  );
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
          system: buildSystemPrompt(todayContext),
          messages,
          tools: [{ type: 'memory_20250818', name: 'memory' }],
        }),
      });

      if (!anthropicRes.ok) {
        const errText = await anthropicRes.text();
        return res.status(502).json({ error: 'Anthropic API request failed', status: anthropicRes.status, body: errText.slice(0, 500) });
      }

      const data = await anthropicRes.json();
      messages.push({ role: 'assistant', content: data.content });

      const toolUses = (data.content || []).filter((b) => b.type === 'tool_use');
      if (toolUses.length === 0) {
        const textBlock = (data.content || []).find((b) => b.type === 'text');
        return res.status(200).json({ reply: textBlock ? textBlock.text : '', history: messages });
      }

      const toolResults = [];
      for (const toolUse of toolUses) {
        const result = await handleMemoryCommand(toolUse.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result.content,
          is_error: !!result.is_error,
        });
      }
      messages.push({ role: 'user', content: toolResults });
    }

    return res.status(504).json({ error: 'too many tool iterations, aborted' });
  } catch (e) {
    return res.status(500).json({ error: 'unexpected error: ' + (e.message || String(e)) });
  }
}
