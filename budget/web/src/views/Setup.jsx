import { useState } from 'preact/hooks';
import { Shell, useUI, nav } from '../main.jsx';
import { put, setPref, beginBatch, endBatch } from '../store.js';
import { fmt, parseMoney, today, addDays } from '../budget.js';
import { catIcon } from '../icons.jsx';
import { isNative } from '../platform.js';
import { Select } from './Pick.jsx';

/**
 * First-run setup (#/setup): accounts, paycheck, bills, everyday amounts. Each step writes real
 * rows as you go (each step is one Undo), and every step can be skipped. Offered on the Budget
 * screen while a budget has no accounts; "setup:done" (a synced setting) hides the offer.
 */
const TYPES = [['checking', 'Checking'], ['savings', 'Savings'], ['cash', 'Cash'], ['credit', 'Credit card'], ['loan', 'Loan']];
const FREQ = [['weekly', 'Every week'], ['biweekly', 'Every 2 weeks'], ['monthly', 'Every month']];
// In a browser (opened from your server) the last step connects a phone; the app is already one.
const STEPS = isNative ? ['Accounts', 'Paycheck', 'Bills', 'Everyday'] : ['Accounts', 'Paycheck', 'Bills', 'Everyday', 'Phone'];
const EVERYDAY = 3;
const isLiab = t => t === 'credit' || t === 'loan';
/** Next date with this day of the month (today or later). */
const nextDay = d => { const t = new Date(today() + 'T12:00:00'); const n = new Date(t.getFullYear(), t.getMonth(), Math.min(d, 28), 12); if (n < t) n.setMonth(n.getMonth() + 1); return n.toISOString().slice(0, 10); };

export const setupDone = data => data.prefs?.['setup:done'] === '1';
/** Show the setup offer: a fresh budget (no accounts) that hasn't finished or dismissed setup. */
export const wantsSetup = data => !setupDone(data) && !data.accounts.some(a => !a.deleted);

export function SetupCard({ data }) {
  if (!wantsSetup(data)) return null;
  return (
    <div class="card setupcard">
      <span class="eyebrow">Welcome</span>
      <b style="font-size:18px">Set up your budget in a few minutes</b>
      <span class="head">Add your accounts, your paycheck and your regular bills. Once Budget then shows what's ready to assign, what every category needs, and whether you'll make it to payday.</span>
      <div class="row"><a class="primary btnlink" href="#/setup">Start setup</a><button class="ghost" onClick={() => setPref('setup:done', '1')}>I'll do it myself</button></div>
    </div>
  );
}

export function Setup({ data }) {
  const ui = useUI();
  const [step, setStep] = useState(0);
  const cats = data.categories.filter(c => !c.deleted);
  const groupOf = Object.fromEntries(data.groups.map(g => [g.id, g]));
  const spendCats = cats.filter(c => !groupOf[c.group_id]?.is_income);
  const byName = re => spendCats.find(c => re.test(c.name));
  const accounts = data.accounts.filter(a => !a.deleted && !a.closed);
  const cashAccts = accounts.filter(a => !isLiab(a.type));

  // ---- step 1: accounts ----
  const [acct, setAcct] = useState({ name: '', type: 'checking', balance: '' });
  const addAccount = async e => {
    e.preventDefault();
    if (!acct.name.trim()) return;
    beginBatch(`Setup: added ${acct.name.trim()}`);
    try {
      const a = await put('accounts', { name: acct.name.trim(), type: acct.type, on_budget: acct.type === 'loan' ? 0 : 1, closed: 0, sort: accounts.length, reconciled_balance: 0 });
      let bal = parseMoney(acct.balance);
      if (isLiab(acct.type) && bal > 0) bal = -bal;
      if (bal) await put('transactions', { account_id: a.id, date: today(), payee: 'Starting balance', category_id: null, memo: '', amount: bal, cleared: 1 });
    } finally { endBatch(); }
    setAcct({ name: '', type: 'checking', balance: '' });
  };

  // ---- step 2: paycheck ----
  const incomeCat = cats.find(c => groupOf[c.group_id]?.is_income);
  const [pay, setPay] = useState({ payee: 'Paycheck', amount: '', frequency: 'biweekly', next: addDays(today(), 7), account: '' });
  const savePay = async () => {
    const cents = parseMoney(pay.amount);
    if (!cents) return setStep(2);
    await put('scheduled', { payee: pay.payee.trim() || 'Paycheck', amount: cents, frequency: pay.frequency, next_date: pay.next, account_id: pay.account || cashAccts[0]?.id, category_id: incomeCat?.id || null, memo: '', auto: 1, transfer_to: null });
    ui.toast(`Paycheck of ${fmt(cents)} scheduled`, { plain: true });
    setStep(2);
  };

  // ---- step 3: bills ----
  const BILLS = [['Rent / mortgage', /rent|mortgage/i, 1], ['Electric', /electric|hydro|power/i, 15], ['Water', /water/i, 20], ['Internet', /internet/i, 10], ['Phone', /phone/i, 18], ['Insurance', /insurance/i, 25]];
  const [bills, setBills] = useState(BILLS.map(([label, re, day]) => ({ label, cat: byName(re)?.id || '', amount: '', day: String(day) })));
  const saveBills = async () => {
    const list = bills.filter(b => parseMoney(b.amount) > 0);
    if (list.length) {
      beginBatch(`Setup: ${list.length} bill${list.length === 1 ? '' : 's'}`);
      try {
        for (const b of list) {
          const cents = parseMoney(b.amount);
          await put('scheduled', { payee: b.label, amount: -cents, frequency: 'monthly', next_date: nextDay(Number(b.day) || 1), account_id: cashAccts[0]?.id, category_id: b.cat || null, memo: '', auto: 0, transfer_to: null });
          const c = cats.find(x => x.id === b.cat);
          if (c && !c.target) await put('categories', { ...c, target: cents, goal_type: 'monthly' });
        }
      } finally { endBatch(); }
      ui.toast(`${list.length} bill${list.length === 1 ? '' : 's'} scheduled, with targets`, { plain: true });
    }
    setStep(3);
  };

  // ---- step 4: everyday targets ----
  // Day-to-day spending: not a bill from step 3, not debt or savings (those get targets another way), in budget order.
  const billCats = new Set(bills.map(b => b.cat).filter(Boolean));
  const skipGroup = g => /debt|loan|saving|goal/i.test(g?.name || '');
  const everyday = spendCats.filter(c => !billCats.has(c.id) && !c.target && !skipGroup(groupOf[c.group_id]))
    .sort((a, b) => (groupOf[a.group_id]?.sort ?? 0) - (groupOf[b.group_id]?.sort ?? 0) || (a.sort ?? 0) - (b.sort ?? 0)).slice(0, 12);
  const [amounts, setAmounts] = useState({});
  const finish = async () => {
    const list = everyday.filter(c => parseMoney(amounts[c.id] || '') > 0);
    beginBatch('Setup: everyday targets');
    try {
      for (const c of list) await put('categories', { ...c, target: parseMoney(amounts[c.id]), goal_type: 'monthly' });
      await setPref('setup:done', '1');
    } finally { endBatch(); }
    if (STEPS.length > EVERYDAY + 1) { ui.toast('Budget set up 🎉', { plain: true, win: true }); setStep(EVERYDAY + 1); return; }
    ui.toast('All set 🎉 Now give every dollar a job', { plain: true, win: true });
    nav('#/budget');
  };

  const top = (
    <div class="row between">
      <a href="#/budget" class="round" style="display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:22px;background:rgba(255,255,255,.12);color:#fff;text-decoration:none;font-size:22px" aria-label="Back">‹</a>
      <div class="col" style="flex:1;margin-left:12px"><span class="eyebrow">Setup · step {step + 1} of {STEPS.length}</span><span class="title">{STEPS[step]}</span></div>
    </div>
  );
  const Steps = () => <div class="setupsteps">{STEPS.map((s, i) => <button type="button" class={i === step ? 'on' : i < step ? 'done' : ''} onClick={() => setStep(i)}>{i < step ? '✓' : i + 1}<span>{s}</span></button>)}</div>;
  const Nav = ({ next, skip = true, label = 'Next' }) => (
    <div class="row" style="justify-content:flex-end;gap:8px">
      {step > 0 && <button type="button" class="ghost" onClick={() => setStep(step - 1)}>Back</button>}
      {skip && <button type="button" class="ghost" onClick={() => (step === EVERYDAY ? finish() : setStep(step + 1))}>Skip</button>}
      <button type="button" class="primary" onClick={next}>{label}</button>
    </div>
  );

  return (
    <Shell route="setup" top={top}>
      <Steps />
      {step === 0 && (
        <div class="card form">
          <span class="head">Add the accounts your money lives in: checking, savings, cash, and any credit cards and loans. Use today's balance from your bank; for cards and loans, what you owe.</span>
          {accounts.length > 0 && <div class="col" style="gap:4px">{accounts.map(a => <div class="row between"><span>{a.name} <span class="head">{TYPES.find(t => t[0] === a.type)?.[1]}</span></span><span class="money">✓</span></div>)}</div>}
          <form class="col" style="gap:8px" onSubmit={addAccount}>
            <label>Name<input value={acct.name} placeholder="e.g. Everyday checking" onInput={e => setAcct({ ...acct, name: e.target.value })} /></label>
            <div class="grid2">
              <label>Type<Select value={acct.type} onChange={e => setAcct({ ...acct, type: e.target.value })}>{TYPES.map(([k, l]) => <option value={k}>{l}</option>)}</Select></label>
              <label>{isLiab(acct.type) ? 'You owe' : 'Balance today'}<input class="num" inputMode="decimal" placeholder="0.00" value={acct.balance} onInput={e => setAcct({ ...acct, balance: e.target.value })} /></label>
            </div>
            <button class="primary" disabled={!acct.name.trim()}>{accounts.length ? 'Add another account' : 'Add account'}</button>
          </form>
          <Nav next={() => setStep(1)} skip={false} label={accounts.length ? 'Next' : 'Skip for now'} />
        </div>
      )}
      {step === 1 && (
        <div class="card form">
          <span class="head">Your paycheck is what Once Budget plans around: the payday forecast, and when bills are due compared with when money arrives. It's added as a scheduled item that posts itself on payday.</span>
          <div class="grid2">
            <label>Name<input value={pay.payee} onInput={e => setPay({ ...pay, payee: e.target.value })} /></label>
            <label>Amount (after tax)<input class="num" inputMode="decimal" placeholder="0.00" value={pay.amount} onInput={e => setPay({ ...pay, amount: e.target.value })} /></label>
            <label>How often<Select value={pay.frequency} onChange={e => setPay({ ...pay, frequency: e.target.value })}>{FREQ.map(([k, l]) => <option value={k}>{l}</option>)}</Select></label>
            <label>Next payday<input type="date" value={pay.next} onInput={e => setPay({ ...pay, next: e.target.value })} /></label>
          </div>
          {cashAccts.length > 1 && <label>Paid into<Select value={pay.account || cashAccts[0].id} onChange={e => setPay({ ...pay, account: e.target.value })}>{cashAccts.map(a => <option value={a.id}>{a.name}</option>)}</Select></label>}
          {!cashAccts.length && <span class="head neg">Add a checking or savings account first (step 1) so the paycheck has somewhere to go.</span>}
          <Nav next={savePay} label={parseMoney(pay.amount) ? 'Save & next' : 'Next'} />
        </div>
      )}
      {step === 2 && (
        <div class="card form">
          <span class="head">Fill in the bills you pay every month; leave the rest blank. Each becomes a scheduled bill on its day, and its category gets that amount as a monthly target.</span>
          {bills.map((b, i) => {
            const c = cats.find(x => x.id === b.cat);
            return (
              <div class="setupbill">
                <span class="n">{c && catIcon(data, c) ? catIcon(data, c) + ' ' : ''}{b.label}</span>
                <input class="num" inputMode="decimal" placeholder="Amount" value={b.amount} onInput={e => setBills(bills.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} aria-label={`${b.label} amount`} />
                <label class="head day">day<input inputMode="numeric" value={b.day} onInput={e => setBills(bills.map((x, j) => (j === i ? { ...x, day: e.target.value.replace(/\D/g, '').slice(0, 2) } : x)))} aria-label={`${b.label} due day`} /></label>
              </div>
            );
          })}
          <Nav next={saveBills} label={bills.some(b => parseMoney(b.amount) > 0) ? 'Save & next' : 'Next'} />
        </div>
      )}
      {step === 3 && (
        <div class="card form">
          <span class="head">Roughly how much do you spend on these in a month? Each becomes the category's monthly target, so the Needs list and Fill to targets know what to aim for. Leave any blank.</span>
          {everyday.map(c => (
            <div class="setupbill">
              <span class="n">{catIcon(data, c) ? catIcon(data, c) + ' ' : ''}{c.name}</span>
              <input class="num" inputMode="decimal" placeholder="per month" value={amounts[c.id] || ''} onInput={e => setAmounts({ ...amounts, [c.id]: e.target.value })} aria-label={`${c.name} per month`} />
            </div>
          ))}
          {!everyday.length && <span class="head">Every category already has a target.</span>}
          <Nav next={finish} label={STEPS.length > EVERYDAY + 1 ? 'Save & next' : 'Finish'} />
        </div>
      )}
      {step === 4 && (
        <div class="card form">
          <b style="font-size:17px">Connect your phone</b>
          <span class="head">Your budget lives on this server now. On Android, the Once Budget app keeps a copy on your phone that works offline and syncs here, and it can log tap-to-pay purchases for you.</span>
          <ol class="setupphone">
            <li>Install <b>Once Budget</b> on your Android phone.</li>
            <li>Tap <b>Show the pairing code</b> below. A QR code appears on this screen.</li>
            <li>Scan it with your phone's camera and tap the link. The app opens, connected to this budget.</li>
          </ol>
          <span class="head">On an iPhone, or any other computer: open this server's address in the browser and sign in with your server password.</span>
          <div class="row" style="justify-content:flex-end;gap:8px;flex-wrap:wrap">
            <button type="button" class="ghost" onClick={() => setStep(EVERYDAY)}>Back</button>
            <button type="button" class="ghost" onClick={() => nav('#/budget')}>Not now</button>
            <a class="primary btnlink" href="/pair">Show the pairing code</a>
          </div>
          <span class="head">You can pair a phone any time from Settings › Sync &amp; server.</span>
        </div>
      )}
      <span class="head" style="text-align:center">You can change all of this later: accounts under Accounts, the paycheck and bills under Scheduled, targets on each category.</span>
    </Shell>
  );
}
