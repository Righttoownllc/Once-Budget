import { createPortal } from 'preact/compat';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ask } from '../dialog.js';
import { fmt, today, payeeMemory, frequentCategories, monthView, ym, addDays, parseMoney, stampLabel } from '../budget.js';
import { put, remove, transfer, restore, haptic, beginBatch, endBatch, uuid, setPref } from '../store.js';
import { finishCapture, canOpenWallet, openWallet } from '../platform.js';
import { cardKey, cardLabel, refreshCaptures } from '../captures.js';
import { useUI, useModal } from '../main.jsx';
import { applyRules, learnRule, getDefaultAccount, isClosedDate, perBudget } from '../features.js';
import { CatInput, CatPicker } from './CatInput.jsx';
import { Pick } from './Pick.jsx';
import { catIcon } from '../icons.jsx';
import { tipWaiting, TIP_PCTS } from '../tips.js';
import { Help } from './Info.jsx';
import { useAuthors } from '../authors.js';

const ACCT_TYPE = { checking: 'Checking', savings: 'Savings', cash: 'Cash', credit: 'Credit card', loan: 'Loan' };
const acctOptions = list => list.map(a => ({ value: a.id, label: a.name, sub: (ACCT_TYPE[a.type] || a.type) + (a.on_budget ? '' : ' · off budget') }));

/**
 * Bottom sheet for adding/editing a transaction.
 * opts: { account_id } to preselect, or { tx } to edit an existing one.
 * A tap-to-pay capture passes { capture, amount, payee, account_id, date } (see captures.js).
 */
const acctIsLiability = t => t === 'credit' || t === 'loan';
// Sort key that ignores leading emoji/symbols so '🍗 Groceries' files under G.
const alphaKey = n => (n || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();

// Categories where "No, it's spending" was answered for the loan-payment question: don't ask again (per device, per budget).
const NOT_PAY_KEY = () => perBudget('budget.notLoanPayment');
const notPayment = () => { try { return JSON.parse(localStorage.getItem(NOT_PAY_KEY()) || '[]'); } catch { return []; } };
const rememberNotPayment = id => { try { localStorage.setItem(NOT_PAY_KEY(), JSON.stringify([...new Set([...notPayment(), id])])); } catch {} };

export function QuickAdd({ data, opts, onClose }) {
  const ui = useUI();
  const editing = opts.tx || null;
  // Asked before an accidental close (Back, tap outside) when typed work would be lost; see useModal.
  const guardRef = useRef(null);
  useModal(onClose, () => (guardRef.current ? guardRef.current() : true));
  const [locked, setLocked] = useState(editing?.cleared === 2 || (editing && isClosedDate(data, editing.date)));
  const otherLeg = editing?.transfer_id ? data.txs.find(t => t.transfer_id === editing.transfer_id && t.id !== editing.id) : null;
  const openAccts = data.accounts.filter(a => !a.closed);
  const memory = useMemo(() => payeeMemory(data.txs), [data.txs]);
  const frequent = useMemo(() => frequentCategories(data.txs), [data.txs]);
  const catById = Object.fromEntries(data.categories.map(c => [c.id, c]));
  const groupName = Object.fromEntries(data.groups.map(g => [g.id, g.name]));

  const [kind, setKind] = useState(editing ? (otherLeg ? 'transfer' : editing.amount > 0 ? 'in' : 'out') : opts.kind || (opts.pay_to ? 'transfer' : 'out'));
  // A tip the bank hasn't posted: the amount box holds what the bank shows (before the tip).
  const startTip = editing && !otherLeg ? tipWaiting(editing) : 0;
  const [digits, setDigits] = useState(editing ? String(Math.abs(editing.amount) - startTip) : opts.amount ? String(opts.amount) : '');
  // An existing tip that matches one of the percent buttons opens with that button picked.
  const [tipMode, setTipMode] = useState(() => {
    if (!startTip) return 'none';
    const base = Math.abs(editing.amount) - startTip;
    return TIP_PCTS.find(p => Math.round((base * p) / 100) === startTip) || 'custom';
  });   // 'none' | 15 | 18 | 20 | 'custom'
  const [tipText, setTipText] = useState(startTip ? (startTip / 100).toFixed(2) : '');
  const [tipOpen, setTipOpen] = useState(!!startTip || !!opts.capture || !!opts.tip);
  const [guard, setGuard] = useState(null);   // { card } when a Spent entry looks like a card payment  // cents as a string
  const [payee, setPayee] = useState(editing?.payee && !otherLeg ? editing.payee : opts.payee || '');
  const [category, setCategory] = useState(editing?.category_id || (otherLeg && otherLeg.category_id) || '');
  const defAcct = getDefaultAccount();
  const [account, setAccount] = useState(editing?.account_id || opts.account_id || (openAccts.some(a => a.id === defAcct) ? defAcct : null) || openAccts.find(a => !acctIsLiability(a.type))?.id || openAccts[0]?.id || '');
  const [other, setOther] = useState(otherLeg?.account_id || opts.pay_to || openAccts.find(a => a.id !== (opts.account_id || openAccts[0]?.id))?.id || '');
  const [date, setDate] = useState(editing?.date || opts.date || today());
  const cap = opts.capture || null;
  const author = useAuthors();
  const multiAuthor = new Set(data.txs.map(t => t.created_by).filter(Boolean)).size > 1;
  // Saving a capture remembers which account the card belongs to (before the transaction is written,
  // so "tap to undo" still undoes the purchase), then clears it from the queue.
  const rememberCard = async () => {
    if (cap?.last4 && account && data.prefs?.[cardKey(cap.last4)] !== account) await setPref(cardKey(cap.last4), account);
  };
  const finishCap = async () => {
    if (!cap) return;
    await finishCapture(cap.id).catch(() => {});
    refreshCaptures();
  };
  const dismissCap = async () => { await finishCapture(cap.id).catch(() => {}); refreshCaptures(); ui.toast('Dismissed tap-to-pay purchase', { plain: true }); onClose(); };
  const closedNew = !editing && isClosedDate(data, date);
  const [cleared, setCleared] = useState(editing ? editing.cleared > 0 : false);
  const [memo, setMemo] = useState(editing?.memo || '');
  const [touchedCat, setTouchedCat] = useState(!!editing);
  const [more, setMore] = useState(false);
  const [showMemo, setShowMemo] = useState(!!editing?.memo);
  const [splits, setSplits] = useState(null);   // null = not split; [{category_id, amount(cents)}]
  const siblings = editing?.split_id ? data.txs.filter(t => t.split_id === editing.split_id && t.id !== editing.id) : [];

  const cents = Number(digits || 0);
  const tipOn = kind === 'out' && !splits;
  const tip = !tipOn ? 0 : typeof tipMode === 'number' ? Math.round((cents * tipMode) / 100) : tipMode === 'custom' ? Math.max(0, Math.abs(parseMoney(tipText) || 0)) : 0;
  // What would be lost: a new entry with an amount typed, or any change to the opening values.
  // The baseline is taken once the sheet has settled, after it fills in a category from rules itself.
  const startRef = useRef(null), snapRef = useRef('');
  const snapshot = snapRef.current = JSON.stringify([kind, digits, payee, category, account, other, date, memo, cleared, splits, tipMode, tipText]);
  useEffect(() => { const t = setTimeout(() => { startRef.current = snapRef.current; }, 60); return () => clearTimeout(t); }, []);
  const dirty = startRef.current !== null && snapshot !== startRef.current && (editing || cents > 0 || cap);
  guardRef.current = () => (dirty ? ask(editing ? 'Discard your changes to this transaction?' : 'Discard this transaction? The amount you entered will be lost.', { title: 'Discard?', ok: 'Discard', cancel: 'Keep editing', danger: true }) : true);
  const splitSum = (splits || []).reduce((s, x) => s + (x.amount || 0), 0);
  const splitRest = cents - splitSum;
  const suggestion = memory[payee.trim().toLowerCase()];
  // Auto-fill category from payee history until the user picks one themselves.
  const gmap = Object.fromEntries(data.groups.map(g => [g.id, g]));
  const rule = applyRules(data.rules, payee);
  const [payeeFocus, setPayeeFocus] = useState(false);
  const payeeOptions = useMemo(() => {
    const m = new Map();
    for (const e of Object.values(memory)) m.set(e.payee.toLowerCase(), { payee: e.payee, category_id: e.category_id, src: 'history' });
    for (const r of data.rules) if (!m.has(r.payee.toLowerCase())) m.set(r.payee.toLowerCase(), { payee: r.payee, category_id: r.category_id, src: 'rule' });
    return [...m.values()].sort((a, b) => alphaKey(a.payee).localeCompare(alphaKey(b.payee), undefined, { sensitivity: 'base' }));
  }, [memory, data.rules]);
  const favorites = useMemo(() => {
    const cutoff = addDays(today(), -90);
    const count = {};
    for (const t of data.txs) if (t.payee && t.payee !== 'Starting balance' && t.payee !== 'Reconciliation adjustment' && !t.transfer_id && t.date >= cutoff && (t.amount < 0) === (kind !== 'in')) count[t.payee.toLowerCase()] = (count[t.payee.toLowerCase()] || 0) + 1;
    const top = Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k]) => payeeOptions.find(o => o.payee.toLowerCase() === k)).filter(Boolean);
    if (top.length >= 3) return top;
    const extra = payeeOptions.filter(o => o.src === 'rule' && !top.includes(o) && (kind !== 'in') !== !!(o.category_id && gmap[catById[o.category_id]?.group_id]?.is_income)).slice(0, 6 - top.length);
    return [...top, ...extra];
  }, [data.txs, payeeOptions, kind]);
  const payeeMatches = useMemo(() => {
    const q = payee.trim().toLowerCase(); if (!q) return [];
    const starts = payeeOptions.filter(o => o.payee.toLowerCase().startsWith(q));
    const contains = payeeOptions.filter(o => !o.payee.toLowerCase().startsWith(q) && o.payee.toLowerCase().includes(q));
    return [...starts, ...contains].filter(o => o.payee.toLowerCase() !== q).slice(0, 5);
  }, [payee, payeeOptions]);
  useEffect(() => {
    if (touchedCat) return;
    if (rule.rule && rule.category_id && catById[rule.category_id]) setCategory(rule.category_id);
    else if (suggestion?.category_id && catById[suggestion.category_id]) setCategory(suggestion.category_id);
  }, [payee]);

  const isIncomeCat = id => !!gmap[catById[id]?.group_id]?.is_income;
  const otherAcctFor = id => openAccts.find(a => a.id === id);
  const chips = useMemo(() => {
    if (kind === 'in') {
      const inc = data.categories.filter(c => gmap[c.group_id]?.is_income);
      return [...new Set([category, ...inc.map(c => c.id)].filter(Boolean))].map(id => catById[id]).filter(Boolean).slice(0, 6);
    }
    const lastLoan = kind === 'transfer' && other ? data.txs.filter(t => t.transfer_id && t.category_id && t.account_id === account && data.txs.some(x => x.transfer_id === t.transfer_id && x.account_id === other)).sort((a, b) => b.date.localeCompare(a.date))[0]?.category_id : null;
    const oname = kind === 'transfer' ? (openAccts.find(a => a.id === other)?.name || '').toLowerCase() : '';
    const words = oname.split(/[^a-z]+/).filter(w => w.length > 2);
    const nameMatch = oname ? data.categories.map(c => { const n = c.name.toLowerCase(); return { id: c.id, score: words.filter(w => n.includes(w)).length }; })
      .filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 3).filter(x => x.score === words.length || x.score >= 2 || words.length === 1).map(x => x.id) : [];
    const loanish = (kind === 'transfer' && otherAcctFor(other) && !otherAcctFor(other).on_budget)
      ? data.categories.filter(c => /loan|mortgage|debt|payoff|snowball/i.test(c.name)).sort((a, b) => (/mortgage|house|home/i.test(a.name) === /mortgage|house|home/i.test(oname) ? -1 : 1)).map(c => c.id) : [];
    const ids = [...new Set([category, lastLoan, ...nameMatch, ...loanish, ...frequent].filter(Boolean))].filter(id => !isIncomeCat(id));
    return ids.map(id => catById[id]).filter(Boolean).slice(0, 6);
  }, [frequent, category, kind, other]);

  const selectedAcct = openAccts.find(a => a.id === account);
  const otherAcct = openAccts.find(a => a.id === other);
  // Paying an off-budget loan: the money leaves the budget for good, so it comes from a category.
  const loanPay = kind === 'transfer' && otherAcct && !otherAcct.on_budget;

  useEffect(() => { if (category && ((kind === 'in') !== isIncomeCat(category))) { setCategory(''); setTouchedCat(false); } }, [kind]);
  useEffect(() => { if (loanPay && !category && chips[0]) setCategory(chips[0].id); }, [loanPay, other]);

  const press = k => {
    if (k === 'back') return setDigits(d => d.slice(0, -1));
    if (k === 'clear') return setDigits('');
    if (/\d/.test(k)) setDigits(d => (d + k).replace(/^0+(?=\d)/, '').slice(0, 9));
  };
  // A computer keyboard (top row or number pad) types the amount too, unless you're typing in a box.
  // Backspace deletes a digit, Delete or Escape-free "c" clears, Enter saves.
  const saveRef = useRef(null);
  useEffect(() => {
    const onKey = e => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const t = e.target, tag = (t?.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || t?.isContentEditable;
      // The number pad always types the amount, even from the Payee or Memo box (not from boxes that
      // take numbers themselves, like the date). The top-row digits still type into a text box.
      const pad = /^Numpad[0-9]$/.test(e.code) || (e.code === 'NumpadEnter');
      const numericBox = tag === 'input' && (/^(number|date|month)$/.test(t.type) || /decimal|numeric/.test(t.inputMode || ''));
      if (typing && !(pad && !numericBox)) return;
      if (document.querySelector('.catsheet, .dialog')) return;   // another pop-up is on top
      const digit = /^Numpad([0-9])$/.exec(e.code)?.[1] || (/^[0-9]$/.test(e.key) ? e.key : null);   // number pad works with Num Lock on or off
      if (digit) { press(digit); e.preventDefault(); }
      else if (e.key === 'Backspace') { press('back'); e.preventDefault(); }
      else if (e.key === 'Delete') { press('clear'); e.preventDefault(); }
      else if (e.key === 'Enter' && tag !== 'button' && (!typing || e.code === 'NumpadEnter')) { saveRef.current && saveRef.current(); e.preventDefault(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Guard: "Spent" on a cash account whose payee matches one of your credit cards is almost
  // always a card payment typed the wrong way. Offer to convert it to a transfer.
  const looksLikePayment = () => {
    if (kind !== 'out' || editing) return null;
    const from = openAccts.find(a => a.id === account);
    if (!from || acctIsLiability(from.type)) return null;
    const p = payee.trim().toLowerCase();
    const words = t => (t || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3 && !['card', 'credit', 'bank', 'loan', 'auto', 'payment', 'direct', 'directpay', 'online'].includes(w));
    const liab = openAccts.filter(a => acctIsLiability(a.type));
    // Account names like "Acme Card (Corner Market)" or "Acme Bank - Auto Loan": the parenthetical is a store, not the lender.
    const core = a => a.name.toLowerCase().replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
    // 1. payee contains / is contained in a liability account's core name
    let hit = p ? liab.find(a => core(a).length >= 3 && (core(a).includes(p) || p.includes(core(a)))) : null;
    // 2. a distinctive word is shared between payee and an account name (ACME BANK AUTO ↔ "Acme Bank - Auto Loan")
    if (!hit && p) hit = liab.find(a => words(core(a)).some(w => words(p).includes(w)));
    // 3. the chosen category is the one you pay an off-budget loan from (only loans: cards never take a category).
    //    Either it has mostly been used for that loan's payments, or its name says so in whole words
    //    ("Car loan", "Mortgage", "Car payment"). Not just any category with "car" in it ("Car Registration", "Daycare").
    if (!hit && category && !notPayment().includes(category)) {
      const loans = liab.filter(a => !a.on_budget);
      const leg = Object.fromEntries(data.txs.filter(t => t.transfer_id && t.amount > 0).map(t => [t.transfer_id, t.account_id]));
      const inCat = data.txs.filter(t => t.category_id === category && t.amount < 0);
      const toLoan = inCat.filter(t => t.transfer_id && loans.some(l => l.id === leg[t.transfer_id]));
      if (toLoan.length && toLoan.length * 2 > inCat.length) hit = loans.find(l => l.id === leg[toLoan[toLoan.length - 1].transfer_id]);
      else if (!toLoan.length && loans.length === 1 && /\b(loans?|mortgages?|(car|auto|truck|house|home) payments?)\b/i.test(catById[category]?.name || '')) hit = loans[0];
    }
    return hit || null;
  };

  const save = async (another = false, force = false) => {
    if (!cents) return;
    if (!force) {
      const card = looksLikePayment();
      if (card) { setGuard({ card, another }); return; }
    }
    if (kind === 'transfer') {
      if (!other || other === account) return;
      if (editing && otherLeg) { await remove('transactions', editing.id); await remove('transactions', otherLeg.id); }
      await transfer({ from_account_id: account, to_account_id: other, amount: cents, date, memo, category_id: loanPay ? category || null : null });
      if (loanPay && category) {
        const txs = data.txs.concat([{ id: 'x', account_id: account, date, amount: -cents, category_id: category }]);
        const v = monthView({ ...data, txs }, ym());
        let avail = null; for (const g of v.groups) for (const r of g.rows) if (r.id === category) avail = r.available;
        ui.toast(`Paid ${otherAcct.name} · ${catById[category].name} now ${fmt(avail)}`);
      }
    } else {
      const finalPayee = rule.rule ? rule.payee : payee.trim();
      await rememberCard();
      if (splits && splits.length) {
        const parts = splits.filter(x => x.amount > 0);
        if (splitRest !== 0 || !parts.length) return;
        const split_id = uuid();
        beginBatch(`Split ${finalPayee} ${fmt(-cents)} into ${parts.length}`);
        try {
          if (editing) await remove('transactions', editing.id);
          const when = editing?.created_at || cap?.postedAt || Date.now();
          for (const [i, x] of parts.entries()) await put('transactions', { created_at: when + i, account_id: account, date, payee: finalPayee, memo: memo.trim() ? `${memo.trim()} (${i + 1}/${parts.length})` : `split ${i + 1}/${parts.length}`, category_id: x.category_id || null, amount: kind === 'out' ? -x.amount : x.amount, cleared: cleared ? 1 : 0, transfer_id: null, split_id });
        } finally { endBatch(); }
        await finishCap();
        haptic('success'); ui.toast(`Saved ${parts.length}-way split`); onClose(); return;
      }
      const row = {
        ...(editing && !otherLeg ? editing : {}),
        account_id: account, date, payee: finalPayee, memo: memo.trim(),
        category_id: category || null,
        amount: kind === 'out' ? -(cents + tip) : cents,
        cleared: editing?.cleared === 2 ? 2 : cleared ? 1 : 0,
        transfer_id: null,
        // Marked cleared means the bank already shows the total with the tip.
        tip_pending: tip > 0 && !cleared ? tip : 0,
        // A tap-to-pay purchase is timed by the payment itself (store.js keeps an existing time).
        ...(!editing && cap?.postedAt ? { created_at: cap.postedAt } : {}),
      };
      if (editing && otherLeg) await remove('transactions', otherLeg.id);
      const saved = await put('transactions', row);
      // 15. confirmation with the category's new available
      if (row.category_id) {
        const txs = data.txs.filter(t => t.id !== saved.id).concat([saved]);
        const v = monthView({ ...data, txs }, ym());
        let avail = null; for (const g of v.groups) for (const r of g.rows) if (r.id === row.category_id) avail = r.available;
        const catName = catById[row.category_id].name;
        const offerRule = !rule.rule && finalPayee && touchedCat && (!suggestion || suggestion.category_id !== row.category_id);
        ui.toast(`${editing ? 'Updated' : 'Saved'} · ${catName} now ${fmt(avail)}${row.tip_pending ? ` · ${fmt(row.tip_pending)} tip waiting for the bank` : ''}`, offerRule ? {
          action: { label: `Always ${catName} for ${finalPayee}`, fn: () => learnRule(data.rules, finalPayee, row.category_id, finalPayee) },
        } : {});
      } else ui.toast(`${editing ? 'Updated' : 'Saved'}${row.tip_pending ? ` · ${fmt(row.tip_pending)} tip waiting for the bank` : ''}`);
      await finishCap();
    }
    haptic('success');
    if (another) { setDigits(''); setPayee(''); setCategory(''); setTouchedCat(false); setMemo(''); }
    else onClose();
  };

  saveRef.current = () => save();
  const del = async () => {
    if (!editing) return;
    await remove('transactions', editing.id);
    if (otherLeg) await remove('transactions', otherLeg.id);
    haptic('warn');
    ui.toast(`Deleted ${otherLeg ? 'transfer' : editing.payee || 'transaction'}`, { undo: async () => { await restore('transactions', editing.id); if (otherLeg) await restore('transactions', otherLeg.id); } });
    onClose();
  };

  const whole = Math.floor(cents / 100).toLocaleString();
  const frac = String(cents % 100).padStart(2, '0');

  return createPortal((
    <div class="scrim">
      <div class="sheet addsheet" role="dialog" aria-modal="true" aria-label={editing ? 'Edit transaction' : 'Add transaction'}>
        <div class="handle" />
        <div class="row between">
          <div class="seg" style="flex:1">
            {[['out', 'Spent'], ['in', 'Received'], ['transfer', 'Transfer']].map(([k, l]) => (
              <button class={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{l}</button>
            ))}
          </div>
          <button class="ghost" onClick={onClose}>Cancel</button>
        </div>
        <div class="addbody">

        {locked ? (
          <div class="lock">
            <span style="font-size:20px">🔒</span>
            <div class="col" style="flex:1"><b>{editing?.cleared === 2 ? 'Reconciled' : 'Closed month'}</b><span>{editing?.cleared === 2 ? 'This matched your bank statement. Editing it will make the account\'s cleared balance disagree with the bank.' : 'This month has been closed. Unlock to edit anyway, or reopen the month under Settings › Budget rules.'}</span></div>
            <button class="dark" onClick={() => setLocked(false)}>Unlock</button>
          </div>
        ) : null}
        {cap && (
          <div class="capbar">
            <div class="col" style="flex:1;min-width:0"><b>Tap to pay</b><span class="head">{cap.hidden ? 'Android hid the details, so enter the amount' : cardLabel(cap)}{cap.postedAt ? ' · ' + new Date(cap.postedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}{cap.merchant ? ' · ' + cap.merchant : ''}</span></div>
            <button class="ghost" onClick={dismissCap}>Dismiss</button>
          </div>
        )}
        {cap?.hidden && canOpenWallet() && <button class="ghost" style="align-self:center" onClick={() => openWallet().catch(e => ui.toast(e.message))}>See amount in Google Wallet ›</button>}
        <div class={'amt money ' + (kind === 'in' ? 'pos' : '')}>
          {kind === 'in' ? '+' : kind === 'out' ? '−' : ''}${whole}.<span class="cents">{frac}</span>
        </div>
        {tipOn && !tipOpen && <button class="memo-link" style="align-self:center;margin-top:-6px" onClick={() => setTipOpen(true)}>+ tip</button>}
        {tipOn && tipOpen && (
          <div class="tiprow">
            <div class="row between" style="gap:6px"><span class="lbl">Tip <Help k="tips" /></span>{tip > 0 && <span class="tiptotal">Total <b class="money">{fmt(cents + tip)}</b></span>}</div>
            <div class="chips tipchips">
              <button class={'chip' + (tipMode === 'none' ? ' on' : '')} onClick={() => setTipMode('none')}>No tip</button>
              {TIP_PCTS.map(p => <button class={'chip' + (tipMode === p ? ' on' : '')} onClick={() => setTipMode(p)}>{p}%{cents ? <span class="tipamt"> {fmt(Math.round((cents * p) / 100))}</span> : ''}</button>)}
              <button class={'chip' + (tipMode === 'custom' ? ' on' : '')} onClick={() => setTipMode('custom')}>Other</button>
            </div>
            {tipMode === 'custom' && <input class="num tipinput" inputMode="decimal" placeholder="Tip amount, e.g. 8.00" value={tipText} onInput={e => setTipText(e.target.value)} aria-label="Tip amount" />}
            {tip > 0 && <span class="head">{cleared ? `Cleared: your bank already shows the full ${fmt(cents + tip)}.` : `Budget counts ${fmt(cents + tip)} now · bank shows ${fmt(cents)} until the tip posts`}</span>}
          </div>
        )}

        {kind !== 'transfer' ? (
          <>
            {!payee && favorites.length > 0 && (
              <div class="chips">
                {favorites.map(o => <button class="chip" key={o.payee} onClick={() => { setPayee(o.payee); if (o.category_id && catById[o.category_id]) { setCategory(o.category_id); setTouchedCat(false); } }}>{o.payee}</button>)}
              </div>
            )}
            <div class="field big">
              <span class="lbl">Payee</span>
              <input value={payee} placeholder="Where?" autocomplete="off" onInput={e => { setPayee(e.target.value); setPayeeFocus(true); }}
                onFocus={() => setPayeeFocus(true)} onBlur={() => setTimeout(() => setPayeeFocus(false), 150)} />
              {rule.rule ? <span class="suggest">→ {rule.payee}</span> : suggestion?.category_id && catById[suggestion.category_id] && !touchedCat && <span class="suggest">usually {catById[suggestion.category_id].name}</span>}
            </div>
            {payeeFocus && payeeMatches.length > 0 && (
              <div class="sugg">
                {payeeMatches.map(o => (
                  <button class="pick" key={o.payee} onMouseDown={e => e.preventDefault()} onClick={() => { setPayee(o.payee); if (o.category_id && catById[o.category_id] && !touchedCat) setCategory(o.category_id); setPayeeFocus(false); }}>
                    <span>{o.payee}</span><span class="head">{o.category_id && catById[o.category_id] ? catById[o.category_id].name : ''}</span>
                  </button>
                ))}
              </div>
            )}
            <div class="chips">
              {kind === 'in' && <button class={'chip ' + (!category ? 'on' : '')} onClick={() => { setCategory(''); setTouchedCat(true); }}>Ready to assign</button>}
              {chips.map(c => <button class={'chip ' + (category === c.id ? 'on' : '')} onClick={() => { setCategory(c.id); setTouchedCat(true); }}>{catIcon(data, c) ? catIcon(data, c) + ' ' : ''}{c.name}</button>)}
            </div>
            {splits ? (
              <div class="col" style="gap:6px;padding:8px;border:1px solid var(--line);border-radius:12px">
                <div class="row between"><b style="font-size:13px">Split {fmt(cents)}</b><button class="ghost" style="min-height:30px;padding:4px 8px" onClick={() => setSplits(null)}>Un-split</button></div>
                {splits.map((x, i) => (
                  <div class="row" key={i}>
                    <div style="flex:1;min-width:0"><CatInput data={data} value={x.category_id} onChange={id => setSplits(ss => ss.map((y, j) => j === i ? { ...y, category_id: id } : y))} income={kind === 'in'} spending={kind !== 'in'} small placeholder="Category…" suggest={frequent} month={date.slice(0, 7)} /></div>
                    <input class="num" inputMode="decimal" style="width:96px;min-height:36px;padding:4px 8px" value={x.amount ? (x.amount / 100).toFixed(2) : ''} placeholder="0.00"
                      onInput={e => { const v = parseMoney(e.target.value); setSplits(ss => ss.map((y, j) => j === i ? { ...y, amount: v } : y)); }} />
                    <button class="ghost" style="min-height:36px;padding:4px 6px" onClick={() => setSplits(ss => ss.filter((_, j) => j !== i))}>✕</button>
                  </div>
                ))}
                <div class="row between">
                  <button class="chip" onClick={() => setSplits(ss => [...ss, { category_id: null, amount: Math.max(0, splitRest) }])}>+ line{splitRest > 0 ? ` (${fmt(splitRest)} left)` : ''}</button>
                  <span class={'head ' + (splitRest === 0 ? 'pos' : 'neg')}>{splitRest === 0 ? '✓ adds up' : splitRest > 0 ? `${fmt(splitRest)} unassigned` : `${fmt(-splitRest)} over`}</span>
                </div>
              </div>
            ) : (
            <div class="field big">
              <span class="lbl">Category</span>
              <CatInput data={data} value={category || null} onChange={id => { setCategory(id || ''); setTouchedCat(true); }}
                income={kind === 'in'} spending={kind !== 'in'} placeholder={kind === 'in' ? 'Ready to assign (or pick an income category)' : 'Choose a category'}
                suggest={[rule.rule?.category_id, suggestion?.category_id, ...frequent]} month={date.slice(0, 7)}
                noneLabel={kind === 'in' ? 'Ready to assign' : 'Uncategorized'} />
              {!editing?.split_id && !tip && <button class="memo-link" style="align-self:center" onClick={() => setSplits([{ category_id: category || null, amount: cents }, { category_id: null, amount: 0 }])}>Split</button>}
            </div>
            )}
            {siblings.length > 0 && <span class="head">Part of a {siblings.length + 1}-way split: {siblings.map(t => `${catById[t.category_id]?.name || '—'} ${fmt(t.amount)}`).join(' · ')}</span>}
          </>
        ) : loanPay ? (
          <>
            <p class="head" style="margin:0">{otherAcct.name} is off-budget, so this payment is an expense. Pick the category it comes from:</p>
            <div class="chips">
              {chips.map(c => <button class={'chip ' + (category === c.id ? 'on' : '')} onClick={() => { setCategory(c.id); setTouchedCat(true); }}>{catIcon(data, c) ? catIcon(data, c) + ' ' : ''}{c.name}</button>)}
              <button class="chip" onClick={() => setMore(m => !m)}>{more ? 'Less' : 'More…'}</button>
            </div>
            {more && <CatPicker data={data} value={category || null} spending noneLabel="None (from Ready to Assign)" suggest={chips.map(c => c.id)} month={date.slice(0, 7)}
              title="Pay this loan from" onPick={id => { setCategory(id || ''); setTouchedCat(true); setMore(false); }} onClose={() => setMore(false)} />}
            {!category && <span class="head neg">Choose a category, or the payment will come straight out of Ready to Assign.</span>}
          </>
        ) : (
          <p class="head" style="margin:0">Transfers never touch the budget. Paying a card moves money you already spent from a category when you swiped.</p>
        )}

        <div class="row acctdate">
          <div class="field" style="flex:1 1 130px">
            <span class="lbl">{kind === 'transfer' ? 'From' : 'Account'}</span>
            <Pick title={kind === 'transfer' ? 'From account' : 'Account'} value={account} onChange={setAccount} options={acctOptions(openAccts)} />
          </div>
          {kind === 'transfer' && (
            <div class="field" style="flex:1 1 130px">
              <span class="lbl">To</span>
              <Pick title="To account" value={other} onChange={setOther} options={acctOptions(openAccts.filter(a => a.id !== account))} />
            </div>
          )}
          <div class="field datef" style="flex:0 1 auto" aria-label="Date">
            <input type="date" aria-label="Date" value={date} onInput={e => setDate(e.target.value)} />
          </div>
        </div>
        {(kind !== 'transfer' || !showMemo) && (
          <div class="row addopts">
            {kind !== 'transfer' && <label class="check"><input type="checkbox" checked={cleared} onChange={e => setCleared(e.target.checked)} /> Cleared</label>}
            {!showMemo && <button class="memo-link" onClick={() => setShowMemo(true)}>+ memo</button>}
          </div>
        )}
        {editing && !otherLeg && <span class="head" style="text-align:center">Entered {stampLabel(editing)}{editing.created_by && multiAuthor ? ` by ${author(editing.created_by).name}` : ''}</span>}
        {showMemo && <div class="field"><span class="lbl">Memo</span><input value={memo} placeholder="optional" onInput={e => setMemo(e.target.value)} autoFocus={!editing} /></div>}

        {closedNew && <div class="head neg" style="text-align:center">🔒 {date.slice(0, 7)} is closed. Pick a later date or reopen the month under Settings › Budget rules.</div>}
        {selectedAcct && acctIsLiability(selectedAcct.type) && kind === 'out' && <div class="head" style="text-align:center">Comes out of the category now · paying {selectedAcct.name} later won't touch the budget</div>}
        </div>
        {locked ? <button class="ghost" onClick={onClose}>Close</button> : guard ? (
          <div class="card" style="background:var(--chip);border:1px solid var(--line)">
            <b>Is this a payment to {guard.card.name}?</b>
            <span class="head">{guard.card.on_budget
              ? <>Card payments are transfers, not spending — the money already left {catById[category]?.name || 'a category'} when you swiped. Saving this as "Spent" would count it twice.</>
              : <>Loan payments should also lower the {guard.card.name} balance. Saved as a payment, it still comes out of {catById[category]?.name || 'the category you pick'} — and the loan goes down too.</>}</span>
            <div class="row" style="flex-wrap:wrap">
              <button class="primary" onClick={async () => { setGuard(null); const toLoan = !guard.card.on_budget; await transfer({ from_account_id: account, to_account_id: guard.card.id, amount: cents, date, memo, category_id: toLoan ? category || null : null }); ui.toast(toLoan ? `Paid ${guard.card.name}${category ? ' from ' + catById[category].name : ''}` : `Paid ${guard.card.name}`); onClose(); }}>Yes, make it a payment</button>
              <button onClick={() => { const g = guard; setGuard(null); if (!g.card.on_budget && category) rememberNotPayment(category); save(g.another, true); }}>No, it's spending</button>
            </div>
          </div>
        ) : (
        <div class="pad">
          {['1', '2', '3'].map(k => <button onClick={() => press(k)}>{k}</button>)}
          <button class="fn" aria-label="Backspace" onClick={() => press('back')}>⌫</button>
          {['4', '5', '6'].map(k => <button onClick={() => press(k)}>{k}</button>)}
          <button class="fn" onClick={() => press('clear')}>C</button>
          {['7', '8', '9'].map(k => <button onClick={() => press(k)}>{k}</button>)}
          <button class="fn" onClick={() => setKind(k => k === 'out' ? 'in' : 'out')}>±</button>
          {editing ? <button class="fn neg" onClick={del}>Delete</button> : <button class="fn" style="font-size:13px" onClick={() => save(true)} disabled={!cents}>Save +1</button>}
          <button onClick={() => press('0')}>0</button>
          <button class="save" onClick={() => save(false)} disabled={closedNew || !cents || (kind === 'transfer' && (!other || other === account)) || (splits && splitRest !== 0)}>
            {editing ? 'Update' : kind === 'transfer' && acctIsLiability(openAccts.find(a => a.id === other)?.type) ? 'Pay' : 'Save'}
          </button>
        </div>)}
      </div>
    </div>
  ), document.body);
}
