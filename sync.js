// =============================================================
// Shared cloud-sync helper. Each page calls initCloudSync({...}).
// Replace the two placeholders with your Supabase project URL +
// publishable key (same ones you used in topbar.js/gym.html).
// =============================================================
(function () {
  'use strict';
  const SUPABASE_URL = 'https://dfxjlneohhgfdussomou.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_9a1GD4OaqszZSnXW80PFTA_JvHi533e';

  window.initCloudSync = function (config) {
    const appKey = config && config.appKey;
    const syncedKeys = (config && config.syncedKeys) || [];
    const syncedPrefixes = (config && config.syncedPrefixes) || [];
    const onApplied = config && config.onApplied;
    if (!appKey || !window.supabase) return;
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    if (SUPABASE_URL.indexOf('PASTE-') === 0 || SUPABASE_KEY.indexOf('PASTE-') === 0) return;

    let supa = null, pushTimer = null, suppressSync = false, lastSyncedJson = null;
    // The most recent server row this page has actually SEEN (via
    // init()'s own select, pushNow's own read-before-write, or a
    // realtime update) — the basis flushOnUnload merges against when
    // it can't afford to read first (see flushOnUnload's own comment).
    let lastPulledState = null, lastPulledUpdatedAt = null;

    // BUG FIX (reported) — applyRemote used to be a blind "does the
    // whole-value JSON differ? if so, remote wins" comparison, with NO
    // timestamp, NO per-item recency check, and deletions NOT
    // tombstoned at all (a local key simply missing from the remote
    // snapshot was deleted outright, unconditionally). Every pull —
    // including the one that runs on EVERY page load before this
    // page's own first push has had a chance to land, and every
    // realtime update from another device/tab — could silently revert
    // a just-made local change (a checked-off to-do, a deleted item)
    // back to whatever a STALE remote snapshot still said, with no
    // way to tell which side was actually newer. That's the exact
    // mechanism behind "I checked it off and it came back unchecked" /
    // a deleted item reappearing, and (via main.html's own rollover(),
    // which only ever carries forward UNDONE items) why a task from
    // days ago could keep reappearing under today indefinitely: its
    // local "done" state kept getting reverted by a stale pull before
    // the NEXT day's rollover ever got a chance to see it as done and
    // drop it.
    //
    // Fix: track a per-KEY last-local-write timestamp (metaStore,
    // mirrored into localStorage under META_KEY so it survives reload,
    // and included in every push's `_meta` field so OTHER devices see
    // it too). applyRemote now only overwrites a local key with the
    // remote's value when the remote's own recorded timestamp is
    // NEWER than this page's local one for that same key (or local has
    // no timestamp at all — a pre-existing key from before this fix,
    // or one this page has genuinely never touched) — never blindly on
    // "the JSON differs." A local key that's actually newer than the
    // incoming remote is left untouched, and a push is scheduled
    // afterward to propagate that correction back up, so the stale
    // remote copy doesn't keep winning indefinitely. Deletions get the
    // same treatment: a key missing from the remote snapshot is only
    // deleted locally when the remote's `_meta` carries an explicit,
    // timestamped tombstone for it that's newer than this page's own
    // last write to that key — never on bare absence alone. A remote
    // snapshot with no `_meta` at all (an older row nothing has pushed
    // metadata to yet) falls back to the exact OLD behavior, so this
    // is backward compatible with every row/page until its own next
    // push adds metadata.
    //
    // Deliberately NOT implemented: pruning old tombstones (metaStore
    // only ever grows). Acceptable for now — to-do-list-scale data —
    // revisit if a shared row's `_meta` ever becomes a real size
    // concern.
    const META_KEY = '__sync_meta_v1:' + appKey;
    function loadMetaStore() {
      try { const m = JSON.parse(localStorage.getItem(META_KEY)); return (m && typeof m === 'object') ? m : {}; } catch (e) { return {}; }
    }
    let metaStore = loadMetaStore();
    function saveMetaStore() { try { origSet(META_KEY, JSON.stringify(metaStore)); } catch (e) {} }
    function touchMeta(k, deleted) { metaStore[k] = { updatedAt: Date.now(), deleted: !!deleted }; saveMetaStore(); }

    function matches(k) {
      if (!k) return false;
      if (k === META_KEY) return false; // internal bookkeeping, never itself a synced "page data" key
      if (syncedKeys.indexOf(k) !== -1) return true;
      for (let i = 0; i < syncedPrefixes.length; i++) {
        if (k.indexOf(syncedPrefixes[i]) === 0) return true;
      }
      return false;
    }
    function listAllKeys() {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (matches(k)) out.push(k);
      }
      return out;
    }
    function collect() {
      const out = {};
      for (const k of listAllKeys()) {
        const v = localStorage.getItem(k);
        if (v == null) continue;
        try { out[k] = JSON.parse(v); } catch (e) { out[k] = v; }
      }
      out._meta = metaStore;
      return out;
    }
    const origSet = localStorage.setItem.bind(localStorage);
    const origRemove = localStorage.removeItem.bind(localStorage);
    localStorage.setItem = function (k, v) {
      origSet(k, v);
      try {
        if (!suppressSync && matches(k)) { touchMeta(k, false); schedulePush(); }
      } catch (e) {}
    };
    localStorage.removeItem = function (k) {
      origRemove(k);
      try {
        if (!suppressSync && matches(k)) { touchMeta(k, true); schedulePush(); }
      } catch (e) {}
    };
    // skipDeletes (used only by init()'s very first pull — see there):
    // a key this page tracks but that the just-fetched remote snapshot
    // doesn't mention yet is normally treated as "deleted elsewhere,
    // remove it here too" — correct for a live realtime update from a
    // page that's been syncing all along. But on the FIRST pull of a
    // fresh page load, that same situation just as easily means "this
    // key has never reached the server yet" (e.g. two pages sharing one
    // appKey, and this is this page's first-ever visit while the other
    // page already populated the row with ITS OWN keys) — deleting it
    // here would destroy real local data before init() ever gets a
    // chance to push it. Confirmed live: without this, po-water.html's
    // first sync against an already-populated 'health' row silently
    // wiped its own not-yet-uploaded po_water_v1.
    function applyRemote(remote, skipDeletes) {
      if (!remote || typeof remote !== 'object') return false;
      const remoteMeta = (remote._meta && typeof remote._meta === 'object') ? remote._meta : null;
      suppressSync = true;
      let changed = false;
      let localWonAConflict = false;
      try {
        for (const k of Object.keys(remote)) {
          if (k === '_meta' || !matches(k)) continue;
          const incoming = JSON.stringify(remote[k]);
          const local = localStorage.getItem(k);
          if (local === incoming) continue;
          // No `_meta` at all on this remote snapshot -> an older row
          // nothing has pushed metadata to yet; behave exactly as
          // before (remote always wins on any difference).
          const remoteUpdatedAt = remoteMeta && remoteMeta[k] ? remoteMeta[k].updatedAt : null;
          const localUpdatedAt = metaStore[k] ? metaStore[k].updatedAt : null;
          // BUG FIX (reported) — this used to require remoteUpdatedAt
          // to be non-null before local could ever win, so a remote
          // with NO timestamp info for this key specifically (either
          // its `_meta` object exists but has no entry for k — e.g. a
          // different device/tab pushed its own collect(), which only
          // ever carries ITS OWN metaStore, silently dropping k's
          // entry since that device never itself touched k — or the
          // whole snapshot has no `_meta` at all) fell straight
          // through to the unconditional accept below: remote wins
          // even though THIS page has real proof (a tracked
          // timestamp) that its own copy is a deliberate, dated local
          // write the remote copy knows nothing about. A remote with
          // no timestamp for this key can never outrank a local one
          // that has it — covers both shapes of "no info" in one
          // rule. When local is ALSO untracked, this is a no-op and
          // falls through exactly as before ("when neither has a
          // timestamp, keep the current behavior").
          if (localUpdatedAt != null && (remoteUpdatedAt == null || localUpdatedAt > remoteUpdatedAt)) {
            // This page's own local copy is the newer (or only) known
            // one -- keep it, and make sure the stale remote gets
            // corrected afterward.
            localWonAConflict = true;
            continue;
          }
          try {
            origSet(k, incoming);
            changed = true;
            if (remoteUpdatedAt != null) metaStore[k] = { updatedAt: remoteUpdatedAt, deleted: false };
          } catch (e) {}
        }
        if (!skipDeletes) {
          for (const k of listAllKeys()) {
            if (k in remote) continue;
            if (remoteMeta) {
              // `_meta` IS present on this snapshot -- only honor an
              // EXPLICIT, timestamped tombstone newer than this page's
              // own last write to that key. Bare absence (no tombstone
              // at all, e.g. a key another device genuinely never
              // reached yet) is never treated as a deletion anymore.
              const tomb = remoteMeta[k];
              const localUpdatedAt = metaStore[k] ? metaStore[k].updatedAt : null;
              if (tomb && tomb.deleted && (localUpdatedAt == null || tomb.updatedAt > localUpdatedAt)) {
                try { origRemove(k); changed = true; metaStore[k] = { updatedAt: tomb.updatedAt, deleted: true }; } catch (e) {}
              } else if (tomb && tomb.deleted) {
                localWonAConflict = true; // a newer local write survives a stale tombstone too
              }
            } else {
              // No `_meta` on this snapshot at all -- exact old
              // behavior (absence = deleted elsewhere).
              try { origRemove(k); changed = true; } catch (e) {}
            }
          }
        }
        if (changed || localWonAConflict) saveMetaStore();
      } finally { suppressSync = false; }
      if (localWonAConflict) schedulePush();
      if (changed && typeof onApplied === 'function') { try { onApplied(); } catch (e) {} }
      return changed;
    }

    // BUG FIX (reported) — pushNow()/flushOnUnload() used to write this
    // page's own collect() snapshot (data AND `_meta`) straight over the
    // server row with a blind upsert — no read, no merge. A second
    // device/tab with a stale local copy of some OTHER key, pushing
    // its own unrelated change, would overwrite the ENTIRE row
    // (including this key's `_meta` tombstone/timestamp) with its own
    // stale copy, silently resurrecting whatever this page had just
    // deleted. Every write now reads the current server row first and
    // merges PER KEY over the union of both sides — never a whole-
    // blob replace — using the exact same last-write-timestamp
    // convention applyRemote already uses, so the two directions
    // (push here, pull above) agree.
    //
    // tsOf: a side's recorded timestamp for one key, or 0 if that side
    // has never tracked it at all (a pre-fix/legacy key, or one this
    // side has simply never touched) — this is the "missing
    // timestamp = 0" rule.
    function tsOf(meta, k) { return (meta && meta[k] && typeof meta[k].updatedAt === 'number') ? meta[k].updatedAt : 0; }
    // Resolves ONE key between a local state and a remote state (both
    // in collect()'s own shape: data keys plus `_meta`). A side's
    // explicit, newer deletion tombstone always wins outright (this is
    // the SAME per-key tombstone applyRemote's deletion loop already
    // honors — not a new, per-ITEM tombstone; see this task's own
    // scope note). Otherwise: present on both sides -> higher
    // timestamp wins, a TIE keeps local. Present on only one side ->
    // that side's value is kept AS IS, regardless of timestamps — this
    // is the safety rule ("a key absent locally must be KEPT from the
    // server", "keys only on the server are kept as is"): there is
    // nothing to compare a real value against on a side that simply
    // never had the key, so absence can never outrank presence.
    function mergeForPush(localState, remoteState) {
      const localMeta = (localState._meta && typeof localState._meta === 'object') ? localState._meta : {};
      const remoteMeta = (remoteState._meta && typeof remoteState._meta === 'object') ? remoteState._meta : {};
      const keys = new Set(Object.keys(localState).concat(Object.keys(remoteState)));
      keys.delete('_meta');
      const data = {}, meta = {};
      keys.forEach((k) => {
        const localHas = Object.prototype.hasOwnProperty.call(localState, k);
        const remoteHas = Object.prototype.hasOwnProperty.call(remoteState, k);
        const lt = tsOf(localMeta, k), rt = tsOf(remoteMeta, k);
        const localDeletedNewer = !!(localMeta[k] && localMeta[k].deleted) && lt > rt;
        const remoteDeletedNewer = !!(remoteMeta[k] && remoteMeta[k].deleted) && rt > lt;
        let keep = null; // 'local' | 'remote' | null (both sides agree it's gone)
        if (localDeletedNewer || remoteDeletedNewer) keep = null;
        else if (localHas && remoteHas) keep = (lt >= rt) ? 'local' : 'remote'; // tie -> local
        else if (localHas) keep = 'local';
        else if (remoteHas) keep = 'remote';
        if (keep === 'local') data[k] = localState[k];
        else if (keep === 'remote') data[k] = remoteState[k];
        if (lt > 0 || rt > 0) meta[k] = { updatedAt: Math.max(lt, rt), deleted: keep === null };
      });
      return { data, meta };
    }
    // After a successful write, bring THIS page's own localStorage up
    // to match the merged result (a server-only key it never had, or a
    // remote value that won the merge for some other key) — through
    // origSet/origRemove (never the monkeypatched setItem/removeItem),
    // so this doesn't itself re-trigger touchMeta/schedulePush.
    function applyMergedLocally(merged) {
      suppressSync = true;
      try {
        const keys = new Set(listAllKeys().concat(Object.keys(merged.data)));
        keys.forEach((k) => {
          const want = Object.prototype.hasOwnProperty.call(merged.data, k) ? JSON.stringify(merged.data[k]) : null;
          const have = localStorage.getItem(k);
          if (want == null) { if (have != null) try { origRemove(k); } catch (e) {} }
          else if (have !== want) try { origSet(k, want); } catch (e) {}
        });
        metaStore = merged.meta;
        saveMetaStore();
      } finally { suppressSync = false; }
    }

    // Never push an empty snapshot over previously-synced non-empty
    // data — confirmed live (via a real pull/push round-trip test) that
    // a page navigation's unload lifecycle can fire flushOnUnload() at
    // a moment where collect() sees zero matching keys (a timing
    // artifact of the unload sequence itself, not an intentional user
    // action), and without this guard that empty snapshot would
    // silently wipe the entire shared row — catastrophic for a page
    // like po-water.html/health.html that share one appKey. A real
    // "user deleted everything this page tracks" is not a scenario
    // that happens in this app (nothing removes every synced key at
    // once), so refusing an empty push whenever we've previously synced
    // real content has no legitimate downside.
    //
    // BUG FIX (reported, alongside applyRemote above) — collect() now
    // always includes `_meta`, so a truly-empty state's JSON is
    // '{"_meta":{}}', never the literal '{}' this used to compare
    // against; counting REAL (non-_meta) keys instead keeps this guard
    // working exactly as before.
    function realKeyCount(state) { return Object.keys(state).filter((k) => k !== '_meta').length; }
    let lastSyncedRealKeyCount = 0;
    function isSuspiciousEmptyPush(state) {
      return realKeyCount(state) === 0 && lastSyncedRealKeyCount > 0;
    }
    // BUG FIX (reported) — read-merge-write (compare-and-swap) instead
    // of a blind upsert: read the CURRENT server row, merge this
    // page's local state into it per key (mergeForPush above, never a
    // whole-blob replace), then write back ONLY if the row's own
    // updated_at is still exactly what was just read (the `.eq(...,
    // serverRow.updated_at)` filter — a no-op UPDATE whose WHERE
    // clause no longer matches touches zero rows instead of silently
    // overwriting whatever someone else just wrote). A real row-
    // version/CAS column would be cleaner than reusing updated_at for
    // this, but this table has no such column and adding one is out
    // of scope here — reusing updated_at is sufficient AS LONG AS every
    // writer goes through this same read-merge-CAS path, which, after
    // this fix, they all do. A lost CAS race re-reads and re-merges
    // (never re-sends the same stale write), bounded by
    // PUSH_MAX_RETRIES so a pathological fight between two tabs can't
    // spin forever — past that bound it backs off and relies on the
    // normal debounced retry queue instead. A failed READ (offline,
    // network error) never falls back to a blind write either — local
    // changes stay exactly as they are (nothing queued is lost; the
    // next scheduled retry tries again) and a retry is queued.
    const PUSH_MAX_RETRIES = 4;
    const PUSH_RETRY_DELAY_MS = 2000;
    async function pushNow(attempt) {
      attempt = attempt || 0;
      if (!supa) return;
      const localState = collect();
      let serverRow;
      try {
        const { data, error } = await supa.from('app_state').select('data, updated_at').eq('key', appKey).maybeSingle();
        if (error) { scheduleRetryPush(); return; }
        serverRow = data;
      } catch (e) { scheduleRetryPush(); return; }

      if (!serverRow) {
        // No row at all yet for this appKey -- nothing to merge
        // against or clobber; a plain insert is safe.
        const nowIso = new Date().toISOString();
        try {
          const { error } = await supa.from('app_state').insert({ key: appKey, data: localState, updated_at: nowIso });
          if (error) {
            // Most likely another tab/device just created the row --
            // retry as a proper read-merge against what's there now.
            if (attempt < PUSH_MAX_RETRIES) { await pushNow(attempt + 1); return; }
            scheduleRetryPush(); return;
          }
          lastPulledState = localState; lastPulledUpdatedAt = nowIso;
          lastSyncedJson = JSON.stringify(localState); lastSyncedRealKeyCount = realKeyCount(localState);
        } catch (e) { scheduleRetryPush(); }
        return;
      }

      lastPulledState = (serverRow.data && typeof serverRow.data === 'object') ? serverRow.data : {};
      lastPulledUpdatedAt = serverRow.updated_at;
      const merged = mergeForPush(localState, lastPulledState);
      const mergedFull = Object.assign({}, merged.data, { _meta: merged.meta });
      const json = JSON.stringify(mergedFull);
      if (json === lastSyncedJson) { applyMergedLocally(merged); return; } // nothing new to WRITE, but local may still need a server-only key applied
      if (isSuspiciousEmptyPush(mergedFull)) return;

      const nowIso = new Date().toISOString();
      try {
        const { data: updRows, error: updErr } = await supa.from('app_state')
          .update({ data: mergedFull, updated_at: nowIso })
          .eq('key', appKey).eq('updated_at', serverRow.updated_at)
          .select('key');
        if (updErr) { scheduleRetryPush(); return; }
        if (!updRows || !updRows.length) {
          // CAS conflict -- the row moved since we read it. Re-read,
          // re-merge, retry (bounded).
          if (attempt < PUSH_MAX_RETRIES) { await pushNow(attempt + 1); return; }
          scheduleRetryPush(); return;
        }
        lastPulledState = mergedFull; lastPulledUpdatedAt = nowIso;
        lastSyncedJson = json; lastSyncedRealKeyCount = realKeyCount(mergedFull);
        applyMergedLocally(merged);
      } catch (e) { scheduleRetryPush(); }
    }
    function schedulePush() { clearTimeout(pushTimer); pushTimer = setTimeout(() => pushNow(0), 250); }
    function scheduleRetryPush() { clearTimeout(pushTimer); pushTimer = setTimeout(() => pushNow(0), PUSH_RETRY_DELAY_MS); }
    // flushOnUnload can't read-merge-write like pushNow — a
    // beforeunload/pagehide handler can't await a network round trip,
    // and fetch(..., {keepalive:true}) is fire-and-forget with no
    // retry. CHOSEN approach: merge against lastPulledState (the most
    // recent server row this page has actually SEEN — from init(), a
    // prior pushNow, or a realtime update) and send a CONDITIONAL
    // PATCH (the URL's own `updated_at=eq.<lastPulledUpdatedAt>`
    // filter is this request's CAS check) instead of an unconditional
    // upsert. If the server has moved on since that last-seen snapshot,
    // the filter simply matches zero rows and this request no-ops —
    // never a blind overwrite. Nothing is lost either way: this page's
    // own localStorage (and its own fresh per-key timestamps) survive
    // the reload/navigation regardless of whether this particular
    // flush lands, and the NEXT load's init()/schedulePush() runs the
    // real read-merge-CAS path and catches it up then. The alternative
    // (skip flushOnUnload entirely and rely only on the queued retry)
    // was considered but rejected: that would mean every single
    // tab-close loses whatever didn't make it into a push in the last
    // 250ms, every time, rather than only in the rare case this one
    // conditional request actually loses its race.
    function flushOnUnload() {
      const localState = collect();
      const merged = mergeForPush(localState, lastPulledState || {});
      const mergedFull = Object.assign({}, merged.data, { _meta: merged.meta });
      const json = JSON.stringify(mergedFull);
      if (json === lastSyncedJson) return;
      if (isSuspiciousEmptyPush(mergedFull)) return;
      const body = JSON.stringify({ key: appKey, data: mergedFull, updated_at: new Date().toISOString() });
      try {
        if (lastPulledUpdatedAt) {
          fetch(SUPABASE_URL + '/rest/v1/app_state?key=eq.' + encodeURIComponent(appKey) + '&updated_at=eq.' + encodeURIComponent(lastPulledUpdatedAt), {
            method: 'PATCH',
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': 'Bearer ' + SUPABASE_KEY,
              'Content-Type': 'application/json',
              'Prefer': 'return=minimal',
            },
            body,
            keepalive: true,
          }).catch(() => {});
        } else {
          // This page has never successfully seen a server row at all
          // this session (would require unloading before init()'s own
          // first select ever resolves) -- best effort only, same as
          // before this fix; there is nothing to CAS against.
          fetch(SUPABASE_URL + '/rest/v1/app_state?on_conflict=key', {
            method: 'POST',
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': 'Bearer ' + SUPABASE_KEY,
              'Content-Type': 'application/json',
              'Prefer': 'resolution=merge-duplicates',
            },
            body,
            keepalive: true,
          }).catch(() => {});
        }
        lastSyncedJson = json;
        lastSyncedRealKeyCount = realKeyCount(mergedFull);
      } catch (e) {}
    }
    (async function init() {
      supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
      try {
        const { data, error } = await supa.from('app_state').select('data, updated_at').eq('key', appKey).maybeSingle();
        if (!error && data && data.data && Object.keys(data.data).length > 0) {
          lastPulledState = data.data; lastPulledUpdatedAt = data.updated_at;
          lastSyncedJson = JSON.stringify(data.data);
          lastSyncedRealKeyCount = realKeyCount(data.data);
          applyRemote(data.data, true);
          // Push right after, in case this page's own local state (this
          // load's collect()) now includes keys the remote snapshot
          // didn't have — e.g. this page's first-ever sync against a
          // row another page already populated. pushNow's own
          // read-merge-CAS already no-ops this when there's genuinely
          // nothing new to add (merged === what's already there).
          schedulePush();
        } else if (realKeyCount(collect()) > 0) {
          schedulePush();
        }
      } catch (e) {}
      supa.channel('app_state_' + appKey)
        .on('postgres_changes', {
          event: '*', schema: 'public', table: 'app_state', filter: 'key=eq.' + appKey,
        }, (payload) => {
          if (!payload.new || !payload.new.data) return;
          const incoming = JSON.stringify(payload.new.data);
          lastPulledState = payload.new.data; lastPulledUpdatedAt = payload.new.updated_at;
          if (incoming === lastSyncedJson) return;
          lastSyncedJson = incoming;
          lastSyncedRealKeyCount = realKeyCount(payload.new.data);
          applyRemote(payload.new.data);
        })
        .subscribe();
    })();
    window.addEventListener('beforeunload', flushOnUnload);
    window.addEventListener('pagehide', flushOnUnload);
    window.addEventListener('storage', (e) => { if (e.key && matches(e.key)) schedulePush(); });
  };
})();
