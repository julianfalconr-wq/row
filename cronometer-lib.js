// =============================================================
// Shared Cronometer scoring library.
// Loaded by main.html (score gauge) and health.html (full section
// + settings). Pure functions + small localStorage helpers so both
// pages compute the exact same score the exact same way.
//
// DATA SOURCE: reads the CSV rows last pushed from cronometer.html
// via GET /api/cronometer-data (DASHBOARD_SECRET-gated, same secret
// stored at localStorage['dashboard:secret']). Nothing here talks
// to Cronometer directly.
//
// COLUMN MATCHING: Cronometer's own CSV export column names vary by
// export type, so every metric is matched by best-effort pattern
// against your file's actual headers rather than an exact name.
// Built-in metrics use regex patterns tuned to the common "Daily
// Nutrition Summary" / diary export headers; metrics you add
// yourself in Settings are matched by a plain substring you supply.
// If a number looks wrong, check window.CronoLib.debugColumns(headers)
// in the console against your file.
// =============================================================
(function () {
  'use strict';

  const SECRET_KEY = 'dashboard:secret';
  const TARGETS_KEY = 'cronometer_targets_v1';
  const HISTORY_KEY = 'cronometer_score_history_v1';
  const API = '/api/cronometer-data';

  // ---------- default metrics (targets + point weights, sum = 100) ----------
  // kind: 'range' (min+max), 'max' (max only), 'min' (min only)
  // group: 'energy' | 'macro' | 'micro' | 'supplements' | 'other'
  // patterns: built-in regex list tried in order against CSV headers.
  const DEFAULT_METRICS = [
    { id: 'energy',      label: 'Energy',      unit: 'kcal', kind: 'range', min: 3000, max: 3300, weight: 15, group: 'energy',      patterns: ['^energy\\s*\\(kcal\\)$', '^energy', 'calories'] },
    { id: 'protein',     label: 'Protein',     unit: 'g',    kind: 'range', min: 120,  max: 150,  weight: 15, group: 'macro',       patterns: ['^protein\\s*\\(g\\)$', '^protein'] },
    { id: 'fat',         label: 'Fat',         unit: 'g',    kind: 'range', min: 100,  max: 120,  weight: 10, group: 'macro',       patterns: ['^fat\\s*\\(g\\)$', '^fat$', '^total fat'] },
    { id: 'carbs',       label: 'Carbs',       unit: 'g',    kind: 'range', min: 400,  max: 450,  weight: 10, group: 'macro',       patterns: ['^carbs\\s*\\(g\\)$', '^net carbs\\s*\\(g\\)$', '^carbohydrate', '^carbs'] },
    { id: 'addedSugar',  label: 'Added Sugar', unit: 'g',    kind: 'max',   min: null, max: 60,   weight: 10, group: 'macro',       patterns: ['added sugar', '^sugar,?\\s*added'] },
    { id: 'sodium',      label: 'Sodium',      unit: 'mg',   kind: 'range', min: 1500, max: 2300, weight: 10, group: 'micro',       patterns: ['^sodium\\s*\\(mg\\)$', '^sodium'] },
    { id: 'potassium',   label: 'Potassium',   unit: 'mg',   kind: 'min',   min: 4000, max: null, weight: 10, group: 'micro',       patterns: ['^potassium\\s*\\(mg\\)$', '^potassium'] },
    { id: 'calcium',     label: 'Calcium',     unit: 'mg',   kind: 'range', min: 1300, max: 3000, weight: 10, group: 'micro',       patterns: ['^calcium\\s*\\(mg\\)$', '^calcium'] },
    { id: 'iron',        label: 'Iron',        unit: 'mg',   kind: 'range', min: 11,   max: 45,   weight: 5,  group: 'micro',       patterns: ['^iron\\s*\\(mg\\)$', '^iron'] },
    { id: 'supplements', label: 'Supplements', unit: '%',    kind: 'min',   min: 100,  max: null, weight: 5,  group: 'supplements', patterns: null }, // special-cased: Daily Stack completion
  ];

  const DATE_PATTERNS = ['^date$', '^day$', '^recorded$'];

  function cloneDefaults() {
    return DEFAULT_METRICS.map((m) => Object.assign({}, m, { patterns: m.patterns ? m.patterns.slice() : null }));
  }

  // ---------- localStorage: targets/weights ----------
  function loadTargets() {
    try {
      const raw = localStorage.getItem(TARGETS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.metrics) && parsed.metrics.length) return parsed;
      }
    } catch (e) {}
    return { metrics: cloneDefaults() };
  }
  function saveTargets(targets) {
    try { localStorage.setItem(TARGETS_KEY, JSON.stringify(targets)); } catch (e) {}
  }
  function resetTargets() {
    const t = { metrics: cloneDefaults() };
    saveTargets(t);
    return t;
  }
  function weightSum(targets) {
    return (targets.metrics || []).reduce((s, m) => s + (Number(m.weight) || 0), 0);
  }
  function makeCustomMetric(opts) {
    return {
      id: 'custom_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
      label: opts.label || 'Custom',
      unit: opts.unit || '',
      kind: opts.kind || 'range',
      min: opts.min == null || opts.min === '' ? null : Number(opts.min),
      max: opts.max == null || opts.max === '' ? null : Number(opts.max),
      weight: Number(opts.weight) || 0,
      group: 'other',
      matchText: opts.matchText || opts.label || '',
    };
  }

  // ---------- localStorage: score history ----------
  function loadScoreHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveScoreForDate(dateKey, score) {
    const h = loadScoreHistory();
    h[dateKey] = score;
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); } catch (e) {}
    return h;
  }

  // ---------- fetch synced Cronometer data ----------
  function getSecret() {
    try { return localStorage.getItem(SECRET_KEY) || ''; } catch (e) { return ''; }
  }
  async function fetchCronometerData() {
    const secret = getSecret();
    if (!secret) return { ok: false, reason: 'no-secret' };
    try {
      const res = await fetch(API, { headers: { 'x-dashboard-secret': secret } });
      const json = await res.json();
      if (!res.ok) return { ok: false, reason: 'http-' + res.status, error: json && json.error };
      if (!json.data) return { ok: false, reason: 'no-data' };
      return { ok: true, rows: json.data.rows || [], headers: json.data.headers || [], source: json.data.source, syncedAt: json.data.syncedAt, updated_at: json.updated_at };
    } catch (e) {
      return { ok: false, reason: 'network', error: e && e.message };
    }
  }

  // ---------- column matching ----------
  function matchByPatterns(headers, patterns) {
    for (const p of patterns) {
      const re = new RegExp(p, 'i');
      const hit = headers.find((h) => re.test(String(h || '').trim()));
      if (hit) return hit;
    }
    return null;
  }
  function matchDateColumn(headers) {
    return matchByPatterns(headers, DATE_PATTERNS);
  }
  // Works for both built-in metrics (regex patterns) and user-added
  // custom metrics (plain substring in matchText).
  function matchColumnForMetric(headers, metric) {
    if (metric.patterns && metric.patterns.length) return matchByPatterns(headers, metric.patterns);
    if (metric.matchText) {
      const needle = metric.matchText.toLowerCase();
      const hit = headers.find((h) => String(h || '').toLowerCase().indexOf(needle) !== -1);
      if (hit) return hit;
    }
    return null;
  }
  function debugColumns(headers, targets) {
    const t = targets || loadTargets();
    const out = { date: matchDateColumn(headers) };
    t.metrics.forEach((m) => {
      if (m.group === 'supplements') return;
      out[m.id] = matchColumnForMetric(headers, m);
    });
    return out;
  }

  function toDateKey(v) {
    const s = String(v == null ? '' : v).trim();
    // Bare "YYYY-MM-DD" (Cronometer's usual date column) parses as UTC
    // midnight in JS's Date constructor, which then reads back as the
    // *previous* local day west of UTC — so handle it directly instead
    // of round-tripping through Date for this specific shape.
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];
    const d = new Date(s);
    if (isNaN(d)) return null;
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function listAvailableDates(rows, headers) {
    const dateCol = matchDateColumn(headers);
    if (!dateCol) return [];
    const set = new Set();
    rows.forEach((r) => {
      const k = toDateKey(r[dateCol]);
      if (k) set.add(k);
    });
    return Array.from(set).sort().reverse(); // newest first
  }

  function num(v) {
    const n = parseFloat(String(v == null ? '' : v).replace(/,/g, ''));
    return isNaN(n) ? 0 : n;
  }

  // Sums every row matching dateKey per metric column, keyed by metric id.
  // Works whether the export is one row per day (summary) or one row per
  // food item per day (diary export) — either way the sum is the day total.
  function sumNutrientsForDate(rows, headers, dateKey, targets) {
    const t = targets || loadTargets();
    const dateCol = matchDateColumn(headers);
    const cols = {};
    t.metrics.forEach((m) => {
      if (m.group === 'supplements') return;
      cols[m.id] = matchColumnForMetric(headers, m);
    });

    const totals = {};
    Object.keys(cols).forEach((id) => { totals[id] = 0; });
    if (!dateCol) return totals;

    rows.forEach((r) => {
      if (toDateKey(r[dateCol]) !== dateKey) return;
      Object.keys(cols).forEach((id) => {
        if (cols[id]) totals[id] += num(r[cols[id]]);
      });
    });
    return totals;
  }

  // ---------- Daily Stack (supplements) completion, matches topbar.js's own logic ----------
  function getStackCompletionForDate(dateKey) {
    let items = [];
    try { items = JSON.parse(localStorage.getItem('stack:items')) || []; } catch (e) {}
    let taken = {};
    try { taken = JSON.parse(localStorage.getItem('stack:taken:' + dateKey)) || {}; } catch (e) {}
    const total = Array.isArray(items) ? items.length : 0;
    if (!total) return null; // no stack configured — excluded from scoring rather than counted as 0
    const done = items.filter((i) => i && taken[i.id]).length;
    return Math.round((done / total) * 100);
  }

  // ---------- per-metric + total scoring ----------
  // Returns 0-1 (fraction of that metric's points earned), or null if
  // there's no value to score.
  function metricFraction(value, metric) {
    if (value == null) return null;
    const min = metric.min == null ? null : Number(metric.min);
    const max = metric.max == null ? null : Number(metric.max);
    if (metric.kind === 'range' && min != null && max != null) {
      if (value >= min && value <= max) return 1;
      if (value < min) return min > 0 ? Math.max(0, value / min) : 0;
      // over max: linear falloff, fully zero at 2x the range width past max
      const span = Math.max(max - min, max * 0.25, 1);
      return Math.max(0, 1 - (value - max) / span);
    }
    if (metric.kind === 'max' && max != null) {
      if (value <= max) return 1;
      const span = Math.max(max * 0.5, 1);
      return Math.max(0, 1 - (value - max) / span);
    }
    if (metric.kind === 'min' && min != null) {
      if (value >= min) return 1;
      return min > 0 ? Math.max(0, value / min) : 0;
    }
    return null;
  }

  // totals: { <metricId>: number, ... } plus totals.supplements (0-100 or null)
  function computeScore(totals, targets) {
    const metrics = (targets && targets.metrics) || cloneDefaults();
    const totalWeight = weightSum({ metrics }) || 1;
    let earned = 0;
    let consideredWeight = 0;
    const breakdown = [];

    metrics.forEach((m) => {
      const value = totals[m.id];
      const frac = metricFraction(value, m);
      if (frac == null) {
        breakdown.push({ id: m.id, label: m.label, value: value == null ? null : value, points: null, ofPoints: m.weight });
        return; // no data for this metric — excluded from both numerator and denominator
      }
      const pts = frac * (Number(m.weight) || 0);
      earned += pts;
      consideredWeight += Number(m.weight) || 0;
      breakdown.push({ id: m.id, label: m.label, value, fraction: frac, points: pts, ofPoints: m.weight });
    });

    // Score out of 100 using only metrics that had data for this day, so a
    // metric with nothing to measure (e.g. no supplements configured) is
    // excluded rather than counted as a zero.
    const score = consideredWeight > 0 ? Math.round((earned / consideredWeight) * 100) : null;

    return { score, breakdown, consideredWeight, totalWeight };
  }

  window.CronoLib = {
    DEFAULT_METRICS,
    loadTargets, saveTargets, resetTargets, weightSum, makeCustomMetric,
    loadScoreHistory, saveScoreForDate,
    fetchCronometerData, getSecret,
    matchDateColumn, matchColumnForMetric, debugColumns, listAvailableDates, toDateKey,
    sumNutrientsForDate, getStackCompletionForDate,
    metricFraction, computeScore,
  };
})();
