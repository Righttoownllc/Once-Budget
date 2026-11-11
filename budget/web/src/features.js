// Helpers for the v0.4.0 features. Pure functions over the loaded data.
import { paydaysBetween } from './paydays.js';
import { monthView, addMonths, addDays, today, ym, HOLD, BORROW, goalNeed, newestFirst } from './budget.js';
import { put, uuid, assign, beginBatch, endBatch, setPref, canChangeAll } from './store.js';
import { fmt } from './budget.js';
import { budgetId } from './platform.js';
/** localStorage key for something that belongs to one budget (account ids, months seen). */
export const perBudget = k => (budgetId() === 'main' ? k : `${k}.${budgetId()}`);

// ---- 5. Money check --------------------------------------------------------
export function moneyCheck(data, month) {
  const v = monthView(data, month);
  const inCats = v.totals.available;
  const held = v.assigned_future;
  const unaccounted = v.cash - inCats - held - v.ready_to_assign;   // always 0 by construction
  // The payoff category's shortfall is card debt to fund, not overspending (see Card payoff below).
  const payoffId = data.prefs?.payoff_category_id || null;
  const overspent = [];
  let payoffDebt = null;
  for (const g of v.groups) for (const r of g.rows) {
    if (r.id === payoffId) { if (r.available < 0) payoffDebt = { cat: r, amount: -r.available }; continue; }
    if (r.available < 0) overspent.push(r);
  }
  const onBudget = new Set(data.accounts.filter(a => a.on_budget).map(a => a.id));
  const isStart = t => t.payee === 'Starting balance';
  // Only on-budget, non-transfer outflows with no category. Starting balances on cards are
  // tracked by the card's own "not covered" figure, not here.
  const uncategorized = data.txs.filter(t => onBudget.has(t.account_id) && !t.transfer_id && !t.category_id && t.amount < 0 && !isStart(t) && t.date.slice(0, 7) <= month)
    .sort(newestFirst);
  const cardDebt = data.accounts.filter(a => a.on_budget && a.type === 'credit' && !a.closed)
    .map(a => ({ a, uncovered: data.txs.filter(t => t.account_id === a.id && !t.transfer_id && !t.category_id && t.amount < 0 && isStart(t)).reduce((s, t) => s + t.amount, 0) }))
    .filter(x => x.uncovered < 0);
  // Possible duplicates: same account, same amount, within a day, newest 60 days.
  const recent = data.txs.filter(t => t.date >= addDays(today(), -60) && t.payee !== 'Starting balance').sort((a, b) => a.date.localeCompare(b.date));
  const dups = [];
  for (let i = 0; i < recent.length; i++) for (let j = i + 1; j < recent.length; j++) {
    const a = recent[i], b = recent[j];
    if (b.date > addDays(a.date, 1)) break;
    if (a.account_id === b.account_id && a.amount === b.amount && a.transfer_id !== b.transfer_id) dups.push([a, b]);
  }
  // Leftovers that no longer count: a "take from next month" bigger than what it still covers (its
  // overspending was deleted or covered another way). Ignored by the math; listed so it can be cleared.
  const next = addMonths(month, 1);
  const recordedBorrow = -data.months.filter(b => b.category_id === BORROW && b.month === next && !b.deleted).reduce((s, b) => s + b.assigned, 0);
  const staleBorrow = recordedBorrow > v.borrowed_from_next ? { month: next, recorded: recordedBorrow, used: v.borrowed_from_next, extra: recordedBorrow - v.borrowed_from_next } : null;
  return { cash: v.cash, inCats, held, rta: v.ready_to_assign, unaccounted, overspent, payoffDebt, uncategorized, cardDebt, dups, staleBorrow, view: v };
}

// ---- 6. Spending pace ------------------------------------------------------
export function pace(row, month) {
  const t = today();
  if (t.slice(0, 7) !== month) return null;
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const day = Number(t.slice(8, 10));
  const left = daysInMonth - day + 1;
  if (row.available <= 0) return null;
  return { daysLeft: left, perDay: Math.floor(row.available / left) };
}

// ---- 2. Targets ------------------------------------------------------------
/** Assignments needed to bring every category with a target up to it. */
export function fillToTargets(data, month) {
  const v = monthView(data, month);
  const out = [];
  const payoffId = data.prefs?.payoff_category_id || null;
  for (const g of v.groups) for (const r of g.rows) {
    // Card payoff: at least enough to clear the rolled card debt, target or not.
    const need = r.id === payoffId ? Math.max(goalNeed(r, month), -r.available) : goalNeed(r, month);
    if (need > 0) out.push({ id: r.id, name: r.name, add: need, assigned: r.assigned + need });
  }
  return out;
}
/** Copy last month's assigned amounts into this month (only where this month is 0). */
export function assignLikeLastMonth(data, month) {
  const prev = addMonths(month, -1);
  const out = [];
  const thisMonth = {};
  for (const b of data.months) if (b.month === month) thisMonth[b.category_id] = b.assigned;
  for (const b of data.months) if (b.month === prev && b.assigned && b.category_id !== HOLD && b.category_id !== BORROW && !thisMonth[b.category_id])
    out.push({ id: b.category_id, assigned: b.assigned });
  return out;
}

// ---- 7. Net worth by month -------------------------------------------------
export function netWorthSeries(data, monthsBack = 12) {
  const end = ym();
  const months = [];
  for (let i = monthsBack - 1; i >= 0; i--) months.push(addMonths(end, -i));
  const closedAt = {};
  const sorted = [...data.txs].sort((a, b) => a.date.localeCompare(b.date));
  let i = 0; let cash = 0, debt = 0;
  const isDebt = Object.fromEntries(data.accounts.map(a => [a.id, a.type === 'credit' || a.type === 'loan']));
  return months.map(m => {
    while (i < sorted.length && sorted[i].date.slice(0, 7) <= m) {
      const t = sorted[i++];
      if (isDebt[t.account_id]) debt += t.amount; else cash += t.amount;
    }
    return { month: m, cash, debt, net: cash + debt };
  });
}

// ---- 10. Month rollover ----------------------------------------------------
const ROLL_KEY = perBudget('budget.lastSeenMonth');
export function rolloverCheck(data) {
  let seen = null;
  try { seen = localStorage.getItem(ROLL_KEY); localStorage.setItem(ROLL_KEY, ym()); } catch {}
  if (!seen || seen === ym()) return null;
  const v = monthView(data, seen);
  const payoffId = data.prefs?.payoff_category_id || null;
  const over = [];
  for (const g of v.groups) for (const r of g.rows) if (r.available < 0 && r.id !== payoffId) over.push(r);
  if (!over.length) return null;
  return { month: seen, over, total: over.reduce((s, r) => s + r.available, 0) };
}

// ---- 1. Scheduled transactions --------------------------------------------
export function advance(date, freq) {
  const d = new Date(date + 'T00:00:00');
  if (freq === 'weekly') d.setDate(d.getDate() + 7);
  else if (freq === 'biweekly') d.setDate(d.getDate() + 14);
  else if (freq === 'yearly') d.setFullYear(d.getFullYear() + 1);
  else { const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + 1); d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); }
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
export const dueScheduled = (data, within = 3) => {
  const limit = addDays(today(), within);
  return data.scheduled.filter(s => s.next_date <= limit).sort((a, b) => a.next_date.localeCompare(b.next_date));
};
/** Post one scheduled item as a real transaction (or transfer) and move its next_date forward. */
export async function postScheduled(s, date = s.next_date) {
  if (s.transfer_to) {
    const transfer_id = uuid(); const a = Math.abs(s.amount);
    // category_id on a transfer = loan payment from a category (outflow leg carries it)
    await put('transactions', { account_id: s.account_id, date, amount: -a, memo: s.memo, transfer_id, payee: 'Transfer', category_id: s.category_id || null, cleared: 0 });
    await put('transactions', { account_id: s.transfer_to, date, amount: a, memo: s.memo, transfer_id, payee: 'Transfer', category_id: null, cleared: 0 });
  } else {
    await put('transactions', { account_id: s.account_id, date, payee: s.payee, category_id: s.category_id || null, memo: s.memo, amount: s.amount, cleared: 0 });
  }
  await put('scheduled', { ...s, next_date: advance(s.next_date, s.frequency) });
}
export const skipScheduled = s => put('scheduled', { ...s, next_date: advance(s.next_date, s.frequency) });
/** Auto-post anything marked auto that is due today or earlier. Returns count. */
export async function autoPostDue(data) {
  if (!canChangeAll()) return 0;   // someone with a limited level in a shared budget: owners' devices post these
  let n = 0;
  for (const s of data.scheduled.filter(s => s.auto && s.next_date <= today())) {
    // Guard against posting the same thing repeatedly if months were missed: post each due occurrence.
    let cur = s;
    while (cur.next_date <= today()) { await postScheduled(cur); cur = { ...cur, next_date: advance(cur.next_date, cur.frequency) }; n++; if (n > 50) break; }
  }
  return n;
}

// ---- 3. Payee rules --------------------------------------------------------
/** Normalize a payee into a rule match key: lowercase, drop store numbers, '#1234', '*', extra spaces. */
export const ruleKey = p => (p || '').toLowerCase().replace(/#\s*\d+/g, '').replace(/\b\d{3,}\b/g, '').replace(/\*\s*[a-z0-9]*\d[a-z0-9]*\b/g, ' ').replace(/[*]/g, ' ').replace(/\s+/g, ' ').trim();
/** Add a rule unless an equivalent one exists. */
export async function learnRule(rules, payee, category_id, display) {
  const match = ruleKey(payee); if (!match) return null;
  if (rules.some(r => r.match.toLowerCase() === match)) return null;
  return put('payee_rules', { match, payee: display || prettyPayee(payee), category_id: category_id || null });
}
export const prettyPayee = p => ruleKey(p).replace(/\b\w/g, c => c.toUpperCase()).trim();
export function applyRules(rules, rawPayee) {
  const p = (rawPayee || '').trim();
  const lower = p.toLowerCase();
  for (const r of rules) if (r.match && lower.includes(r.match.toLowerCase())) return { payee: r.payee, category_id: r.category_id || null, rule: r };
  return { payee: p, category_id: null, rule: null };
}

// ---- 11. Reconcile age -----------------------------------------------------
export function reconcileAge(acct) {
  if (!acct.reconciled_at) return null;
  return Math.floor((Date.now() - acct.reconciled_at) / 86400000);
}

// ---- 18. CSV import --------------------------------------------------------
export function parseCSV(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const clean = rows.filter(r => r.some(x => x.trim()));
  // Some banks put a sentence or two above the real header. The header is the
  // first row with 3+ cells whose width matches the following row.
  let start = 0;
  for (let i = 0; i < clean.length - 1; i++) {
    if (clean[i].length >= 3 && clean[i].length === clean[i + 1].length) { start = i; break; }
  }
  return clean.slice(start).map(r => r.map(x => x.trim()));
}
const norm = s => s.toLowerCase().replace(/[^a-z]/g, '');
/** Guess which columns hold date / payee / amount / debit / credit from the header row. */
export function guessColumns(header) {
  const h = header.map(norm);
  // Some credit card exports list charges as positive numbers; flag so the UI can suggest flipping.
  const looksLikeCardExport = h.some(x => x === 'card' || x.startsWith('card')) && h.some(x => x.includes('item'));
  const find = (...names) => { for (const n of names) { const i = h.findIndex(x => x.includes(n)); if (i >= 0) return i; } return -1; };
  // A signed amount column wins; separate debit/credit columns are only for exports without one
  // (and never a "CREDIT/DEBIT" column, which holds the words, not amounts). "Original amount" is a
  // foreign-currency column, not the amount.
  const amount = h.findIndex(x => x.includes('amount') && !x.includes('original'));
  const both = x => x.includes('credit') && x.includes('debit');
  const findMoney = (...names) => (amount >= 0 ? -1 : h.findIndex(x => !both(x) && names.some(n => x.includes(n))));
  return {
    date: find('transactiondate', 'dateposted', 'postingdate', 'postdate', 'date'),
    payee: find('description', 'payee', 'merchant', 'name', 'memo'),
    amount,
    debit: findMoney('debit', 'withdrawal'),
    credit: findMoney('credit', 'deposit'),
    suggestInvert: looksLikeCardExport,
  };
}
export function parseDate(s) {
  s = (s || '').trim();
  let m;
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/))) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; }
  const d = new Date(s); return isNaN(d) ? null : d.toISOString().slice(0, 10);
}
export function parseAmount(s) {
  if (s == null) return null;
  s = String(s).trim(); if (!s) return null;
  const neg = /^\(.*\)$/.test(s) || s.startsWith('-') || /\bDR\b/i.test(s);
  const n = parseFloat(s.replace(/[^0-9.]/g, ''));
  if (isNaN(n)) return null;
  return Math.round(n * 100) * (neg ? -1 : 1);
}
/** Turn CSV rows into transaction drafts; dedupes against existing by date+amount+payee. */
/**
 * Rows of a bank CSV as draft transactions, with duplicate checks against what's already in the
 * account (payee is ignored on purpose: rules and edits change it, the bank's date and amount don't):
 *  - dup:  same date and amount as an existing transaction. Matched one-for-one, so two genuine
 *          identical charges on one day still import if the file has more of them than the app.
 *  - near: same amount within NEAR_DAYS of an existing transaction not matched above (typically a
 *          purchase logged by hand or by tap-to-pay that the bank posted a day or two later).
 * Both start unticked; `match` describes the existing transaction.
 */
const NEAR_DAYS = 3;
export function draftsFromCSV(rows, cols, { account_id, invert = false, rules = [], existing = [] }) {
  const mine = existing.filter(t => t.account_id === account_id && !t.deleted).map(t => ({ t, used: false }));
  const days = (a, b) => Math.abs((new Date(a + 'T00:00:00') - new Date(b + 'T00:00:00')) / 864e5);
  const describe = t => `${t.payee || 'transaction'}, ${t.date}`;
  const out = [];
  for (const r of rows.slice(1)) {
    const date = parseDate(r[cols.date]); if (!date) continue;
    let amount = null;
    if (cols.amount >= 0) amount = parseAmount(r[cols.amount]);
    else { const d = parseAmount(r[cols.debit]), c = parseAmount(r[cols.credit]); amount = (c || 0) - Math.abs(d || 0); }
    if (amount == null) continue;
    if (invert) amount = -amount;
    const raw = r[cols.payee] || '';
    const ruled = applyRules(rules, raw);
    const bank_ref = cols.ref >= 0 ? (r[cols.ref] || '').trim() || null : null;
    out.push({ date, amount, payee: ruled.payee, raw, bank_ref, category_id: ruled.category_id, ruleHit: !!ruled.rule, dup: false, near: false, include: true, match: null });
  }
  // The bank's reference, when both sides have one, is exact: same ref = already in app; a different
  // ref = a different bank transaction, so rows with a reference never take part in date/amount
  // matching below (two identical purchases on one day stay two).
  const byRef = new Map(mine.filter(x => x.t.bank_ref).map(x => [x.t.bank_ref, x]));
  const seenRefs = new Set();
  for (const d of out) {
    if (!d.bank_ref) continue;
    const m = byRef.get(d.bank_ref);
    if (m) { m.used = true; Object.assign(d, { dup: true, include: false, match: describe(m.t) }); }
    else if (seenRefs.has(d.bank_ref)) Object.assign(d, { dup: true, include: false, match: 'repeated in this file' });
    seenRefs.add(d.bank_ref);
  }
  for (const x of mine) if (x.t.bank_ref) x.used = true;

  // Exact matches first, so a near match never takes an existing row an exact one needs.
  for (const d of out) {
    if (d.dup) continue;
    const m = mine.find(x => !x.used && x.t.date === d.date && x.t.amount === d.amount);
    if (m) { m.used = true; Object.assign(d, { dup: true, include: false, match: describe(m.t) }); }
  }
  for (const d of out) {
    if (d.dup) continue;
    const m = mine.filter(x => !x.used && x.t.amount === d.amount && days(x.t.date, d.date) <= NEAR_DAYS)
      .sort((a, b) => days(a.t.date, d.date) - days(b.t.date, d.date))[0];
    if (m) { m.used = true; Object.assign(d, { near: true, include: false, match: describe(m.t) }); }
  }
  return out;
}

/**
 * The bank's own transaction id column, if the file has a usable one: a header that sounds like a
 * reference, with values that are filled in and unique on nearly every row. Banks name and fill
 * these differently (some leave theirs empty), so emptiness and uniqueness decide, not the name.
 */
export function guessRefColumn(rows) {
  if (!rows || rows.length < 2) return -1;
  const h = rows[0].map(norm), data = rows.slice(1);
  const named = h.map((x, i) => [x, i]).filter(([x]) => /reference|refno|transactionid|txnid|fitid|confirmation|uniqueid|^id$/.test(x) && !/check|cheque/.test(x));
  let best = -1, bestScore = 0;
  for (const [, i] of named) {
    const vals = data.map(r => (r[i] || '').trim()).filter(Boolean);
    const filled = vals.length / data.length, unique = new Set(vals).size / Math.max(1, vals.length);
    const score = filled * unique;
    if (filled >= 0.9 && unique >= 0.98 && score > bestScore) { best = i; bestScore = score; }
  }
  return best;
}

/** Short fingerprint of a file's text (the same bank export imported twice gives the same value). */
export function fileFingerprint(text) {
  let h1 = 0x811c9dc5, h2 = 0;
  const s = text.replace(/\r\n?/g, '\n').trim();
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619) >>> 0; h2 = (h2 * 31 + c) >>> 0; }
  return h1.toString(36) + h2.toString(36) + s.length.toString(36);
}

// ---- recurring charge detection (used by CSV import) ------------------------
const keyOf = p => (p || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b\d+\b/g, '').trim();
/**
 * Find payees that recur on a steady rhythm with a steady amount.
 * rows: [{date, amount, payee}] from the import plus existing account transactions.
 */
export function detectRecurring(rows, existingScheduled = []) {
  const groups = {};
  for (const r of rows) { if (!r.payee || r.amount === 0) continue; (groups[keyOf(r.payee)] ||= []).push(r); }
  const already = new Set(existingScheduled.map(s => keyOf(s.payee)));
  const out = [];
  for (const [k, list] of Object.entries(groups)) {
    if (list.length < 2 || already.has(k)) continue;
    const byDate = [...list].sort((a, b) => a.date.localeCompare(b.date));
    const days = [];
    for (let i = 1; i < byDate.length; i++) days.push((new Date(byDate[i].date) - new Date(byDate[i - 1].date)) / 86400000);
    const med = median(days);
    let frequency = null;
    if (med >= 6 && med <= 8) frequency = 'weekly';
    else if (med >= 12 && med <= 16) frequency = 'biweekly';
    else if (med >= 26 && med <= 35) frequency = 'monthly';
    else if (med >= 350 && med <= 380) frequency = 'yearly';
    if (!frequency) continue;
    const amts = byDate.map(r => Math.abs(r.amount));
    const medAmt = median(amts);
    const steady = amts.every(a => Math.abs(a - medAmt) <= Math.max(200, medAmt * 0.15));
    const last = byDate[byDate.length - 1];
    out.push({
      key: k, payee: last.payee, count: byDate.length, frequency,
      amount: Math.sign(last.amount) * medAmt, steady,
      next_date: advance(last.date, frequency),
      category_id: byDate.map(r => r.category_id).filter(Boolean).pop() || null,
      include: steady,
    });
  }
  return out.sort((a, b) => b.count - a.count);
}
function median(xs) { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

// ---- default account (per device) -------------------------------------------
const DEF_KEY = perBudget('budget.defaultAccount');
export const getDefaultAccount = () => { try { return localStorage.getItem(DEF_KEY); } catch { return null; } };
export const setDefaultAccount = id => { try { id ? localStorage.setItem(DEF_KEY, id) : localStorage.removeItem(DEF_KEY); } catch {} };

// ---- Age of money ------------------------------------------------------------
/**
 * FIFO: every on-budget outflow spends the oldest unspent inflow dollars. The age of a
 * purchase is how long those dollars sat in your accounts. We report the average age of
 * the last 10 purchases (YNAB's definition). Returns null until there's enough history.
 */
export function ageOfMoney(data, asOf = today()) {
  const onBudget = new Set(data.accounts.filter(a => a.on_budget).map(a => a.id));
  const txs = data.txs.filter(t => onBudget.has(t.account_id) && !t.transfer_id && t.date <= asOf)
    .sort((a, b) => a.date.localeCompare(b.date) || a.updated_at - b.updated_at);
  // Transfers to off-budget accounts (loan payments) are real outflows from the budget's view.
  const loanPays = data.txs.filter(t => onBudget.has(t.account_id) && t.transfer_id && t.amount < 0 && t.date <= asOf &&
    data.txs.some(x => x.transfer_id === t.transfer_id && x.id !== t.id && !onBudget.has(x.account_id)));
  const all = txs.concat(loanPays).sort((a, b) => a.date.localeCompare(b.date));
  const inflows = [];   // queue of { date, left }
  const ages = [];      // age in days of each outflow, in order
  let qi = 0;
  for (const t of all) {
    if (t.amount > 0) { inflows.push({ date: t.date, left: t.amount }); continue; }
    let need = -t.amount, weighted = 0, used = 0;
    while (need > 0 && qi < inflows.length) {
      const inf = inflows[qi]; const take = Math.min(need, inf.left);
      weighted += take * daysBetween(inf.date, t.date); used += take; need -= take; inf.left -= take;
      if (inf.left === 0) qi++;
    }
    if (used > 0) ages.push(weighted / used);
  }
  if (ages.length < 3) return null;
  const last = ages.slice(-10);
  return { days: Math.round(last.reduce((s, a) => s + a, 0) / last.length), samples: last.length };
}
const daysBetween = (a, b) => Math.max(0, Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000));
/** Age of money at the end of each of the last n months, for a trend. */
export function ageOfMoneySeries(data, n = 6) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const m = addMonths(ym(), -i);
    const [y, mo] = m.split('-').map(Number);
    const end = i === 0 ? today() : `${m}-${String(new Date(y, mo, 0).getDate()).padStart(2, '0')}`;
    out.push({ month: m, age: ageOfMoney(data, end) });
  }
  return out;
}

// ---- closed months -----------------------------------------------------------
export const closedThrough = data => data.prefs?.closed_through || null;
export const isClosedMonth = (data, month) => { const c = closedThrough(data); return !!c && month <= c; };
export const isClosedDate = (data, date) => isClosedMonth(data, (date || '').slice(0, 7));

/**
 * A copy of exported data with every id replaced and every reference re-pointed: groups,
 * categories, accounts, transfers and splits, scheduled items, rules, card memory, the payoff category
 * and debt-plan settings. Used when
 * importing a backup into a different budget, so the copy is independent of the original.
 */
export function freshIds(data) {
  const map = {};
  const nid = old => (old && old !== HOLD && old !== BORROW ? (map[old] ||= uuid()) : old);
  const out = {};
  for (const [t, rows] of Object.entries(data || {})) {
    out[t] = (rows || []).map(r => {
      if (t === 'household_prefs') {
        // Settings that point at an account or category follow it to its new id.
        if (r.id.startsWith('card:') || r.id === 'payoff_category_id') return { ...r, value: nid(r.value) };
        if (r.id === 'debt:exclude' || r.id === 'reports:hide' || r.id === 'reports:piehide') { let ids = []; try { ids = JSON.parse(r.value || '[]'); } catch {} return { ...r, value: JSON.stringify(ids.map(nid)) }; }
        if (r.id.startsWith('icon:')) return { ...r, id: 'icon:' + nid(r.id.slice(5)) };
        if (/^debt:/.test(r.id) && !['debt:extra', 'debt:strategy', 'debt:exclude'].includes(r.id)) return { ...r, id: 'debt:' + nid(r.id.slice(5)) };
        return { ...r };
      }
      const c = { ...r, id: nid(r.id) };
      for (const k of ['group_id', 'category_id', 'account_id', 'transfer_id', 'split_id', 'transfer_to']) if (c[k]) c[k] = nid(c[k]);
      return c;
    });
  }
  return out;
}

// ---- Roll card overspending into a payoff category (source/roll-overspending-spec.md) -----------------
// At month end, a category that ended negative because of credit-card spending hands that shortfall to
// the payoff category, so it opens the next month clean and the card debt sits in one place. Only the
// card share rolls: overspending paid by cash or debit is money that's truly gone, so it stays red in
// its category. Done with assignments in the old month (Ready to Assign doesn't change), one undoable
// batch per month, and never twice for the same month (household_prefs.rolled_through).
export const rollSettings = data => ({
  on: data.prefs?.roll_card_overspending === '1',
  payoff: data.prefs?.payoff_category_id || null,
  through: data.prefs?.rolled_through || null,
});

/** What would roll for one month: [{ id, name, amount, assigned }] (amount = card share of the shortfall). */
export function rollMoves(data, month, payoffId) {
  const v = monthView(data, month);
  const cards = new Set(data.accounts.filter(a => a.type === 'credit' && a.on_budget).map(a => a.id));
  const cardOut = {};
  for (const t of data.txs) if (t.date.slice(0, 7) === month && cards.has(t.account_id) && t.category_id && t.amount < 0 && !t.transfer_id)
    cardOut[t.category_id] = (cardOut[t.category_id] || 0) - t.amount;
  const moves = [];
  for (const g of v.groups) for (const r of g.rows) {
    if (r.id === payoffId || r.id === HOLD || r.available >= 0) continue;   // income categories aren't in v.groups
    const amount = Math.min(-r.available, cardOut[r.id] || 0);
    if (amount > 0) moves.push({ id: r.id, name: r.name, amount, assigned: r.assigned });
  }
  return moves;
}

/** Months from..through, each computed on the result of the previous ones: [{ month, moves, total, payoffAssigned }]. */
export function planRoll(data, from, through, payoffId) {
  const d = { ...data, months: [...data.months] };
  const plan = [];
  for (let m = from; m && m <= through; m = addMonths(m, 1)) {
    const moves = rollMoves(d, m, payoffId);
    if (!moves.length) continue;
    const total = moves.reduce((s, x) => s + x.amount, 0);
    const pay = monthView(d, m).groups.flatMap(g => g.rows).find(r => r.id === payoffId);
    plan.push({ month: m, moves, total, payoffAssigned: (pay?.assigned || 0) - total });
    for (const x of moves) d.months.push({ category_id: x.id, month: m, assigned: x.amount, deleted: 0 });
    d.months.push({ category_id: payoffId, month: m, assigned: -total, deleted: 0 });
  }
  return { plan, after: d };
}

export const rollLabel = (total, payoffName, month) => `Rolled ${fmt(total)} overspending → ${payoffName} (${month})`;

/** Applies a plan: one history batch per month. Allowed in closed months (it's a system adjustment). */
export async function applyRoll(plan, payoffId, payoffName) {
  for (const p of plan) {
    beginBatch(rollLabel(p.total, payoffName, p.month));
    try {
      for (const x of p.moves) await assign(x.id, p.month, x.assigned + x.amount);
      await assign(payoffId, p.month, p.payoffAssigned);
      // What left each category, for card coverage. In the batch, so Undo removes it with the roll.
      await setPref('rolled:' + p.month, JSON.stringify(Object.fromEntries(p.moves.map(x => [x.id, x.amount]))));
    } finally { endBatch(); }
  }
}

/** Earliest month with card spending (start of "roll existing overspending now"). */
export function firstCardMonth(data) {
  const cards = new Set(data.accounts.filter(a => a.type === 'credit').map(a => a.id));
  return data.txs.filter(t => cards.has(t.account_id)).map(t => t.date.slice(0, 7)).sort()[0] || null;
}

/**
 * Runs any rolls that are due: every ended month after rolled_through (or up to a closed month).
 * Returns { rolled, notice, after } where after is the data as it will be once the writes land.
 */
export async function autoRoll(data) {
  if (!canChangeAll()) return { rolled: 0, after: data };
  const s = rollSettings(data);
  if (!s.on) return { rolled: 0, after: data };
  const payoff = data.categories.find(c => c.id === s.payoff && !c.deleted);
  if (!payoff) {
    await setPref('roll_card_overspending', '0');
    return { rolled: 0, after: data, notice: 'Your card payoff category was deleted, so rolling card overspending is off. Pick a category under Settings to turn it back on.' };
  }
  const closed = data.prefs?.closed_through || null;
  let through = addMonths(ym(), -1);
  if (closed && closed > through && closed <= ym()) through = closed;
  if (s.through && s.through >= through) return { rolled: 0, after: data };
  const from = s.through ? addMonths(s.through, 1) : through;
  const { plan, after } = planRoll(data, from, through, s.payoff);
  await applyRoll(plan, s.payoff, payoff.name);
  await setPref('rolled_through', through);   // outside the batches: undoing a roll doesn't make it run again
  return { rolled: plan.reduce((t, p) => t + p.total, 0), after, plan };
}

// ---- Payday forecast ----------------------------------------------------------
/**
 * Projected balance of each spending account (checking, savings, cash; on budget) for the next
 * `days` days: today's balance, then future-dated transactions and every scheduled occurrence
 * (overdue ones count as today). Same-day outflows come before income, to stay on the safe side.
 * For each account: the next payday (first scheduled income into it), the lowest point before then
 * (or in the whole window without a payday), and the first day it would go below zero.
 */
export function cashForecast(data, days = 35) {
  const t0 = today(), end = addDays(t0, days);
  const accts = data.accounts.filter(a => !a.closed && a.on_budget !== 0 && a.type !== 'credit' && a.type !== 'loan');
  const byId = Object.fromEntries(accts.map(a => [a.id, { a, start: 0, events: [] }]));
  const name = Object.fromEntries(data.accounts.map(a => [a.id, a.name]));
  for (const t of data.txs) {
    const f = byId[t.account_id]; if (!f) continue;
    if (t.date <= t0) f.start += t.amount;
    else if (t.date <= end) f.events.push({ date: t.date, amount: t.amount, label: t.payee || 'Transaction', entered: true });
  }
  for (const s of data.scheduled) {
    let cur = s.next_date, n = 0;
    while (cur <= end && n++ < 120) {
      const date = cur < t0 ? t0 : cur;
      if (s.transfer_to) {
        const a = Math.abs(s.amount);
        byId[s.account_id]?.events.push({ date, amount: -a, label: `Transfer to ${name[s.transfer_to] || 'account'}`, sid: s.id });
        byId[s.transfer_to]?.events.push({ date, amount: a, label: `Transfer from ${name[s.account_id] || 'account'}`, sid: s.id });
      } else byId[s.account_id]?.events.push({ date, amount: s.amount, label: s.payee || 'Scheduled', sid: s.id, income: s.amount > 0 });
      cur = advance(cur, s.frequency);
    }
  }
  // Your pay schedule (when you get paid, no amount) decides payday when it's set; otherwise the
  // first scheduled income into the account does.
  const paydays = paydaysBetween(data, t0, end);
  return Object.values(byId).map(f => {
    f.events.sort((x, y) => x.date.localeCompare(y.date) || x.amount - y.amount);
    let bal = f.start;
    for (const e of f.events) { bal += e.amount; e.balance = bal; }
    const payday = paydays.length ? { ...paydays[0], fromSchedule: true } : f.events.find(e => e.income) || null;
    f.paydays = paydays;
    const before = payday ? f.events.filter(e => e.date < payday.date || (e.date === payday.date && e.amount < 0)) : f.events;
    let low = { date: t0, balance: f.start };
    for (const e of before) if (e.balance < low.balance) low = { date: e.date, balance: e.balance, label: e.label };
    const short = f.start < 0 ? { date: t0, balance: f.start } : before.find(e => e.balance < 0) || null;
    return { ...f, end: bal, payday, low, short, scheduled: f.events.some(e => e.sid) };
  }).sort((x, y) => (y.scheduled - x.scheduled) || (x.a.sort - y.a.sort));
}

// ---- Debt payoff planner --------------------------------------------------------
/** Debts = credit cards and loans that are owed. APR and minimum payment live in prefs (debt:<id>). */
export { debtList } from './budget.js';   // lives with the card math, which funds cards in plan order

/**
 * Month-by-month payoff. Every month: interest is added, each debt gets its minimum, and the extra
 * (plus minimums freed by debts already paid off, when rollover) goes to the first unpaid debt in
 * order: snowball = smallest balance first, avalanche = highest APR first.
 * Returns { months, never, interest, totals: [owed after each month], paidOff: {id: month}, first: {id: payment} }.
 */
export function planPayoff(debts, extra = 0, strategy = 'snowball', rollover = true) {
  const ds = debts.filter(d => d.balance > 0).map(d => ({ ...d, bal: d.balance }));
  const order = [...ds].sort(strategy === 'avalanche' ? (a, b) => b.apr - a.apr || a.bal - b.bal : (a, b) => a.bal - b.bal || b.apr - a.apr);
  const monthly = ds.reduce((s, d) => s + d.min, 0) + extra;
  const totals = [ds.reduce((s, d) => s + d.bal, 0)], paidOff = {}, first = {};
  let interest = 0, m = 0, never = false;
  while (ds.some(d => d.bal > 0)) {
    if (++m > 600) { never = true; break; }
    for (const d of ds) if (d.bal > 0) { const i = Math.round(d.bal * d.apr / 1200); d.bal += i; interest += i; }
    let pool = rollover ? monthly : extra;
    const pay = {};
    for (const d of ds) if (d.bal > 0) { const p = Math.min(d.min, d.bal); d.bal -= p; pay[d.id] = p; if (rollover) pool -= p; }
    for (const d of order) if (d.bal > 0 && pool > 0) { const p = Math.min(pool, d.bal); d.bal -= p; pool -= p; pay[d.id] = (pay[d.id] || 0) + p; }
    for (const d of ds) if (d.bal <= 0 && paidOff[d.id] == null) paidOff[d.id] = m;
    if (m === 1) Object.assign(first, pay);
    const owed = ds.reduce((s, d) => s + Math.max(0, d.bal), 0);
    if (m === 1 && owed >= totals[0]) { never = true; totals.push(owed); break; }   // payments don't cover the interest
    totals.push(owed);
  }
  return { months: never ? null : m, never, interest, totals, paidOff, first, order: order.map(d => d.id), monthly };
}

/** Every scheduled occurrence from today to `end` (overdue ones count as today), all accounts. */
export function scheduleOccurrences(data, end) {
  const t0 = today(), out = [];
  for (const s of data.scheduled) {
    let cur = s.next_date, n = 0;
    while (cur <= end && n++ < 400) { out.push({ date: cur < t0 ? t0 : cur, s, next: n === 1 }); cur = advance(cur, s.frequency); }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ---- Plan check: spending above plan, and scheduled charges that cost more than scheduled --------
const words = s => (s || '').toLowerCase().replace(/#\s*\d+/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
/** Spent above a monthly target this month (cents), or 0. Covered or not; targets by a date don't count. */
export const overPlan = c => (c.target > 0 && c.goal_type !== 'by_date' ? Math.max(0, -Math.min(0, c.activity) - c.target) : 0);

export function planCheck(data, month) {
  const v = monthView(data, month);
  const cats = v.groups.flatMap(g => g.rows).filter(c => overPlan(c) > 0).map(c => ({ c, spent: -Math.min(0, c.activity), over: overPlan(c) })).sort((a, b) => b.over - a.over);
  // A scheduled bill whose latest real charge (matched by payee, last 45 days) is higher than scheduled.
  const since = addDays(today(), -45);
  const charges = [];
  for (const s of data.scheduled) {
    if (s.transfer_to || !(s.amount < 0)) continue;
    const key = words(s.payee); if (key.length < 3) continue;
    const hits = data.txs.filter(t => t.amount < 0 && !t.transfer_id && t.date >= since && t.payee && t.payee !== 'Starting balance' && (words(t.payee).includes(key) || (words(t.payee).length >= 3 && key.includes(words(t.payee)))))
      .sort(newestFirst);
    const t = hits[0];
    if (t && -t.amount > -s.amount + 50) charges.push({ s, t, planned: -s.amount, charged: -t.amount });
  }
  return { cats, charges };
}

// ---- Covering overspending ---------------------------------------------------
/**
 * Categories that can spare money this month, best first: no target and no bills (0), then ones that
 * keep enough for their monthly target or the bills still due this month (1), then savings goals (2).
 * [{ id, name, group_name, assigned, available, spare, tier, keeps, why }]
 */
export function spareCategories(data, month, v = monthView(data, month)) {
  const payoffId = data.prefs?.payoff_category_id || null;
  const end = month + '-31';
  const bills = {};
  for (const o of scheduleOccurrences(data, end)) if (o.date.slice(0, 7) === month && o.s.category_id && o.s.amount < 0) bills[o.s.category_id] = (bills[o.s.category_id] || 0) - o.s.amount;
  const out = [];
  for (const g of v.groups) for (const r of g.rows) {
    if (r.available <= 0 || r.id === payoffId) continue;
    const goal = r.target > 0 && r.goal_type === 'by_date';
    const plan = r.target > 0 && !goal ? Math.max(0, r.target + Math.min(0, r.activity)) : 0;   // target not yet spent
    const due = bills[r.id] || 0;
    const keeps = Math.max(plan, due);
    const spare = r.available - keeps;
    if (spare <= 0) continue;
    out.push({ ...r, spare, keeps, tier: goal ? 2 : keeps ? 1 : 0, why: goal ? 'savings goal' : keeps ? `keeps ${fmt(keeps)} for ${due >= plan ? 'bills due' : 'its target'}` : '' });
  }
  return out.sort((a, b) => a.tier - b.tier || b.spare - a.spare);
}

/** Next month's money already used to cover this month's overspending (cents, positive). */
export const borrowedFromNext = (data, month) => monthView(data, month).borrowed_from_next;   // only what still counts (a stale borrow is dropped)

/**
 * Covers `amount` of the overspending in categories `ids` (in order), paid from `src`: 'rta' (Ready to
 * Assign), 'next' (next month's money) or a category id; caps ({ id: cents }) limits each category,
 * for covering only the cash part. One history batch, so Undo puts it back.
 */
export async function coverFrom(data, month, ids, src, amount, label, caps = null) {
  const v = monthView(data, month);
  const rows = v.groups.flatMap(g => g.rows);
  beginBatch(label);
  try {
    let left = amount;
    const took = [];
    for (const id of ids) {
      const r = rows.find(x => x.id === id);
      if (!r || r.available >= 0 || left <= 0) continue;
      const take = Math.min(left, -r.available, caps ? caps[r.id] ?? 0 : Infinity);
      if (take <= 0) continue;
      await assign(r.id, month, r.assigned + take);
      took.push({ cat: r.id, amount: take });
      left -= take;
    }
    const used = amount - left;
    if (src === 'next') {
      // The borrow itself (what the math uses), and what it covered (so it can be shown until repaid).
      const kept = borrowItems(data, month).items.filter(x => x.owed > 0).map(x => ({ cat: x.cat, amount: x.owed, date: x.date }));
      await assign(BORROW, addMonths(month, 1), -(borrowedFromNext(data, month) + used));
      await setPref(borrowKey(month), JSON.stringify([...kept, ...took.map(t => ({ ...t, date: today() }))]));
    }
    else if (src !== 'rta') { const s = rows.find(x => x.id === src); await assign(src, month, s.assigned - used); }
    if (src !== 'next' && took.length) {
      // Where each cover came from, so both categories can say so and link to each other.
      let log = []; try { log = JSON.parse(data.prefs?.[coverKey(month)] || '[]'); } catch {}
      await setPref(coverKey(month), JSON.stringify([...log, ...took.map(t => ({ to: t.cat, from: src, amount: t.amount, date: today() }))].slice(-60)));
    }
    return used;
  } finally { endBatch(); }
}

/**
 * What a category spent this month, by how it was paid: { spent, card, cash, cards: [{ id, name, amount }] }
 * (cents, positive). card = on-budget credit cards; cash = everything else (checking, savings, cash).
 */
export function spendSplit(data, month, catId) {
  const acct = Object.fromEntries(data.accounts.map(a => [a.id, a]));
  const by = {};
  for (const t of data.txs) if (t.category_id === catId && !t.transfer_id && t.date.slice(0, 7) === month) by[t.account_id] = (by[t.account_id] || 0) - t.amount;
  const out = { spent: 0, card: 0, cash: 0, cards: [] };
  for (const [id, amt] of Object.entries(by)) {
    if (amt <= 0) continue;
    const a = acct[id];
    out.spent += amt;
    if (a && a.type === 'credit') { out.card += amt; out.cards.push({ id, name: a.name, amount: amt }); } else out.cash += amt;
  }
  out.cards.sort((x, y) => y.amount - x.amount);
  return out;
}

/**
 * The card part of a category's overspending this month (what would roll to the payoff category at
 * month end), or 0 when rolling is off, the month has ended, or it's the payoff category itself.
 */
export function cardPartOfOverspend(data, month, row) {
  const s = rollSettings(data);
  if (!s.on || !s.payoff || row.id === s.payoff || row.available >= 0 || month < ym()) return 0;
  const onCards = spendSplit(data, month, row.id).cards.filter(c => data.accounts.find(a => a.id === c.id)?.on_budget).reduce((t, c) => t + c.amount, 0);
  return Math.min(-row.available, onCards);
}

/** Clears the part of a "take from next month" that no longer covers anything. */
export async function clearStaleBorrow(sb, data) {
  const month = addMonths(sb.month, -1);
  beginBatch(`Cleared a leftover ${fmt(sb.extra)} taken from next month`);
  try {
    await assign(BORROW, sb.month, -sb.used);
    if (data) await setPref(borrowKey(month), JSON.stringify(borrowItems(data, month).items.filter(x => x.owed > 0).map(x => ({ cat: x.cat, amount: x.owed, date: x.date }))));
  } finally { endBatch(); }
}

// ---- Money borrowed from next month ------------------------------------------
/** The record of what a month's borrows from the next month covered: household_prefs "borrow:<month>". */
export const borrowKey = month => 'borrow:' + month;
/**
 * What `month` borrowed from the next month, and what for: { owed, items: [{ cat, name, date, amount,
 * owed }] }. owed is what still counts (money that came in later has paid the oldest back first). Borrows
 * from before this was recorded show as one item with no category.
 */
export function borrowItems(data, month) {
  const owed = monthView(data, month).borrowed_from_next;
  let log = []; try { log = JSON.parse(data.prefs?.[borrowKey(month)] || '[]'); } catch {}
  const name = id => data.categories.find(c => c.id === id)?.name || 'A deleted category';
  const total = log.reduce((s, x) => s + x.amount, 0);
  let repaid = Math.max(0, total - owed);
  const items = log.map(x => { const r = Math.min(repaid, x.amount); repaid -= r; return { ...x, name: name(x.cat), owed: x.amount - r }; });
  if (owed > total) items.push({ cat: null, name: 'Overspending', date: null, amount: owed - total, owed: owed - total });
  return { owed, items };
}

/** Undoes one borrow item: the category gives back what's still owed (it's overspent again), and the borrow shrinks. */
export async function undoBorrow(data, month, item) {
  const v = monthView(data, month);
  const row = v.groups.flatMap(g => g.rows).find(r => r.id === item.cat);
  const { items } = borrowItems(data, month);
  beginBatch(`Undid ${fmt(item.owed)} from ${new Date(addMonths(month, 1) + '-15').toLocaleString(undefined, { month: 'long' })}'s money${row ? ' for ' + row.name : ''}`);
  try {
    if (row) await assign(row.id, month, row.assigned - item.owed);
    await assign(BORROW, addMonths(month, 1), -(v.borrowed_from_next - item.owed));
    await setPref(borrowKey(month), JSON.stringify(items.filter(x => x !== items.find(y => y.cat === item.cat && y.date === item.date)).filter(x => x.owed > 0 && x.cat).map(x => ({ cat: x.cat, amount: x.owed, date: x.date }))));
  } finally { endBatch(); }
}

// ---- Where covers came from ------------------------------------------------------
/** household_prefs "covers:<month>": [{ to, from ('rta' or a category id), amount, date }], newest last. */
export const coverKey = month => 'covers:' + month;
/** This month's covers into and out of a category: { got: [...], gave: [...] } (newest first). */
export function coverNotes(data, month, catId) {
  let log = []; try { log = JSON.parse(data.prefs?.[coverKey(month)] || '[]'); } catch {}
  const name = id => (id === 'rta' ? 'Ready to assign' : data.categories.find(c => c.id === id)?.name || 'a deleted category');
  const got = log.filter(x => x.to === catId).map(x => ({ ...x, other: x.from, otherName: name(x.from) })).reverse();
  const gave = log.filter(x => x.from === catId).map(x => ({ ...x, other: x.to, otherName: name(x.to) })).reverse();
  return { got, gave };
}
/** Opens a category on the Budget tab (in `month`), from anywhere on it. */
export const goCat = (id, month) => dispatchEvent(new CustomEvent('budget:gocat', { detail: { id, month } }));
