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
          if (remoteMeta && remoteUpdatedAt != null && localUpdatedAt != null && localUpdatedAt > remoteUpdatedAt) {
            // This page's own local copy is the newer one -- keep it,
            // and make sure the stale remote gets corrected afterward.
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
    async function pushNow() {
      if (!supa) return;
      const state = collect();
      const json = JSON.stringify(state);
      if (json === lastSyncedJson) return;
      if (isSuspiciousEmptyPush(state)) return;
      try {
        const { error } = await supa.from('app_state').upsert(
          { key: appKey, data: state, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        );
        if (!error) { lastSyncedJson = json; lastSyncedRealKeyCount = realKeyCount(state); }
      } catch (e) {}
    }
    function schedulePush() { clearTimeout(pushTimer); pushTimer = setTimeout(pushNow, 250); }
    function flushOnUnload() {
      const state = collect();
      const json = JSON.stringify(state);
      if (json === lastSyncedJson) return;
      if (isSuspiciousEmptyPush(state)) return;
      try {
        fetch(SUPABASE_URL + '/rest/v1/app_state?on_conflict=key', {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': 'Bearer ' + SUPABASE_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates',
          },
          body: JSON.stringify({ key: appKey, data: state, updated_at: new Date().toISOString() }),
          keepalive: true,
        }).catch(() => {});
        lastSyncedJson = json;
        lastSyncedRealKeyCount = realKeyCount(state);
      } catch (e) {}
    }
    (async function init() {
      supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
      try {
        const { data, error } = await supa.from('app_state').select('data').eq('key', appKey).maybeSingle();
        if (!error && data && data.data && Object.keys(data.data).length > 0) {
          lastSyncedJson = JSON.stringify(data.data);
          lastSyncedRealKeyCount = realKeyCount(data.data);
          applyRemote(data.data, true);
          // Push right after, in case this page's own local state (this
          // load's collect()) now includes keys the remote snapshot
          // didn't have — e.g. this page's first-ever sync against a
          // row another page already populated. pushNow's own
          // json===lastSyncedJson guard makes this a no-op when there's
          // genuinely nothing new to add.
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
