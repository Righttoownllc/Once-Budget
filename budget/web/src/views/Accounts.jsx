import { useState, useEffect, useRef } from 'preact/hooks';
import { Shell, useUI, nav } from '../main.jsx';
import { balances, fmt, parseMoney, today, dayLabel, ym, cardCoverage, newestFirst, stampLabel, monthView } from '../budget.js';
import { put, remove, restore, haptic, beginBatch, endBatch, canChangeAll } from '../store.js';
import { tell, ask } from '../dialog.js';
import { Roll } from './Roll.jsx';
import { Empty } from './Empty.jsx';
import { pop } from '../fun.js';
import { reconcileAge, getDefaultAccount, setDefaultAccount } from '../features.js';
import { SearchResults } from './Search.jsx';
import { CsvImport } from './CsvImport.jsx';
import { Help } from './Info.jsx';
import { useAuthors } from '../authors.js';
import { tipWaiting, tipPosted } from '../tips.js';
import { TipClear } from './TipClear.jsx';
import { Select } from './Pick.jsx';

const TYPES = { checking: 'Checking', savings: 'Savings', cash: 'Cash', credit: 'Credit card', loan: 'Loan' };
const isLiability = t => t === 'credit' || t === 'loan';

export function Accounts({ data }) {
  const ui = useUI();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [showClosed, setShowClosed] = useState(false);
  const all = balances(data.accounts, data.txs);
  const accts = all.filter(a => !a.closed);
  const closed = all.filter(a => a.closed);
  const cash = accts.filter(a => !isLiability(a.type));
  const cards = accts.filter(a => a.type === 'credit');
  const loans = accts.filter(a => a.type === 'loan');
  const sum = l => l.reduce((s, a) => s + a.balance, 0);
  const netWorth = sum(accts);

  const top = (
    <div class="col">
      <span class="eyebrow">Net worth <Help k="networth" /></span>
      <Roll class={'rta money ' + (netWorth < 0 ? 'bad' : 'ok')} value={netWorth} ms={900} />
      <span class="head" style="color:var(--head-muted)">Cash <b class="money" style="color:#fff">{fmt(sum(cash))}</b> · Debt <b class="money" style="color:#fff">{fmt(sum(cards) + sum(loans))}</b></span>
    </div>
  );

  const section = (title, list) => list.length > 0 && (
    <div class="card">
      <div class="row between"><span class="eyebrow">{title}</span><span class="eyebrow money">{fmt(sum(list))}</span></div>
      <div>
        {list.map(a => (
          <a class="acct" href={'#/accounts/' + a.id} key={a.id}>
            <div class="col"><span style="font-weight:500">{a.name} <ReconBadge acct={a} /></span><span class="head">{a.type === 'credit' && a.balance < 0 ? <CoverTag acct={a} data={data} /> : <>{TYPES[a.type]}{a.cleared_balance !== a.balance ? ` · ${fmt(a.balance - a.cleared_balance)} uncleared` : ''}</>}{a.tips_pending > 0 && <span class="tiptag"> · bank shows {fmt(Math.abs(a.balance + a.tips_pending))}{a.balance + a.tips_pending < 0 && isLiability(a.type) ? ' owed' : ''} until {fmt(a.tips_pending)} in tips post</span>}</span></div>
            <Roll class={'money ' + (a.balance < 0 ? 'neg' : '')} style="font-weight:600" value={a.balance} />
          </a>
        ))}
      </div>
    </div>
  );

  return (
    <Shell route="accounts" top={top}>
      <div class="search"><input type="search" placeholder="Search payee, memo, amount…" value={q} onInput={e => setQ(e.target.value)} /></div>
      {!q.trim() && <ReadyToPay data={data} cards={cards.concat(loans)} />}
      {q.trim() ? <SearchResults data={data} q={q} /> : (
        <>
          {!accts.length && !open && <Empty icon="🏦" title="No accounts yet" hint="Add your checking account first; its balance becomes money to budget." />}
          {section('Cash', cash)}
          {section('Credit cards', cards)}
          {section('Loans', loans)}
          {open ? <NewAccount count={accts.length} data={data} onDone={msg => { setOpen(false); if (msg !== undefined) ui.toast('Account added' + msg); }} /> : <button class="dark" onClick={() => setOpen(true)}>+ Add account</button>}
          {closed.length > 0 && <button class="ghost" onClick={() => setShowClosed(s => !s)}>{showClosed ? 'Hide' : 'Show'} {closed.length} closed account{closed.length === 1 ? '' : 's'}</button>}
          {showClosed && section('Closed', closed)}
        </>
      )}
    </Shell>
  );
}

/** Banner listing every card/loan with money already set aside to pay it. */
function ReadyToPay({ data, cards }) {
  const ui = useUI();
  const items = cards.map(a => ({ a, c: cardCoverage(a, data, ym()) })).filter(x => x.c.ready > 0);
  const [open, setOpen] = useState(items.length === 1 ? items[0].a.id : null);
  if (!items.length) return null;
  const total = items.reduce((s, x) => s + x.c.ready, 0);
  const from = data.accounts.find(a => !a.closed && !isLiability(a.type))?.id;
  const payoff = data.categories.find(x => x.id === data.prefs?.payoff_category_id && !x.deleted);
  return (
    <div class="card" style="background:var(--pos-bg)">
      <div class="row between"><span class="eyebrow" style="color:var(--pos)">Ready to pay <Help k="readytopay" /></span><b class="money pos">{fmt(total)}</b></div>
      {items.map(({ a, c }) => (
        <div class="col" key={a.id} style="gap:4px">
          <div class="row between">
            <button type="button" class="col linkish" style="text-align:left;background:none;padding:0" aria-expanded={open === a.id} onClick={() => setOpen(open === a.id ? null : a.id)}>
              <span style="font-weight:500">{a.name} <span class="head">{open === a.id ? '▴' : '▾'}</span></span><span class="head">{fmt(c.ready)} of {fmt(c.debt)} covered{c.uncovered ? ` · ${fmt(c.uncovered)} not yet` : ''}</span></button>
            {canChangeAll() && <button class="primary" style="min-height:36px;padding:6px 12px" onClick={() => ui.open({ account_id: from, pay_to: a.id, amount: c.ready })}>Pay {fmt(c.ready)}</button>}
          </div>
          {open === a.id && <ReadySources acct={a} data={data} c={c} payoff={payoff} />}
        </div>
      ))}
    </div>
  );
}

function ReconBadge({ acct }) {
  const age = reconcileAge(acct);
  if (age === null) return <span class="pill amber" title="Never reconciled">never reconciled</span>;
  if (age >= 30) return <span class="pill amber">reconciled {age}d ago</span>;
  return null;
}


function CoverTag({ acct, data }) {
  const c = cardCoverage(acct, data, ym());
  return c.uncovered > 0
    ? <><span class="cover">{fmt(c.ready)} ready</span> <span class="uncov">{fmt(c.uncovered)} not covered</span></>
    : <span class="cover">{fmt(c.ready)} ready to pay</span>;
}

function NewAccount({ count, onDone, data }) {
  const [type, setType] = useState('checking');
  const debt = isLiability(type);
  const cash = (data?.accounts || []).filter(a => !a.closed && !a.deleted && a.on_budget && !isLiability(a.type));
  const loanCat = (data?.categories || []).find(c => !c.deleted && /loan|car payment|mortgage/i.test(c.name));
  return (
    <form class="card form" onSubmit={async e => {
      e.preventDefault();
      const f = e.target;
      const name = f.name.value.trim();
      beginBatch(`Added account ${name}`);
      let msg = '';
      try {
        const a = await put('accounts', { name, type, on_budget: type === 'loan' ? 0 : 1, closed: 0, sort: count, reconciled_balance: 0 });
        let bal = parseMoney(f.balance.value);
        if (debt && bal > 0) bal = -bal;   // people type what they owe as a positive number
        if (bal) await put('transactions', { account_id: a.id, date: f.date.value, payee: 'Starting balance', category_id: null, memo: '', amount: bal, cleared: 1 });
        if (debt) {
          // Rate and minimum feed the debt payoff planner; due day + minimum become a scheduled
          // monthly payment, so a reminder comes the morning it's due.
          const apr = f.apr.value.trim() === '' ? null : Math.max(0, parseFloat(f.apr.value) || 0);
          const min = parseMoney(f.min.value);
          const day = Math.min(31, Math.max(0, parseInt(f.due.value, 10) || 0));
          if (apr !== null || min) await put('household_prefs', { id: 'debt:' + a.id, value: JSON.stringify({ ...(apr !== null ? { apr } : {}), ...(min ? { min } : {}) }) });
          if (day && min && cash[0]) {
            const t = new Date(today() + 'T12:00:00'); const n = new Date(t.getFullYear(), t.getMonth(), Math.min(day, 28), 12); if (n < t) n.setMonth(n.getMonth() + 1);
            const pay = f.payfrom?.value || cash[0].id;
            await put('scheduled', { payee: 'Transfer', amount: -min, frequency: 'monthly', next_date: n.toISOString().slice(0, 10), account_id: pay, transfer_to: a.id, category_id: type === 'loan' ? loanCat?.id || null : null, memo: `${name} payment`, auto: 0 });
            msg = ` · ${fmt(min)} payment scheduled for the ${day}${['th', 'st', 'nd', 'rd'][(day % 10 > 3 || [11, 12, 13].includes(day % 100)) ? 0 : day % 10]} with a reminder`;
          }
        }
      } finally { endBatch(); }
      onDone(msg);
    }}>
      <label>Name<input name="name" required autoFocus /></label>
      <div class="grid2">
        <label>Type<Select name="type" value={type} onChange={e => setType(e.target.value)}>{Object.entries(TYPES).map(([k, v]) => <option value={k}>{v}</option>)}</Select></label>
        <label>As of<input name="date" type="date" value={today()} /></label>
      </div>
      <label>{debt ? 'What you owe today' : 'Current balance'}<input name="balance" class="num" inputMode="decimal" placeholder="0.00" /></label>
      {debt && <>
        <div class="grid2">
          <label>Interest rate (APR %)<input name="apr" class="num" inputMode="decimal" placeholder={type === 'credit' ? 'e.g. 21.99' : 'e.g. 6.4'} /></label>
          <label>Minimum payment<input name="min" class="num" inputMode="decimal" placeholder="0.00" /></label>
        </div>
        <div class="grid2">
          <label>Due day of the month<input name="due" class="num" inputMode="numeric" placeholder="e.g. 15" /></label>
          {cash.length > 1 ? <label>Paid from<Select name="payfrom">{cash.map(a => <option value={a.id}>{a.name}</option>)}</Select></label> : <span />}
        </div>
        <p class="head" style="margin:0">The rate and minimum go into the debt payoff planner. With a due day and minimum, Budget schedules the monthly payment{type === 'loan' ? (loanCat ? ` from ${loanCat.name}` : '') : ''} and reminds you the morning it's due.{type === 'credit' ? " A card's starting debt lowers Ready to Assign by that much: it's money you still need to set aside to pay it off." : ''}</p>
      </>}
      {!debt && <p class="head" style="margin:0">Checking, savings and cash count toward Ready to Assign.</p>}
      <div class="row"><button class="primary">Add account</button><button type="button" onClick={() => onDone()}>Cancel</button></div>
    </form>
  );
}

export function AccountDetail({ data, id }) {
  const ui = useUI();
  const acct = balances(data.accounts, data.txs).find(a => a.id === id);
  const [filter, setFilter] = useState('all');
  const [recon, setRecon] = useState(false);
  const [tipAsk, setTipAsk] = useState(null);   // a transaction with a waiting tip being marked cleared
  const [settings, setSettings] = useState(false);
  const [csv, setCsv] = useState(false);
  const [sort, setSort] = useState('date');          // date (uncleared first) | newest | amount
  const [tq, setTq] = useState('');
  const [sel, setSel] = useState(null);              // null = normal; Set of ids = select mode
  // Long histories draw in pages, more as you near the end, so the list stays quick to scroll.
  const PAGE = 120;
  const [shown, setShown] = useState(PAGE);
  useEffect(() => setShown(PAGE), [id, filter, sort, tq]);
  const moreRef = useRef(null);
  useEffect(() => {
    const el = moreRef.current; if (!el || !('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) setShown(n => n + PAGE); }, { rootMargin: '800px' });
    io.observe(el); return () => io.disconnect();
  });
  const who = useAuthors();                           // names and colours for the initials on each transaction
  if (!acct) return <Shell route="accounts" top={<div class="title">Account not found</div>}><a href="#/accounts">Back</a></Shell>;

  const catName = Object.fromEntries(data.categories.map(c => [c.id, c.name]));
  const acctName = Object.fromEntries(data.accounts.map(a => [a.id, a.name]));
  // Each transfer's other half, found once (searching every transaction for every row was slow).
  const legs = new Map();
  for (const x of data.txs) if (x.transfer_id) { const l = legs.get(x.transfer_id); l ? l.push(x) : legs.set(x.transfer_id, [x]); }
  const otherLeg = t => (t.transfer_id ? (legs.get(t.transfer_id) || []).find(x => x.id !== t.id) || null : null);
  // Uncleared first (newest first), then everything cleared by date and entry time: clearing an
  // item moves it into its place, and editing never moves it.
  let txs = data.txs.filter(t => t.account_id === id).sort((a, b) => (a.cleared ? 1 : 0) - (b.cleared ? 1 : 0) || newestFirst(a, b));
  const unclearedCount = txs.filter(t => t.cleared === 0).length;
  if (filter === 'uncleared') txs = txs.filter(t => t.cleared === 0);
  if (filter === 'month') txs = txs.filter(t => t.date.startsWith(ym()));
  if (filter === 'transfers') txs = txs.filter(t => t.transfer_id);
  if (sort === 'newest') txs = [...txs].sort(newestFirst);
  if (sort === 'amount') txs = [...txs].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount) || newestFirst(a, b));
  const liability = isLiability(acct.type);
  const authors = new Set(data.txs.map(t => t.created_by).filter(Boolean));
  const multiUser = authors.size > 1;
  const groupName = Object.fromEntries(data.groups.map(g => [g.id, g.name]));
  const selected = sel ? txs.filter(t => sel.has(t.id)) : [];
  const toggleSel = id => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const batch = async (fn, msg, undo) => { beginBatch(msg); try { for (const t of selected) await fn(t); } finally { endBatch(); } haptic('success'); ui.toast(msg, undo ? { undo } : {}); setSel(null); };
  const batchDelete = () => {
    const rows = selected.filter(t => t.cleared !== 2);
    const legs = rows.flatMap(t => t.transfer_id ? [t, otherLeg(t)].filter(Boolean) : [t]);
    return (async () => {
      beginBatch(`Deleted ${rows.length} transactions`);
      try { for (const t of legs) await remove('transactions', t.id); } finally { endBatch(); }
      haptic('warn');
      ui.toast(`Deleted ${rows.length} transaction${rows.length === 1 ? '' : 's'}`, { undo: async () => { for (const t of legs) await restore('transactions', t.id); } });
      setSel(null);
    })();
  };

  const top = (
    <>
      <div class="row between">
        <a href="#/accounts" class="round" style="display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:22px;background:rgba(255,255,255,.12);color:#fff;text-decoration:none;font-size:22px" aria-label="Back">‹</a>
        <div class="col" style="flex:1;margin-left:12px"><span class="eyebrow">{TYPES[acct.type]}{acct.closed ? ' · closed' : ''}</span><span class="title">{acct.name}</span></div>
        <button class="round" aria-label="Account settings" onClick={() => setSettings(s => !s)}>⋯</button>
        {sel ? <button class="white" onClick={() => setSel(null)}>Done</button> : <button class="white" onClick={() => setRecon(r => !r)}>Reconcile</button>}
      </div>
    </>
  );

  return (
    <Shell route="accounts" top={top}>
      <div class={'strip ' + (liability && acct.balance < 0 ? 'owe' : '')}>
        <div class="col"><span class="head">Balance</span><Roll class={'money ' + (acct.balance < 0 ? 'neg' : '')} style="font-size:20px;font-weight:700" value={acct.balance} ms={900} /></div>
        <div class="col" style="margin-left:auto;text-align:right"><span class="head">Cleared</span><Roll class="money" style="font-weight:600" value={acct.cleared_balance} ms={900} /></div>
        {!canChangeAll() ? null : liability
          ? <button class="dark" onClick={() => ui.open({ account_id: data.accounts.find(a => !a.closed && !isLiability(a.type))?.id, pay_to: id })}>Pay {acct.type === 'loan' ? 'loan' : 'card'}</button>
          : <button class="dark" onClick={() => ui.open({ account_id: id, kind: 'transfer' })}>Transfer</button>}
      </div>
      {acct.tips_pending > 0 && <div class="card tipnote"><span>💵 Your bank shows <b class="money">{fmt(Math.abs(acct.balance + acct.tips_pending))}</b>{liability ? ' owed' : ''} for now: <b class="money">{fmt(acct.tips_pending)}</b> in tips hasn't posted yet. When it does, tap the circle on the purchase to clear it.</span></div>}
      {tipAsk && <TipClear tx={tipAsk} onClose={() => setTipAsk(null)} />}

      {acct.type === 'credit' && <CoverageCard acct={acct} data={data} onPay={amt => ui.open({ account_id: data.accounts.find(a => !a.closed && !isLiability(a.type))?.id, pay_to: id, amount: amt })} />}

      {settings && <AccountSettings acct={acct} data={data} onDone={() => setSettings(false)} onImport={() => { setSettings(false); setCsv(true); }} />}
      {csv && <CsvImport acct={acct} data={data} onDone={() => setCsv(false)} />}
      {recon && <Reconcile account={acct} txs={data.txs.filter(t => t.account_id === id)} onDone={() => setRecon(false)} />}
      {!recon && reconcileAge(acct) !== null && reconcileAge(acct) >= 30 && <div class="warn amber" onClick={() => setRecon(true)}><span>Last reconciled {reconcileAge(acct)} days ago</span><span>Reconcile ›</span></div>}
      {!recon && reconcileAge(acct) === null && data.txs.some(t => t.account_id === id) && <div class="warn amber" onClick={() => setRecon(true)}><span>Never reconciled against the bank</span><span>Reconcile ›</span></div>}

      <div class="search"><input type="search" placeholder={`Search ${acct.name}…`} value={tq} onInput={e => setTq(e.target.value)} /></div>
      {tq.trim() ? <SearchResults data={data} q={tq} account_id={id} /> : <>
      <div class="chips">
        {[['all', 'All'], ['uncleared', `Uncleared ${unclearedCount}`], ['month', 'This month'], ['transfers', liability ? 'Payments' : 'Transfers']].map(([k, l]) => (
          <button class={'chip ' + (filter === k ? 'on' : '')} onClick={() => setFilter(k)}>{l}</button>
        ))}
        <span style="flex:0 0 1px;background:var(--line);height:24px;align-self:center" />
        {[['date', 'Uncleared first'], ['newest', 'Newest'], ['amount', 'Largest']].map(([k, l]) => (
          <button class={'chip ' + (sort === k ? 'on' : '')} onClick={() => setSort(k)}>{l}</button>
        ))}
        <span style="flex:0 0 1px;background:var(--line);height:24px;align-self:center" />
        <button class={'chip ' + (sel ? 'on' : '')} onClick={() => setSel(sel ? null : new Set())}>{sel ? `${sel.size} selected` : 'Select'}</button>
        {sel && <button class="chip" onClick={() => setSel(new Set(txs.map(t => t.id)))}>Select all</button>}
      </div>

      <div>
        {txs.length === 0 && (filter === 'all' ? <Empty icon="☕" title="Nothing here yet" hint="Tap + after your next coffee, or import your bank's CSV from ⋯." /> : <Empty icon="✨" title="All clear" hint="Nothing matches this filter." />)}
        {txs.slice(0, shown).map((t, i) => {
          const other = otherLeg(t);
          const showDay = sort === 'date' && (i === 0 || txs[i - 1].date !== t.date);
          return (
            <div key={t.id}>
              {showDay && <div class="daylbl">{dayLabel(t.date)}</div>}
              <div class={'txrow ' + (t.cleared === 2 ? 'rec ' : '') + (sel && sel.has(t.id) ? 'sel' : '')}>
                {sel
                  ? <input type="checkbox" class="selbox" checked={sel.has(t.id)} onChange={() => toggleSel(t.id)} aria-label="Select" />
                  : t.cleared === 2
                    ? <span class="clr c2" title="Reconciled">R</span>
                    : <button class={'clr ' + (t.cleared === 1 ? 'c1' : '')} aria-label={t.cleared ? 'Cleared, tap to unclear' : 'Tap to mark cleared'} onClick={e => { if (!t.cleared && tipWaiting(t)) return setTipAsk(t); if (!t.cleared) pop(e.currentTarget); put('transactions', { ...t, cleared: t.cleared ? 0 : 1 }); }}>{t.cleared ? '✓' : ''}</button>}
                <div class="main" onClick={() => sel ? toggleSel(t.id) : ui.open({ tx: t })}>
                  <div class="p">{other ? `${t.amount < 0 ? (liability ? 'Payment to' : 'Transfer to') : 'Payment from'} ${acctName[other.account_id] || '?'}` : t.payee || '(no payee)'}{t.split_id ? <span class="pill" style="margin-left:6px">split</span> : null}</div>
                  <div class="s">{sort !== 'date' ? `${dayLabel(t.date)} · ` : ''}{other ? (t.category_id ? `${catName[t.category_id]} · loan payment` : other.category_id ? `Loan payment · from ${catName[other.category_id]}` : 'Transfer · no budget effect') : t.category_id ? catName[t.category_id] || 'Uncategorized' : t.amount > 0 ? 'Ready to assign' : 'Uncategorized'}{t.memo ? ` · ${t.memo}` : ''}</div>
                </div>
                <span class={'money txamt ' + (t.amount > 0 ? 'pos' : '')} style="font-weight:600" onClick={() => sel ? toggleSel(t.id) : ui.open({ tx: t })}>{t.amount > 0 ? '+' : ''}{fmt(t.amount)}
                  {tipWaiting(t) ? <span class="tipwait" title={`Your bank shows ${fmt(Math.abs(t.amount + t.tip_pending))} until the tip posts`}>+ tip waiting</span> : null}</span>
                {multiUser && t.created_by && (() => { const w = who(t.created_by); return (
                  <button type="button" class={'who' + (w.color ? ' tinted' : '')} style={w.color ? `background:${w.color}` : ''} aria-label={`Entered by ${w.name}`}
                    onClick={e => { e.stopPropagation(); ui.toast(`Entered by ${w.name} · ${stampLabel(t)}`, { plain: true }); }}>{w.initials}</button>
                ); })()}
              </div>
            </div>
          );
        })}
        {txs.length > shown && <button ref={moreRef} class="ghost" style="width:100%" onClick={() => setShown(n => n + PAGE)}>Show more ({txs.length - shown} older)</button>}
      </div>

      </>}
      {sel && sel.size > 0 && (
        <div class="selbar">
          <b>{sel.size} selected · {fmt(selected.reduce((x, t) => x + t.amount, 0))}</b>
          <button onClick={async () => {
            const tips = selected.filter(t => tipWaiting(t));
            const posted = !tips.length || await ask(`${tips.length === 1 ? '1 of these has a tip' : `${tips.length} of these have tips`} your bank may not have posted yet. Does your bank show the full amount${tips.length === 1 ? '' : 's'}, with the tip${tips.length === 1 ? '' : 's'}?`, { title: 'Tips', ok: 'Yes, clear them', cancel: 'Leave those uncleared' });
            batch(t => t.cleared !== 2 && (tipWaiting(t) ? (posted && tipPosted(t)) : put('transactions', { ...t, cleared: 1 })), `Cleared ${posted ? sel.size : sel.size - tips.length}`);
          }}>Clear</button>
          <button onClick={() => batch(t => t.cleared !== 2 && put('transactions', { ...t, cleared: 0 }), `Uncleared ${sel.size}`)}>Unclear</button>
          <Select aria-label="Set category" onChange={e => { const v = e.target.value; if (!v) return; const cid = v === '__none' ? null : v; batch(t => !t.transfer_id && t.cleared !== 2 && put('transactions', { ...t, category_id: cid }), `Categorized ${sel.size}`); }}>
            <option value="">Category…</option><option value="__none">Uncategorized</option>
            {data.categories.map(c => <option value={c.id}>{groupName[c.group_id]}: {c.name}</option>)}
          </Select>
          <button class="danger" onClick={batchDelete}>Delete</button>
        </div>
      )}
    </Shell>
  );
}

function AccountSettings({ acct, data, onDone, onImport }) {
  const ui = useUI();
  const [name, setName] = useState(acct.name);
  const strip = a => { const { balance, cleared_balance, tips_pending, ...row } = a; return row; };
  const siblings = data.accounts.filter(a => !a.closed).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  const idx = siblings.findIndex(a => a.id === acct.id);
  const move = async dir => {
    const other = siblings[idx + dir]; if (!other) return;
    const order = siblings.map(a => a.id); order[idx] = other.id; order[idx + dir] = acct.id;
    for (let i = 0; i < order.length; i++) { const a = data.accounts.find(x => x.id === order[i]); if (a.sort !== i) await put('accounts', { ...a, sort: i }); }
  };
  return (
    <div class="card form">
      <span class="eyebrow">Account settings</span>
      <div class="row">
        <input value={name} onInput={e => setName(e.target.value)} aria-label="Account name" />
        <button onClick={async () => { if (name.trim() && name !== acct.name) { await put('accounts', { ...strip(acct), name: name.trim() }); ui.toast('Renamed'); } }}>Rename</button>
      </div>
      <label class="check"><input type="checkbox" checked={getDefaultAccount() === acct.id} onChange={e => { setDefaultAccount(e.target.checked ? acct.id : null); ui.toast(e.target.checked ? `${acct.name} is now the default for new transactions` : 'Default cleared'); }} /> Default account for new transactions (this device)</label>
      <div class="row" style="flex-wrap:wrap">
        <button disabled={idx <= 0} onClick={() => move(-1)}>↑ Move up</button>
        <button disabled={idx < 0 || idx >= siblings.length - 1} onClick={() => move(1)}>↓ Move down</button>
        <button onClick={onImport}>Import CSV</button>
      </div>
      {acct.closed
        ? <button onClick={async () => { await put('accounts', { ...strip(acct), closed: 0 }); ui.toast('Reopened'); onDone(); }}>Reopen account</button>
        : <button class="ghost" onClick={async () => {
            if (acct.balance !== 0) { await tell(`Balance must be $0.00 to close (it's ${fmt(acct.balance)}). Transfer it out first.`, { title: "Can't close yet" }); return; }
            await put('accounts', { ...strip(acct), closed: 1 }); ui.toast(`Closed ${acct.name}`, { undo: () => put('accounts', { ...strip(acct), closed: 0 }) }); nav('#/accounts');
          }}>Close account (keeps history)</button>}
      <button class="ghost" onClick={onDone}>Done</button>
    </div>
  );
}

function CoverageCard({ acct, data, onPay }) {
  const c = cardCoverage(acct, data, ym());
  const payoff = data.categories.find(x => x.id === data.prefs?.payoff_category_id && !x.deleted);
  if (c.debt === 0) return null;
  return (
    <div class="card">
      <div class="row between">
        <div class="col"><span class="eyebrow">Ready to pay <Help k="readytopay" /></span><b class="money pos" style="font-size:20px">{fmt(c.ready)}</b></div>
        <div class="col" style="text-align:right"><span class="eyebrow">Of balance</span><span class="money" style="font-weight:600">{fmt(c.debt)}</span></div>
        {canChangeAll() && <button class="primary" disabled={c.ready === 0} onClick={() => onPay(c.ready)}>Pay {fmt(c.ready)}</button>}
      </div>
      <div class="bar"><i style={`width:${Math.round(c.ready / c.debt * 100)}%`} /></div>
      {c.ready > 0 && <ReadySources acct={acct} data={data} c={c} payoff={payoff} />}
      {c.uncovered > 0 ? (
        <div class="head">
          <b class="neg">{fmt(c.uncovered)} not covered by the budget.</b>{' '}
          {c.overspent > 0 && <>{fmt(c.overspent)} is in overspent categories — cover them on the Budget tab. </>}
          {c.rolled > 0 && <>{fmt(c.rolled)} is card overspending rolled into {payoff?.name || 'your payoff category'}: fund it on the Budget tab. </>}
          {c.uncategorized > 0 && (payoff
            ? <>{fmt(c.uncategorized)} is uncategorized (often the starting balance). <button class="link" onClick={async () => {
                beginBatch(`Starting debt → ${payoff.name}`);
                try { for (const t of data.txs.filter(t => t.account_id === acct.id && !t.transfer_id && !t.category_id && t.amount < 0)) await put('transactions', { ...t, category_id: payoff.id }); } finally { endBatch(); }
              }}>Put it in {payoff.name}</button></>
            : <>{fmt(c.uncategorized)} is uncategorized (often the starting balance): give it a category like "Card payoff", then assign money to it. <a href="#/more/rules" class="link">Set up a payoff category</a> to roll card overspending there too.</>)}
        </div>
      ) : <div class="head">Every dollar on this card already came out of a category. Paying it won't touch the budget.</div>}
    </div>
  );
}

/**
 * Where a card's Ready to pay comes from: money assigned to the payoff category (by debt plan order or
 * your own), this month's purchases on the card that their categories covered, and the rest
 * (earlier purchases, already paid for out of their categories).
 */
function ReadySources({ acct, data, c, payoff }) {
  const month = ym();
  const v = monthView(data, month);
  const avail = {}, names = {};
  for (const g of v.groups) for (const r of g.rows) { avail[r.id] = r.available; names[r.id] = r.name; }
  const spent = {};
  for (const t of data.txs) if (t.account_id === acct.id && t.category_id && t.category_id !== payoff?.id && !t.transfer_id && t.date.slice(0, 7) === month) spent[t.category_id] = (spent[t.category_id] || 0) - t.amount;
  let left = c.ready;
  const rows = [];
  const add = (label, amt, sub) => { const a = Math.min(left, amt); if (a > 0) { rows.push({ label, amt: a, sub }); left -= a; } };
  if (c.fromPayoff > 0) add(payoff?.name || 'Payoff category', c.fromPayoff, data.prefs?.roll_fund_by_plan === '0' ? 'in your card order' : 'in debt plan order');
  Object.entries(spent).filter(([, a]) => a > 0)
    .map(([id, a]) => [id, a - Math.min(a, Math.max(0, -(avail[id] ?? 0)))])
    .sort((x, y) => y[1] - x[1])
    .forEach(([id, a]) => add(names[id] || 'A category', a, `this month's purchases`));
  if (left > 0) rows.push({ label: 'Earlier purchases', amt: left, sub: 'already paid for out of their categories' });
  return (
    <div class="readysrc">
      <span class="eyebrow">Where the {fmt(c.ready)} comes from</span>
      {rows.map(r => <div class="row between" key={r.label}><span>{r.label} <span class="head">· {r.sub}</span></span><b class="money">{fmt(r.amt)}</b></div>)}
    </div>
  );
}

function Reconcile({ account, txs, onDone }) {
  const [stmt, setStmt] = useState('');
  const target = stmt === '' ? null : parseMoney(stmt) * (isLiability(account.type) && parseMoney(stmt) > 0 ? -1 : 1);
  const diff = target === null ? null : target - account.cleared_balance;
  const finish = async () => {
    for (const t of txs) if (t.cleared === 1) await put('transactions', { ...t, cleared: 2 });
    const { balance, cleared_balance, tips_pending, ...row } = account;
    await put('accounts', { ...row, reconciled_balance: target, reconciled_at: Date.now() });
    onDone();
  };
  return (
    <div class="card form">
      <b>Reconcile {account.name}</b>
      <label><span>Balance on your bank's site right now</span><input class="num" inputMode="decimal" value={stmt} onInput={e => setStmt(e.target.value)} placeholder="0.00" autoFocus /></label>
      <div class="head">Cleared in app: <b class="money">{fmt(account.cleared_balance)}</b></div>
      {account.tips_pending > 0 && <div class="head">💵 {fmt(account.tips_pending)} in tips hasn't posted at your bank yet. Those purchases stay uncleared: tap the circle on each once your bank shows the full amount.</div>}
      {diff !== null && (diff === 0
        ? <div class="pos">Matches. Finishing locks all cleared transactions.</div>
        : <div class="neg">Off by <span class="money">{fmt(diff)}</span>. Tap the circles below to clear/unclear until it matches, or add an adjustment.</div>)}
      <div class="row" style="flex-wrap:wrap">
        <button class="primary" disabled={diff !== 0} onClick={finish}>Finish</button>
        {diff !== null && diff !== 0 && <button onClick={() => put('transactions', { account_id: account.id, date: today(), payee: 'Reconciliation adjustment', category_id: null, memo: '', amount: diff, cleared: 1 })}>Add {fmt(diff)} adjustment</button>}
        <button class="ghost" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}
