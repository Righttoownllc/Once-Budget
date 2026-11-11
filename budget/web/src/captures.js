// Tap-to-pay captures: Google Wallet payment notifications the Android shell read and
// queued. Each one becomes a pre-filled Quick add; saving or dismissing it clears it.
// A capture with hidden: true means Android withheld the text (see WalletListener.kt):
// only the time is known, and the user types the amount.
import { listCaptures, onNative, isNative, callNative, captureBudget, budgetId, BRIDGE_VERSION, finishCapture } from './platform.js';
import { applyRules, ruleKey, getDefaultAccount } from './features.js';
import { payeeMemory, monthView, ym, fmt } from './budget.js';
import { put, remove, setPref, canChangeAll } from './store.js';

// Caught purchases are shared with the budget while they wait ("capture:<id>" budget settings), so
// every phone and the web app show the same "to log" bubble, and saving or dismissing it anywhere
// clears it everywhere. Nothing touches the budget until it's saved. Saved, a purchase is the
// transaction "cap-<id>", so saving it on two devices still makes one transaction.
let native = [], list = [], data = null;
const subs = new Set();
const KEY = id => 'capture:' + id;
export const captureTxId = cap => 'cap-' + cap.id;
const PUB = 'budget.capturesShared';
const published = new Set((() => { try { return JSON.parse(localStorage.getItem(PUB) || '[]'); } catch { return []; } })());
const savePub = () => { try { localStorage.setItem(PUB, JSON.stringify([...published].slice(-200))); } catch {} };
export const captures = () => list;
export const onCaptures = fn => { subs.add(fn); return () => subs.delete(fn); };
const shareable = () => !!data && canChangeAll() && captureBudget() === budgetId();
const fields = c => ({ id: c.id, amount: c.amount, merchant: c.merchant, card: c.card, last4: c.last4, postedAt: c.postedAt, hidden: !!c.hidden });

async function merge() {
  const prefs = data?.prefs || {}, txIds = new Set((data?.txs || []).map(t => t.id));
  const shared = Object.entries(prefs).filter(([k]) => k.startsWith('capture:')).map(([, v]) => { try { return JSON.parse(v); } catch { return null; } }).filter(Boolean);
  const mine = [];
  for (const c of native) {
    const done = txIds.has(captureTxId(c)) || (published.has(c.id) && !prefs[KEY(c.id)]);
    if (data && done) { finishCapture(c.id).catch(() => {}); continue; }   // saved or dismissed on another device
    mine.push(c);
    if (shareable() && !published.has(c.id) && !prefs[KEY(c.id)]) {
      published.add(c.id); savePub();
      setPref(KEY(c.id), JSON.stringify(fields(c))).catch(() => { published.delete(c.id); savePub(); });
    }
  }
  const ids = new Set(mine.map(c => c.id));
  list = [...mine, ...shared.filter(c => !ids.has(c.id) && !txIds.has(captureTxId(c))).map(c => ({ ...c, shared: true }))]
    .sort((a, b) => (a.postedAt || 0) - (b.postedAt || 0));
  subs.forEach(fn => fn(list));
  return list;
}
export async function refreshCaptures() {
  try { native = (await listCaptures()) || []; } catch { native = []; }
  return merge();
}
/** Gives the capture list the budget's data (for the shared ones); called whenever it changes. */
export function setCaptureData(d) { data = d; merge(); }
/** A capture is finished (saved or dismissed): off this phone's queue and, if shared, off everyone's. */
export async function doneCapture(cap) {
  await finishCapture(cap.id).catch(() => {});
  if (data?.prefs?.[KEY(cap.id)] !== undefined) await remove('household_prefs', KEY(cap.id)).catch(() => {});
  native = native.filter(c => c.id !== cap.id);
  return refreshCaptures();
}
if (isNative) {
  onNative('capture', refreshCaptures);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshCaptures(); });
}

/** Household pref that remembers which account a card's last 4 digits belong to. */
export const cardKey = last4 => 'card:' + last4;

/** Bank-style merchant text ("MARIO S PIZZA #1234") → a readable payee ("Mario's Pizza"). */
export function cleanMerchant(raw) {
  const s = ruleKey(raw);
  if (!s) return (raw || '').trim();
  return s.replace(/\b(\w+) s\b/g, "$1's")           // "joe s" → "joe's" (apostrophes are stripped by the card network)
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/'S\b/g, "'s");
}

/** Best account for a card: the remembered mapping, else an account sharing a word with the card name. */
export function accountForCard(data, cap) {
  const open = data.accounts.filter(a => !a.closed);
  const mapped = cap.last4 && data.prefs?.[cardKey(cap.last4)];
  if (mapped && open.some(a => a.id === mapped)) return mapped;
  const generic = new Set(['debit', 'credit', 'card', 'visa', 'mastercard', 'amex', 'discover', 'the', 'bank']);
  const words = (cap.card || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1 && !generic.has(w));
  const byLast4 = cap.last4 && open.find(a => a.name.includes(cap.last4));
  if (byLast4) return byLast4.id;
  const byWord = words.length && open.find(a => words.some(w => a.name.toLowerCase().split(/[^a-z0-9]+/).includes(w)));
  return byWord ? byWord.id : null;
}

const localDate = ms => { const d = new Date(ms || Date.now()); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

/** Quick add options for a capture. */
export function captureDraft(data, cap) {
  const ruled = cap.merchant ? applyRules(data.rules, cap.merchant) : { rule: null };
  return {
    capture: cap,
    kind: 'out',
    amount: cap.amount || undefined,
    payee: ruled.rule ? ruled.payee : cap.merchant ? cleanMerchant(cap.merchant) : '',
    account_id: accountForCard(data, cap) || undefined,
    date: localDate(cap.postedAt),
  };
}

// ---- one-tap logging from the notification (bridge v9) ------------------------------
/** Merchant key shared with WalletParser.hintKey: ruleKey without punctuation. */
export const hintKey = s => ruleKey(s).replace(/[^a-z0-9]+/g, ' ').trim();

/** What the phone needs to offer "Save as <category>" while the app is closed. Stays on the phone. */
export function captureHints(data) {
  const name = Object.fromEntries(data.categories.map(c => [c.id, c.name]));
  const rules = data.rules.filter(r => r.match).map(r => ({ m: r.match.toLowerCase(), c: name[r.category_id] ? r.category_id : '', n: name[r.category_id] || '' }));
  const memory = {};
  for (const e of Object.values(payeeMemory(data.txs))) {
    const k = hintKey(e.payee);
    if (k && e.category_id && name[e.category_id]) memory[k] = { c: e.category_id, n: name[e.category_id] };
  }
  return { budget: budgetId(), rules, memory };
}
let hintTimer = 0, lastHints = '';
/** Keeps the shell's hints current; only the budget purchases go to sends them. */
export function sendCaptureHints(data) {
  if (!isNative || BRIDGE_VERSION < 9 || !data || captureBudget() !== budgetId()) return;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    const h = captureHints(data), s = JSON.stringify(h);
    if (s !== lastHints) callNative('captures.hints', h).then(() => { lastHints = s; }).catch(() => {});
  }, 1500);
}

/** Account a capture is logged to without asking: the card's account, else the usual default. */
function autoAccount(data, cap) {
  const open = data.accounts.filter(a => !a.closed);
  const def = getDefaultAccount();
  return accountForCard(data, cap) || (open.some(a => a.id === def) ? def : null) || open.find(a => a.type !== 'credit' && a.type !== 'loan')?.id || open[0]?.id || null;
}

const logged = new Set();
/** Writes purchases confirmed from the notification ("Save as …"); a toast offers Undo for each. */
export async function logConfirmed(data, list, toast, openTx) {
  for (const cap of list) {
    if (!cap.confirm || logged.has(cap.id)) continue;
    const cat = data.categories.find(c => c.id === cap.confirm);
    const account_id = autoAccount(data, cap);
    if (!cat || !account_id) continue;   // category gone or no account: stays in the banner to log by hand
    logged.add(cap.id);
    const d = captureDraft(data, cap);
    const saved = await put('transactions', { id: captureTxId(cap), account_id, date: d.date, payee: d.payee, memo: '', category_id: cat.id, amount: -cap.amount, cleared: 0, transfer_id: null, created_at: cap.postedAt || undefined });
    await doneCapture(cap);
    const v = monthView({ ...data, txs: data.txs.concat([saved]) }, ym());
    let avail = null; for (const g of v.groups) for (const r of g.rows) if (r.id === cat.id) avail = r.available;
    // Saved from the notification without the tip: the toast offers to add one (and Undo).
    toast(`Logged ${fmt(-cap.amount)} at ${d.payee} · ${cat.name} now ${fmt(avail)}`, { undo: () => remove('transactions', saved.id), ...(openTx ? { action: { label: '+ Tip', fn: () => openTx(saved) } } : {}) });
  }
  if (list.some(c => c.confirm)) refreshCaptures();
}

export const cardLabel = cap => [cap.card, cap.last4 && '••' + cap.last4].filter(Boolean).join(' ') || 'Google Wallet';
/** One-line summary for the banner. */
export const captureSummary = cap => cap.hidden
  ? `Google Wallet · ${new Date(cap.postedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · amount hidden by Android`
  : `$${(cap.amount / 100).toFixed(2)} at ${cap.merchant || 'unknown merchant'} · ${cardLabel(cap)}`;
