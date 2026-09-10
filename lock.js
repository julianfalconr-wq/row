// =============================================================
// Casual PIN lock for the whole app — a client-side deterrent, like
// a notes app's PIN, NOT real security. Anyone with devtools access
// can bypass this in seconds (e.g. running
// `sessionStorage.setItem('dashboard:unlocked','1')` in the console
// unlocks everything). It exists only to stop a casual glance from
// someone who picked up an already-unlocked phone — completely
// separate from DASHBOARD_SECRET, which is the REAL, server-side
// gate protecting every api/*.js endpoint. DASHBOARD_SECRET is not
// read, written, or modified by this file for anything except an
// optional "forgot PIN" recovery comparison (see recoverWithSecret()
// below) — it still does 100% of the actual security work and must
// never be treated as replaceable by this PIN.
//
// LOAD ORDER — the same class of bug already caught twice in this
// project (daylib.js, RowIcons in topbar.js), but sharper here: the
// whole point of a lock screen is that it must cover the page BEFORE
// any content is visible or interactive, not "shortly after". So
// this is loaded as a plain BLOCKING <script src="lock.js"></script>
// (no defer, no async), placed as the very first script in <head> on
// every page, before even the theme-detection script. Being
// render-blocking at the very top of every page is a deliberate,
// unavoidable cost of that requirement — this file is kept tiny and
// dependency-free so that cost stays small. The very first line that
// runs sets documentElement's visibility to hidden, synchronously,
// before the parser has even reached <body> — nothing on the page
// can render or receive focus/clicks until reveal() below explicitly
// undoes that. The lock overlay itself then opts back in with
// `visibility: visible` (a CSS-legal override of a hidden ancestor),
// so it's the only thing shown while the real page stays invisible
// underneath.
//
// Storage:
//   localStorage['dashboard:lock_pin_hash'] — SHA-256 hex digest of
//     the PIN, never the plaintext, so a casual look at localStorage
//     in devtools doesn't hand over the actual PIN. Device-local, NOT
//     synced across devices — this project's Supabase sync is opt-in
//     per data type and this deliberately isn't one of them; syncing
//     a PIN would need its own real auth story server-side, exactly
//     the complexity this feature is intentionally not taking on.
//     Each device you use Row on needs its own PIN set up once.
//   sessionStorage['dashboard:unlocked'] — presence means "unlocked
//     for this browser/PWA session". sessionStorage is cleared
//     automatically when the tab/app is fully closed, which is what
//     gives "stay unlocked until closed" for free, with no timeout
//     logic to write or maintain. Same-origin iframes (e.g.
//     po-water.html embedded in health.html) share their top-level
//     page's sessionStorage, so an already-unlocked page's embedded
//     iframe never re-prompts.
// =============================================================

(function () {
  'use strict';

  // Never lock inside an iframe — the embedding top-level page (e.g.
  // health.html embedding po-water.html) is the thing a user actually
  // "opens", and it's already responsible for gating access. Locking
  // the iframe too would show a second, redundant lock screen inside
  // it (and could momentarily disagree with the parent's own unlock
  // state, since iframes can start loading before the parent finishes
  // unlocking). Direct, top-level navigation to any page — including
  // po-water.html on its own — still hits the check below normally.
  let embedded = false;
  try { embedded = window.self !== window.top; } catch (e) { embedded = true; }
  if (embedded) return;

  const PIN_LENGTH = 4;
  const HASH_KEY = 'dashboard:lock_pin_hash';
  const UNLOCK_KEY = 'dashboard:unlocked';
  const SECRET_KEY = 'dashboard:secret'; // read-only, for "forgot PIN" recovery — see header comment

  document.documentElement.style.visibility = 'hidden';

  function safely(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }

  // No Web Crypto (very old browser, or a non-secure context) — fail
  // OPEN rather than lock someone out with no way to ever unlock.
  if (!window.crypto || !window.crypto.subtle) {
    document.documentElement.style.visibility = '';
    return;
  }

  async function sha256Hex(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function reveal() { document.documentElement.style.visibility = ''; }
  function getStoredHash() { return safely(() => localStorage.getItem(HASH_KEY), null); }
  function setStoredHash(h) { safely(() => localStorage.setItem(HASH_KEY, h)); }
  function isUnlockedThisSession() { return safely(() => sessionStorage.getItem(UNLOCK_KEY) === '1', false); }
  function markUnlocked() { safely(() => sessionStorage.setItem(UNLOCK_KEY, '1')); }
  function getSecret() { return safely(() => localStorage.getItem(SECRET_KEY) || '', ''); }

  // -------------------------------------------------------------
  // Overlay UI — hand-rolled, no dependency on topbar.js/Lucide/etc,
  // since this must work before ANY of those have loaded. Colors are
  // literal hex values, not var(--something): this project's pages
  // use several different, incompatible CSS-variable naming schemes
  // (see topbar.js's own header comment for the same reasoning), and
  // this one file has to look right on all of them.
  // -------------------------------------------------------------
  let overlayEl = null;
  let digitEls = [];
  let pendingFirstPin = null; // holds the first entry during a create -> confirm step
  let mode = 'unlock'; // 'unlock' | 'create' | 'confirm' | 'forgot'
  let onSuccess = null; // called once, after a successful unlock/change

  function ensureOverlay() {
    if (overlayEl) return overlayEl;
    const style = document.createElement('style');
    style.textContent = `
      #rowLockOverlay {
        position: fixed; inset: 0; z-index: 2147483647;
        visibility: visible;
        background: #0a0a0b;
        display: flex; align-items: center; justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
        padding: 20px;
      }
      #rowLockOverlay .row-lock-card {
        width: 100%; max-width: 320px; text-align: center;
      }
      #rowLockOverlay .row-lock-title {
        color: #FAFAFA; font-size: 19px; font-weight: 800; margin-bottom: 8px;
      }
      #rowLockOverlay .row-lock-sub {
        color: #A5A3A0; font-size: 13px; margin-bottom: 28px; line-height: 1.5;
      }
      #rowLockOverlay .row-lock-dots {
        display: flex; justify-content: center; gap: 16px; margin-bottom: 28px;
      }
      #rowLockOverlay .row-lock-dot {
        width: 16px; height: 16px; border-radius: 50%;
        border: 1.5px solid rgba(255,255,255,0.25);
        background: transparent; transition: background 0.12s, border-color 0.12s;
      }
      #rowLockOverlay .row-lock-dot.filled { background: #17E88F; border-color: #17E88F; }
      #rowLockOverlay .row-lock-dots.error .row-lock-dot {
        border-color: #FF4D5E; background: #FF4D5E;
        animation: rowLockShake 0.4s ease;
      }
      @keyframes rowLockShake {
        0%, 100% { transform: translateX(0); }
        20% { transform: translateX(-8px); }
        40% { transform: translateX(8px); }
        60% { transform: translateX(-6px); }
        80% { transform: translateX(6px); }
      }
      #rowLockOverlay .row-lock-input {
        position: absolute; opacity: 0; pointer-events: none; width: 1px; height: 1px;
      }
      #rowLockOverlay .row-lock-secret-row {
        display: flex; gap: 8px; margin-bottom: 12px;
      }
      #rowLockOverlay .row-lock-secret-input {
        flex: 1; min-width: 0;
        background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
        border-radius: 10px; padding: 10px 12px;
        color: #FAFAFA; font-family: inherit; font-size: 13.5px; outline: none;
      }
      #rowLockOverlay .row-lock-secret-submit {
        flex-shrink: 0; padding: 10px 16px; border: none; border-radius: 10px;
        background: #17E88F; color: #08110D; font-family: inherit; font-size: 13px; font-weight: 700;
        cursor: pointer;
      }
      #rowLockOverlay .row-lock-error-text {
        color: #FF4D5E; font-size: 12.5px; font-weight: 600; min-height: 16px; margin-bottom: 12px;
      }
      #rowLockOverlay .row-lock-link {
        background: none; border: none; color: #6E6C68; font-size: 12.5px;
        font-family: inherit; cursor: pointer; text-decoration: underline;
        padding: 6px; -webkit-tap-highlight-color: transparent;
      }
      #rowLockOverlay .row-lock-link:hover { color: #A5A3A0; }
    `;
    const wrap = document.createElement('div');
    wrap.id = 'rowLockOverlay';
    wrap.innerHTML = `
      <div class="row-lock-card">
        <div class="row-lock-title" id="rowLockTitle">Enter PIN</div>
        <div class="row-lock-sub" id="rowLockSub"></div>
        <div class="row-lock-dots" id="rowLockDots"></div>
        <div class="row-lock-secret-row" id="rowLockSecretRow" style="display:none">
          <input class="row-lock-secret-input" id="rowLockSecretInput" type="password" autocomplete="off" placeholder="Dashboard secret">
          <button type="button" class="row-lock-secret-submit" id="rowLockSecretSubmit">Reset</button>
        </div>
        <div class="row-lock-error-text" id="rowLockErrorText"></div>
        <input class="row-lock-input" id="rowLockInput" type="tel" inputmode="numeric" pattern="[0-9]*" autocomplete="off">
        <button type="button" class="row-lock-link" id="rowLockForgotBtn">Forgot PIN?</button>
      </div>
    `;
    // documentElement is hidden, not <head>/<body> individually — by
    // the time this runs (DOMContentLoaded, see boot() below) body
    // always exists, so appending here is safe.
    document.body.appendChild(style);
    document.body.appendChild(wrap);
    overlayEl = wrap;
    digitEls = Array.from(wrap.querySelectorAll('.row-lock-dot'));
    const input = wrap.querySelector('#rowLockInput');
    input.addEventListener('input', onInput);
    wrap.querySelector('#rowLockForgotBtn').addEventListener('click', () => {
      if (mode === 'forgot') showUnlock(); else showForgot();
    });
    wrap.querySelector('#rowLockSecretSubmit').addEventListener('click', handleForgotSubmit);
    wrap.querySelector('#rowLockSecretInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleForgotSubmit();
    });
    return wrap;
  }

  function buildDots(container) {
    container.innerHTML = '';
    for (let i = 0; i < PIN_LENGTH; i++) {
      const d = document.createElement('div');
      d.className = 'row-lock-dot';
      container.appendChild(d);
    }
    digitEls = Array.from(container.children);
  }

  function focusInput() {
    const input = overlayEl.querySelector('#rowLockInput');
    input.value = '';
    updateDots('');
    setTimeout(() => input.focus(), 30);
  }

  function updateDots(value) {
    digitEls.forEach((d, i) => d.classList.toggle('filled', i < value.length));
  }

  function showError(msg) {
    overlayEl.querySelector('#rowLockErrorText').textContent = msg;
    const dotsWrap = overlayEl.querySelector('#rowLockDots');
    dotsWrap.classList.add('error');
    setTimeout(() => dotsWrap.classList.remove('error'), 400);
  }

  function setScreen(newMode, title, sub) {
    mode = newMode;
    overlayEl.querySelector('#rowLockTitle').textContent = title;
    overlayEl.querySelector('#rowLockSub').textContent = sub || '';
    overlayEl.querySelector('#rowLockErrorText').textContent = '';
    const isForgot = newMode === 'forgot';
    overlayEl.querySelector('#rowLockDots').style.display = isForgot ? 'none' : 'flex';
    overlayEl.querySelector('#rowLockSecretRow').style.display = isForgot ? 'flex' : 'none';
    const forgotBtn = overlayEl.querySelector('#rowLockForgotBtn');
    forgotBtn.style.display = (newMode === 'unlock' || isForgot) ? 'inline-block' : 'none';
    forgotBtn.textContent = isForgot ? 'Back' : 'Forgot PIN?';
    if (isForgot) {
      const secretInput = overlayEl.querySelector('#rowLockSecretInput');
      secretInput.value = '';
      setTimeout(() => secretInput.focus(), 30);
    } else {
      buildDots(overlayEl.querySelector('#rowLockDots'));
      focusInput();
    }
  }

  function showUnlock() { setScreen('unlock', 'Enter PIN', ''); }
  function showCreate() { pendingFirstPin = null; setScreen('create', 'Create a PIN', 'Choose a ' + PIN_LENGTH + '-digit PIN for this device.'); }
  function showConfirm(first) { pendingFirstPin = first; setScreen('confirm', 'Confirm PIN', 'Enter it again to confirm.'); }
  function showForgot() { setScreen('forgot', 'Reset PIN', 'Enter your dashboard secret to reset your PIN on this device.'); }

  function handleForgotSubmit() {
    const entered = overlayEl.querySelector('#rowLockSecretInput').value;
    const secret = getSecret();
    if (secret && entered === secret) {
      showCreate();
    } else {
      overlayEl.querySelector('#rowLockErrorText').textContent = secret ? 'Incorrect secret' : 'No dashboard secret set on this device — recovery unavailable';
      overlayEl.querySelector('#rowLockSecretInput').value = '';
    }
  }

  async function onInput(e) {
    const val = e.target.value.replace(/\D/g, '').slice(0, PIN_LENGTH);
    e.target.value = val;
    updateDots(val);
    if (val.length < PIN_LENGTH) return;

    if (mode === 'unlock') {
      const enteredHash = await sha256Hex(val);
      if (enteredHash === getStoredHash()) {
        markUnlocked();
        finish();
      } else {
        showError('Incorrect PIN');
        focusInput();
      }
      return;
    }
    if (mode === 'create') { showConfirm(val); return; }
    if (mode === 'confirm') {
      if (val === pendingFirstPin) {
        setStoredHash(await sha256Hex(val));
        markUnlocked();
        finish();
      } else {
        // Show the mismatch on THIS screen first — calling showCreate()
        // immediately would reset the error text before the shake
        // animation (or the user) ever had a chance to render/read it,
        // since both DOM writes would land in the same paint-less tick.
        showError("PINs didn't match — try again");
        setTimeout(showCreate, 700);
      }
      return;
    }
  }

  function finish() {
    reveal();
    overlayEl.remove();
    overlayEl = null;
    if (typeof onSuccess === 'function') { const cb = onSuccess; onSuccess = null; cb(); }
  }

  // ---------- boot: decide what to show ----------
  function boot() {
    if (isUnlockedThisSession()) { reveal(); return; } // common case — skip building the overlay DOM at all
    ensureOverlay();
    if (!getStoredHash()) { showCreate(); return; }
    showUnlock();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  // ---------- public API for General Settings' "Change PIN" ----------
  // Safe to call from any page's own DOMContentLoaded-time code: this
  // whole IIFE (including this assignment) runs as a blocking script
  // at the very top of <head>, so window.RowLock always exists by the
  // time any other script's DOMContentLoaded handler runs — the same
  // load-order guarantee window.RowIcons (topbar.js) already relies on.
  window.RowLock = {
    changePin: function (onDone) {
      ensureOverlay();
      onSuccess = typeof onDone === 'function' ? onDone : null;
      showCreate();
    },
  };
})();
