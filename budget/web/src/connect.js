// Connecting the Android app to the user's own server (opt-in), and back to offline mode.
//
// First connect: the phone's offline budget and the server's may both hold data. Before anything
// changes, a safety copy of the phone's data is saved inside the app. Then either
//   useServer — the phone takes the server's budget (its own is replaced), or
//   merge     — the phone's rows are added to the server's. Starter categories, groups and
//               accounts with the same name are matched up, so there's one "Groceries", not two.
import { db, TABLES, setMeta, now } from './store.js';
import { apiFetch, callNative } from './platform.js';
import { tell } from './dialog.js';

export const serverSettings = () => callNative('server.get');
export const saveServerSettings = s => callNative('server.set', s);
export const testServer = () => callNative('server.test');
export const signIn = () => callNative('server.login');
/** Sign-in through the phone's browser (works with Google); see CloudflareLogin.kt. */
export const browserSignIn = () => callNative('server.browserLogin');
/** Sign in again the way the user did last time (banner when the session expired). */
export async function reSignIn() {
  const s = await serverSettings();
  const r = await (s.loginMethod === 'browser' ? browserSignIn() : signIn()).catch(e => ({ ok: false, message: e.message }));
  if (!r.ok && r.message) await tell(r.message, { title: 'Sign in' });
  if (!r.ok) return false;
  // Signed in, but is the server actually letting us in now? If it still refuses, say why instead of
  // bouncing back to the same banner.
  const t = await testServer().catch(() => null);
  const ok = t && ['home', 'away'].some(k => t[k]?.status === 200);
  if (!ok) {
    await tell(t?.away?.needsLogin ? 'Cloudflare still asks for a sign-in. Try "Sign in with browser" under Settings › Sync & server.'
      : 'Signed in, but your server still refuses the connection. Open Settings › Sync & server and tap Save & test for details.');
    return false;
  }
  return true;
}
const setMode = mode => callNative('mode.set', { mode });

const live = rows => (rows || []).filter(r => !r.deleted);
/** Anything a person entered, beyond the starter categories. */
export const hasRealData = d => ['accounts', 'transactions', 'budget_months', 'scheduled'].some(t => live(d[t]).length > 0);

export async function localData() {
  const d = {};
  for (const t of TABLES) d[t] = await db[t].toArray();
  return d;
}

export async function serverData() {
  const r = await apiFetch('/api/bootstrap');
  if (r.status === 401) throw new Error('Not signed in to the server');
  if (!r.ok) throw new Error('Server answered ' + r.status);
  return r.json();   // { cursor, data, version }
}

/** Safety copy of everything on the phone, kept inside the app (last 5). */
export async function snapshotPhone(reason) {
  const data = await localData();
  const text = JSON.stringify({ version: 1, exported_at: now(), reason, data: Object.fromEntries(TABLES.map(t => [t, live(data[t])])) });
  return callNative('backup.save', { name: `before-${reason}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, text });
}

const key = s => (s || '').trim().toLowerCase();

/** Phone rows rewritten to point at the server's matching groups/categories/accounts. Pure, for testing. */
export function planMerge(phone, server) {
  const sGroups = live(server.category_groups), sCats = live(server.categories), sAccts = live(server.accounts);
  const groupMap = {}, catMap = {}, acctMap = {};
  for (const g of live(phone.category_groups)) {
    const m = sGroups.find(s => key(s.name) === key(g.name));
    if (m) groupMap[g.id] = m.id;
  }
  for (const c of live(phone.categories)) {
    const inGroup = groupMap[c.group_id];
    const same = sCats.filter(s => key(s.name) === key(c.name));
    const m = same.find(s => s.group_id === inGroup) || (same.length === 1 ? same[0] : null);
    if (m) catMap[c.id] = m.id;
  }
  for (const a of live(phone.accounts)) {
    const m = sAccts.find(s => key(s.name) === key(a.name) && s.type === a.type);
    if (m) acctMap[a.id] = m.id;
  }
  const cat = id => (id && catMap[id]) || id;
  const acct = id => (id && acctMap[id]) || id;
  const out = {};
  out.category_groups = live(phone.category_groups).filter(g => !groupMap[g.id]);
  out.categories = live(phone.categories).filter(c => !catMap[c.id]).map(c => ({ ...c, group_id: groupMap[c.group_id] || c.group_id }));
  out.accounts = live(phone.accounts).filter(a => !acctMap[a.id]);
  out.transactions = live(phone.transactions).map(t => ({ ...t, category_id: cat(t.category_id), account_id: acct(t.account_id) }));
  out.budget_months = live(phone.budget_months).map(b => ({ ...b, category_id: cat(b.category_id) }));
  out.scheduled = live(phone.scheduled).map(s => ({ ...s, category_id: cat(s.category_id), account_id: acct(s.account_id), ...(s.transfer_to ? { transfer_to: acct(s.transfer_to) } : {}) }));
  out.payee_rules = live(phone.payee_rules).map(r => ({ ...r, category_id: cat(r.category_id) }));
  out.household_prefs = live(phone.household_prefs).map(p => (p.id.startsWith('card:') ? { ...p, value: acct(p.value) } : p));
  return { rows: out, matched: { groups: Object.keys(groupMap).length, categories: Object.keys(catMap).length, accounts: Object.keys(acctMap).length } };
}

async function replaceWithServer(boot, extraRows = null) {
  const ts = now();
  await db.transaction('rw', TABLES.map(t => db[t]).concat(db.outbox, db.meta), async () => {
    for (const t of TABLES) await db[t].clear();
    await db.outbox.clear();
    await db.meta.clear();
    for (const t of TABLES) await db[t].bulkPut(boot.data[t] || []);
    if (extraRows) {
      for (const t of TABLES) {
        const rows = (extraRows[t] || []).map(r => ({ ...r, updated_at: ts }));
        await db[t].bulkPut(rows);
        await db.outbox.bulkAdd(rows.map(r => ({ tbl: t, row_id: r.id })));
      }
    }
    await setMeta('cursor', boot.cursor);
    await setMeta('seeded', ts);
  });
}

/** The phone takes the server's budget. */
export async function useServer(boot) {
  await snapshotPhone('use-server');
  await replaceWithServer(boot);
  await setMode('server');
}

/** The phone's budget is added to the server's; the next sync uploads it. */
export async function merge(boot, phone) {
  await snapshotPhone('merge');
  const plan = planMerge(phone, boot.data);
  await replaceWithServer(boot, plan.rows);
  await setMode('server');
  return plan.matched;
}

/** Back to offline mode. The data stays on the phone; reconnecting later goes through the first-connect choice again. */
export async function disconnect() {
  await db.outbox.clear();
  await db.meta.delete('cursor');
  await setMode('local');
}
