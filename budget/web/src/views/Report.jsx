import { monthView, balances, fmt, monthLabel, ym, addMonths } from '../budget.js';
import { isNative, callNative } from '../platform.js';
import { nav } from '../main.jsx';

/**
 * Printable monthly report (rule 04: records travel with you as PDF). In the app, "Save as PDF"
 * opens Android's print dialog, where "Save as PDF" is a printer; in a browser it's window.print().
 * Everything outside .report-page is hidden when printing.
 */
export function Report({ data, month: m0 }) {
  const month = /^\d{4}-\d{2}$/.test(m0 || '') ? m0 : ym();
  const v = monthView(data, month);
  const acctName = Object.fromEntries(data.accounts.map(a => [a.id, a.name]));
  const catName = Object.fromEntries(data.categories.map(c => [c.id, c.name]));
  const txs = data.txs.filter(t => t.date.slice(0, 7) === month).sort((a, b) => a.date.localeCompare(b.date) || (a.payee || '').localeCompare(b.payee || ''));
  const accts = balances(data.accounts.filter(a => !a.closed), data.txs.filter(t => t.date.slice(0, 7) <= month));
  const spent = -txs.filter(t => t.amount < 0 && t.category_id).reduce((s, t) => s + t.amount, 0);
  const title = `Budget report ${monthLabel(month)}`;
  const go = mm => nav('#/report?month=' + mm);
  const save = () => (isNative ? callNative('print', { title }) : window.print());

  return (
    <div class="report">
      <div class="report-bar no-print">
        <button class="ghost" onClick={() => history.back()} aria-label="Back">✕</button>
        <div class="row" style="gap:2px">
          <button class="ghost" onClick={() => go(addMonths(month, -1))} aria-label="Previous month">‹</button>
          <b class="nowrap">{new Date(month + '-15').toLocaleString(undefined, { month: 'short', year: 'numeric' })}</b>
          <button class="ghost" onClick={() => go(addMonths(month, 1))} aria-label="Next month">›</button>
        </div>
        <button class="primary" onClick={save}>Save as PDF</button>
      </div>

      <div class="report-page">
        <h1>{title}</h1>
        <p class="muted">Generated {new Date().toLocaleString()} · amounts in USD</p>

        <h2>Summary</h2>
        <table>
          <tbody>
            <tr><td>Income</td><td class="num">{fmt(v.income_total)}</td></tr>
            <tr><td>Spent from categories</td><td class="num">{fmt(-spent)}</td></tr>
            <tr><td>Assigned this month</td><td class="num">{fmt(v.totals.assigned)}</td></tr>
            <tr><td>Available in categories</td><td class="num">{fmt(v.totals.available)}</td></tr>
            <tr><td>Ready to assign</td><td class="num">{fmt(v.ready_to_assign)}</td></tr>
          </tbody>
        </table>

        <h2>Categories</h2>
        <table>
          <thead><tr><th>Category</th><th class="num">Assigned</th><th class="num">Activity</th><th class="num">Available</th></tr></thead>
          <tbody>
            {v.groups.filter(g => g.rows.length).map(g => [
              <tr class="grp"><td>{g.name}</td><td class="num">{fmt(g.assigned)}</td><td class="num">{fmt(g.activity)}</td><td class="num">{fmt(g.available)}</td></tr>,
              ...g.rows.map(r => <tr><td class="indent">{r.name}</td><td class="num">{fmt(r.assigned)}</td><td class="num">{fmt(r.activity)}</td><td class={'num' + (r.available < 0 ? ' neg' : '')}>{fmt(r.available)}</td></tr>),
            ])}
            <tr class="grp"><td>Total</td><td class="num">{fmt(v.totals.assigned)}</td><td class="num">{fmt(v.totals.activity)}</td><td class="num">{fmt(v.totals.available)}</td></tr>
          </tbody>
        </table>

        <h2>Accounts at end of {monthLabel(month)}</h2>
        <table>
          <thead><tr><th>Account</th><th>Type</th><th class="num">Balance</th></tr></thead>
          <tbody>{accts.map(a => <tr><td>{a.name}</td><td>{a.type}{a.on_budget ? '' : ' (off budget)'}</td><td class="num">{fmt(a.balance)}</td></tr>)}</tbody>
        </table>

        <h2>Transactions ({txs.length})</h2>
        <table class="small">
          <thead><tr><th>Date</th><th>Payee</th><th>Account</th><th>Category</th><th class="num">Amount</th></tr></thead>
          <tbody>
            {txs.map(t => (
              <tr>
                <td>{t.date}</td>
                <td>{t.transfer_id ? 'Transfer' : t.payee}{t.memo ? <span class="muted"> · {t.memo}</span> : null}</td>
                <td>{acctName[t.account_id] || ''}</td>
                <td>{t.category_id ? catName[t.category_id] || '' : t.transfer_id ? '' : t.amount > 0 ? 'Ready to assign' : 'Uncategorized'}</td>
                <td class={'num' + (t.amount < 0 ? '' : ' pos')}>{fmt(t.amount)}</td>
              </tr>
            ))}
            {!txs.length && <tr><td colspan="5" class="muted">No transactions in {monthLabel(month)}.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
