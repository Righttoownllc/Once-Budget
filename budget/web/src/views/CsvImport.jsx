import { useRef, useState } from 'preact/hooks';
import { useUI } from '../main.jsx';
import { fmt, dayLabel } from '../budget.js';
import { put, putMany, haptic, beginBatch, endBatch, setPref } from '../store.js';
import { parseCSV, guessColumns, guessRefColumn, draftsFromCSV, detectRecurring, learnRule, fileFingerprint } from '../features.js';
import { CatInput } from './CatInput.jsx';
import { Roll } from './Roll.jsx';
import { Select } from './Pick.jsx';

const FREQ = { weekly: 'weekly', biweekly: 'every 2 weeks', monthly: 'monthly', yearly: 'yearly' };

/**
 * Import a bank CSV into one account:
 * file → map columns → categorize by payee (learns rules) → review rows → recurring → import.
 */
export function CsvImport({ acct, data, onDone }) {
  const ui = useUI();
  const [rows, setRows] = useState(null);
  const [cols, setCols] = useState(null);
  const [invert, setInvert] = useState(false);
  const [drafts, setDrafts] = useState(null);
  const [step, setStep] = useState('payees');        // payees | rows | recurring
  const [learn, setLearn] = useState({});            // payeeKey -> { category_id, save }
  const [recur, setRecur] = useState(null);
  const [busy, setBusy] = useState(false);
  // Set synchronously: a second tap arrives before `busy` re-renders, which is how a file got imported twice.
  const running = useRef(false);
  const [progress, setProgress] = useState(null);   // { done, total, sum } while importing
  const [file, setFile] = useState(null);            // { name, key, seenOn } of the loaded file
  const groupName = Object.fromEntries(data.groups.map(g => [g.id, g.name]));
  const catName = Object.fromEntries(data.categories.map(c => [c.id, c.name]));
  const catSelect = (value, onChange, small, inflow) => <CatInput data={data} value={value} onChange={onChange} small={small} placeholder={inflow ? 'Income category…' : 'Category…'} noneLabel={inflow ? 'Ready to assign' : 'Uncategorized'} />;

  const load = async e => {
    const f = e.target.files[0]; if (!f) return;
    const text = await f.text();
    const r = parseCSV(text);
    if (r.length < 2) { ui.toast('That file has no rows'); return; }
    // Remember each file imported into this account (synced with the budget) to warn on a repeat.
    const key = `csv:${acct.id}:${fileFingerprint(text)}`;
    setFile({ name: f.name, key, seenOn: data.prefs?.[key] || null });
    const g = { ...guessColumns(r[0]), ref: guessRefColumn(r) }; setRows(r); setCols(g); setInvert(!!g.suggestInvert); setDrafts(null);
  };
  const preview = () => {
    const d = draftsFromCSV(rows, cols, { account_id: acct.id, invert, rules: data.rules, existing: data.txs });
    setDrafts(d); setStep('payees'); setLearn({});
  };

  // ---- by-payee categorization --------------------------------------------
  const payees = (() => {
    const m = {};
    for (const d of drafts || []) {
      if (!d.include) continue;
      const k = d.payee.toLowerCase();
      const e = m[k] || (m[k] = { key: k, payee: d.payee, count: 0, total: 0, category_id: d.category_id, fromRule: !!d.ruleHit });
      e.count++; e.total += d.amount;
    }
    return Object.values(m).sort((a, b) => (a.category_id ? 1 : 0) - (b.category_id ? 1 : 0) || b.count - a.count);
  })();
  const setPayeeCat = (p, cid) => {
    setLearn(l => ({ ...l, [p.key]: { category_id: cid, save: l[p.key]?.save ?? true } }));
    setDrafts(ds => ds.map(d => d.payee.toLowerCase() === p.key ? { ...d, category_id: cid } : d));
  };
  const toggleSave = key => setLearn(l => ({ ...l, [key]: { ...l[key], save: !l[key].save } }));

  // ---- rows ------------------------------------------------------------------
  const toggle = i => setDrafts(d => d.map((x, j) => j === i ? { ...x, include: !x.include } : x));
  const setCat = (i, v) => setDrafts(d => d.map((x, j) => j === i ? { ...x, category_id: v } : x));

  // ---- recurring ----------------------------------------------------------------
  const goRecurring = () => {
    const mine = data.txs.filter(t => t.account_id === acct.id && !t.transfer_id).map(t => ({ date: t.date, amount: t.amount, payee: t.payee, category_id: t.category_id }));
    const incoming = drafts.filter(d => d.include).map(d => ({ date: d.date, amount: d.amount, payee: d.payee, category_id: d.category_id }));
    setRecur(detectRecurring([...mine, ...incoming], data.scheduled));
    setStep('recurring');
  };

  // ---- import ----------------------------------------------------------------
  const doImport = async () => {
    if (running.current) return;   // a second tap while importing would import everything twice
    running.current = true; setBusy(true);
    const sel = drafts.filter(d => d.include);
    beginBatch(`CSV import into ${acct.name} (${sel.length})`);
    // Declared outside the try: the summary below uses them (inside, it crashed after saving, and the
    // screen stayed open looking unfinished, inviting a second import).
    let nRules = 0, nSched = 0;
    try {
    if (file) await setPref(file.key, new Date().toISOString().slice(0, 10));
    // In small batches with a short pause, so you can watch the rows land and the balances roll.
    // Still one history batch (one Undo), and the lock above stops a second run.
    const rows = sel.map(d => ({ account_id: acct.id, date: d.date, payee: d.payee, memo: d.raw !== d.payee ? d.raw : '', category_id: d.category_id, amount: d.amount, cleared: 1, bank_ref: d.bank_ref || null }));
    const calm = (() => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } })();
    const size = calm ? rows.length : Math.max(10, Math.ceil(rows.length / 24));
    for (let i = 0; i < rows.length; i += size) {
      const part = rows.slice(i, i + size);
      await putMany('transactions', part, `CSV import into ${acct.name} (${sel.length})`);
      setProgress(p => ({ done: i + part.length, total: rows.length, sum: (p?.sum || 0) + part.reduce((t, r) => t + r.amount, 0) }));
      if (!calm && i + size < rows.length) await new Promise(r => setTimeout(r, 70));
    }
    for (const [key, l] of Object.entries(learn)) {
      if (!l.save || !l.category_id) continue;
      const p = payees.find(x => x.key === key);
      if (await learnRule(data.rules, p?.payee || key, l.category_id)) nRules++;
    }
    for (const r of (recur || []).filter(r => r.include)) {
      await put('scheduled', { account_id: acct.id, transfer_to: null, payee: r.payee, category_id: r.category_id, memo: '', amount: Math.round(r.amount), frequency: r.frequency, next_date: r.next_date, auto: 0 }); nSched++;
    }
    } finally { endBatch(); }
    haptic('success');
    ui.toast(`Imported ${sel.length}${nRules ? ` · ${nRules} rule${nRules === 1 ? '' : 's'}` : ''}${nSched ? ` · ${nSched} scheduled` : ''}`);
    onDone();
  };

  const colSel = (k, label) => (
    <label class="head">{label}<Select value={cols[k]} onChange={e => setCols({ ...cols, [k]: Number(e.target.value) })}>
      <option value={-1}>—</option>{rows[0].map((h, i) => <option value={i}>{h || `col ${i + 1}`}</option>)}
    </Select></label>
  );
  const included = drafts ? drafts.filter(d => d.include) : [];
  const sum = included.reduce((s, d) => s + d.amount, 0);
  const uncategorized = payees.filter(p => !p.category_id).length;

  return (
    <div class="card form">
      <div class="row between"><span class="eyebrow">Import CSV into {acct.name}</span><button class="ghost" onClick={onDone}>Close</button></div>

      {!rows && <>
        <input type="file" accept=".csv,text/csv" onChange={load} />
        <p class="head" style="margin:0">Download a CSV from your bank or card site. Rows already in this account are skipped. Payee rules are applied, and you can teach new ones as you go.</p>
      </>}

      {rows && file?.seenOn && (
        <div class="banner warn" style="margin:0">
          <b>You've imported this file before</b>
          <span class="head">{file.name} was imported into {acct.name} on {file.seenOn}. Rows already in the app will be unticked; only genuinely new ones are imported.</span>
        </div>
      )}
      {rows && !drafts && <>
        <div class="head">{rows.length - 1} rows. Check the column mapping:</div>
        <div class="grid2">{colSel('date', 'Date')}{colSel('payee', 'Payee / description')}</div>
        <div class="grid2">{colSel('amount', 'Amount (signed)')}<span class="head" style="align-self:end">or separate columns:</span></div>
        <div class="grid2">{colSel('debit', 'Debit / withdrawal')}{colSel('credit', 'Credit / deposit')}</div>
        <div class="grid2">{colSel('ref', 'Bank reference (optional)')}<span class="head" style="align-self:end">{cols.ref >= 0 ? 'Duplicates matched by this reference' : 'None found: duplicates matched by date and amount'}</span></div>
        <div class="note-box">
          <b>Every bank's file is a little different.</b> Check that the columns above are right and look over the
          rows on the next screens before importing. Duplicates are caught by your bank's reference when the file has
          one (same reference = already in the app), otherwise by date and amount, so a rare genuine
          repeat may need ticking back on. The whole import is one change you can Undo.
        </div>
        <label class="check"><input type="checkbox" checked={invert} onChange={e => setInvert(e.target.checked)} /> Flip signs (card exports often list charges as positive)</label>
        <div class="row"><button class="primary" disabled={cols.date < 0 || (cols.amount < 0 && cols.debit < 0 && cols.credit < 0)} onClick={preview}>Next</button><button onClick={() => setRows(null)}>Pick another file</button></div>
      </>}

      {drafts && step === 'payees' && <>
        <div class="row between"><b>Categorize by payee</b><span class="head">{uncategorized} of {payees.length} need one</span></div>
        <p class="head" style="margin:0">Pick a category once per merchant; it applies to every row from them. Ticked ones become rules so next time it's automatic. You can still change individual rows on the next step.</p>
        <div style="max-height:50vh;overflow:auto">
          {payees.map(p => (
            <div class="due" key={p.key}>
              <div class="main">
                <div class="p">{p.payee}</div>
                <div class="s">{p.count}× · {fmt(p.total)}{p.fromRule ? ' · from rule' : ''}</div>
                {learn[p.key]?.category_id && <label class="check head" style="margin-top:2px"><input type="checkbox" checked={learn[p.key].save} onChange={() => toggleSave(p.key)} /> remember as rule</label>}
              </div>
              <div style="flex:0 0 48%">{catSelect(p.category_id, cid => setPayeeCat(p, cid), true, p.total > 0)}</div>
            </div>
          ))}
        </div>
        <div class="row"><button class="primary" onClick={() => setStep('rows')}>Review rows</button><button onClick={() => setDrafts(null)}>Back</button></div>
      </>}

      {drafts && step === 'rows' && <>
        <div class="row between"><span class="head">{included.length} of {drafts.length} selected · {drafts.filter(d => d.dup).length} already in app · {drafts.filter(d => d.near).length} possible duplicates</span><b class="money">{fmt(sum)}</b></div>
        {drafts.some(d => d.near) && <span class="head">Possible duplicates have the same amount within a few days of something already in this account (often a purchase you logged yourself before the bank posted it). They're unticked; tick any that are really new.</span>}
        <div style="max-height:50vh;overflow:auto">
          <table class="tbl">
            <thead><tr><th></th><th>Date</th><th>Payee</th><th>Category</th><th class="r">Amount</th></tr></thead>
            <tbody>
              {drafts.map((d, i) => (
                <tr class={d.dup || d.near ? 'dup' : ''} key={i}>
                  <td><input type="checkbox" checked={d.include} onChange={() => toggle(i)} style="width:18px;height:18px;min-height:0" /></td>
                  <td>{d.date.slice(5)}</td>
                  <td>{d.payee}{d.dup ? <div class="head">already in app ({d.match})</div> : d.near ? <div class="head neg">possible duplicate of {d.match}</div> : d.raw !== d.payee ? <div class="head">{d.raw}</div> : null}</td>
                  <td style="min-width:120px">{catSelect(d.category_id, v => setCat(i, v), true, d.amount > 0)}</td>
                  <td class={'r money ' + (d.amount > 0 ? 'pos' : '')}>{fmt(d.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div class="row"><button class="primary" onClick={goRecurring} disabled={!included.length}>Next</button><button onClick={() => setStep('payees')}>Back</button></div>
      </>}

      {drafts && step === 'recurring' && <>
        <b>Recurring charges</b>
        {recur.length === 0
          ? <p class="head" style="margin:0">Nothing in this file repeats on a steady schedule yet. Import a few months and it will spot subscriptions and bills.</p>
          : <p class="head" style="margin:0">These show up on a regular rhythm. Ticked ones are added to Scheduled so they appear as Due on the Budget tab (you confirm each one; nothing posts by itself).</p>}
        {recur.map((r, i) => (
          <div class="due" key={r.key}>
            <input type="checkbox" class="selbox" checked={r.include} onChange={() => setRecur(rs => rs.map((x, j) => j === i ? { ...x, include: !x.include } : x))} />
            <div class="main">
              <div class="p">{r.payee}</div>
              <div class="s">{FREQ[r.frequency]} · seen {r.count}× · next {dayLabel(r.next_date)}{r.steady ? '' : ' · amount varies'}{r.category_id ? ` · ${catName[r.category_id]}` : ''}</div>
            </div>
            <span class={'money ' + (r.amount > 0 ? 'pos' : '')} style="font-weight:600">{fmt(Math.round(r.amount))}</span>
          </div>
        ))}
        {progress && (
          <div class="importing">
            <div class="row between"><b>Importing {progress.done} of {progress.total}</b><Roll class={'money ' + (progress.sum < 0 ? 'neg' : 'pos')} value={progress.sum} ms={250} /></div>
            <div class="bar"><i style={`width:${Math.round(progress.done / progress.total * 100)}%`} /></div>
          </div>
        )}
        <div class="row"><button class="primary" onClick={doImport} disabled={busy}>{busy ? 'Importing…' : `Import ${included.length}`}</button><button onClick={() => setStep('rows')}>Back</button></div>
        <p class="head" style="margin:0">Imported rows are marked cleared (they came from the bank). Uncategorized ones show in Money check so you can fix them later.</p>
      </>}
    </div>
  );
}
