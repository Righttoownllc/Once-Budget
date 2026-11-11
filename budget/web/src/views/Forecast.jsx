import { useState } from 'preact/hooks';
import { Shell, useUI } from '../main.jsx';
import { fmt, today, addDays, dayLabel } from '../budget.js';
import { cashForecast, scheduleOccurrences, postScheduled, skipScheduled } from '../features.js';
import { put } from '../store.js';
import { Editor } from './Scheduled.jsx';
import { Help } from './Info.jsx';
import { PayCard } from './PaySchedule.jsx';
import { paydaysBetween } from '../paydays.js';

/**
 * "Will I make it to payday?" Each spending account's balance projected from scheduled bills,
 * paychecks and transfers (plus anything entered with a future date).
 */
const RANGES = [[14, '2 weeks'], [35, '5 weeks'], [90, '3 months']];
const short = iso => new Date(iso + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** The account's events with a 💵 Payday marker after each payday's own events. */
const withPaydays = f => {
  const out = [], pays = (f.paydays || []).filter(p => !f.events.some(e => e.income && e.date === p.date));   // a listed paycheck already shows it
  for (const e of f.events) { while (pays.length && pays[0].date < e.date) out.push({ ...pays.shift(), payday: true }); out.push(e); }
  return out.concat(pays.map(p => ({ ...p, payday: true })));
};

/** One-line verdict for an account, used here, on the Budget screen and in the dashboard widget. */
export function verdict(f) {
  const until = f.payday ? ` until payday ${short(f.payday.date)}` : ' over the next 5 weeks';
  const m = v => <span class="money">{fmt(v)}</span>;   // blurs with Hide balances
  if (f.short) return { bad: true, text: <>{f.a.name} goes to {m(f.short.balance)} on {short(f.short.date)}{f.short.label ? ` (${f.short.label})` : ''}{f.payday ? `. Payday is ${short(f.payday.date)}` : ''}</> };
  return { bad: false, text: <>{f.a.name} stays above {m(f.low.balance)}{until}</> };
}

/** Small step chart of the balance per day, with the zero line. */
function Chart({ f, days }) {
  const t0 = today(), W = 320, H = 90, pts = [];
  let bal = f.start, i = 0;
  for (let d = 0; d <= days; d++) {
    const iso = addDays(t0, d);
    while (i < f.events.length && f.events[i].date <= iso) bal = f.events[i++].balance;
    pts.push(bal);
  }
  const lo = Math.min(0, ...pts), hi = Math.max(1, ...pts), y = v => H - 6 - ((v - lo) / (hi - lo)) * (H - 12), x = d => (d / days) * W;
  let path = `M0 ${y(pts[0])}`;
  pts.forEach((v, d) => { if (d) path += ` H${x(d)} V${y(v)}`; });
  const payX = f.payday ? x(Math.round((new Date(f.payday.date) - new Date(t0)) / 864e5)) : null;
  return (
    <svg class="fchart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      {lo < 0 && <rect x="0" y={y(0)} width={W} height={H - y(0)} class="below" />}
      <line x1="0" x2={W} y1={y(0)} y2={y(0)} class="zero" />
      {payX !== null && <line x1={payX} x2={payX} y1="0" y2={H} class="pay" />}
      <path d={path} class={f.short ? 'line bad' : 'line'} vector-effect="non-scaling-stroke" />
    </svg>
  );
}

/** Compact card: one verdict per account with something scheduled, problems first. */
export function PaydayCheck({ data, title = 'Payday check', empty = false }) {
  const list = cashForecast(data, 35).filter(f => f.scheduled).map(f => ({ f, v: verdict(f) })).sort((x, y) => y.v.bad - x.v.bad);
  if (!list.length) return empty ? <a class="card fcheck" href="#/forecast"><span class="eyebrow">{title}</span><span class="head">Schedule your paycheck and bills to see whether each account makes it to payday.</span></a> : null;
  return (
    <a class="card fcheck" href="#/forecast">
      <div class="row between"><span class="eyebrow">{title}</span><span class="link" style="font-size:13px;font-weight:600;color:var(--pos)">Forecast ›</span></div>
      {list.slice(0, 3).map(({ f, v }) => <span class={'fl' + (v.bad ? ' bad' : '')} key={f.a.id}>{v.bad ? '⚠ ' : '✓ '}{v.text}</span>)}
    </a>
  );
}

const VIEW_KEY = 'budget.forecastView';
const iso = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

/**
 * Bills calendar: the month as a grid with every scheduled bill, paycheck and transfer, and the
 * days an account would be below zero. Tap a day for its items (post, skip, move) and balances.
 */
function Calendar({ data }) {
  const ui = useUI();
  const now = new Date();
  const [offset, setOffset] = useState(0);   // months from this one, 0..11
  const [sel, setSel] = useState(today());
  const [moving, setMoving] = useState(null);   // scheduled id whose date is being changed
  const [adding, setAdding] = useState(null);   // new recurring item starting on the chosen day
  const first = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  const t0 = today(), end = iso(last);
  const horizon = Math.max(1, Math.round((last - new Date(t0 + 'T00:00:00')) / 864e5) + 1);
  const fc = cashForecast(data, horizon);
  const occ = scheduleOccurrences(data, end);
  const acctName = Object.fromEntries(data.accounts.map(a => [a.id, a.name]));
  const byDay = {};
  for (const o of occ) (byDay[o.date] ||= []).push(o);
  const payOn = Object.fromEntries(paydaysBetween(data, iso(first), end).map(p => [p.date, p]));
  // Each spending account's balance at the end of a day (from the forecast).
  const balOn = (f, d) => { let b = f.start; for (const e of f.events) { if (e.date > d) break; b = e.balance; } return b; };
  const negDay = d => d >= t0 && fc.some(f => f.events.length && balOn(f, d) < 0);

  const cells = [];
  for (let i = 0; i < first.getDay(); i++) cells.push(null);
  for (let d = 1; d <= last.getDate(); d++) cells.push(iso(new Date(first.getFullYear(), first.getMonth(), d)));
  const kind = o => (o.s.transfer_to ? 'xfer' : o.s.amount > 0 ? 'inc' : 'bill');
  const items = byDay[sel] || [];
  const showBal = fc.filter(f => f.events.length || f.scheduled);

  const act = async (fn, msg) => { await fn(); ui.toast(msg); };
  return (
    <div class="col" style="gap:12px">
      <div class="card cal">
        <div class="row between">
          <button class="round ghost" disabled={offset === 0} onClick={() => setOffset(offset - 1)} aria-label="Previous month">‹</button>
          <b>{first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</b>
          <button class="round ghost" disabled={offset >= 11} onClick={() => setOffset(offset + 1)} aria-label="Next month">›</button>
        </div>
        <div class="calgrid">
          {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(w => <span class="wd">{w}</span>)}
          {cells.map(d => d === null ? <span /> : (
            <button class={'day' + (d === sel ? ' sel' : '') + (d === t0 ? ' today' : '') + (d < t0 ? ' past' : '') + (negDay(d) ? ' neg' : '')} onClick={() => { setSel(d); setMoving(null); }}>
              <span class="n">{Number(d.slice(8))}</span>
              <span class="dots">{payOn[d] && <i class="pay" />}{(byDay[d] || []).slice(0, payOn[d] ? 3 : 4).map(o => <i class={kind(o)} />)}</span>
            </button>
          ))}
        </div>
        <div class="row head callegend"><span><i class="bill" /> bill</span><span><i class="inc" /> income</span><span><i class="xfer" /> transfer</span><span><i class="negkey" /> below zero</span>{Object.keys(payOn).length > 0 && <span><i class="pay" /> payday</span>}</div>
      </div>

      <div class="card">
        <div class="row between"><b>{dayLabel(sel)}</b>{sel >= t0 && <button class="link" style="font-weight:600;color:var(--pos)" onClick={() => setAdding({ next_date: sel })}>+ Recurring</button>}</div>
        {payOn[sel] && <div class="calitem"><b style="color:var(--pos)">💵 Payday{payOn[sel].label ? ` (${payOn[sel].label})` : ''}</b></div>}
        {!items.length && !payOn[sel] && <span class="head">Nothing scheduled.{sel >= t0 ? ' Tap + Recurring to add a bill or paycheck that starts this day.' : ''}</span>}
        {items.map(o => (
          <div class="calitem">
            <div class="row between">
              <span class="col"><span>{o.s.transfer_to ? `Transfer to ${acctName[o.s.transfer_to] || 'account'}` : o.s.payee || 'Scheduled'}</span>
                <span class="head">{acctName[o.s.account_id] || ''}{o.s.next_date < t0 && o.next ? ' · overdue' : ''}</span></span>
              <span class={'money' + (kind(o) === 'inc' ? ' pos' : '')}>{fmt(o.s.transfer_to ? -Math.abs(o.s.amount) : o.s.amount)}</span>
            </div>
            {o.next && (moving === o.s.id
              ? <div class="row"><input type="date" value={o.s.next_date} min={t0} onChange={async e => { if (!e.target.value) return; await put('scheduled', { ...o.s, next_date: e.target.value }); setMoving(null); setSel(e.target.value); ui.toast(`Moved to ${dayLabel(e.target.value)}`); }} /><button class="ghost" onClick={() => setMoving(null)}>Cancel</button></div>
              : <div class="row">
                {o.date <= t0 && <button class="primary" onClick={() => act(() => postScheduled(o.s), `Posted ${o.s.payee || 'transfer'}`)}>Post</button>}
                <button class="ghost" onClick={() => act(() => skipScheduled(o.s), `Skipped this ${o.s.payee || 'transfer'}`)}>Skip</button>
                <button class="ghost" onClick={() => setMoving(o.s.id)}>Move to…</button>
              </div>)}
          </div>
        ))}
        {sel >= t0 && showBal.length > 0 && <>
          <span class="eyebrow" style="margin-top:8px">End of day</span>
          {showBal.map(f => { const b = balOn(f, sel); return <div class="row between"><span>{f.a.name}</span><span class={'money' + (b < 0 ? ' neg' : '')}>{fmt(b)}</span></div>; })}
        </>}
      </div>
      {adding && <Editor data={data} row={adding} onClose={() => setAdding(null)} />}
    </div>
  );
}

export function Forecast({ data }) {
  const [view, setViewS] = useState(() => { try { return localStorage.getItem(VIEW_KEY) || 'list'; } catch { return 'list'; } });
  const setView = v => { setViewS(v); try { localStorage.setItem(VIEW_KEY, v); } catch {} };
  const [days, setDays] = useState(35);
  const list = cashForecast(data, days);
  const withPlans = list.filter(f => f.events.length);
  const top = (
    <div class="row between">
      <a href="#/budget" class="round" style="display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:22px;background:rgba(255,255,255,.12);color:#fff;text-decoration:none;font-size:22px" aria-label="Back">‹</a>
      <div class="col" style="flex:1;margin-left:12px"><span class="eyebrow">Forecast <Help k="forecast" /></span><span class="title">Will I make it to payday?</span></div>
    </div>
  );
  return (
    <Shell route="forecast" top={top}>
      <PayCard data={data} />
      <div class="seg nowrap" style="align-self:flex-start"><button class={view === 'list' ? 'on' : ''} onClick={() => setView('list')}>List</button><button class={view === 'calendar' ? 'on' : ''} onClick={() => setView('calendar')}>Calendar</button></div>
      {view === 'calendar' ? <Calendar data={data} /> : <>
      <div class="seg nowrap" style="align-self:flex-start">{RANGES.map(([d, l]) => <button class={days === d ? 'on' : ''} onClick={() => setDays(d)}>{l}</button>)}</div>
      {!withPlans.length && (
        <div class="card"><span class="head">Nothing scheduled yet. Add your paycheck and regular bills under <a href="#/scheduled" class="link">Scheduled</a> and this shows how each account's balance will move, and whether it dips below zero before payday.</span></div>
      )}
      {withPlans.map(f => {
        const v = verdict(f);
        return (
          <div class={'card fcard' + (withPlans.length === 1 ? ' span' : '')} key={f.a.id}>
            <div class="row between"><b>{f.a.name}</b><span class="head">today <span class="money">{fmt(f.start)}</span></span></div>
            <div class={'fverdict ' + (v.bad ? 'bad' : 'ok')}>{v.bad ? '⚠ ' : '✓ '}{v.text}</div>
            <Chart f={f} days={days} />
            <div class="flist">
              {withPaydays(f).map(e => e.payday ? (
                <div class="frow payday"><span class="d">{dayLabel(e.date)}</span><span class="p">💵 Payday{e.label ? ` (${e.label})` : ''}<span class="head"> · amount not counted</span></span></div>
              ) : (
                <div class={'frow' + (e.balance < 0 ? ' neg' : '') + (e.income ? ' inc' : '')}>
                  <span class="d">{dayLabel(e.date)}</span>
                  <span class="p">{e.label}{e.entered ? <span class="head"> · entered</span> : ''}</span>
                  <span class={'money a' + (e.amount > 0 ? ' pos' : '')}>{e.amount > 0 ? '+' : ''}{fmt(e.amount)}</span>
                  <span class="money b">{fmt(e.balance)}</span>
                </div>
              ))}
            </div>
            <div class="row between head"><span>In {RANGES.find(r => r[0] === days)[1]}{f.paydays.length && !f.events.some(e => e.income) ? ', before paychecks' : ''}</span><span class="money">{fmt(f.end)}</span></div>
          </div>
        );
      })}
      {list.length > withPlans.length && <span class="head" style="text-align:center">{list.filter(f => !f.events.length).map(f => f.a.name).join(', ')}: nothing scheduled.</span>}
      </>}
      <span class="head" style="text-align:center">Based on your scheduled transactions and anything entered with a future date. Spending you haven't scheduled isn't included.</span>
    </Shell>
  );
}
