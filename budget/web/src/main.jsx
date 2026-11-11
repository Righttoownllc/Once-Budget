import { render, createContext } from 'preact';
import { useContext, useEffect, useRef, useState } from 'preact/hooks';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import './app.css';
import { isNative, isLocal, onNative, takeLaunchCapture, exitApp, callNative, hasBudgets, budgetId, listBudgets, peekPendingAction, moneyHidden, setMoneyHidden, takeLaunchPair } from './platform.js';
import { captures, onCaptures, refreshCaptures, captureDraft, captureSummary, sendCaptureHints, logConfirmed, setCaptureData } from './captures.js';
import { reSignIn } from './connect.js';
import { ask, tell, setDialogHost } from './dialog.js';
import { subscribe, bootstrapIfEmpty, sync, syncState, APP_VERSION, CHANGELOG, updateAvailable, historyList, undoBatch, reloadApp, access, canChangeAll, canAddPurchases, dataVersion } from './store.js';
import { loadAll } from './budget.js';
import { watchMilestones } from './fun.js';
import { Budget } from './views/Budget.jsx';
import { Accounts, AccountDetail } from './views/Accounts.jsx';
import { Reports } from './views/Reports.jsx';
import { Settings, HistoryPage } from './views/Settings.jsx';
import { QuickAdd } from './views/QuickAdd.jsx';
import { Scheduled } from './views/Scheduled.jsx';
import { Forecast } from './views/Forecast.jsx';
import { Debt } from './views/Debt.jsx';
import { Recap } from './views/Recap.jsx';
import { YearRecap } from './views/YearRecap.jsx';
import { Setup } from './views/Setup.jsx';
import { Badges } from './views/Fun.jsx';
import { checkBadges } from './achievements.js';
import { sendWidget } from './widget.js';
import { initPullSync } from './pullsync.js';
import './autobackup.js';   // automatic backups (app) start themselves
import { Grid } from './views/Grid.jsx';
import { Report } from './views/Report.jsx';
import { About } from './views/About.jsx';
import { Budgets } from './views/Budgets.jsx';
import { syncReminders } from './reminders.js';

// Any view can open the quick-add sheet: ui.open({ account_id }) or ui.open({ tx }) to edit,
// and show a toast: ui.toast('Saved', { undo: async () => {} }).
export const UI = createContext({ open: () => {}, toast: () => {} });
export const useUI = () => useContext(UI);

/** Every undo asks first: undo buttons and the tappable toast sit where a stray tap lands easily. */
export const confirmUndo = label => ask(`Undo ${label ? `"${label}"` : 'the last change'}?\n\nThis reverses that change.`, { title: 'Undo', ok: 'Undo' });

// ---- Back button handling --------------------------------------------------
// Every sheet/dialog pushes a history entry while open, so the Android back button
// closes it instead of leaving the page. At the root, back shows "press again to exit".
const modalStack = [];
let suppressPop = 0;
/**
 * guard (optional): called before an accidental close (Back, tap outside); return true or a promise
 * of true to allow it. Explicit buttons call onClose directly and skip it.
 */
export function useModal(onClose, guard) {
  const guardRef = useRef(guard);
  guardRef.current = guard;
  useEffect(() => {
    history.pushState({ modal: true }, '');
    onClose.guard = () => (guardRef.current ? guardRef.current() : true);
    modalStack.push(onClose);
    document.body.classList.add('modal-open'); document.documentElement.classList.add('modal-open');
    return () => {
      const i = modalStack.lastIndexOf(onClose);
      if (i >= 0) {
        modalStack.splice(i, 1);
        if (history.state && history.state.modal) { suppressPop++; history.back(); }
      }
      if (!modalStack.length) { document.body.classList.remove('modal-open'); document.documentElement.classList.remove('modal-open'); }
    };
  }, []);
}
document.addEventListener('click', e => {
  if (!(e.target.classList && e.target.classList.contains('scrim') && modalStack.length)) return;
  const top = modalStack[modalStack.length - 1];
  Promise.resolve(top.guard ? top.guard() : true).then(ok => { if (ok && modalStack.includes(top)) top(); });
});
let lastRootPop = 0;
let exitToast = () => {};
addEventListener('popstate', () => {
  if (suppressPop > 0) { suppressPop--; return; }
  // Out of the budget (choosing one): Back must not land back inside it. Deliberate jumps leave the
  // picker through goRoute() first.
  if (pickerActive && location.hash !== '#/budgets') location.replace('#/budgets');
  if (modalStack.length) {
    const top = modalStack[modalStack.length - 1];
    // Back already left the sheet's history entry: put it back, then close only if the sheet agrees.
    history.pushState({ modal: true }, '');
    Promise.resolve(top.guard ? top.guard() : true).then(ok => { if (ok && modalStack.includes(top)) top(); });
    return;
  }
  if (history.state && history.state.root) {
    if (Date.now() - lastRootPop < 2500) { isNative ? exitApp() : history.back(); return; }   // second press: really leave
    lastRootPop = Date.now();
    exitToast();
    history.pushState({ page: true }, '');
  }
});
// History is kept flat: [root, Budget, at most one other screen]. Going from Budget to a screen adds
// one entry; moving between other screens replaces it. So Back from anywhere lands on Budget, and
// Back on Budget asks to exit. Pop-ups add their own entry on top (useModal).
const HOME = '#/budget';
let pendingAdd = false;
if (!history.state || !(history.state.root || history.state.page || history.state.modal || history.state.sub)) {
  const start = location.hash;
  history.replaceState({ root: true }, '', HOME);
  history.pushState({ page: true }, '', HOME);
  if (start === '#/add') pendingAdd = true;   // widget "+" / home-screen shortcut: Quick add over Budget
  else if (start && start !== HOME && start !== '#/' && start !== '#') history.pushState({ sub: true }, '', start);
}
/** Every in-app screen change goes through here (links included, see the click handler below). */
export function nav(h) {
  if (h === '#/add') { pendingAdd = true; dispatchEvent(new Event('budget:add')); return; }   // a sheet, not a screen
  if (!h || h === location.hash) return;
  if (h === HOME && history.state && history.state.sub) { history.back(); return; }   // reuse the Budget entry
  const onHome = (location.hash || HOME) === HOME && !(history.state && history.state.sub);
  if (onHome && h !== HOME) history.pushState({ sub: true }, '', h);
  else history.replaceState(h === HOME ? { page: true } : { sub: true }, '', h);
  dispatchEvent(new HashChangeEvent('hashchange'));
  // A new screen starts at its top (the page itself scrolls, so the last screen's position would carry over).
  requestAnimationFrame(() => { scrollTo(0, 0); document.body.scrollTop = 0; document.documentElement.scrollTop = 0; });
}
document.addEventListener('click', e => {
  if (e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey) return;
  const a = e.target.closest && e.target.closest('a[href^="#/"]');
  if (!a || a.target) return;
  e.preventDefault();
  nav(a.getAttribute('href'));
});
// Warn before closing the tab while changes are still unsynced.
addEventListener('beforeunload', e => { if (syncState.pending > 0 && !window.__appReloading) { e.preventDefault(); e.returnValue = ''; } });

function useHash() {
  const [h, setH] = useState(location.hash || '#/budget');
  useEffect(() => {
    const f = () => setH(location.hash || '#/budget');
    addEventListener('hashchange', f);
    return () => removeEventListener('hashchange', f);
  }, []);
  return h;
}

function useData() {
  const [data, setData] = useState(null);
  useEffect(() => {
    let alive = true, loaded = 0, busy = false, again = false;
    // Reload only when the data changed since the last load, and one load at a time.
    const refresh = () => {
      if (busy) { again = true; return; }
      const v = dataVersion(); if (v === loaded) return;
      busy = true;
      loadAll().then(d => { loaded = v; if (alive) setData(d); }).finally(() => { busy = false; if (again) { again = false; refresh(); } });
    };
    refresh();
    const un = subscribe(refresh);
    return () => { alive = false; un(); };
  }, []);
  return data;
}

/**
 * Leave the open budget for the "Choose a budget" screen. It replaces the page in history, so
 * Back can't step back into the budget; from there Back behaves like the home screen.
 */
let pickerActive = false;
export function openPicker() { pickerActive = true; location.replace('#/budgets'); }
export const setPickerActive = on => { pickerActive = on; };
/** Deliberate navigation (reminder notification, captured purchase): leaves the picker if it's open. */
export function goRoute(hash) { pickerActive = false; nav(hash); }
window.__goRoute = goRoute;   // used by the Android shell for notification taps

/** Hide/show balances (privacy mode). */
function EyeToggle() {
  const [hidden, setHidden] = useState(moneyHidden());
  const flip = () => { setMoneyHidden(!hidden); setHidden(!hidden); };
  return (
    <button class="eye" style="margin-left:auto" onClick={flip} aria-pressed={hidden} aria-label={hidden ? 'Show balances' : 'Hide balances'} title={hidden ? 'Show balances' : 'Hide balances'}>
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />
        {hidden && <path d="M3 3l18 18" />}
      </svg>
    </button>
  );
}

/** Name of the open budget (null until known, or on the web). */
let budgetNameCache = null;
function useBudgetName() {
  const [name, setName] = useState(budgetNameCache);
  useEffect(() => {
    if (!hasBudgets() || budgetNameCache) return;
    listBudgets().then(r => { budgetNameCache = (r.list.find(b => b.id === r.active) || {}).name || null; setName(budgetNameCache); }).catch(() => {});
  }, []);
  return name;
}

/** Dark header (option A) + tab strip; views pass their own header content as `top`. */
/** Inside a dashboard widget, screens render just their content (no header, tabs or banners). */
export const Embedded = createContext(false);

export function Shell({ route, top, children }) {
  if (useContext(Embedded)) return <div class="embed">{children}</div>;
  const [, tick] = useState(0);
  useEffect(() => subscribe(() => tick(x => x + 1)), []);
  const st = connState();
  const bname = useBudgetName();
  // Wide screens: some screens spread their cards over two columns, some just get a wider column.
  // Width follows the screen actually showing (the Budget table and Scheduled pass route="budget"
  // only so the Budget tab stays highlighted).
  const [page = '', sub = ''] = location.hash.split('?')[0].split('/').slice(1);
  const width = page === 'grid' ? ' widefull'
    : (page === 'accounts' && !sub) || ['reports', 'more', 'debt', 'forecast', 'badges'].includes(page) ? ' wide'
    : (page === 'accounts' && sub) || ['scheduled', 'history'].includes(page) ? ' wide1' : '';
  return (
    <div class={'shell' + width}>
      <header class="hdr">
        {top}
        <nav class="tabs">
          {[['budget', 'Budget'], ['accounts', 'Accounts'], ['reports', 'Reports']].map(([r, l]) => (
            <a href={'#/' + r} class={route === r || (r === 'budget' && ['grid', 'scheduled', 'forecast', 'debt', 'badges', 'setup'].includes(route)) ? 'on' : ''}>{l}</a>
          ))}
          <EyeToggle />
          <button class="status" onClick={() => sync()} title={st.detail} aria-label={st.detail}>
            <span class={'dot ' + st.color} /> {st.label}
          </button>
        </nav>
        {!canChangeAll() && <div class="rolebar">{access.role === 'viewer' ? '👀 View only: you can see this budget but not change it' : '🧾 You can add purchases and change the ones you added'}</div>}
        {budgetId() !== 'main' && <a href="#/budgets" class="budgetflag" onClick={e => { e.preventDefault(); openPicker(); }}>📒 {bname || 'Budget'} · tap to switch</a>}
      </header>
      {updateAvailable() && (
        <div class="banner" onClick={applyUpdate}>
          <b>Update ready: v{syncState.serverVersion}</b><span class="head">You're on v{APP_VERSION}. Tap to reload.</span>
        </div>
      )}
      {syncState.needsLogin && (
        // In a browser, reloading the page takes it through the Cloudflare Access login again.
        <div class="banner warn" onClick={() => (isNative ? reSignIn().then(ok => ok && sync()) : reloadApp())}>
          <b>Sign in again to sync</b><span class="head">Your server's sign-in has expired. Your changes are safe on this phone until then. Tap to sign in.</span>
        </div>
      )}
      <CaptureBanner />
      <main class="body">{children}</main>
    </div>
  );
}

/** Tap-to-pay purchases waiting to be logged. Tapping opens the oldest one in Quick add. */
function CaptureBanner() {
  const ui = useContext(UI);
  const [list, setList] = useState(captures());
  useEffect(() => { const un = onCaptures(setList); setList(captures()); return un; }, []);   // catch a refresh that landed before subscribing
  if (!list.length) return null;
  const c = list[0];
  return (
    <div class="banner" onClick={() => ui.openCapture(c)}>
      <b>{list.length === 1 ? 'Log tap-to-pay purchase' : `${list.length} tap-to-pay purchases to log`}{c.shared ? <span class="head"> · caught on another phone</span> : null}</b>
      <span class="head">{captureSummary(c)}</span>
    </div>
  );
}

/** Slim bar at the bottom: a handle that opens the menu, with the last change as a hint. */
const swipe = { y: 0, done: false };
const reduceMotion = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

function BottomBar({ onMenu }) {
  const [last, setLast] = useState(null);
  useEffect(() => {
    let seen = 0;
    const refresh = () => { const v = dataVersion(); if (v === seen) return; seen = v; historyList(5).then(l => setLast(l.find(b => !b.undone && !(b.label || '').startsWith('Undo:')) || null)); };
    refresh(); return subscribe(() => { refresh(); setTimeout(refresh, 400); });
  }, []);
  return (
    // A swipe up on the bar opens the menu too (tap still works).
    <button class="bbar" onClick={onMenu} aria-label="Open menu"
      onTouchStart={e => { swipe.y = e.touches[0].clientY; swipe.done = false; }}
      onTouchMove={e => { if (!swipe.done && swipe.y - e.touches[0].clientY > 24) { swipe.done = true; onMenu(); } }}>
      <span class="grip" />
      <span class="blast">{last ? <><span class="head">Last:</span> {last.label}</> : <span class="head">Menu</span>}</span>
    </button>
  );
}

/** The pull-up menu. */
function Menu({ onClose: done, data }) {
  // Slides up when it opens and back down when it closes (tap outside, Back, an item, or dragging it down).
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false), sheetRef = useRef(null), drag = useRef(null);
  const onClose = () => { if (closingRef.current) return; closingRef.current = true; setClosing(true); setTimeout(done, reduceMotion() ? 0 : 200); };
  useModal(onClose);
  const later = fn => setTimeout(fn, reduceMotion() ? 0 : 220);
  const dragStart = e => { if (sheetRef.current.scrollTop > 0) return; drag.current = { y: e.touches[0].clientY, dy: 0 }; };
  const dragMove = e => {
    if (!drag.current) return;
    drag.current.dy = Math.max(0, e.touches[0].clientY - drag.current.y);
    sheetRef.current.style.transition = 'none';
    sheetRef.current.style.transform = `translateY(${drag.current.dy}px)`;
  };
  const dragEnd = () => {
    if (!drag.current) return;
    const far = drag.current.dy > 90; drag.current = null;
    sheetRef.current.style.transition = ''; sheetRef.current.style.transform = '';
    if (far) onClose();
  };
  const ui = useContext(UI);
  const [last, setLast] = useState(null);
  useEffect(() => { historyList(5).then(l => setLast(l.find(b => !b.undone && !(b.label || '').startsWith('Undo:')) || null)); }, []);
  const go = h => { onClose(); later(() => nav(h)); };
  const undo = async () => { if (!last || !(await confirmUndo(last.label))) return; const n = await undoBatch(last.batch); onClose(); later(() => ui.toast(`Undid: ${last.label}${n > 1 ? ` (${n} rows)` : ''}`)); };
  const Item = ({ h, icon, label, sub }) => (
    <button class="mitem" onClick={() => go(h)}><span class="micon">{icon}</span><span class="col" style="flex:1;text-align:left"><b>{label}</b>{sub && <span class="head">{sub}</span>}</span><span class="muted">›</span></button>
  );
  const due = data ? data.scheduled.filter(s => s.next_date <= new Date().toISOString().slice(0, 10)).length : 0;
  const budgetName = useBudgetName();
  return (
    <div class={'scrim' + (closing ? ' closing' : '')}>
      <div class={'sheet menu' + (closing ? ' closing' : '')} role="dialog" aria-modal="true" aria-label="Menu"
        ref={sheetRef} onTouchStart={dragStart} onTouchMove={dragMove} onTouchEnd={dragEnd}>
        <div class="handle" />
        <button class="mitem" onClick={undo} disabled={!last}><span class="micon">↶</span><span class="col" style="flex:1;text-align:left"><b>Undo</b><span class="head">{last ? last.label : 'Nothing to undo'}</span></span></button>
        <div class="mgrid">
        <Item h="#/grid" icon="▦" label="Budget table" sub="Categories × months" />
        <Item h="#/scheduled" icon="⟳" label="Scheduled" sub={data ? `${data.scheduled.length} recurring${due ? ` · ${due} due` : ''}` : ''} />
        <Item h="#/forecast" icon="📈" label="Payday forecast" sub="Will each account make it to payday?" />
        <Item h="#/debt" icon="⛰" label="Debt payoff planner" sub="Snowball or avalanche, and your debt-free date" />
        <Item h="#/more/rules?open=rules" icon="≡" label="Payee rules" sub={data ? `${data.rules.length} rules` : ''} />
        <Item h="#/reports?review=1" icon="◔" label="Month review" sub="Last month at a glance" />
        <Item h="#/badges" icon="🏅" label="Badges & goals" sub={data ? `${Object.keys(data.prefs || {}).filter(k => k.startsWith('badge:')).length} earned` : ''} />
        <Item h="#/recap" icon="✨" label="Monthly recap" sub="Last month as a story, to keep or share" />
        <Item h="#/more/notifications" icon="🔔" label="Reminders" sub="Due-today notifications" />
        <Item h="#/history" icon="↶" label="History" sub="Every change, undoable" />
        {hasBudgets() && <button class="mitem" onClick={() => { onClose(); later(openPicker); }}><span class="micon">📒</span><span class="col" style="flex:1;text-align:left"><b>Switch budget</b><span class="head">{budgetName ? `Leave ${budgetName} and choose a budget` : 'Choose or add a budget'}</span></span><span class="muted">›</span></button>}
        <Item h="#/more" icon="⚙" label="Settings" sub="Privacy, notifications, budget rules, backups" />
        <Item h="#/about" icon="ⓘ" label="About &amp; privacy" sub="Our rules, permissions, open source" />
        </div>
        <button class="ghost" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

/** One place that turns sync state into a dot colour + short label. */
export function connState() {
  const s = syncState;
  if (isLocal()) return { color: 'green', label: 'On device', detail: 'Offline mode: your budget is stored only on this phone' };
  if (!s.online) return { color: 'grey', label: 'Offline', detail: `Offline · ${s.pending} change${s.pending === 1 ? '' : 's'} saved on this device` };
  if (s.unreachable) return { color: 'red', label: 'No server', detail: 'Online but the budget server is not responding. Changes are saved locally.' };
  if (s.needsLogin) return { color: 'amber', label: 'Sign in', detail: 'Sign in to your server again to sync. Changes are kept on this phone.' };
  if (s.lastError) return { color: 'red', label: 'Error', detail: s.lastError };
  if (s.busy) return { color: 'amber', label: 'Syncing', detail: 'Syncing…' };
  if (s.pending > 0) return { color: 'amber', label: `${s.pending} pending`, detail: `${s.pending} change${s.pending === 1 ? '' : 's'} waiting to sync` };
  if (s.lastSync) return { color: 'green', label: 'Synced', detail: 'Synced ' + new Date(s.lastSync).toLocaleTimeString() };
  return { color: 'grey', label: '…', detail: 'Connecting' };
}

/** Push reminders: subscribe this device (needs HTTPS, so works over Cloudflare, not plain LAN). */
export async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('This browser can\'t do push notifications');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications were blocked');
  const reg = await navigator.serviceWorker.ready;
  const { key } = await (await fetch('/api/push/key')).json();
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(key) });
  await fetch('/api/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sub.toJSON()) });
  return sub;
}
export async function disablePush() {
  const reg = await navigator.serviceWorker?.ready; const sub = await reg?.pushManager.getSubscription();
  if (sub) { await fetch('/api/push/unsubscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }); await sub.unsubscribe(); }
}
export async function pushStatus() {
  try { const reg = await navigator.serviceWorker?.ready; const sub = await reg?.pushManager.getSubscription(); return !!sub; } catch { return false; }
}
function urlB64(s) { const b = atob((s + '='.repeat((4 - s.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, c => c.charCodeAt(0)); }

/** Force the service worker to fetch the new build, activate it, then reload. */
export async function applyUpdate() {
  // In the app: download the server's screens, check them, and restart on them (UiBundles.kt).
  if (isNative) {
    const r = await callNative('ui.update').catch(e => ({ ok: false, message: e.message }));
    if (!r.ok) await tell(r.message, { title: 'Update' });
    else if (r.upToDate) reloadApp();
    return;
  }
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) {
      await reg.update();
      const w = reg.waiting || reg.installing;
      if (w) {
        await new Promise(res => { const t = setTimeout(res, 4000); w.addEventListener('statechange', () => { if (w.state === 'activated') { clearTimeout(t); res(); } }); if (w.state === 'installed') w.postMessage({ type: 'SKIP_WAITING' }); });
      }
    }
  } catch {}
  reloadApp();
}

/** Draws ask()/tell() dialogs (dialog.js) as app-styled cards; Back or a tap outside cancels. */
function DialogHost() {
  const [d, setD] = useState(null);
  useEffect(() => setDialogHost(setD), []);
  if (!d) return null;
  const done = v => { setD(null); d.resolve(v); };
  return <Dialog d={d} done={done} />;
}
function Dialog({ d, done }) {
  useModal(() => done(false));
  return (
    <div class="scrim center">
      <div class="dialog" role="alertdialog" aria-modal="true" aria-label={d.title || 'Once Budget'}>
        {d.title && <b class="dtitle">{d.title}</b>}
        <div class="dmsg">{d.message}</div>
        <div class="row dbtns">
          {d.cancel && <button class="ghost" onClick={() => done(false)}>{d.cancel}</button>}
          <button class={'primary' + (d.danger ? ' danger' : '')} onClick={() => done(true)} autoFocus>{d.ok}</button>
        </div>
      </div>
    </div>
  );
}

const SEEN_KEY = 'budget.seenVersion';
function WhatsNew({ since, onClose }) {
  const entries = CHANGELOG.filter(e => cmpVer(e.version, since) > 0);
  useModal(onClose);
  return (
    <div class="scrim">
      <div class="sheet fitbody" role="dialog" aria-label="What's new">
        <div class="handle" />
        <b>What's new in v{APP_VERSION}</b>
        <div class="grow" style="display:flex;flex-direction:column;gap:10px">
        {entries.slice(0, 3).map(e => (
          <div class="col" key={e.version}>
            <span class="eyebrow">v{e.version} · {e.date}</span>
            <ul style="margin:4px 0 0 18px;padding:0;display:flex;flex-direction:column;gap:3px;font-size:13px">{e.changes.map(c => <li>{c}</li>)}</ul>
          </div>
        ))}
        {entries.length > 3 && <span class="head">…{entries.length - 3} older version{entries.length - 3 === 1 ? '' : 's'} under Settings › About</span>}
        </div>
        <button class="primary" onClick={onClose}>Got it</button>
      </div>
    </div>
  );
}
export const cmpVer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };

function App() {
  const hash = useHash();
  const data = useData();
  const [sheet, setSheet] = useState(null);
  const [whatsNew, setWhatsNew] = useState(null);
  const [toast, setToast] = useState(null);
  useEffect(() => {
    const f = e => showToast(e.detail, { plain: true });
    const quiet = e => { if (e.reason?.limited) e.preventDefault(); };   // already explained by the toast above
    addEventListener('budget:limited', f); addEventListener('unhandledrejection', quiet);
    return () => { removeEventListener('budget:limited', f); removeEventListener('unhandledrejection', quiet); };
  }, []);
  const showToast = (msg, opts = {}) => {
    const id = Date.now();
    // Any toast without its own undo/action becomes "tap to undo the latest change" when one exists.
    if (!opts.undo && !opts.action && !opts.plain) {
      historyList(3).then(l => { const b = l.find(x => !x.undone && !(x.label || '').startsWith('Undo:') && Date.now() - x.ts < 4000); if (b) setToast(t => t && t.id === id ? { ...t, undoBatch: b } : t); });
    }
    setToast({ id, msg, ...opts });
    setTimeout(() => setToast(t => (t && t.id === id ? null : t)), (opts.undo || opts.action) ? 7000 : opts.win ? 4200 : 2500);
  };
  exitToast = () => showToast('Press back again to exit');
  // A conversion started on Choose a budget continues in this budget's Settings (ServerCard).
  useEffect(() => { if (peekPendingAction()) location.replace('#/more/sync'); }, []);
  useEffect(() => {
    bootstrapIfEmpty().catch(e => { syncState.lastError = e.message; });
    try {
      const seen = localStorage.getItem(SEEN_KEY);
      if (seen && seen !== APP_VERSION) setWhatsNew(seen);
      localStorage.setItem(SEEN_KEY, APP_VERSION);
    } catch {}
  }, []);

  const [, routeRaw, arg] = hash.split('/');
  const route = (routeRaw || '').split('?')[0];
  const [menu, setMenu] = useState(false);
  const ui = { open: (opts = {}) => setSheet(opts), close: () => setSheet(null), toast: showToast,
    openCapture: c => { if (!data) return; setPickerActive(false); if (location.hash === '#/budgets') location.replace('#/budget'); setSheet(captureDraft(data, c)); } };
  // Bill reminders run natively; keep the shell's copy of the scheduled items current.
  useEffect(() => { if (isNative && data) syncReminders(data); }, [data]);
  // One-tap logging: keep the phone's category hints current, and log purchases saved from the notification.
  useEffect(() => { if (isNative && data) sendCaptureHints(data); }, [data]);
  // Caught purchases waiting to be logged are shared with the budget (every device shows them).
  useEffect(() => { if (data) setCaptureData(data); }, [data]);
  const dataRef = useRef(data); dataRef.current = data;
  useEffect(() => {
    if (!isNative) return;
    const run = l => dataRef.current && logConfirmed(dataRef.current, l, showToast, tx => setSheet({ tx, tip: true }));
    run(captures());
    return onCaptures(run);
  }, [!!data]);
  // Celebrations and nudges when money moves (fun.js).
  useEffect(() => { watchMilestones(data, showToast); }, [data]);
  // Badges: checked a moment after the numbers settle (each is awarded once, synced).
  useEffect(() => { const t = setTimeout(() => checkBadges(data, showToast), 1500); return () => clearTimeout(t); }, [data]);
  // Tap-to-pay: open the purchase the user tapped in the notification (at launch, or while running).
  const [launchCap, setLaunchCap] = useState(null);
  useEffect(() => {
    if (!isNative) return;
    takeLaunchCapture().then(id => id && setLaunchCap(id)).catch(() => {});
    refreshCaptures();
    return onNative('openCapture', id => { refreshCaptures(); setLaunchCap(id); });
  }, []);
  useEffect(() => {
    if (!launchCap || !data) return;
    refreshCaptures().then(l => { const c = l.find(x => x.id === launchCap); if (c) { setPickerActive(false); location.replace('#/budget'); setSheet(captureDraft(data, c)); } setLaunchCap(null); });
  }, [launchCap, data]);
  // Widget "+" and the home-screen shortcut (#/add): Quick add, without adding a screen to Back.
  useEffect(() => {
    const go = () => { if (!pendingAdd || !dataRef.current) return; pendingAdd = false; setPickerActive(false); if (location.hash === '#/budgets') location.replace('#/budget'); setSheet({}); };
    go();
    addEventListener('budget:add', go);
    return () => removeEventListener('budget:add', go);
  }, [!!data]);
  useEffect(() => initPullSync(showToast), []);
  // Pairing link (budget://pair, from the QR on the server's Pair a phone page): Settings › Sync & server takes it from here.
  useEffect(() => {
    if (!isNative) return;
    const go = p => { if (!p) return; window.__pendingPair = typeof p === 'string' ? JSON.parse(p) : p; goRoute('#/more/sync'); setTimeout(() => dispatchEvent(new Event('budget:pair')), 300); };
    takeLaunchPair().then(go).catch(() => {});
    return onNative('pair', go);
  }, []);
  // Phone: the + button slides away while you scroll down a list and comes back when you scroll up.
  useEffect(() => {
    let lastY = 0;
    const onScroll = () => {
      const y = (document.scrollingElement?.scrollTop || 0) + (document.body.scrollTop || 0);
      if (Math.abs(y - lastY) < 8) return;
      document.body.classList.toggle('fab-away', y > lastY && y > 120);
      lastY = y;
    };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', onScroll, { capture: true });
  }, []);
  // Keep the home-screen widget current.
  useEffect(() => { if (isNative && data) sendWidget(data); }, [data]);

  let view;
  if (!data) view = <Shell route={route}><p class="muted">Loading…</p></Shell>;
  else if (route === 'accounts' && arg) view = <AccountDetail data={data} id={arg.split('?')[0]} />;
  else if (route === 'accounts') view = <Accounts data={data} />;
  else if (route === 'reports') view = <Reports data={data} />;
  else if (route === 'more') view = <Settings data={data} section={(arg || '').split('?')[0]} />;
  else if (route === 'history') view = <HistoryPage />;
  else if (route === 'scheduled') view = <Scheduled data={data} />;
  else if (route === 'forecast') view = <Forecast data={data} />;
  else if (route === 'debt') view = <Debt data={data} />;
  else if (route === 'grid') view = <Grid data={data} />;
  else if (route === 'about') view = <About />;
  else if (route === 'budgets' && hasBudgets()) view = <Budgets />;
  else if (route === 'setup') view = <Setup data={data} />;
  else if (route === 'badges') view = <Badges data={data} />;
  else if (route === 'recap') view = /[?&]year=/.test(hash) ? <YearRecap data={data} year={(hash.split('year=')[1] || '').slice(0, 4)} /> : <Recap data={data} month={(hash.split('month=')[1] || '').slice(0, 7)} />;
  else if (route === 'report') view = <Report data={data} month={(hash.split('month=')[1] || '').slice(0, 7)} />;
  else view = <Budget data={data} />;

  return (
    <UI.Provider value={ui}>
      <div inert={sheet || whatsNew || menu ? true : undefined}>{view}</div>
      {data && !['report', 'recap', 'budgets'].includes(route) && <BottomBar onMenu={() => setMenu(true)} />}
      {menu && <Menu data={data} onClose={() => setMenu(false)} />}
      {data && !sheet && canAddPurchases() && !['report', 'recap', 'about', 'budgets', 'more', 'badges', 'history', 'setup'].includes(route) && <button class="fab" aria-label="Add transaction" onClick={() => ui.open({ account_id: route === 'accounts' && arg ? arg : undefined })}>+</button>}
      {data && sheet && <QuickAdd data={data} opts={sheet} onClose={ui.close} />}
      {whatsNew && <WhatsNew since={whatsNew} onClose={() => setWhatsNew(null)} />}
      <DialogHost />
      {toast && (
        <div class={'toast' + (toast.undoBatch ? ' tappable' : '') + (toast.win ? ' win' : '')} role="status" onClick={async () => { if (toast.undoBatch) { const b = toast.undoBatch; if (!(await confirmUndo(b.label))) return; setToast(null); const n = await undoBatch(b.batch); showToast(`Undid: ${b.label}${n > 1 ? ` (${n} rows)` : ''}`, { plain: true }); } }}>
          <span>{toast.msg}{toast.undoBatch ? <span class="head" style="color:#b9c3d3;margin-left:8px">tap to undo</span> : null}</span>
          {toast.undo && <button class="link" style="color:#8fe0b0" onClick={async e => { e.stopPropagation(); if (!(await confirmUndo(toast.msg))) return; await toast.undo(); setToast(null); }}>Undo</button>}
          {toast.action && <button class="link" style="color:#8fe0b0" onClick={async () => { await toast.action.fn(); setToast(null); }}>{toast.action.label}</button>}
        </div>
      )}
    </UI.Provider>
  );
}

render(<App />, document.getElementById('app'));

// The Docker-served web app is a PWA. Inside the Android app the shell serves the files itself,
// so no service worker there (it would pin an old copy of the UI).
if (!isNative && import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
