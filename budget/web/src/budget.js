// Client-side budget math, identical rules to server/budget.js so the app
// works fully offline. See that file for the credit-card reasoning.
import { liveRows } from './store.js';

export const HOLD = '__hold__';
// "Take from next month's money": a budget_months row with this id and month M holds a negative
// amount. It covers overspending in M-1 (that month's Ready to Assign doesn't change) and comes off
// M's Ready to Assign. Like HOLD it's never a spendable category.
export const BORROW = '__borrow__';
export const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
export const ym = d => (d ? d.toISOString() : today()).slice(0, 7);
export const addMonths = (m, n) => {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};
export const monthLabel = m => new Date(m + '-15').toLocaleString(undefined, { month: 'long', year: 'numeric' });

/** Money that was already yours when you added an account: not income, though it lands in Ready to Assign. */
export function startingIn(data, month) {
  const on = new Set(data.accounts.filter(a => a.on_budget).map(a => a.id));
  return data.txs.filter(t => t.payee === 'Starting balance' && t.amount > 0 && on.has(t.account_id) && t.date.slice(0, 7) === month && !t.deleted).reduce((s, t) => s + t.amount, 0);
}

export function balances(accounts, txs) {
  const bal = {}, clr = {}, tip = {};
  for (const t of txs) {
    bal[t.account_id] = (bal[t.account_id] || 0) + t.amount;
    if (t.cleared > 0) clr[t.account_id] = (clr[t.account_id] || 0) + t.amount;
    else if (t.tip_pending > 0) tip[t.account_id] = (tip[t.account_id] || 0) + t.tip_pending;
  }
  // tips_pending: tips already counted in the balance that the bank hasn't posted, so the bank shows
  // balance + tips_pending until they do.
  return accounts.map(a => ({ ...a, balance: bal[a.id] || 0, cleared_balance: clr[a.id] || 0, tips_pending: tip[a.id] || 0 }))
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
}

export async function loadAll() {
  const [accounts, groups, categories, months, txs, scheduled, rules, prefRows] = await Promise.all(
    ['accounts', 'category_groups', 'categories', 'budget_months', 'transactions', 'scheduled', 'payee_rules', 'household_prefs'].map(liveRows));
  const prefs = Object.fromEntries(prefRows.map(r => [r.id, r.value]));
  // Accounts in the order you arranged them (the database returns them by id), so "first account"
  // defaults and every account list are predictable.
  accounts.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name));
  return { accounts, groups, categories, months, txs, scheduled, rules, prefs };
}

export function monthView({ accounts, groups, categories, months, txs, prefs }, month) {
  const onBudget = new Set(accounts.filter(a => a.on_budget).map(a => a.id));
  const assignedNow = {}, assignedThrough = {}, actNow = {}, actThrough = {};
  let assignedFuture = 0, cash = 0;

  for (const b of months) {
    if (b.month === month) assignedNow[b.category_id] = (assignedNow[b.category_id] || 0) + b.assigned;
    if (b.month <= month) assignedThrough[b.category_id] = (assignedThrough[b.category_id] || 0) + b.assigned;
    else assignedFuture += b.assigned;
  }
  let incomeUncat = 0;
  for (const t of txs) {
    const m = t.date.slice(0, 7);
    if (m <= month && onBudget.has(t.account_id)) cash += t.amount;
    if (!t.category_id) { if (m === month && t.amount > 0 && !t.transfer_id && onBudget.has(t.account_id)) incomeUncat += t.amount; continue; }
    if (m === month) actNow[t.category_id] = (actNow[t.category_id] || 0) + t.amount;
    if (m <= month) actThrough[t.category_id] = (actThrough[t.category_id] || 0) + t.amount;
  }

  const gmap = Object.fromEntries(groups.map(g => [g.id, g]));
  const incomeCatIds = new Set(categories.filter(c => gmap[c.group_id]?.is_income).map(c => c.id));
  const income = categories.filter(c => incomeCatIds.has(c.id)).map(c => ({ ...c, group_name: gmap[c.group_id].name, activity: actNow[c.id] || 0, total: actThrough[c.id] || 0 }));
  const rows = categories
    .filter(c => gmap[c.group_id] && !incomeCatIds.has(c.id))
    .map(c => ({
      ...c,
      group_name: gmap[c.group_id].name,
      group_sort: gmap[c.group_id].sort,
      assigned: assignedNow[c.id] || 0,
      activity: actNow[c.id] || 0,
      available: (assignedThrough[c.id] || 0) + (actThrough[c.id] || 0),
    }))
    .sort((a, b) => a.group_sort - b.group_sort || a.sort - b.sort || a.name.localeCompare(b.name));

  // The payoff category holds card debt (rolled overspending, starting balances). Paying a card down
  // beyond its Ready to pay pays that debt, so the category shows only what's still held, and the
  // payment comes out of Ready to Assign (the cash is gone). See payoffHeld.
  const payoffRow = prefs?.payoff_category_id ? rows.find(r => r.id === prefs.payoff_category_id) : null;
  let paidDown = 0;
  if (payoffRow) {
    const availByCat = Object.fromEntries(rows.map(r => [r.id, r.available]));
    paidDown = payoffHeld({ accounts, txs, prefs }, month, availByCat).paidDown;
    payoffRow.available += paidDown;
    payoffRow.paid_down = paidDown;
  }
  const totalAvailable = rows.reduce((s, r) => s + r.available, 0);
  const next = addMonths(month, 1);
  const heldForNext = months.filter(b => b.category_id === HOLD && b.month === next).reduce((s, b) => s + b.assigned, 0);
  const heldFromPrev = months.filter(b => b.category_id === HOLD && b.month === month).reduce((s, b) => s + b.assigned, 0);
  const sumAt = (id, m) => months.filter(b => b.category_id === id && b.month === m).reduce((s, b) => s + b.assigned, 0);
  const byGroup = [...groups].filter(g => !g.is_income).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
    .map(g => ({ id: g.id, name: g.name, rows: [], assigned: 0, activity: 0, available: 0 }));
  for (const r of rows) {
    const g = byGroup.find(x => x.id === r.group_id);
    g.rows.push(r); g.assigned += r.assigned; g.activity += r.activity; g.available += r.available;
  }
  return {
    month,
    ready_to_assign: cash - totalAvailable - assignedFuture,
    assigned_future: assignedFuture,
    held_for_next: heldForNext,
    held_from_prev: heldFromPrev,
    borrowed_from_next: -sumAt(BORROW, next),   // next month's money used to cover overspending here
    borrowed_by_prev: -sumAt(BORROW, month),    // this month's money that covered last month's overspending
    cash,
    income,                                   // income categories with this month's activity
    income_total: income.reduce((s, c) => s + c.activity, 0) + (incomeUncat || 0),
    income_uncategorized: incomeUncat || 0,   // inflows with no category this month
    groups: byGroup,
    totals: { assigned: rows.reduce((s, r) => s + r.assigned, 0), activity: rows.reduce((s, r) => s + r.activity, 0), available: totalAvailable },
  };
}

// --- card debt held in the payoff category -------------------------------------
/**
 * Per on-budget credit card, through `month`: what went into the payoff category from it (purchases
 * categorized there, such as starting balances, plus its share of overspending rolled there) and how
 * much of that it still owes. A payment first uses the card's Ready to pay (purchases its categories
 * paid for), then pays this debt; it never pays down debt from overspent categories or uncategorized
 * purchases first. availByCat: each category's available this month, before this adjustment.
 * { byCard: { id: { putIn, held } }, paidDown }
 */
export function payoffHeld({ accounts, txs, prefs }, month, availByCat) {
  const payoff = prefs?.payoff_category_id;
  const out = { byCard: {}, paidDown: 0 };
  if (!payoff) return out;
  const cards = new Set(accounts.filter(a => a.type === 'credit' && a.on_budget).map(a => a.id));
  if (!cards.size) return out;
  const rolled = {}, rolledFrom = {};
  for (const [k, val] of Object.entries(prefs || {})) {
    if (!k.startsWith('rolled:') || k.slice(7) > month) continue;
    try { rolled[k.slice(7)] = JSON.parse(val); for (const [cid, amt] of Object.entries(rolled[k.slice(7)])) rolledFrom[cid] = (rolledFrom[cid] || 0) + amt; } catch {}
  }
  // One pass in date order per card. Debt from categories (purchases they paid for, overspending,
  // uncategorized) and debt held in the payoff category are tracked apart; a payment or refund pays
  // the category debt that exists at that moment first, then the held debt. So a payment made before
  // later purchases pays the held debt, and those purchases stay Ready to pay.
  const byCard = {};
  for (const t of txs) if (cards.has(t.account_id) && t.date.slice(0, 7) <= month) (byCard[t.account_id] ||= []).push(t);
  const bal = {}, uncat = {}, spent = {}, inMonth = {};
  for (const [id, list] of Object.entries(byCard)) for (const t of list) {
    const m = t.date.slice(0, 7);
    bal[id] = (bal[id] || 0) + t.amount;
    if (t.transfer_id || t.amount >= 0 || !t.category_id || t.category_id === payoff) { if (!t.transfer_id && t.amount < 0 && !t.category_id) uncat[id] = (uncat[id] || 0) - t.amount; continue; }
    ((spent[id] ||= {})[t.category_id] = (spent[id][t.category_id] || 0) - t.amount);
    if (rolled[m]?.[t.category_id]) (((inMonth[m] ||= {})[t.category_id] ||= {})[id] = (inMonth[m][t.category_id][id] || 0) - t.amount);
  }
  // Rolled overspending lands on each card at the end of its month, split by that month's purchases.
  const rollAt = {};
  for (const [m, moved] of Object.entries(rolled)) for (const [cid, amt] of Object.entries(moved)) {
    const by = inMonth[m]?.[cid] || {};
    const ids = Object.keys(by), tot = ids.reduce((s, id) => s + by[id], 0);
    if (!tot) continue;
    let rest = amt;
    ids.forEach((id, i) => { const share = i === ids.length - 1 ? rest : Math.round(amt * by[id] / tot); ((rollAt[id] ||= {})[m] = (rollAt[id][m] || 0) + share); rest -= share; });
  }
  for (const id of cards) {
    const list = (byCard[id] || []).slice().sort((a, b) => a.date.localeCompare(b.date) || (a.created_at || 0) - (b.created_at || 0));
    const ends = Object.keys(rollAt[id] || {}).sort();
    let held = 0, other = 0, put = 0, e = 0;
    const roll = upTo => { while (e < ends.length && ends[e] < upTo) { const a = rollAt[id][ends[e++]]; held += a; other = Math.max(0, other - a); put += a; } };
    for (const t of list) {
      roll(t.date.slice(0, 7));
      if (t.amount < 0) {
        if (t.category_id === payoff && !t.transfer_id) { held -= t.amount; put -= t.amount; } else other -= t.amount;
      } else {
        const toOther = Math.min(t.amount, Math.max(0, other));
        other -= toOther;
        held = Math.max(0, held - (t.amount - toOther));
      }
    }
    roll('9999-99');
    const debt = Math.max(0, -(bal[id] || 0));
    let over = 0;
    for (const [cid, amt] of Object.entries(spent[id] || {})) { const a = availByCat[cid] ?? 0; if (a < 0) over += Math.min(-a, Math.max(0, amt - (rolledFrom[cid] || 0))); }
    const base = Math.min(debt, (uncat[id] || 0) + over);
    held = Math.min(held, Math.max(0, debt - base));
    out.byCard[id] = { putIn: put, held };
    out.paidDown += put - held;
  }
  return out;
}

// --- credit card coverage ----------------------------------------------------
/**
 * How much of a card's debt is already backed by money sitting in categories.
 * Debt is uncovered when it came from (a) uncategorized outflows on the card
 * (starting balance, forgotten category) or (b) spending in a category that is
 * now overspent (the category didn't have the money when you swiped).
 * ready_to_pay = debt - uncovered. Paying that amount leaves the budget whole.
 */
export function cardCoverage(acct, data, month) {
  return coverageAll(data, month)[acct.id] || { debt: 0, uncovered: 0, ready: 0, uncategorized: 0, overspent: 0, rolled: 0 };
}

/**
 * Coverage for every credit card. Debt is uncovered when it came from (a) uncategorized outflows,
 * (b) the card's share of spending in categories now overspent, or (c) the payoff category's
 * shortfall: card overspending rolled there at month end (and starting balances put there), counted
 * on the card it came from and paid off in debt plan order (see below).
 */
export function coverageAll(data, month) {
  const v = monthView(data, month);
  const availByCat = {};
  for (const g of v.groups) for (const r of g.rows) availByCat[r.id] = r.available;
  const payoff = data.prefs?.payoff_category_id || null;
  // Card spending already rolled into the payoff category, per category (household_prefs 'rolled:YYYY-MM',
  // written in the same undoable batch as the roll). That share is counted in (c), not again in (b).
  const rolledFrom = {};
  for (const [k, val] of Object.entries(data.prefs || {})) {
    if (!k.startsWith('rolled:') || k.slice(7) > month) continue;
    try { for (const [cid, amt] of Object.entries(JSON.parse(val))) rolledFrom[cid] = (rolledFrom[cid] || 0) + amt; } catch {}
  }
  const out = {};
  for (const acct of data.accounts.filter(a => a.type === 'credit')) {
    const txs = data.txs.filter(t => t.account_id === acct.id);
    const debt = Math.max(0, -txs.reduce((s, t) => s + t.amount, 0));
    if (debt === 0) { out[acct.id] = { debt: 0, uncovered: 0, ready: 0, uncategorized: 0, overspent: 0, rolled: 0 }; continue; }
    let uncategorized = 0;
    for (const t of txs) if (!t.transfer_id && !t.category_id && t.amount < 0) uncategorized += -t.amount;
    const spentOnCardByCat = {};
    for (const t of txs) if (t.category_id && t.category_id !== payoff && t.amount < 0 && t.date.slice(0, 7) <= month) spentOnCardByCat[t.category_id] = (spentOnCardByCat[t.category_id] || 0) + -t.amount;
    let overspent = 0;
    for (const [cid, spent] of Object.entries(spentOnCardByCat)) {
      const avail = availByCat[cid] ?? 0;
      if (avail < 0) overspent += Math.min(-avail, Math.max(0, spent - (rolledFrom[cid] || 0)));
    }
    const base = Math.min(debt, uncategorized + overspent);
    out[acct.id] = { debt, base, uncategorized, overspent, rolled: 0, onBudget: !!acct.on_budget };
  }
  // (c) The payoff category's debt: card overspending rolled there, plus card purchases categorized to
  // it (starting balances), each counted on the card it was on. Money assigned to the payoff category
  // pays them off in your debt plan's order (minimums first, then snowball or avalanche), or, with
  // that switched off, in proportion to what came from each card.
  const deficit = payoff && (availByCat[payoff] ?? 0) < 0 ? -availByCat[payoff] : 0;
  const cards = Object.entries(out).filter(([, c]) => c.onBudget && c.debt > c.base);
  // What each card still owes in the payoff category, counted in date order (payoffHeld).
  const held = payoffHeld(data, month, availByCat).byCard;
  // The category shows what's still held (payments already taken off), so what's assigned to it,
  // up to what the cards still owe there, is money set aside for the next payment.
  for (const [id, c] of cards) c.owed = Math.min(held[id]?.held || 0, c.debt - c.base);
  const totalOwed = cards.reduce((s, [, c]) => s + c.owed, 0);
  if (totalOwed > 0) {
    let funded = Math.max(0, totalOwed - deficit);
    const fund = {};
    if (data.prefs?.roll_fund_by_plan !== '0') {
      const plan = Object.fromEntries(debtList(data).map(d => [d.id, d]));
      const strategy = data.prefs?.['debt:strategy'] || 'snowball';
      const list = cards.map(([id, c]) => ({ id, c, d: plan[id] || { balance: c.debt, apr: 0, min: 0, excluded: false } }));
      list.sort((a, b) => (a.d.excluded - b.d.excluded) || (strategy === 'avalanche' ? b.d.apr - a.d.apr || a.d.balance - b.d.balance : a.d.balance - b.d.balance || b.d.apr - a.d.apr));
      for (const x of list) { const p = Math.min(funded, x.d.excluded ? 0 : x.d.min, x.c.owed); fund[x.id] = p; funded -= p; }
      for (const x of list) { const p = Math.min(funded, x.c.owed - fund[x.id]); fund[x.id] += p; funded -= p; }
    } else {
      // Your own order (Budget rules › Credit card overspending): the first card gets it all until it's
      // covered, then the next. Cards you haven't placed come after, biggest debt first.
      let pick = []; try { pick = JSON.parse(data.prefs?.roll_fund_order || '[]'); } catch {}
      const rank = id => { const i = pick.indexOf(id); return i < 0 ? 1e9 : i; };
      const list = [...cards].sort(([a, x], [b, y]) => rank(a) - rank(b) || y.owed - x.owed);
      for (const [id, c] of list) { const p = Math.min(funded, c.owed); fund[id] = p; funded -= p; }
    }
    for (const [id, c] of cards) { c.rolled = c.owed - (fund[id] || 0); c.fromPayoff = fund[id] || 0; }
  } else {
    // Older data with no record of where the debt came from: split by what each card can still take.
    const room = cards.reduce((s, [, c]) => s + c.debt - c.base, 0);
    let left = Math.min(deficit, room);
    cards.forEach(([, c], i) => {
      const share = i === cards.length - 1 ? left : Math.min(left, Math.round(deficit * (c.debt - c.base) / room));
      c.rolled = Math.min(share, c.debt - c.base); left -= c.rolled;
      c.fromPayoff = 0;
    });
  }
  for (const c of Object.values(out)) {
    if (c.base === undefined) continue;
    c.uncovered = Math.min(c.debt, c.base + c.rolled);
    c.ready = c.debt - c.uncovered;
    delete c.base; delete c.onBudget; delete c.owed;
  }
  return out;
}

// --- goals -----------------------------------------------------------------
/**
 * How much this category still needs to be assigned this month to stay on its goal.
 * c needs target, available and assigned (this month), as monthView rows have.
 * - Monthly target: funded once this month's assignment reaches the target, or the category
 *   already holds that much (carried over). Spending what you assigned doesn't make it "need" more.
 * - Save by a date: this month's share of what was still missing at the start of the month,
 *   less what's been assigned this month.
 */
export function goalNeed(c, month) {
  if (!c.target) return 0;
  const assigned = Math.max(0, c.assigned || 0);
  if (c.goal_type === 'by_date' && c.goal_date) {
    const target = c.goal_date.slice(0, 7);
    if (month > target || c.available >= c.target) return 0;
    const [y1, m1] = month.split('-').map(Number), [y2, m2] = target.split('-').map(Number);
    const monthsLeft = (y2 - y1) * 12 + (m2 - m1) + 1;           // including this month
    const missingAtStart = Math.max(0, c.target - (c.available - assigned));
    return Math.max(0, Math.ceil(missingAtStart / monthsLeft) - assigned);
  }
  return Math.max(0, c.target - Math.max(assigned, c.available));
}
/** Share of the goal covered, 0..1 (for progress bars). */
export function goalProgress(c, month) {
  if (!c.target) return 0;
  const need = goalNeed(c, month);
  if (c.goal_type === 'by_date') return Math.max(0, Math.min(1, c.available / c.target));
  return Math.max(0, Math.min(1, 1 - need / c.target));
}
export const monthsUntil = (month, dateIso) => { const [y1, m1] = month.split('-').map(Number), [y2, m2] = dateIso.slice(0, 7).split('-').map(Number); return (y2 - y1) * 12 + (m2 - m1); };

// --- quick-add helpers -----------------------------------------------------
/** For each payee: the category used most often with it, and the last amount. */
export function payeeMemory(txs) {
  const m = {};
  for (const t of txs) {
    if (!t.payee || t.transfer_id) continue;
    const k = t.payee.trim().toLowerCase();
    const e = m[k] || (m[k] = { payee: t.payee, cats: {}, last: 0, lastDate: '' });
    if (t.category_id) e.cats[t.category_id] = (e.cats[t.category_id] || 0) + 1;
    if (t.date >= e.lastDate) { e.lastDate = t.date; e.last = t.amount; }
  }
  for (const e of Object.values(m)) {
    e.category_id = Object.entries(e.cats).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  }
  return m;
}
/** Category ids ordered by how often they were used in the last ~90 days. */
export function frequentCategories(txs, n = 6) {
  const cutoff = addDays(today(), -90);
  const c = {};
  for (const t of txs) if (t.category_id && t.date >= cutoff) c[t.category_id] = (c[t.category_id] || 0) + 1;
  return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, n).map(([id]) => id);
}
export const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
export const dayLabel = iso => {
  const t = today();
  if (iso === t) return 'Today';
  if (iso === addDays(t, -1)) return 'Yesterday';
  return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
};

// --- money formatting ----------------------------------------------------
export const fmt = c => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const parseMoney = s => Math.round(parseFloat(String(s).replace(/[^0-9.-]/g, '') || '0') * 100);

/** When a transaction was entered (ms): its entry time, or for old rows their last change. */
export const stamp = t => t.created_at || t.updated_at || 0;
/** Newest first: by date, then by entry time within a day. */
export const newestFirst = (a, b) => b.date.localeCompare(a.date) || stamp(b) - stamp(a);
/** "Nov 7, 8:42 PM": when a transaction was entered. */
export const stampLabel = t => new Date(stamp(t)).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// --- debts (cards and loans) ----------------------------------------------------
/** Cards and loans you owe on, with APR and minimum (entered in the debt planner, or estimated). */
export function debtList(data) {
  const bal = {};
  for (const t of data.txs) bal[t.account_id] = (bal[t.account_id] || 0) + t.amount;
  let out_ = new Set(); try { out_ = new Set(JSON.parse(data.prefs?.['debt:exclude'] || '[]')); } catch {}
  return data.accounts.filter(a => !a.closed && (a.type === 'credit' || a.type === 'loan') && (bal[a.id] || 0) < 0).map(a => {
    const owed = -bal[a.id];
    let saved = {}; try { saved = JSON.parse(data.prefs?.['debt:' + a.id] || '{}'); } catch {}
    const apr = saved.apr ?? (a.type === 'credit' ? 21 : 6);
    // Typical minimums when none entered: cards ~1% + interest (at least $25); loans paid off in 5 years.
    const r = apr / 1200;
    const est = a.type === 'credit' ? Math.max(2500, Math.round(owed * 0.01 + owed * r)) : Math.round(r ? owed * r / (1 - Math.pow(1 + r, -60)) : owed / 60);
    return { id: a.id, name: a.name, type: a.type, balance: owed, apr, min: Math.min(owed, saved.min ?? est), aprSet: saved.apr != null, minSet: saved.min != null, excluded: out_.has(a.id) };
  });
}

