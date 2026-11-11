import { db } from './db.js';

/**
 * Budget math. The rules that keep credit cards from breaking the budget:
 *  - Only transactions with a category_id affect categories. Transfer legs
 *    (card payments, moving money between accounts) have no category.
 *  - Spending on a credit card reduces the category immediately, exactly as
 *    cash spending does. Paying the card later is a transfer: no budget effect.
 *  - Ready to Assign = (sum of on-budget account balances, cards included as
 *    negative) - (sum of every category's available balance). Because card
 *    debt is already subtracted via the account balance, the money "owed to
 *    the card" is never counted as assignable.
 */

// Reserved category id for "hold for next month". A budget_months row with
// this id and month M means: that money leaves Ready to Assign in M-1 and
// comes back into Ready to Assign in M. It is never a spendable category.
export const HOLD_CATEGORY = '__hold__';
// Reserved category id for "take from next month's money": a row with this id and month M holds a
// negative amount. It covers overspending in M-1 and comes off M's Ready to Assign.
export const BORROW_CATEGORY = '__borrow__';

export function nextMonth(m) {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 7);
}

export function accountBalances(hh) {
  return db.prepare(`
    SELECT a.id, a.name, a.type, a.on_budget, a.closed, a.reconciled_balance, a.reconciled_at,
           COALESCE(SUM(t.amount), 0) AS balance,
           COALESCE(SUM(CASE WHEN t.cleared > 0 THEN t.amount ELSE 0 END), 0) AS cleared_balance
    FROM accounts a
    LEFT JOIN transactions t ON t.account_id = a.id AND t.deleted = 0
    WHERE a.household_id = ? AND a.deleted = 0
    GROUP BY a.id ORDER BY a.sort, a.name`).all(hh);
}

export function monthView(hh, month) {
  // month = 'YYYY-MM'
  const cats = db.prepare(`
    SELECT c.id, c.name, c.group_id, g.name AS group_name, c.sort, g.sort AS group_sort
    FROM categories c JOIN category_groups g ON g.id = c.group_id
    WHERE c.household_id = ? AND c.deleted = 0 AND g.deleted = 0 AND g.is_income = 0
    ORDER BY g.sort, c.sort, c.name`).all(hh);

  const assignedThisMonth = rowsToMap(db.prepare(
    `SELECT category_id, assigned FROM budget_months WHERE household_id = ? AND month = ? AND deleted = 0`).all(hh, month));
  const assignedThrough = rowsToMap(db.prepare(
    `SELECT category_id, SUM(assigned) AS assigned FROM budget_months WHERE household_id = ? AND month <= ? AND deleted = 0 GROUP BY category_id`).all(hh, month), 'assigned');
  const activityThisMonth = rowsToMap(db.prepare(
    `SELECT category_id, SUM(amount) AS amount FROM transactions
     WHERE household_id = ? AND deleted = 0 AND category_id IS NOT NULL AND substr(date,1,7) = ?
     GROUP BY category_id`).all(hh, month), 'amount');
  const activityThrough = rowsToMap(db.prepare(
    `SELECT category_id, SUM(amount) AS amount FROM transactions
     WHERE household_id = ? AND deleted = 0 AND category_id IS NOT NULL AND substr(date,1,7) <= ?
     GROUP BY category_id`).all(hh, month), 'amount');

  const rows = cats.map(c => ({
    ...c,
    assigned: assignedThisMonth[c.id] || 0,
    activity: activityThisMonth[c.id] || 0,
    available: (assignedThrough[c.id] || 0) + (activityThrough[c.id] || 0),
  }));

  // Ready to assign as of the end of this month.
  const onBudgetCash = db.prepare(`
    SELECT COALESCE(SUM(t.amount),0) AS v FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE t.household_id = ? AND t.deleted = 0 AND a.deleted = 0 AND a.on_budget = 1 AND substr(t.date,1,7) <= ?`).get(hh, month).v;
  const totalAvailable = rows.reduce((s, r) => s + r.available, 0);
  // Anything assigned to a later month (real categories AND the reserved
  // HOLD_CATEGORY row) is not assignable now.
  const assignedFuture = db.prepare(
    `SELECT COALESCE(SUM(assigned),0) AS v FROM budget_months WHERE household_id = ? AND month > ? AND deleted = 0`).get(hh, month).v;
  const heldForNext = db.prepare(
    `SELECT COALESCE(SUM(assigned),0) AS v FROM budget_months WHERE household_id = ? AND month = ? AND category_id = ? AND deleted = 0`).get(hh, nextMonth(month), HOLD_CATEGORY).v;
  const heldFromPrev = db.prepare(
    `SELECT COALESCE(SUM(assigned),0) AS v FROM budget_months WHERE household_id = ? AND month = ? AND category_id = ? AND deleted = 0`).get(hh, month, HOLD_CATEGORY).v;

  const borrowAt = m => db.prepare(
    `SELECT COALESCE(SUM(assigned),0) AS v FROM budget_months WHERE household_id = ? AND month = ? AND category_id = ? AND deleted = 0`).get(hh, m, BORROW_CATEGORY).v;

  return {
    month,
    borrowed_from_next: -borrowAt(nextMonth(month)),
    borrowed_by_prev: -borrowAt(month),
    ready_to_assign: onBudgetCash - totalAvailable - assignedFuture,
    held_for_next: heldForNext,            // set aside for next month (part of assigned_future)
    held_from_prev: heldFromPrev,          // released into this month's ready to assign
    assigned_future: assignedFuture,
    totals: {
      assigned: rows.reduce((s, r) => s + r.assigned, 0),
      activity: rows.reduce((s, r) => s + r.activity, 0),
      available: totalAvailable,
    },
    categories: rows,
  };
}

export function spendingReport(hh, { from, to, account_id, category_id, group_by = 'category' }) {
  const where = ['t.household_id = ?', 't.deleted = 0', 't.category_id IS NOT NULL'];
  const p = [hh];
  if (from) { where.push('t.date >= ?'); p.push(from); }
  if (to) { where.push('t.date <= ?'); p.push(to); }
  if (account_id) { where.push('t.account_id = ?'); p.push(account_id); }
  if (category_id) { where.push('t.category_id = ?'); p.push(category_id); }
  const key = group_by === 'month' ? "substr(t.date,1,7)"
    : group_by === 'payee' ? 't.payee'
    : group_by === 'account' ? 'a.name'
    : 'c.name';
  return db.prepare(`
    SELECT ${key} AS label, SUM(t.amount) AS amount, COUNT(*) AS count
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN accounts a ON a.id = t.account_id
    WHERE ${where.join(' AND ')}
    GROUP BY label ORDER BY amount ASC`).all(...p);
}

function rowsToMap(rows, field) {
  const m = {};
  for (const r of rows) m[r.category_id] = r[field || 'assigned'];
  return m;
}
