import { createPortal } from 'preact/compat';
import { useState } from 'preact/hooks';
import { useModal } from '../main.jsx';
import { monthView, addMonths, monthLabel, fmt } from '../budget.js';
import { spareCategories, coverFrom, cardPartOfOverspend, rollSettings } from '../features.js';

/**
 * Cover overspending in one or more categories (ids, in order). Pick where the money comes from:
 * Ready to Assign, a category that can spare some, or next month's money. A source that doesn't
 * have enough covers what it can, and the sheet stays open for the rest.
 */
export function CoverSheet({ data, month, ids, ui, onClose, onDone }) {
  useModal(onClose);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [part, setPart] = useState('all');   // 'all' | 'cash': leave the card part to roll at month end
  const v = monthView(data, month);
  const rows = v.groups.flatMap(g => g.rows);
  const over = ids.map(id => rows.find(r => r.id === id)).filter(r => r && r.available < 0);
  const total = over.reduce((s, r) => s - r.available, 0);
  // The card part can wait: at month end it moves to the payoff category (when that's on).
  const cardPart = Object.fromEntries(over.map(r => [r.id, cardPartOfOverspend(data, month, r)]));
  const cardTotal = Object.values(cardPart).reduce((s, x) => s + x, 0);
  const caps = part === 'cash' ? Object.fromEntries(over.map(r => [r.id, -r.available - cardPart[r.id]])) : null;
  const left = part === 'cash' ? total - cardTotal : total;
  const payoffName = data.categories.find(c => c.id === rollSettings(data).payoff)?.name || 'your payoff category';
  const spare = spareCategories(data, month, v).filter(r => !ids.includes(r.id));
  const shown = more ? spare : spare.slice(0, 5);
  const nextName = monthLabel(addMonths(month, 1)).split(' ')[0];
  const what = over.length === 1 ? over[0].name : `${over.length} categories`;

  const take = async (src, have, name) => {
    const amount = Math.min(have, left);
    setBusy(true);
    try {
      await coverFrom(data, month, over.map(r => r.id), src, amount, `Covered ${fmt(amount)} of ${what} from ${name}`, caps);
      if (amount >= left) { ui.toast(`Covered ${what} from ${name}`); onDone && onDone(); onClose(); }
      else ui.toast(`${fmt(amount)} from ${name}. ${fmt(left - amount)} still to cover.`);
    } finally { setBusy(false); }
  };

  if (!total) return null;
  const Src = ({ src, have, name, sub }) => (
    <button class="pick coverpick" disabled={busy} onClick={() => take(src, have, name)}>
      <span class="col" style="min-width:0"><b>{name}</b>{sub && <span class="head">{sub}</span>}</span>
      <span class="money pos" style="font-weight:600;flex:none">{have >= left ? `Cover ${fmt(left)}` : `Take ${fmt(have)}`}</span>
    </button>
  );
  return createPortal((
    <div class="scrim">
      <div class="sheet coversheet" role="dialog" aria-modal="true" aria-label={`Cover ${what}`}>
        <div class="handle" />
        <div class="row between"><b>Cover {fmt(total)} overspent</b><button class="ghost" onClick={onClose}>Cancel</button></div>
        <span class="head">{over.length === 1 ? `${over[0].name} is overspent in ${monthLabel(month)}.` : over.map(r => `${r.name} ${fmt(r.available)}`).join(' · ')} Where should the money come from?</span>
        {cardTotal > 0 && <>
          <div class="seg" role="group" aria-label="How much to cover">
            <button class={part === 'all' ? 'on' : ''} aria-pressed={part === 'all'} onClick={() => setPart('all')}>All {fmt(total)}</button>
            <button class={part === 'cash' ? 'on' : ''} aria-pressed={part === 'cash'} onClick={() => setPart('cash')}>{total > cardTotal ? `Cash part ${fmt(total - cardTotal)}` : 'Leave it on the card'}</button>
          </div>
          <span class="head">{fmt(cardTotal)} of it was on a credit card. {part === 'cash' ? `That part stays on the card: at the end of the month it moves to ${payoffName}, and your debt plan pays it.` : 'Covering it now sets the money aside to pay that card.'}</span>
        </>}
        {left === 0 ? <div class="row"><button class="primary" style="flex:1" onClick={onClose}>OK, leave it</button></div> : <>
        <div class="coverlist">
          {v.ready_to_assign > 0 && <Src src="rta" have={v.ready_to_assign} name="Ready to assign" sub={`${fmt(v.ready_to_assign)} not given a job yet`} />}
          {v.ready_to_assign < left && shown.map(r => <Src src={r.id} have={r.spare} name={r.name} sub={`${fmt(r.available)} left${r.why ? ' · ' + r.why : ''}`} />)}
          {v.ready_to_assign < left && spare.length > 5 && <button class="link" onClick={() => setMore(m => !m)}>{more ? 'Fewer' : `${spare.length - 5} more categories`}</button>}
          {!spare.length && v.ready_to_assign <= 0 && <span class="head">No category has money to spare this month.</span>}
        </div>
        {v.ready_to_assign < left && <div class="coverlast">
          <Src src="next" have={left} name={`Take from ${nextName}'s money`} sub={`Covers it all now; ${fmt(left)} comes off ${nextName}'s Ready to assign`} />
        </div>}
        </>}
      </div>
    </div>
  ), document.body);
}
