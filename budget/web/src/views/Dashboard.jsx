import { DebtCard } from './Debt.jsx';
import { PaydayCheck } from './Forecast.jsx';
import { useEffect, useState } from 'preact/hooks';
import { Board, item } from './Board.jsx';
import { Embedded, useUI } from '../main.jsx';
import { fmt, ym, addMonths, monthLabel, dayLabel, monthView, coverageAll } from '../budget.js';
import { netWorthSeries, dueScheduled, postScheduled } from '../features.js';
import { Accounts } from './Accounts.jsx';
import { Reports } from './Reports.jsx';
import { Grid } from './Grid.jsx';
import { Roll } from './Roll.jsx';

/**
 * Wide screens (unfolded phones, tablets, computers): the Budget tab becomes a dashboard of widgets
 * you can move, resize, remove and add, or set from a preset (Three panes, Budget + detail, Wide
 * table). Each screen size keeps its own arrangement (localStorage, per device). Below 600 px wide
 * the app keeps its single-column phone layout.
 */
export const WIDE_MIN = 600;
export { useWidth } from './Board.jsx';

export const WIDGETS = {
  budget: { title: 'Budget', hint: 'Categories, money check, due bills, income' },
  detail: { title: 'Category detail', hint: 'Tap a category to see it here', fullHeight: true },
  accounts: { title: 'Accounts', hint: 'Balances, ready to pay, add accounts' },
  networth: { title: 'Net worth', hint: '12-month trend' },
  spending: { title: 'Spending this month', hint: 'By group' },
  due: { title: 'Due soon', hint: 'Scheduled bills to post' },
  forecast: { title: 'Payday forecast', hint: 'Will each account make it to payday?' },
  debt: { title: 'Debt payoff', hint: 'Debt-free date and what you owe' },
  cardpay: { title: 'Ready to pay', hint: 'What you can pay on each card' },
  reports: { title: 'Reports', hint: 'Spending, income vs spending, PDF reports' },
  table: { title: 'Budget table', hint: 'Categories across months', wide: true },
};
export const PRESETS = {
  three: { name: 'Three panes', build: cols => [item('accounts'), item('budget', Math.max(1, cols - 2)), item('networth'), item('due'), item('spending')] },
  detail: { name: 'Budget + detail', build: cols => [item('budget', Math.max(1, Math.ceil(cols / 2))), item('detail', Math.max(1, Math.floor(cols / 2)))] },
  table: { name: 'Wide table', build: cols => [item('table', cols), item('networth'), item('due'), item('spending')] },
};

/** body: the Budget tab's normal content (the "budget" widget). detail: render function for a category id. */
export function Dashboard({ data, month, body, detail, onLayout }) {
  const render = x => {
    switch (x.type) {
      case 'budget': return body;
      case 'detail': return detail();
      case 'accounts': return <Embedded.Provider value={true}><Accounts data={data} /></Embedded.Provider>;
      case 'reports': return <Embedded.Provider value={true}><Reports data={data} /></Embedded.Provider>;
      case 'table': return <Embedded.Provider value={true}><Grid data={data} /></Embedded.Provider>;
      case 'networth': return <NetWorth data={data} />;
      case 'spending': return <Spending data={data} month={month} />;
      case 'due': return <Due data={data} />;
      case 'debt': return <DebtCard data={data} />;
      case 'forecast': return <PaydayCheck data={data} title="Payday forecast" empty />;
      case 'cardpay': return <CardPay data={data} month={month} />;
      default: return null;
    }
  };
  return <Board storageKey="budget.dash" widgets={WIDGETS} presets={PRESETS} defaultPreset={cls => (cls === 'desk' ? 'three' : 'detail')}
    render={render} onLayout={l => onLayout && onLayout(l.some(x => x.type === 'detail'))} emptyHint="No widgets. Tap ✎ Customize, then a layout or + Add." />;
}

// ---- small widgets ---------------------------------------------------------------------------
function NetWorth({ data }) {
  const s = netWorthSeries(data, 12), last = s[s.length - 1], prev = s[s.length - 2];
  const max = Math.max(1, ...s.map(p => Math.abs(p.net)));
  return (
    <div class="card">
      <span class="eyebrow">Net worth · 12 months</span>
      <div class="row between"><Roll class={'money ' + (last.net < 0 ? 'neg' : 'pos')} style="font-size:22px;font-weight:800" value={last.net} />
        {prev && <span class={'head ' + (last.net - prev.net >= 0 ? 'pos' : 'neg')}>{last.net - prev.net >= 0 ? '+' : ''}{fmt(last.net - prev.net)} this month</span>}</div>
      <div class="spark">{s.map(p => <i title={`${monthLabel(p.month)}: ${fmt(p.net)}`} class={p.net < 0 ? 'neg' : ''} style={`height:${Math.max(4, Math.round(Math.abs(p.net) / max * 100))}%`} />)}</div>
    </div>
  );
}
function Spending({ data, month }) {
  const v = monthView(data, month);
  const g = v.groups.map(x => ({ name: x.name, spent: -Math.min(0, x.activity) })).filter(x => x.spent > 0).sort((a, b) => b.spent - a.spent);
  const max = Math.max(1, ...g.map(x => x.spent));
  return (
    <div class="card">
      <span class="eyebrow">Spending · {monthLabel(month)}</span>
      {g.map(x => <div class="col" style="gap:2px"><div class="row between"><span>{x.name}</span><Roll class="money" value={x.spent} /></div><div class="bar"><i style={`width:${Math.round(x.spent / max * 100)}%`} /></div></div>)}
      {!g.length && <span class="head">Nothing spent yet this month.</span>}
    </div>
  );
}
function Due({ data }) {
  const ui = useUI();
  const items = dueScheduled(data, 7);
  return (
    <div class="card">
      <div class="row between"><span class="eyebrow">Due soon</span><a href="#/scheduled" class="link" style="font-size:12px">Manage ›</a></div>
      {items.map(s => (
        <div class="row between" key={s.id}><span class="col"><span>{s.payee || 'Transfer'}</span><span class="head">{dayLabel(s.next_date)}</span></span>
          <span class="row"><span class={'money ' + (s.amount < 0 ? '' : 'pos')}>{fmt(s.amount)}</span><button class="primary" style="min-height:30px;padding:3px 10px" onClick={async () => { await postScheduled(s); ui.toast(`Posted ${s.payee}`); }}>Post</button></span></div>
      ))}
      {!items.length && <span class="head">Nothing due in the next week.</span>}
    </div>
  );
}
function CardPay({ data, month }) {
  const all = coverageAll(data, month);
  const cards = data.accounts.filter(a => a.type === 'credit' && !a.closed && all[a.id]?.debt > 0);
  return (
    <div class="card">
      <span class="eyebrow">Ready to pay</span>
      {cards.map(a => <a href={'#/accounts/' + a.id} class="row between" style="text-decoration:none;color:inherit"><span>{a.name}</span><span><Roll class="money pos" value={all[a.id].ready} /> <span class="head">of {fmt(all[a.id].debt)}</span></span></a>)}
      {!cards.length && <span class="head">No card balances to pay.</span>}
    </div>
  );
}
