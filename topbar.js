// =============================================================
// Persistent dashboard top bar + bottom tab bar + AI chat FAB.
// Drop this on any page with:
//     <script src="topbar.js" defer></script>
// It self-injects HTML + CSS, reads progress from localStorage,
// and renders the water +1 button in the top bar plus the
// Main/Health/Fitness bottom tabs. Skips the topbar/bottombar on
// finance.html and inside iframes (so the water tracker can embed
// cleanly) — but the chat FAB shows on every non-embedded page,
// finance.html included, since that's a page in its own right, just
// one with its own internal nav instead of the shared chrome.
//
// This file is self-contained on purpose: every color below is a
// literal value, not var(--something). Pages in this project use at
// least three different, incompatible CSS-variable naming schemes
// (health.html/finance.html vs. index.html/main.html/po-water.html
// vs. gym.html), and this same stylesheet gets injected on all of
// them — reaching for a page's own tokens would silently break on
// whichever pages don't define them.
// =============================================================
(function () {
  'use strict';

  // -------- Supabase config (replace with your own project URL + publishable key) --------
  const TOPBAR_SUPABASE_URL = 'https://dfxjlneohhgfdussomou.supabase.co';
  const TOPBAR_SUPABASE_KEY = 'sb_publishable_9a1GD4OaqszZSnXW80PFTA_JvHi533e';

  // -------- CSS --------
  const css = `
.topbar {
  position: sticky; top: 0; z-index: 40;
  display: flex; justify-content: flex-end; align-items: center;
  gap: 8px;
  padding: max(10px, env(safe-area-inset-top)) 14px 8px;
  background: #0a0a0b;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
}
.topbar-water-wrap { display: flex; align-items: stretch; }
.topbar-water-pill {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 9px 14px;
  background: rgba(125, 211, 252, 0.08);
  border: 1px solid rgba(125, 211, 252, 0.16);
  border-right: none;
  border-radius: 12px 0 0 12px;
  text-decoration: none; color: #FAFAFA;
  -webkit-tap-highlight-color: transparent;
}
.topbar-water-pill .topbar-pill-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #7DD3FC; flex-shrink: 0;
}
.topbar-water-pill.warn .topbar-pill-dot { background: #fbbf24; }
.topbar-water-pill.miss .topbar-pill-dot {
  background: #ff8a8a;
  animation: topbar-miss-pulse 1.6s ease-in-out infinite;
}
@keyframes topbar-miss-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.5); }
  50%      { box-shadow: 0 0 0 5px rgba(239, 68, 68, 0); }
}
.topbar-pill-count {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 13px; font-weight: 700; color: #FAFAFA;
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
.topbar-water-add {
  width: 44px;
  border: 1px solid rgba(125, 211, 252, 0.16);
  background: linear-gradient(180deg, rgba(125, 211, 252, 0.28), rgba(110, 231, 183, 0.28));
  color: #FFFFFF; font-family: inherit;
  font-size: 20px; font-weight: 700; line-height: 1;
  cursor: pointer; border-radius: 0 12px 12px 0;
  -webkit-tap-highlight-color: transparent;
  transition: background 0.15s, transform 0.10s;
}
.topbar-water-add:active { transform: scale(0.94); }
.topbar-water-add.flash {
  background: linear-gradient(180deg, rgba(125, 211, 252, 0.7), rgba(110, 231, 183, 0.7));
}
.topbar-icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 44px; height: 42px;
  border: 1px solid rgba(255, 255, 255, 0.10);
  background: rgba(255, 255, 255, 0.04);
  border-radius: 12px; text-decoration: none;
  -webkit-tap-highlight-color: transparent;
  transition: background 0.15s;
}
.topbar-icon-btn:hover { background: rgba(255, 255, 255, 0.08); }
.topbar-icon {
  font-size: 20px; line-height: 1;
  filter: grayscale(100%) brightness(1.4); opacity: 0.85;
}
.bottombar {
  position: fixed; bottom: 0; left: 0; right: 0; z-index: 40;
  display: flex; justify-content: space-around; align-items: stretch;
  padding: 6px 0 calc(6px + env(safe-area-inset-bottom));
  background: #0a0a0b;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
}
.bottombar-tab {
  flex: 1;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 3px; padding: 6px 0 4px; text-decoration: none;
  color: rgba(255, 255, 255, 0.45);
  font-size: 10px; font-weight: 600; letter-spacing: 0.04em;
  -webkit-tap-highlight-color: transparent; transition: color 0.15s;
}
.bottombar-tab-icon {
  font-size: 24px; line-height: 1;
  filter: grayscale(100%) brightness(1.2); opacity: 0.55;
  transition: opacity 0.15s, filter 0.15s, transform 0.10s;
}
.bottombar-tab.active { color: #FAFAFA; }
.bottombar-tab.active .bottombar-tab-icon {
  filter: grayscale(100%) brightness(1.6); opacity: 1;
}
.bottombar-tab:active .bottombar-tab-icon { transform: scale(0.92); }
body.has-bottombar {
  padding-bottom: calc(72px + env(safe-area-inset-bottom)) !important;
}
@media (max-width: 480px) {
  .topbar { padding-left: 10px; padding-right: 10px; gap: 6px; }
  .topbar-water-pill { padding: 8px 11px; gap: 6px; }
  .topbar-pill-count { font-size: 12px; }
  .topbar-water-add { width: 40px; font-size: 18px; }
  .topbar-icon-btn { width: 40px; height: 38px; }
  .topbar-icon { font-size: 18px; }
  .bottombar-tab-icon { font-size: 22px; }
  .bottombar-tab { font-size: 10px; }
}
html, body { -webkit-text-size-adjust: 100%; }
@media (max-width: 768px) {
  html { touch-action: pan-y; }
  ::-webkit-scrollbar { width: 0; height: 0; display: none; }
  html, body { scrollbar-width: none; -ms-overflow-style: none; }
}
.modal-bg, .modal, .po-modal-bg, .po-modal, .wt-overlay, .wt-viewer,
.chat-modal-bg, .chat-modal {
  overscroll-behavior: contain;
}
body.topbar-modal-open { overflow: hidden; touch-action: none; }
@media (max-width: 480px) {
  .modal-bg, .po-modal-bg, .chat-modal-bg {
    padding: 0 !important;
    align-items: stretch !important;
    justify-content: stretch !important;
  }
  .modal, .po-modal, .chat-modal {
    width: 100% !important; max-width: 100% !important;
    max-height: 100vh !important; height: 100vh !important;
    border-radius: 0 !important;
    padding-top: max(20px, env(safe-area-inset-top)) !important;
    padding-bottom: max(28px, env(safe-area-inset-bottom)) !important;
    overflow-y: auto !important; overscroll-behavior: contain;
  }
}

/* ----- AI chat FAB + panel -----
   Self-contained: uses its own .chat-modal-bg/.chat-modal classes
   rather than the bare .modal-bg/.modal names, because several pages
   already define their own local (and different) versions of those
   — health.html's Cronometer settings modal and po-water.html's
   settings modal both use plain .modal-bg/.modal already, and
   reusing that name here would either collide with them or (on pages
   that don't define it at all) leave the chat panel with no base
   styling. The mobile-fullscreen + scroll-lock media queries just
   above list .chat-modal-bg/.chat-modal alongside the others, so the
   chat panel still gets the exact same responsive/scroll-lock
   pattern as every other modal in the app. */
.chat-fab {
  position: fixed;
  left: 16px;
  bottom: calc(84px + env(safe-area-inset-bottom));
  z-index: 200;
  width: 52px; height: 52px;
  border-radius: 50%;
  background: #1D9E75;
  color: #08110D;
  border: none;
  box-shadow: 0 8px 24px rgba(0,0,0,0.40), inset 0 1px 0 rgba(255,255,255,0.18);
  display: flex; align-items: center; justify-content: center;
  overflow: hidden;
  cursor: pointer;
  transition: transform 0.15s, box-shadow 0.15s, filter 0.15s;
}
.chat-fab-img {
  width: 68%; height: 68%;
  object-fit: contain;
  object-position: center;
  display: block;
  pointer-events: none;
}
.chat-fab:hover { filter: brightness(1.08); box-shadow: 0 10px 28px rgba(0,0,0,0.45); }
.chat-fab:active { transform: scale(0.92); }
.chat-fab.is-open { display: none; }
@media (max-width: 480px) {
  .chat-fab { width: 48px; height: 48px; left: 14px; bottom: calc(80px + env(safe-area-inset-bottom)); }
}
.chat-modal-bg {
  display: none; position: fixed; inset: 0;
  background: rgba(0,0,0,0.65); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  z-index: 300; align-items: center; justify-content: center; padding: 20px;
}
.chat-modal-bg.show { display: flex; }
.chat-modal {
  display: flex; flex-direction: column;
  width: 100%; max-width: 480px;
  height: min(640px, 88vh); max-height: 88vh;
  background: #121214;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 16px;
  overflow: hidden;
}
.chat-modal-head {
  display: flex; align-items: center; justify-content: space-between;
  gap: 10px; padding: 16px 18px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  flex-shrink: 0;
}
.chat-modal-head h3 { margin: 0; font-size: 17px; font-weight: 700; color: #FAFAFA; }
.chat-head-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.chat-close-btn, .chat-history-btn, .chat-back-btn {
  flex-shrink: 0; width: 30px; height: 30px; border-radius: 50%;
  background: transparent; border: 1px solid rgba(255, 255, 255, 0.12);
  color: #76746E; font-size: 15px; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  transition: color 0.15s, border-color 0.15s;
}
.chat-close-btn:hover, .chat-history-btn:hover, .chat-back-btn:hover { color: #FAFAFA; border-color: #76746E; }
.chat-messages {
  flex: 1; overflow-y: auto; min-height: 0;
  padding: 16px 18px;
  display: flex; flex-direction: column; gap: 10px;
}
.chat-day-list {
  flex: 1; overflow-y: auto; min-height: 0;
  padding: 8px 10px;
}
.chat-day-row {
  display: block; width: 100%; text-align: left;
  background: transparent; border: 0; border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  padding: 12px 8px; cursor: pointer; font-family: inherit;
}
.chat-day-row:hover { background: rgba(255, 255, 255, 0.035); border-radius: 8px; }
.chat-day-date { font-size: 12.5px; font-weight: 700; color: #FAFAFA; }
.chat-day-count {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 10.5px; color: #76746E; margin-left: 8px;
}
.chat-day-preview {
  margin-top: 3px; font-size: 12px; color: #A5A3A0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.chat-history-empty, .chat-history-loading, .chat-history-error {
  text-align: center; font-size: 12px; color: #76746E; padding: 24px 12px;
}
.chat-history-error { color: #FF8A8A; }
.chat-ios-banner {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 14px;
  background: rgba(29, 158, 117, 0.10);
  border-bottom: 1px solid rgba(29, 158, 117, 0.25);
  font-size: 11.5px; line-height: 1.4; color: #A5A3A0;
  flex-shrink: 0;
}
.chat-ios-banner button {
  flex-shrink: 0; border: 0; background: transparent; color: #76746E;
  font-size: 16px; cursor: pointer; padding: 0 2px;
}
.chat-ios-banner button:hover { color: #FAFAFA; }
.chat-empty { text-align: center; font-size: 12px; font-style: italic; color: #76746E; padding: 20px 10px; }
.chat-bubble {
  max-width: 82%;
  padding: 10px 14px;
  border-radius: 14px;
  font-size: 13.5px; line-height: 1.5;
  white-space: pre-wrap; word-break: break-word;
}
.chat-bubble.user {
  align-self: flex-end;
  background: #1D9E75; color: #08110D;
  border-bottom-right-radius: 4px;
}
.chat-bubble.assistant {
  align-self: flex-start;
  background: rgba(255, 255, 255, 0.035); border: 1px solid rgba(255, 255, 255, 0.06);
  color: #FAFAFA;
  border-bottom-left-radius: 4px;
}
.chat-bubble.error {
  align-self: center;
  background: rgba(255,107,107,0.08); border: 1px solid rgba(255,107,107,0.28);
  color: #FF8A8A; font-size: 12px; max-width: 90%;
}
.chat-bubble.typing { align-self: flex-start; color: #76746E; font-style: italic; }
.chat-bubble.has-chart { max-width: 100%; width: 100%; }
.chat-chart-wrap { position: relative; width: 100%; height: 200px; margin: 6px 0; }
.chat-chart-text { white-space: pre-wrap; word-break: break-word; }
.chat-chart-fallback { font-size: 11px; color: #76746E; font-style: italic; margin-top: 4px; }
.chat-input-row {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 14px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  flex-shrink: 0;
}
.chat-input {
  flex: 1; min-width: 0;
  background: rgba(0, 0, 0, 0.28); border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 20px; padding: 10px 16px;
  color: #FAFAFA; font-family: inherit; font-size: 13.5px;
  outline: none;
}
.chat-input:focus { border-color: #1D9E75; }
.chat-send-btn {
  flex-shrink: 0; width: 40px; height: 40px; border-radius: 50%;
  background: #1D9E75; color: #08110D; border: none;
  cursor: pointer; font-size: 16px; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
  transition: transform 0.1s, opacity 0.15s;
}
.chat-send-btn:active { transform: scale(0.92); }
.chat-send-btn:disabled { opacity: 0.4; cursor: default; }
`;

  const topbarHtml = `
<header class="topbar" id="topbar" role="navigation" aria-label="Quick actions">
  <div class="topbar-water-wrap">
    <a href="health.html#water" class="topbar-water-pill" id="topbarWater" aria-label="Water progress">
      <span class="topbar-pill-dot"></span>
      <span class="topbar-pill-count" id="topbarWaterCount">0/0</span>
    </a>
    <button class="topbar-water-add" id="topbarWaterAdd" aria-label="Log one drink" type="button">+</button>
  </div>
  <a href="finance.html" class="topbar-icon-btn" id="topbarFinance" aria-label="Finance">
    <span class="topbar-icon">📊</span>
  </a>
</header>`;

  const bottombarHtml = `
<nav class="bottombar" id="bottombar" role="navigation" aria-label="Main tabs">
  <a href="main.html" class="bottombar-tab" data-page="main">
    <span class="bottombar-tab-icon">🏠</span><span>Main</span>
  </a>
  <a href="health.html" class="bottombar-tab" data-page="health">
    <span class="bottombar-tab-icon">💊</span><span>Health</span>
  </a>
  <a href="gym.html" class="bottombar-tab" data-page="fitness">
    <span class="bottombar-tab-icon">💪</span><span>Fitness</span>
  </a>
</nav>`;

  const chatFabHtml = `
<button type="button" class="chat-fab" id="chatFab" aria-label="Ask the assistant about today">
  <img src="assets/chat-icon.png" alt="" class="chat-fab-img">
</button>`;

  const chatModalHtml = `
<div class="chat-modal-bg" id="chatModalBg">
  <div class="chat-modal">
    <div class="chat-modal-head">
      <h3 id="chatHeadTitle">Ask about today</h3>
      <div class="chat-head-actions">
        <button type="button" class="chat-back-btn" id="chatBackBtn" aria-label="Back to today" style="display:none">←</button>
        <button type="button" class="chat-history-btn" id="chatHistoryBtn" aria-label="History">🕘</button>
        <button type="button" class="chat-close-btn" id="chatCloseBtn" aria-label="Close">×</button>
      </div>
    </div>
    <div class="chat-ios-banner" id="chatIosBanner" style="display:none">
      <span>Add Row to your Home Screen to get daily check-in notifications — Safari tabs can't receive them in the background on iOS.</span>
      <button type="button" id="chatIosBannerDismiss" aria-label="Dismiss">×</button>
    </div>
    <div class="chat-messages" id="chatMessages">
      <div class="chat-empty" id="chatEmpty">Ask about your nutrition, workouts, recovery, or anything else tracked on this dashboard today.</div>
    </div>
    <div class="chat-day-list" id="chatDayList" style="display:none"></div>
    <div class="chat-input-row" id="chatInputRow">
      <input type="text" id="chatInput" class="chat-input" placeholder="Ask a question…" autocomplete="off">
      <button type="button" id="chatSendBtn" class="chat-send-btn" aria-label="Send">↑</button>
    </div>
  </div>
</div>`;

  function isFinancePage() {
    const p = (window.location.pathname || '').toLowerCase();
    return p.endsWith('/finance.html') || p.endsWith('finance.html');
  }
  function isEmbedded() {
    try { return window.self !== window.top; } catch (e) { return true; }
  }
  function shouldShowChrome() { return !isFinancePage() && !isEmbedded(); }
  // Chat is not part of the shared topbar/bottombar chrome — it should
  // show on every real page a person can land on, finance.html included
  // (finance.html only opts out of the topbar/bottombar because it has
  // its own internal 4-tab nav, not because it should be chat-free).
  // Only iframes (the embedded water tracker) skip it.
  function shouldShowChat() { return !isEmbedded(); }
  function currentPageKey() {
    const p = (window.location.pathname || '').toLowerCase();
    if (p.endsWith('health.html')) return 'health';
    if (p.endsWith('gym.html')) return 'fitness';
    if (p.endsWith('main.html')) return 'main';
    return 'hub'; // index.html (the bento hub) — no bottombar tab represents it
  }

  function injectStyle() {
    if (document.getElementById('topbar-style')) return;
    const style = document.createElement('style');
    style.id = 'topbar-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function injectChrome() {
    if (document.getElementById('topbar') || document.getElementById('bottombar')) return;
    if (!shouldShowChrome()) return;
    const topWrap = document.createElement('div');
    topWrap.innerHTML = topbarHtml.trim();
    document.body.insertBefore(topWrap.firstChild, document.body.firstChild);
    const bottomWrap = document.createElement('div');
    bottomWrap.innerHTML = bottombarHtml.trim();
    document.body.appendChild(bottomWrap.firstChild);
    const active = currentPageKey();
    document.querySelectorAll('.bottombar-tab').forEach((t) => {
      t.classList.toggle('active', t.getAttribute('data-page') === active);
    });
    document.body.classList.add('has-bottombar');
  }

  function injectChat() {
    if (document.getElementById('chatFab')) return;
    if (!shouldShowChat()) return;
    const fabWrap = document.createElement('div');
    fabWrap.innerHTML = chatFabHtml.trim();
    document.body.appendChild(fabWrap.firstChild);
    const modalWrap = document.createElement('div');
    modalWrap.innerHTML = chatModalHtml.trim();
    document.body.appendChild(modalWrap.firstChild);
    wireChat();
  }

  function calendarDateKey() {
    const d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }
  function getWaterProgress() {
    let state = null;
    try { state = JSON.parse(localStorage.getItem('po_water_v1')); } catch (e) {}
    if (!state) return { done: 0, total: 0 };
    const todayKey = calendarDateKey();
    const done = (state.logs || {})[todayKey] || 0;
    const p = state.profile || { weightKg: 75 };
    const wKg = state.weightUnit === 'lb' ? (p.weightKg || 0) / 2.20462 : (p.weightKg || 0);
    const base = wKg * 35;
    const exercise = (p.activityHrsPerWeek || 0) / 7 * 500;
    const caffeine = Math.max(0, (state.caffeineMgPerDay || 0) - 200) * 1.5;
    const subs = (state.substances || []).reduce((s, x) => {
      const dose = (x && x.dose != null ? x.dose : (x && x.defaultDose)) || 0;
      return s + Math.max(0, dose * ((x && x.mlPerUnit) || 0));
    }, 0);
    let adjust = 0;
    if (p.sex === 'm') adjust += 200;
    if ((p.age || 0) >= 50) adjust += 100;
    const totalMl = base + exercise + caffeine + subs + adjust;
    let unitVol;
    if (state.unit === 'glass') unitVol = state.glassMl || 250;
    else if (state.unit === 'oz') unitVol = 30;
    else if (state.unit === 'ml') unitVol = 1;
    else unitVol = state.bottleMl || 500;
    const total = Math.max(1, Math.ceil(totalMl / unitVol));
    return { done, total };
  }
  function classifyStatus(done, total) {
    if (total === 0) return 'idle';
    if (done >= total) return 'good';
    if (done >= total * 0.5) return 'warn';
    const h = new Date().getHours();
    if (h >= 18 && done < total * 0.5) return 'miss';
    return 'warn';
  }
  function setPillStatus(pillEl, status) {
    pillEl.classList.remove('good', 'warn', 'miss');
    if (status === 'warn' || status === 'miss') pillEl.classList.add(status);
  }
  function render() {
    const waterEl = document.getElementById('topbarWater');
    if (!waterEl) return;
    const w = getWaterProgress();
    const countEl = document.getElementById('topbarWaterCount');
    if (countEl) countEl.textContent = w.total ? w.done + '/' + w.total : '0/0';
    setPillStatus(waterEl, classifyStatus(w.done, w.total));
  }

  function defaultWaterState() {
    return {
      unit: 'bottle', bottleMl: 500, glassMl: 250, weightUnit: 'kg',
      profile: { weightKg: 75, age: 25, sex: 'm', activityHrsPerWeek: 5 },
      caffeineMgPerDay: 200, substances: [], logs: {}
    };
  }
  async function pushWaterMergedToSupabase(localWater) {
    if (window.location.pathname.endsWith('/health.html') ||
        window.location.pathname.endsWith('health.html')) return;
    if (!window.supabase || !TOPBAR_SUPABASE_URL || !TOPBAR_SUPABASE_KEY) return;
    if (TOPBAR_SUPABASE_URL.indexOf('PASTE-') === 0) return;
    try {
      const supa = window.supabase.createClient(TOPBAR_SUPABASE_URL, TOPBAR_SUPABASE_KEY);
      const { data } = await supa
        .from('app_state').select('data').eq('key', 'health').maybeSingle();
      const current = (data && data.data) || {};
      const merged = Object.assign({}, current, { po_water_v1: localWater });
      await supa.from('app_state').upsert(
        { key: 'health', data: merged, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
    } catch (e) {}
  }
  function addWater() {
    let state = null;
    try { state = JSON.parse(localStorage.getItem('po_water_v1')); } catch (e) {}
    if (!state || typeof state !== 'object') state = defaultWaterState();
    state.logs = state.logs || {};
    const k = calendarDateKey();
    state.logs[k] = (state.logs[k] || 0) + 1;
    try { localStorage.setItem('po_water_v1', JSON.stringify(state)); } catch (e) {}
    render();
    const btn = document.getElementById('topbarWaterAdd');
    if (btn) { btn.classList.add('flash'); setTimeout(() => btn.classList.remove('flash'), 220); }
    pushWaterMergedToSupabase(state);
  }

  // =============================================================
  // gatherTodayContext() — collects a compact snapshot of today's
  // data from every area of the app and returns it as one object,
  // sent as "todayContext" on every /api/chat call. Page-independent
  // by design: every value here comes from localStorage, window.CronoLib
  // (cronometer-lib.js), or a direct fetch — never from another page's
  // DOM, so it returns the same data no matter which page it's called
  // from. Every top-level section key is always present — sections
  // with nothing to report use null/empty values rather than being
  // omitted, so the assistant knows the section exists even when
  // there's no data yet.
  //
  // Every key/shape here was confirmed against the actual current
  // code in gym.html, finance.html, cronometer-lib.js, and health.html
  // — not assumed.
  // =============================================================
  window.gatherTodayContext = async function gatherTodayContext() {
    // ---------- shared date helpers ----------
    // Cronometer + Daily Stack use a 6am rollover (matches getActiveDate()
    // in health.html's Daily Stack script + cronometer-lib.js).
    function activeDateKey() {
      const now = new Date();
      if (now.getHours() < 6) now.setDate(now.getDate() - 1);
      return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    }
    // gym.html's wtDateKey() uses a plain calendar date, no rollover.
    function calDateKey(d) {
      d = d || new Date();
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    function safeParse(key, fallback) {
      try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; }
      catch (e) { return fallback; }
    }
    function round1(n) { return n == null ? null : Math.round(n * 10) / 10; }

    const todayKey = activeDateKey();
    const gymTodayKey = calDateKey();

    // ---------- 1 & 2. Nutrition + goals/targets (Cronometer) ----------
    // Reuses window.CronoLib (cronometer-lib.js), loaded on every page —
    // exactly what health.html's own Cronometer section calls.
    let nutrition = { connected: false, date: null, totals: null, score: null };
    let goals = { metrics: null };
    if (window.CronoLib) {
      const targets = window.CronoLib.loadTargets();
      goals.metrics = (targets.metrics || []).map((m) => ({
        id: m.id, label: m.label, unit: m.unit, kind: m.kind, min: m.min, max: m.max, weight: m.weight,
      }));
      try {
        const result = await window.CronoLib.fetchCronometerData();
        if (result && result.ok && result.rows && result.rows.length) {
          const dates = window.CronoLib.listAvailableDates(result.rows, result.headers) || [];
          const dateKey = dates.includes(todayKey) ? todayKey : (dates[0] || null);
          if (dateKey) {
            const totals = window.CronoLib.sumNutrientsForDate(result.rows, result.headers, dateKey, targets);
            totals.supplements = window.CronoLib.getStackCompletionForDate(dateKey);
            const scored = window.CronoLib.computeScore(totals, targets);
            nutrition = {
              connected: true,
              date: dateKey,
              totals: Object.keys(totals).reduce((o, k) => { o[k] = round1(totals[k]); return o; }, {}),
              score: scored ? scored.score : null,
            };
          }
        }
      } catch (e) { /* leave nutrition at its not-connected default */ }
    }

    // ---------- 3. Recent AI food scans ----------
    // Same key + shape as health.html's Scan Food with AI section:
    // foodscan_history_v1 = [{ ts, description, nutrients }, ...], newest first.
    const scanHistory = safeParse('foodscan_history_v1', []);
    const foodScans = {
      count: Array.isArray(scanHistory) ? scanHistory.length : 0,
      recent: (Array.isArray(scanHistory) ? scanHistory.slice(0, 3) : []).map((s) => ({
        ts: s.ts, description: s.description || '', nutrients: s.nutrients || {},
      })),
    };

    // ---------- 4. Gym / workouts ----------
    // po_coach_v1: { exercises:[{id,name,...}], logs:{ [exId]: [{weight,reps,date}] } }
    // po_coach_workout_done: { [dateKey]: isoTimestamp }
    // po_coach_weights: [{ dateKey, weight }]
    // po_coach_photos: [{ id, url|dataUrl, dateKey, weight }] — photo data itself is never read here.
    const pcState = safeParse('po_coach_v1', null);
    const doneDays = safeParse('po_coach_workout_done', {});
    const bodyWeights = safeParse('po_coach_weights', []);
    const photos = safeParse('po_coach_photos', []);

    const exById = {};
    if (pcState && Array.isArray(pcState.exercises)) {
      pcState.exercises.forEach((ex) => { exById[ex.id] = ex.name; });
    }

    const todaysSets = [];
    const recentWorkoutsByDay = {};
    if (pcState && pcState.logs) {
      const sevenDaysAgo = new Date(); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      Object.keys(pcState.logs).forEach((exId) => {
        (pcState.logs[exId] || []).forEach((log) => {
          const dk = String(log.date || '').slice(0, 10);
          if (!dk) return;
          if (dk === gymTodayKey) {
            todaysSets.push({ exercise: exById[exId] || exId, weight: log.weight, reps: log.reps });
          }
          if (new Date(dk) >= sevenDaysAgo) {
            if (!recentWorkoutsByDay[dk]) recentWorkoutsByDay[dk] = { sets: 0, exercises: new Set() };
            recentWorkoutsByDay[dk].sets++;
            recentWorkoutsByDay[dk].exercises.add(exById[exId] || exId);
          }
        });
      });
    }
    const recentWorkouts = Object.keys(recentWorkoutsByDay).sort().reverse().map((dk) => ({
      date: dk,
      done: !!doneDays[dk],
      totalSets: recentWorkoutsByDay[dk].sets,
      exerciseCount: recentWorkoutsByDay[dk].exercises.size,
    }));

    const latestBodyWeight = Array.isArray(bodyWeights) && bodyWeights.length
      ? bodyWeights.slice().sort((a, b) => (a.dateKey < b.dateKey ? 1 : -1))[0]
      : null;
    const latestPhoto = Array.isArray(photos) && photos.length
      ? { dateKey: photos[0].dateKey, weight: photos[0].weight }
      : null;

    const gym = {
      todayWorkoutDone: !!doneDays[gymTodayKey],
      todaysSets,
      recentWorkouts,
      latestBodyWeight: latestBodyWeight ? { dateKey: latestBodyWeight.dateKey, weight: latestBodyWeight.weight, unit: (pcState && pcState.units) || null } : null,
      latestProgressPhoto: latestPhoto,
    };

    // ---------- 5. Whoop ----------
    // whoop_tokens_v1 = { access, refresh, expires } — the only Whoop data
    // ever persisted to localStorage (see health.html's/index.html's own
    // Whoop cards). The actual readings (recovery/sleep/hrv/rhr/strain)
    // are NOT cached anywhere — every page that shows them fetches live
    // and renders straight into its own DOM. Since this function has to
    // work on pages with no Whoop card at all, it does that same live
    // fetch itself (token refresh included) rather than reading a DOM
    // element — this mirrors health.html's whoopFetch()/refreshToken()
    // exactly, just without touching the page.
    const WHOOP_KEY = 'whoop_tokens_v1';
    let whoop = {
      connected: false, lastSyncedMinutesAgo: null,
      recoveryPct: null, sleepDuration: null, sleepPct: null,
      hrv: null, rhr: null, strain: null,
    };
    const whoopTokens = safeParse(WHOOP_KEY, null);
    if (whoopTokens && whoopTokens.access) {
      const whoopLastSync = Number(localStorage.getItem('whoop_last_sync')) || null;
      whoop.connected = true;
      whoop.lastSyncedMinutesAgo = whoopLastSync ? Math.round((Date.now() - whoopLastSync) / 60000) : null;

      async function refreshWhoopToken(t) {
        if (!t.refresh) return null;
        try {
          const r = await fetch('/api/whoop-refresh', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: t.refresh }),
          });
          const j = await r.json();
          if (j.access_token) {
            const next = { access: j.access_token, refresh: j.refresh_token || t.refresh, expires: Date.now() + (j.expires_in || 3500) * 1000 };
            try { localStorage.setItem(WHOOP_KEY, JSON.stringify(next)); } catch (e) {}
            return next;
          }
        } catch (e) {}
        return null;
      }
      async function whoopFetch(path, t) {
        const [p, qs] = path.split('?');
        const params = new URLSearchParams(qs || ''); params.set('path', p);
        const r = await fetch('/api/whoop-data?' + params.toString(), { headers: { Authorization: 'Bearer ' + t.access, Accept: 'application/json' } });
        if (r.status === 401) { const n = await refreshWhoopToken(t); if (n) return whoopFetch(path, n); throw new Error('unauthorized'); }
        if (!r.ok) throw new Error('WHOOP ' + r.status);
        return r.json();
      }
      function fmtMins(ms) { const m = Math.round(ms / 60000); const h = Math.floor(m / 60); return h + 'h ' + String(m % 60).padStart(2, '0') + 'm'; }

      try {
        let t = whoopTokens;
        if (t.expires && Date.now() > t.expires - 60000) { const n = await refreshWhoopToken(t); if (n) t = n; }
        const [rec, sleep, cycle] = await Promise.all([
          whoopFetch('/recovery?limit=1', t).catch(() => null),
          whoopFetch('/activity/sleep?limit=1', t).catch(() => null),
          whoopFetch('/cycle?limit=1', t).catch(() => null),
        ]);
        const r = rec && rec.records && rec.records[0] && rec.records[0].score;
        if (r) {
          whoop.recoveryPct = Math.round(r.recovery_score || 0);
          whoop.hrv = Math.round(r.hrv_rmssd_milli || 0);
          whoop.rhr = Math.round(r.resting_heart_rate || 0);
        }
        const s = sleep && sleep.records && sleep.records[0];
        if (s && s.score) {
          if (s.score.stage_summary) {
            const ss = s.score.stage_summary;
            whoop.sleepDuration = fmtMins((ss.total_in_bed_time_milli || 0) - (ss.total_awake_time_milli || 0));
          }
          whoop.sleepPct = Math.round(s.score.sleep_performance_percentage || 0);
        }
        const c = cycle && cycle.records && cycle.records[0] && cycle.records[0].score;
        if (c && c.strain != null) whoop.strain = round1(c.strain);
      } catch (e) { /* leave whoop.connected true but readings null — token exists but fetch failed */ }
    }

    // ---------- 6. Finance ----------
    // nw:bank / nw:stocks / nw:crypto / nw:other = [{ name, amount }], amount
    // stored in CHF (finance.html's base currency) regardless of display
    // currency. subs = [{ name, amount, period }], amount also CHF-based.
    const nwCats = ['bank', 'stocks', 'crypto', 'other'];
    const netWorthByCategory = {};
    let netWorthTotal = 0;
    nwCats.forEach((cat) => {
      const items = safeParse('nw:' + cat, []);
      const sum = (Array.isArray(items) ? items : []).reduce((s, it) => s + (Number(it.amount) || 0), 0);
      netWorthByCategory[cat] = round1(sum);
      netWorthTotal += sum;
    });
    const subs = safeParse('subs', []);
    const subsMonthlyTotal = (Array.isArray(subs) ? subs : []).reduce((s, it) => {
      const a = Number(it.amount) || 0;
      if (it.period === 'yearly') return s + a / 12;
      if (it.period === 'weekly') return s + a * 4.345;
      return s + a;
    }, 0);
    const finance = {
      // finance.html's own storeSet() JSON.stringifies every value it writes
      // (including plain strings), so this must be parsed like every other
      // key here rather than read raw — a raw read returns the currency
      // code wrapped in literal quote characters.
      currency: safeParse('nw_currency', 'CHF'),
      netWorthByCategoryCHF: netWorthByCategory,
      netWorthTotalCHF: round1(netWorthTotal),
      subscriptions: { count: Array.isArray(subs) ? subs.length : 0, monthlyTotalCHF: round1(subsMonthlyTotal) },
    };

    // ---------- 7. Daily Stack (supplements) ----------
    // Exact same keys the Daily Stack section itself reads: stack:items
    // (the configured list) + stack:taken:<dateKey> (today's checked-off map).
    const stackItems = safeParse('stack:items', []);
    const stackTaken = safeParse('stack:taken:' + todayKey, {});
    const stackTotal = Array.isArray(stackItems) ? stackItems.length : 0;
    const stackDone = Array.isArray(stackItems) ? stackItems.filter((i) => i && stackTaken[i.id]).length : 0;
    const dailyStack = {
      total: stackTotal,
      done: stackDone,
      completionPct: stackTotal ? Math.round((stackDone / stackTotal) * 100) : null,
    };

    return { date: todayKey, nutrition, goals, foodScans, gym, whoop, finance, dailyStack };
  };

  // =============================================================
  // AI chat FAB + panel. Talks to /api/chat.js (not modified here —
  // see that file's own header comment for the exact contract this
  // mirrors). Wired up once, from injectChat() in boot().
  // =============================================================
  function wireChat() {
    const HISTORY_KEY = 'chat_history_v1'; // { date: 'YYYY-MM-DD', history: [...] } — today's fast local cache
    const SECRET_KEY = 'dashboard:secret'; // same key cronometer-lib.js already uses

    const fab = document.getElementById('chatFab');
    const modalBg = document.getElementById('chatModalBg');
    const closeBtn = document.getElementById('chatCloseBtn');
    const historyBtn = document.getElementById('chatHistoryBtn');
    const backBtn = document.getElementById('chatBackBtn');
    const headTitle = document.getElementById('chatHeadTitle');
    const messagesEl = document.getElementById('chatMessages');
    const emptyEl = document.getElementById('chatEmpty');
    const dayListEl = document.getElementById('chatDayList');
    const inputRow = document.getElementById('chatInputRow');
    const input = document.getElementById('chatInput');
    const sendBtn = document.getElementById('chatSendBtn');
    if (!fab || !modalBg) return;

    function chatTodayKey() {
      const d = new Date();
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    function getSecret() {
      try { return localStorage.getItem(SECRET_KEY) || ''; } catch (e) { return ''; }
    }

    // Reset whenever the stored date doesn't match today, so today's local
    // cache never grows across days — Supabase (via api/chat-history.js)
    // is the durable archive; localStorage is just today's fast copy.
    function loadStoredHistory() {
      try { return JSON.parse(localStorage.getItem(HISTORY_KEY)); } catch (e) { return null; }
    }
    function saveChatHistory(h) {
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify({ date: chatTodayKey(), history: h })); } catch (e) {}
    }
    async function archiveToServer(date, messages) {
      if (!date || !messages || !messages.length) return;
      const secret = getSecret();
      if (!secret) return;
      try {
        await fetch('/api/chat-history?secret=' + encodeURIComponent(secret), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date, messages }),
        });
      } catch (e) { /* best-effort — today's localStorage copy is unaffected either way */ }
    }

    let chatHistory = [];
    (function initHistory() {
      const stored = loadStoredHistory();
      if (!stored || !Array.isArray(stored.history)) return;
      if (stored.date === chatTodayKey()) {
        chatHistory = stored.history;
      } else if (stored.history.length) {
        // A day boundary passed since this was last saved (e.g. the tab
        // was left open, or it's just a new visit the next day) — archive
        // the stale day to Supabase before starting today empty.
        archiveToServer(stored.date, stored.history);
      }
    })();

    // Assistant turns store the raw Anthropic content array (text blocks,
    // and sometimes tool_use blocks from the memory tool) — extract just
    // the text for display. User turns we construct ourselves as a plain
    // string. Tool-result turns (role:'user', content: an array) are
    // internal plumbing from the memory-tool loop, not real messages, so
    // they render nothing.
    function contentToText(content) {
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        const textBlock = content.find((b) => b && b.type === 'text');
        return textBlock ? textBlock.text : '';
      }
      return '';
    }

    // ---------- charts ----------
    // Detects a ```chart fenced JSON block in assistant text (see
    // api/chat.js's system prompt for the exact format it's told to use)
    // and renders it as a Chart.js canvas in place, keeping any text
    // before/after as normal bubble content. Chart.js is lazy-loaded from
    // a CDN only the first time a chart actually appears, not on every
    // page load. Falls back to the raw text if parsing fails for any
    // reason — never silently drops content.
    const CHART_BLOCK_RE = /```chart\s*\n([\s\S]*?)```/;
    let chartJsPromise = null;
    function loadChartJs() {
      if (window.Chart) return Promise.resolve();
      if (chartJsPromise) return chartJsPromise;
      chartJsPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js';
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('Chart.js failed to load'));
        document.head.appendChild(s);
      });
      return chartJsPromise;
    }

    function renderChartCanvas(container, spec) {
      const canvas = document.createElement('canvas');
      container.appendChild(canvas);
      loadChartJs().then(() => {
        const type = spec.type === 'bar' ? 'bar' : 'line';
        const datasets = (Array.isArray(spec.datasets) ? spec.datasets : []).map((ds, i) => ({
          label: (ds && ds.label) || ('Series ' + (i + 1)),
          data: (ds && ds.data) || [],
          borderColor: '#1D9E75',
          backgroundColor: type === 'bar' ? 'rgba(29, 158, 117, 0.55)' : 'rgba(29, 158, 117, 0.15)',
          pointBackgroundColor: '#1D9E75',
          borderWidth: 2,
          tension: 0.3,
          fill: type === 'line',
        }));
        new window.Chart(canvas.getContext('2d'), {
          type,
          data: { labels: Array.isArray(spec.labels) ? spec.labels : [], datasets },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: datasets.length > 1, labels: { color: '#A5A3A0', font: { size: 10 }, boxWidth: 10 } },
            },
            scales: {
              x: { ticks: { color: '#76746E', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.06)' } },
              y: { ticks: { color: '#76746E', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.06)' } },
            },
          },
        });
      }).catch(() => {
        container.innerHTML = '';
        const msg = document.createElement('div');
        msg.className = 'chat-chart-fallback';
        msg.textContent = '(chart failed to load)';
        container.appendChild(msg);
      });
    }

    function renderBubbleContent(el, text) {
      const match = CHART_BLOCK_RE.exec(text || '');
      if (!match) { el.textContent = text; return; }

      let spec = null;
      try { spec = JSON.parse(match[1]); } catch (e) { spec = null; }
      if (!spec || (spec.type !== 'line' && spec.type !== 'bar') || !Array.isArray(spec.datasets)) {
        el.textContent = text; // malformed — show the raw reply rather than lose it
        return;
      }

      el.classList.add('has-chart');
      const before = text.slice(0, match.index).trim();
      const after = text.slice(match.index + match[0].length).trim();
      if (before) {
        const p = document.createElement('div');
        p.className = 'chat-chart-text';
        p.textContent = before;
        el.appendChild(p);
      }
      const chartWrap = document.createElement('div');
      chartWrap.className = 'chat-chart-wrap';
      el.appendChild(chartWrap);
      renderChartCanvas(chartWrap, spec);
      if (after) {
        const p = document.createElement('div');
        p.className = 'chat-chart-text';
        p.style.marginTop = '6px';
        p.textContent = after;
        el.appendChild(p);
      }
    }

    function addBubble(role, text) {
      emptyEl.style.display = 'none';
      const el = document.createElement('div');
      el.className = 'chat-bubble ' + role;
      renderBubbleContent(el, text);
      messagesEl.appendChild(el);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return el;
    }

    function renderChatHistory() {
      messagesEl.innerHTML = '';
      messagesEl.appendChild(emptyEl);
      let shown = 0;
      chatHistory.forEach((turn) => {
        if (turn.role === 'user' && typeof turn.content === 'string') {
          addBubble('user', turn.content); shown++;
        } else if (turn.role === 'assistant') {
          const text = contentToText(turn.content);
          if (text) { addBubble('assistant', text); shown++; }
        }
      });
      emptyEl.style.display = shown ? 'none' : 'block';
    }

    // ---------- view switching: live chat / history list / read-only day ----------
    function showView(view) {
      if (view === 'live') {
        messagesEl.style.display = 'flex';
        dayListEl.style.display = 'none';
        inputRow.style.display = 'flex';
        backBtn.style.display = 'none';
        historyBtn.style.display = 'inline-flex';
        headTitle.textContent = 'Ask about today';
      } else if (view === 'list') {
        messagesEl.style.display = 'none';
        dayListEl.style.display = 'block';
        inputRow.style.display = 'none';
        backBtn.style.display = 'inline-flex';
        historyBtn.style.display = 'none';
        headTitle.textContent = 'History';
      } else if (view === 'day') {
        messagesEl.style.display = 'flex';
        dayListEl.style.display = 'none';
        inputRow.style.display = 'none';
        backBtn.style.display = 'inline-flex';
        historyBtn.style.display = 'none';
      }
    }

    async function openHistoryList() {
      showView('list');
      dayListEl.innerHTML = '<div class="chat-history-loading">Loading…</div>';
      const secret = getSecret();
      if (!secret) { dayListEl.innerHTML = '<div class="chat-history-error">Set your dashboard secret first.</div>'; return; }
      try {
        const res = await fetch('/api/chat-history?secret=' + encodeURIComponent(secret));
        const json = await res.json();
        if (!res.ok) throw new Error((json && json.error) || ('HTTP ' + res.status));
        const days = Array.isArray(json.days) ? json.days : [];
        if (!days.length) { dayListEl.innerHTML = '<div class="chat-history-empty">No past conversations yet.</div>'; return; }
        dayListEl.innerHTML = '';
        days.forEach((d) => {
          const row = document.createElement('button');
          row.type = 'button';
          row.className = 'chat-day-row';
          row.innerHTML =
            '<span class="chat-day-date">' + escapeHtml(d.date) + '</span>' +
            '<span class="chat-day-count">' + d.messageCount + ' msg' + (d.messageCount === 1 ? '' : 's') + '</span>' +
            '<div class="chat-day-preview">' + escapeHtml(d.preview || '(no preview)') + '</div>';
          row.addEventListener('click', () => openDay(d.date));
          dayListEl.appendChild(row);
        });
      } catch (e) {
        dayListEl.innerHTML = '<div class="chat-history-error">Couldn\'t load history: ' + escapeHtml(e.message || String(e)) + '</div>';
      }
    }

    async function openDay(date) {
      showView('day');
      headTitle.textContent = date;
      messagesEl.innerHTML = '<div class="chat-history-loading">Loading…</div>';
      const secret = getSecret();
      try {
        const res = await fetch('/api/chat-history?secret=' + encodeURIComponent(secret) + '&date=' + encodeURIComponent(date));
        const json = await res.json();
        if (!res.ok) throw new Error((json && json.error) || ('HTTP ' + res.status));
        messagesEl.innerHTML = '';
        const messages = Array.isArray(json.messages) ? json.messages : [];
        let shown = 0;
        messages.forEach((turn) => {
          if (turn.role === 'user' && typeof turn.content === 'string') {
            addBubble('user', turn.content); shown++;
          } else if (turn.role === 'assistant') {
            const text = contentToText(turn.content);
            if (text) { addBubble('assistant', text); shown++; }
          }
        });
        if (!shown) messagesEl.innerHTML = '<div class="chat-history-empty">Nothing to show for this day.</div>';
      } catch (e) {
        messagesEl.innerHTML = '<div class="chat-history-error">Couldn\'t load that day: ' + escapeHtml(e.message || String(e)) + '</div>';
      }
    }

    function backToLive() {
      showView('live');
      renderChatHistory();
    }

    function escapeHtml(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // ---------- push notifications (daily check-in) ----------
    // Fails silently at every step: no VAPID key yet, no service worker
    // support, permission denied, offline — none of it should ever
    // interrupt a normal chat session. See api/push-subscribe.js,
    // api/send-notification.js, api/daily-checkin.js, and sw.js.
    const PUSH_ASKED_KEY = 'push_permission_asked_v1';
    const IOS_BANNER_DISMISSED_KEY = 'ios_pwa_banner_dismissed_v1';

    function urlBase64ToUint8Array(base64String) {
      const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
      const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
      const raw = atob(base64);
      const arr = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
      return arr;
    }

    function isIosSafari() {
      const ua = navigator.userAgent || '';
      const isIos = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && 'ontouchend' in document);
      return isIos;
    }
    function isStandalone() {
      return window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
    }

    function maybeShowIosBanner() {
      const banner = document.getElementById('chatIosBanner');
      const dismissBtn = document.getElementById('chatIosBannerDismiss');
      if (!banner) return;
      let dismissed = false;
      try { dismissed = localStorage.getItem(IOS_BANNER_DISMISSED_KEY) === '1'; } catch (e) {}
      if (isIosSafari() && !isStandalone() && !dismissed) {
        banner.style.display = 'flex';
      }
      if (dismissBtn) {
        dismissBtn.addEventListener('click', () => {
          banner.style.display = 'none';
          try { localStorage.setItem(IOS_BANNER_DISMISSED_KEY, '1'); } catch (e) {}
        });
      }
    }

    async function subscribeForPush() {
      try {
        if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
        const secret = getSecret();
        if (!secret) return;

        const reg = await navigator.serviceWorker.register('/sw.js');

        const keyRes = await fetch('/api/push-subscribe?secret=' + encodeURIComponent(secret));
        const keyJson = await keyRes.json();
        const publicKey = keyJson && keyJson.publicKey;
        if (!publicKey) return; // VAPID keys not configured yet — nothing to do

        let existing = await reg.pushManager.getSubscription();
        if (!existing) {
          existing = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey),
          });
        }

        await fetch('/api/push-subscribe?secret=' + encodeURIComponent(secret), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(existing.toJSON()),
        });
      } catch (e) { /* fail silently — push is a nice-to-have, never blocks chat */ }
    }

    let pushSetupAttempted = false;
    function maybeSetupPush() {
      if (pushSetupAttempted) return;
      if (!('Notification' in window)) return;
      if (Notification.permission === 'granted') { pushSetupAttempted = true; subscribeForPush(); return; }
      if (Notification.permission === 'denied') return;

      // 'default' — ask once, the first time the panel is opened, not on
      // page load (a permission prompt before the user has done anything
      // gets reflexively denied and can't be re-asked).
      let asked = false;
      try { asked = localStorage.getItem(PUSH_ASKED_KEY) === '1'; } catch (e) {}
      if (asked) return;
      pushSetupAttempted = true;
      try { localStorage.setItem(PUSH_ASKED_KEY, '1'); } catch (e) {}
      Notification.requestPermission().then((perm) => {
        if (perm === 'granted') subscribeForPush();
      }).catch(() => {});
    }

    function openChatPanel() {
      modalBg.classList.add('show');
      fab.classList.add('is-open');
      showView('live');
      renderChatHistory();
      maybeShowIosBanner();
      maybeSetupPush();
      setTimeout(() => input.focus(), 50);
    }
    function closeChatPanel() {
      modalBg.classList.remove('show');
      fab.classList.remove('is-open');
    }

    fab.addEventListener('click', openChatPanel);
    closeBtn.addEventListener('click', closeChatPanel);
    historyBtn.addEventListener('click', openHistoryList);
    backBtn.addEventListener('click', backToLive);
    modalBg.addEventListener('click', (e) => { if (e.target === modalBg) closeChatPanel(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modalBg.classList.contains('show')) closeChatPanel();
    });

    // Clicking a push notification (via sw.js) opens the page at
    // ?openChat=1 — auto-open the panel so the tap actually lands
    // somewhere useful instead of just the bare dashboard.
    try {
      if (new URLSearchParams(window.location.search).get('openChat') === '1') {
        openChatPanel();
      }
    } catch (e) {}

    async function sendChatMessage() {
      const text = input.value.trim();
      if (!text) return;

      const stored = loadStoredHistory();
      if (chatHistory.length && (!stored || stored.date !== chatTodayKey())) {
        // Day rolled over while the panel sat open on an older message set.
        archiveToServer(chatHistory.length && stored ? stored.date : null, chatHistory);
        chatHistory = [];
      }

      addBubble('user', text);
      input.value = '';
      input.disabled = true;
      sendBtn.disabled = true;

      const typingEl = addBubble('assistant typing', 'Thinking…');

      const secret = getSecret();

      try {
        const todayContext = typeof window.gatherTodayContext === 'function'
          ? await window.gatherTodayContext()
          : null;

        const res = await fetch('/api/chat?secret=' + encodeURIComponent(secret), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, history: chatHistory, todayContext }),
        });
        const json = await res.json();
        typingEl.remove();

        if (!res.ok) throw new Error(json && json.error ? json.error : ('HTTP ' + res.status));

        chatHistory = Array.isArray(json.history) ? json.history : chatHistory;
        saveChatHistory(chatHistory);
        addBubble('assistant', json.reply || '(no reply)');
        archiveToServer(chatTodayKey(), chatHistory); // best-effort, doesn't block the UI
      } catch (e) {
        typingEl.remove();
        addBubble('error', "Couldn't reach the assistant, try again. (" + (e.message || String(e)) + ')');
      } finally {
        input.disabled = false;
        sendBtn.disabled = false;
        input.focus();
      }
    }

    sendBtn.addEventListener('click', sendChatMessage);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); sendChatMessage(); }
    });
  }

  function blockGesture(e) { e.preventDefault(); }
  function lockGestures() {
    document.addEventListener('gesturestart', blockGesture, { passive: false });
    document.addEventListener('gesturechange', blockGesture, { passive: false });
    document.addEventListener('gestureend', blockGesture, { passive: false });
    let lastTouch = 0;
    document.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - lastTouch <= 300) e.preventDefault();
      lastTouch = now;
    }, { passive: false });
  }
  function startModalLock() {
    const MODAL_SELECTORS = ['.modal-bg', '.po-modal-bg', '.wt-overlay', '.wt-viewer', '.wt-cam', '.chat-modal-bg'];
    function anyOpen() {
      for (const sel of MODAL_SELECTORS) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (el.classList.contains('show') || el.classList.contains('is-open')) return true;
        }
      }
      return false;
    }
    function sync() { document.body.classList.toggle('topbar-modal-open', anyOpen()); }
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true });
    sync();
  }

  function boot() {
    injectStyle();
    injectChrome();
    injectChat();
    const btn = document.getElementById('topbarWaterAdd');
    if (btn) btn.addEventListener('click', (e) => { e.preventDefault(); addWater(); });
    render();
    lockGestures();
    startModalLock();
    window.addEventListener('storage', render);
    window.addEventListener('focus', render);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
    setInterval(render, 30 * 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
