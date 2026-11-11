import { useState } from 'preact/hooks';
import { Shell, useUI } from '../main.jsx';
import { fmt, parseMoney } from '../budget.js';
import { setPref } from '../store.js';
import { debtList, planPayoff } from '../features.js';
import { Help } from './Info.jsx';

/**
 * Debt payoff planner: credit cards and loans you owe, with each one's interest rate and minimum
 * payment, an extra amount per month, and snowball or avalanche order. Settings are synced prefs.
 */
const monthName = n => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + n); return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }); };
const span = n => n < 12 ? `${n} month${n === 1 ? '' : 's'}` : `${Math.floor(n / 12)} yr${n >= 24 ? 's' : ''}${n % 12 ? ` ${n % 12} mo` : ''}`;
const pref = (data, k, d) => data.prefs?.[k] ?? d;

/** Owed over time: the plan (solid) against minimums only (dashed). */
function Chart({ plan, base }) {
  const W = 320, H = 100, n = Math.max(plan.totals.length, base.never ? plan.totals.length * 2 : base.totals.length) - 1 || 1;
  const hi = Math.max(1, ...plan.totals, ...base.totals);
  const line = t => t.map((v, i) => `${i ? 'L' : 'M'}${(i / n) * W} ${H - 4 - (v / hi) * (H - 8)}`).join(' ');
  return (
    <svg class="fchart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" style="height:100px">
      <path d={line(base.totals.slice(0, n + 1))} class="line base" vector-effect="non-scaling-stroke" />
      <path d={line(plan.totals)} class="line" vector-effect="non-scaling-stroke" />
    </svg>
  );
}

/** Dashboard widget: debt-free date and what's owed. */
export function DebtCard({ data }) {
  const debts = debtList(data).filter(d => !d.excluded);
  const plan = planPayoff(debts, Math.max(0, Number(pref(data, 'debt:extra', 0)) || 0), pref(data, 'debt:strategy', 'snowball'));
  const owed = debts.reduce((s, d) => s + d.balance, 0);
  return (
    <a class="card fcheck" href="#/debt">
      <div class="row between"><span class="eyebrow">Debt payoff</span><span class="link" style="font-size:13px;font-weight:600;color:var(--pos)">Plan ›</span></div>
      {!debts.length ? <span class="head">No debts 🎉</span>
        : <><b style="font-size:20px">{plan.never ? 'Payments too low' : 'Debt-free ' + monthName(plan.months)}</b><span class="head"><span class="money">{fmt(owed)}</span> owed on {debts.length} account{debts.length === 1 ? '' : 's'}</span></>}
    </a>
  );
}

/** A number box you can type in freely; it saves when you leave it or press Enter (not on every key). */
function Draft({ value, onSave }) {
  const [t, setT] = useState(null);
  const done = () => { if (t !== null && t !== value) onSave(t); setT(null); };
  return <input inputMode="decimal" value={t ?? value} onFocus={e => { setT(value); e.target.select(); }} onInput={e => setT(e.target.value)} onBlur={done} onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { setT(null); e.target.blur(); } }} />;
}

export function Debt({ data }) {
  const ui = useUI();
  const allDebts = debtList(data);
  const debts = allDebts.filter(d => !d.excluded);
  const left = allDebts.filter(d => d.excluded);
  const setOut = (id, out) => { let ids = []; try { ids = JSON.parse(data.prefs?.['debt:exclude'] || '[]'); } catch {} const n = new Set(ids); out ? n.add(id) : n.delete(id); setPref('debt:exclude', JSON.stringify([...n])); };
  const [strategy, setStrategy] = useState(pref(data, 'debt:strategy', 'snowball'));
  const [extraText, setExtraText] = useState(((Number(pref(data, 'debt:extra', 0)) || 0) / 100).toFixed(2));
  const extra = Math.max(0, parseMoney(extraText));
  const plan = planPayoff(debts, extra, strategy);
  const other = planPayoff(debts, extra, strategy === 'snowball' ? 'avalanche' : 'snowball');
  const base = planPayoff(debts, 0, 'snowball', false);
  const save = (id, patch) => {
    let cur = {}; try { cur = JSON.parse(data.prefs?.['debt:' + id] || '{}'); } catch {}
    setPref('debt:' + id, JSON.stringify({ ...cur, ...patch }));
  };
  const pick = s => { setStrategy(s); setPref('debt:strategy', s); };

  const top = (
    <div class="row between">
      <a href="#/budget" class="round" style="display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:22px;background:rgba(255,255,255,.12);color:#fff;text-decoration:none;font-size:22px" aria-label="Back">‹</a>
      <div class="col" style="flex:1;margin-left:12px"><span class="eyebrow">Debt</span><span class="title">Payoff planner</span></div>
    </div>
  );
  const leftOut = left.length > 0 && (
    <div class="card">
      <span class="eyebrow">Not in this plan</span>
      {left.map(d => <div class="row between"><span>{d.name} <span class="head money">{fmt(d.balance)}</span></span><button class="chip" onClick={() => setOut(d.id, false)}>Add back</button></div>)}
      <span class="head">Left-out debts aren't counted in the debt-free date or the payments.</span>
    </div>
  );
  if (!debts.length && left.length) return <Shell route="debt" top={top}>{leftOut}</Shell>;
  if (!debts.length) return <Shell route="debt" top={top}><div class="card"><b>No debts 🎉</b><span class="head">No credit card or loan has a balance owing. If you have one, add it under Accounts as a Credit card or Loan with what you owe.</span></div></Shell>;

  const byId = Object.fromEntries(debts.map(d => [d.id, d]));
  // When both orders line up, say so (otherwise the switch looks broken).
  const same = other.order.join() === plan.order.join();
  const sameNote = !same ? null
    : debts.length === 1 ? 'With one debt, snowball and avalanche are the same plan.'
    : 'Both orders are the same for your debts: the smallest balance also has the highest rate, so switching changes nothing.';
  const target = plan.order.find(id => plan.paidOff[id] !== 1) || plan.order[0];   // gets the extra this month
  const saved = base.never ? null : base.interest - plan.interest;
  return (
    <Shell route="debt" top={top}>
      <div class="card debtsum">
        {plan.never
          ? <><span class="eyebrow">Not paying it down</span><b class="neg" style="font-size:20px">These payments don't cover the interest</b><span class="head">Raise the minimums or the extra amount below until the total owed goes down each month.</span></>
          : <>
            <span class="eyebrow">Debt-free</span>
            <b class="big">{monthName(plan.months)}</b>
            <span class="head">in {span(plan.months)} · <span class="money">{fmt(plan.interest)}</span> interest · <span class="money">{fmt(plan.monthly)}</span> a month</span>
            {base.never ? <span class="head pos">Minimums alone would never pay these off.</span>
              : !extra ? <span class="head">Add an extra amount below to see how much sooner you'd be done.</span>
              : saved > 0 || base.months > plan.months ? <span class="head pos">Compared with minimums only ({monthName(base.months)}): <b>{span(base.months - plan.months)} sooner</b>, <span class="money">{fmt(saved)}</span> less interest.</span> : null}
            {!other.never && other.interest !== plan.interest && <span class="head">{strategy === 'snowball' ? 'Avalanche' : 'Snowball'} would cost <span class="money">{fmt(Math.abs(other.interest - plan.interest))}</span> {other.interest < plan.interest ? 'less' : 'more'} in interest{other.months !== plan.months ? `, done ${monthName(other.months)}` : ''}.</span>}
            <Chart plan={plan} base={base} />
            <span class="head" style="font-size:12px">Solid: your plan. Dashed: minimums only.</span>
          </>}
      </div>

      <div class="card form">
        <div class="row between" style="gap:8px"><span class="eyebrow">Payoff order</span><Help k="debtorder" /></div>
        <div class="seg">
          <button class={strategy === 'snowball' ? 'on' : ''} onClick={() => pick('snowball')}>Snowball</button>
          <button class={strategy === 'avalanche' ? 'on' : ''} onClick={() => pick('avalanche')}>Avalanche</button>
        </div>
        <span class="head">{strategy === 'snowball' ? 'Smallest balance first. Each payoff comes sooner, which keeps you going.' : 'Highest interest rate first. The least interest overall.'} When a debt is paid off, its payment rolls onto the next one.</span>
        {sameNote && <span class="head samenote">ⓘ {sameNote}</span>}
        <label>Extra per month, on top of the minimums<input inputMode="decimal" value={extraText} onInput={e => setExtraText(e.target.value)} onBlur={e => { const v = Math.max(0, parseMoney(e.target.value)); setPref('debt:extra', v); setExtraText((v / 100).toFixed(2)); }} /></label>
      </div>

      <div class="row" style="margin:4px 4px 0;gap:8px"><span class="eyebrow">In payoff order</span><Help k="debtlist" /></div>
      {plan.order.map((id, i) => {
        const d = byId[id];
        return (
          <div class="card debtrow" key={id}>
            <div class="row between" style="gap:10px"><span class="row" style="gap:10px;min-width:0"><span class={'ordnum' + (id === target ? ' now' : '')} aria-label={`Number ${i + 1} to pay off`}>{i + 1}</span><b class="nm">{d.name}</b></span><span class="money">{fmt(d.balance)}</span></div>
            {id === target && plan.monthly > debts.reduce((s, x) => s + x.min, 0) && <span class="head pos" style="font-size:12px">◎ Gets the extra money now</span>}
            <div class="row" style="gap:10px">
              <label class="sm">Interest rate (APR %)<Draft value={String(d.apr)} onSave={t => save(id, { apr: Math.max(0, parseFloat(t) || 0) })} /></label>
              <label class="sm">Minimum a month<Draft value={(d.min / 100).toFixed(2)} onSave={t => save(id, { min: Math.max(0, parseMoney(t)) })} /></label>
            </div>
            {(!d.aprSet || !d.minSet) && <span class="head" style="font-size:12px">⚠ {[!d.aprSet && 'rate', !d.minSet && 'minimum'].filter(Boolean).join(' and ')} estimated. Enter yours from your statement.</span>}
            <button class="link leaveout" onClick={() => setOut(id, true)}>Leave out of plan</button>
            <span class="head">{plan.paidOff[id] ? <>Paid off <b>{monthName(plan.paidOff[id])}</b> · this month pay <span class="money">{fmt(plan.first[id] || 0)}</span></> : 'Not paid off with these payments'}</span>
          </div>
        );
      })}
      {leftOut}
      <span class="head" style="text-align:center">Assumes fixed rates and no new charges. Interest is estimated monthly from the APR.</span>
    </Shell>
  );
}

