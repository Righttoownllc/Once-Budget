import { useEffect, useState } from 'preact/hooks';
import { Shell } from '../main.jsx';
import { db, sync, syncState, TABLES, put, putMany, APP_VERSION, CHANGELOG, updateAvailable, beginBatch, endBatch, historyList, undoBatch, reloadApp } from '../store.js';
import { confirmUndo } from '../main.jsx';
import { ask, tell } from '../dialog.js';
import { connState, useUI, applyUpdate, enablePush, disablePush, pushStatus } from '../main.jsx';
import { useState as useS } from 'preact/hooks';
import { remove } from '../store.js';
import { getDefaultAccount, setDefaultAccount, closedThrough, freshIds, rollSettings, planRoll, applyRoll, firstCardMonth, autoRoll } from '../features.js';
import { setPref } from '../store.js';
import { ym, addMonths, monthLabel, fmt } from '../budget.js';
import { CatInput } from './CatInput.jsx';
import { reminderSettings, saveReminderSettings, testReminder } from '../reminders.js';
import { serverSettings, saveServerSettings, testServer, signIn, browserSignIn, serverData, localData, hasRealData, useServer, merge, disconnect } from '../connect.js';
import { autoBackupOn, setAutoBackupOn } from '../autobackup.js';
import { hasAutoBackup, autoBackup, lastAutoBackup, listAutoBackups, restoreAutoBackup, backupFolder, pickBackupFolder, clearBackupFolder } from '../autobackup.js';
import { tapHaptics, setTapHaptics, hasAppLock, lockSettings, setLock, moneyHidden, setMoneyHidden, hasWidget, pinWidget } from '../platform.js';
import { hasServerBudgets, serverBudgets, createServerBudget, budgetId, hasBudgets, takePendingAction, hasPairing, pairServer } from '../platform.js';
import { apiFetch, isLocal, isNative, saveFile, captureAccess, captureLog, openCaptureSettings, requestNotifications, openNotificationSettings, openAppDetails, captureBudget, setCaptureBudget, hasCaptureBudget, listBudgets } from '../platform.js';
import { Help } from './Info.jsx';
import { SharingCard, ServerPasswordCard, HomeCodeCard } from './Sharing.jsx';
import { Select } from './Pick.jsx';

export function Settings({ data, section }) {
  const ui = useUI();
  const [, setDefTick] = useState(0);   // redraw after changing the default account
  const [me, setMe] = useState(null);
  const [msg, setMsg] = useState('');
  const [pending, setPending] = useState(0);
  useEffect(() => {
    if (!isLocal()) apiFetch('/api/me').then(r => r.json()).then(setMe).catch(() => {});
    db.outbox.count().then(setPending);
  }, [syncState.lastSync]);

  const importFile = async e => {
    const file = e.target.files[0];
    if (!file) return;
    let json = JSON.parse(await file.text());
    // A backup from another budget gets fresh ids, so it can never collide with (or, on a server,
    // be refused because of) the budget it came from. Restoring into the same budget keeps ids.
    const ids = TABLES.flatMap(t => (json.data?.[t] || []).map(r => r.id)).filter(Boolean);
    const overlap = ids.length && (await Promise.all(TABLES.map(t => db[t].bulkGet((json.data?.[t] || []).map(r => r.id))))).flat().some(Boolean);
    const copied = ids.length > 0 && !overlap;
    if (copied) json = { ...json, data: freshIds(json.data) };
    let n = 0, replaced = false;
    beginBatch(`Import ${file.name}`);
    try {
      // Restoring into an empty budget (fresh install or after Erase): the starter categories would
      // end up next to the backup's own, so retire them first. Same batch, so Undo brings them back.
      const empty = !data.accounts.length && !data.txs.length && !data.months.length;
      if (empty && json.data?.category_groups?.length) {
        for (const c of data.categories) await put('categories', { ...c, deleted: 1 });
        for (const g of data.groups) await put('category_groups', { ...g, deleted: 1 });
        replaced = data.groups.length > 0;
      }
      // One write per table (thousands of single writes took minutes on a phone).
      for (const t of TABLES) { const rows = json.data?.[t] || []; if (rows.length) { await putMany(t, rows); n += rows.length; } }
    }
    finally { endBatch(); }
    e.target.value = '';
    setMsg(`Imported ${n} rows${copied ? ' as a copy' : ''}${replaced ? ' (replacing the starter categories)' : ''}${local ? '' : '; syncing'}. Undo is under History if needed.`);
  };

  // Same shape as the server's /api/export, so either file imports anywhere.
  const exportLocal = async () => {
    const out = { version: 1, exported_at: Date.now(), data: {} };
    for (const t of TABLES) out.data[t] = (await db[t].toArray()).filter(r => !r.deleted);
    try {
      const r = await saveFile(`budget-export-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(out, null, 1));
      if (r?.saved) setMsg('Backup saved' + (r.name ? ': ' + r.name : ''));
    } catch (e) { setMsg(e.message); }
  };
  const exportServer = async () => {
    try { const r = await apiFetch('/api/export'); await saveFile(`budget-server-export-${new Date().toISOString().slice(0, 10)}.json`, await r.text()); }
    catch (e) { setMsg(e.message); }
  };
  const local = isLocal();

  // Wide screens: the list stays on the left and the chosen page (General to start) fills the right.
  const wide = useWide();
  const sec = SECTIONS.find(x => x.id === section) || (wide ? SECTIONS[0] : null);
  const back = <a href="#/more" data-back class="round" style="display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:22px;background:rgba(255,255,255,.12);color:#fff;text-decoration:none;font-size:22px" aria-label="Settings">‹</a>;
  const top = sec
    ? <div class="row">{back}<div class="col" style="flex:1;margin-left:12px"><span class="eyebrow">Settings</span><span class="title">{sec.title}</span></div></div>
    : <div class="col"><span class="eyebrow">Once Budget</span><span class="title">Settings</span></div>;

  const rows = SECTIONS.map(x => (
    <a class={'setrow' + (wide && sec?.id === x.id ? ' on' : '')} href={'#/more/' + x.id} key={x.id}>
      <span class="micon">{x.icon}</span>
      <span class="col" style="flex:1;min-width:0"><b>{x.title}</b><span class="head">{x.sub(local) || 'Version, updates, what\'s new'}</span></span>
      <span class="muted">›</span>
    </a>
  ));

  // ---- Settings home: one row per page ----
  if (!sec) return (
    <Shell route="more" top={top}>
      <div class="card setlist">
        {SECTIONS.filter(x => x.id !== 'about').map(x => (
          <a class="setrow" href={'#/more/' + x.id} key={x.id}>
            <span class="micon">{x.icon}</span>
            <span class="col" style="flex:1;min-width:0"><b>{x.title}</b><span class="head">{x.sub(local)}</span></span>
            <span class="muted">›</span>
          </a>
        ))}
      </div>
      <a class="setfoot" href="#/more/about">
        <span>Once Budget v{APP_VERSION}{updateAvailable() ? ' · update ready' : ''}</span><span>About &amp; privacy ›</span>
      </a>
    </Shell>
  );

  const show = id => sec.id === id;
  const content = <>
      {show('general') && <>
        <div class="card form">
          <span class="eyebrow">New transactions</span>
          <label>Account for new transactions (this device)
            <Select value={getDefaultAccount() || ''} onChange={e => { setDefaultAccount(e.target.value || null); setDefTick(t => t + 1); ui.toast('New transactions will start in ' + (data.accounts.find(a => a.id === e.target.value)?.name || 'your first cash account'), { plain: true }); }}>
              <option value="">First cash account</option>
              {data.accounts.filter(a => !a.closed).map(a => <option value={a.id}>{a.name}</option>)}
            </Select>
          </label>
        </div>
        <TapFeedback />
        <div class="card"><div class="row between"><span class="col"><b>Guided setup</b><span class="head">Accounts, paycheck, bills and everyday amounts, step by step</span></span><a class="link" href="#/setup" style="font-weight:600;color:var(--pos)">Run setup ›</a></div></div>
      </>}

      {show('privacy') && <Privacy />}

      {show('notifications') && <>
        <div id="reminders">{isNative ? <AppReminders data={data} /> : <Reminders />}</div>
        {isNative ? <TapToPay /> : <span class="head" style="padding:0 4px">Tap-to-pay capture (logging Google Wallet purchases as you pay) lives in the Android app; purchases logged there sync here.</span>}
      </>}

      {show('rules') && <>
        <RollSetting data={data} />
        <CloseMonths data={data} />
        <PayeeRules data={data} />
      </>}

      {show('sync') && <>
        {isNative && <ServerCard data={data} />}
        {local ? (
          <span class="head" style="padding:0 4px">{isNative ? 'This budget is stored only on this phone. There\'s no account and nothing is sent anywhere.' : 'This budget is stored only in this browser. Clearing the browser\'s site data erases it.'}</span>
        ) : (
          <div class="card">
            <span class="eyebrow">Sync</span>
            <div>{me ? <>Signed in as <b>{me.user.email || me.user.name}</b> <span class="pill">{me.auth}</span>{me.user.is_admin && me.separate ? <span class="pill">admin</span> : null}</> : <span class="muted">Not connected to server</span>}</div>
            <div class="muted" style="margin-top:6px">Last sync: {syncState.lastSync ? new Date(syncState.lastSync).toLocaleString() : 'never'} · {pending} pending change{pending === 1 ? '' : 's'}</div>
            {syncState.lastError && <div class="neg">{syncState.lastError}</div>}
            {syncState.conflicts > 0 && <div class="neg">{syncState.conflicts} change{syncState.conflicts === 1 ? '' : 's'} weren't uploaded because the same items belong to another budget on your server. Import them with Import JSON instead, which gives them their own copies.</div>}
            <button style="margin-top:8px" onClick={() => sync()}>Sync now</button>
            {!isNative && me?.auth === 'password' && (
              <div class="row" style="flex-wrap:wrap;margin-top:6px">
                <a class="btn primary btnlink" href="/pair">📱 Pair a phone</a>
                <a class="btn ghost btnlink" href="/logout">Sign out of this browser</a>
              </div>
            )}
            {!isNative && me?.auth === 'password' && <span class="head">Pair a phone shows a QR code to scan with the phone's camera, the devices that have access, and the address phones use from away.{me.user.is_admin ? ' As the admin, you also add people there.' : ''}</span>}
          </div>
        )}
        {!local && <ServerPasswordCard me={me} onDone={() => apiFetch('/api/me').then(r => r.json()).then(setMe).catch(() => {})} />}
        {!local && !isNative && <HomeCodeCard me={me} />}
        {!local && <SharingCard me={me} />}
      </>}

      {show('data') && <>
        {hasAutoBackup() && <AutoBackups />}
        <div class="card form">
          <span class="eyebrow">Export &amp; import</span>
          <div class="row" style="flex-wrap:wrap">
            <button onClick={exportLocal}>Export JSON{local ? '' : ' (this device)'}</button>
            {!local && <button onClick={exportServer}>Export JSON (server)</button>}
            {!local && <button onClick={() => apiFetch('/api/backup', { method: 'POST' }).then(r => r.json()).then(r => setMsg('Server backup written: ' + r.file)).catch(e => setMsg(e.message))}>Server backup now</button>}
          </div>
          <label>Import JSON<input type="file" accept="application/json" onChange={importFile} /></label>
          {!local && <Restore />}
          {msg && <div class="muted">{msg}</div>}
          <p class="head">{local ? 'A JSON file holds everything: accounts, transactions, categories, budgets, scheduled items, rules and settings.' : 'The server backs up every budget each night and keeps 14 days. Restore one above, or copy a file from data/backups/ back to data/budget.db.'}</p>
        </div>
        <div class="card form">
          <span class="eyebrow">Danger zone</span>
          {!local && <button onClick={async () => { if (!(await ask("Clear this device's copy and download it again from the server?", { ok: 'Reset' }))) return; await Promise.all(TABLES.map(t => db[t].clear())); await db.outbox.clear(); await db.meta.clear(); reloadApp(); }}>Reset local data</button>}
          {local ? <LocalReset /> : <FullReset />}
        </div>
      </>}

      {show('about') && <>
        <div class="card">
          <div class="row between"><span>App version</span><b>v{APP_VERSION}</b></div>
          {!local && <div class="row between"><span>Server version</span><b>{syncState.serverVersion ? 'v' + syncState.serverVersion : '—'}</b></div>}
          <div class="row between"><span>{local ? 'Storage' : 'Connection'}</span><span class="row"><span class={'dot ' + connState().color} /> {local ? (isNative ? 'This phone only' : 'This browser only') : connState().detail}</span></div>
          {!local && <Integrity />}
          {updateAvailable() && <button class="primary" onClick={applyUpdate}>Update to v{syncState.serverVersion}</button>}
          {!isNative && <button class="ghost" onClick={applyUpdate}>Check for update</button>}
          <a href="#/about" class="link" style="font-weight:600;color:var(--pos);text-decoration:none">Our rules, privacy and open-source licenses ›</a>
        </div>
        <div class="card">
          <span class="eyebrow">What's new</span>
          {CHANGELOG.slice(0, 3).map(e => <div class="col" style="margin-top:6px"><span class="eyebrow">v{e.version} · {e.date}</span><ul style="margin:2px 0 0 18px;padding:0">{e.changes.map(c => <li class="head">{c}</li>)}</ul></div>)}
          {CHANGELOG.length > 3 && <details><summary class="head" style="cursor:pointer;margin-top:8px">Older versions</summary>
            {CHANGELOG.slice(3).map(e => <div class="col" style="margin-top:8px"><span class="eyebrow">v{e.version} · {e.date}</span><ul style="margin:2px 0 0 18px;padding:0">{e.changes.map(c => <li class="head">{c}</li>)}</ul></div>)}
          </details>}
        </div>
      </>}
  </>;
  if (wide) return (
    <Shell route="more" top={<div class="col"><span class="eyebrow">Once Budget</span><span class="title">Settings</span></div>}>
      <div class="setpanes">
        <nav class="card setlist">{rows}</nav>
        <div class="setpage">{content}</div>
      </div>
    </Shell>
  );
  return <Shell route="more" top={top}>{content}</Shell>;
}

/** True on screens 1000px or wider (follows resizing). */
function useWide() {
  const q = typeof matchMedia === 'function' ? matchMedia('(min-width: 1000px)') : null;
  const [w, setW] = useState(!!q?.matches);
  useEffect(() => { if (!q) return; const f = () => setW(q.matches); q.addEventListener('change', f); return () => q.removeEventListener('change', f); }, []);
  return w;
}

/** Settings pages, in order. `sub` is the one-line summary on the Settings home. */
const SECTIONS = [
  { id: 'general', icon: '⚙', title: 'General', sub: () => 'Default account, tap vibration' },
  { id: 'privacy', icon: '🔒', title: 'Privacy & security', sub: () => isNative ? 'Hide balances, app lock, home-screen widget' : 'Hide balances' },
  { id: 'notifications', icon: '🔔', title: 'Notifications', sub: () => isNative ? 'Bill reminders, tap-to-pay' : 'Bill reminders' },
  { id: 'rules', icon: '📐', title: 'Budget rules', sub: () => 'Roll overspending, close months, payee rules' },
  { id: 'sync', icon: '☁', title: 'Sync & server', sub: local => local ? 'Offline · connect your own server' : 'Synced with your server · status' },
  { id: 'data', icon: '💾', title: 'Backups & data', sub: () => isNative ? 'Automatic backups, export, import, erase' : 'Export, import, restore, erase' },
  { id: 'about', icon: 'ℹ', title: 'About', sub: () => '' },
];

/** Undo history as its own screen (Menu › History). */
export function HistoryPage() {
  const top = <div class="row"><a href="#/budget" class="round" style="display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:22px;background:rgba(255,255,255,.12);color:#fff;text-decoration:none;font-size:22px" aria-label="Back">‹</a><div class="col" style="flex:1;margin-left:12px"><span class="eyebrow">Every change, undoable</span><span class="title">History</span></div></div>;
  return <Shell route="history" top={top}><History alwaysOpen /></Shell>;
}

const wantOpen = key => (location.hash.split('?')[1] || '').includes('open=' + key);
function PayeeRules({ data }) {
  const ui = useUI();
  const [open, setOpen] = useS(wantOpen('rules'));
  const [f, setF] = useS({ match: '', payee: '', category_id: '' });
  const groupName = Object.fromEntries(data.groups.map(g => [g.id, g.name]));
  const catName = Object.fromEntries(data.categories.map(c => [c.id, c.name]));
  const add = async () => {
    if (!f.match.trim() || !f.payee.trim()) return;
    if (data.rules.some(r => r.match.toLowerCase() === f.match.trim().toLowerCase())) { ui.toast('A rule for that already exists'); return; }
    await put('payee_rules', { match: f.match.trim().toLowerCase(), payee: f.payee.trim(), category_id: f.category_id || null });
    setF({ match: '', payee: '', category_id: '' }); ui.toast('Rule added');
  };
  return (
    <div class="card form">
      <div class="row between" onClick={() => setOpen(o => !o)} style="cursor:pointer"><span class="eyebrow">Payee rules</span><span class="pill">{data.rules.length}</span></div>
      {open && <>
        <p class="head" style="margin:0">When a typed or imported payee contains the text on the left, rename it and (optionally) set its category. Keeps "SQ *CORNER MARKET #123" showing as "Corner Market".</p>
        {data.rules.map(r => (
          <div class="row between" key={r.id}>
            <span class="head"><b>{r.match}</b> → {r.payee}{r.category_id ? ` · ${catName[r.category_id]}` : ''}</span>
            <button class="ghost" onClick={async () => { await remove('payee_rules', r.id); ui.toast('Rule removed', { undo: () => put('payee_rules', { ...r, deleted: 0 }) }); }}>✕</button>
          </div>
        ))}
        <div class="grid2">
          <label>Contains<input value={f.match} onInput={e => setF({ ...f, match: e.target.value })} placeholder="corner market" /></label>
          <label>Show as<input value={f.payee} onInput={e => setF({ ...f, payee: e.target.value })} placeholder="Corner Market" /></label>
        </div>
        <label>Default category<CatInput data={data} value={f.category_id} onChange={id => setF({ ...f, category_id: id || '' })} noneLabel="none" /></label>
        <button class="primary" onClick={add}>Add rule</button>
      </>}
    </div>
  );
}

function History({ alwaysOpen }) {
  const ui = useUI();
  const [open, setOpen] = useS(alwaysOpen || wantOpen('history'));
  const [list, setList] = useS([]);
  const refresh = () => historyList(60).then(setList);
  useEffect(() => { refresh(); }, [open, syncState.lastSync]);
  const when = ts => { const d = new Date(ts); const t = new Date(); return (d.toDateString() === t.toDateString() ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ') + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); };
  return (
    <div class="card">
      <div class="row between" onClick={() => !alwaysOpen && setOpen(o => !o)} style={alwaysOpen ? '' : 'cursor:pointer'}><span class="eyebrow">History &amp; undo</span><span class="pill">{list.length}</span></div>
      {open && (list.length === 0 ? <span class="head">No changes recorded on this device yet.</span> : (
        <div>
          <span class="head">Changes made on this device, newest first. Undo puts things back exactly as they were (and is itself undoable).</span>
          {list.map(b => (
            <div class="due" key={b.batch} style={b.undone ? 'opacity:.5' : ''}>
              <div class="main">
                <div class="p" style="font-size:14px">{b.label || 'Change'}{b.count > 1 ? <span class="pill" style="margin-left:6px">{b.count}</span> : null}</div>
                <div class="s">{when(b.ts)}{b.undone ? ' · undone' : ''}</div>
              </div>
              {!b.undone && <button style="min-height:34px;padding:5px 10px" onClick={async () => { if (!(await confirmUndo(b.label))) return; const n = await undoBatch(b.batch); ui.toast(`Undid ${n} change${n === 1 ? '' : 's'}`); refresh(); }}>Undo</button>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function FullReset() {
  const ui = useUI();
  const [open, setOpen] = useS(false);
  const [word, setWord] = useS('');
  const [busy, setBusy] = useS(false);
  const go = async () => {
    if (word !== 'YES') return;
    setBusy(true);
    try {
      const r = await apiFetch('/api/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'YES' }) });
      if (!r.ok) throw new Error('Server refused: ' + r.status);
      const j = await r.json();
      await Promise.all(TABLES.map(t => db[t].clear())); await db.outbox.clear(); await db.meta.clear(); await db.history.clear();
      try { localStorage.removeItem('budget.lastSeenMonth'); } catch {}
      await tell('Everything erased. A backup was saved on the server at:\n' + j.backup + '\n\nThe app will reload empty. Use Import JSON to load your layout.', { title: 'Erased' });
      reloadApp();
    } catch (e) { ui.toast(e.message); setBusy(false); }
  };
  return open ? (
    <div class="col" style="gap:8px;padding:10px;border-radius:10px;background:var(--neg-bg)">
      <b class="neg">Erase everything on the server and this device?</b>
      <span class="head">Deletes all accounts, transactions, categories, groups, budgets, scheduled items and rules for this household. Other phones will pick up the empty state on their next sync. A backup copy of the database is written first to <code>data/backups/</code>.</span>
      <label class="head">Type YES to confirm<input value={word} onInput={e => setWord(e.target.value)} placeholder="YES" autoFocus /></label>
      <div class="row"><button class="primary" style="background:var(--neg)" disabled={word !== 'YES' || busy} onClick={go}>{busy ? 'Erasing…' : 'Erase everything'}</button><button class="ghost" onClick={() => { setOpen(false); setWord(''); }}>Cancel</button></div>
    </div>
  ) : <button class="ghost neg" onClick={() => setOpen(true)}>Erase everything (server + device)…</button>;
}

function LocalReset() {
  const [open, setOpen] = useS(false);
  const [word, setWord] = useS('');
  const go = async () => {
    if (word !== 'YES') return;
    await Promise.all(TABLES.map(t => db[t].clear())); await db.outbox.clear(); await db.meta.clear(); await db.history.clear();
    try { localStorage.removeItem('budget.lastSeenMonth'); } catch {}
    reloadApp();
  };
  return open ? (
    <div class="col" style="gap:8px;padding:10px;border-radius:10px;background:var(--neg-bg)">
      <b class="neg">Erase everything on this phone?</b>
      <span class="head">Deletes all accounts, transactions, categories, budgets, scheduled items and rules. There is no server copy in offline mode, so export a JSON backup first if you might want any of it back. The app restarts with the starter categories.</span>
      <label class="head">Type YES to confirm<input value={word} onInput={e => setWord(e.target.value)} placeholder="YES" autoFocus /></label>
      <div class="row"><button class="primary" style="background:var(--neg)" disabled={word !== 'YES'} onClick={go}>Erase everything</button><button class="ghost" onClick={() => { setOpen(false); setWord(''); }}>Cancel</button></div>
    </div>
  ) : <button class="ghost neg" onClick={() => setOpen(true)}>Erase everything…</button>;
}

/**
 * Your own server (Android app only, opt-in). Offline: enter addresses, test, connect.
 * Connected: shows where it syncs, sign in again, disconnect.
 */
function ServerCard({ data }) {
  const ui = useUI();
  const local = isLocal();
  const [cfg, setCfg] = useS(null);
  const [form, setForm] = useS({ home: '', away: '', cfClientId: '', cfClientSecret: '' });
  const [test, setTest] = useS(null);
  const [busy, setBusy] = useS('');
  const [choice, setChoice] = useS(null);   // { boot, phone } when both sides hold data
  const [pickFrom, setPickFrom] = useS(null);   // { main, list } when the server has several budgets
  const [open, setOpen] = useS(false);
  const [pairOpen, setPairOpen] = useS(false);
  const [pf, setPf] = useS({ url: '', code: '' });
  useEffect(() => { serverSettings().then(c => { setCfg(c); setForm(f => ({ ...f, home: c.home, away: c.away, cfClientId: c.cfClientId })); }).catch(() => {}); }, []);
  const [myName, setMyName] = useS('');
  useEffect(() => { if (hasBudgets()) listBudgets().then(r => setMyName((r.list.find(b => b.id === r.active) || {}).name || '')).catch(() => {}); }, []);
  // Instructions left by Choose a budget (Put on your server / Make offline); functions below exist by the time this runs.
  useEffect(() => {
    if (!cfg) return;
    const act = takePendingAction();
    if (act === 'online' && local) putOnline();
    if (act === 'offline' && !local) goOffline();
  }, [!!cfg]);
  // A pairing link (QR scanned with the phone's camera) handed over by main.jsx.
  useEffect(() => {
    if (!cfg) return;
    const take = () => { const p = window.__pendingPair; if (!p) return; window.__pendingPair = null; doPair(p.u, p.c, p.a, true); };
    take(); addEventListener('budget:pair', take);
    return () => removeEventListener('budget:pair', take);
  }, [!!cfg]);
  if (!cfg) return null;
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));
  /** Pair with the server's one-time code, then carry on with the usual connect steps. */
  async function doPair(url, code, away, fromLink) {
    if (!url || !/\d{6}/.test((code || '').replace(/\D/g, ''))) return ui.toast('Enter the server address and the 6-digit code from its Pair a phone page');
    if (fromLink && !(await ask(`Connect ${myName ? `"${myName}"` : 'this budget'} to your server at ${url}?`, { title: 'Pair with your server', ok: 'Connect' }))) return;
    setBusy('Pairing…');
    try {
      const r = await pairServer(url.trim(), code.replace(/\D/g, ''), away);
      setForm(f => ({ ...f, home: r.home, away: r.away })); setCfg(c => ({ ...c, home: r.home, away: r.away }));
      setPairOpen(false);
      // Already connected (for example through Cloudflare): pairing only adds the home address and
      // this phone's key, so it also syncs at home. Nothing else about the connection changes.
      if (!local) { setBusy(''); sync(); return ui.toast(r.home ? `Paired. This phone now also syncs at home (${r.home})` : 'Paired'); }
      await connect(undefined, { paired: true });
    } catch (e) { setBusy(''); ui.toast(e.message); }
  }

  const save = (serverBudget) => {
    const s = { home: form.home, away: form.away, cfClientId: form.cfClientId };
    if (serverBudget !== undefined) s.serverBudget = serverBudget;
    if (form.cfClientSecret) s.cfClientSecret = form.cfClientSecret;
    if (!form.cfClientId) s.cfClientSecret = '';
    return saveServerSettings(s).then(r => { setForm(f => ({ ...f, home: r.home, away: r.away })); return r; });
  };
  // Home refuses this phone but away (Cloudflare) works: on a password-mode server that just means
  // this phone has no key for home yet. Ask for a pairing code through Cloudflare and pair at home.
  const pairHome = async t => {
    if (!hasPairing() || !form.home || ![401, 403].includes(t?.home?.status) || t?.away?.status !== 200) return t;
    setBusy('Pairing this phone with your home address…');
    try {
      const r = await apiFetch('/api/pair-code', { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.code) return t;   // a Cloudflare-only server: the refusal message explains
      const p = await pairServer(form.home, j.code, form.away);
      setForm(f => ({ ...f, home: p.home, away: p.away })); setCfg(c => ({ ...c, home: p.home, away: p.away }));
      ui.toast('Paired. This phone now also syncs at home');
      sync();
      return await testServer();
    } catch (e) { ui.toast(e.message); return t; }
  };
  const runTest = async () => {
    setBusy('Testing…'); setTest(null);
    try { await save(); setTest(await pairHome(await testServer())); } catch (e) { ui.toast(e.message); }
    setBusy('');
  };
  const doSignIn = async how => {
    if (how === 'browser') setBusy('Finish signing in in your browser, then come back here…');
    const r = await (how === 'browser' ? browserSignIn() : signIn()).catch(e => ({ ok: false, message: e.message }));
    setBusy('');
    if (!r.ok && r.message) ui.toast(r.message);
    else if (r.ok && r.email) ui.toast('Signed in as ' + r.email);
    runTest();
  };
  const SignInButtons = ({ again }) => (
    <>
      <button onClick={() => doSignIn('browser')}>{again ? 'Sign in again' : 'Sign in'} with browser</button>
      <button class="ghost" onClick={() => doSignIn('app')}>{again ? 'Sign in again' : 'Sign in'} here</button>
    </>
  );
  const finish = async msg => { await tell(msg, { title: 'Connected' }); reloadApp(); };
  /** pick: which server budget to sync with ('' = your main one); asked when the server has several. */
  const connect = async (pick, opts = {}) => {
    setBusy('Connecting…');
    try {
      if (!opts.paired) await save(pick);   // just paired: the shell already saved the addresses and key
      // Check the addresses first (also covers a sign-in that just reloaded the page).
      const t = await testServer(); setTest(t);
      if (!['home', 'away'].some(k => t[k]?.status === 200)) {
        setBusy('');
        return ui.toast(t.away?.needsLogin ? 'Sign in to your away address first' : 'Couldn\'t reach your server. Check the addresses and tap Test.');
      }
      if (pick === undefined && hasServerBudgets()) {
        const sb = await serverBudgets().catch(() => null);
        if (sb && (sb.list.length > 1 || budgetId() !== 'main')) { setPickFrom(sb); setBusy(''); return; }
      }
      setPickFrom(null);
      const boot = await serverData();
      const phone = await localData();
      const phoneReal = hasRealData(phone), serverReal = hasRealData(boot.data);
      if (phoneReal && serverReal) { setChoice({ boot, phone }); setBusy(''); return; }
      if (!phoneReal) {
        if (!(await ask('Load the budget from your server onto this phone?', { ok: 'Load it' }))) return setBusy('');
        await useServer(boot);
        return finish('Connected. This phone now syncs with your server.');
      }
      if (!(await ask("Upload this phone's budget to your server? A safety copy is kept on the phone first.", { ok: 'Upload' }))) return setBusy('');
      await merge(boot, phone);
      finish('Connected. Your budget is uploading to the server now.');
    } catch (e) { ui.toast(e.message); setBusy(''); }
  };
  const pick = async how => {
    setBusy('Connecting…');
    try {
      if (how === 'server') { await useServer(choice.boot); finish('Connected. This phone now shows the server\'s budget. Its old budget was saved inside the app first.'); }
      else { const m = await merge(choice.boot, choice.phone); finish(`Connected and merged (${m.categories} categories and ${m.accounts} accounts matched by name). Check Money check for any duplicate transactions.`); }
    } catch (e) { ui.toast(e.message); setBusy(''); }
  };
  // This budget's name (for a new server budget), and instructions left by Choose a budget.
  const newOnServer = async () => {
    setBusy('Creating the budget on your server…');
    try {
      // Look the name up now: on an automatic "Put on your server" this runs before myName has loaded.
      const name = myName || (await listBudgets().then(r => (r.list.find(b => b.id === r.active) || {}).name).catch(() => '')) || 'New budget';
      const b = await createServerBudget(name); setPickFrom(null); await connect(b.id);
    }
    catch (e) { setBusy(''); ui.toast(e.message); }
  };
  const putOnline = async () => {
    setOpen(true); setBusy('Checking your server…');
    const t = await testServer().catch(() => ({})); setTest(t);
    if (!['home', 'away'].some(k => t[k]?.status === 200)) {
      setBusy('');
      return tell(t.away?.needsLogin ? 'Your server needs a sign-in first. Tap Sign in below, then Connect.' : "Couldn't reach your server, so this budget is still offline. Try again when you're connected, or check the addresses below.", { title: 'Put on your server' });
    }
    await newOnServer();
  };

  const goOffline = async () => {
    if (!(await ask('Stop syncing and go back to offline mode? Your budget stays on this phone. Changes made offline are uploaded the next time you connect.', { title: 'Disconnect', ok: 'Disconnect' }))) return;
    await disconnect();
    reloadApp();
  };

  const Status = ({ name, r }) => !r ? null : (
    <div class="row between"><span>{name}</span><span class="row">
      <span class={'dot ' + (r.status === 200 ? 'green' : r.needsLogin ? 'amber' : 'red')} />
      {r.status === 200 ? `OK · v${r.version || '?'}${r.user ? ' · ' + r.user : ''}` : r.needsLogin ? 'Needs sign-in' : r.status === 401 || r.status === 403 ? 'Refused' : r.status ? `Error ${r.status}` : (r.error || 'Unreachable')}
    </span></div>
  );
  const anyOk = test && ['home', 'away'].some(k => test[k]?.status === 200);
  const needsLogin = test?.away?.needsLogin;

  const fields = (
    <>
      <label>Home address <span class="head">(on your Wi-Fi)</span>
        <input value={form.home} onInput={set('home')} placeholder="192.168.1.10:8085" autocapitalize="off" inputMode="url" /></label>
      <label>Away address <span class="head">(optional, from anywhere)</span>
        <input value={form.away} onInput={set('away')} placeholder="https://budget.example.com" autocapitalize="off" inputMode="url" /></label>
      <details>
        <summary class="head" style="cursor:pointer">Cloudflare service token (optional)</summary>
        <span class="head">Instead of signing in: create a service token in Cloudflare Zero Trust, allow it in your Access policy (Service Auth), and enter it here. It never expires, but changes are recorded as "local" rather than under your email.</span>
        <label>Client ID<input value={form.cfClientId} onInput={set('cfClientId')} autocapitalize="off" /></label>
        <label>Client secret<input type="password" value={form.cfClientSecret} onInput={set('cfClientSecret')} placeholder={cfg.hasSecret ? 'saved, type to replace' : ''} autocapitalize="off" /></label>
      </details>
      {test && <div class="col" style="gap:4px"><Status name="Home" r={test.home} /><Status name="Away" r={test.away} /></div>}
      {[401, 403].includes(test?.home?.status) && <span class="head neg">Your server refused the home address: it's set to require a Cloudflare sign-in on every request (<code>AUTH_MODE=cloudflare</code>), and requests on your own network don't pass through Cloudflare. {test?.away?.status === 200 ? 'The app will use your away address instead, even at home. ' : ''}To use both, set <code>AUTH_MODE=password</code> on the server and keep its Cloudflare settings: Cloudflare sign-ins keep working away, and at home you pair this phone with a code (see the manual, "Home and Cloudflare together"). Or clear the home address here.</span>}
      {test?.away?.needsLogin && <span class="head">Your away address needs a Cloudflare sign-in. <b>Sign in with browser</b> works with every login type, including Google. <b>Sign in here</b> works with email codes, GitHub and similar, but not Google.</span>}
    </>
  );

  if (pickFrom) return (
    <div class="card form" id="server">
      <span class="eyebrow">Your own server</span>
      <b>Which budget on your server should this one sync with?</b>
      <button class="primary" onClick={newOnServer}>New budget on the server{myName ? `: ${myName}` : ''}<br /><span class="head" style="color:inherit">This budget is uploaded into it</span></button>
      {pickFrom.list.map(b => (
        <button key={b.id} onClick={() => connect(b.id === pickFrom.main ? '' : b.id)}>{b.name}{b.id === pickFrom.main ? ' (main)' : ''}<br /><span class="head">{b.accounts} accounts · {b.transactions} transactions</span></button>
      ))}
      <button class="ghost" onClick={() => setPickFrom(null)}>Cancel</button>
    </div>
  );

  if (choice) return (
    <div class="card form" id="server">
      <span class="eyebrow">Your own server</span>
      <b>Both this phone and your server have a budget</b>
      <span class="head">A safety copy of this phone's budget is saved inside the app first, whichever you pick.</span>
      <button class="primary" disabled={!!busy} onClick={() => pick('server')}>Use the server's budget<br /><span class="head" style="color:inherit">This phone's budget is replaced</span></button>
      <button disabled={!!busy} onClick={() => pick('merge')}>Merge both<br /><span class="head">Adds this phone's accounts and transactions to the server's</span></button>
      <button class="ghost" onClick={() => setChoice(null)}>Cancel, stay offline</button>
    </div>
  );

  if (local) return (
    <div class="card form" id="server">
      <span class="eyebrow">Your own server (optional) <Help k="server" /></span>
      <span class="head">Sync this budget with a Once Budget server you run yourself (Docker), and get new features from it without updating the app. You decide how the server is protected; RightToOwn never sees your data.</span>
      {hasPairing() && !open && (pairOpen ? (
        <div class="col" style="gap:8px">
          <span class="head">On your server's web page, open <b>Pair a phone</b>. Scan its QR code with this phone's camera app, or type the address and code here.</span>
          <div class="field"><span class="lbl">Address</span><input value={pf.url} onInput={e => setPf({ ...pf, url: e.target.value })} placeholder="http://192.168.1.10:8085" inputMode="url" autocapitalize="off" /></div>
          <div class="field"><span class="lbl">Code</span><input value={pf.code} onInput={e => setPf({ ...pf, code: e.target.value })} placeholder="123 456" inputMode="numeric" maxLength={7} /></div>
          <div class="row"><button class="primary" disabled={!!busy} onClick={() => doPair(pf.url, pf.code)}>{busy || 'Pair'}</button><button class="ghost" onClick={() => setPairOpen(false)}>Cancel</button></div>
        </div>
      ) : <button class="primary" onClick={() => setPairOpen(true)}>Pair with a code</button>)}
      {!open ? <button onClick={() => setOpen(true)}>{hasPairing() ? 'Set up by address instead…' : 'Set up a server…'}</button> : (
        <>
          {fields}
          <div class="row" style="flex-wrap:wrap">
            <button onClick={runTest} disabled={!!busy || (!form.home && !form.away)}>Test</button>
            {needsLogin && <SignInButtons />}
            <button class="primary" onClick={() => connect()} disabled={!!busy || (!form.home && !form.away)}>Connect</button>
          </div>
          {busy && <span class="head">{busy}</span>}
          {anyOk && !busy && <span class="head pos">Your server answered. Tap <b>Connect</b> to bring your budget onto this phone.</span>}
        </>
      )}
    </div>
  );

  return (
    <div class="card form" id="server">
      <span class="eyebrow">Your own server</span>
      <span class="head">Syncing with {[cfg.home, cfg.away].filter(Boolean).join(' · ')}. Home is used when it answers; away otherwise.</span>
      {hasPairing() && !open && (pairOpen ? (
        <div class="col" style="gap:8px">
          <span class="head">On your server's web page, open <b>Pair a phone</b>. Scan its QR code with this phone's camera app, or type the address and code here.</span>
          <div class="field"><span class="lbl">Address</span><input value={pf.url} onInput={e => setPf({ ...pf, url: e.target.value })} placeholder="http://192.168.1.10:8085" inputMode="url" autocapitalize="off" /></div>
          <div class="field"><span class="lbl">Code</span><input value={pf.code} onInput={e => setPf({ ...pf, code: e.target.value })} placeholder="123 456" inputMode="numeric" maxLength={7} /></div>
          <div class="row"><button class="primary" disabled={!!busy} onClick={() => doPair(pf.url, pf.code)}>{busy || 'Pair'}</button><button class="ghost" onClick={() => setPairOpen(false)}>Cancel</button></div>
        </div>
      ) : <button onClick={() => setPairOpen(true)}>{cfg.home ? 'Pair again with a code' : 'Pair with a code (to sync at home too)'}</button>)}
      {!open ? <button onClick={() => setOpen(true)}>Change addresses / test…</button> : (
        <>
          {fields}
          <div class="row" style="flex-wrap:wrap">
            <button onClick={runTest} disabled={!!busy}>Save &amp; test</button>
            {(needsLogin || cfg.away) && <SignInButtons again />}
          </div>
          {busy && <span class="head">{busy}</span>}
        </>
      )}
      <button class="ghost" onClick={goOffline}>Disconnect (back to offline mode)</button>
    </div>
  );
}

/** Automatic backups on the phone: the last 14 days used, optionally copied to a folder. */
function AutoBackups() {
  const ui = useUI();
  const [list, setList] = useS(null);
  const [folder, setFolder] = useS(null);
  const [pick, setPick] = useS('');
  const [last, setLast] = useS(lastAutoBackup());
  const [on, setOn] = useS(autoBackupOn());
  const synced = !isLocal();
  const load = () => { listAutoBackups().then(setList).catch(() => setList([])); backupFolder().then(setFolder).catch(() => {}); setLast(lastAutoBackup()); };
  useEffect(load, []);
  const when = ms => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const day = d => new Date(d + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const now = async () => { const r = await autoBackup(true); load(); ui.toast(r?.folderError ? 'Saved on the phone. ' + r.folderError : r ? 'Backed up' + (r.folder ? ' (also to ' + r.folder + ')' : '') : 'Backup failed'); };
  const restore = async () => {
    if (!pick) return;
    if (!(await ask(`Put this budget back exactly as it was on ${day(pick)}?

Everything changed since then is undone. You can reverse the restore with Undo or under History.`, { title: 'Restore backup', ok: 'Restore', danger: true }))) return;
    try { const n = await restoreAutoBackup(pick); ui.toast(`Restored ${day(pick)} (${n} rows)`); setPick(''); }
    catch (e) { ui.toast(e.message); }
  };
  return (
    <div class="card form" id="auto-backups">
      <span class="eyebrow">Automatic backups <Help k="backups" /></span>
      {synced && <label class="toggle"><input type="checkbox" checked={on} onChange={e => { setAutoBackupOn(e.target.checked); setOn(e.target.checked); if (e.target.checked) autoBackup().then(load); }} /> <span>Also back up on this phone</span></label>}
      <span class="head">{synced && !on
        ? 'This budget syncs with your server, which backs it up every night and keeps 14 days, so copies on the phone are optional. Switch this on for an extra copy here (or in a folder).'
        : <>Once Budget saves a copy of this budget each day you use it and keeps the last 14. {last ? `Last backup: ${when(last.at)}.` : 'The first one is made shortly after you open it.'}</>}</span>
      {last?.folderError && <div class="warn amber"><span>Couldn't copy to your backup folder: {last.folderError}</span></div>}
      <div class="row" style="flex-wrap:wrap">
        <button onClick={now}>Back up now</button>
        {list && list.length > 0 && <Select aria-label="Backup to restore" value={pick} onChange={e => setPick(e.target.value)} style="flex:1;min-width:150px">
          <option value="">Restore from…</option>
          {list.map(b => <option value={b.date}>{day(b.date)} · {Math.max(1, Math.round(b.size / 1024))} KB</option>)}
        </Select>}
        {pick && <button class="primary" onClick={restore}>Restore</button>}
      </div>
      <span class="eyebrow" style="margin-top:6px">Also copy to a folder</span>
      {folder?.set
        ? <><span class="head">Copies go to <b>{folder.name}</b> too, as "Budget - name - date.json", also keeping 14.</span>
            <div class="row"><button onClick={async () => { const r = await pickBackupFolder(); if (r?.set) { setFolder(r); autoBackup(true).then(load); } }}>Change folder</button><button class="ghost" onClick={async () => setFolder(await clearBackupFolder())}>Stop copying</button></div></>
        : <><span class="head">Copies on this phone are lost if the phone is. Choose a folder that Google Drive syncs, or an SD card, so a copy lives somewhere else. Android asks you once. No permission needed.</span>
            <button onClick={async () => { const r = await pickBackupFolder(); if (r?.set) { setFolder(r); const b = await autoBackup(true); load(); ui.toast(b?.folderError ? b.folderError : 'Backing up to ' + r.name); } }}>Choose a folder…</button></>}
    </div>
  );
}

/** Hide balances (everywhere) and app lock (Android app). */
function Privacy() {
  const ui = useUI();
  const [hide, setHide] = useS(moneyHidden());
  const [lk, setLk] = useS(null);
  useEffect(() => { if (hasAppLock()) lockSettings().then(setLk).catch(() => {}); }, []);
  const change = async s => { try { setLk({ ...lk, ...(await setLock(s)) }); } catch (e) { ui.toast(e.message); } };
  return (
    <div class="card form" id="privacy-settings">
      <span class="eyebrow">Privacy</span>
      <label class="toggle"><input type="checkbox" checked={hide} onChange={e => { setMoneyHidden(e.target.checked); setHide(e.target.checked); }} /> <span>Hide balances</span></label>
      <span class="head">Blurs every amount until you switch it off (also the eye button at the top). Press and hold an amount to peek.</span>
      {lk && <>
        <label class="toggle"><input type="checkbox" checked={lk.enabled} disabled={!lk.available && !lk.enabled} onChange={e => change({ enabled: e.target.checked })} /> <span>Lock with your phone's screen lock</span></label>
        <span class="head">{lk.available ? 'Opening Once Budget asks for your fingerprint, face or PIN, the same as unlocking your phone. No extra permission needed.' : 'Set up a fingerprint, PIN or pattern in Android settings to use this.'}</span>
        {hasWidget() && <>
          <span class="head">The home-screen widget shows •••• instead of amounts while Hide balances or the lock is on.</span>
          <button onClick={async () => { const r = await pinWidget().catch(() => null); if (!r?.ok) ui.toast('Long-press your home screen, tap Widgets and find Budget'); }}>Add Budget to your home screen</button>
        </>}
        {lk.enabled && <label>Lock after<Select value={lk.after} onChange={e => change({ after: Number(e.target.value) })}>
          <option value={0}>Leaving the app</option><option value={60}>1 minute away</option><option value={300}>5 minutes away</option>
        </Select></label>}
      </>}
    </div>
  );
}

function TapFeedback() {
  const [on, setOn] = useS(tapHaptics());
  return (
    <div class="card form">
      <span class="eyebrow">Feel</span>
      <label class="toggle"><input type="checkbox" checked={on} onChange={e => { setTapHaptics(e.target.checked); setOn(e.target.checked); }} /> <span>Vibrate on tap (this device)</span></label>
      {isNative && <span class="head">Uses your phone's touch feedback, so it also follows Android's Settings › Sound &amp; vibration › Touch feedback.</span>}
    </div>
  );
}

/** Bill reminders in the app: a daily check on this phone (Reminders.kt), offline or connected. */
function AppReminders({ data }) {
  const ui = useUI();
  const [s, setS] = useS(reminderSettings());
  const [notify, setNotify] = useS(true);
  useEffect(() => { captureAccess().then(st => setNotify(!!st.notify)).catch(() => {}); }, []);
  const due = data.scheduled.filter(x => !x.auto && !x.deleted).length;
  const update = async patch => {
    const n = { ...s, ...patch };
    if (n.enabled && !notify) {
      const r = await requestNotifications().catch(() => null);
      if (!r?.granted) { ui.toast('Allow notifications for Budget to get reminders'); return; }
      setNotify(true);
    }
    setS(n); await saveReminderSettings(data, n);
    if (patch.enabled !== undefined) ui.toast(n.enabled ? `Reminders on, around ${hourLabel(n.hour)}` : 'Reminders off');
  };
  const hourLabel = h => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' });
  return (
    <div class="card form">
      <span class="eyebrow">Reminders</span>
      <span class="head">A notification the morning a scheduled bill is due ({due === 1 ? 'you have 1 scheduled item' : `you have ${due} scheduled items`} that wait for you to post {due === 1 ? 'it' : 'them'}). Checked on this phone, so it works offline too.</span>
      <div class="row" style="flex-wrap:wrap">
        <button class={s.enabled ? '' : 'primary'} onClick={() => update({ enabled: !s.enabled })}>{s.enabled ? 'Turn off' : 'Turn on reminders'}</button>
        <Select value={s.hour} onChange={e => update({ hour: Number(e.target.value) })} aria-label="Reminder time">
          {[6, 7, 8, 9, 10, 11, 12].map(h => <option value={h}>Around {hourLabel(h)}</option>)}
        </Select>
        {s.enabled && <button class="ghost" onClick={() => testReminder().then(r => ui.toast(r.due ? `${r.due} due today: notification sent` : 'Test notification sent'))}>Send test</button>}
      </div>
    </div>
  );
}

/** Tap-to-pay capture: needs Android notification access (to read Google Wallet) and permission to post our prompt. */
function TapToPay() {
  const ui = useUI();
  const [st, setSt] = useS(null);
  const [budgets, setBudgets] = useS(null);
  const [target, setTarget] = useS(hasCaptureBudget() ? captureBudget() : null);
  useEffect(() => { if (hasCaptureBudget()) listBudgets().then(r => setBudgets(r.list)).catch(() => {}); }, []);
  const load = () => captureAccess().then(setSt).catch(() => setSt(null));
  useEffect(() => {
    load();
    const f = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', f);
    return () => document.removeEventListener('visibilitychange', f);
  }, []);
  if (!st) return null;
  return (
    <div class="card form" id="taptopay">
      <span class="eyebrow">Tap-to-pay capture <Help k="taptopay" /></span>
      <span class="head">When you pay with Google Wallet, the app reads Wallet's payment notification (merchant, amount, card) and asks if you want to log it. It only looks at Google Wallet; every other notification is ignored. Nothing leaves this phone.</span>
      {budgets && budgets.length > 1 && (
        <label>Purchases go to
          <Select value={target} onChange={async e => { const id = e.target.value; await setCaptureBudget(id); setTarget(id); ui.toast(`Tap-to-pay purchases now go to ${budgets.find(b => b.id === id)?.name}`, { plain: true }); }}>
            {budgets.map(b => <option value={b.id}>{b.name}</option>)}
          </Select>
          <span class="head">Only that budget shows them, and tapping a purchase prompt opens it there.</span>
        </label>
      )}
      <div class="row between"><span>Read Wallet notifications</span><span class="row"><span class={'dot ' + (st.listener ? 'green' : 'grey')} /> {st.listener ? 'On' : 'Off'}</span></div>
      <div class="row between"><span>Prompt me after a purchase</span><span class="row"><span class={'dot ' + (st.notify ? 'green' : 'grey')} /> {st.notify ? 'On' : 'Off'}</span></div>
      <div class="row" style="flex-wrap:wrap">
        <button class={st.listener ? '' : 'primary'} onClick={() => openCaptureSettings()}>{st.listener ? 'Turn off in Android settings' : 'Turn on'}</button>
        {!st.notify && <button onClick={async () => { const r = await requestNotifications().catch(() => null); if (r && !r.granted) ui.toast('Allow notifications for Budget in Android settings'); load(); }}>Allow prompts</button>}
      </div>
      {st.listener && !st.notify && <span class="head">Without prompts, purchases still wait in a banner at the top of the app.</span>}
      {st.listener && !st.batteryUnrestricted && (
        <div class="col" style="gap:6px;padding:10px;border-radius:10px;background:var(--chip)">
          <b>Keep capture running</b>
          <span class="head">Some phones stop apps when you swipe them away, and a purchase made in the next few seconds can be missed. In App info, open <b>Battery</b> and choose <b>Unrestricted</b> (or allow background activity). The app does no background work of its own, so this costs almost no battery: it only wakes when a notification arrives.</span>
          <button onClick={() => openAppDetails()}>Open App info</button>
        </div>
      )}
      {st.listener && st.hiddenSeen && (
        <div class="col" style="gap:6px;padding:10px;border-radius:10px;background:var(--chip)">
          <b>Android hid a purchase's details</b>
          <span class="head">Android hides notification text it thinks is a one-time security code, and a four-digit number on its own can look like one: a store number ("SHOP 2468") or a card ending ("•••• 5555"). The app still asks you to log the purchase; tap <b>See amount in Google Wallet</b> in Quick add to read it. On some phones, turning off <b>Enhanced notifications</b> (or <b>Adaptive notifications</b>) stops the hiding; on others Android always does it and there's no setting to change.</span>
          <button onClick={() => openNotificationSettings()}>Open notification settings</button>
        </div>
      )}
      {!st.listener && <span class="head">If Android says "Restricted setting", open App info for Budget, tap ⋮ → Allow restricted settings, then come back and tap Turn on.</span>}
      {st.listener && <WalletLog />}
    </div>
  );
}

/** The last few raw Wallet notifications, for checking the parser against real wording. Device-only. */
function WalletLog() {
  const [log, setLog] = useS(null);
  return (
    <details onToggle={e => { if (e.target.open) captureLog().then(setLog).catch(() => setLog([])); }}>
      <summary class="head" style="cursor:pointer">Recent Wallet notifications (for troubleshooting)</summary>
      {log === null ? null : !log.length ? <p class="head">None yet. Pay with Google Wallet and they'll show here.</p> : (
        <div class="col" style="gap:6px;margin-top:6px">
          {log.slice().reverse().map(e => (
            <div class="col" style="font-size:12px;border-left:3px solid var(--line);padding-left:8px">
              <span class="head">{new Date(e.at).toLocaleString()} · {e.hidden ? 'details hidden by Android' : e.parsed ? 'captured' : 'not a purchase'}</span>
              <span><b>{e.title}</b></span><span>{e.bigText || e.text}</span>
            </div>
          ))}
        </div>
      )}
    </details>
  );
}

function Integrity() {
  const [r, setR] = useS(null); const [busy, setBusy] = useS(false);
  const load = () => apiFetch('/api/integrity').then(x => x.json()).then(setR).catch(() => {});
  useEffect(() => { load(); }, []);
  const run = async () => { setBusy(true); try { const x = await apiFetch('/api/integrity/run', { method: 'POST' }); setR(await x.json()); } finally { setBusy(false); } };
  return (
    <div class="row between">
      <span>Last verified</span>
      <span class="row">
        {r ? <><span class={'dot ' + (r.ok ? 'green' : 'red')} /> {new Date(r.at || r.checked_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}{r.ok ? ' · OK' : ` · ${r.issues.join('; ')}`}</> : <span class="head">never</span>}
        <button class="ghost" style="min-height:30px;padding:2px 8px;font-size:12px" disabled={busy} onClick={run}>{busy ? '…' : 'Verify now'}</button>
      </span>
    </div>
  );
}

/**
 * Roll card overspending into a payoff category (source/roll-overspending-spec.md). Off until the
 * user turns it on and picks (or creates) the category that holds their card debt.
 */
function RollSetting({ data }) {
  const ui = useUI();
  const s = rollSettings(data);
  const payoff = data.categories.find(c => c.id === s.payoff && !c.deleted);
  const [picking, setPicking] = useS(false);
  const [creating, setCreating] = useS(null);   // { name, group }
  const spendingGroups = data.groups.filter(g => !g.is_income);
  const last = addMonths(ym(), -1);

  const enable = async id => {
    const cat = data.categories.find(c => c.id === id) || { id, name: creating?.name || 'Card payoff' };
    await setPref('payoff_category_id', id);
    await setPref('roll_card_overspending', '1');
    setPicking(false); setCreating(null);
    // Existing overspending from before: offer to roll it now, as one batch per month.
    const start = firstCardMonth(data);
    const already = s.through && s.through >= last;
    const { plan } = start && !already ? planRoll({ ...data, prefs: { ...data.prefs, payoff_category_id: id } }, start, last, id) : { plan: [] };
    const total = plan.reduce((t, p) => t + p.total, 0);
    if (total > 0 && await ask(`Roll existing card overspending now?\n\n${fmt(total)} of past months' card overspending moves into ${cat.name}, and those categories go back to $0. Cash or debit overspending stays where it is.`, { title: 'Existing overspending', ok: 'Roll it', cancel: 'Not now' }))
      await applyRoll(plan, id, cat.name);
    if (!already) await setPref('rolled_through', last);
    ui.toast(`Rolling card overspending into ${cat.name}`, { plain: true });
  };
  const createAndUse = async () => {
    let gid = creating.group;
    if (!gid) gid = (await put('category_groups', { name: 'Debt', sort: data.groups.length, is_income: 0 })).id;
    const c = await put('categories', { group_id: gid, name: creating.name.trim() || 'Card payoff', sort: 999, target: 0, note: '' });
    await enable(c.id);
  };

  return (
    <div class="card form" id="roll">
      <span class="eyebrow">Credit card overspending <Help k="cardroll" /></span>
      <label class="toggle"><input type="checkbox" checked={s.on && !!payoff} onChange={async e => {
        if (e.target.checked) { if (payoff) await enable(payoff.id); else setPicking(true); }
        else { await setPref('roll_card_overspending', '0'); setPicking(false); ui.toast('Card overspending stays in its categories', { plain: true }); }
      }} /> <span>Roll card overspending into a payoff category</span></label>
      <span class="head">At the end of each month, a category that ended overspent because of credit card purchases hands that shortfall to one payoff category, so it starts the new month clean and your card debt sits in one place. Overspending paid with cash or debit isn't rolled: that money is really gone, so it stays red in its category until you cover it.</span>
      {s.on && payoff && !picking && <div class="row between"><span>Rolling into: <b>{payoff.name}</b></span><button class="link" onClick={() => setPicking(true)}>Change</button></div>}
      {s.on && payoff && !picking && <>
        <label class="toggle"><input type="checkbox" checked={data.prefs?.roll_fund_by_plan !== '0'} onChange={e => setPref('roll_fund_by_plan', e.target.checked ? '1' : '0')} /> <span>Pay cards in my debt plan's order</span></label>
        <span class="head">{data.prefs?.roll_fund_by_plan !== '0'
          ? <>Money you assign to {payoff.name} goes to each card's minimum first, then to the next card in your <a href="#/debt" class="link">debt plan</a> ({(data.prefs?.['debt:strategy'] || 'snowball') === 'avalanche' ? 'avalanche: highest rate first' : 'snowball: smallest balance first'}). That's what each card's Ready to pay shows.</>
          : <>Money you assign to {payoff.name} goes to the first card below until its debt there is covered, then the next. Use ▲ ▼ to set the order.</>}</span>
        {data.prefs?.roll_fund_by_plan === '0' && <CardOrder data={data} />}
      </>}
      {picking && !creating && (
        <div class="col" style="gap:6px">
          <b>Which category holds your card debt?</b>
          <CatInput data={data} value={payoff?.id || null} onChange={id => id && enable(id)} spending placeholder="Search categories…" noneLabel="(choose one)" />
          <div class="row"><button onClick={() => setCreating({ name: 'Card payoff', group: (spendingGroups.find(g => /debt/i.test(g.name)) || spendingGroups[0])?.id || '' })}>+ New category…</button><button class="ghost" onClick={() => setPicking(false)}>Cancel</button></div>
        </div>
      )}
      {creating && (
        <div class="col" style="gap:6px">
          <label>Name<input value={creating.name} onInput={e => setCreating({ ...creating, name: e.target.value })} autoFocus /></label>
          <label>Group<Select value={creating.group} onChange={e => setCreating({ ...creating, group: e.target.value })}>
            {spendingGroups.map(g => <option value={g.id}>{g.name}</option>)}
            <option value="">New group "Debt"</option>
          </Select></label>
          <div class="row"><button class="primary" onClick={createAndUse}>Create and use</button><button class="ghost" onClick={() => setCreating(null)}>Back</button></div>
        </div>
      )}
    </div>
  );
}

/** The order cards get payoff-category money in, when it isn't the debt plan's (household_prefs roll_fund_order). */
function CardOrder({ data }) {
  const cards = data.accounts.filter(a => a.type === 'credit' && a.on_budget && !a.closed);
  let pick = []; try { pick = JSON.parse(data.prefs?.roll_fund_order || '[]'); } catch {}
  const bal = id => data.txs.filter(t => t.account_id === id).reduce((s, t) => s + t.amount, 0);
  const rank = id => { const i = pick.indexOf(id); return i < 0 ? 1e9 : i; };
  const list = [...cards].sort((a, b) => rank(a.id) - rank(b.id) || bal(a.id) - bal(b.id));
  const move = (i, d) => { const ids = list.map(a => a.id); [ids[i], ids[i + d]] = [ids[i + d], ids[i]]; setPref('roll_fund_order', JSON.stringify(ids)); };
  if (cards.length < 2) return null;
  return (
    <ol class="cardorder">
      {list.map((a, i) => (
        <li key={a.id} class="row between">
          <span><b>{i + 1}.</b> {a.name} <span class="head">{fmt(bal(a.id))}</span></span>
          <span class="row" style="gap:4px">
            <button class="ghost small" aria-label={`Move ${a.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>▲</button>
            <button class="ghost small" aria-label={`Move ${a.name} down`} disabled={i === list.length - 1} onClick={() => move(i, 1)}>▼</button>
          </span>
        </li>
      ))}
    </ol>
  );
}

function CloseMonths({ data }) {
  const ui = useUI();
  const cur = closedThrough(data);
  const last = addMonths(ym(), -1);
  const opts = []; for (let i = 1; i <= 12; i++) opts.push(addMonths(ym(), -i));
  return (
    <div class="card form">
      <span class="eyebrow">Close months <Help k="closemonths" /></span>
      <span class="head">Closed months are locked: no new or edited transactions dated in them, no assignment changes. Do this after reconciling. Currently closed through <b>{cur ? monthLabel(cur) : 'nothing'}</b>.</span>
      <div class="row" style="flex-wrap:wrap">
        <Select aria-label="Close months through" value={cur || ''} onChange={async e => { const v = e.target.value; await setPref('closed_through', v); ui.toast(v ? `Closed through ${monthLabel(v)}` : 'All months open'); if (v) autoRoll({ ...data, prefs: { ...data.prefs, closed_through: v } }).catch(() => {}); }}>
          <option value="">Nothing closed</option>
          {opts.map(m => <option value={m}>Through {monthLabel(m)}</option>)}
        </Select>
        {cur !== last && <button onClick={async () => { await setPref('closed_through', last); ui.toast(`Closed through ${monthLabel(last)}`); }}>Close {monthLabel(last).split(' ')[0]}</button>}
      </div>
    </div>
  );
}

function Restore() {
  const ui = useUI();
  const [list, setList] = useS(null); const [pick, setPick] = useS(''); const [word, setWord] = useS(''); const [busy, setBusy] = useS(false);
  const load = () => apiFetch('/api/backups').then(r => r.json()).then(setList).catch(() => setList([]));
  const when = ms => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const go = async () => {
    if (word !== 'YES' || !pick) return;
    setBusy(true);
    try {
      const r = await apiFetch('/api/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: pick, confirm: 'YES' }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status);
      await Promise.all(TABLES.map(t => db[t].clear())); await db.outbox.clear(); await db.meta.clear();
      await tell('Restored from ' + pick + '. The state before restoring was saved as a new backup.', { title: 'Restored' }); reloadApp();
    } catch (e) { ui.toast('Restore failed: ' + e.message); setBusy(false); }
  };
  return (
    <div class="col" style="gap:6px">
      {list === null ? <button class="ghost" onClick={load}>Restore from a server backup…</button> : (
        <>
          <span class="head">Nightly snapshots on the server. Restoring replaces everything with the chosen snapshot (the current state is backed up first).</span>
          <Select aria-label="Server backup to restore" value={pick} onChange={e => setPick(e.target.value)}>
            <option value="">Choose a backup…</option>
            {list.map(b => <option value={b.file}>{when(b.mtime)} · {b.counts ? `${b.counts.transactions} tx, ${b.counts.accounts} accts, ${b.counts.categories} cats` : Math.round(b.size / 1024) + ' KB'}</option>)}
          </Select>
          {pick && <label class="head">Type YES to restore<input value={word} onInput={e => setWord(e.target.value)} placeholder="YES" /></label>}
          <div class="row"><button class="primary" style="background:var(--neg)" disabled={!pick || word !== 'YES' || busy} onClick={go}>{busy ? 'Restoring…' : 'Restore'}</button><button class="ghost" onClick={() => { setList(null); setPick(''); setWord(''); }}>Cancel</button></div>
        </>
      )}
    </div>
  );
}

function Reminders() {
  const ui = useUI();
  const [on, setOn] = useS(null); const [busy, setBusy] = useS(false);
  useEffect(() => { pushStatus().then(setOn); }, []);
  const secure = location.protocol === 'https:' || location.hostname === 'localhost';
  return (
    <div class="card form">
      <span class="eyebrow">Reminders</span>
      <span class="head">A notification on this device the morning a scheduled bill is due (items set to wait for Post). Sent at {8}:00 server time; change REMIND_HOUR in the compose file to adjust.</span>
      {!secure ? <span class="head neg">Needs HTTPS — open the app through your Cloudflare address to enable.</span> : (
        <div class="row" style="flex-wrap:wrap">
          {on ? <button onClick={async () => { setBusy(true); await disablePush(); setOn(false); setBusy(false); ui.toast('Reminders off on this device'); }} disabled={busy}>Turn off</button>
              : <button class="primary" onClick={async () => { setBusy(true); try { await enablePush(); setOn(true); ui.toast('Reminders on'); } catch (e) { ui.toast(e.message); } setBusy(false); }} disabled={busy}>Turn on reminders</button>}
          {on && <button class="ghost" onClick={() => apiFetch('/api/push/test', { method: 'POST' }).then(r => r.json()).then(j => ui.toast(j.sent ? 'Test sent' : 'No subscriptions on server'))}>Send test</button>}
        </div>
      )}
    </div>
  );
}
