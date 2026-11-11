import { useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { useUI, useModal } from '../main.jsx';
import { fmt, ym, addMonths, dayLabel, newestFirst } from '../budget.js';
import { catIcon } from '../icons.jsx';
import { setPref } from '../store.js';
import { Help } from './Info.jsx';

/**
 * Reports › Where it went: spending by category (or group) for a period, as a donut you can tap.
 * Spending = categorized money going out, less refunds back into the same category. Card payments
 * are transfers, so they never count; the card payoff category only counts money actually spent
 * from it (not payments into it).
 */
const PERIODS = [['this', 'This month'], ['last', 'Last month'], ['3m', '3 months'], ['year', 'This year']];
const COLORS = ['#2F855A', '#3182CE', '#D69E2E', '#805AD5', '#DD6B20', '#319795', '#D53F8C', '#718096', '#38A169', '#E53E3E', '#5A67D8', '#B7791F'];

function range(p) {
  const m = ym();
  if (p === 'last') return [addMonths(m, -1), addMonths(m, -1)];
  if (p === '3m') return [addMonths(m, -2), m];
  if (p === 'year') return [m.slice(0, 4) + '-01', m];
  return [m, m];
}

/** Categories left out of the chart (a synced setting: reports:piehide = JSON list of category ids). */
const hiddenCats = data => { try { return new Set(JSON.parse(data.prefs?.['reports:piehide'] || '[]')); } catch { return new Set(); } };

export function SpendPie({ data, hide = new Set() }) {
  const ui = useUI();
  const [period, setPeriod] = useState('this');
  const [by, setBy] = useState('category');
  const [open, setOpen] = useState(null);   // slice key whose transactions are shown
  const [picking, setPicking] = useState(false);
  const off = hiddenCats(data);
  const saveOff = n => setPref('reports:piehide', JSON.stringify([...n]));
  const [from, to] = range(period);
  const gmap = Object.fromEntries(data.groups.map(g => [g.id, g]));
  const cats = Object.fromEntries(data.categories.map(c => [c.id, c]));
  const payoff = data.prefs?.payoff_category_id || null;
  const txs = data.txs.filter(t => {
    const m = t.date.slice(0, 7);
    if (m < from || m > to || !t.category_id || hide.has(t.account_id)) return false;
    const c = cats[t.category_id]; if (!c || gmap[c.group_id]?.is_income) return false;
    if (t.category_id === payoff && t.transfer_id) return false;   // payments into card debt aren't spending
    return true;
  });
  const agg = {};
  const offSpent = {};   // spending in hidden categories, so the chart can say what it leaves out
  for (const t of txs) {
    if (off.has(t.category_id)) { offSpent[t.category_id] = (offSpent[t.category_id] || 0) - t.amount; continue; }
    const c = cats[t.category_id];
    const key = by === 'group' ? c.group_id : c.id;
    const a = agg[key] || (agg[key] = { key, name: by === 'group' ? (gmap[c.group_id]?.name || 'Other') : c.name, icon: by === 'group' ? '' : catIcon(data, c), spent: 0, txs: [] });
    a.spent -= t.amount; a.txs.push(t);
  }
  const slices = Object.values(agg).filter(a => a.spent > 0).sort((a, b) => b.spent - a.spent);
  const total = slices.reduce((s, a) => s + a.spent, 0);
  // Donut geometry
  const R = 70, W = 22, C = 2 * Math.PI * R;
  let at = 0;
  const arcs = slices.map((a, i) => { const len = (a.spent / total) * C; const arc = { a, color: COLORS[i % COLORS.length], dash: `${Math.max(0, len - 1.5)} ${C}`, off: -at }; at += len; return arc; });
  const offList = [...off].filter(id => cats[id]).map(id => ({ c: cats[id], spent: Math.max(0, offSpent[id] || 0) }));
  const offTotal = offList.reduce((s, x) => s + x.spent, 0);
  // Spending groups and their categories, for the picker (income and hidden-by-archive left out).
  const pickGroups = data.groups.filter(g => !g.is_income && !g.deleted).map(g => ({ g, cs: data.categories.filter(c => c.group_id === g.id && !c.deleted && !c.hidden) })).filter(x => x.cs.length);
  const nCats = pickGroups.reduce((s, x) => s + x.cs.length, 0);
  const nShown = pickGroups.reduce((s, x) => s + x.cs.filter(c => !off.has(c.id)).length, 0);
  const toggleCat = id => { const n = new Set(off); n.has(id) ? n.delete(id) : n.add(id); saveOff(n); };
  const toggleGroup = cs => { const n = new Set(off); const allOn = cs.every(c => !n.has(c.id)); for (const c of cs) allOn ? n.add(c.id) : n.delete(c.id); saveOff(n); };
  const hideSlice = a => { const n = new Set(off); for (const t of a.txs) n.add(t.category_id); saveOff(n); setOpen(null); };
  const shown = open ? slices.find(a => a.key === open) : null;
  const label = PERIODS.find(p => p[0] === period)[1];
  return (
    <div class="card spendpie">
      <div class="row between" style="flex-wrap:wrap;gap:6px">
        <span class="eyebrow">Where it went · {label.toLowerCase()} <Help k="wherewent" /></span>
        <div class="seg nowrap small">{[['category', 'Categories'], ['group', 'Groups']].map(([k, l]) => <button class={by === k ? 'on' : ''} onClick={() => setBy(k)}>{l}</button>)}</div>
      </div>
      <div class="row" style="flex-wrap:wrap;gap:6px">{PERIODS.map(([k, l]) => <button class={'chip' + (period === k ? ' on' : '')} onClick={() => setPeriod(k)}>{l}</button>)}</div>
      <div class="row" style="flex-wrap:wrap;gap:6px">
        <button class={'chip' + (off.size ? ' on' : '')} aria-expanded={picking} onClick={() => setPicking(!picking)}>🎯 Categories: {nShown === nCats ? 'all' : `${nShown} of ${nCats}`} {picking ? '▾' : '▸'}</button>
        {payoff && cats[payoff] && !off.has(payoff) && <button class="chip" onClick={() => toggleCat(payoff)}>Hide {cats[payoff].name}</button>}
      </div>
      {picking && (
        <div class="catpick">
          <div class="row between" style="gap:8px;flex-wrap:wrap">
            <span class="head">Untick categories to leave them out of this chart. Saved for this budget.</span>
            <span class="row" style="gap:6px"><button class="chip" onClick={() => saveOff(new Set())}>Show all</button><button class="chip" onClick={() => saveOff(new Set(pickGroups.flatMap(x => x.cs.map(c => c.id))))}>Hide all</button></span>
          </div>
          {pickGroups.map(({ g, cs }) => {
            const on = cs.filter(c => !off.has(c.id)).length;
            return (
              <div class="pickgroup">
                <label class="check grp"><input type="checkbox" checked={on === cs.length} ref={el => { if (el) el.indeterminate = on > 0 && on < cs.length; }} onChange={() => toggleGroup(cs)} /> <b>{g.name}</b></label>
                <div class="pickcats">{cs.map(c => <label class="check"><input type="checkbox" checked={!off.has(c.id)} onChange={() => toggleCat(c.id)} /> {catIcon(data, c) ? catIcon(data, c) + ' ' : ''}{c.name}</label>)}</div>
              </div>
            );
          })}
          <button class="primary" onClick={() => setPicking(false)}>Done</button>
        </div>
      )}
      {!slices.length ? <span class="head">{offTotal > 0 ? 'Everything spent in this period is in hidden categories.' : 'Nothing spent in this period.'}</span> : (
        <div class="pierow">
          <svg viewBox="0 0 180 180" class="donut" role="img" aria-label={`Spending ${label}: ${fmt(total)}`}>
            {arcs.map(x => (
              <circle cx="90" cy="90" r={R} fill="none" stroke={x.color} stroke-width={open === x.a.key ? W + 8 : W} stroke-dasharray={x.dash} stroke-dashoffset={x.off}
                transform="rotate(-90 90 90)" class="slice" onClick={() => setOpen(x.a.key)}><title>{x.a.name}: {fmt(x.a.spent)}</title></circle>
            ))}
            <text x="90" y="86" text-anchor="middle" class="dlabel">Spent</text>
            <text x="90" y="106" text-anchor="middle" class="dtotal money">{fmt(total)}</text>
          </svg>
          <div class="legend">
            {arcs.map(x => (
              <button type="button" class="lrow" onClick={() => setOpen(x.a.key)}>
                <i style={`background:${x.color}`} /><span class="nm">{x.a.icon ? x.a.icon + ' ' : ''}{x.a.name}</span>
                <span class="pct">{Math.round((x.a.spent / total) * 100)}%</span><b class="money">{fmt(x.a.spent)}</b>
              </button>
            ))}
          </div>
        </div>
      )}
      {offList.length > 0 && (
        <span class="head pieoff">Not shown: {(() => { const sp = offList.filter(x => x.spent > 0).sort((x, y) => y.spent - x.spent); if (!sp.length) return `${offList.length} categor${offList.length === 1 ? 'y' : 'ies'} (nothing spent)`; const names = sp.slice(0, 3).map(x => `${x.c.name} ${fmt(x.spent)}`).join(', '); return sp.length > 3 ? `${names} and ${sp.length - 3} more (${fmt(offTotal)} in all)` : names; })()} · <button class="link" onClick={() => saveOff(new Set())}>Show all</button></span>
      )}
      {shown && <SliceSheet onHide={() => hideSlice(shown)} slice={shown} data={data} label={label} onClose={() => setOpen(null)} onEdit={t => { setOpen(null); ui.open({ tx: t }); }} />}
    </div>
  );
}

function SliceSheet({ slice, data, label, onClose, onEdit, onHide }) {
  useModal(onClose);
  const acct = Object.fromEntries(data.accounts.map(a => [a.id, a.name]));
  const cats = Object.fromEntries(data.categories.map(c => [c.id, c.name]));
  const list = [...slice.txs].sort(newestFirst);
  return createPortal((
    <div class="scrim">
      <div class="sheet" role="dialog" aria-modal="true" aria-label={slice.name}>
        <div class="handle" />
        <div class="row between"><b>{slice.icon ? slice.icon + ' ' : ''}{slice.name} · {label.toLowerCase()}</b><button class="ghost" onClick={onClose}>Close</button></div>
        <span class="head">{list.length} transaction{list.length === 1 ? '' : 's'} · spent <b class="money">{fmt(slice.spent)}</b>. Tap one to edit it.</span>
        <button class="chip" style="align-self:flex-start" onClick={onHide}>🙈 Hide from chart</button>
        <div class="slicelist">
          {list.map(t => (
            <button type="button" class="txrow tap" onClick={() => onEdit(t)}>
              <div class="main"><div class="p">{t.payee || (t.transfer_id ? 'Transfer' : '—')}</div><div class="s">{dayLabel(t.date)} · {acct[t.account_id] || ''}{slice.key !== t.category_id && cats[t.category_id] ? ` · ${cats[t.category_id]}` : ''}</div></div>
              <span class={'money' + (t.amount > 0 ? ' pos' : '')}>{t.amount > 0 ? '+' : ''}{fmt(t.amount)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  ), document.body);
}
