// Local-first data layer. Every table lives in IndexedDB (Dexie); writes go
// local first and into an outbox, then sync() pushes the outbox and pulls
// anything newer from the server. The UI never waits on the network.
import Dexie from 'dexie';
import { apiFetch, isLocal, isNative, haptic as deviceHaptic, budgetDbName, webServerBudget, switchBudget } from './platform.js';

/**
 * Reload the app on purpose (after a restore, reset, budget switch…). Skips the browser's own
 * "Leave site?" box, which is only for really closing the tab with unsynced changes.
 */
export function reloadApp() { window.__appReloading = true; location.reload(); }
export const TABLES = ['accounts', 'category_groups', 'categories', 'budget_months', 'transactions', 'scheduled', 'payee_rules', 'household_prefs'];

export const db = new Dexie(budgetDbName());   // one database per budget on this phone
/** True if the open budget changed under this page (it must reload before touching data). */
export const budgetChanged = () => budgetDbName() !== db.name;
db.version(1).stores({
  accounts: 'id, name, type',
  category_groups: 'id, sort',
  categories: 'id, group_id',
  budget_months: 'id, [category_id+month], month',
  transactions: 'id, account_id, date, category_id, transfer_id',
  outbox: '++seq, tbl, row_id',
  meta: 'key',
});
db.version(2).stores({
  scheduled: 'id, next_date, account_id',
  payee_rules: 'id',
});
db.version(3).stores({
  history: '++seq, batch, ts',
});
db.version(4).stores({
  household_prefs: 'id',
});
export const getPref = async (key, dflt = null) => { const r = await db.household_prefs.get(key); return r && !r.deleted ? r.value : dflt; };
export const setPref = (key, value) => put('household_prefs', { id: key, value: String(value) });

// crypto.randomUUID is only available in secure contexts (https / localhost);
// on a plain LAN http:// address we fall back to a manual v4.
/** Short vibration: native haptics in the app, navigator.vibrate in a browser. */
export const haptic = deviceHaptic;

export const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)));
export const now = () => Date.now();

// --- subscriptions so views re-render after any local write or sync ----
const listeners = new Set();
export const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const notify = () => listeners.forEach(fn => fn());
// Goes up whenever the budget's data (or its history) is written, by anything: views reload their
// data only then, not on every sync-status change (a sync with nothing new used to re-read every
// table and redraw the whole app, a stutter once a minute).
let dataVer = 1;
export const dataVersion = () => dataVer;
const bump = () => { dataVer++; };
// An in-memory copy of each budget table, kept current from every committed write, so a change
// doesn't mean re-reading thousands of transactions from storage (most of a save's time on a phone).
const mirror = {};   // table -> Map(id -> row), once read
// Applied as each write happens (so it's current before the save finishes and the screen redraws);
// if the write is then rolled back, the copy is dropped and read again from storage.
const after = (tx, fn, t) => { fn(); bump(); if (tx?.on) tx.on('abort', () => { delete mirror[t]; bump(); }); };
for (const t of [...TABLES, 'history']) {
  const keep = TABLES.includes(t);
  db[t].hook('creating', function (key, obj, tx) { const row = { ...obj }; if (key != null && row.id == null) row.id = key; after(tx, () => keep && mirror[t]?.set(row.id, row), t); });
  db[t].hook('updating', function (mods, key, obj, tx) {
    const row = { ...obj };
    for (const [k, v] of Object.entries(mods)) { if (v === undefined) delete row[k]; else row[k] = v; }
    after(tx, () => keep && mirror[t]?.set(key, row), t);
  });
  db[t].hook('deleting', function (key, obj, tx) { after(tx, () => keep && mirror[t]?.delete(key), t); });
  const clear = db[t].clear.bind(db[t]); db[t].clear = () => { delete mirror[t]; bump(); return clear(); };
}
/** A table's rows that aren't deleted: from the in-memory copy, reading storage only the first time. */
export async function liveRows(t) {
  if (!mirror[t]) {
    const all = await db[t].toArray();
    if (!mirror[t]) mirror[t] = new Map(all.map(r => [r.id, r]));
  }
  const out = [];
  for (const r of mirror[t].values()) if (!r.deleted) out.push(r);
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));   // storage's order (by id), as before
}

// ---- history / undo -----------------------------------------------------------
// Every local write records {batch, ts, label, tbl, row_id, before, after}. Writes made
// inside beginBatch()/endBatch() share one batch id so a whole import or batch edit
// undoes as one step. Undo = re-put the `before` snapshots (or soft-delete if none).
let batchId = null, batchLabel = null, batchCount = 0;
export function beginBatch(label) { batchId = uuid(); batchLabel = label; batchCount = 0; return batchId; }
export function endBatch() { const id = batchId; batchId = null; batchLabel = null; return id; }
const HISTORY_MAX = 1000;
export function labelFor(tbl, row, before) {
  const verb = !before ? 'Added' : row.deleted && !before.deleted ? 'Deleted' : 'Edited';
  const money = c => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toFixed(2);
  switch (tbl) {
    case 'transactions': return `${verb} ${row.payee || 'transaction'} ${money(row.amount)}`;
    case 'budget_months': return `Assigned ${money(row.assigned)} (${row.month})`;
    case 'categories': return `${verb} category ${row.name}`;
    case 'category_groups': return `${verb} group ${row.name}`;
    case 'accounts': return `${verb} account ${row.name}`;
    case 'scheduled': return `${verb} scheduled ${row.payee}`;
    case 'payee_rules': return `${verb} rule ${row.match}`;
    case 'household_prefs': {
      if (row.id.startsWith('card:')) return `Remembered card ••${row.id.slice(5)}`;
      if (row.id.startsWith('icon:')) return 'Changed a category icon';
      if (row.id === 'setup:done') return 'Finished setup';
      if (row.id === 'debt:exclude') return 'Debt plan: debts included';
      if (row.id === 'reports:hide') return 'Reports: accounts shown';
      if (row.id === 'pay:schedule') return 'Changed when you get paid';
      if (row.id === 'reports:piehide') return 'Reports: categories in the spending chart';
      if (row.id === 'debt:strategy') return `Debt plan: ${row.value === 'avalanche' ? 'avalanche' : 'snowball'}`;
      if (row.id === 'debt:extra') return `Debt plan: extra $${((Number(row.value) || 0) / 100).toFixed(2)} a month`;
      if (row.id.startsWith('debt:')) return 'Debt plan: rate or minimum';
      if (row.id === 'closed_through') return row.value ? `Closed months through ${new Date(row.value + '-15').toLocaleString(undefined, { month: 'short', year: 'numeric' })}` : 'Reopened all months';
      return `Changed setting ${row.id.replace(/_/g, ' ')}`;
    }
    default: return `${verb} ${tbl}`;
  }
}
// Bookkeeping the app writes for itself (badges earned) isn't something you'd want Undo to reverse.
const quiet = (tbl, row) => tbl === 'household_prefs' && /^badges?:/.test(row.id || '');
async function record(tbl, before, after) {
  if (quiet(tbl, after)) return;
  const label = batchLabel ? (batchCount++ === 0 ? batchLabel : null) : labelFor(tbl, after, before);
  await db.history.add({ batch: batchId || uuid(), ts: now(), label, tbl, row_id: after.id, before: before || null, after });
  const n = await db.history.count();
  if (n > HISTORY_MAX) { const old = await db.history.orderBy('seq').limit(n - HISTORY_MAX).primaryKeys(); await db.history.bulkDelete(old); }
}
/** Recent batches, newest first: [{batch, ts, label, count, tbls}] */
export async function historyList(limit = 60) {
  const rows = await db.history.orderBy('seq').reverse().limit(2000).toArray();
  const out = []; const idx = {};
  for (const r of rows) {
    let b = idx[r.batch];
    if (!b) { b = idx[r.batch] = { batch: r.batch, ts: r.ts, label: r.label, count: 0, undone: false }; out.push(b); }
    b.count++; if (r.label && !b.label) b.label = r.label; if (r.undone) b.undone = true;
    if (out.length > limit) break;
  }
  return out.slice(0, limit);
}
/** Reverse every change in a batch, newest first. Recorded as its own batch. */
export async function undoBatch(batch) {
  const rows = await db.history.where('batch').equals(batch).reverse().sortBy('seq');
  if (!rows.length) return 0;
  beginBatch('Undo: ' + (rows.find(r => r.label)?.label || 'change'));
  try {
    for (const r of rows) {
      if (r.before) await put(r.tbl, r.before);
      else await put(r.tbl, { ...r.after, deleted: 1 });
    }
  } finally { endBatch(); }
  for (const r of rows) await db.history.update(r.seq, { undone: true });
  return rows.length;
}

// ---- what you may change in a shared budget -----------------------------------------------
// The server says your level in this budget (role) and who you are to it (actor, what your
// transactions record as created_by). Offline budgets, and servers that don't tell people apart,
// have no limits. The server enforces the same rules; this keeps the app from making changes that
// would only be refused.
export const access = { role: null, actor: null };
export function setAccess(role, actor) {
  if (!role || (role === access.role && actor === access.actor)) return;
  access.role = role; access.actor = actor || null;
  setMeta('access', { role: access.role, actor: access.actor }).catch(() => {});
  notify();
}
/** You can change everything in this budget (owners, members, offline). */
export const canChangeAll = () => isLocal() || !access.role || access.role === 'owner' || access.role === 'member';
/** You can add purchases (everyone but view-only). */
export const canAddPurchases = () => canChangeAll() || access.role === 'spender';
export const LIMIT_MSG = () => (access.role === 'viewer' ? 'You can view this budget but not change it.' : 'You can add purchases and change the ones you added. Ask an owner for anything else.');
let lastLimitNote = 0;
function refuse() {
  if (Date.now() - lastLimitNote > 4000) { lastLimitNote = Date.now(); dispatchEvent(new CustomEvent('budget:limited', { detail: LIMIT_MSG() })); }
  const e = new Error(LIMIT_MSG()); e.limited = true; throw e;
}
/** null when allowed; 'quiet' for settings that simply aren't saved; otherwise refuses. */
function check(tbl, row, before) {
  if (canChangeAll()) return null;
  if (tbl === 'household_prefs') return 'quiet';   // conveniences (remembered cards, badges): just not saved
  if (access.role === 'spender' && tbl === 'transactions' && (!before || before.created_by === access.actor)) return null;
  refuse();
}

export async function put(tbl, row) {
  if (budgetChanged()) { reloadApp(); throw new Error('Switching budgets'); }
  const full = { deleted: 0, ...row, id: row.id || uuid(), updated_at: now() };
  const limited = access.role && !isLocal();
  if (limited || tbl === 'transactions') {
    const prior = await db[tbl].get(full.id);
    if (limited && check(tbl, full, prior) === 'quiet') return full;
    if (limited && tbl === 'transactions' && !prior && !full.created_by && access.actor) full.created_by = access.actor;
    // When it was entered: set once (a tap-to-pay purchase brings the payment's time), never changed,
    // so editing or clearing it doesn't move it. Older rows keep their last-changed time as theirs.
    if (tbl === 'transactions') full.created_at = prior?.created_at || full.created_at || prior?.updated_at || full.updated_at;
  }
  try {
    await db.transaction('rw', db[tbl], db.outbox, db.history, async () => {
      const before = await db[tbl].get(full.id);
      await db[tbl].put(full);
      // Offline mode has no server to push to; connecting later uploads everything at once.
      if (!isLocal()) await db.outbox.put({ tbl, row_id: full.id });
      await record(tbl, before, full);
    });
  } catch (e) {
    syncState.lastError = 'Save failed: ' + e.message;
    notify();
    throw e;
  }
  notify();
  return full;
}
/**
 * Many rows of one table in a single database transaction, one history batch (one Undo) and one
 * redraw. For imports: hundreds of separate put()s each count the history and re-render the app,
 * which takes tens of seconds on a phone.
 */
export async function putMany(tbl, rows, label) {
  if (budgetChanged()) { reloadApp(); throw new Error('Switching budgets'); }
  const ts = now(), batch = batchId || uuid();   // inside beginBatch(): part of that one Undo
  const full = rows.map(r => ({ deleted: 0, ...r, id: r.id || uuid(), updated_at: ts }));
  if ((access.role && !isLocal()) || tbl === 'transactions') {
    const prior = await db[tbl].bulkGet(full.map(r => r.id));
    if (access.role && !isLocal()) for (let i = 0; i < full.length; i++) if (check(tbl, full[i], prior[i]) === 'quiet') return full;
    // Imported in one go: keep the file's order within a day (a millisecond apart, in sequence).
    if (tbl === 'transactions') full.forEach((r, i) => { r.created_at = prior[i]?.created_at || r.created_at || prior[i]?.updated_at || ts - full.length + i; });
  }
  try {
    await db.transaction('rw', db[tbl], db.outbox, db.history, async () => {
      const before = await db[tbl].bulkGet(full.map(r => r.id));
      await db[tbl].bulkPut(full);
      if (!isLocal()) await db.outbox.bulkPut(full.map(r => ({ tbl, row_id: r.id })));
      await db.history.bulkAdd(full.map((r, i) => ({ batch, ts, label: i === 0 ? (batchId ? (batchCount++ === 0 ? batchLabel : null) : label) : null, tbl, row_id: r.id, before: before[i] || null, after: r })));
      const n = await db.history.count();
      if (n > HISTORY_MAX) { const old = await db.history.orderBy('seq').limit(n - HISTORY_MAX).primaryKeys(); await db.history.bulkDelete(old); }
    });
  } catch (e) {
    syncState.lastError = 'Save failed: ' + e.message;
    notify();
    throw e;
  }
  notify();
  return full;
}

export const remove = (tbl, id) => db[tbl].get(id).then(r => r && put(tbl, { ...r, deleted: 1 }));
export const restore = (tbl, id) => db[tbl].get(id).then(r => r && put(tbl, { ...r, deleted: 0 }));

/** Move money between accounts. `category_id` (optional) makes the outflow leg a budgeted
 *  expense — used for paying off-budget loans from a category (mortgage, car loan). */
export async function transfer({ from_account_id, to_account_id, amount, date, memo = '', category_id = null }) {
  const transfer_id = uuid();
  const a = Math.abs(amount);
  await put('transactions', { account_id: from_account_id, date, amount: -a, memo, transfer_id, payee: 'Transfer', category_id: category_id || null, cleared: 0 });
  await put('transactions', { account_id: to_account_id, date, amount: a, memo, transfer_id, payee: 'Transfer', category_id: null, cleared: 0 });
  return transfer_id;
}

export async function assign(category_id, month, assigned) {
  // Reuse the live row for this category/month; fall back to reviving a soft-deleted one.
  const rows = await db.budget_months.where('[category_id+month]').equals([category_id, month]).toArray();
  const live = rows.filter(r => !r.deleted);
  const existing = live[0] || rows[0];
  // If duplicates somehow exist, fold them into one so the view and the server agree.
  for (const extra of live.slice(1)) await put('budget_months', { ...extra, deleted: 1 });
  return put('budget_months', { ...(existing || {}), category_id, month, assigned, deleted: 0 });
}

// --- reads (filter soft-deleted) ---------------------------------------
export const live = tbl => db[tbl].filter(r => !r.deleted).toArray();
export const getMeta = (k, d) => db.meta.get(k).then(r => (r ? r.value : d));
export const setMeta = (k, value) => db.meta.put({ key: k, value });
getMeta('access').then(v => { if (v) { Object.assign(access, v); notify(); } }).catch(() => {});   // your level, remembered for offline

// --- sync -------------------------------------------------------------------
export const APP_VERSION = __APP_VERSION__;
export const CHANGELOG = __CHANGELOG__;
export const syncState = { busy: false, lastError: null, lastSync: null, online: navigator.onLine, pending: 0, serverVersion: null, unreachable: false, needsLogin: false };
const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
// In a browser any difference means the server was redeployed. The app only ever moves forward:
// its own bundled screens may be newer than the server's.
export const updateAvailable = () => !!syncState.serverVersion && (isNative ? newer(syncState.serverVersion, APP_VERSION) : syncState.serverVersion !== APP_VERSION);
window.addEventListener('online', () => { syncState.online = true; sync(); notify(); });
window.addEventListener('offline', () => { syncState.online = false; notify(); });

// Offline mode: the starter categories the server would otherwise create for a new household.
const DEFAULT_GROUPS = [
  ['Bills', ['Rent / Mortgage', 'Electric', 'Water', 'Internet', 'Phone', 'Insurance']],
  ['Everyday', ['Groceries', 'Gas', 'Dining Out', 'Household']],
  ['Debt', ['Loan Payments']],
  ['Savings Goals', ['Emergency Fund', 'Vacation']],
];
async function seedLocalIfNew() {
  if (await getMeta('seeded')) return;
  const ts = now();
  await db.transaction('rw', db.category_groups, db.categories, db.meta, async () => {
    if (!(await db.category_groups.count())) {
      for (const [gs, [gname, cats]] of DEFAULT_GROUPS.entries()) {
        const gid = uuid();
        await db.category_groups.put({ id: gid, name: gname, sort: gs, is_income: 0, deleted: 0, updated_at: ts });
        for (const [cs, name] of cats.entries()) await db.categories.put({ id: uuid(), group_id: gid, name, sort: cs, deleted: 0, updated_at: ts });
      }
    }
    await setMeta('seeded', ts);
  });
  notify();
}

export async function bootstrapIfEmpty() {
  if (isLocal()) return seedLocalIfNew();
  const cursor = await getMeta('cursor');
  if (cursor !== undefined) return sync();
  const r = await apiFetch('/api/bootstrap');
  if (r.status === 404 && webServerBudget()) return switchBudget('main');   // that budget was deleted on the server
  if (r.status === 401) { syncState.needsLogin = true; syncState.lastError = 'Not signed in'; notify(); return; }
  if (!r.ok) throw new Error('bootstrap failed: ' + r.status);
  syncState.needsLogin = false;
  const { cursor: c, data, version, role, actor, epoch } = await r.json();
  syncState.serverVersion = version;
  setAccess(role, actor);
  if (epoch != null) await setMeta('epoch', epoch);
  await db.transaction('rw', TABLES.map(t => db[t]).concat(db.meta), async () => {
    for (const t of TABLES) await db[t].bulkPut(data[t]);
    await setMeta('cursor', c);
  });
  syncState.lastSync = now();
  notify();
}

let syncPromise = null;
export function sync() {
  if (syncPromise) return syncPromise;
  syncPromise = doSync().finally(() => { syncPromise = null; notify(); });
  return syncPromise;
}

async function doSync() {
  if (isLocal() || !navigator.onLine) return;
  syncState.busy = true; notify();
  try {
    const out = await db.outbox.toArray();
    const changes = Object.fromEntries(TABLES.map(t => [t, []]));
    const seen = new Set();
    for (const o of out) {
      const key = o.tbl + ':' + o.row_id;
      if (seen.has(key)) continue;
      seen.add(key);
      const row = await db[o.tbl].get(o.row_id);
      // Older versions saved a removed target's goal type as null, which the server can't store.
      if (row && o.tbl === 'categories' && row.goal_type == null) row.goal_type = 'monthly';
      if (row) changes[o.tbl].push(row);
    }
    const cursor = await getMeta('cursor', 0);
    let r;
    try {
      r = await apiFetch('/api/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cursor, changes }) });
    } catch (e) { syncState.unreachable = true; syncState.lastError = 'Server unreachable'; return; }
    syncState.unreachable = false;
    if (r.status === 401) { syncState.lastError = 'Not signed in'; syncState.needsLogin = true; return; }
    if (r.status === 404 && webServerBudget()) { switchBudget('main'); return; }
    if (r.status === 404) { syncState.lastError = "Your server doesn't have this budget for you any more: it was deleted, or its owner stopped sharing it. Everything stays on this phone."; return; }
    syncState.needsLogin = false;
    if (r.status === 503) { try { const j = await r.json(); syncState.lastError = j.message || 'Server setup incomplete'; } catch { syncState.lastError = 'Server setup incomplete'; } return; }
    if (!r.ok) throw new Error('sync ' + r.status);
    const res = await r.json();
    syncState.serverVersion = res.version || syncState.serverVersion;
    // The server's copy was replaced wholesale (a backup restored, or erased), or this device's copy
    // predates such markers: rows deleted that way never reach a device as changes, so download the
    // budget again rather than keep what the server no longer has. (This device's changes went up
    // in this same request, so nothing is lost.)
    if (res.epoch != null) {
      const mine = await getMeta('epoch');
      if (mine !== res.epoch) {
        const sent = out.length ? out[out.length - 1].seq : 0;
        await db.transaction('rw', TABLES.map(t => db[t]).concat(db.outbox, db.meta, db.history), async () => {
          for (const t of TABLES) await db[t].clear();
          await db.outbox.where('seq').belowOrEqual(sent).delete();
          await db.history.clear();   // Undo can't refer to rows from the old copy
          await db.meta.delete('cursor');
        });
        await bootstrapIfEmpty();
        if (mine !== undefined) dispatchEvent(new CustomEvent('budget:limited', { detail: "Your server's copy of this budget was restored or erased, so this device downloaded it again." }));
        return;
      }
    }
    // Rows the server refused because their id belongs to another budget on it (never moved across).
    if (res.conflicts) syncState.conflicts = (syncState.conflicts || 0) + res.conflicts;
    setAccess(res.role, res.actor);
    const refused = Object.entries(res.refused || {}).filter(([, ids]) => ids.length);
    await db.transaction('rw', TABLES.map(t => db[t]).concat(db.outbox, db.meta), async () => {
      // Only clear outbox entries we actually sent.
      await db.outbox.where('seq').belowOrEqual(out.length ? out[out.length - 1].seq : 0).delete();
      for (const t of TABLES) {
        for (const row of res.changes[t]) {
          const local = await db[t].get(row.id);
          if (!local || local.updated_at <= row.updated_at) await db[t].put(row);
        }
      }
      // Changes your level in this budget doesn't allow: put the server's version back (or drop a
      // row the server never had), so this device shows what everyone else sees.
      for (const [t, ids] of refused) for (const id of ids) {
        if (!db[t]) continue;
        const cur = (res.current?.[t] || []).find(x => x.id === id);
        if (cur) await db[t].put(cur); else await db[t].delete(id);
      }
      await setMeta('cursor', res.cursor);
    });
    if (refused.length) dispatchEvent(new CustomEvent('budget:limited', { detail: LIMIT_MSG() + ' Changes that weren\'t allowed were undone.' }));
    syncState.lastError = null;
    syncState.lastSync = now();
    if (res.more) return doSync();
  } catch (e) {
    syncState.lastError = e.message;
  } finally {
    syncState.busy = false;
    syncState.pending = await db.outbox.count();
  }
}

// Push shortly after each local write, and poll while open.
let t;
subscribe(() => { clearTimeout(t); t = setTimeout(() => db.outbox.count().then(n => { syncState.pending = n; if (n) sync(); }), 1500); });
db.outbox.count().then(n => { syncState.pending = n; });
setInterval(sync, 60_000);
