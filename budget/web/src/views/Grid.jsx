import { useEffect, useRef, useState, useContext } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { Shell, Embedded, useModal, useUI } from '../main.jsx';
import { useWidth } from './Board.jsx';
import { monthView, ym, addMonths, monthLabel, fmt, parseMoney } from '../budget.js';
import { assign } from '../store.js';
import { isClosedMonth } from '../features.js';
import { Select } from './Pick.jsx';

/** Classic budget table: categories down, months across (assigned / spent / available). */
export function Grid({ data }) {
  const [end, setEnd] = useState(ym());
  const [cols, setCols] = useState(4);
  const months = []; for (let i = cols - 1; i >= 0; i--) months.push(addMonths(end, -i));
  const views = Object.fromEntries(months.map(m => [m, monthView(data, m)]));
  const groups = views[end].groups;
  const cell = (m, cid) => { for (const g of views[m].groups) for (const r of g.rows) if (r.id === cid) return r; return null; };
  const top = (
    <div class="row between">
      <div class="col"><span class="eyebrow">Budget table</span><span class="title">{monthLabel(months[0]).split(' ')[0]} – {monthLabel(end)}</span></div>
      <div class="row">
        <button class="round" aria-label="Earlier" onClick={() => setEnd(addMonths(end, -1))}>‹</button>
        <button class="round" aria-label="Later" onClick={() => setEnd(addMonths(end, 1))}>›</button>
        <Select aria-label="Months shown" value={cols} onChange={e => setCols(Number(e.target.value))} style="width:auto;min-height:40px;background:rgba(255,255,255,.12);color:#fff;border:0">{[3, 4, 6, 12].map(n => <option value={n}>{n} mo</option>)}</Select>
      </div>
    </div>
  );
  const embedded = useContext(Embedded), width = useWidth();
  if (width < 600 && !embedded) return <Shell route="budget" top={top}><PhoneGrid data={data} months={months} views={views} groups={groups} cell={cell} /></Shell>;
  return (
    <Shell route="budget" top={top}>
      <div class="gridwrap">
        <table class="grid">
          <thead>
            <tr><th class="sticky">Category</th>{months.map(m => <th colSpan={3} class={m === ym() ? 'cur' : ''}>{monthLabel(m).replace(' 20', ' ’')}</th>)}</tr>
            <tr><th class="sticky"></th>{months.map(() => <><th class="sub">Assigned</th><th class="sub">Spent</th><th class="sub">Avail.</th></>)}</tr>
          </thead>
          <tbody>
            <tr class="tot"><td class="sticky">Ready to assign</td>{months.map(m => <><td></td><td></td><td class={'r money ' + (views[m].ready_to_assign < 0 ? 'neg' : 'pos')}>{m < ym() ? <span class="muted">—</span> : fmt(views[m].ready_to_assign)}</td></>)}</tr>
            {groups.map(g => (
              <>
                <tr class="grp"><td class="sticky" colSpan={1}>{g.name}</td>{months.map(m => { const gg = views[m].groups.find(x => x.id === g.id) || { assigned: 0, activity: 0, available: 0 }; return <><td class="r money">{fmt(gg.assigned)}</td><td class="r money">{fmt(gg.activity)}</td><td class={'r money ' + (gg.available < 0 ? 'neg' : '')}>{fmt(gg.available)}</td></>; })}</tr>
                {g.rows.map(c => (
                  <tr key={c.id}>
                    <td class="sticky">{c.name}</td>
                    {months.map(m => { const r = cell(m, c.id); const locked = isClosedMonth(data, m); return (
                      <>
                        <td class="r"><AssignCell r={r} month={m} locked={locked} /></td>
                        <td class="r money muted">{r ? fmt(r.activity) : ''}</td>
                        <td class={'r money ' + (r && r.available < 0 ? 'neg' : r && r.available > 0 ? 'pos' : 'muted')}>{r ? fmt(r.available) : ''}</td>
                      </>); })}
                  </tr>
                ))}
              </>
            ))}
          </tbody>
        </table>
      </div>
      <span class="head">Tap an Assigned cell to edit. Scroll sideways for more months.</span>
    </Shell>
  );
}

function AssignCell({ r, month, locked }) {
  const [v, setV] = useState(null);
  if (!r) return null;
  return (
    <input class="num cellin" inputMode="decimal" disabled={locked} value={v ?? (r.assigned / 100).toFixed(2)} onFocus={e => e.target.select()}
      onInput={e => setV(e.target.value)} onBlur={async () => { if (v !== null) { await assign(r.id, month, parseMoney(v)); setV(null); } }}
      onKeyDown={e => e.key === 'Enter' && e.target.blur()} />
  );
}

// ---- Phones: one number per month -----------------------------------------------------------
// Pick Assigned, Spent or Available; each month is one narrow column (whole dollars), newest on the
// right and in view. Tap a number to change that month's assigned amount.
const METRIC_KEY = 'budget.gridMetric';
const METRICS = [['assigned', 'Assigned'], ['spent', 'Spent'], ['available', 'Available']];
// Whole dollars; $10,000 and over as "21.8k" so four months fit on a narrow phone.
const whole = v => { const d = Math.round(v / 100), a = Math.abs(d); return (d < 0 ? '−' : '') + (a >= 10000 ? (a / 1000).toFixed(a >= 100000 ? 0 : 1) + 'k' : a.toLocaleString()); };

function PhoneGrid({ data, months, views, groups, cell }) {
  const [metric, setMetricS] = useState(() => { try { return localStorage.getItem(METRIC_KEY) || 'available'; } catch { return 'available'; } });
  const setMetric = m => { setMetricS(m); try { localStorage.setItem(METRIC_KEY, m); } catch {} };
  const [edit, setEdit] = useState(null);   // { c, month }
  const wrap = useRef(null);
  useEffect(() => { const w = wrap.current; if (w) w.scrollLeft = w.scrollWidth; }, [months.length, months[months.length - 1]]);
  const val = r => (!r ? 0 : metric === 'assigned' ? r.assigned : metric === 'spent' ? -r.activity : r.available);
  const cls = v => (v === 0 ? 'muted' : metric === 'available' ? (v < 0 ? 'neg' : 'pos') : metric === 'spent' && v < 0 ? 'pos' : '');
  return (
    <>
      <div class="seg pgseg" role="tablist">{METRICS.map(([k, l]) => <button role="tab" aria-selected={metric === k} class={metric === k ? 'on' : ''} onClick={() => setMetric(k)}>{l}</button>)}</div>
      <div class="pgwrap" ref={wrap}>
        <table class="pgrid">
          <thead><tr><th class="sticky">Category</th>{months.map(m => <th class={m === ym() ? 'cur' : ''}>{monthLabel(m).slice(0, 3)}</th>)}</tr></thead>
          <tbody>
            {metric === 'available' && <tr class="tot"><td class="sticky">Ready to assign</td>{months.map(m => { const v = views[m].ready_to_assign; return <td class={'money ' + (v < 0 ? 'neg' : v > 0 ? 'pos' : 'muted')}>{whole(v)}</td>; })}</tr>}
            {groups.map(g => (
              <>
                <tr class="grp"><td class="sticky">{g.name}</td>{months.map(m => { const gg = views[m].groups.find(x => x.id === g.id); const v = !gg ? 0 : metric === 'assigned' ? gg.assigned : metric === 'spent' ? -gg.activity : gg.available; return <td class={'money ' + cls(v)}>{whole(v)}</td>; })}</tr>
                {g.rows.map(c => (
                  <tr key={c.id}>
                    <td class="sticky">{c.name}</td>
                    {months.map(m => { const r = cell(m, c.id); const v = val(r); return <td class={'money tap ' + cls(v)} title={r ? fmt(v) : ''} onClick={() => r && setEdit({ c, month: m })}>{r ? whole(v) : ''}</td>; })}
                  </tr>
                ))}
              </>
            ))}
          </tbody>
        </table>
      </div>
      <span class="head" style="text-align:center">Tap a number to change what's assigned that month.{months.length > 4 ? ' Scroll sideways for earlier months.' : ''}</span>
      {edit && <CellSheet data={data} c={edit.c} month={edit.month} r={cell(edit.month, edit.c.id)} onClose={() => setEdit(null)} />}
    </>
  );
}

/** Change one category's assigned amount for one month, with that month's spent and available. */
function CellSheet({ data, c, month, r, onClose }) {
  useModal(onClose);
  const ui = useUI();
  const locked = isClosedMonth(data, month);
  const [v, setV] = useState(r ? (r.assigned / 100).toFixed(2) : '0.00');
  const prev = (() => { const pv = monthView(data, addMonths(month, -1)); for (const g of pv.groups) for (const x of g.rows) if (x.id === c.id) return x; return null; })();
  const save = async cents => { await assign(c.id, month, cents); ui.toast(`${c.name} · ${monthLabel(month)}: assigned ${fmt(cents)}`, { plain: true }); onClose(); };
  return createPortal((
    <div class="scrim">
      <div class="sheet cellsheet" role="dialog" aria-modal="true" aria-label={`${c.name}, ${monthLabel(month)}`}>
        <div class="handle" />
        <div class="row between"><b>{c.name} · {monthLabel(month)}</b><button class="ghost" onClick={onClose}>Close</button></div>
        <div class="cellstats">
          <span><span class="head">Spent</span><b class="money">{fmt(r ? -r.activity : 0)}</b></span>
          <span><span class="head">Available</span><b class={'money ' + (r && r.available < 0 ? 'neg' : 'pos')}>{fmt(r ? r.available : 0)}</b></span>
          {c.target > 0 && <span><span class="head">Target</span><b class="money">{fmt(c.target)}</b></span>}
        </div>
        {locked ? <span class="head">{monthLabel(month)} is closed. Reopen it under Settings › Budget rules to change it.</span> : <>
          <label class="field"><span class="lbl">Assigned</span><input class="num" inputMode="decimal" autofocus value={v} onFocus={e => e.target.select()} onInput={e => setV(e.target.value)} onKeyDown={e => e.key === 'Enter' && save(parseMoney(v))} /></label>
          <div class="chips">
            {prev && prev.assigned > 0 && <button class="chip" onClick={() => setV((prev.assigned / 100).toFixed(2))}>Same as {monthLabel(addMonths(month, -1)).split(' ')[0]}: {fmt(prev.assigned)}</button>}
            {c.target > 0 && <button class="chip" onClick={() => setV((c.target / 100).toFixed(2))}>Target: {fmt(c.target)}</button>}
            {r && r.activity < 0 && <button class="chip" onClick={() => setV((-r.activity / 100).toFixed(2))}>What was spent: {fmt(-r.activity)}</button>}
          </div>
          <button class="primary" onClick={() => save(parseMoney(v))}>Save</button>
        </>}
      </div>
    </div>
  ), document.body);
}
