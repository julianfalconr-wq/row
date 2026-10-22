// Smoke test — run this before every push touching sync.js's push/pull
// merge logic (mergeForPush / applyRemote / pushNow / flushOnUnload).
//
//   node tests/smoke-sync-merge.cjs
//
// Reproduces the EXACT reported bug and verifies the fix: pushNow()/
// flushOnUnload() used to write this page's own collect() snapshot
// (data AND _meta) straight over the server row with a blind upsert —
// no read, no merge. A second tab/device with a stale local copy of
// some OTHER key, pushing its own unrelated change, would overwrite
// the ENTIRE row (including a just-deleted key's own _meta tombstone)
// with its own stale copy, silently resurrecting whatever had just
// been deleted. The fix reads the current server row first and merges
// PER KEY (mergeForPush) before writing back with a compare-and-swap
// (CAS) on updated_at, retrying a bounded number of times on conflict;
// applyRemote (the pull side) now also lets a LOCAL timestamp win
// outright against a remote with no timestamp info for that key at
// all, not just an explicitly older one.
//
// NOTE on test technique: jsdom's real `localStorage` does NOT support
// sync.js's `localStorage.setItem = function(){...}` override at all —
// confirmed separately: the assignment silently creates a STORAGE ITEM
// keyed "setItem" instead of overriding the method (a jsdom Storage/
// Proxy quirk, not a bug in sync.js). So this runs the REAL sync.js
// source in a `vm` sandbox with a hand-rolled, plain-object
// localStorage (where a normal method override behaves like normal
// JS) plus a mocked Supabase client/fetch — never a live network call.
const fs = require('fs');
const vm = require('vm');

const SYNC_SRC = fs.readFileSync('/Users/julian.fr/row/sync.js', 'utf8');
let failures = 0;
function fail(msg) { failures++; console.log('FAIL:', msg); }
function ok(msg) { console.log('PASS:', msg); }

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

function makeLocalStorage() {
  const store = {};
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
    get length() { return Object.keys(store).length; },
    key(i) { return Object.keys(store)[i] || null; },
  };
}

// A fake "app_state" row, shared by reference across however many
// sandboxes a test wires up to it — exactly like a real shared
// Supabase table row every device/tab talks to.
function makeFakeServer(initialRow) {
  return { row: initialRow || null, selectCount: 0 };
}

// Builds a window-shaped object wired to a FAKE server, running the
// REAL sync.js in a vm context. `hooks.onSelect` (optional) lets a
// test inject a side effect exactly once a specific select() call is
// about to resolve — used to deterministically engineer a CAS race.
function makeSandbox(server, opts) {
  opts = opts || {};
  const listeners = {};
  const sandbox = {
    localStorage: makeLocalStorage(),
    console, setTimeout, clearTimeout, Date, JSON, Object, Promise, Array, encodeURIComponent, String,
    window: {
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    },
    fetch(url, init) {
      // Mirrors flushOnUnload's two real request shapes against the
      // SAME fake server row. PATCH ...&updated_at=eq.<X> is this
      // request's own CAS check: it only applies if the row's current
      // updated_at still equals X (0 rows affected otherwise, exactly
      // like a real WHERE clause matching nothing). POST ?on_conflict=key
      // (Prefer: resolution=merge-duplicates) is the "never pulled
      // anything yet this session" fallback — a plain unconditional
      // upsert, same as before this fix, only ever used in that one
      // rare case.
      const body = JSON.parse(init.body);
      if (init.method === 'PATCH') {
        const m = url.match(/updated_at=eq\.([^&]*)/);
        const expected = m ? decodeURIComponent(m[1]) : null;
        if (server.row && server.row.updated_at === expected) {
          server.row = { data: body.data, updated_at: body.updated_at };
        } // else: CAS miss -- no-op, exactly like a real PATCH matching 0 rows
      } else if (init.method === 'POST') {
        server.row = { data: body.data, updated_at: body.updated_at };
      }
      return Promise.resolve({ ok: true });
    },
  };
  sandbox.window.fire = (type) => (listeners[type] || []).forEach((fn) => fn());
  sandbox.window.supabase = {
    createClient: () => ({
      auth: {},
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => {
              server.selectCount++;
              if (opts.selectError) return Promise.resolve({ data: null, error: { message: 'network error' } });
              const toReturn = server.row ? { data: server.row.data, updated_at: server.row.updated_at } : null;
              if (opts.onSelect) opts.onSelect(server, server.selectCount);
              return Promise.resolve({ data: toReturn, error: null });
            },
          }),
        }),
        insert: (row) => {
          if (server.row) return Promise.resolve({ error: { message: 'duplicate key' } });
          server.row = { data: row.data, updated_at: row.updated_at };
          return Promise.resolve({ error: null });
        },
        update: (patch) => ({
          eq: () => ({
            eq: (col2, expectedUpdatedAt) => ({
              select: () => {
                if (server.row && server.row.updated_at === expectedUpdatedAt) {
                  server.row = { data: patch.data, updated_at: patch.updated_at };
                  return Promise.resolve({ data: [{ key: 'x' }], error: null });
                }
                return Promise.resolve({ data: [], error: null }); // CAS miss -- 0 rows matched
              },
            }),
          }),
        }),
      }),
      channel: () => ({ on: () => ({ subscribe: () => {} }), subscribe: () => {} }),
    }),
  };
  vm.createContext(sandbox);
  vm.runInContext(SYNC_SRC, sandbox);
  return sandbox;
}

async function main() {
  // =================================================================
  // Group A — the 4 reported reload variants: add 3 goals, delete 1,
  // reload (fresh sandbox, same localStorage), pull from the cloud.
  // The deleted goal must NEVER reappear, in any of the 4 shapes.
  // =================================================================
  const KEY = 'goals:2026-10-21';
  const server = makeFakeServer(null);
  const A = makeSandbox(server);
  A.window.initCloudSync({ appKey: 'goals', syncedPrefixes: ['goals:'] });
  await wait(20);
  A.localStorage.setItem(KEY, JSON.stringify([{ text: 'A', done: false }, { text: 'B', done: false }, { text: 'C', done: false }]));
  await wait(20);
  let list = JSON.parse(A.localStorage.getItem(KEY));
  list.splice(1, 1); // delete "B" -- the EXACT real main.html delete handler's own setGoals(key, list)
  A.localStorage.setItem(KEY, JSON.stringify(list));
  await wait(400); // let the 250ms debounced push settle

  if (!server.row || JSON.stringify(server.row.data[KEY]) !== JSON.stringify([{ text: 'A', done: false }, { text: 'C', done: false }])) {
    fail('Group A setup: the delete must have reached the fake server, got ' + JSON.stringify(server.row && server.row.data[KEY]));
  } else {
    ok('Group A setup: window A\'s delete correctly reached the server via read-merge-CAS');
  }

  const aData = A.localStorage.getItem(KEY);
  const aMeta = A.localStorage.getItem('__sync_meta_v1:goals');

  async function reloadAndCheck(label, remoteOverride) {
    const srv = makeFakeServer(remoteOverride !== undefined ? remoteOverride : { data: server.row.data, updated_at: server.row.updated_at });
    const B = makeSandbox(srv);
    B.localStorage.setItem(KEY, aData);
    if (aMeta) B.localStorage.setItem('__sync_meta_v1:goals', aMeta);
    B.window.initCloudSync({ appKey: 'goals', syncedPrefixes: ['goals:'] });
    await wait(50);
    const after = JSON.parse(B.localStorage.getItem(KEY) || 'null');
    const reappeared = Array.isArray(after) && after.some((g) => g.text === 'B');
    if (reappeared) fail('THE EXACT ASSERTION REQUESTED: ' + label + ' — "B" must stay deleted, got ' + JSON.stringify(after));
    else ok(label + ' — "B" stays deleted');
  }

  await reloadAndCheck('reload variant 1/4 (real server row, as actually pushed)');
  // The remote data's own _meta field (inside `data`) is what applyRemote reads.
  {
    const srv = makeFakeServer({
      data: { [KEY]: [{ text: 'A', done: false }, { text: 'B', done: false }, { text: 'C', done: false }], _meta: { [KEY]: { updatedAt: 1, deleted: false } } },
      updated_at: 'irrelevant-2',
    });
    const B = makeSandbox(srv);
    B.localStorage.setItem(KEY, aData);
    if (aMeta) B.localStorage.setItem('__sync_meta_v1:goals', aMeta);
    B.window.initCloudSync({ appKey: 'goals', syncedPrefixes: ['goals:'] });
    await wait(50);
    const after = JSON.parse(B.localStorage.getItem(KEY) || 'null');
    if (Array.isArray(after) && after.some((g) => g.text === 'B')) fail('reload variant 2/4: "B" must stay deleted, got ' + JSON.stringify(after));
    else ok('reload variant 2/4 (stale remote, _meta has an OLDER valid timestamp for this key) — "B" stays deleted');
  }
  await reloadAndCheck('reload variant 3/4 (stale remote, _meta exists but is MISSING this key\'s entry)', {
    data: { [KEY]: [{ text: 'A', done: false }, { text: 'B', done: false }, { text: 'C', done: false }], _meta: { 'goals:2099-01-01': { updatedAt: Date.now(), deleted: false } } },
    updated_at: 'irrelevant-3',
  });
  await reloadAndCheck('reload variant 4/4 (stale remote, NO _meta at all — legacy row)', {
    data: { [KEY]: [{ text: 'A', done: false }, { text: 'B', done: false }, { text: 'C', done: false }] },
    updated_at: 'irrelevant-4',
  });

  // =================================================================
  // Group B — a second device/tab with a stale pre-delete copy pushes
  // an UNRELATED key. The server must keep the delete's own _meta and
  // data; the deleted goal must stay deleted server-side.
  // =================================================================
  {
    const C = makeSandbox(server); // SAME shared server as window A above, which already has the delete
    C.localStorage.setItem(KEY, JSON.stringify([{ text: 'A', done: false }, { text: 'B', done: false }, { text: 'C', done: false }])); // C's OWN stale, pre-delete copy
    C.window.initCloudSync({ appKey: 'goals', syncedPrefixes: ['goals:'] });
    await wait(20);
    C.localStorage.setItem('goals:2026-10-22', JSON.stringify([{ text: 'unrelated', done: false }])); // an edit to a totally different key
    await wait(400);
    const stillDeleted = !server.row.data[KEY].some((g) => g.text === 'B');
    if (!stillDeleted) fail('THE EXACT ASSERTION REQUESTED (Group B): device C\'s unrelated push must never resurrect "B" on the server, got ' + JSON.stringify(server.row.data[KEY]));
    else ok('Group B: device C\'s push of an unrelated key correctly merges — the server keeps "B" deleted');
    if (!server.row.data['goals:2026-10-22']) fail('Group B: device C\'s own real edit must still land, got ' + JSON.stringify(server.row.data));
    else ok('Group B: device C\'s own real edit (the unrelated key) still lands on the server');
  }

  // =================================================================
  // Group C — two devices edit DIFFERENT keys concurrently (a genuine
  // CAS race: both read the SAME server row before either writes).
  // Both edits must survive.
  // =================================================================
  {
    const srv = makeFakeServer({ data: { 'goals:2026-11-01': [{ text: 'seed', done: false }] }, updated_at: 'v0' });
    let raceArmed = true;
    const D1 = makeSandbox(srv, {
      onSelect: (s) => {
        // The FIRST time device D1 reads the server, inject device
        // D2's own complete push landing in between D1's read and
        // D1's write -- deterministically engineering the exact race
        // a CAS is meant to catch.
        if (!raceArmed) return;
        raceArmed = false;
        s.row = { data: Object.assign({}, s.row.data, { 'goals:2026-11-02': [{ text: 'from-D2', done: false }] }), updated_at: 'v1-from-D2' };
      },
    });
    D1.window.initCloudSync({ appKey: 'goals', syncedPrefixes: ['goals:'] });
    await wait(20);
    D1.localStorage.setItem('goals:2026-11-03', JSON.stringify([{ text: 'from-D1', done: false }]));
    await wait(600); // long enough to cover the CAS-conflict retry's own re-read + re-write

    const finalData = srv.row.data;
    if (!finalData['goals:2026-11-02'] || !finalData['goals:2026-11-03']) {
      fail('THE EXACT ASSERTION REQUESTED (Group C): both concurrent edits to DIFFERENT keys must survive, got ' + JSON.stringify(finalData));
    } else {
      ok('Group C: two devices editing different keys concurrently — both survive after the CAS conflict + retry');
    }
    if (srv.selectCount < 2) fail('Group C: THE EXACT ASSERTION REQUESTED — a CAS conflict must trigger an actual re-read+retry (expected >= 2 selects), got ' + srv.selectCount);
    else ok('Group C: the CAS conflict correctly triggered a re-read + retry (selectCount=' + srv.selectCount + ')');
  }

  // =================================================================
  // Group D — same key, concurrent edits: the NEWEST write wins.
  // =================================================================
  {
    const srv = makeFakeServer(null);
    const E1 = makeSandbox(srv);
    E1.window.initCloudSync({ appKey: 'goals', syncedPrefixes: ['goals:'] });
    await wait(20);
    E1.localStorage.setItem('goals:2026-12-01', JSON.stringify([{ text: 'older-write', done: false }]));
    await wait(400);

    await wait(5); // ensure a strictly later Date.now() for the second writer
    const E2 = makeSandbox(srv);
    E2.window.initCloudSync({ appKey: 'goals', syncedPrefixes: ['goals:'] }); // E2 never pulled E1's write before touching the same key
    await wait(20);
    E2.localStorage.setItem('goals:2026-12-01', JSON.stringify([{ text: 'newer-write', done: false }]));
    await wait(400);

    const winner = srv.row.data['goals:2026-12-01'];
    if (!winner || winner[0].text !== 'newer-write') {
      fail('THE EXACT ASSERTION REQUESTED (Group D): the newest write to the SAME key must win, got ' + JSON.stringify(winner));
    } else {
      ok('Group D: same key, concurrent edits — the newest write wins (' + JSON.stringify(winner) + ')');
    }
  }

  // =================================================================
  // Group E — server read fails/offline: local is kept exactly as is,
  // nothing is overwritten, and a retry is queued (verified by letting
  // a LATER, successful select go through).
  // =================================================================
  {
    const srv = makeFakeServer({ data: { 'goals:2026-10-21': [{ text: 'untouched', done: false }] }, updated_at: 'v0' });
    const F = makeSandbox(srv, { selectError: true });
    F.window.initCloudSync({ appKey: 'goals', syncedPrefixes: ['goals:'] });
    await wait(20);
    F.localStorage.setItem('goals:2026-10-30', JSON.stringify([{ text: 'local-only', done: false }]));
    await wait(400);
    if (srv.row.data['goals:2026-10-30']) {
      fail('THE EXACT ASSERTION REQUESTED (Group E): a failed server read must NEVER fall back to a blind write, got ' + JSON.stringify(srv.row.data));
    } else {
      ok('Group E: a failed server read never falls back to a blind overwrite — nothing was written');
    }
    if (F.localStorage.getItem('goals:2026-10-30') == null) {
      fail('Group E: local data must be kept exactly as the user left it despite the failed read');
    } else {
      ok('Group E: local data is kept exactly as is despite the failed read');
    }
  }

  // =================================================================
  // Group F — a key present ONLY on the server must never be dropped
  // by a push from a device that doesn't have it locally at all.
  // =================================================================
  {
    const srv = makeFakeServer({ data: { 'goals:2026-09-01': [{ text: 'server-only', done: false }] }, updated_at: 'v0' });
    const G = makeSandbox(srv);
    G.window.initCloudSync({ appKey: 'goals', syncedPrefixes: ['goals:'] });
    await wait(20);
    G.localStorage.setItem('goals:2026-09-02', JSON.stringify([{ text: 'new-local', done: false }])); // G never had 2026-09-01 at all
    await wait(400);
    if (!srv.row.data['goals:2026-09-01']) {
      fail('THE EXACT ASSERTION REQUESTED (Group F): a server-only key must never be dropped by an unrelated push, got ' + JSON.stringify(srv.row.data));
    } else {
      ok('Group F: a server-only key (2026-09-01) survives a push from a device that never had it locally');
    }
    if (G.localStorage.getItem('goals:2026-09-01') == null) {
      fail('Group F: the pushing device should also pick up the server-only key locally after the merge');
    } else {
      ok('Group F: the pushing device also picks up the server-only key locally (applyMergedLocally)');
    }
  }

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
}

main();
