import { createPortal } from 'preact/compat';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { useUI, useModal, confirmUndo, nav } from '../main.jsx';
import { historyList, undoBatch } from '../store.js';
import { monthView, monthLabel, addMonths, fmt, ym } from '../budget.js';
import { netWorthSeries, fillToTargets, ageOfMoney } from '../features.js';
import { assign, beginBatch, endBatch } from '../store.js';
import { CoverSheet } from './Cover.jsx';

/** One-page look back at a month, offered on the first open of a new month and from Reports. */
export function Review({ data, month, onClose }) {
  const ui = useUI();
  useModal(onClose);
  const v = monthView(data, month);
  const next = addMonths(month, 1);
  const vNext = monthView(data, next);
  const onBudget = new Set(data.accounts.filter(a => a.on_budget).map(a => a.id));
  const spentByGroup = v.groups.map(g => ({ name: g.name, spent: -Math.min(0, g.activity) })).filter(g => g.spent > 0).sort((a, b) => b.spent - a.spent);
  const spent = spentByGroup.reduce((s, g) => s + g.spent, 0);
  const payoffId = data.prefs?.payoff_category_id || null;   // card debt to fund, not overspending
  const over = []; for (const g of v.groups) for (const r of g.rows) if (r.available < 0 && r.id !== payoffId) over.push(r);
  const nw = netWorthSeries(data, 13);
  const cur = nw.find(p => p.month === month), prev = nw.find(p => p.month === addMonths(month, -1));
  const nwDelta = cur && prev ? cur.net - prev.net : null;
  const aom = ageOfMoney(data, `${month}-28`);
  const fills = fillToTargets(data, next);
  const fillTotal = fills.reduce((s, f) => s + f.add, 0);
  const isPast = month < ym();
  // Card overspending rolled into the payoff category at the end of this month (one history batch).
  const [rolled, setRolled] = useState(null);
  useEffect(() => { historyList(400).then(l => setRolled(l.find(b => !b.undone && (b.label || '').startsWith('Rolled ') && b.label.endsWith(`(${month})`)) || null)); }, [month]);

  const [covering, setCovering] = useState(false);
  const coverAll = () => setCovering(true);
  const fillNext = async () => { beginBatch(`Fill to targets · ${monthLabel(next)}`); try { for (const f of fills) await assign(f.id, next, f.assigned); } finally { endBatch(); } ui.toast(`Filled ${fills.length} categories for ${monthLabel(next).split(' ')[0]}`); };

  const Line = ({ l, v: val, cls }) => <div class="ln"><span>{l}</span><b class={'money ' + (cls || '')}>{val}</b></div>;
  return createPortal((
    <div class="scrim">
      <div class="sheet" role="dialog" aria-modal="true" aria-label="Month review">
        <div class="handle" />
        <div class="row between"><b>{monthLabel(month)} in review</b><span class="row"><button class="link" onClick={() => { onClose(); setTimeout(() => nav('#/recap?month=' + month), 250); }} style="font-weight:600;color:var(--pos)">✨ Recap</button><button class="ghost" onClick={onClose}>Close</button></span></div>
        <div class="mcheck" style="padding:0">
          <Line l="Income" v={fmt(v.income_total)} cls="pos" />
          <Line l="Spent" v={fmt(-spent)} />
          {rolled && (
            <div class="ln"><span>{rolled.label.replace(/^Rolled (\S+) overspending → (.*) \(\d{4}-\d{2}\)$/, 'Rolled $1 of card overspending into $2')}</span>
              <button class="link" onClick={async () => { if (!(await confirmUndo(rolled.label))) return; await undoBatch(rolled.batch); setRolled(null); ui.toast('Roll undone'); }}>Undo</button></div>
          )}
          <Line l="Saved (income − spent)" v={fmt(v.income_total - spent)} cls={v.income_total - spent >= 0 ? 'pos' : 'neg'} />
          {nwDelta !== null && <Line l="Net worth change" v={(nwDelta >= 0 ? '+' : '') + fmt(nwDelta)} cls={nwDelta >= 0 ? 'pos' : 'neg'} />}
          {aom && <Line l="Age of money" v={`${aom.days} days`} />}
          <Line l={`Held for ${monthLabel(next).split(' ')[0]}`} v={fmt(v.held_for_next)} />
          {v.borrowed_from_next > 0 && <Line l={`Covered with ${monthLabel(next).split(' ')[0]}'s money`} v={fmt(v.borrowed_from_next)} />}
        </div>
        {spentByGroup.length > 0 && (
          <div>
            <span class="eyebrow">Spending by group</span>
            {spentByGroup.slice(0, 6).map(g => (
              <div style="padding:3px 0" key={g.name}>
                <div class="row between" style="font-size:13px"><span>{g.name}</span><span class="money">{fmt(-g.spent)}</span></div>
                <div class="bar"><i style={`width:${Math.round(g.spent / spentByGroup[0].spent * 100)}%`} /></div>
              </div>
            ))}
          </div>
        )}
        {over.length > 0 && (
          <div class="warn"><span>{over.length} overspent · {fmt(over.reduce((s, r) => s + r.available, 0))}</span><button class="primary" style="min-height:32px;padding:4px 10px" onClick={coverAll}>Cover all</button></div>
        )}
        {isPast && (
          <div class="col" style="gap:6px">
            <span class="eyebrow">Start {monthLabel(next).split(' ')[0]}</span>
            <span class="head">Ready to assign in {monthLabel(next).split(' ')[0]}: <b class="money">{fmt(vNext.ready_to_assign)}</b>{fills.length ? ` · targets need ${fmt(fillTotal)}` : ''}</span>
            <div class="row" style="flex-wrap:wrap">
              {fills.length > 0 && <button class="primary" onClick={fillNext} disabled={vNext.ready_to_assign <= 0}>Fill to targets</button>}
              <button onClick={onClose}>I'll assign by hand</button>
            </div>
          </div>
        )}
      </div>
      {covering && <CoverSheet data={data} month={month} ids={over.map(r => r.id)} ui={ui} onClose={() => setCovering(false)} />}
    </div>
  ), document.body);
}
