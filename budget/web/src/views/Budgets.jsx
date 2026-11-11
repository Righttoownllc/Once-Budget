import { useEffect, useState } from 'preact/hooks';
import { useUI, setPickerActive } from '../main.jsx';
import { ask } from '../dialog.js';
import { APP_VERSION, reloadApp } from '../store.js';
import { listBudgets, createBudget, switchBudget, renameBudget, deleteBudget, isNative, isLocal, hasServerBudgets, serverBudgets, createServerBudget, hasPutOnline, linkServer, setPendingAction } from '../platform.js';

/**
 * "Choose a budget": a screen outside any budget (no month header, tabs, menu or + button), so
 * picking a budget means stepping out of the one you were in. Each one is a complete, separate budget (household, business, a shared trip, a
 * sandbox). App: budgets on this phone, each offline or connected to a budget on a server, plus
 * the server's other budgets to add. Browser: the budgets stored on this server.
 */
/** "today 3:41 PM", "yesterday 9:02 AM", or "Oct 28, 2026 4:15 PM". */
const when = ms => {
  const d = new Date(ms), t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = x => new Date(x).toDateString();
  if (day(d) === day(Date.now())) return 'today ' + t;
  if (day(d) === day(Date.now() - 864e5)) return 'yesterday ' + t;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' + t;
};

/** Accounts and latest change in one budget's database on this phone (read-only; never creates one). */
async function phoneStats(name) {
  const names = (await indexedDB.databases?.().catch(() => [])) || [];
  if (!names.some(d => d.name === name)) return { accounts: 0, updated_at: null };
  return new Promise(res => {
    const rq = indexedDB.open(name);
    rq.onerror = () => res({});
    rq.onsuccess = () => {
      const idb = rq.result, out = { accounts: 0, updated_at: null };
      const tables = ['accounts', 'category_groups', 'categories', 'budget_months', 'transactions', 'scheduled', 'payee_rules', 'household_prefs'].filter(t => idb.objectStoreNames.contains(t));
      const tx = idb.transaction(tables);
      for (const t of tables) tx.objectStore(t).openCursor().onsuccess = e => {
        const c = e.target.result; if (!c) return;
        const r = c.value;
        if (t === 'accounts' && !r.deleted && !r.closed) out.accounts++;
        if (r.updated_at && (!out.updated_at || r.updated_at > out.updated_at)) out.updated_at = r.updated_at;
        c.continue();
      };
      tx.oncomplete = () => { idb.close(); res(out); };
      tx.onerror = () => { idb.close(); res(out); };
    };
  });
}

export function Budgets() {
  const ui = useUI();
  const [state, setState] = useState(null);
  const [onServer, setOnServer] = useState(null);   // app: { main, list } from the connected server
  const [name, setName] = useState('');
  const [where, setWhere] = useState(isNative ? 'phone' : 'server');   // app: new budget offline, or on the server
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(null);   // { id, server, name }
  const [deleting, setDeleting] = useState(null);   // { id, server, name, word }

  const load = () => listBudgets().then(async r => {
    // App: count each budget's accounts and find its latest change from its own database on the phone.
    if (isNative) r = { ...r, list: await Promise.all(r.list.map(async b => ({ ...b, ...(await phoneStats(b.id === 'main' ? 'budget' : 'budget-' + b.id)) }))) };
    setState(r);
    if (isNative) {
      // Tidy up databases left by budgets that no longer exist on this phone.
      const known = new Set(r.list.map(b => (b.id === 'main' ? 'budget' : 'budget-' + b.id)));
      indexedDB.databases?.().then(dbs => dbs.forEach(d => { if (/^budget-/.test(d.name) && !known.has(d.name)) indexedDB.deleteDatabase(d.name); })).catch(() => {});
      if (!isLocal() && hasServerBudgets()) serverBudgets().then(setOnServer).catch(() => setOnServer(null));
    }
  }).catch(e => ui.toast(e.message));
  useEffect(() => { setPickerActive(true); load(); }, []);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (isNative && where === 'server') {
        const b = await createServerBudget(name.trim() || 'New budget');
        await createBudget(b.name, { server: b.id });
      } else await createBudget(name.trim() || 'New budget');
    } catch (e) { ui.toast(e.message); setBusy(false); }
    // The app/page reloads on the new budget.
  };
  const addFromServer = b => createBudget(b.name, { server: b.id }).catch(e => ui.toast(e.message));
  // Re-entering the budget you just left needs no reload; any other budget loads fresh.
  // Converting: open the budget and let its Settings do it (server check, upload / disconnect, confirmations).
  const connected = (state?.list || []).find(b => b.mode === 'server');
  const convert = async (b, act) => {
    if (act === 'online') {
      if (!(await ask(`Put ${b.name} on your server?\n\nOnce Budget checks that your server can be reached, creates a budget called "${b.name}" there and uploads everything in it. It then syncs like your other server budgets.`, { title: 'Put on your server', ok: 'Continue' }))) return;
      await linkServer(b.id, connected.id);
    }
    setPendingAction(b.id, act);
    if (b.id === state?.active) { setPickerActive(false); location.replace('#/more/sync'); reloadApp(); }
    else switchBudget(b.id).catch(e => ui.toast(e.message));
  };
  const open = id => {
    if (id === state?.active) { setPickerActive(false); location.replace('#/budget'); return; }
    switchBudget(id).catch(e => ui.toast(e.message));
  };
  const saveName = async () => { try { await renameBudget(renaming.id, renaming.name, renaming.server); setRenaming(null); load(); } catch (e) { ui.toast(e.message); } };
  const remove = async () => {
    try { await deleteBudget(deleting.id, deleting.server); ui.toast(`Deleted ${deleting.name}`); setDeleting(null); load(); }
    catch (e) { ui.toast(e.message); }
  };

  // Server budgets already on this phone: connected phone budgets remember which one they sync with
  // (an unlinked connected budget syncs with your main server budget).
  const linked = new Set((state?.list || []).filter(b => b.mode === 'server').map(b => b.serverBudget || onServer?.main));
  const addable = onServer ? onServer.list.filter(b => !linked.has(b.id)) : [];

  return (
    <div class="shell picker">
      <header class="hdr">
        <div class="col" style="padding-bottom:16px">
          <span class="eyebrow">Once Budget · RightToOwn</span>
          <span class="title" style="font-size:24px">Choose a budget</span>
          <span class="head" style="color:var(--head-muted)">{isNative ? 'Budgets on this phone' : 'Budgets on your server'}</span>
        </div>
      </header>
      <main class="body">
      <div class="card">
        <span class="head">{isNative
          ? 'Each budget is completely separate, with its own accounts, transactions and categories. A budget can stay offline on this phone, or sync with a budget on your server. Use them for separate households, a business, a shared trip, or a sandbox.'
          : 'Each budget is completely separate and stored on your server, which backs them all up every night. This browser only keeps a working copy, so clearing it loses nothing.'}</span>
      </div>

      {state && state.list.map(b => {
        const active = b.id === state.active;
        return (
          <div class="card" key={b.id}>
            <div class="row between">
              <div class="col" style="min-width:0">
                <b>{b.name}{active && <span class="pill" style="margin-left:6px">last open</span>}</b>
                <span class="budgetstats">{b.accounts ?? 0} account{b.accounts === 1 ? '' : 's'} · {b.updated_at ? `updated ${when(b.updated_at)}` : 'no changes yet'}</span>
                <span class="head">{isNative ? (b.mode === 'server' ? 'Synced with a server' : 'Offline · on this phone only') : `${b.transactions ?? 0} transaction${b.transactions === 1 ? '' : 's'}`}{b.id === 'main' ? (isNative ? ' · your first budget' : ' · your main budget') : ''}</span>
              </div>
              <button class="primary" onClick={() => open(b.id)}>Open</button>
            </div>
            {renaming?.id === b.id ? (
              <div class="row">
                <input value={renaming.name} onInput={e => setRenaming({ ...renaming, name: e.target.value })} autoFocus />
                <button class="primary" onClick={saveName}>Save</button><button class="ghost" onClick={() => setRenaming(null)}>Cancel</button>
              </div>
            ) : deleting?.id === b.id ? (
              <div class="col" style="gap:8px;padding:10px;border-radius:10px;background:var(--neg-bg)">
                <b class="neg">Delete {b.name}?</b>
                <span class="head">{isNative
                  ? (b.mode === 'server' ? 'Removes it from this phone. The budget stays on your server.' : "Everything in this budget is erased. It isn't stored anywhere else, so export it first if you might want it.")
                  : 'Deletes it from your server, for everyone. A backup of the server is taken first (Settings › Backups & data › Restore can bring it back).'}</span>
                <label class="head">Type YES to confirm<input value={deleting.word} onInput={e => setDeleting({ ...deleting, word: e.target.value })} placeholder="YES" autoFocus /></label>
                <div class="row"><button class="primary" style="background:var(--neg)" disabled={deleting.word !== 'YES'} onClick={remove}>Delete</button><button class="ghost" onClick={() => setDeleting(null)}>Cancel</button></div>
              </div>
            ) : (
              <div class="row">
                {(!b.role || b.role === 'owner') && <button class="ghost" onClick={() => setRenaming({ id: b.id, server: b.server, name: b.name })}>Rename</button>}
                {isNative && hasPutOnline() && b.mode !== 'server' && connected && <button class="ghost" onClick={() => convert(b, 'online')}>Put on your server</button>}
                {isNative && hasPutOnline() && b.mode === 'server' && <button class="ghost" onClick={() => convert(b, 'offline')}>Make offline</button>}
                {!active && b.id !== 'main' && (!b.role || b.role === 'owner') && <button class="ghost neg" onClick={() => setDeleting({ id: b.id, server: b.server, name: b.name, word: '' })}>Delete…</button>}
              </div>
            )}
          </div>
        );
      })}

      {isNative && addable.length > 0 && (
        <div class="card">
          <span class="eyebrow">On your server</span>
          <span class="head">Budgets on the server this budget syncs with that aren't on this phone yet. Adding one keeps it synced, using the same server addresses and sign-in.</span>
          {addable.map(b => (
            <div class="row between" key={b.id}>
              <div class="col"><b>{b.name}</b><span class="head">{b.accounts} accounts · {b.transactions} transactions</span></div>
              <button onClick={() => addFromServer(b)}>Add to this phone</button>
            </div>
          ))}
        </div>
      )}

      <div class="card form">
        <span class="eyebrow">New budget</span>
        {isNative && onServer && (
          <div class="seg">
            <button class={where === 'phone' ? 'on' : ''} onClick={() => setWhere('phone')}>Offline on this phone</button>
            <button class={where === 'server' ? 'on' : ''} onClick={() => setWhere('server')}>On your server</button>
          </div>
        )}
        <span class="head">{!isNative ? 'Created on your server with the starter categories, and opened here.'
          : where === 'server' ? 'Created on your server with the starter categories and synced to this phone.'
          : 'Starts offline with the starter categories. You can connect it to a server later under Settings › Sync & server.'}</span>
        <label>Name<input value={name} onInput={e => setName(e.target.value)} placeholder="e.g. Business, Cabin, Sandbox" /></label>
        <button class="primary" disabled={busy} onClick={create}>{busy ? 'Opening…' : 'Create and open'}</button>
      </div>
      <span class="head" style="text-align:center">Once Budget v{APP_VERSION}</span>
      </main>
    </div>
  );
}
