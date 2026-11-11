// Where the UI is running. Inside the Android app the shell injects window.BudgetNative
// (see android/.../Bridge.kt); in a browser the page was served by the Docker server.
//
// Modes:
//   local  — Android default. Data lives only in this device's IndexedDB; no server, no sync.
//   server — browser on the Docker server, or the Android app after the user opts in.
const N = typeof window !== 'undefined' ? window.BudgetNative : undefined;
export const isNative = !!N;
/** Version of the native bridge. A UI bundle that needs a newer bridge must not be loaded. */
export const BRIDGE_VERSION = N ? Number(N.bridgeVersion()) : 0;

// ---- budgets ---------------------------------------------------------------------
// App: several budgets on the phone (bridge v4), each offline or connected to a budget on a
// server. Browser: the budgets stored on the server it came from (never browser-only data;
// the browser just caches them). Each budget has its own IndexedDB cache; "main" keeps "budget".
const SRV_KEY = 'budget.serverBudget';   // browser: which server budget is open (null = your main one)
const webPick = () => { try { return localStorage.getItem(SRV_KEY) || null; } catch { return null; } };
const webOpen = hh => { try { hh ? localStorage.setItem(SRV_KEY, hh) : localStorage.removeItem(SRV_KEY); } catch {} location.assign(location.pathname + '?budget=' + (hh || 'main') + '#/budget'); };

export const budgetId = () => (N ? (typeof N.getBudget === 'function' ? N.getBudget() : 'main') : webPick() ? 'srv-' + webPick() : 'main');
export const mode = () => (N ? N.getMode() : 'server');
export const budgetDbName = () => (budgetId() === 'main' ? 'budget' : 'budget-' + budgetId());
export const hasBudgets = () => !N || BRIDGE_VERSION >= 4;
/** Bridge v5: phone budgets can be tied to a particular budget on the server. */
export const hasServerBudgets = () => !N || BRIDGE_VERSION >= 5;
/** The server budget requests should go to (browser only; the app's shell adds its own header). */
export const webServerBudget = () => (N ? null : webPick());

const api = async (path, opts = {}) => {
  const r = await apiFetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Server answered ' + r.status);
  return j;
};
/** Budgets stored on the server (as the app or browser can reach it). */
export const serverBudgets = () => api('/api/budgets');
export const createServerBudget = name => api('/api/budgets', { method: 'POST', body: JSON.stringify({ name }) });

export const listBudgets = async () => {
  if (N) return callNative('budgets.list');
  const r = await serverBudgets();
  const pick = webPick();
  return { active: pick && r.list.some(b => b.id === pick) ? 'srv-' + pick : 'main', list: r.list.map(b => ({ id: b.id === r.main ? 'main' : 'srv-' + b.id, server: b.id, name: b.name, mode: 'server', role: b.role, accounts: b.accounts, transactions: b.transactions, updated_at: b.updated_at })) };
};
/** opts (app, bridge v5): { server: <server budget id> } adds a budget connected like the open one. */
export const createBudget = async (name, opts = {}) => {
  if (N) return callNative('budgets.create', { name, ...opts });
  const b = await createServerBudget(name);
  webOpen(b.id);
  return { id: 'srv-' + b.id };
};
export const switchBudget = async id => (N ? callNative('budgets.switch', { id }) : webOpen(id === 'main' ? null : id.replace(/^srv-/, '')));
/** Bridge v7: offline budgets can be put on the server from Choose a budget. */
export const hasPutOnline = () => BRIDGE_VERSION >= 7;
export const linkServer = (id, from) => callNative('budgets.linkServer', { id, from });
/** One-shot instruction for a budget to carry out when it next opens ('online' | 'offline'). */
export const setPendingAction = (id, act) => { try { localStorage.setItem('budget.pending.' + id, act); } catch {} };
export const peekPendingAction = () => { try { return localStorage.getItem('budget.pending.' + budgetId()); } catch { return null; } };
export const takePendingAction = () => { try { const k = 'budget.pending.' + budgetId(), v = localStorage.getItem(k); localStorage.removeItem(k); return v; } catch { return null; } };
export const renameBudget = async (id, name, server) => {
  if (N) return callNative('budgets.rename', { id, name });
  if (!name.trim()) return;
  return api('/api/budgets/' + server, { method: 'PATCH', body: JSON.stringify({ name }) });
};
/** Deletes a budget that isn't open. App: from this phone only. Browser: from the server (after a backup). */
export async function deleteBudget(id, server) {
  if (id === 'main' || id === budgetId()) throw new Error('Switch to another budget before deleting this one');
  await new Promise((res, rej) => { const r = indexedDB.deleteDatabase('budget-' + id); r.onsuccess = res; r.onerror = () => rej(r.error); r.onblocked = res; });
  if (N) return callNative('budgets.delete', { id });
  return api('/api/budgets/' + server, { method: 'DELETE', body: JSON.stringify({ confirm: 'YES' }) });
}
export const isLocal = () => mode() === 'local';

// ---- async calls into the shell ---------------------------------------------------
// JS -> native: N.call(id, method, argsJson). Native -> JS: window.__nativeResolve(id, ok, resultJson).
let seq = 0;
const waiting = new Map();
if (N) {
  window.__nativeResolve = (id, ok, json) => {
    const w = waiting.get(id); if (!w) return;
    waiting.delete(id);
    let v = null; try { v = json ? JSON.parse(json) : null; } catch { v = json; }
    ok ? w.resolve(v) : w.reject(new Error((v && v.message) || String(v || 'native call failed')));
  };
}
export function callNative(method, args = {}) {
  if (!N) return Promise.reject(new Error('Not running in the app'));
  const id = ++seq;
  return new Promise((resolve, reject) => { waiting.set(id, { resolve, reject }); N.call(id, method, JSON.stringify(args)); });
}

// ---- events pushed from the shell ---------------------------------------------
// The shell calls window.__nativeEvent(name, json), e.g. 'capture' when a Wallet payment arrives.
const handlers = {};
export const onNative = (name, fn) => { (handlers[name] ||= new Set()).add(fn); return () => handlers[name].delete(fn); };
if (N) window.__nativeEvent = (name, json) => { let v = null; try { v = json ? JSON.parse(json) : null; } catch {} (handlers[name] || []).forEach(fn => fn(v)); };

// ---- server API ------------------------------------------------------------------
/** fetch() for /api/*. In the app the shell makes the request (it holds the server URL and sign-in). */
export async function apiFetch(path, opts = {}) {
  if (!N) {
    const hh = webPick();
    return fetch(path, hh ? { ...opts, headers: { ...(opts.headers || {}), 'x-budget': hh } } : opts);
  }
  // Offline mode never syncs; the only calls made then are while connecting (Settings → Your own server).
  const r = await callNative('http', { method: opts.method || 'GET', path, body: opts.body ?? null, contentType: opts.headers?.['content-type'] || null });
  if (r.status === 0) throw new TypeError(r.error || 'Server unreachable');
  if (r.needsLogin) return new Response(JSON.stringify({ error: 'unauthenticated', needsLogin: true }), { status: 401, headers: { 'content-type': 'application/json' } });
  return new Response(r.body, { status: r.status, headers: { 'content-type': r.contentType || 'application/json' } });
}

// ---- device helpers --------------------------------------------------------------
export function haptic(kind = 'tap') {
  if (kind === 'tap' && !tapHaptics()) return;
  try {
    if (N) return N.haptic(kind);
    if (navigator.vibrate) navigator.vibrate(kind === 'success' ? [12, 40, 12] : kind === 'warn' ? [40] : 10);
  } catch {}
}

// ---- tap feedback ---------------------------------------------------------------
// Every tap on something pressable gives a short vibration (per-device setting, on by default).
// Uses Android's touch feedback, so no vibrate permission and it follows the system setting.
const HAPTICS_KEY = 'budget.haptics';
export const tapHaptics = () => { try { return localStorage.getItem(HAPTICS_KEY) !== '0'; } catch { return true; } };
export const setTapHaptics = on => { try { localStorage.setItem(HAPTICS_KEY, on ? '1' : '0'); } catch {} };
const PRESSABLE = 'button, a[href], select, summary, label.check, input[type=checkbox], input[type=radio], .chip, .mitem, .pick, .banner, .bbar, [role=button]';
if (typeof document !== 'undefined') {
  document.addEventListener('click', e => {
    const el = e.target.closest && e.target.closest(PRESSABLE);
    if (el && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && tapHaptics()) haptic('tap');
  }, true);
}

// ---- hide balances (privacy mode, per device) -------------------------------------
// Blurs every amount (class .money) until switched off; press and hold an amount to peek.
const HIDE_KEY = 'budget.hideMoney';
export const moneyHidden = () => { try { return localStorage.getItem(HIDE_KEY) === '1'; } catch { return false; } };
export function setMoneyHidden(on) {
  try { localStorage.setItem(HIDE_KEY, on ? '1' : '0'); } catch {}
  if (typeof document !== 'undefined') document.documentElement.classList.toggle('hide-money', on);
  if (typeof window !== 'undefined') dispatchEvent(new Event('budget:privacy'));   // the home-screen widget follows it
}
if (typeof document !== 'undefined') {
  document.documentElement.classList.toggle('hide-money', moneyHidden());
  const peek = on => e => { const m = e.target.closest && e.target.closest('.money'); if (m) m.classList.toggle('peek', on); };
  document.addEventListener('pointerdown', peek(true));
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) document.addEventListener(ev, () => document.querySelectorAll('.money.peek').forEach(m => m.classList.remove('peek')), true);
}

/** Bridge v8: app lock with the phone's screen lock. */
export const hasAppLock = () => BRIDGE_VERSION >= 8;
export const lockSettings = () => callNative('lock.get');
export const setLock = s => callNative('lock.set', s);

/** Bridge v12: pair with a server (AUTH_MODE=password) using its QR or 6-digit code. */
export const hasPairing = () => BRIDGE_VERSION >= 12;
export const pairServer = (url, code, away) => callNative('server.pair', { url, code, away: away || '' });
export const takeLaunchPair = () => (hasPairing() ? callNative('pair.takeLaunch') : Promise.resolve(null));

/** Bridge v10: home-screen widget. */
export const hasWidget = () => BRIDGE_VERSION >= 10;
export const pinWidget = () => callNative('widget.pin');

/** Leave the app (second back press at the root). */
export const exitApp = () => N && N.exit();

/** Save text to a file. In the app this opens Android's "save to" picker (no storage permission). */
export async function saveFile(name, text, mime = 'application/json') {
  if (N) return callNative('saveFile', { name, mime, text });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  a.click();
  return { saved: true };
}

// ---- tap-to-pay captures ----------------------------------------------------------
// A capture: { id, amount (cents, positive), merchant (raw), card (e.g. "Visa"), last4, postedAt (ms) }
/** Budget tap-to-pay purchases go to (bridge v6). Older apps: whichever budget is open. */
export const captureBudget = () => (N && typeof N.getCaptureBudget === 'function' ? N.getCaptureBudget() : budgetId());
export const setCaptureBudget = id => callNative('captures.setBudget', { id });
export const hasCaptureBudget = () => BRIDGE_VERSION >= 6;
/** Purchases waiting to be logged, only in the budget they go to. */
export const listCaptures = () => (N ? (captureBudget() === budgetId() ? callNative('captures.list') : Promise.resolve([])) : Promise.resolve([]));
export const finishCapture = id => (N ? callNative('captures.done', { id }) : Promise.resolve());
/** Capture id the app was opened for (tapped notification), consumed once. */
export const takeLaunchCapture = () => (N ? callNative('captures.takeLaunch') : Promise.resolve(null));
export const captureLog = () => callNative('captures.log');
export const captureAccess = () => (N ? callNative('captures.status') : Promise.resolve({ supported: false }));
export const openCaptureSettings = () => callNative('captures.openSettings');
export const requestNotifications = () => callNative('notifications.request');
export const openNotificationSettings = () => callNative('notifications.openSettings');
export const openAppDetails = () => callNative('app.openDetails');
/** Bridge v3+: open Google Wallet (to read a purchase Android hid). Older apps: hide the button. */
export const canOpenWallet = () => BRIDGE_VERSION >= 3;
export const openWallet = () => callNative('wallet.open');
