// Streaks, badges and goal progress. Streaks and goals are worked out from the data each time,
// so every device agrees. Badges are remembered as budget settings ("badge:<id>" = date earned),
// so each one is celebrated once, on whichever device earns it.
import { monthView, ym, addMonths, balances, today, addDays } from './budget.js';
import { ageOfMoney, fillToTargets } from './features.js';
import { setPref, canChangeAll } from './store.js';
import { confetti } from './fun.js';

const isStart = t => t.payee === 'Starting balance' || t.payee === 'Reconciliation adjustment';
const firstMonth = data => { let m = null; for (const t of data.txs) if (!isStart(t) && (!m || t.date < m)) m = t.date; return m ? m.slice(0, 7) : null; };

/** Months (oldest first) that ended with no overspent category, counting back from last month. */
function onBudgetMonths(data) {
  const start = firstMonth(data); if (!start) return 0;
  const payoff = data.prefs?.payoff_category_id || null;
  let n = 0;
  for (let m = addMonths(ym(), -1); m >= start && n < 36; m = addMonths(m, -1)) {
    const v = monthView(data, m);
    const used = v.groups.some(g => g.rows.some(r => r.assigned || r.activity));
    if (!used) break;
    if (v.groups.some(g => g.rows.some(r => r.available < 0 && r.id !== payoff))) break;
    n++;
  }
  return n;
}

/** Days in a row (ending today, or yesterday if nothing yet today) with something logged. */
function loggingStreak(data) {
  const days = new Set(data.txs.filter(t => !isStart(t)).map(t => t.date));
  let d = today();
  if (!days.has(d)) d = addDays(d, -1);
  let n = 0;
  while (days.has(d) && n < 3650) { n++; d = addDays(d, -1); }
  return n;
}

/** Days so far this month with no purchase. */
function noSpendDays(data) {
  const m = ym(), t0 = today();
  const spent = new Set(data.txs.filter(t => t.date.slice(0, 7) === m && t.amount < 0 && t.category_id && !t.transfer_id).map(t => t.date));
  return Number(t0.slice(8)) - [...spent].filter(d => d <= t0).length;
}

export function streaks(data) {
  return { logging: loggingStreak(data), onBudget: onBudgetMonths(data), noSpend: noSpendDays(data) };
}

// ---- goals --------------------------------------------------------------------------------------
/**
 * Save-by-date goals: progress, whether you're on track, and when you'll get there at your recent
 * pace (average assigned over the last 3 months).
 */
export function goals(data) {
  const v = monthView(data, ym());
  const out = [];
  for (const g of v.groups) for (const c of g.rows) {
    if (!(c.target > 0 && c.goal_type === 'by_date' && c.goal_date)) continue;
    const pct = Math.max(0, Math.min(1, c.available / c.target));
    const done = c.available >= c.target;
    let pace = 0; for (let i = 0; i < 3; i++) { const b = data.months.find(x => x.category_id === c.id && x.month === addMonths(ym(), -i) && !x.deleted); pace += b?.assigned || 0; }
    pace = Math.max(0, pace / 3);
    const left = Math.max(0, c.target - c.available);
    const monthsNeeded = pace > 0 ? Math.ceil(left / pace) : null;
    const eta = done ? null : monthsNeeded !== null ? addMonths(ym(), monthsNeeded) : null;
    const due = c.goal_date.slice(0, 7);
    out.push({ c, pct, done, eta, due, onTrack: done || (eta !== null && eta <= due), pace, left });
  }
  return out.sort((a, b) => a.done - b.done || a.due.localeCompare(b.due));
}

// ---- badges -------------------------------------------------------------------------------------
const spentPerMonth = data => {
  let s = 0; for (let i = 1; i <= 3; i++) { const v = monthView(data, addMonths(ym(), -i)); for (const g of v.groups) for (const r of g.rows) s += -Math.min(0, r.activity); }
  return s / 3;
};
export const BADGES = [
  { id: 'first', icon: '🌱', title: 'First step', hint: 'Log your first transaction', test: d => d.txs.some(t => !isStart(t)) },
  { id: 'setup', icon: '🧭', title: 'All set up', hint: 'Finish the guided setup', test: d => d.prefs?.['setup:done'] === '1' && d.accounts.length > 0 },
  { id: 'zero', icon: '🎯', title: 'Every dollar has a job', hint: 'Bring Ready to Assign to exactly $0', test: (d, x) => x.rta === 0 && x.assigned > 0 },
  { id: 'reconcile', icon: '🔍', title: 'Matched the bank', hint: 'Reconcile an account', test: d => d.accounts.some(a => a.reconciled_at) },
  { id: 'month', icon: '🛡️', title: 'On budget', hint: 'Finish a month with nothing overspent', test: (d, x) => x.streaks.onBudget >= 1 },
  { id: 'month3', icon: '🏆', title: 'Three in a row', hint: 'Three months in a row with nothing overspent', test: (d, x) => x.streaks.onBudget >= 3 },
  { id: 'log7', icon: '🔥', title: 'On a roll', hint: 'Log something 7 days in a row', test: (d, x) => x.streaks.logging >= 7 },
  { id: 'log30', icon: '🌟', title: 'Habit formed', hint: 'Log something 30 days in a row', test: (d, x) => x.streaks.logging >= 30 },
  { id: 'aom30', icon: '⏳', title: 'A month ahead', hint: 'Age of money reaches 30 days', test: (d, x) => (x.aom ?? 0) >= 30 },
  { id: 'emergency', icon: '🆘', title: 'Safety net', hint: 'Emergency fund covers a month of spending', test: (d, x) => x.emergency },
  { id: 'goal', icon: '🐷', title: 'Goal reached', hint: 'Reach a save-by-date goal', test: (d, x) => x.goals.some(g => g.done) },
  { id: 'card', icon: '💳', title: 'Card cleared', hint: 'Pay a credit card down to $0', test: (d, x) => x.cardPaid },
  { id: 'debtfree', icon: '⛰️', title: 'Debt-free', hint: 'Every card and loan paid off', test: (d, x) => x.debtFree },
];

function facts(data) {
  const v = monthView(data, ym());
  const bal = balances(data.accounts.filter(a => !a.deleted), data.txs);
  const debts = bal.filter(a => a.type === 'credit' || a.type === 'loan');
  const hadDebt = id => data.txs.some(t => t.account_id === id && t.amount < 0);
  const emergencyCat = v.groups.flatMap(g => g.rows).find(r => /emergency/i.test(r.name));
  const monthly = spentPerMonth(data);
  let aom = null; try { aom = ageOfMoney(data)?.days ?? null; } catch {}
  const payoffId = data.prefs?.payoff_category_id || null;
  let targetsLeft = 0; try { targetsLeft = fillToTargets(data, ym()).filter(f => f.id !== payoffId).length; } catch {}
  return {
    hasTargets: v.groups.some(g => g.rows.some(r => r.target > 0 && r.goal_type !== 'by_date' && r.id !== payoffId)), targetsLeft, monthDay: Number(today().slice(8)),
    rta: v.ready_to_assign, assigned: v.totals.assigned, streaks: streaks(data), goals: goals(data), aom,
    emergency: !!emergencyCat && monthly > 0 && emergencyCat.available >= monthly,
    cardPaid: debts.some(a => a.type === 'credit' && !a.closed && a.balance === 0 && hadDebt(a.id)),
    debtFree: debts.some(a => hadDebt(a.id)) && debts.every(a => a.balance >= 0),
  };
}

/**
 * Monthly badges: earned at most once each month ("badge:m:<id>:<YYYY-MM>"), so there's something
 * new to go for every month. The one-time badges above are earned once and kept.
 */
export const MONTHLY = [
  { id: 'job', icon: '🎯', title: 'Every dollar placed', hint: 'Bring Ready to assign to exactly $0 this month', test: (d, x) => x.rta === 0 && x.assigned > 0 },
  { id: 'targets', icon: '✅', title: 'Targets funded', hint: 'Fund every monthly target this month', test: (d, x) => x.hasTargets && x.targetsLeft === 0 },
  { id: 'nospend5', icon: '🌿', title: 'Five quiet days', hint: 'Five days this month with no purchases', test: (d, x) => x.streaks.noSpend >= 5 },
  { id: 'week', icon: '📒', title: 'Kept the log', hint: 'Log something 7 days in a row', test: (d, x) => x.streaks.logging >= 7 && x.monthDay >= 7 },
  { id: 'clean', icon: '🛡️', title: 'Clean finish', hint: 'Last month ended with nothing overspent', test: (d, x) => x.streaks.onBudget >= 1 },
];
const mkey = (id, month) => `badge:m:${id}:${month}`;
/** Monthly badges earned in `month`: { id: date }. */
export const earnedMonthly = (data, month = ym()) => Object.fromEntries(MONTHLY.filter(b => data.prefs?.[mkey(b.id, month)]).map(b => [b.id, data.prefs[mkey(b.id, month)]]));
/** How many months each monthly badge has been earned: { id: n }. */
export const monthlyCounts = data => {
  const n = {};
  for (const k of Object.keys(data.prefs || {})) { const m = /^badge:m:([^:]+):\d{4}-\d{2}$/.exec(k); if (m) n[m[1]] = (n[m[1]] || 0) + 1; }
  return n;
};

export const earned = data => Object.fromEntries(BADGES.filter(b => data.prefs?.['badge:' + b.id]).map(b => [b.id, data.prefs['badge:' + b.id]]));

let checking = false;
const announced = new Set();   // badge settings already celebrated on this device (never twice, even if saving failed)
/** Awards new badges. The first time (no badges recorded yet), existing ones are awarded quietly. */
export async function checkBadges(data, toast) {
  if (!data || checking || !data.accounts.length || !canChangeAll()) return;
  const have = earned(data), month = ym(), haveM = earnedMonthly(data, month);
  const x = facts(data);
  const pass = b => { try { return b.test(data, x); } catch { return false; } };
  // Badges already saved are never awarded again; a monthly one only once per month.
  const once = BADGES.filter(b => !have[b.id] && !announced.has('badge:' + b.id) && pass(b));
  const monthly = MONTHLY.filter(b => !haveM[b.id] && !announced.has(mkey(b.id, month)) && pass(b));
  for (const b of once) announced.add('badge:' + b.id);
  for (const b of monthly) announced.add(mkey(b.id, month));
  const fresh = [...once, ...monthly];
  if (!fresh.length) return;
  checking = true;
  const first = !Object.keys(have).length && !data.prefs?.['badges:init'];
  try {
    for (const b of once) await setPref('badge:' + b.id, today());   // kept out of Undo history (store.js)
    for (const b of monthly) await setPref(mkey(b.id, month), today());
    if (first) await setPref('badges:init', today());
  } finally { checking = false; }
  if (first && fresh.length > 1) { toast(`🏅 You've already earned ${fresh.length} badges. See them under Menu › Badges`, { plain: true, win: true }); return; }
  confetti(fresh.length > 1 ? 90 : 60);
  toast(fresh.length === 1 ? `🏅 Badge earned: ${fresh[0].icon} ${fresh[0].title}` : `🏅 ${fresh.length} badges earned: ${fresh.map(b => b.icon).join(' ')}`, { plain: true, win: true });
}
