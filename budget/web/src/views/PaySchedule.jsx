import { useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { useModal, useUI } from '../main.jsx';
import { today, addDays } from '../budget.js';
import { uuid } from '../store.js';
import { FREQS, WEEKEND, paySchedules, savePaySchedules, payDates, describe, payShort } from '../paydays.js';
import { Help } from './Info.jsx';
import { Select } from './Pick.jsx';

/** Forecast card: when you get paid (no amounts), with Change and + Add another paycheck. */
export function PayCard({ data }) {
  const list = paySchedules(data);
  const [editing, setEditing] = useState(null);
  const t0 = today();
  return (
    <div class="card paycard span">
      <div class="row between"><span class="eyebrow">Payday <Help k="payday" /></span>
        {list.length > 0 && <button class="link" onClick={() => setEditing({})}>+ Another paycheck</button>}</div>
      {!list.length && <>
        <span class="head">When do you get paid? Tell Once Budget your pay schedule and the forecast checks that each account lasts until your real payday. No amounts needed.</span>
        <button class="primary" onClick={() => setEditing({})}>Set my payday</button>
      </>}
      {list.map(s => {
        const next = payDates(s, t0, addDays(t0, 70)).slice(0, 2);
        return (
          <button class="payrow" key={s.id} onClick={() => setEditing(s)}>
            <span class="col" style="flex:1;min-width:0;text-align:left"><b>💵 {s.name ? `${s.name}: ` : ''}{describe(s)}</b>
              <span class="head">{next.length ? `Next ${next.map(payShort).join(', then ')}` : 'No payday in the next 10 weeks'}</span></span>
            <span class="link">Change</span>
          </button>
        );
      })}
      {editing && <PaySheet data={data} s={editing} many={list.length > (editing.id ? 1 : 0)} onClose={() => setEditing(null)} />}
    </div>
  );
}

function PaySheet({ data, s, many, onClose }) {
  useModal(onClose);
  const ui = useUI();
  const t0 = today();
  const [freq, setFreq] = useState(s.freq || 'biweekly');
  const [start, setStart] = useState(s.start || t0);
  const [days, setDays] = useState(s.days || [15, 31]);
  const [weekend, setWeekend] = useState(s.weekend || 'before');
  const [name, setName] = useState(s.name || '');
  const draft = { id: s.id || uuid(), name: name.trim(), freq, weekend, ...(freq === 'semimonthly' ? { days: days.map(Number) } : { start }) };
  const next = start || freq === 'semimonthly' ? payDates(draft, t0, addDays(t0, 100)).slice(0, 3) : [];
  const save = async () => {
    const list = paySchedules(data).filter(x => x.id !== draft.id);
    await savePaySchedules([...list, draft]);
    ui.toast(`Payday saved · next ${next[0] ? payShort(next[0]) : '—'}`); onClose();
  };
  const remove = async () => { await savePaySchedules(paySchedules(data).filter(x => x.id !== s.id)); ui.toast('Payday removed'); onClose(); };
  const dayOpts = Array.from({ length: 31 }, (_, i) => i + 1);
  return createPortal((
    <div class="scrim">
      <div class="sheet paysheet fitbody" role="dialog" aria-modal="true" aria-label="When you get paid">
        <div class="handle" />
        <div class="row between"><b>When do you get paid?</b><button class="ghost" onClick={onClose}>Close</button></div>
        <div class="grow col" style="gap:10px">
          <div class="seg wrap2">{FREQS.map(([k, l]) => <button class={freq === k ? 'on' : ''} onClick={() => setFreq(k)}>{l}</button>)}</div>
          {freq === 'semimonthly' ? (
            <div class="row" style="gap:8px">
              {[0, 1].map(i => (
                <label class="field" style="flex:1"><span class="lbl">{i ? 'and' : 'On the'}</span>
                  <Select value={days[i]} onChange={e => setDays(d => d.map((x, j) => (j === i ? Number(e.target.value) : x)))}>
                    {dayOpts.map(d => <option value={d}>{d === 31 ? 'Last day' : d}</option>)}
                  </Select></label>
              ))}
            </div>
          ) : (
            <label class="field"><span class="lbl">{freq === 'monthly' ? 'A payday' : 'One payday'}</span>
              <input type="date" value={start} onInput={e => setStart(e.target.value)} /></label>
          )}
          <span class="head">{freq === 'semimonthly' ? 'The two days of the month you get paid.' : 'Any payday, the last one or the next one. Once Budget counts forward from it.'}</span>
          <span class="lbl" style="font-size:13px;color:var(--muted)">When payday falls on a weekend</span>
          <div class="seg">{WEEKEND.map(([k, l]) => <button class={weekend === k ? 'on' : ''} onClick={() => setWeekend(k)}>{l}</button>)}</div>
          {many && <label class="field"><span class="lbl">Whose</span><input value={name} placeholder="optional, e.g. Sam" onInput={e => setName(e.target.value)} /></label>}
          <div class="paynext"><span class="head">Next paydays</span><b>{next.length ? next.map(payShort).join(' · ') : '—'}</b></div>
        </div>
        <div class="row">
          {s.id && <button class="ghost neg" onClick={remove}>Remove</button>}
          <button class="primary" style="flex:1" disabled={!next.length} onClick={save}>Save</button>
        </div>
      </div>
    </div>
  ), document.body);
}
