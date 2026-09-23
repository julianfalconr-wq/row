// =============================================================
// Persistent dashboard top bar + bottom tab bar + AI chat FAB.
// Drop this on any page with:
//     <script src="topbar.js" defer></script>
// It self-injects HTML + CSS, reads progress from localStorage,
// and renders the water +1 button in the top bar plus the
// Main/Health/Training bottom tabs. Skips the topbar/bottombar on
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
.topbar-back-btn { margin-right: auto; }
.topbar-icon {
  width: 20px; height: 20px;
  stroke: currentColor; color: rgba(255, 255, 255, 0.85);
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
  width: 24px; height: 24px;
  stroke: currentColor; stroke-width: 1.75;
  transition: transform 0.10s;
}
.bottombar-tab.active { color: #FAFAFA; }
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
  .topbar-icon { width: 18px; height: 18px; }
  .bottombar-tab-icon { width: 22px; height: 22px; }
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
.chat-history-icon { width: 15px; height: 15px; stroke: currentColor; }
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
/* "New version available" toast — see setupFreshnessGuard() below.
   Fixed at the top, above everything (max z-index, same convention as
   the chat FAB/modal), since it needs to be reachable from any page
   regardless of what else is on screen. Literal colors, not
   var(--something) — same reasoning as every other rule in this file
   (see this file's own header comment): this must render correctly
   across all of this project's incompatible CSS-variable schemes. */
.row-update-toast {
  position: fixed; top: max(12px, env(safe-area-inset-top)); left: 50%;
  transform: translateX(-50%);
  z-index: 2147483647;
  display: none;
  align-items: center; gap: 10px;
  padding: 10px 10px 10px 16px;
  background: #17E88F; color: #08110D;
  border-radius: 999px;
  font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
  font-size: 12.5px; font-weight: 700;
  box-shadow: 0 8px 24px rgba(0,0,0,0.35);
  max-width: calc(100vw - 24px);
}
.row-update-toast.show { display: flex; }
.row-update-toast button {
  flex-shrink: 0; border: 0; border-radius: 999px; cursor: pointer;
  font-family: inherit; font-weight: 700; -webkit-tap-highlight-color: transparent;
}
.row-update-reload-btn { padding: 6px 12px; background: #08110D; color: #17E88F; font-size: 12px; }
.row-update-dismiss-btn { padding: 4px 6px; background: transparent; color: #08110D; opacity: 0.6; font-size: 15px; }
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
.chat-plan-card {
  margin-top: 10px;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.10);
  border-radius: 12px;
  padding: 12px 14px;
}
.chat-plan-row {
  display: flex; justify-content: space-between; align-items: baseline; gap: 10px;
  padding: 7px 0;
  border-bottom: 1px solid rgba(255,255,255,0.06);
}
.chat-plan-row:last-of-type { border-bottom: none; }
.chat-plan-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.chat-plan-label { font-size: 9.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #76746E; }
.chat-plan-desc { font-size: 11px; color: #A5A3A0; }
.chat-plan-value { font-size: 12.5px; font-weight: 700; color: #FAFAFA; text-align: right; white-space: nowrap; flex-shrink: 0; }
/* See planRow()'s own comment on wrapValue — used for a row whose
   value is a long free-text string (a goal description) rather than a
   short stat. Stacks label above value instead of side-by-side, and
   lets the value wrap normally at word boundaries at full width,
   so nothing is ever squeezed narrow enough to trip the same
   crushed-flex-item/word-break trap this project has already hit
   twice elsewhere (main.html's nested calendar chip, trends.html). */
.chat-plan-row.is-wrap { flex-direction: column; align-items: flex-start; gap: 4px; }
.chat-plan-row.is-wrap .chat-plan-value { white-space: normal; text-align: left; flex-shrink: 1; width: 100%; }
.chat-plan-rationale { font-size: 11.5px; color: #A5A3A0; margin-top: 10px; line-height: 1.4; font-style: italic; }
.chat-plan-actions { display: flex; gap: 8px; margin-top: 12px; }
.chat-plan-save-btn {
  flex: 1; padding: 10px; border-radius: 10px; border: none;
  background: #1D9E75; color: #08110D; font-family: inherit; font-size: 12.5px; font-weight: 700;
  cursor: pointer;
}
.chat-plan-save-btn:disabled { opacity: 0.5; cursor: default; }
/* Destructive variant (delete-event proposal only) — same layout as
   .chat-plan-save-btn, distinct color so a real deletion doesn't look
   identical to every other "confirm" action. #E5484D matches the mic
   button's existing "is-listening"/recording red above, the one other
   place this file already uses a danger accent. */
.chat-plan-danger-btn {
  flex: 1; padding: 10px; border-radius: 10px; border: none;
  background: #E5484D; color: #FAFAFA; font-family: inherit; font-size: 12.5px; font-weight: 700;
  cursor: pointer;
}
.chat-plan-danger-btn:disabled { opacity: 0.5; cursor: default; }
.chat-plan-dismiss-btn {
  padding: 10px 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.10);
  background: transparent; color: #A5A3A0; font-family: inherit; font-size: 12.5px; font-weight: 600;
  cursor: pointer;
}
.chat-plan-status { font-size: 12px; font-weight: 700; margin-top: 12px; text-align: center; }
.chat-plan-status.is-saved { color: #1D9E75; }
.chat-plan-status.is-dismissed { color: #76746E; font-weight: 600; }
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
.chat-mic-btn {
  flex-shrink: 0; width: 40px; height: 40px; border-radius: 50%;
  background: rgba(255, 255, 255, 0.06); color: #C9C7C2; border: 1px solid rgba(255, 255, 255, 0.08);
  cursor: pointer; font-size: 16px;
  display: flex; align-items: center; justify-content: center;
  transition: transform 0.1s, background 0.15s, color 0.15s;
}
.chat-mic-btn:active { transform: scale(0.92); }
.chat-mic-icon { width: 18px; height: 18px; stroke: currentColor; }
.chat-mic-btn.is-listening {
  background: #E5484D; color: #FAFAFA; border-color: transparent;
  animation: chatMicPulse 1.2s ease-in-out infinite;
}
@keyframes chatMicPulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(229, 72, 77, 0.45); }
  50% { box-shadow: 0 0 0 8px rgba(229, 72, 77, 0); }
}
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
    <i data-lucide="wallet" class="topbar-icon"></i>
  </a>
</header>`;

  const bottombarHtml = `
<nav class="bottombar" id="bottombar" role="navigation" aria-label="Main tabs">
  <a href="main.html" class="bottombar-tab" data-page="main">
    <i data-lucide="home" class="bottombar-tab-icon"></i><span>Main</span>
  </a>
  <a href="health.html" class="bottombar-tab" data-page="health">
    <i data-lucide="pill" class="bottombar-tab-icon"></i><span>Health</span>
  </a>
  <a href="gym.html" class="bottombar-tab" data-page="training">
    <i data-lucide="dumbbell" class="bottombar-tab-icon"></i><span>Training</span>
  </a>
  <a href="habits.html" class="bottombar-tab" data-page="habits">
    <i data-lucide="list-checks" class="bottombar-tab-icon"></i><span>Habits</span>
  </a>
  <a href="trends.html" class="bottombar-tab" data-page="trends">
    <i data-lucide="trending-up" class="bottombar-tab-icon"></i><span>Trends</span>
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
        <button type="button" class="chat-history-btn" id="chatHistoryBtn" aria-label="History"><i data-lucide="history" class="chat-history-icon"></i></button>
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
      <button type="button" id="chatMicBtn" class="chat-mic-btn" aria-label="Voice input" style="display:none"><i data-lucide="mic" class="chat-mic-icon"></i></button>
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
  // The "Chat enabled" General Settings toggle (daylib.js's
  // DEFAULT_PROFILE.chatEnabled) — kept SEPARATE from shouldShowChat()
  // above on purpose: shouldShowChat() decides whether the chat DOM
  // exists at all (never true inside the embedded water-tracker
  // iframe), while this decides whether an ALREADY-injected FAB is
  // currently visible. Injecting the DOM unconditionally (subject only
  // to shouldShowChat()) and toggling visibility separately here is
  // what lets a mid-session Settings change take effect immediately,
  // on this tab and others (see applyChatVisibility()'s callers below),
  // without needing to re-inject a different DOM tree.
  function isChatEnabledInSettings() {
    try {
      if (typeof window.DayLib === 'undefined') return true;
      return window.DayLib.loadProfile().chatEnabled !== false;
    } catch (e) { return true; }
  }
  // Toggles the FAB's visibility to match the setting. Uses an inline
  // style, not the `hidden` attribute — `.chat-fab` already sets its
  // own `display`, and the UA stylesheet's `[hidden] { display: none }`
  // rule is LOWER priority than any author rule regardless of
  // specificity, so `hidden` alone would silently do nothing here (the
  // same class of CSS-cascade gotcha already hit and documented
  // elsewhere in this project). An inline style always wins instead.
  function applyChatVisibility() {
    const fab = document.getElementById('chatFab');
    if (!fab) return; // never injected at all (isEmbedded()) — nothing to toggle
    const enabled = isChatEnabledInSettings();
    fab.style.display = enabled ? '' : 'none';
    if (!enabled) {
      // Force-close an already-open panel too — otherwise a user who
      // had it open when the setting was flipped off (e.g. in another
      // tab) could keep chatting through it with no FAB left to close it.
      const modalBg = document.getElementById('chatModalBg');
      if (modalBg) modalBg.classList.remove('show');
    }
  }
  // Exposed so main.html's General Settings save handler can re-apply
  // this immediately in the SAME tab after toggling (a 'storage' event
  // only fires in OTHER tabs) — same live-update pattern already
  // established for the Day Ring (window.__refreshDayRing).
  window.__applyChatVisibility = applyChatVisibility;
  function currentPageKey() {
    const p = (window.location.pathname || '').toLowerCase();
    if (p.endsWith('health.html')) return 'health';
    if (p.endsWith('gym.html')) return 'training';
    if (p.endsWith('habits.html')) return 'habits';
    if (p.endsWith('trends.html')) return 'trends';
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

  // -------------------------------------------------------------
  // Back button for sub-pages reached from somewhere other than the
  // bottom tab bar (e.g. health.html -> cronometer.html). A sub-page
  // opts in by setting a global BEFORE topbar.js runs:
  //   <script>window.ROW_BACK_TO = 'health.html';</script>
  //   <script src="topbar.js" defer></script>
  // topbar.js then prepends a small "<-" icon button to the shared
  // topbar, styled like the other topbar-icon-btn buttons, linking
  // back to that specific page (not just browser history). Pages that
  // don't set window.ROW_BACK_TO get no button, same as today.
  // -------------------------------------------------------------
  function injectBackButton() {
    const target = window.ROW_BACK_TO;
    if (typeof target !== 'string' || !target) return;
    const topbarEl = document.getElementById('topbar');
    if (!topbarEl || document.getElementById('topbarBackBtn')) return;
    const back = document.createElement('a');
    back.href = target;
    back.className = 'topbar-icon-btn topbar-back-btn';
    back.id = 'topbarBackBtn';
    back.setAttribute('aria-label', 'Back');
    // A real Lucide SVG icon, not a text glyph — matching every OTHER
    // .topbar-icon-btn exactly (e.g. Finance's <i data-lucide="wallet">
    // below). .topbar-icon's width/height/stroke CSS only has any
    // effect on a replaced element like an SVG; on a plain text <span>
    // those are no-ops, so the "←" character sat at its own font's
    // baseline/glyph metrics instead of truly centered in the button —
    // visibly off relative to every sibling icon, which IS a properly
    // centered SVG. injectBackButton() runs (via injectChrome()) before
    // boot()'s own window.RowIcons.render() call below, so this gets
    // picked up and converted to inline SVG in the same pass as every
    // other icon, with identical centering.
    back.innerHTML = '<i data-lucide="arrow-left" class="topbar-icon"></i>';
    topbarEl.insertBefore(back, topbarEl.firstChild);
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
    injectBackButton();
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

    // ---------- staleness helpers ----------
    // Cronometer's nutrition section already fell back to the most
    // RECENTLY synced date when today's isn't available (see below) —
    // reasonable for the app's own display, but the chat was passing
    // that same fallback along as if it were today's data with no way
    // for the model to tell the difference, so a 5-day-old sync got
    // presented as "what you ate today". daysStale (0 = genuinely
    // today) makes that distinction explicit for the model instead of
    // silent. Applied the same way to Whoop below, since a live fetch
    // still only returns whatever WHOOP's own most recent record is —
    // if the user hasn't worn/synced the device, that can be several
    // days old too, same failure mode as Cronometer.
    function keyToUTCMs(key) {
      const parts = String(key || '').split('-').map(Number);
      if (parts.length !== 3 || parts.some((n) => !n && n !== 0)) return null;
      return Date.UTC(parts[0], parts[1] - 1, parts[2]);
    }
    function daysStaleFromToday(dateKeyStr) {
      const a = keyToUTCMs(todayKey);
      const b = keyToUTCMs(dateKeyStr);
      if (a == null || b == null) return null;
      return Math.round((a - b) / 86400000);
    }

    const todayKey = activeDateKey();
    const gymTodayKey = calDateKey();

    // ---------- 1 & 2. Nutrition + goals/targets (Cronometer) ----------
    // Reuses window.CronoLib (cronometer-lib.js), loaded on every page —
    // exactly what health.html's own Cronometer section calls.
    let nutrition = { connected: false, date: null, daysStale: null, totals: null, score: null };
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
          // Falls back to the most recently synced date when today's own
          // isn't there yet — daysStale (computed below) is what tells
          // the model whether that fallback actually kicked in.
          const dateKey = dates.includes(todayKey) ? todayKey : (dates[0] || null);
          if (dateKey) {
            const totals = window.CronoLib.sumNutrientsForDate(result.rows, result.headers, dateKey, targets);
            totals.supplements = window.CronoLib.getStackCompletionForDate(dateKey);
            const scored = window.CronoLib.computeScore(totals, targets);
            nutrition = {
              connected: true,
              date: dateKey,
              daysStale: daysStaleFromToday(dateKey),
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

    // ---------- 4b. Activities (running/cardio history) ----------
    // po_coach_activities: [{ id, dateKey, activityTypeId, distanceKm?,
    // count?, durationMin?, effort, notes }] — the canonical storage
    // from the multi-activity-type generalization (gym.html's own
    // header comment on ACTIVITY_KEY). Before this, the chat had NO
    // visibility into running/cardio at all — the "gym" section above
    // only ever covered strength (po_coach_v1) — so a question like
    // "should I run 21km Wednesday" had no real volume/history data to
    // answer from, yet the model could still claim to have "looked and
    // found nothing" rather than never having had a running section to
    // check in the first place. Bounded to the last 28 days and
    // summarized per activity type (longest/total distance + up to 8
    // recent entries), same "recent + summarized, not a full dump"
    // convention as every other section here.
    const allActivities = safeParse('po_coach_activities', []);
    const activityWindowStart = new Date(); activityWindowStart.setDate(activityWindowStart.getDate() - 28);
    const recentActivities = (Array.isArray(allActivities) ? allActivities : [])
      .filter((a) => a && a.dateKey && new Date(a.dateKey) >= activityWindowStart)
      .sort((a, b) => (a.dateKey < b.dateKey ? 1 : -1));

    // Resolves activityTypeId -> a real name/unit via the same server
    // config gym.html's own Activities tab reads (api/sync-state.js's
    // resource=activity-types) — falls back to the one built-in
    // "Running" default on any failure (secret not set, offline,
    // etc.), matching this project's established fall-back-to-defaults
    // convention, so a fetch failure here never blocks the rest of
    // gatherTodayContext(). Small per-scope duplication of
    // gym.html's own fetchActivityTypes() rather than a shared import —
    // this function has to work standalone on every page.
    const activitiesSecret = (() => { try { return localStorage.getItem('dashboard:secret') || ''; } catch (e) { return ''; } })();
    let activityTypesForContext = [{ id: 'running', name: 'Running', unit: 'km', unitKind: 'distance' }];
    if (activitiesSecret && recentActivities.length) {
      try {
        const r = await fetch('/api/sync-state?secret=' + encodeURIComponent(activitiesSecret) + '&resource=activity-types');
        const j = await r.json();
        if (j && j.ok && Array.isArray(j.types) && j.types.length) activityTypesForContext = j.types;
      } catch (e) { /* keep the built-in default */ }
    }
    function activityTypeNameFor(id) {
      const t = activityTypesForContext.find((x) => x.id === id);
      return t ? t.name : id;
    }

    const activitiesByType = {};
    recentActivities.forEach((a) => {
      const key = a.activityTypeId || 'unknown';
      (activitiesByType[key] = activitiesByType[key] || []).push(a);
    });
    const activities = {
      windowDays: 28,
      byType: Object.keys(activitiesByType).map((typeId) => {
        const entries = activitiesByType[typeId];
        const distances = entries.map((a) => a.distanceKm).filter((d) => d != null);
        return {
          activityName: activityTypeNameFor(typeId),
          sessionsLast28Days: entries.length,
          longestDistanceKm: distances.length ? round1(Math.max(...distances)) : null,
          totalDistanceKm: distances.length ? round1(distances.reduce((sum, d) => sum + d, 0)) : null,
          recent: entries.slice(0, 8).map((a) => ({
            date: a.dateKey,
            distanceKm: a.distanceKm != null ? round1(a.distanceKm) : null,
            count: a.count != null ? a.count : null,
            durationMin: a.durationMin != null ? a.durationMin : null,
            effort: a.effort || null,
          })),
        };
      }),
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
      // dataDate/daysStale describe the RECOVERY record's own date (WHOOP's
      // "?limit=1" always returns whatever its most recent record actually
      // is) — a different thing from lastSyncedMinutesAgo above, which is
      // just when index.html's manual Sync button last ran and says
      // nothing about whether that data is for today. If the user hasn't
      // worn/synced their WHOOP device, the recovery score returned here
      // can genuinely be several days old, same failure mode as
      // Cronometer's nutrition section above.
      dataDate: null, daysStale: null,
      recoveryPct: null, sleepDuration: null, sleepPct: null,
      hrv: null, rhr: null, strain: null,
    };
    const whoopTokens = safeParse(WHOOP_KEY, null);
    if (whoopTokens && whoopTokens.access) {
      const whoopLastSync = Number(localStorage.getItem('whoop_last_sync')) || null;
      whoop.connected = true;
      whoop.lastSyncedMinutesAgo = whoopLastSync ? Math.round((Date.now() - whoopLastSync) / 60000) : null;

      // Shared cooldown key — same convention as health.html's WHOOP card,
      // gym.html's Training page, and index.html's settings modal, all of
      // which independently fetch WHOOP data. A refresh failure anywhere
      // sets this, so the others (this one included) skip retrying too
      // instead of each hammering /api/whoop-refresh on its own next call —
      // this function in particular runs on every chat message sent, so
      // without this it would retry a dead refresh token every single time.
      const WHOOP_REFRESH_COOLDOWN_KEY = 'whoop_refresh_cooldown_until';
      const WHOOP_REFRESH_COOLDOWN_MS = 20 * 60 * 1000; // 20 minutes
      function isWhoopRefreshCoolingDown() { return Date.now() < (Number(localStorage.getItem(WHOOP_REFRESH_COOLDOWN_KEY)) || 0); }
      function startWhoopRefreshCooldown() { try { localStorage.setItem(WHOOP_REFRESH_COOLDOWN_KEY, String(Date.now() + WHOOP_REFRESH_COOLDOWN_MS)); } catch (e) {} }
      function clearWhoopRefreshCooldown() { try { localStorage.removeItem(WHOOP_REFRESH_COOLDOWN_KEY); } catch (e) {} }

      async function refreshWhoopToken(t) {
        if (!t.refresh) return null;
        if (isWhoopRefreshCoolingDown()) return null;
        try {
          const r = await fetch('/api/whoop-refresh', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: t.refresh }),
          });
          const j = await r.json();
          if (j.access_token) {
            const next = { access: j.access_token, refresh: j.refresh_token || t.refresh, expires: Date.now() + (j.expires_in || 3500) * 1000 };
            try { localStorage.setItem(WHOOP_KEY, JSON.stringify(next)); } catch (e) {}
            clearWhoopRefreshCooldown();
            return next;
          }
        } catch (e) {}
        startWhoopRefreshCooldown();
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
        const recRecord = rec && rec.records && rec.records[0];
        const r = recRecord && recRecord.score;
        if (r) {
          whoop.recoveryPct = Math.round(r.recovery_score || 0);
          whoop.hrv = Math.round(r.hrv_rmssd_milli || 0);
          whoop.rhr = Math.round(r.resting_heart_rate || 0);
        }
        if (recRecord && recRecord.created_at) {
          // Local calendar date, not a slice of the UTC ISO string —
          // same UTC-vs-local trap this project has fixed elsewhere
          // (see daylib.js's header comment) would silently misdate this
          // near local midnight in negative-UTC-offset timezones.
          whoop.dataDate = calDateKey(new Date(recRecord.created_at));
          whoop.daysStale = daysStaleFromToday(whoop.dataDate);
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

    // ---------- 6. Plan (long-term goal feature, plan.html Phase 3) ----------
    // Progress-engine formulas ported verbatim from plan.html's own
    // (weightAsOf/strengthBestAsOf/runningTotalForWeek/checkpointStatus
    // — see that file's own comments) — duplicated per this file's
    // established per-scope convention (see e.g. WHOOP fetch/refresh
    // logic already independently duplicated in health.html/gym.html/
    // index.html/main.html) rather than computed server-side, which
    // has no access to localStorage at all. Pre-computed here, not
    // left for the model to reason about from raw numbers, for the
    // same reason this project never asks an LLM to do exact
    // arithmetic (see api/training.js's wakeUpTime comment) — a
    // "how's my plan going" review needs real hit/missed/current
    // status per checkpoint, not the model's own guess at the math.
    function planWeightAsOf(weights, asOfKey) {
      let best = null;
      for (const w of weights) { if (w.dateKey > asOfKey) break; if (w.weight != null) best = w.weight; }
      return best;
    }
    function planEstimate1RM(w, r) { if (r < 2) return w; return w * (1 + r / 30); }
    function planFindExercise(gymState, name) {
      if (!name) return null;
      const target = name.trim().toLowerCase();
      return (gymState.exercises || []).find((ex) => (ex.name || '').trim().toLowerCase() === target) || null;
    }
    function planStrengthBestAsOf(gymState, exercise, asOfKey) {
      if (!exercise) return null;
      const logs = (gymState.logs && gymState.logs[exercise.id]) || [];
      let best = null;
      logs.forEach((l) => {
        if (l.date == null) return;
        const dk = String(l.date).slice(0, 10);
        if (dk > asOfKey) return;
        const val = exercise.bw ? l.reps : planEstimate1RM(l.weight, l.reps);
        if (val != null && (best == null || val > best)) best = val;
      });
      return best;
    }
    function planAddDaysKey(dateKeyStr, n) {
      const [y, m, d] = dateKeyStr.split('-').map(Number);
      const dt = new Date(y, m - 1, d);
      dt.setDate(dt.getDate() + n);
      return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
    }
    function planMostRecentCheckpointWeekStart(checkpoints, asOfKey) {
      let best = null;
      (checkpoints || []).forEach((cp) => { if (cp.weekStartDate <= asOfKey) { if (!best || cp.weekStartDate > best) best = cp.weekStartDate; } });
      return best;
    }
    function planRunningTotalForWeek(activitiesArr, activityTypeId, weekStartKey, weekEndKey) {
      let total = 0, any = false;
      activitiesArr.forEach((a) => {
        if (!a || !a.dateKey || a.distanceKm == null) return;
        if (a.dateKey < weekStartKey || a.dateKey > weekEndKey) return;
        if (activityTypeId && a.activityTypeId !== activityTypeId) return;
        total += a.distanceKm; any = true;
      });
      return any ? Math.round(total * 100) / 100 : null;
    }
    function planActualAsOf(planObj, sources, asOfKey) {
      if (planObj.goalType === 'weight_gain' || planObj.goalType === 'weight_loss') return planWeightAsOf(sources.weights, asOfKey);
      if (planObj.goalType === 'strength_pr') return planStrengthBestAsOf(sources.gymState, sources.matchedExercise, asOfKey);
      if (planObj.goalType === 'running_distance') {
        const weekStart = planMostRecentCheckpointWeekStart(planObj.weeklyCheckpoints, asOfKey);
        if (!weekStart) return null;
        return planRunningTotalForWeek(sources.activitiesArr, planObj.goalActivityTypeId, weekStart, planAddDaysKey(weekStart, 6));
      }
      return null; // "other" — no auto-tracked series, same as plan.html
    }
    function planIsIncreasingGoal(goalType) { return goalType !== 'weight_loss'; }
    function planCheckpointStatus(planObj, cp, current, todayK) {
      const weekEnd = planAddDaysKey(cp.weekStartDate, 6);
      if (todayK >= cp.weekStartDate && todayK <= weekEnd) return 'current';
      if (todayK < cp.weekStartDate) return 'upcoming';
      if (current == null) return 'missed';
      const hit = planIsIncreasingGoal(planObj.goalType) ? current >= cp.targetValue : current <= cp.targetValue;
      return hit ? 'hit' : 'missed';
    }

    // Uses DayLib.effectiveDateKey() when available (matches plan.html's
    // own "today" exactly — the Day Ring's configured day-end, not the
    // 6am rollover activeDateKey() above uses for nutrition/foodScans),
    // falling back to activeDateKey() on the pages that don't load
    // daylib.js at all (finance.html, cronometer.html) — see this
    // section's own fallback precedent elsewhere in this file.
    const planTodayKey = (typeof window.DayLib !== 'undefined') ? window.DayLib.effectiveDateKey() : todayKey;
    let plan = { active: null, pastPlanCount: 0 };
    if (activitiesSecret) {
      try {
        const r = await fetch('/api/sync-state?secret=' + encodeURIComponent(activitiesSecret) + '&resource=plans');
        const j = await r.json();
        const allPlans = (j && j.ok && Array.isArray(j.plans)) ? j.plans : [];
        const activePlan = allPlans.find((p) => p.status === 'active') || null;
        plan.pastPlanCount = allPlans.filter((p) => p.status !== 'active').length;
        if (activePlan) {
          const matchedExercise = activePlan.goalType === 'strength_pr' ? planFindExercise(pcState || {}, activePlan.goalExerciseName) : null;
          const sources = { weights: bodyWeights, gymState: pcState || { exercises: [], logs: {} }, activitiesArr: allActivities, matchedExercise };
          const currentValue = planActualAsOf(activePlan, sources, planTodayKey);
          const checkpoints = (activePlan.weeklyCheckpoints || []).map((cp) => {
            const weekEnd = planAddDaysKey(cp.weekStartDate, 6);
            const asOf = weekEnd < planTodayKey ? weekEnd : planTodayKey;
            const actualAtWeekEnd = planActualAsOf(activePlan, sources, asOf);
            return {
              weekNumber: cp.weekNumber, weekStartDate: cp.weekStartDate, targetValue: cp.targetValue,
              status: planCheckpointStatus(activePlan, cp, actualAtWeekEnd, planTodayKey),
              actualAtWeekEnd,
            };
          });
          plan.active = {
            id: activePlan.id, goalDescription: activePlan.goalDescription, goalType: activePlan.goalType,
            targetValue: activePlan.targetValue, startValue: activePlan.startValue, targetUnit: activePlan.targetUnit,
            goalExerciseName: activePlan.goalExerciseName || null, goalActivityTypeId: activePlan.goalActivityTypeId || null,
            startDate: activePlan.startDate, endDate: activePlan.endDate,
            currentValue, checkpoints,
          };
        }
      } catch (e) { /* leave plan at its default — secret unset, offline, or the plans table not created yet */ }
    }

    // ---------- 7. Finance ----------
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

    // ---------- 8. Daily Stack (supplements) ----------
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

    // ---------- 9. Calendar ----------
    // google_tokens_v1 = { access, refresh, expires } — same shape/spirit
    // as whoop_tokens_v1 above. Live-fetches today + the next few days
    // (via api/google-callback.js's ?action=list proxy) so the chat can
    // see what's already scheduled before proposing a new event — this
    // is exactly why propose_calendar_event needs this section to exist
    // (see api/chat.js). Uses the same cooldown-on-failed-refresh
    // circuit breaker convention as the WHOOP section above (own key,
    // so a dead Google token doesn't block WHOOP retries or vice versa).
    const GOOGLE_KEY = 'google_tokens_v1';
    let calendar = { connected: false, upcoming: [] };
    const googleTokens = safeParse(GOOGLE_KEY, null);
    if (googleTokens && googleTokens.access) {
      calendar.connected = true;
      const GOOGLE_REFRESH_COOLDOWN_KEY = 'google_refresh_cooldown_until';
      const GOOGLE_REFRESH_COOLDOWN_MS = 20 * 60 * 1000;
      function isGoogleRefreshCoolingDown() { return Date.now() < (Number(localStorage.getItem(GOOGLE_REFRESH_COOLDOWN_KEY)) || 0); }
      function startGoogleRefreshCooldown() { try { localStorage.setItem(GOOGLE_REFRESH_COOLDOWN_KEY, String(Date.now() + GOOGLE_REFRESH_COOLDOWN_MS)); } catch (e) {} }
      function clearGoogleRefreshCooldown() { try { localStorage.removeItem(GOOGLE_REFRESH_COOLDOWN_KEY); } catch (e) {} }

      // No dashboard:secret on these two calls — api/google-callback.js's
      // refresh/list modes are gated only by possession of a valid Google
      // bearer/refresh token (matching WHOOP's actual security model:
      // api/whoop-refresh.js and api/whoop-data.js don't check
      // DASHBOARD_SECRET either). Only its client-id mode requires the
      // secret, and this function never calls that mode.
      async function refreshGoogleToken(t) {
        if (!t.refresh) return null;
        if (isGoogleRefreshCoolingDown()) return null;
        try {
          const r = await fetch('/api/google-callback?action=refresh', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: t.refresh }),
          });
          const j = await r.json();
          if (j.access_token) {
            const next = { access: j.access_token, refresh: j.refresh_token || t.refresh, expires: Date.now() + (j.expires_in || 3500) * 1000 };
            try { localStorage.setItem(GOOGLE_KEY, JSON.stringify(next)); } catch (e) {}
            clearGoogleRefreshCooldown();
            return next;
          }
        } catch (e) {}
        startGoogleRefreshCooldown();
        return null;
      }
      async function calendarFetch(qs, t) {
        const r = await fetch('/api/google-callback?action=list&' + qs, {
          headers: { Authorization: 'Bearer ' + t.access },
        });
        if (r.status === 401) { const n = await refreshGoogleToken(t); if (n) return calendarFetch(qs, n); throw new Error('unauthorized'); }
        if (!r.ok) throw new Error('Calendar ' + r.status);
        return r.json();
      }

      try {
        let t = googleTokens;
        if (t.expires && Date.now() > t.expires - 60000) { const n = await refreshGoogleToken(t); if (n) t = n; }
        const timeMin = new Date();
        const timeMax = new Date(); timeMax.setDate(timeMax.getDate() + 5);
        const qs = new URLSearchParams({ timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString() }).toString();
        const data = await calendarFetch(qs, t);
        calendar.upcoming = (Array.isArray(data.items) ? data.items : []).slice(0, 20).map((ev) => ({
          // id is the real Google Calendar event id — added so the chat's
          // propose_calendar_event_update/propose_calendar_event_delete
          // tools (api/chat.js) have something real to target. Every
          // Calendar API event always carries one; never guessed/derived.
          id: ev.id || null,
          title: ev.summary || '(untitled)',
          start: (ev.start && (ev.start.dateTime || ev.start.date)) || null,
          end: (ev.end && (ev.end.dateTime || ev.end.date)) || null,
          allDay: !!(ev.start && ev.start.date),
        }));
      } catch (e) { /* leave calendar.connected true but upcoming empty — token exists but fetch failed */ }
    }

    return { date: todayKey, nutrition, goals, foodScans, gym, activities, whoop, plan, finance, dailyStack, calendar };
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

    // ---------- weekly training objectives proposal (see api/chat.js's
    // propose_training_objectives tool) ----------
    // Renders the plan as a distinct card with explicit Save/Not now
    // actions — this is the first place chat can influence real app
    // data, so nothing is written to localStorage until the user taps
    // Save. Writes to the exact same po_coach_weekly_plan_v1 key/shape
    // gym.html's own "Generate" button already uses (see gym.html's
    // PLAN_KEY/saveStoredPlan/thisWeekMondayKey), so the Training page's
    // progress bars and rendering pick it up with no changes there.
    const PLAN_KEY = 'po_coach_weekly_plan_v1';
    function mondayOfLocal(d) {
      const date = new Date(d);
      const day = date.getDay(); // 0 = Sun .. 6 = Sat
      const diff = (day === 0 ? -6 : 1) - day;
      date.setDate(date.getDate() + diff);
      date.setHours(0, 0, 0, 0);
      return date;
    }
    function dateKeyLocal(d) {
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    function thisWeekMondayKeyLocal() { return dateKeyLocal(mondayOfLocal(new Date())); }

    // wrapValue: every OTHER caller passes a short, single-line stat as
    // value (e.g. "81 kg", "3 sessions/wk") — .chat-plan-value's
    // white-space:nowrap/flex-shrink:0/text-align:right suits that
    // correctly and must stay unchanged for those. renderLongTermPlanCard's
    // own Goal/Adjusted-goal row is different: value there is the
    // user's full free-text goal description, which can be arbitrarily
    // long (e.g. "Preparación Sprint Triathlon (750m nado, 20km bici,
    // 5km correr) en 6 semanas") — forcing THAT onto one nowrap,
    // never-shrinking line broke two ways at once: the long line
    // itself forced the whole card into horizontal scroll, and since
    // it can't shrink at all, 100% of the row's flex-shrink fell on
    // the LABEL side instead (.chat-plan-main has min-width:0, so
    // nothing stopped it), crushing "GOAL" down near 0 width — and
    // because .chat-bubble sets word-break:break-word (inherited by
    // everything inside it), WebKit's automatic minimum size for that
    // crushed label dropped to a single glyph, wrapping it letter by
    // letter (G/O/A/L stacked). wrapValue:true switches the row to a
    // column layout instead — label on its own line, the long value
    // wrapping normally at word boundaries underneath, full width —
    // so nothing is ever squeezed by a competing nowrap sibling.
    function planRow(label, value, desc, wrapValue) {
      const row = document.createElement('div');
      row.className = 'chat-plan-row' + (wrapValue ? ' is-wrap' : '');
      // label is escaped too (not just value/desc) since Phase 3 of the
      // multi-activity-type feature started interpolating an
      // activityName into it — ultimately a user-chosen activity type
      // name from General Settings, no longer a guaranteed-safe literal.
      row.innerHTML =
        '<div class="chat-plan-main">' +
          '<span class="chat-plan-label">' + escapeHtml(label) + '</span>' +
          (desc ? '<span class="chat-plan-desc">' + escapeHtml(desc) + '</span>' : '') +
        '</div>' +
        '<span class="chat-plan-value">' + escapeHtml(value) + '</span>';
      return row;
    }

    function renderPlanCard(container, plan) {
      const card = document.createElement('div');
      card.className = 'chat-plan-card';

      // Phase 3 of the multi-activity-type generalization: cardio slots
      // each carry their own assigned activityName now (plan.running is
      // gone), rather than always being "running".
      const interval = plan.cardio.interval;
      const longSession = plan.cardio.longSession;
      const easyVolume = plan.cardio.easyVolume;
      card.appendChild(planRow('Strength', plan.strength.targetSessions + ' sessions/wk', plan.strength.focus));
      card.appendChild(planRow('Interval / VO2 max' + (interval.activityName ? ' — ' + interval.activityName : ''), interval.targetSessions + '× · ' + interval.targetMinutes + ' min', interval.description));
      card.appendChild(planRow('Long session' + (longSession.activityName ? ' — ' + longSession.activityName : ''), longSession.targetAmount + (longSession.unit ? ' ' + longSession.unit : ''), longSession.description));
      card.appendChild(planRow('Easy volume' + (easyVolume.activityName ? ' — ' + easyVolume.activityName : ''), easyVolume.targetAmount + (easyVolume.unit ? ' ' + easyVolume.unit : ''), easyVolume.description));

      if (plan.rationale) {
        const rationale = document.createElement('div');
        rationale.className = 'chat-plan-rationale';
        rationale.textContent = plan.rationale;
        card.appendChild(rationale);
      }

      const actions = document.createElement('div');
      actions.className = 'chat-plan-actions';
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button'; saveBtn.className = 'chat-plan-save-btn';
      saveBtn.textContent = "Save as this week's objectives";
      const dismissBtn = document.createElement('button');
      dismissBtn.type = 'button'; dismissBtn.className = 'chat-plan-dismiss-btn';
      dismissBtn.textContent = 'Not now';
      actions.appendChild(saveBtn);
      actions.appendChild(dismissBtn);
      card.appendChild(actions);

      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        try {
          // Resolve each cardio slot's free-text activityName (all the
          // chat tool can produce — see PROPOSE_OBJECTIVES_TOOL's header
          // comment in api/chat.js) against the user's REAL configured
          // activity types, by exact case-insensitive name match, so a
          // chat-negotiated plan ties into progress-tracking the same
          // way a "Generate" button plan does. No match -> leave that
          // slot's activityTypeId unset; its label/targets still display
          // correctly, it just won't connect to logged activities.
          // Deliberately no auto-create here (unlike Phase 2's WHOOP
          // import) — see that same header comment for why.
          let types = [];
          try {
            const secret = getSecret();
            if (secret) {
              const r = await fetch('/api/sync-state?secret=' + encodeURIComponent(secret) + '&resource=activity-types');
              const j = await r.json();
              if (j && j.ok && Array.isArray(j.types)) types = j.types;
            }
          } catch (e) {}
          const resolved = JSON.parse(JSON.stringify(plan));
          ['interval', 'longSession', 'easyVolume'].forEach((slotKey) => {
            const slot = resolved.cardio && resolved.cardio[slotKey];
            if (!slot) return;
            const match = types.find((t) => t && typeof t.name === 'string' && t.name.trim().toLowerCase() === String(slot.activityName || '').trim().toLowerCase());
            if (match) { slot.activityTypeId = match.id; slot.activityName = match.name; if (match.unit) slot.unit = match.unit; }
          });
          localStorage.setItem(PLAN_KEY, JSON.stringify({ weekStart: thisWeekMondayKeyLocal(), plan: resolved, generatedAt: new Date().toISOString() }));
        } catch (e) {}
        actions.remove();
        const status = document.createElement('div');
        status.className = 'chat-plan-status is-saved';
        status.textContent = 'Saved ✓ — check the Training page';
        card.appendChild(status);
      });
      dismissBtn.addEventListener('click', () => {
        actions.remove();
        const status = document.createElement('div');
        status.className = 'chat-plan-status is-dismissed';
        status.textContent = 'Not saved';
        card.appendChild(status);
      });

      container.appendChild(card);
    }

    // ---------- calendar event proposal (see api/chat.js's
    // propose_calendar_event tool) ----------
    // Same explicit-confirmation pattern as renderPlanCard above, reusing
    // its generic .chat-plan-* card styling — nothing is created until
    // the user taps Create. Duplicates a small refresh-and-create routine
    // rather than reaching into gatherTodayContext()'s Google helpers
    // (a sibling function's locals aren't visible here), matching this
    // project's established pattern of small per-scope duplication over
    // cross-function plumbing (see e.g. health.html/gym.html/index.html
    // each having their own independent WHOOP fetch logic).
    function renderCalendarEventCard(container, event) {
      const card = document.createElement('div');
      card.className = 'chat-plan-card';

      card.appendChild(planRow('Event', event.summary, event.description || ''));
      card.appendChild(planRow('Date', event.date, ''));
      card.appendChild(planRow('Time', event.startTime + '–' + event.endTime, ''));

      const actions = document.createElement('div');
      actions.className = 'chat-plan-actions';
      const createBtn = document.createElement('button');
      createBtn.type = 'button'; createBtn.className = 'chat-plan-save-btn';
      createBtn.textContent = 'Create event';
      const dismissBtn = document.createElement('button');
      dismissBtn.type = 'button'; dismissBtn.className = 'chat-plan-dismiss-btn';
      dismissBtn.textContent = 'Not now';
      actions.appendChild(createBtn);
      actions.appendChild(dismissBtn);
      card.appendChild(actions);

      function showStatus(text, isSaved) {
        actions.remove();
        const status = document.createElement('div');
        status.className = 'chat-plan-status ' + (isSaved ? 'is-saved' : 'is-dismissed');
        status.textContent = text;
        card.appendChild(status);
      }

      const GOOGLE_KEY = 'google_tokens_v1';
      const GOOGLE_COOLDOWN_KEY = 'google_refresh_cooldown_until';
      const GOOGLE_COOLDOWN_MS = 20 * 60 * 1000;
      function loadGoogleTokens() { try { return JSON.parse(localStorage.getItem(GOOGLE_KEY)); } catch (e) { return null; } }
      function saveGoogleTokens(t) { try { localStorage.setItem(GOOGLE_KEY, JSON.stringify(t)); } catch (e) {} }
      // Shares the cooldown KEY with gatherTodayContext()'s and
      // main.html's Google sections (same convention as WHOOP's) — a
      // failed refresh anywhere stops all three from hammering
      // api/google-callback.js's refresh mode on their own next attempt.
      function isGoogleCoolingDown() { return Date.now() < (Number(localStorage.getItem(GOOGLE_COOLDOWN_KEY)) || 0); }
      function startGoogleCooldown() { try { localStorage.setItem(GOOGLE_COOLDOWN_KEY, String(Date.now() + GOOGLE_COOLDOWN_MS)); } catch (e) {} }
      function clearGoogleCooldown() { try { localStorage.removeItem(GOOGLE_COOLDOWN_KEY); } catch (e) {} }

      async function refreshGoogle(t) {
        if (!t.refresh) return null;
        if (isGoogleCoolingDown()) return null;
        try {
          const r = await fetch('/api/google-callback?action=refresh', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: t.refresh }),
          });
          const j = await r.json();
          if (j.access_token) {
            const next = { access: j.access_token, refresh: j.refresh_token || t.refresh, expires: Date.now() + (j.expires_in || 3500) * 1000 };
            saveGoogleTokens(next);
            clearGoogleCooldown();
            return next;
          }
        } catch (e) {}
        startGoogleCooldown();
        return null;
      }

      async function doCreate(tok) {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const r = await fetch('/api/google-callback?action=create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok.access },
          body: JSON.stringify({
            summary: event.summary,
            description: event.description || undefined,
            start: { dateTime: event.date + 'T' + event.startTime + ':00', timeZone: tz },
            end: { dateTime: event.date + 'T' + event.endTime + ':00', timeZone: tz },
          }),
        });
        if (r.status === 401) {
          const n = await refreshGoogle(tok);
          if (n) return doCreate(n);
          throw new Error('unauthorized');
        }
        if (!r.ok) throw new Error('Calendar ' + r.status);
        return r.json();
      }

      createBtn.addEventListener('click', async () => {
        const t = loadGoogleTokens();
        if (!t || !t.access) { showStatus('Connect Google Calendar on the main dashboard first.', false); return; }
        createBtn.disabled = true;
        try {
          await doCreate(t);
          showStatus('Created ✓ — check your calendar', true);
        } catch (e) {
          createBtn.disabled = false;
          showStatus('Could not create event: ' + (e.message || String(e)), false);
        }
      });
      dismissBtn.addEventListener('click', () => showStatus('Not created', false));

      container.appendChild(card);
    }

    // ---------- calendar event UPDATE proposal (move/edit a REAL
    // existing event — see api/chat.js's propose_calendar_event_update
    // tool) ----------
    // Same explicit-confirmation pattern as renderCalendarEventCard
    // above, and duplicates the same small Google token load/refresh
    // helpers rather than sharing them (this project's established
    // per-scope-duplication convention — see that function's own
    // comment). Real destructive/modifying calendar access (unlike
    // create), so there is still no auto-apply path here at all: the
    // event is only ever touched after the user taps "Update event".
    function renderCalendarEventUpdateCard(container, update) {
      const card = document.createElement('div');
      card.className = 'chat-plan-card';

      const finalDate = update.date || update.originalDate;
      const finalStart = update.startTime || update.originalStartTime;
      const finalEnd = update.endTime || update.originalEndTime;
      const finalSummary = update.summary || update.originalSummary;

      card.appendChild(planRow('Event', finalSummary, finalSummary !== update.originalSummary ? ('was: ' + update.originalSummary) : ''));
      card.appendChild(planRow('Date', finalDate, finalDate !== update.originalDate ? ('was: ' + update.originalDate) : ''));
      card.appendChild(planRow(
        'Time',
        finalStart + '–' + finalEnd,
        (finalStart !== update.originalStartTime || finalEnd !== update.originalEndTime)
          ? ('was: ' + update.originalStartTime + '–' + update.originalEndTime)
          : ''
      ));

      const actions = document.createElement('div');
      actions.className = 'chat-plan-actions';
      const applyBtn = document.createElement('button');
      applyBtn.type = 'button'; applyBtn.className = 'chat-plan-save-btn';
      applyBtn.textContent = 'Update event';
      const dismissBtn = document.createElement('button');
      dismissBtn.type = 'button'; dismissBtn.className = 'chat-plan-dismiss-btn';
      dismissBtn.textContent = 'Not now';
      actions.appendChild(applyBtn);
      actions.appendChild(dismissBtn);
      card.appendChild(actions);

      function showStatus(text, isSaved) {
        actions.remove();
        const status = document.createElement('div');
        status.className = 'chat-plan-status ' + (isSaved ? 'is-saved' : 'is-dismissed');
        status.textContent = text;
        card.appendChild(status);
      }

      const GOOGLE_KEY = 'google_tokens_v1';
      const GOOGLE_COOLDOWN_KEY = 'google_refresh_cooldown_until';
      const GOOGLE_COOLDOWN_MS = 20 * 60 * 1000;
      function loadGoogleTokens() { try { return JSON.parse(localStorage.getItem(GOOGLE_KEY)); } catch (e) { return null; } }
      function saveGoogleTokens(t) { try { localStorage.setItem(GOOGLE_KEY, JSON.stringify(t)); } catch (e) {} }
      function isGoogleCoolingDown() { return Date.now() < (Number(localStorage.getItem(GOOGLE_COOLDOWN_KEY)) || 0); }
      function startGoogleCooldown() { try { localStorage.setItem(GOOGLE_COOLDOWN_KEY, String(Date.now() + GOOGLE_COOLDOWN_MS)); } catch (e) {} }
      function clearGoogleCooldown() { try { localStorage.removeItem(GOOGLE_COOLDOWN_KEY); } catch (e) {} }

      async function refreshGoogle(t) {
        if (!t.refresh) return null;
        if (isGoogleCoolingDown()) return null;
        try {
          const r = await fetch('/api/google-callback?action=refresh', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: t.refresh }),
          });
          const j = await r.json();
          if (j.access_token) {
            const next = { access: j.access_token, refresh: j.refresh_token || t.refresh, expires: Date.now() + (j.expires_in || 3500) * 1000 };
            saveGoogleTokens(next);
            clearGoogleCooldown();
            return next;
          }
        } catch (e) {}
        startGoogleCooldown();
        return null;
      }

      // Always sends a COMPLETE start/end pair (never a lone dateTime)
      // whenever either changed — Google's PATCH treats start/end as
      // whole nested objects, not deep-merged field-by-field, so a
      // partial {dateTime} with the other end left off would silently
      // corrupt the event's other boundary rather than actually moving it.
      async function doUpdate(tok) {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const eventBody = {};
        if (update.summary && update.summary !== update.originalSummary) eventBody.summary = update.summary;
        if (finalDate !== update.originalDate || finalStart !== update.originalStartTime || finalEnd !== update.originalEndTime) {
          eventBody.start = { dateTime: finalDate + 'T' + finalStart + ':00', timeZone: tz };
          eventBody.end = { dateTime: finalDate + 'T' + finalEnd + ':00', timeZone: tz };
        }
        const r = await fetch('/api/google-callback?action=update&eventId=' + encodeURIComponent(update.eventId), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok.access },
          body: JSON.stringify(eventBody),
        });
        if (r.status === 401) {
          const n = await refreshGoogle(tok);
          if (n) return doUpdate(n);
          throw new Error('unauthorized');
        }
        if (!r.ok) throw new Error('Calendar ' + r.status);
        return r.json();
      }

      applyBtn.addEventListener('click', async () => {
        const t = loadGoogleTokens();
        if (!t || !t.access) { showStatus('Connect Google Calendar on the main dashboard first.', false); return; }
        applyBtn.disabled = true;
        try {
          await doUpdate(t);
          showStatus('Updated ✓ — check your calendar', true);
        } catch (e) {
          applyBtn.disabled = false;
          showStatus('Could not update event: ' + (e.message || String(e)), false);
        }
      });
      dismissBtn.addEventListener('click', () => showStatus('Not changed', false));

      container.appendChild(card);
    }

    // ---------- calendar event DELETE proposal (cancel a REAL existing
    // event — see api/chat.js's propose_calendar_event_delete tool)
    // ----------
    // Same pattern as the update card above, with a visually distinct
    // danger-styled confirm button (.chat-plan-danger-btn) since this is
    // the one card type whose confirmation is irreversible.
    function renderCalendarEventDeleteCard(container, del) {
      const card = document.createElement('div');
      card.className = 'chat-plan-card';

      card.appendChild(planRow('Delete event', del.summary, del.date));
      card.appendChild(planRow('Time', del.startTime + '–' + del.endTime, ''));

      const actions = document.createElement('div');
      actions.className = 'chat-plan-actions';
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button'; deleteBtn.className = 'chat-plan-danger-btn';
      deleteBtn.textContent = 'Delete event';
      const dismissBtn = document.createElement('button');
      dismissBtn.type = 'button'; dismissBtn.className = 'chat-plan-dismiss-btn';
      dismissBtn.textContent = 'Keep it';
      actions.appendChild(deleteBtn);
      actions.appendChild(dismissBtn);
      card.appendChild(actions);

      function showStatus(text, isSaved) {
        actions.remove();
        const status = document.createElement('div');
        status.className = 'chat-plan-status ' + (isSaved ? 'is-saved' : 'is-dismissed');
        status.textContent = text;
        card.appendChild(status);
      }

      const GOOGLE_KEY = 'google_tokens_v1';
      const GOOGLE_COOLDOWN_KEY = 'google_refresh_cooldown_until';
      const GOOGLE_COOLDOWN_MS = 20 * 60 * 1000;
      function loadGoogleTokens() { try { return JSON.parse(localStorage.getItem(GOOGLE_KEY)); } catch (e) { return null; } }
      function saveGoogleTokens(t) { try { localStorage.setItem(GOOGLE_KEY, JSON.stringify(t)); } catch (e) {} }
      function isGoogleCoolingDown() { return Date.now() < (Number(localStorage.getItem(GOOGLE_COOLDOWN_KEY)) || 0); }
      function startGoogleCooldown() { try { localStorage.setItem(GOOGLE_COOLDOWN_KEY, String(Date.now() + GOOGLE_COOLDOWN_MS)); } catch (e) {} }
      function clearGoogleCooldown() { try { localStorage.removeItem(GOOGLE_COOLDOWN_KEY); } catch (e) {} }

      async function refreshGoogle(t) {
        if (!t.refresh) return null;
        if (isGoogleCoolingDown()) return null;
        try {
          const r = await fetch('/api/google-callback?action=refresh', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: t.refresh }),
          });
          const j = await r.json();
          if (j.access_token) {
            const next = { access: j.access_token, refresh: j.refresh_token || t.refresh, expires: Date.now() + (j.expires_in || 3500) * 1000 };
            saveGoogleTokens(next);
            clearGoogleCooldown();
            return next;
          }
        } catch (e) {}
        startGoogleCooldown();
        return null;
      }

      async function doDelete(tok) {
        const r = await fetch('/api/google-callback?action=delete&eventId=' + encodeURIComponent(del.eventId), {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + tok.access },
        });
        if (r.status === 401) {
          const n = await refreshGoogle(tok);
          if (n) return doDelete(n);
          throw new Error('unauthorized');
        }
        if (!r.ok) throw new Error('Calendar ' + r.status);
      }

      deleteBtn.addEventListener('click', async () => {
        const t = loadGoogleTokens();
        if (!t || !t.access) { showStatus('Connect Google Calendar on the main dashboard first.', false); return; }
        deleteBtn.disabled = true;
        try {
          await doDelete(t);
          showStatus('Deleted ✓', true);
        } catch (e) {
          deleteBtn.disabled = false;
          showStatus('Could not delete event: ' + (e.message || String(e)), false);
        }
      });
      dismissBtn.addEventListener('click', () => showStatus('Kept — not deleted', false));

      container.appendChild(card);
    }

    // ---------- restriction proposal (see api/chat.js's
    // propose_restriction tool) ----------
    // Same explicit-confirmation pattern as the two cards above. Saving
    // just writes the row via api/sync-state.js's resource=restrictions
    // — no Google/WHOOP tokens involved here, unlike the calendar card,
    // so there's no refresh-and-retry plumbing to duplicate.
    function renderRestrictionCard(container, restriction) {
      const card = document.createElement('div');
      card.className = 'chat-plan-card';

      card.appendChild(planRow('Restriction', restriction.text, restriction.scope ? ('Scope: ' + restriction.scope) : ''));
      card.appendChild(planRow('Dates', restriction.starts_on + ' – ' + restriction.ends_on, ''));

      const actions = document.createElement('div');
      actions.className = 'chat-plan-actions';
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button'; saveBtn.className = 'chat-plan-save-btn';
      saveBtn.textContent = 'Save restriction';
      const dismissBtn = document.createElement('button');
      dismissBtn.type = 'button'; dismissBtn.className = 'chat-plan-dismiss-btn';
      dismissBtn.textContent = 'Not now';
      actions.appendChild(saveBtn);
      actions.appendChild(dismissBtn);
      card.appendChild(actions);

      function showStatus(text, isSaved) {
        actions.remove();
        const status = document.createElement('div');
        status.className = 'chat-plan-status ' + (isSaved ? 'is-saved' : 'is-dismissed');
        status.textContent = text;
        card.appendChild(status);
      }

      saveBtn.addEventListener('click', async () => {
        const secret = getSecret();
        if (!secret) { showStatus('Set your dashboard secret first (on the Cronometer page).', false); return; }
        saveBtn.disabled = true;
        try {
          // resource= must be in the QUERY STRING, not just the body —
          // the server's dispatch reads req.query.resource only. Without
          // it this silently fell through to the legacy {key,data}
          // branch and failed with "key must be one of: gym, finance,
          // dailystack".
          const r = await fetch('/api/sync-state?secret=' + encodeURIComponent(secret) + '&resource=restrictions', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resource: 'restrictions', action: 'create', restriction: restriction }),
          });
          const j = await r.json();
          if (!r.ok || !j.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
          showStatus('Saved ✓ — Training will respect this', true);
        } catch (e) {
          showStatus('Could not save: ' + (e.message || String(e)), false);
        }
      });
      dismissBtn.addEventListener('click', () => showStatus('Not saved', false));

      container.appendChild(card);
    }

    // ---------- today's session override (see api/chat.js's
    // propose_today_session tool) ----------
    // Same explicit-confirmation pattern as the cards above, but purely
    // client-side — no server call at all, just a localStorage write
    // to the exact same po_coach_today_recommendation_v1 entry
    // gym.html's Training page already reads (the "generate once,
    // cache until tapped" entry from the earlier caching fix), so the
    // Training card picks it up with zero extra plumbing on that side.
    // Also updates ttText/ttSub directly if they exist in THIS page's
    // DOM right now (i.e. the user has Training open in the same tab
    // as the chat) — a bare localStorage write alone doesn't push to
    // already-rendered DOM on its own, and the chat widget can be open
    // on any page, not just gym.html.
    function renderTodaySessionCard(container, session) {
      const card = document.createElement('div');
      card.className = 'chat-plan-card';

      card.appendChild(planRow('Today’s session', session.recommendation, session.sub || ''));

      const actions = document.createElement('div');
      actions.className = 'chat-plan-actions';
      const replaceBtn = document.createElement('button');
      replaceBtn.type = 'button'; replaceBtn.className = 'chat-plan-save-btn';
      replaceBtn.textContent = 'Replace today’s session';
      const dismissBtn = document.createElement('button');
      dismissBtn.type = 'button'; dismissBtn.className = 'chat-plan-dismiss-btn';
      dismissBtn.textContent = 'Not now';
      actions.appendChild(replaceBtn);
      actions.appendChild(dismissBtn);
      card.appendChild(actions);

      function showStatus(text, isSaved) {
        actions.remove();
        const status = document.createElement('div');
        status.className = 'chat-plan-status ' + (isSaved ? 'is-saved' : 'is-dismissed');
        status.textContent = text;
        card.appendChild(status);
      }

      replaceBtn.addEventListener('click', () => {
        try {
          localStorage.setItem('po_coach_today_recommendation_v1', JSON.stringify({
            recommendation: session.recommendation,
            sub: session.sub || '',
            dateKey: window.DayLib.effectiveDateKey(),
            generatedAt: new Date().toISOString(),
          }));
          const ttText = document.getElementById('ttText');
          const ttSub = document.getElementById('ttSub');
          if (ttText) ttText.textContent = session.recommendation;
          if (ttSub) ttSub.textContent = session.sub || '';
          showStatus('Replaced ✓ — check Training', true);
        } catch (e) {
          showStatus('Could not replace: ' + (e.message || String(e)), false);
        }
      });
      dismissBtn.addEventListener('click', () => showStatus('Not replaced — original kept', false));

      container.appendChild(card);
    }

    // ---------- long-term plan proposal (see api/chat.js's
    // propose_long_term_plan tool / plan.html Phase 1) ----------
    // Same explicit-confirmation, API-backed-save pattern as
    // renderRestrictionCard above (POST to api/sync-state.js's
    // resource=plans, not a localStorage write) — a Plan is multi-
    // device state the same way a restriction is, not a per-device
    // cache like renderTodaySessionCard's.
    function renderLongTermPlanCard(container, plan) {
      const isAdjustment = !!plan.adjustsPlanId;
      const card = document.createElement('div');
      card.className = 'chat-plan-card';

      const trackedAs = plan.exerciseName ? (' — ' + plan.exerciseName) : (plan.activityName ? (' — ' + plan.activityName) : '');
      card.appendChild(planRow(isAdjustment ? 'Adjusted goal' : 'Goal', plan.goalDescription + trackedAs, '', true));
      card.appendChild(planRow('Target', plan.targetValue + ' ' + plan.targetUnit, 'from ' + plan.startValue + ' ' + plan.targetUnit + ' now'));
      // wrapValue:true here too — unlike Target's short value ("1
      // triatlón"), a full date range ("2026-09-16 → 2026-10-27") is
      // long enough that forcing it onto one nowrap line, competing
      // against the "Timeframe"/"From this week" label for the same
      // narrow width, still crushed the label across 2 lines with a
      // mid-word break (confirmed live). A min-width floor on the
      // label was tried first and rejected: it stopped the crush but
      // pushed the row's total demanded width past the card's own,
      // reintroducing horizontal overflow instead. Stacking, like
      // Goal, has no such tradeoff — it fits by construction.
      card.appendChild(planRow(isAdjustment ? 'From this week' : 'Timeframe', plan.startDate + ' → ' + plan.endDate, plan.weeklyCheckpoints.length + (isAdjustment ? ' adjusted' : ' weekly') + ' checkpoint' + (plan.weeklyCheckpoints.length === 1 ? '' : 's'), true));
      if (plan.rationale) {
        const rationale = document.createElement('div');
        rationale.className = 'chat-plan-rationale';
        rationale.textContent = plan.rationale;
        card.appendChild(rationale);
      }

      const actions = document.createElement('div');
      actions.className = 'chat-plan-actions';
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button'; saveBtn.className = 'chat-plan-save-btn';
      saveBtn.textContent = isAdjustment ? 'Save adjustment' : 'Save plan';
      const dismissBtn = document.createElement('button');
      dismissBtn.type = 'button'; dismissBtn.className = 'chat-plan-dismiss-btn';
      dismissBtn.textContent = 'Not now';
      actions.appendChild(saveBtn);
      actions.appendChild(dismissBtn);
      card.appendChild(actions);

      function showStatus(text, isSaved) {
        actions.remove();
        const status = document.createElement('div');
        status.className = 'chat-plan-status ' + (isSaved ? 'is-saved' : 'is-dismissed');
        status.textContent = text;
        card.appendChild(status);
      }

      saveBtn.addEventListener('click', async () => {
        const secret = getSecret();
        if (!secret) { showStatus('Set your dashboard secret first (on the Cronometer page).', false); return; }
        saveBtn.disabled = true;
        try {
          // Resolve the model's free-text activityName against the
          // user's REAL configured activity types (exact same
          // case-insensitive match renderPlanCard's cardio slots
          // already use) so a running_distance plan ties into
          // plan.html's real weekly-distance tracking — that page
          // filters logged activities by activityTypeId, a real
          // configured id, not a name string. goalExerciseName needs
          // no such resolution: plan.html's own strength_pr tracking
          // matches by NAME directly (findExercise() in plan.html),
          // exactly like Phase 1's schema already expects.
          let goalActivityTypeId = null;
          if (plan.goalType === 'running_distance' && plan.activityName) {
            try {
              const r = await fetch('/api/sync-state?secret=' + encodeURIComponent(secret) + '&resource=activity-types');
              const j = await r.json();
              const types = (j && j.ok && Array.isArray(j.types)) ? j.types : [];
              const match = types.find((t) => t && typeof t.name === 'string' && t.name.trim().toLowerCase() === plan.activityName.trim().toLowerCase());
              if (match) goalActivityTypeId = match.id;
            } catch (e) {}
          }

          if (!isAdjustment) {
            const payload = {
              goalDescription: plan.goalDescription,
              goalType: plan.goalType,
              targetValue: plan.targetValue,
              startValue: plan.startValue,
              targetUnit: plan.targetUnit,
              goalExerciseName: (plan.goalType === 'strength_pr' && plan.exerciseName) ? plan.exerciseName : null,
              goalActivityTypeId,
              startDate: plan.startDate,
              endDate: plan.endDate,
              weeklyCheckpoints: plan.weeklyCheckpoints,
            };
            const r = await fetch('/api/sync-state?secret=' + encodeURIComponent(secret) + '&resource=plans', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ resource: 'plans', action: 'create', plan: payload }),
            });
            const j = await r.json();
            if (!r.ok || !j.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
            showStatus('Saved ✓ — check the Plan page', true);
            return;
          }

          // Adjustment (adjustsPlanId set): re-fetch the plan fresh
          // (never trust a copy from earlier in the conversation —
          // it may have been ended/adjusted again since) so past
          // checkpoints reflect real current state. Every checkpoint
          // whose weekStartDate is BEFORE this proposal's own
          // startDate (always "today", computed server-side — see
          // normalizeProposedLongTermPlan's own comment) is a real,
          // already-elapsed hit/missed record and is kept byte-for-
          // byte unchanged; the new proposal's checkpoints (already
          // dated correctly from today) replace everything from the
          // current week onward, renumbered to continue the SAME
          // weekNumber sequence rather than restarting at 1 — so
          // "week 5" stays week 5 whether or not it came from the
          // original proposal or an adjustment.
          const listRes = await fetch('/api/sync-state?secret=' + encodeURIComponent(secret) + '&resource=plans');
          const listJson = await listRes.json();
          const existing = (listJson && listJson.ok && Array.isArray(listJson.plans)) ? listJson.plans.find((p) => p.id === plan.adjustsPlanId) : null;
          if (!existing) { showStatus('Could not find that plan — it may have already been ended.', false); return; }
          const pastCheckpoints = (existing.weeklyCheckpoints || []).filter((cp) => cp.weekStartDate < plan.startDate);
          const newCheckpoints = plan.weeklyCheckpoints.map((cp, i) => ({
            weekNumber: pastCheckpoints.length + i + 1,
            weekStartDate: cp.weekStartDate,
            targetValue: cp.targetValue,
          }));
          const mergedCheckpoints = pastCheckpoints.concat(newCheckpoints);
          const lastCp = newCheckpoints.length ? newCheckpoints[newCheckpoints.length - 1] : null;
          const patch = {
            targetValue: plan.targetValue,
            weeklyCheckpoints: mergedCheckpoints,
          };
          if (plan.goalDescription) patch.goalDescription = plan.goalDescription;
          if (lastCp) {
            const [y, m, d] = lastCp.weekStartDate.split('-').map(Number);
            const endDt = new Date(y, m - 1, d); endDt.setDate(endDt.getDate() + 6);
            patch.endDate = endDt.getFullYear() + '-' + String(endDt.getMonth() + 1).padStart(2, '0') + '-' + String(endDt.getDate()).padStart(2, '0');
          }
          const r = await fetch('/api/sync-state?secret=' + encodeURIComponent(secret) + '&resource=plans', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resource: 'plans', action: 'update', id: plan.adjustsPlanId, patch }),
          });
          const j = await r.json();
          if (!r.ok || !j.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
          showStatus('Adjustment saved ✓ — check the Plan page', true);
        } catch (e) {
          showStatus('Could not save: ' + (e.message || String(e)), false);
        }
      });
      dismissBtn.addEventListener('click', () => showStatus('Not saved', false));

      container.appendChild(card);
    }

    // ---------- plan status change proposal (see api/chat.js's
    // propose_plan_status_change tool) ----------
    // Same explicit-confirmation, API-backed-save pattern as
    // renderRestrictionCard — posts action="update" to the SAME
    // api/sync-state.js resource=plans endpoint Phase 1 already built
    // (no server changes needed for this at all).
    function renderPlanStatusChangeCard(container, change) {
      const card = document.createElement('div');
      card.className = 'chat-plan-card';

      card.appendChild(planRow('Plan', change.goalDescription, ''));
      card.appendChild(planRow('Mark as', change.status === 'completed' ? 'Completed ✓' : 'Abandoned', ''));

      const actions = document.createElement('div');
      actions.className = 'chat-plan-actions';
      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'button'; confirmBtn.className = 'chat-plan-save-btn';
      confirmBtn.textContent = change.status === 'completed' ? 'Mark completed' : 'Abandon plan';
      const dismissBtn = document.createElement('button');
      dismissBtn.type = 'button'; dismissBtn.className = 'chat-plan-dismiss-btn';
      dismissBtn.textContent = 'Not now';
      actions.appendChild(confirmBtn);
      actions.appendChild(dismissBtn);
      card.appendChild(actions);

      function showStatus(text, isSaved) {
        actions.remove();
        const status = document.createElement('div');
        status.className = 'chat-plan-status ' + (isSaved ? 'is-saved' : 'is-dismissed');
        status.textContent = text;
        card.appendChild(status);
      }

      confirmBtn.addEventListener('click', async () => {
        const secret = getSecret();
        if (!secret) { showStatus('Set your dashboard secret first (on the Cronometer page).', false); return; }
        confirmBtn.disabled = true;
        try {
          const r = await fetch('/api/sync-state?secret=' + encodeURIComponent(secret) + '&resource=plans', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resource: 'plans', action: 'update', id: change.id, patch: { status: change.status } }),
          });
          const j = await r.json();
          if (!r.ok || !j.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
          showStatus((change.status === 'completed' ? 'Marked completed ✓' : 'Abandoned ✓') + ' — check the Plan page', true);
        } catch (e) {
          showStatus('Could not save: ' + (e.message || String(e)), false);
        }
      });
      dismissBtn.addEventListener('click', () => showStatus('Not changed', false));

      container.appendChild(card);
    }

    // proposedCalendarEvents/Updates/Deletes are ARRAYS — a complex
    // request (e.g. "fit my run in before dinner, move whatever you
    // need to") can produce several proposals of the same type in one
    // reply, each rendered as its OWN separate confirmation card (never
    // merged into one), so the user sees and approves every real-
    // calendar change individually. See api/chat.js's handler comment
    // on why this can't just be a single object per type.
    function addBubble(role, text, proposedObjectives, proposedCalendarEvents, proposedRestriction, proposedTodaySession, proposedCalendarEventUpdates, proposedCalendarEventDeletes, proposedLongTermPlan, proposedPlanStatusChange) {
      emptyEl.style.display = 'none';
      const el = document.createElement('div');
      el.className = 'chat-bubble ' + role;
      renderBubbleContent(el, text);
      if (proposedObjectives) renderPlanCard(el, proposedObjectives);
      (proposedCalendarEvents || []).forEach((ev) => renderCalendarEventCard(el, ev));
      if (proposedRestriction) renderRestrictionCard(el, proposedRestriction);
      if (proposedTodaySession) renderTodaySessionCard(el, proposedTodaySession);
      (proposedCalendarEventUpdates || []).forEach((u) => renderCalendarEventUpdateCard(el, u));
      (proposedCalendarEventDeletes || []).forEach((d) => renderCalendarEventDeleteCard(el, d));
      if (proposedLongTermPlan) renderLongTermPlanCard(el, proposedLongTermPlan);
      if (proposedPlanStatusChange) renderPlanStatusChangeCard(el, proposedPlanStatusChange);
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
    // interrupt a normal chat session. See api/push.js (merged from the
    // former api/push-subscribe.js + api/send-notification.js),
    // api/daily-checkin.js, and sw.js.
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

    // TEMPORARY diagnostic logging (see [push] console lines) — added to
    // find why push_subscriptions has 0 rows despite iOS reporting
    // notification permission granted. Remove once the root cause is
    // confirmed and fixed; the original version silently swallowed every
    // failure here, which is exactly what made this impossible to debug.
    async function subscribeForPush() {
      console.log('[push] subscribeForPush() called');
      try {
        const support = {
          serviceWorker: 'serviceWorker' in navigator,
          PushManager: 'PushManager' in window,
          Notification: 'Notification' in window,
        };
        console.log('[push] browser support:', support);
        if (!support.serviceWorker || !support.PushManager || !support.Notification) {
          console.log('[push] ABORT: missing required browser API');
          return;
        }

        const secret = getSecret();
        console.log('[push] dashboard:secret present in localStorage:', !!secret);
        if (!secret) { console.log('[push] ABORT: no dashboard:secret — never reached service worker registration'); return; }

        console.log('[push] registering /sw.js ...');
        // updateViaCache:'none' — without it, the DEFAULT is 'imports',
        // meaning the browser's update check for sw.js itself (and any
        // importScripts()'d file) may be satisfied from HTTP cache
        // rather than the network. This app's HTTP responses are
        // already max-age=0 (confirmed against the live deployment),
        // so this is belt-and-suspenders rather than the fix for a
        // confirmed bug, but it's the technically-correct explicit
        // option regardless — see setupFreshnessGuard() for the actual
        // update-detection/reload-prompt mechanism.
        const reg = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
        console.log('[push] service worker registered, scope:', reg.scope);

        console.log('[push] fetching VAPID public key from /api/push ...');
        const keyRes = await fetch('/api/push?secret=' + encodeURIComponent(secret));
        console.log('[push] GET /api/push status:', keyRes.status);
        const keyJson = await keyRes.json();
        console.log('[push] GET /api/push body:', keyJson);
        const publicKey = keyJson && keyJson.publicKey;
        if (!publicKey) { console.log('[push] ABORT: no publicKey in response — VAPID keys likely not set server-side'); return; }

        let existing = await reg.pushManager.getSubscription();
        console.log('[push] existing pushManager subscription:', existing ? existing.endpoint : null);
        if (!existing) {
          console.log('[push] calling pushManager.subscribe() ...');
          existing = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey),
          });
          console.log('[push] pushManager.subscribe() resolved:', existing.endpoint);
        }

        console.log('[push] POSTing subscription to /api/push?action=subscribe ...');
        const postRes = await fetch('/api/push?action=subscribe&secret=' + encodeURIComponent(secret), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(existing.toJSON()),
        });
        const postJson = await postRes.json().catch(() => null);
        console.log('[push] POST /api/push?action=subscribe status:', postRes.status, 'body:', postJson);
      } catch (e) {
        console.error('[push] subscribeForPush() THREW:', e && (e.message || String(e)), e);
      }
    }

    let pushSetupAttempted = false;
    function maybeSetupPush() {
      if (pushSetupAttempted) { console.log('[push] maybeSetupPush: already attempted this page load, skipping'); return; }
      if (!('Notification' in window)) { console.log('[push] maybeSetupPush: no Notification API'); return; }
      console.log('[push] maybeSetupPush: Notification.permission =', Notification.permission);
      if (Notification.permission === 'granted') { pushSetupAttempted = true; subscribeForPush(); return; }
      if (Notification.permission === 'denied') { console.log('[push] maybeSetupPush: permission denied, not asking'); return; }

      // 'default' — ask once, the first time the panel is opened, not on
      // page load (a permission prompt before the user has done anything
      // gets reflexively denied and can't be re-asked).
      let asked = false;
      try { asked = localStorage.getItem(PUSH_ASKED_KEY) === '1'; } catch (e) {}
      console.log('[push] maybeSetupPush: permission default, already asked before =', asked);
      if (asked) return;
      pushSetupAttempted = true;
      try { localStorage.setItem(PUSH_ASKED_KEY, '1'); } catch (e) {}
      Notification.requestPermission().then((perm) => {
        console.log('[push] Notification.requestPermission() resolved:', perm);
        if (perm === 'granted') subscribeForPush();
      }).catch((e) => console.error('[push] Notification.requestPermission() THREW:', e));
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
    // somewhere useful instead of just the bare dashboard. Gated on the
    // same setting as the FAB itself — a stale/queued notification link
    // shouldn't be able to open chat after the user has turned it off.
    try {
      if (new URLSearchParams(window.location.search).get('openChat') === '1' && isChatEnabledInSettings()) {
        openChatPanel();
      }
    } catch (e) {}

    async function sendChatMessage() {
      // Hard backstop, not just relying on the FAB being hidden/the
      // panel being force-closed elsewhere (applyChatVisibility()) —
      // this is the ONE place that actually calls /api/chat, so it's
      // the one place that must never do so while the setting is off,
      // regardless of how the panel happened to still be open.
      if (!isChatEnabledInSettings()) return;
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
        const events = Array.isArray(json.proposedCalendarEvents) ? json.proposedCalendarEvents : [];
        const updates = Array.isArray(json.proposedCalendarEventUpdates) ? json.proposedCalendarEventUpdates : [];
        const deletes = Array.isArray(json.proposedCalendarEventDeletes) ? json.proposedCalendarEventDeletes : [];
        const fallbackText = json.proposedObjectives
          ? "Here's what I'm proposing for this week:"
          : (events.length ? (events.length > 1 ? "Here are the events I'm proposing:" : "Here's the event I'm proposing:")
          : (json.proposedRestriction ? "Here's the restriction I'm proposing:"
          : (json.proposedTodaySession ? "Here's the replacement I'm proposing for today's session:"
          : (json.proposedLongTermPlan ? "Here's the plan I'm proposing:"
          : (json.proposedPlanStatusChange ? "Here's what I'm proposing:"
          : (updates.length ? (updates.length > 1 ? "Here are the changes I'm proposing:" : "Here's the change I'm proposing:")
          : (deletes.length ? (deletes.length > 1 ? "Here are the events I'm proposing to delete:" : "Here's what I'm proposing to delete:")
          : '(no reply)')))))));
        addBubble('assistant', json.reply || fallbackText, json.proposedObjectives || null, events, json.proposedRestriction || null, json.proposedTodaySession || null, updates, deletes, json.proposedLongTermPlan || null, json.proposedPlanStatusChange || null);
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

    // ---------- voice input ----------
    // Native browser speech-to-text (Web Speech API). Chrome/Edge expose
    // it as SpeechRecognition, Safari/iOS only as the prefixed
    // webkitSpeechRecognition — feature-detect both and hide the mic
    // entirely (rather than show a button that errors on tap) when
    // neither exists. continuous=false means the browser's own silence
    // detection stops listening after a natural pause, same as tapping
    // the button again mid-utterance.
    const micBtn = document.getElementById('chatMicBtn');
    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (micBtn && SpeechRecognitionCtor) {
      micBtn.style.display = 'flex';
      let recognition = null;
      let listening = false;
      // Text already in the box when listening started — interim/final
      // results replace only what voice input has added, so typing first
      // and then dictating more doesn't clobber what was typed.
      let baseText = '';

      function stopListening() {
        listening = false;
        micBtn.classList.remove('is-listening');
        if (recognition) { try { recognition.stop(); } catch (e) {} }
      }

      micBtn.addEventListener('click', () => {
        if (listening) { stopListening(); return; }

        recognition = new SpeechRecognitionCtor();
        recognition.lang = (navigator.language || 'en-US');
        recognition.continuous = false;
        recognition.interimResults = true;

        baseText = input.value ? input.value + ' ' : '';
        listening = true;
        micBtn.classList.add('is-listening');

        recognition.onresult = (e) => {
          let transcript = '';
          for (let i = 0; i < e.results.length; i++) transcript += e.results[i][0].transcript;
          input.value = baseText + transcript;
        };
        recognition.onerror = () => stopListening();
        recognition.onend = () => stopListening();

        try { recognition.start(); } catch (e) { stopListening(); }
      });
    }
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

  // Shared entry point for rendering Lucide icons (<i data-lucide="...">
  // placeholders -> inline SVG), used both here and by any other page's
  // own dynamic re-renders that introduce new data-lucide elements
  // (e.g. finance.html's empty states, health.html's Daily Stack list) —
  // one place to keep the stroke width consistent everywhere, per the
  // "consistent stroke width across every instance" requirement. Safe
  // to call repeatedly; Lucide skips elements already converted to SVG.
  // Lucide's own <script> tag is loaded (deferred, before topbar.js's
  // own tag) by every page directly, not injected here, so there's no
  // load-order race to worry about — see daylib.js's header comment for
  // the general shape of that lesson, learned the hard way earlier in
  // this project.
  window.RowIcons = {
    render: function () {
      if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 1.75 } });
    },
  };

  // =============================================================
  // Freshness guard — mitigates "the app on my phone feels stuck on an
  // old version" reports. Investigated first, not assumed: sw.js does
  // no caching at all (no fetch handler), and this app's own HTTP
  // responses are already `cache-control: max-age=0, must-revalidate`
  // (confirmed against the live deployment), so neither explains
  // staleness by itself. The most likely real cause — iOS suspending/
  // freezing the standalone PWA's WebKit process instead of reloading
  // it on reopen, or a plain browser bfcache restore — can't be
  // confirmed from this environment, but both are exactly what these
  // two standard, independently-useful mechanisms detect and recover
  // from, so both are added rather than betting on one specific theory.
  //
  // 1. bfcache/frozen-page resume (pageshow + event.persisted): fires
  //    whenever the browser hands back a previously-rendered page from
  //    a frozen snapshot instead of actually re-running this page's
  //    scripts, which is exactly the "reopened the app, it's showing
  //    what it showed before I backgrounded it" symptom. Applies to
  //    every visitor, service worker or not.
  // 2. Service worker update detection: only meaningful for the subset
  //    of users with push notifications enabled — sw.js is ONLY ever
  //    registered inside subscribeForPush() below, never
  //    unconditionally, so this deliberately does not register one
  //    itself (that would be a real behavior change for everyone else,
  //    out of scope here); it only acts on a registration that already
  //    exists. Shows a dismissible "tap to refresh" toast rather than
  //    silently reloading — an unprompted reload could drop an
  //    in-progress PIN entry, chat message, or Settings edit.
  // =============================================================
  function showUpdateToast() {
    let toast = document.getElementById('rowUpdateToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'rowUpdateToast';
      toast.className = 'row-update-toast';
      toast.innerHTML =
        '<span>Update available</span>' +
        '<button type="button" class="row-update-reload-btn" id="rowUpdateReloadBtn">Refresh</button>' +
        '<button type="button" class="row-update-dismiss-btn" id="rowUpdateDismissBtn" aria-label="Dismiss">×</button>';
      document.body.appendChild(toast);
      toast.querySelector('#rowUpdateReloadBtn').addEventListener('click', () => location.reload());
      toast.querySelector('#rowUpdateDismissBtn').addEventListener('click', () => toast.classList.remove('show'));
    }
    toast.classList.add('show');
  }

  function setupFreshnessGuard() {
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) location.reload();
    });

    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.getRegistration().then((reg) => {
      if (!reg) return;
      // A worker sitting in 'installed' (waiting) state right now means
      // an update was already found and finished installing before this
      // listener was attached (e.g. it happened between page loads) —
      // surface the toast immediately instead of only for FUTURE updates.
      if (reg.waiting) showUpdateToast();
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          // 'installed' + an existing controller means this is a real
          // UPDATE (not the very first install, which also passes
          // through 'installed' but has no controller yet to replace).
          if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdateToast();
        });
      });
      // Browsers only check for a new sw.js on navigation or roughly
      // every 24h on their own — too infrequent for an app that can sit
      // open/backgrounded for a long time between real navigations.
      reg.update().catch(() => {});
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    }).catch(() => {});
  }

  function boot() {
    injectStyle();
    injectChrome();
    injectChat();
    applyChatVisibility();
    setupFreshnessGuard();
    window.RowIcons.render();
    const btn = document.getElementById('topbarWaterAdd');
    if (btn) btn.addEventListener('click', (e) => { e.preventDefault(); addWater(); });
    render();
    lockGestures();
    startModalLock();
    // applyChatVisibility() rides the same reactive triggers as the
    // water pill's render() — a 'storage' event catches the toggle
    // being flipped in ANOTHER tab, focus/visibilitychange and the
    // interval catch it having changed while this tab was backgrounded.
    window.addEventListener('storage', render);
    window.addEventListener('storage', applyChatVisibility);
    window.addEventListener('focus', render);
    window.addEventListener('focus', applyChatVisibility);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); applyChatVisibility(); } });
    setInterval(render, 30 * 1000);
    setInterval(applyChatVisibility, 30 * 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
