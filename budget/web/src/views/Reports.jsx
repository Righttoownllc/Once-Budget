import { useState } from 'preact/hooks';
import { useContext } from 'preact/hooks';
import { Shell, Embedded } from '../main.jsx';
import { Board, item, useWidth } from './Board.jsx';
import { fmt, ym, monthLabel } from '../budget.js';
import { netWorthSeries, ageOfMoneySeries } from '../features.js';
import { Review } from './Review.jsx';
import { SpendPie } from './SpendPie.jsx';
import { addMonths } from '../budget.js';
import { setPref } from '../store.js';
import { Help } from './Info.jsx';
import { Select } from './Pick.jsx';

// Reports on a computer: cards on a board (move, resize, remove, add back), remembered per device.
const REPORT_WIDGETS = {
  where: { title: 'Where it went', hint: 'Spending by category or group, for a period' },
  networth: { title: 'Net worth', hint: '12-month trend' },
  ivs: { title: 'Income vs spending', hint: '12 months side by side' },
  aom: { title: 'Age of money', hint: '6-month trend' },
  pdf: { title: 'Monthly report (PDF)', hint: 'A month to save or print' },
  custom: { title: 'Custom report', hint: 'Any dates, account and category, grouped your way', wide: true },
};
const REPORT_ORDER = ['where', 'pdf', 'networth', 'ivs', 'aom', 'custom'];
const REPORT_PRESETS = {
  overview: { name: 'Overview', build: cols => [item('where', Math.min(2, cols)), item('networth'), item('ivs'), item('aom'), item('pdf'), item('custom', cols)] },
  trends: { name: 'Trends first', build: cols => [item('networth', Math.max(1, Math.floor(cols / 2))), item('ivs', Math.max(1, Math.ceil(cols / 2))), item('aom'), item('where', Math.min(2, cols)), item('pdf'), item('custom', cols)] },
  spending: { name: 'Spending focus', build: cols => [item('where', Math.min(2, cols)), item('custom', Math.max(1, cols - 2)), item('networth'), item('ivs'), item('aom'), item('pdf')] },
};

/** Accounts left out of Reports (a synced setting: reports:hide = JSON list of account ids). */
const hiddenAccts = data => { try { return new Set(JSON.parse(data.prefs?.['reports:hide'] || '[]')); } catch { return new Set(); } };

export function Reports({ data: all }) {
  const hide = hiddenAccts(all);
  // Everything on this screen works from the chosen accounts only.
  const data = hide.size ? { ...all, accounts: all.accounts.filter(a => !hide.has(a.id)), txs: all.txs.filter(t => !hide.has(t.account_id)) } : all;
  const [pickAccts, setPickAccts] = useState(false);
  const embedded = useContext(Embedded), width = useWidth();
  const wide = width >= 1000 && !embedded;
  const shown = all.accounts.filter(a => !a.closed && !a.deleted);
  const toggle = id => { const n = new Set(hide); n.has(id) ? n.delete(id) : n.add(id); setPref('reports:hide', JSON.stringify([...n])); };
  const [f, setF] = useState({ from: ym() + '-01', to: '', account: '', category: '', group: 'category' });
  const set = k => e => setF({ ...f, [k]: e.target.value });
  const catName = Object.fromEntries(data.categories.map(c => [c.id, c.name]));
  const acctName = Object.fromEntries(data.accounts.map(a => [a.id, a.name]));

  const rows = data.txs.filter(t =>
    t.category_id &&
    (!f.from || t.date >= f.from) &&
    (!f.to || t.date <= f.to) &&
    (!f.account || t.account_id === f.account) &&
    (!f.category || t.category_id === f.category));

  const agg = {};
  for (const t of rows) {
    const k = f.group === 'month' ? t.date.slice(0, 7)
      : f.group === 'payee' ? (t.payee || '(none)')
      : f.group === 'account' ? acctName[t.account_id]
      : catName[t.category_id];
    agg[k] = (agg[k] || 0) + t.amount;
  }
  const list = Object.entries(agg).sort((a, b) => a[1] - b[1]);
  const total = list.reduce((s, [, v]) => s + v, 0);
  const max = Math.max(1, ...list.map(([, v]) => Math.abs(v)));

  const [review, setReview] = useState((location.hash.split('?')[1] || '').includes('review=1') ? addMonths(ym(), -1) : null);
  const nw = netWorthSeries(data, 12);
  const ivs = (() => {
    const onB = new Set(data.accounts.filter(a => a.on_budget).map(a => a.id));
    const out = []; for (let i = 11; i >= 0; i--) { const m = addMonths(ym(), -i); let inc = 0, sp = 0;
      for (const t of data.txs) { if (t.date.slice(0, 7) !== m || !onB.has(t.account_id)) continue;
        if (t.transfer_id) { const o = data.txs.find(x => x.transfer_id === t.transfer_id && x.id !== t.id); if (o && !onB.has(o.account_id) && t.amount < 0) sp += -t.amount; continue; }
        if (t.amount > 0 && t.payee !== 'Starting balance' && t.payee !== 'Reconciliation adjustment') inc += t.amount; else if (t.amount < 0) sp += -t.amount; }
      out.push({ month: m, inc, sp }); }
    return out; })();
  const ivsMax = Math.max(1, ...ivs.map(p => Math.max(p.inc, p.sp)));
  const aom = ageOfMoneySeries(data, 6);
  const aomMax = Math.max(1, ...aom.map(p => p.age ? p.age.days : 0));
  const nwMax = Math.max(1, ...nw.map(p => Math.abs(p.net)));
  const first = nw.find(p => p.net !== 0) || nw[0];
  const last = nw[nw.length - 1];

  // Each report is a card: on a computer they go on a board you can rearrange (Board.jsx);
  // on a phone, or inside the Budget dashboard, they're one column in this order.
  const cards = {
    where: (
      <SpendPie data={all} hide={hide} />
    ),
    pdf: (
      <div class="card">
        <span class="eyebrow">Monthly report (PDF)</span>
        <span class="head">Summary, categories, account balances and every transaction for a month, ready to save as a PDF or print.</span>
        <div class="row" style="flex-wrap:wrap">
          {[0, 1, 2].map(i => addMonths(ym(), -i)).map(m => <a class="chip" style="text-decoration:none" href={'#/report?month=' + m}>{monthLabel(m)}</a>)}
        </div>
      </div>
    ),
    networth: (
      <div class="card">
        <div class="row between">
          <span class="eyebrow">Net worth · 12 months <Help k="networthtrend" /></span>
          <span class={'money ' + (last.net - first.net >= 0 ? 'pos' : 'neg')} style="font-weight:600">{last.net - first.net >= 0 ? '+' : ''}{fmt(last.net - first.net)}</span>
        </div>
        <div class="nw" role="img" aria-label="Net worth by month">
          {nw.map(p => (
            <div class="b" title={`${monthLabel(p.month)}: ${fmt(p.net)} (cash ${fmt(p.cash)}, debt ${fmt(p.debt)})`}>
              <i class={p.net < 0 ? 'neg' : ''} style={`height:${Math.max(2, Math.round(Math.abs(p.net) / nwMax * 100))}%`} />
              <span>{p.month.slice(5)}</span>
            </div>
          ))}
        </div>
        <div class="row between head"><span>Cash {fmt(last.cash)}</span><span>Debt {fmt(last.debt)}</span><b class="money">{fmt(last.net)}</b></div>
        <p class="head" style="margin:0">If this matches your real bank balances after reconciling, the budget side is provably complete.</p>
      </div>
    ),
    ivs: (
      <div class="card">
        <div class="row between"><span class="eyebrow">Income vs spending · 12 months</span><span class="head"><span class="dot green" /> income · <span class="dot grey" /> spending</span></div>
        <div class="ivs" role="img" aria-label="Income versus spending by month">
          {ivs.map(p => <div class="m" key={p.month} title={`${monthLabel(p.month)}: income ${fmt(p.inc)}, spent ${fmt(p.sp)}`}><i class="in" style={`height:${Math.round(p.inc / ivsMax * 100)}%`} /><i class="out" style={`height:${Math.round(p.sp / ivsMax * 100)}%`} /><span>{p.month.slice(5)}</span></div>)}
        </div>
        <div style="height:14px" />
        <div class="row between head"><span>Last 12 months: in {fmt(ivs.reduce((s, p) => s + p.inc, 0))} · out {fmt(ivs.reduce((s, p) => s + p.sp, 0))}</span><b class={'money ' + (ivs.reduce((s, p) => s + p.inc - p.sp, 0) >= 0 ? 'pos' : 'neg')}>{fmt(ivs.reduce((s, p) => s + p.inc - p.sp, 0))}</b></div>
      </div>
    ),
    aom: (
      <div class="card">
        <div class="row between"><span class="eyebrow">Age of money · 6 months <Help k="aomtrend" /></span><b>{aom[aom.length - 1].age ? `${aom[aom.length - 1].age.days} days` : '—'}</b></div>
        <div class="nw" style="height:80px" role="img" aria-label="Age of money by month">
          {aom.map(p => (
            <div class="b" title={`${monthLabel(p.month)}: ${p.age ? p.age.days + ' days' : 'n/a'}`}>
              <i style={`height:${p.age ? Math.max(3, Math.round(p.age.days / aomMax * 100)) : 2}%`} />
              <span>{p.month.slice(5)}</span>
            </div>
          ))}
        </div>
        <span class="head">Days between money arriving and being spent, averaged over the last 10 purchases. Up and to the right means you're building a buffer.</span>
      </div>
    ),
    custom: (
      <div class="card customrep span">
        <div class="row between"><span class="eyebrow">Custom report</span><strong class={'money ' + (total < 0 ? 'neg' : 'pos')}>Net {fmt(total)}</strong></div>
        <div class="repfilters form">
          <label>From<input type="date" value={f.from} onInput={set('from')} /></label>
          <label>To<input type="date" value={f.to} onInput={set('to')} /></label>
          <label>Account<Select value={f.account} onChange={set('account')}><option value="">All</option>{data.accounts.map(a => <option value={a.id}>{a.name}</option>)}</Select></label>
          <label>Category<Select value={f.category} onChange={set('category')}><option value="">All</option>{data.categories.map(c => <option value={c.id}>{c.name}</option>)}</Select></label>
          <label>Group by<Select value={f.group} onChange={set('group')}>
            <option value="category">Category</option><option value="month">Month</option><option value="payee">Payee</option><option value="account">Account</option>
          </Select></label>
        </div>
        <div class="replist">
          {list.map(([k, v]) => (
            <div style="padding:6px 0">
              <div class="row between"><span>{k}</span><span class={'money ' + (v < 0 ? '' : 'pos')}>{fmt(v)}</span></div>
              <div class="bar"><i style={`width:${Math.abs(v) / max * 100}%;background:${v < 0 ? 'var(--neg)' : 'var(--pos)'}`} /></div>
            </div>
          ))}
        </div>
        {!list.length && <p class="muted">No categorized transactions match.</p>}
      </div>
    ),
  };
  const top = <div class="col"><span class="eyebrow">Spending &amp; net worth</span><span class="title">Reports</span></div>;
  return (
    <Shell route="reports" top={top}>
      <div class="row" style="flex-wrap:wrap">
        {[1, 2, 3].map(i => addMonths(ym(), -i)).map(m => <button class="chip" key={m} onClick={() => setReview(m)}>Review {monthLabel(m).split(' ')[0]}</button>)}
        {[1, 2].map(i => addMonths(ym(), -i)).map(m => <a class="chip" style="text-decoration:none" key={'r' + m} href={'#/recap?month=' + m}>✨ Recap {monthLabel(m).split(' ')[0]}</a>)}
        {(() => { const y = Number(ym().slice(0, 4)); const years = Number(ym().slice(5)) <= 3 ? [y - 1, y] : [y]; return years.map(yr => <a class="chip yearchip" style="text-decoration:none" key={'y' + yr} href={'#/recap?year=' + yr}>🎆 Your {yr}{yr === y ? ' so far' : ''}</a>); })()}
      </div>
      <div class="row" style="flex-wrap:wrap">
        <button class={'chip' + (hide.size ? ' on' : '')} aria-expanded={pickAccts} onClick={() => setPickAccts(!pickAccts)}>
          🏦 Accounts: {shown.filter(a => !hide.has(a.id)).length === shown.length ? 'all' : `${shown.filter(a => !hide.has(a.id)).length} of ${shown.length}`} {pickAccts ? '▾' : '▸'}
        </button>
      </div>
      {pickAccts && (
        <div class="card acctpick">
          <span class="head">Untick accounts to leave them out of every report on this screen: net worth, income vs spending, age of money and spending. Saved for this budget.</span>
          {shown.map(a => <label class="check"><input type="checkbox" checked={!hide.has(a.id)} onChange={() => toggle(a.id)} /> {a.name}</label>)}
        </div>
      )}
      {review && <Review data={all} month={review} onClose={() => setReview(null)} />}
      {wide ? <Board storageKey="budget.reports" widgets={REPORT_WIDGETS} presets={REPORT_PRESETS} defaultPreset={() => 'overview'} render={x => cards[x.type]} />
        : REPORT_ORDER.map(k => cards[k])}
    </Shell>
  );
}
