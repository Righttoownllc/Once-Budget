import { monthView, monthLabel, ym, addMonths, fmt, startingIn } from '../budget.js';
import { netWorthSeries, ageOfMoney } from '../features.js';
import { isNative, callNative } from '../platform.js';
import { nav } from '../main.jsx';
import { catIcon } from '../icons.jsx';

/**
 * Monthly recap: the month as a short, shareable story. Full screen like the monthly report, and
 * "Save as PDF" prints only the recap (rule 04: your records travel with you).
 */
const WEEKDAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

export function recapStats(data, month) {
  const prevM = addMonths(month, -1);
  const v = monthView(data, month), pv = monthView(data, prevM);
  const rowsSpent = view => view.groups.flatMap(g => g.rows).map(r => ({ id: r.id, name: r.name, spent: -Math.min(0, r.activity) }));
  const cur = rowsSpent(v), prev = Object.fromEntries(rowsSpent(pv).map(r => [r.id, r.spent]));
  const spent = cur.reduce((s, r) => s + r.spent, 0), prevSpent = Object.values(prev).reduce((s, x) => s + x, 0);
  const top = cur.filter(r => r.spent > 0).sort((a, b) => b.spent - a.spent).slice(0, 5).map(r => ({ ...r, change: r.spent - (prev[r.id] || 0) }));
  const swings = cur.map(r => ({ ...r, change: r.spent - (prev[r.id] || 0) })).filter(r => Math.abs(r.change) >= 100).sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, 2);
  // Purchases: categorized outflows that aren't transfers.
  const buys = data.txs.filter(t => t.date.slice(0, 7) === month && t.amount < 0 && t.category_id && !t.transfer_id);
  const biggest = buys.reduce((m, t) => (!m || t.amount < m.amount ? t : m), null);
  const visits = {}; for (const t of buys) if (t.payee) visits[t.payee] = (visits[t.payee] || 0) + 1;
  const regular = Object.entries(visits).sort((a, b) => b[1] - a[1])[0];
  const byDay = Array(7).fill(0); for (const t of buys) byDay[new Date(t.date + 'T12:00:00').getDay()] -= t.amount;
  const topDay = byDay.some(Boolean) ? byDay.indexOf(Math.max(...byDay)) : null;
  const isNow = month === ym();
  const daysIn = isNow ? new Date().getDate() : new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate();
  const spendDays = new Set(buys.map(t => t.date));
  const noSpend = daysIn - [...spendDays].filter(d => Number(d.slice(8)) <= daysIn).length;
  const budgeted = v.groups.flatMap(g => g.rows).filter(r => r.assigned > 0 || r.activity < 0);
  const within = budgeted.filter(r => r.available >= 0).length;
  const nw = netWorthSeries(data, 14);
  const n0 = nw.find(p => p.month === prevM), n1 = nw.find(p => p.month === month);
  // Accounts added this month bring a "Starting balance": that's not money earned or lost, so leave it out.
  const isDebt = Object.fromEntries(data.accounts.map(a => [a.id, a.type === 'credit' || a.type === 'loan']));
  const starts = data.txs.filter(t => t.date.slice(0, 7) === month && t.payee === 'Starting balance');
  const startNet = starts.reduce((s, t) => s + t.amount, 0), startDebt = starts.filter(t => isDebt[t.account_id]).reduce((s, t) => s + t.amount, 0);
  const nwChange = n0 && n1 ? n1.net - n0.net - startNet : null;
  const debtDown = n0 && n1 ? n1.debt - n0.debt - startDebt : null;   // debts are negative: positive = paid down
  const aom = ageOfMoney(data, `${month}-28`);
  const income = v.income_total - startingIn(data, month);   // starting balances aren't income
  return { v, income, spent, prevSpent, saved: income - spent, top, swings, biggest, regular, topDay, noSpend, daysIn, within, budgeted: budgeted.length, nwChange, debtDown, aom, count: buys.length, isNow };
}

export function Recap({ data, month: m0 }) {
  const month = /^\d{4}-\d{2}$/.test(m0 || '') ? m0 : addMonths(ym(), -1);
  const s = recapStats(data, month);
  const name = monthLabel(month).split(' ')[0];
  const title = `${monthLabel(month)} recap`;
  const go = mm => nav('#/recap?month=' + mm);
  const save = () => (isNative ? callNative('print', { title }) : window.print());
  const rate = pct(s.saved, s.income);
  const max = s.top[0]?.spent || 1;
  const facts = [
    s.biggest && ['🧾', 'Biggest purchase', `${fmt(-s.biggest.amount)} at ${s.biggest.payee || 'somewhere'}`, `on ${new Date(s.biggest.date + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`],
    s.regular && s.regular[1] > 1 && ['📍', 'Your regular', s.regular[0], `${s.regular[1]} visits`],
    ['🌿', 'No-spend days', `${s.noSpend} of ${s.daysIn}`, s.noSpend >= s.daysIn / 3 ? 'nicely done' : ''],
    s.topDay !== null && ['📆', 'Biggest spending day', WEEKDAYS[s.topDay], ''],
    s.budgeted > 0 && ['🎯', 'Stayed within budget', `${s.within} of ${s.budgeted} categor${s.budgeted === 1 ? 'y' : 'ies'}`, s.within === s.budgeted ? 'every one!' : ''],
    s.debtDown !== null && s.debtDown > 0 && ['⛰', 'Debt paid down', fmt(s.debtDown), ''],
  ].filter(Boolean);

  return (
    <div class="report recap">
      <div class="report-bar no-print">
        <button class="ghost" onClick={() => history.back()} aria-label="Back">✕</button>
        <div class="row" style="gap:2px">
          <button class="ghost" onClick={() => go(addMonths(month, -1))} aria-label="Previous month">‹</button>
          <b class="nowrap">{new Date(month + '-15').toLocaleString(undefined, { month: 'short', year: 'numeric' })}</b>
          <button class="ghost" disabled={month >= ym()} onClick={() => go(addMonths(month, 1))} aria-label="Next month">›</button>
        </div>
        <button class="primary" onClick={save}>Save as PDF</button>
      </div>

      <div class="report-page recap-page">
        <div class="rhero">
          <span class="eyebrow">Your {name}{s.isNow ? ' so far' : ''}</span>
          {s.income || s.spent ? (s.saved >= 0
            ? <h1>You kept <span class="money">{fmt(s.saved)}</span>{s.income ? <>, {rate}% of what came in</> : ''}</h1>
            : <h1>You spent <span class="money">{fmt(-s.saved)}</span> more than came in</h1>)
            : <h1>A quiet month: nothing came in or went out</h1>}
          {s.prevSpent > 0 && s.spent > 0 && <p>Spending was {s.spent <= s.prevSpent ? 'down' : 'up'} <span class="money">{fmt(Math.abs(s.spent - s.prevSpent))}</span> ({Math.abs(pct(s.spent - s.prevSpent, s.prevSpent))}%) from {monthLabel(addMonths(month, -1)).split(' ')[0]}.</p>}
        </div>

        <div class="rtiles">
          <div class="rtile in"><span>Came in</span><b class="money">{fmt(s.income)}</b></div>
          <div class="rtile out"><span>Went out</span><b class="money">{fmt(s.spent)}</b></div>
          {s.nwChange !== null && <div class={'rtile ' + (s.nwChange >= 0 ? 'in' : 'out')}><span>Net worth</span><b class="money">{s.nwChange >= 0 ? '+' : '−'}{fmt(Math.abs(s.nwChange))}</b></div>}
          {s.aom?.days > 0 && <div class="rtile"><span>Age of money</span><b>{s.aom.days} days</b></div>}
        </div>

        {s.top.length > 0 && <>
          <h2>Where it went</h2>
          {s.top.map(r => (
            <div class="rbar">
              <div class="row between"><span>{catIcon(data, r) ? catIcon(data, r) + ' ' : ''}{r.name}</span><span><b class="money">{fmt(r.spent)}</b>{r.change !== 0 && <small class={r.change > 0 ? 'up' : 'down'}> {r.change > 0 ? '▲' : '▼'} <span class="money">{fmt(Math.abs(r.change))}</span></small>}</span></div>
              <div class="bar"><i style={`width:${Math.round((r.spent / max) * 100)}%`} /></div>
            </div>
          ))}
        </>}

        {s.swings.length > 0 && <>
          <h2>Biggest changes</h2>
          {s.swings.map(r => <p class="rswing">{r.change > 0 ? '📈' : '📉'} <b>{r.name}</b> {r.change > 0 ? 'up' : 'down'} <span class="money">{fmt(Math.abs(r.change))}</span> from {monthLabel(addMonths(month, -1)).split(' ')[0]}</p>)}
        </>}

        {facts.length > 0 && <>
          <h2>Highlights</h2>
          <div class="rfacts">{facts.map(([icon, label, value, note]) => (
            <div class="rfact"><span class="ico">{icon}</span><span class="col"><span class="lbl">{label}</span><b class={/\$/.test(value) ? 'money' : ''}>{value}</b>{note && <span class="note">{note}</span>}</span></div>
          ))}</div>
        </>}
        <a class="link no-print" href={'#/recap?year=' + month.slice(0, 4)} style="text-align:center;font-weight:600;color:var(--pos)">🎆 See your whole {month.slice(0, 4)} ›</a>
        <p class="muted rfoot">{s.count} purchase{s.count === 1 ? '' : 's'} · made with Once Budget by RightToOwn · {new Date().toLocaleDateString()}</p>
      </div>
    </div>
  );
}
