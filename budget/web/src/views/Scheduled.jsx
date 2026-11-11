import { createPortal } from 'preact/compat';
import { useRef, useState } from 'preact/hooks';
import { ask } from '../dialog.js';
import { Shell, useUI, useModal } from '../main.jsx';
import { fmt, parseMoney, today, dayLabel } from '../budget.js';
import { put, remove } from '../store.js';
import { postScheduled, skipScheduled } from '../features.js';
import { CatInput } from './CatInput.jsx';
import { Help } from './Info.jsx';
import { Select } from './Pick.jsx';

const FREQ = { weekly: 'Every week', biweekly: 'Every 2 weeks', monthly: 'Every month', yearly: 'Every year' };

export function Scheduled({ data }) {
  const ui = useUI();
  const [editing, setEditing] = useState(null);   // null | {} (new) | row
  const list = [...data.scheduled].sort((a, b) => a.next_date.localeCompare(b.next_date));
  const acctName = Object.fromEntries(data.accounts.map(a => [a.id, a.name]));
  const catName = Object.fromEntries(data.categories.map(c => [c.id, c.name]));
  const monthly = list.reduce((s, r) => s + (r.frequency === 'monthly' ? r.amount : r.frequency === 'weekly' ? r.amount * 52 / 12 : r.frequency === 'biweekly' ? r.amount * 26 / 12 : r.amount / 12), 0);

  const top = (
    <div class="row between">
      <a href="#/budget" class="round" style="display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:22px;background:rgba(255,255,255,.12);color:#fff;text-decoration:none;font-size:22px" aria-label="Back">‹</a>
      <div class="col" style="flex:1;margin-left:12px"><span class="eyebrow">Recurring <Help k="scheduled" /></span><span class="title">Scheduled</span></div>
      <button class="white" onClick={() => setEditing({})}>+ New</button>
    </div>
  );

  return (
    <Shell route="budget" top={top}>
      {editing && <Editor data={data} row={editing} onClose={() => setEditing(null)} />}
      <div class="card">
        <div class="row between"><span class="eyebrow">Net per month</span><b class={'money ' + (monthly < 0 ? 'neg' : 'pos')}>{fmt(Math.round(monthly))}</b></div>
        {list.length === 0 && <p class="muted" style="margin:0">Nothing scheduled yet. Add rent, paycheck, subscriptions — they'll show up on the Budget tab when due.</p>}
        <div>
          {list.map(s => (
            <div class="due" key={s.id}>
              <div class="main" onClick={() => setEditing(s)} style="cursor:pointer">
                <div class="p">{s.transfer_to ? `Transfer ${acctName[s.account_id]} → ${acctName[s.transfer_to]}` : s.payee}{s.auto ? <span class="pill" style="margin-left:6px">auto</span> : null}</div>
                <div class="s">{FREQ[s.frequency]} · next {dayLabel(s.next_date)}{s.transfer_to ? '' : ` · ${acctName[s.account_id]}`}{s.category_id ? ` · ${catName[s.category_id]}` : s.transfer_to && !data.accounts.find(a => a.id === s.transfer_to)?.on_budget ? ' · ⚠ no category' : ''}</div>
              </div>
              <span class={'money ' + (s.amount > 0 ? 'pos' : '')} style="font-weight:600">{fmt(s.amount)}</span>
              {s.next_date <= today() && <button class="primary" style="min-height:36px;padding:6px 12px" onClick={async () => { await postScheduled(s); ui.toast(`Posted ${s.payee || 'transfer'}`); }}>Post</button>}
            </div>
          ))}
        </div>
      </div>
    </Shell>
  );
}

export function Editor({ data, row, onClose }) {
  const ui = useUI();
  const [err, setErr] = useState('');
  // Tapping outside or Back with something typed asks first, so a half-filled bill isn't lost.
  const startRef = useRef(null);
  const dirtyRef = useRef(false);
  useModal(onClose, () => (dirtyRef.current ? ask(row.id ? 'Discard your changes to this scheduled item?' : 'Discard this scheduled item? What you typed will be lost.', { title: 'Discard?', ok: 'Discard', cancel: 'Keep editing', danger: true }) : true));
  const accts = data.accounts.filter(a => !a.closed);
  const groupName = Object.fromEntries(data.groups.map(g => [g.id, g.name]));
  const [f, setF] = useState({
    kind: row.transfer_to ? 'transfer' : (row.amount || 0) > 0 ? 'in' : 'out',
    payee: row.payee || '', amount: row.amount ? (Math.abs(row.amount) / 100).toFixed(2) : '',
    account_id: row.account_id || accts[0]?.id || '', transfer_to: row.transfer_to || accts[1]?.id || '',
    category_id: row.category_id || '', memo: row.memo || '', frequency: row.frequency || 'monthly',
    next_date: row.next_date || today(), auto: !!row.auto,
  });
  const set = k => e => { setErr(''); setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }); };
  if (startRef.current === null) startRef.current = JSON.stringify(f);
  dirtyRef.current = JSON.stringify(f) !== startRef.current;
  const toAcct = accts.find(a => a.id === f.transfer_to);
  const toOffBudget = f.kind === 'transfer' && toAcct && !toAcct.on_budget;
  const save = async () => {
    const cents = parseMoney(f.amount);
    if (!cents) return setErr('Enter the amount.');
    if (f.kind !== 'transfer' && !f.payee.trim()) return setErr('Enter who it\'s paid to (or from).');
    if (!f.account_id) return setErr('Choose an account.');
    if (!f.next_date) return setErr('Choose the next date.');
    if (f.kind === 'transfer' && (!f.transfer_to || f.transfer_to === f.account_id)) return setErr('Choose a different account to transfer to.');
    await put('scheduled', {
      ...(row.id ? row : {}),
      account_id: f.account_id, transfer_to: f.kind === 'transfer' ? f.transfer_to : null,
      payee: f.kind === 'transfer' ? 'Transfer' : f.payee.trim(),
      category_id: f.kind === 'transfer' ? (toOffBudget ? f.category_id || null : null) : f.category_id || null,
      memo: f.memo.trim(), amount: f.kind === 'in' ? cents : -cents, frequency: f.frequency, next_date: f.next_date, auto: f.auto ? 1 : 0,
    });
    ui.toast(row.id ? 'Updated' : 'Scheduled'); onClose();
  };
  return createPortal((
    <div class="scrim">
      <div class="sheet" role="dialog" aria-modal="true" aria-label="Scheduled transaction">
        <div class="handle" />
        <div class="seg">{[['out', 'Spent'], ['in', 'Received'], ['transfer', 'Transfer']].map(([k, l]) => <button class={f.kind === k ? 'on' : ''} onClick={() => setF({ ...f, kind: k })}>{l}</button>)}</div>
        {f.kind !== 'transfer' && <div class="field"><span class="lbl">Payee</span><input value={f.payee} onInput={set('payee')} placeholder="Rent, Netflix, Paycheck…" /></div>}
        <div class="row">
          <div class="field" style="flex:1"><span class="lbl">Amount</span><input class="num" inputMode="decimal" value={f.amount} onInput={set('amount')} placeholder="0.00" /></div>
          <div class="field" style="flex:1"><span class="lbl">Repeats</span><Select value={f.frequency} onChange={set('frequency')}>{Object.entries(FREQ).map(([k, v]) => <option value={k}>{v}</option>)}</Select></div>
        </div>
        <div class="row">
          <div class="field" style="flex:1"><span class="lbl">{f.kind === 'transfer' ? 'From' : 'Account'}</span><Select value={f.account_id} onChange={set('account_id')}>{accts.map(a => <option value={a.id}>{a.name}</option>)}</Select></div>
          {f.kind === 'transfer' && <div class="field" style="flex:1"><span class="lbl">To</span><Select value={f.transfer_to} onChange={set('transfer_to')}>{accts.filter(a => a.id !== f.account_id).map(a => <option value={a.id}>{a.name}</option>)}</Select></div>}
          <div class="field" style="flex:1"><span class="lbl">Next</span><input type="date" value={f.next_date} onInput={set('next_date')} /></div>
        </div>
        {(f.kind !== 'transfer' || toOffBudget) && (
          <div class="field"><span class="lbl">Category</span>
            <CatInput data={data} value={f.category_id} onChange={id => setF({ ...f, category_id: id || '' })} income={f.kind === 'in'} spending={f.kind !== 'in'} noneLabel={f.kind === 'in' ? 'Ready to assign' : 'Uncategorized'} placeholder={toOffBudget ? 'Category this loan payment comes from…' : 'Category…'} />
          </div>
        )}
        {toOffBudget && <span class="head">{toAcct.name} is off-budget, so this payment is an expense: it comes out of the category above and lowers the loan balance. {!f.category_id && <b class="neg">Pick a category or it will come straight from Ready to Assign.</b>}</span>}
        {f.kind === 'transfer' && toAcct && toAcct.on_budget && <span class="head">Transfers between budget accounts (including card payments) don't need a category.</span>}
        <div class="field"><span class="lbl">Memo</span><input value={f.memo} onInput={set('memo')} placeholder="optional" /></div>
        <label class="check"><input type="checkbox" checked={f.auto} onChange={set('auto')} /> Post automatically on the due date (otherwise it waits for you to tap Post)</label>
        {err && <div class="neg head" role="alert">{err}</div>}
        <div class="row">
          <button class="primary" style="flex:1" onClick={save}>{row.id ? 'Update' : 'Schedule'}</button>
          {row.id && <button class="ghost neg" onClick={async () => { await remove('scheduled', row.id); ui.toast('Removed', { undo: () => put('scheduled', { ...row, deleted: 0 }) }); onClose(); }}>Delete</button>}
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  ), document.body);
}
