// =============================================================
// AI food photo scanner. Takes a base64 photo of a plate of food,
// asks Claude (vision) to estimate its nutritional content, and
// returns a description + a fixed set of 29 nutrients (null where
// the model can't reasonably estimate a value).
//
// This is a rough visual ESTIMATE only — it is never merged into
// the Cronometer-synced totals shown elsewhere on the Health page.
// The client stores each result in its own separate localStorage
// history key.
//
// Requires an ANTHROPIC_API_KEY environment variable (Vercel ->
// Settings -> Environment Variables). The key is only ever read
// server-side here and never sent to the browser.
// =============================================================

const MAX_BASE64_CHARS = 8 * 1024 * 1024; // ~6MB decoded image, generous for a compressed JPEG
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// Single source of truth for the 29 nutrients this endpoint asks the
// model for. Keep this in sync with the identical list in health.html's
// Scan Food with AI script (duplicated rather than shared, same as the
// rest of this repo's small per-file config).
const NUTRIENTS = [
  { id: 'energy',             label: 'Energy',              unit: 'kcal' },
  { id: 'totalFat',           label: 'total fat',           unit: 'g' },
  { id: 'saturatedFat',       label: 'saturated fat',       unit: 'g' },
  { id: 'transFat',           label: 'trans fat',           unit: 'g' },
  { id: 'cholesterol',        label: 'cholesterol',         unit: 'mg' },
  { id: 'sodium',             label: 'sodium',              unit: 'mg' },
  { id: 'totalCarbohydrates', label: 'total carbohydrates', unit: 'g' },
  { id: 'fiber',              label: 'fiber',               unit: 'g' },
  { id: 'sugars',             label: 'sugars',              unit: 'g' },
  { id: 'addedSugars',        label: 'added sugars',        unit: 'g' },
  { id: 'netCarbs',           label: 'net carbs',           unit: 'g' },
  { id: 'starch',             label: 'starch',              unit: 'g' },
  { id: 'fructose',           label: 'fructose',            unit: 'g' },
  { id: 'protein',            label: 'protein',             unit: 'g' },
  { id: 'water',              label: 'water',               unit: 'g' },
  { id: 'vitaminA',           label: 'vitamin A',           unit: 'mcg' },
  { id: 'vitaminC',           label: 'vitamin C',           unit: 'mg' },
  { id: 'vitaminD',           label: 'vitamin D',           unit: 'mcg' },
  { id: 'vitaminE',           label: 'vitamin E',           unit: 'mg' },
  { id: 'vitaminK',           label: 'vitamin K',           unit: 'mcg' },
  { id: 'calcium',            label: 'calcium',             unit: 'mg' },
  { id: 'iron',               label: 'iron',                unit: 'mg' },
  { id: 'potassium',          label: 'potassium',           unit: 'mg' },
  { id: 'magnesium',          label: 'magnesium',           unit: 'mg' },
  { id: 'manganese',          label: 'manganese',           unit: 'mg' },
  { id: 'copper',             label: 'copper',              unit: 'mg' },
  { id: 'iodine',             label: 'iodine',              unit: 'mcg' },
  { id: 'zinc',               label: 'zinc',                unit: 'mg' },
  { id: 'omega3',             label: 'omega-3',             unit: 'g' },
];

function buildSystemPrompt() {
  const shape = {};
  NUTRIENTS.forEach((n) => { shape[n.id] = 'number or null (' + n.unit + ')'; });
  return (
    'You are a nutrition estimation assistant. You will be shown a photo of a plate ' +
    'of food. Identify what is on the plate and estimate the TOTAL nutritional content ' +
    'of the entire visible plate/serving (not per 100g) as best you can from visual ' +
    'inspection alone: portion size, visible ingredients, likely preparation method.\n\n' +
    'Reply with ONLY valid JSON, no markdown code fences, no commentary before or after, ' +
    'in exactly this shape:\n' +
    JSON.stringify({ description: 'one or two sentence description of what you identified', nutrients: shape }, null, 2) +
    '\n\nEvery nutrient key listed above MUST be present in "nutrients". If you cannot ' +
    'reasonably estimate a value for a nutrient from the photo, use null for it instead ' +
    'of guessing a number you have no visual basis for — this is especially likely for ' +
    'micronutrients like iodine, manganese, vitamin K, and omega-3.'
  );
}

function parseDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(String(dataUrl || ''));
  if (!m) return null;
  return { mimeType: m[1], base64: m[2] };
}

function extractJson(text) {
  try { return JSON.parse(text); } catch (e) {}
  // Defensive fallback in case the model wraps the JSON in ```json fences
  // despite instructions not to.
  const m = /\{[\s\S]*\}/.exec(text);
  if (m) {
    try { return JSON.parse(m[0]); } catch (e) {}
  }
  return null;
}

function normalizeNutrients(raw) {
  const out = {};
  NUTRIENTS.forEach((n) => {
    const v = raw ? raw[n.id] : null;
    if (v == null || v === '') { out[n.id] = null; return; }
    const num = Number(v);
    out[n.id] = isNaN(num) ? null : num;
  });
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ ok: false, error: 'Server not configured (missing ANTHROPIC_API_KEY env var).' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const image = body && body.image;
  if (!image || typeof image !== 'string') {
    return res.status(400).json({ ok: false, error: 'Missing "image" (expected a data: URL).' });
  }
  if (image.length > MAX_BASE64_CHARS) {
    return res.status(400).json({ ok: false, error: 'Image is too large. Try a smaller photo.' });
  }
  const parsed = parseDataUrl(image);
  if (!parsed) {
    return res.status(400).json({ ok: false, error: 'Invalid image — expected a base64 data: URL.' });
  }
  if (!ALLOWED_MIME.includes(parsed.mimeType)) {
    return res.status(400).json({ ok: false, error: 'Unsupported image type: ' + parsed.mimeType });
  }

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1500,
        system: buildSystemPrompt(),
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: parsed.mimeType, data: parsed.base64 } },
            { type: 'text', text: 'Analyze this plate of food and return the JSON described in your instructions.' },
          ],
        }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      return res.status(502).json({ ok: false, error: 'Anthropic API error (' + anthropicRes.status + '): ' + errText.slice(0, 500) });
    }

    const data = await anthropicRes.json();
    const text = (data && data.content && data.content[0] && data.content[0].text) || '';
    const parsedJson = extractJson(text);
    if (!parsedJson || typeof parsedJson !== 'object') {
      return res.status(502).json({ ok: false, error: 'Model did not return valid JSON.' });
    }

    return res.status(200).json({
      ok: true,
      description: typeof parsedJson.description === 'string' ? parsedJson.description : '',
      nutrients: normalizeNutrients(parsedJson.nutrients),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Unexpected error: ' + (e && e.message) });
  }
}
