// =============================================================
// row-charts.js — the one shared Chart.js styling helper. Every chart
// in the app (trends.html, plan.html, topbar.js's chat charts) calls
// window.RowCharts.render(canvas, spec) instead of maintaining its own
// near-identical Chart.js config, so the visual language (smooth
// curves, gradient area fill fading to transparent, a subtle line
// glow, muted gridlines, rounded bar tops, the semantic accent
// palette) only needs to be right in one place.
//
// Loaded as a plain classic script (not a module, not deferred) after
// row-ui.css and before any page script that calls it — same
// load-order discipline as daylib.js/score-lib.js. Chart.js itself is
// loaded separately per-caller exactly as before (trends.html's own
// CDN <script>, topbar.js's loadChartJs()) — this file only wraps
// styling, never loads or replaces the library itself.
//
// TWO DELIBERATE FIXES FROM EARLIER IN THIS PROJECT, preserved here
// and now applied UNIFORMLY (previously animation:false was only on
// plan.html's chart, not trends.html's — see this file's own
// migration commit for why that's now applied everywhere instead):
//   - spanGaps: false, always. A `null` in a data array is a real
//     "nothing was logged this day" and must render as a visible
//     break in the line — never bridged, matching this app's
//     "no data = null, not zero, not guessed" principle used
//     everywhere else.
//   - animation: false, always. Chart.js's default animation advances
//     via requestAnimationFrame, which a backgrounded/suspended tab
//     can freeze mid-draw — confirmed directly in this project's own
//     headless-browser verification (a frozen chart stuck at its
//     animation start position, never reaching the real value). A
//     standalone PWA reopened from the home screen (this app's
//     primary real-world usage) can plausibly hit the same browser
//     behavior. animation:false draws the final, correct state in one
//     paint, with no window for that to ever happen.
//
// spec shape:
//   {
//     type: 'line' | 'bar',
//     labels: [...],
//     datasets: [{ label, data, color?, dashed?, fill? }],
//     // color defaults to the semantic accent (cyan) if omitted;
//     // pass a literal hex (e.g. from a page's own --accent-* token,
//     // read via getComputedStyle) for a specific series.
//     legend: Boolean,   // defaults to datasets.length > 1
//     beginAtZeroY: Boolean,   // defaults to true for bar, false for line
//     maxTicksX: Number,   // defaults to 8
//   }
// Returns the Chart.js instance (same as `new Chart(...)` would) —
// callers that need to .destroy() it before re-rendering keep doing
// that themselves, same as before.
// =============================================================
(function () {
  'use strict';

  const DEFAULT_COLOR = '#22D3EE'; // --accent-cyan

  function hexToRgba(hex, alpha) {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  // Reads the page's own current token values so charts stay correct
  // if a page ever overrides one locally — falls back to row-ui.css's
  // own defaults (this file doesn't assume row-ui.css is the only
  // source of truth, just the usual one).
  function themeColor(varName, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    return v || fallback;
  }

  function render(canvas, spec) {
    if (typeof window.Chart === 'undefined' || !canvas) return null;
    const ctx = canvas.getContext('2d');
    const type = spec.type === 'bar' ? 'bar' : 'line';
    const tickColor = themeColor('--text-tertiary', '#6E6C68');
    const gridColor = themeColor('--border-soft', 'rgba(255,255,255,0.07)');
    const datasetsSpec = Array.isArray(spec.datasets) ? spec.datasets : [];

    const datasets = datasetsSpec.map((ds) => {
      const color = ds.color || DEFAULT_COLOR;
      const isSingleLine = type === 'line' && datasetsSpec.length === 1;
      // Gradient area fill fading to transparent — built against the
      // canvas's own drawing context (a CanvasGradient, not a plain
      // color string) so it correctly reflects THIS canvas's actual
      // pixel height rather than an assumed fixed size.
      let backgroundColor;
      if (type === 'bar') {
        backgroundColor = hexToRgba(color, 0.85);
      } else if (ds.fill !== false && isSingleLine) {
        const h = canvas.height || 200;
        const gradient = ctx.createLinearGradient(0, 0, 0, h);
        gradient.addColorStop(0, hexToRgba(color, 0.28));
        gradient.addColorStop(1, hexToRgba(color, 0));
        backgroundColor = gradient;
      } else {
        backgroundColor = 'transparent';
      }
      return {
        label: ds.label,
        data: ds.data,
        borderColor: ds.dashed ? tickColor : color,
        backgroundColor,
        borderDash: ds.dashed ? [4, 4] : undefined,
        pointRadius: ds.dashed ? 0 : 2,
        pointHoverRadius: ds.dashed ? 0 : 4,
        pointBackgroundColor: color,
        borderWidth: ds.dashed ? 1.5 : 2,
        // Subtle line glow — a soft shadow following the stroke,
        // static (no animation), well under the performance rules'
        // blur-radius ceiling.
        borderCapStyle: 'round',
        borderJoinStyle: 'round',
        shadowColor: type === 'line' && !ds.dashed ? hexToRgba(color, 0.45) : undefined,
        shadowBlur: type === 'line' && !ds.dashed ? 6 : undefined,
        tension: type === 'line' ? 0.4 : 0,
        fill: type === 'line' ? (ds.fill !== false && isSingleLine) : false,
        spanGaps: false, // never bridge a real gap — see header comment
        borderRadius: type === 'bar' ? 6 : undefined, // rounded bar tops
        borderSkipped: type === 'bar' ? false : undefined,
      };
    });

    return new window.Chart(ctx, {
      type,
      data: { labels: Array.isArray(spec.labels) ? spec.labels : [], datasets },
      // Chart.js has no native "line glow" option — a tiny plugin
      // applies the shadowColor/shadowBlur set per-dataset above to
      // the canvas context right before each line draws, then clears
      // it so it doesn't bleed into points/gridlines/bars.
      plugins: [{
        id: 'rowChartsGlow',
        beforeDatasetDraw(chart, args) {
          const meta = args.meta;
          const ds = chart.data.datasets[args.index];
          if (meta.type === 'line' && ds && ds.shadowColor) {
            chart.ctx.save();
            chart.ctx.shadowColor = ds.shadowColor;
            chart.ctx.shadowBlur = ds.shadowBlur || 0;
          }
        },
        afterDatasetDraw(chart, args) {
          const meta = args.meta;
          if (meta.type === 'line') chart.ctx.restore();
        },
      }],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false, // see header comment — deliberate, always on
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            display: spec.legend !== undefined ? spec.legend : datasets.length > 1,
            labels: { color: tickColor, font: { size: 10 }, boxWidth: 10 },
          },
        },
        scales: {
          x: {
            ticks: { color: tickColor, font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: spec.maxTicksX || 8 },
            grid: { color: gridColor },
          },
          y: {
            ticks: { color: tickColor, font: { size: 10 } },
            grid: { color: gridColor },
            beginAtZero: spec.beginAtZeroY !== undefined ? spec.beginAtZeroY : type === 'bar',
          },
        },
      },
    });
  }

  window.RowCharts = { render };
})();
