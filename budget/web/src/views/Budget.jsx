import { createPortal } from 'preact/compat';
import { PaydayCheck } from './Forecast.jsx';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Shell, useUI, useModal, nav } from '../main.jsx';
import { monthView, ym, addMonths, monthLabel, fmt, parseMoney, HOLD, dayLabel, goalNeed, goalProgress, monthsUntil, balances, coverageAll, newestFirst } from '../budget.js';
import { assign, put, remove, restore, beginBatch, endBatch, haptic } from '../store.js';
import { SearchResults } from './Search.jsx';
import { CoverSheet } from './Cover.jsx';
import { Review } from './Review.jsx';
import { ask, tell } from '../dialog.js';
import { Roll } from './Roll.jsx';
import { Empty } from './Empty.jsx';
import { SetupCard } from './Setup.jsx';
import { Editor } from './Scheduled.jsx';
import { Glance } from './Fun.jsx';
import { Icon, IconField, NameField } from './IconField.jsx';
import { catIcon } from '../icons.jsx';
import { Dashboard, useWidth, WIDE_MIN } from './Dashboard.jsx';
import { overPlan, planCheck } from '../features.js';
import { isClosedMonth, ageOfMoney, moneyCheck, pace, fillToTargets, assignLikeLastMonth, rolloverCheck, dueScheduled, postScheduled, skipScheduled, autoPostDue, perBudget, autoRoll, coverFrom, spendSplit, cardPartOfOverspend, clearStaleBorrow, borrowItems, undoBorrow } from '../features.js';
import { Help } from './Info.jsx';
import { staleTips, TIP_REMIND_DAYS } from '../tips.js';
import { TipClear } from './TipClear.jsx';
import { Select } from './Pick.jsx';

// Which categories and in what order: 'remaining' (lowest left first, default), 'spent' (most first)
// or 'groups' (everything, by group). The first two flatten groups into one list and hide unused ones.
const SORT_KEY = 'budget.catSort';
const loadSort = () => { try { const s = localStorage.getItem(SORT_KEY); return s === 'spent' || s === 'groups' || s === 'needs' ? s : 'remaining'; } catch { return 'remaining'; } };
const spentOf = r => -Math.min(0, r.activity);

export function Budget({ data }) {
  const view = 'list';   // categories are always a list (the Tiles view was removed in 1.49)
  const [sortPref, setSortState] = useState(loadSort());
  const [needEdit, setNeedEdit] = useState(null);
  const [renamingGroup, setRenamingGroup] = useState(null);
  // Income card: one line until opened (remembered on this device).
  const [incomeOpen, setIncomeOpen] = useState(() => { try { return localStorage.getItem('budget.incomeOpen') === '1'; } catch { return false; } });
  const setIncomeOpenS = o => { setIncomeOpen(o); try { localStorage.setItem('budget.incomeOpen', o ? '1' : '0'); } catch {} };   // Needs list: { id, amount, type, date } being edited
  const setSort = k => { setSortState(k); try { localStorage.setItem(SORT_KEY, k); } catch {} };
  const ui = useUI();
  const [month, setMonth] = useState(ym());
  const [openCat, setOpenCat] = useState(null);
  const [holdOpen, setHoldOpen] = useState(false);
  const [adding, setAdding] = useState(null);
  const [checkOpen, setCheckOpen] = useState(false);
  const [uncatOpen, setUncatOpen] = useState(false);
  const [tipsOpen, setTipsOpen] = useState(false);
  const [tipAsk, setTipAsk] = useState(null);
  const [overOpen, setOverOpen] = useState(false);
  const [dupOpen, setDupOpen] = useState(false);
  const catName = Object.fromEntries(data.categories.map(c => [c.id, c.name]));
  const acctName = Object.fromEntries(data.accounts.map(a => [a.id, a.name]));
  const [roll, setRoll] = useState(null);
  const [covering, setCovering] = useState(null);   // { month, ids, done? }: the Cover sheet
  const [q, setQ] = useState('');
  ui.search = term => { setQ(term); setOpenCat(null); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const [review, setReview] = useState(null);
  // Wide screens show the Budget tab as a dashboard. With a Category detail widget, tapping a
  // category fills that widget instead of opening the category inline.
  const wide = useWidth() >= WIDE_MIN;
  const [hasDetail, setHasDetail] = useState(false);
  const side = wide && hasDetail;
  useEffect(() => {
    const seen = (() => { try { return localStorage.getItem(perBudget('budget.reviewedMonth')); } catch { return null; } })();
    const prev = addMonths(ym(), -1);
    const hasPrev = data.txs.some(t => t.date.slice(0, 7) === prev);
    (async () => {
      // Month-end roll of card overspending first, so the "ended overspent" prompt only lists what stays
      // (cash/debit overspending, which never rolls).
      const r = await autoRoll(data).catch(() => ({ after: data }));
      if (r.notice) tell(r.notice, { title: 'Card overspending' });
      else if (r.rolled) ui.toast(`Rolled ${fmt(r.rolled)} of card overspending into ${data.categories.find(c => c.id === data.prefs?.payoff_category_id)?.name || 'your payoff category'}`, { plain: true });
      if (hasPrev && seen !== prev) { setReview(prev); try { localStorage.setItem(perBudget('budget.reviewedMonth'), prev); } catch {} }
      else setRoll(rolloverCheck(r.after));
    })();
    autoPostDue(data).then(n => n && ui.toast(`${n} scheduled transaction${n === 1 ? '' : 's'} posted`));
  }, []);

  const v = monthView(data, month);
  const anyUsed = v.groups.some(g => g.rows.some(r => r.assigned || r.activity || r.available));
  const sort = anyUsed || sortPref === 'needs' ? sortPref : 'groups';
  const mc = moneyCheck(data, month);
  const next = addMonths(month, 1);
  const nextName = monthLabel(next).split(' ')[0];
  const prevName = monthLabel(addMonths(month, -1)).split(' ')[0];
  const isCurrent = month === ym();
  const closed = isClosedMonth(data, month);
  const due = isCurrent ? dueScheduled(data) : [];
  const fills = fillToTargets(data, month);
  const fillTotal = fills.reduce((s, f) => s + f.add, 0);
  const needN = fills.filter(f => f.id !== data.prefs?.payoff_category_id).length;   // Needs leaves out the card payoff category
  const copyLast = assignLikeLastMonth(data, month);

  const top = (
    <>
      <div class="row between">
        <button class="round" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}>‹</button>
        <div class="title">{monthLabel(month)}</div>
        <button class="round" aria-label="Next month" onClick={() => setMonth(next)}>›</button>
      </div>
      <div class="row between" style="align-items:flex-end">
        <div class="col">
          <span class="eyebrow">Ready to assign <Help k="rta" /></span>
          <button type="button" class="rtabtn" onClick={() => setHoldOpen(true)} aria-label="Ready to assign: money in your budget, and hold for next month">
            <Roll class={'rta money ' + (v.ready_to_assign < 0 ? 'bad' : 'ok')} value={v.ready_to_assign} ms={900} /><span class="rtainfo" aria-hidden="true">›</span>
          </button>
          {v.held_from_prev > 0 && <span class="head" style="color:var(--head-muted)">includes {fmt(v.held_from_prev)} held from {prevName}</span>}
          {v.held_for_next > 0 && <span class="head" style="color:var(--head-muted)">holding {fmt(v.held_for_next)} for {nextName}</span>}
          {v.borrowed_by_prev > 0 && <span class="head" style="color:var(--head-muted)">after {fmt(v.borrowed_by_prev)} that covered {prevName}'s overspending</span>}
          {v.borrowed_from_next > 0 && <span class="head" style="color:var(--head-muted)">{fmt(v.borrowed_from_next)} of {nextName}'s money covered overspending</span>}
          <AomLine data={data} ui={ui} />
        </div>
        {month < ym() ? <button class="white" onClick={() => setReview(month)}>Review</button> : <button class="white" onClick={() => setHoldOpen('hold')}>Hold for {nextName}</button>}
      </div>
    </>
  );

  const budgetBody = () => (
    <>
      <div class="search"><input type="search" placeholder="Search transactions…" value={q} onInput={e => setQ(e.target.value)} /><a href="#/grid" class="chip" style="text-decoration:none;color:inherit;display:inline-flex;align-items:center">Table</a></div>
      <div class="viewbar">
        <div class="seg sortseg" role="group" aria-label="Show categories">
          {[['remaining', 'Remaining'], ['spent', 'Spent'], ['needs', 'Needs'], ['groups', 'Groups']].map(([k, l]) => (
            <button class={sortPref === k ? 'on' : ''} aria-pressed={sortPref === k} onClick={() => setSort(k)}>
              {l}{k === 'needs' && needN > 0 && <span class="needcount" aria-label={`${needN} below target`}>{needN}</span>}
            </button>
          ))}
        </div>
      </div>
      {q.trim() ? <BudgetSearch view={view} data={data} q={q} v={v} month={month} rta={v.ready_to_assign} openCat={openCat} setOpenCat={setOpenCat} ui={ui} /> : <>
      {roll && (
        <div class="card" style="background:var(--neg-bg)">
          <b class="neg">{monthLabel(roll.month)} ended {fmt(-roll.total)} overspent in {roll.over.length} categor{roll.over.length === 1 ? 'y' : 'ies'}.</b>
          <span class="head">{roll.over.map(r => `${r.name} ${fmt(r.available)}`).join(' · ')}</span>
          <span class="head">Left alone, those categories stay in the red until you cover them. Taking it from {monthLabel(addMonths(roll.month, 1)).split(' ')[0]}'s money starts them at $0 and lowers this month's Ready to assign instead.</span>
          <div class="row" style="flex-wrap:wrap">
            <button class="primary" onClick={async () => { const amt = -roll.total, nm = monthLabel(addMonths(roll.month, 1)).split(' ')[0]; await coverFrom(data, roll.month, roll.over.map(r => r.id), 'next', amt, `Covered ${monthLabel(roll.month)} overspending from ${nm}'s money`); setRoll(null); ui.toast(`Covered from ${nm}'s money`); }}>Take from {monthLabel(addMonths(roll.month, 1)).split(' ')[0]}'s money</button>
            <button onClick={() => setCovering({ month: roll.month, ids: roll.over.map(r => r.id), done: () => setRoll(null) })}>Other ways…</button>
            <button class="ghost" onClick={() => setRoll(null)}>Later</button>
          </div>
        </div>
      )}

      <Borrows data={data} month={month} ui={ui} />
      {closed && <div class="lock"><span style="font-size:18px">🔒</span><div class="col" style="flex:1"><b>{monthLabel(month)} is closed</b><span>Assignments are locked. Reopen under Settings › Budget rules if you need to change it.</span></div></div>}

      {/* 5. Money check */}
      <div class="card mcheck">
        <div class="row between" onClick={() => setCheckOpen(o => !o)} style="cursor:pointer">
          <span class="eyebrow">Money check <Help k="moneycheck" /></span>
          <span class={'pill ' + (mc.unaccounted === 0 && !mc.overspent.length && !mc.uncategorized.length && !mc.cardDebt.length && !mc.dups.length && !mc.payoffDebt && !mc.staleBorrow ? '' : 'amber')}>
            {mc.unaccounted === 0 && !mc.overspent.length && !mc.uncategorized.length && !mc.cardDebt.length && !mc.dups.length && !mc.payoffDebt && !mc.staleBorrow ? '✓ All accounted for' : `${mc.overspent.length + mc.uncategorized.length + mc.cardDebt.length + mc.dups.length + (mc.payoffDebt ? 1 : 0) + (mc.staleBorrow ? 1 : 0)} to fix`}
          </span>
        </div>
        {checkOpen && (
          <div>
            <div class="ln"><span>Cash in budget accounts</span><b class="money">{fmt(mc.cash)}</b></div>
            <div class="ln"><span>− In categories</span><span class="money">{fmt(mc.inCats)}</span></div>
            <div class="ln"><span>− Held for future months</span><span class="money">{fmt(mc.held)}</span></div>
            <div class="ln"><span>− Ready to assign</span><span class="money">{fmt(mc.rta)}</span></div>
            <div class="ln tot"><span>= Unaccounted</span><span class={'money ' + (mc.unaccounted === 0 ? 'pos' : 'neg')}>{fmt(mc.unaccounted)} {mc.unaccounted === 0 ? '✓' : ''}</span></div>
          </div>
        )}
        {mc.overspent.length > 0 && (
          <>
            <div class="warn" onClick={() => setOverOpen(o => !o)}>
              <span>{mc.overspent.length} overspent · {fmt(mc.overspent.reduce((s, r) => s + r.available, 0))}</span><span>{overOpen ? 'Hide' : 'Fix ›'}</span>
            </div>
            {overOpen && (
              <div>
                {mc.overspent.map(r => (
                  <div class="due" key={r.id}>
                    <div class="main" onClick={() => { setOpenCat(r.id); setTimeout(() => document.getElementById('cat-' + r.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50); }} style="cursor:pointer">
                      <div class="p">{r.name}</div>
                      <div class="s">{r.group_name} · {fmt(r.assigned)} assigned, {fmt(-Math.min(0, r.activity))} spent</div>
                    </div>
                    <span class="money neg" style="font-weight:600">{fmt(r.available)}</span>
                    <button class="primary" style="min-height:34px;padding:5px 10px" disabled={closed} onClick={() => setCovering({ month, ids: [r.id] })}>Cover</button>
                  </div>
                ))}
                {mc.overspent.length > 1 && !closed && (
                  <button class="primary" style="margin-top:6px" onClick={() => setCovering({ month, ids: mc.overspent.map(r => r.id) })}>Cover all · {fmt(-mc.overspent.reduce((s, r) => s + r.available, 0))}</button>
                )}
              </div>
            )}
          </>
        )}
        {staleTips(data).length > 0 && (() => {
          const st = staleTips(data);
          return (
            <>
              <div class="warn info" onClick={() => setTipsOpen(o => !o)}>
                <span>💵 {st.length} tip{st.length === 1 ? '' : 's'} not posted yet · {fmt(st.reduce((s, t) => s + t.tip_pending, 0))}</span><span>{tipsOpen ? 'Hide' : 'Show ›'}</span>
              </div>
              {tipsOpen && (
                <div>
                  <span class="head">Your bank still shows these without the tip after {TIP_REMIND_DAYS}+ days. Tap one when you've checked your bank.</span>
                  {st.map(t => (
                    <div class="txrow" key={t.id}>
                      <div class="main" onClick={() => setTipAsk(t)}>
                        <div class="p">{t.payee || '(no payee)'}</div>
                        <div class="s">{dayLabel(t.date)} · {acctName[t.account_id]} · bank shows {fmt(Math.abs(t.amount + t.tip_pending))}</div>
                      </div>
                      <span class="money" style="font-weight:600" onClick={() => setTipAsk(t)}>{fmt(t.amount)}</span>
                    </div>
                  ))}
                </div>
              )}
              {tipAsk && <TipClear tx={tipAsk} onClose={() => setTipAsk(null)} />}
            </>
          );
        })()}
        {mc.uncategorized.length > 0 && (
          <>
            <div class="warn amber" onClick={() => setUncatOpen(o => !o)}>
              <span>{mc.uncategorized.length} uncategorized · {fmt(mc.uncategorized.reduce((s, t) => s + t.amount, 0))}</span><span>{uncatOpen ? 'Hide' : 'Show ›'}</span>
            </div>
            {uncatOpen && (
              <div>
                {mc.uncategorized.slice(0, 30).map(t => (
                  <div class="txrow" key={t.id}>
                    <div class="main" onClick={() => ui.open({ tx: t })}>
                      <div class="p">{t.payee || '(no payee)'}</div>
                      <div class="s">{dayLabel(t.date)} · {acctName[t.account_id]}{t.memo ? ` · ${t.memo}` : ''}</div>
                    </div>
                    <span class="money" style="font-weight:600" onClick={() => ui.open({ tx: t })}>{fmt(t.amount)}</span>
                  </div>
                ))}
                {mc.uncategorized.length > 30 && <span class="head">…and {mc.uncategorized.length - 30} more. Use an account's Select mode to categorize in bulk.</span>}
              </div>
            )}
          </>
        )}
        {mc.dups.length > 0 && (
          <>
            <div class="warn amber" onClick={() => setDupOpen(o => !o)}><span>{mc.dups.length} possible duplicate{mc.dups.length === 1 ? '' : 's'}</span><span>{dupOpen ? 'Hide' : 'Show ›'}</span></div>
            {dupOpen && mc.dups.map(([a, b]) => (
              <div key={a.id + b.id} style="border:1px solid var(--line);border-radius:10px;padding:4px 8px">
                {[a, b].map(t => (
                  <div class="txrow" key={t.id} style="padding:6px 0">
                    <div class="main" onClick={() => ui.open({ tx: t })}>
                      <div class="p">{t.transfer_id ? (t.category_id ? `Loan payment · ${catName[t.category_id]}` : 'Transfer') : t.payee || '(no payee)'}</div>
                      <div class="s">{dayLabel(t.date)} · {acctName[t.account_id]}{!t.transfer_id ? ` · ${t.category_id ? catName[t.category_id] : 'uncategorized'}` : ''}</div>
                    </div>
                    <span class="money" style="font-weight:600">{fmt(t.amount)}</span>
                    <button class="ghost" style="min-height:32px;padding:4px 8px" onClick={async () => { const legs = t.transfer_id ? data.txs.filter(x => x.transfer_id === t.transfer_id) : [t]; for (const x of legs) await remove('transactions', x.id); ui.toast('Deleted', { undo: async () => { for (const x of legs) await restore('transactions', x.id); } }); }}>✕</button>
                  </div>
                ))}
                <span class="head">Same account, same amount, same day or next. Keep one; if it's a loan payment, keep the Transfer and give it the category.</span>
              </div>
            ))}
          </>
        )}
        {mc.payoffDebt && (
          <div class="warn amber">
            <span>Card debt to fund: <b class="money">{fmt(mc.payoffDebt.amount)}</b> in {mc.payoffDebt.cat.name}</span>
            {v.ready_to_assign > 0 && <button class="link" onClick={async () => {
              const add = Math.min(v.ready_to_assign, mc.payoffDebt.amount);
              await assign(mc.payoffDebt.cat.id, month, mc.payoffDebt.cat.assigned + add);
              ui.toast(`Funded ${fmt(add)} toward ${mc.payoffDebt.cat.name}`);
            }}>Fund {fmt(Math.min(v.ready_to_assign, mc.payoffDebt.amount))}</button>}
          </div>
        )}
        {mc.cardDebt.map(({ a, uncovered }) => (
          <a class="warn amber" key={a.id} href={'#/accounts/' + a.id} style="text-decoration:none">
            <span>{a.name}: {fmt(-uncovered)} starting debt not budgeted</span><span>View ›</span>
          </a>
        ))}
        {mc.staleBorrow && (
          <div class="warn amber">
            <span>{fmt(mc.staleBorrow.extra)} taken from {monthLabel(mc.staleBorrow.month).split(' ')[0]}'s money no longer covers anything (not counted)</span>
            <button class="ghost" style="min-height:32px;padding:4px 10px" onClick={async () => { await clearStaleBorrow(mc.staleBorrow, data); ui.toast('Cleared'); }}>Clear</button>
          </div>
        )}
      </div>

      <PlanCheck data={data} month={month} ui={ui} closed={closed} onOpen={id => {
        if (sort === 'needs') setSort('remaining');
        setOpenCat(id);
        setTimeout(() => document.getElementById('cat-' + id)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 150);
      }} />

      {/* 1. Due scheduled */}
      {due.length > 0 && (
        <div class="card duecard">
          <div class="row between"><span class="eyebrow">Due</span><a href="#/scheduled" class="link" style="font-size:13px;font-weight:600;color:var(--pos);text-decoration:none">Manage</a></div>
          <div>{due.map(s => <DueRow key={s.id} s={s} data={data} />)}</div>
        </div>
      )}

      <Glance data={data} />

      {/* 2. Assign helpers */}
      {(fills.length > 0 || copyLast.length > 0) && v.ready_to_assign > 0 && (
        <div class="row" style="flex-wrap:wrap">
          {fills.length > 0 && <button class="chip" onClick={async () => {
            const total = fills.reduce((t, f) => t + f.add, 0);
            const list = fills.slice(0, 5).map(f => `• ${f.name}: +${fmt(f.add)}`).join('\n') + (fills.length > 5 ? `\n• …and ${fills.length - 5} more` : '');
            const short = total > v.ready_to_assign ? `\n\nThat's ${fmt(total - v.ready_to_assign)} more than you have in Ready to Assign (${fmt(v.ready_to_assign)}).` : '';
            if (!(await ask(`Assign ${fmt(total)} to ${fills.length} categor${fills.length === 1 ? 'y' : 'ies'} to reach their targets?\n\n${list}${short}`, { title: 'Fill to targets', ok: 'Fill' }))) return;
            beginBatch('Fill to targets'); try { for (const f of fills) await assign(f.id, month, f.assigned); } finally { endBatch(); } ui.toast(`Filled ${fills.length} categories to target`); }}>Fill to targets · {fmt(fillTotal)}</button>}
          {copyLast.length > 0 && <button class="chip" onClick={async () => { beginBatch('Assign like last month'); try { for (const c of copyLast) await assign(c.id, month, c.assigned); } finally { endBatch(); } ui.toast(`Assigned like ${prevName}`); }}>Assign like {prevName}</button>}
        </div>
      )}

      {(data.groups.some(g => g.is_income) || v.income_total > 0) && (
        <div class="card income">
          <button type="button" class="row between incomehead" aria-expanded={incomeOpen} onClick={() => setIncomeOpenS(!incomeOpen)}>
            <span class="eyebrow">Income · {monthLabel(month).split(' ')[0]} <span class="chev">{incomeOpen ? '▾' : '▸'}</span></span><b class="money pos">{fmt(v.income_total)}</b>
          </button>
          {incomeOpen && <>
          <div>
            {v.income.map(c => (
              <div class="ln" key={c.id}>
                <span>{c.name}{c.note ? <span class="note" style="margin-left:6px">{c.note}</span> : null}</span>
                <span class={'money ' + (c.activity > 0 ? 'pos' : 'muted')}>{fmt(c.activity)}</span>
              </div>
            ))}
            {v.income_uncategorized > 0 && <div class="ln"><span class="muted">No income category</span><span class="money">{fmt(v.income_uncategorized)}</span></div>}
          </div>
          <span class="head">All income goes to Ready to Assign; these categories just track where it came from.</span>
          {data.groups.filter(g => g.is_income).map(g => (
            <div class="row" key={g.id}>
              <button class="link" onClick={() => setAdding(adding === g.id ? null : g.id)}>+ Add {g.name.toLowerCase()} category</button>
              {adding === g.id && (
                <form class="row" style="flex:1" onSubmit={async e => { e.preventDefault(); const name = e.target.name.value.trim(); if (name) await put('categories', { group_id: g.id, name, sort: v.income.length, target: 0, note: '' }); setAdding(null); }}>
                  <input name="name" placeholder="e.g. Paycheck, Cash deposit" autoFocus /><button class="primary">Add</button>
                </form>
              )}
            </div>
          ))}
          </>}
        </div>
      )}

      {/* Needs: only categories below their target, biggest shortfall first, each with a one-tap fund button. */}
      {sort === 'needs' && (() => {
        const byId = Object.fromEntries(v.groups.flatMap(g => g.rows.map(r => [r.id, { ...r, group_name: g.name }])));
        // The card payoff category is money you spend down, not a target to fill: not listed here.
        const list = [...fills].filter(f => f.id !== data.prefs?.payoff_category_id).sort((a, b) => b.add - a.add);
        const total = list.reduce((s, f) => s + f.add, 0);
        const free = Math.max(0, v.ready_to_assign);
        const editing = needEdit && list.some(f => f.id === needEdit.id) ? needEdit : null;
        const saveTarget = async (f, remove) => {
          const cat = data.categories.find(x => x.id === f.id);
          const amount = remove ? 0 : parseMoney(editing.amount);
          if (!remove && amount <= 0) { ui.toast('Enter a target amount, or tap Remove target'); return; }
          if (!remove && editing.type === 'by_date' && !editing.date) { ui.toast('Pick the date to save it by'); return; }
          await put('categories', { ...cat, target: amount, goal_type: remove ? 'monthly' : editing.type, goal_date: !remove && editing.type === 'by_date' ? editing.date : null });
          setNeedEdit(null);
          ui.toast(remove ? `Removed ${f.name}'s target` : `${f.name}: target ${fmt(amount)}${editing.type === 'by_date' ? ' by ' + new Date(editing.date + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : ' a month'}`);
        };
        const fund = async (f, give) => {
          const c = byId[f.id];
          await assign(f.id, month, (c?.assigned || 0) + give);
          haptic('success');
          ui.toast(give < f.add ? `${f.name} +${fmt(give)} (${fmt(f.add - give)} still needed)` : `${f.name} funded to target`);
        };
        return (
          <div class="card needs">
            <div class="row between">
              <span class="eyebrow">Below target <Help k="needs" /></span>
              <span class="eyebrow money">{fmt(total)} needed</span>
            </div>
            {!list.length && <span class="head">Every category with a target is funded ✓ Give a category a target (open it › Goal) to track it here.</span>}
            {list.map(f => {
              const c = byId[f.id] || {};
              const give = Math.min(f.add, free);
              const pct = c.target > 0 ? Math.round(goalProgress(c, month) * 100) : 0;
              return (
                <div class={'needitem' + (editing?.id === f.id ? ' open' : '')} key={f.id}>
                <div class="needrow">
                  <div class="col" role="button" tabIndex={0} style="flex:1;min-width:0;gap:3px;cursor:pointer" title="Change or remove the target"
                    onClick={() => setNeedEdit(editing?.id === f.id ? null : { id: f.id, amount: c.target > 0 ? (c.target / 100).toFixed(2) : '', type: c.goal_type === 'by_date' ? 'by_date' : 'monthly', date: c.goal_date || '' })}>
                    <span class="n"><Icon data={data} c={c} />{f.name}<span class="grp">{c.group_name}</span></span>
                    <span class="head">{c.target > 0 && c.goal_type !== 'by_date' ? <><span class="money">{fmt(Math.max(0, c.assigned || 0))}</span> assigned of <span class="money">{fmt(c.target)}</span></> : <><span class="money">{fmt(c.available ?? 0)}</span>{c.target > 0 ? <> of <span class="money">{fmt(c.target)}</span> goal</> : ' · card debt to fund'}</>} · needs <b class="money">{fmt(f.add)}</b></span>
                    <div class="thin"><i style={`width:${pct}%`} /></div>
                  </div>
                  <button class="primary needfund" disabled={closed || give <= 0} onClick={() => fund(f, give)} aria-label={`Add ${fmt(give)} to ${f.name}`}>+<span class="money">{fmt(give)}</span></button>
                </div>
                {editing?.id === f.id && (
                  <form class="neededit" onSubmit={e => { e.preventDefault(); saveTarget(f, false); }}>
                    {c.target > 0 ? <>
                      <div class="seg">
                        <button type="button" class={editing.type === 'monthly' ? 'on' : ''} onClick={() => setNeedEdit({ ...editing, type: 'monthly' })}>Each month</button>
                        <button type="button" class={editing.type === 'by_date' ? 'on' : ''} onClick={() => setNeedEdit({ ...editing, type: 'by_date' })}>By a date</button>
                      </div>
                      <div class="row" style="gap:8px">
                        <label class="head" style="flex:1">{editing.type === 'by_date' ? 'Save up' : 'Target each month'}<input inputMode="decimal" value={editing.amount} onInput={e => setNeedEdit({ ...editing, amount: e.target.value })} autoFocus /></label>
                        {editing.type === 'by_date' && <label class="head" style="flex:1">By<input type="date" value={editing.date} onInput={e => setNeedEdit({ ...editing, date: e.target.value })} /></label>}
                      </div>
                      <div class="row" style="flex-wrap:wrap">
                        <button class="primary">Save</button>
                        <button type="button" class="ghost neg" onClick={() => saveTarget(f, true)}>Remove target</button>
                        <button type="button" class="ghost" onClick={() => setNeedEdit(null)}>Cancel</button>
                      </div>
                    </> : <span class="head">This is card debt waiting to be funded, not a target. Fund it with the + button, or see Settings › Budget rules.</span>}
                  </form>
                )}
                </div>
              );
            })}
            {list.length > 0 && free < total && <span class="head">{free > 0 ? `Ready to Assign has ${fmt(free)}: buttons fund what they can.` : 'Ready to Assign is empty, so there\'s nothing to fund these with yet.'}</span>}
          </div>
        );
      })()}

      {/* A month with nothing assigned or spent yet shows every group (the saved choice is kept). */}
      {sort !== 'groups' && sort !== 'needs' && (() => {
        // One list across all groups, so watching the budget doesn't mean scrolling through every group.
        const all = v.groups.flatMap(g => g.rows.map(r => ({ ...r, group_name: g.name })));
        const used = all.filter(r => r.assigned || r.activity || r.available);
        const rows = [...used].sort(sort === 'spent'
          ? (a, b) => spentOf(b) - spentOf(a) || a.available - b.available
          : (a, b) => a.available - b.available || spentOf(b) - spentOf(a));
        const hidden = all.length - used.length;
        return (
          <div class="card">
            <div class="row between">
              <span class="eyebrow">{sort === 'spent' ? 'Most spent first' : 'Lowest remaining first'} <Help k="categories" /></span>
              <span class="eyebrow money">{fmt(v.totals.available)} left</span>
            </div>
            {view === 'list' && rows.length > 0 && <ColHeads />}
            <div class="clist">
              {rows.map(c => <CategoryRow key={c.id} view={view} c={c} showGroup month={month} open={openCat === c.id && !side} picked={side && openCat === c.id} onToggle={() => setOpenCat(openCat === c.id ? null : c.id)} rta={v.ready_to_assign} ui={ui} data={data} closed={closed} />)}
            </div>
            {hidden > 0 && <button class="link" style="align-self:flex-start;font-size:12px" onClick={() => setSort('groups')}>{hidden} unused categor{hidden === 1 ? 'y' : 'ies'} hidden · show all groups</button>}
          </div>
        );
      })()}

      {sort === 'groups' && v.groups.map(g => (
        <div class="card" key={g.id}>
          <div class="row between">
            <span class="eyebrow">{renamingGroup === g.id
              ? <form style="display:inline" onSubmit={e => { e.preventDefault(); e.target.n.blur(); }}>
                  {/* Saved once, when the box loses focus (Enter just leaves the box); Escape cancels. */}
                  <input name="n" class="grpname" defaultValue={g.name} autoFocus aria-label="Group name"
                    onBlur={async e => { const n = e.target.value.trim(), cancel = e.target.dataset.cancel; setRenamingGroup(null); const grp = data.groups.find(x => x.id === g.id); if (!cancel && n && n !== grp.name) { await put('category_groups', { ...grp, name: n }); ui.toast(`Renamed group to ${n}`); } }}
                    onKeyDown={e => { if (e.key === 'Escape') { e.target.dataset.cancel = '1'; e.target.blur(); } }} />
                </form>
              : g.name} {renamingGroup !== g.id && <button class="link" onClick={() => setRenamingGroup(g.id)} aria-label={`Rename ${g.name}`} title="Rename group">✎</button>}<button class="link" onClick={() => setAdding(adding === g.id ? null : g.id)}>+</button>{g.rows.length === 0 && <button class="link" style="color:var(--muted)" onClick={async () => { const grp = data.groups.find(x => x.id === g.id); await put('category_groups', { ...grp, deleted: 1 }); ui.toast(`Deleted group ${g.name}`); }}>delete</button>}</span>
            <span class="eyebrow money"><Roll value={g.available} /> left</span>
          </div>
          {adding === g.id && (
            <form class="row" onSubmit={async e => { e.preventDefault(); const name = e.target.name.value.trim(); if (name) await put('categories', { group_id: g.id, name, sort: g.rows.length, target: 0, note: '' }); setAdding(null); }}>
              <input name="name" placeholder="New category" autoFocus /><button class="primary">Add</button>
            </form>
          )}
          {view === 'list' && g.rows.length > 0 && <ColHeads />}
          <div class="clist">
            {g.rows.map(c => <CategoryRow key={c.id} view={view} c={c} month={month} open={openCat === c.id && !side} picked={side && openCat === c.id} onToggle={() => setOpenCat(openCat === c.id ? null : c.id)} rta={v.ready_to_assign} ui={ui} data={data} closed={closed} />)}
          </div>
        </div>
      ))}


      <form class="card form" onSubmit={async e => { e.preventDefault(); const name = e.target.name.value.trim(); const inc = e.target.inc.checked; if (name) await put('category_groups', { name, sort: v.groups.length + 1, is_income: inc ? 1 : 0 }); e.target.reset(); }}>
        <div class="row"><input name="name" placeholder="New category group" /><button>Add group</button></div>
        <label class="check head"><input type="checkbox" name="inc" /> Income group (Paycheck, Cash deposit, Check deposit…) — its categories track where money came from instead of holding a budget</label>
      </form>

      </>}
    </>
  );

  return (
    <Shell route="budget" top={top}>
      <SetupCard data={data} />
      {wide ? <Dashboard data={data} month={month} onLayout={setHasDetail} body={<div class="card budgetw">{budgetBody()}</div>} detail={() => <CategoryDetail c={v.groups.flatMap(g => g.rows).find(c => c.id === openCat)} view="list" month={month} rta={v.ready_to_assign} ui={ui} data={data} closed={closed} />} /> : budgetBody()}
      {holdOpen && <ReadySheet start={holdOpen === 'hold' ? 'hold' : 'check'} data={data} v={v} month={month} nextName={nextName} closed={closed} onClose={() => setHoldOpen(false)} />}
      {review && <Review data={data} month={review} onClose={() => setReview(null)} />}
      {covering && <CoverSheet data={data} month={covering.month} ids={covering.ids} ui={ui} onDone={covering.done} onClose={() => setCovering(null)} />}
    </Shell>
  );
}

/** Dashboard "Category detail" widget: the chosen category, opened. */
function CategoryDetail({ c, ...rest }) {
  if (!c) return <div class="card"><span class="eyebrow">Category detail</span><span class="head">Tap a category to see its details, trend and transactions here.</span></div>;
  return <div class="card detailw"><span class="eyebrow">{c.group_name}</span><CategoryRow key={c.id} c={c} open onToggle={() => {}} {...rest} /></div>;
}

function DueRow({ s, data }) {
  const ui = useUI();
  const acct = data.accounts.find(a => a.id === s.account_id);
  const cat = data.categories.find(c => c.id === s.category_id);
  return (
    <div class="due">
      <div class="main">
        <div class="p">{s.transfer_to ? `Transfer to ${data.accounts.find(a => a.id === s.transfer_to)?.name}` : s.payee}</div>
        <div class="s">{dayLabel(s.next_date)} · {acct?.name}{cat ? ` · ${cat.name}` : s.transfer_to ? ' · transfer' : ''}</div>
      </div>
      <span class={'money ' + (s.amount > 0 ? 'pos' : '')} style="font-weight:600">{fmt(s.amount)}</span>
      <button class="primary" style="min-height:36px;padding:6px 12px" onClick={async () => { await postScheduled(s); ui.toast(`Posted ${s.payee || 'transfer'}`); }}>Post</button>
      <button class="ghost" style="min-height:36px;padding:6px 8px" onClick={() => skipScheduled(s)}>Skip</button>
    </div>
  );
}

const ColHeads = () => <div class="ccols"><span>Category</span><span>Assigned</span><span>Spent</span><span>Available</span></div>;

function CategoryRow({ view = 'list', showGroup = false, c, month, open, picked, onToggle, rta, ui, data, closed }) {
  const [merging, setMerging] = useState(false);
  const [moving, setMoving] = useState(false);
  const [covering, setCovering] = useState(false);
  // Envelope filling: when money is assigned in, the bar or ring pours up with a shimmer.
  const [pour, setPour] = useState(false);
  const lastAssigned = useRef(c.assigned);
  useEffect(() => {
    if (c.assigned > lastAssigned.current) { setPour(true); const t = setTimeout(() => setPour(false), 900); lastAssigned.current = c.assigned; return () => clearTimeout(t); }
    lastAssigned.current = c.assigned;
  }, [c.assigned]);
  const spent = -Math.min(0, c.activity);
  const total = Math.max(spent + Math.max(c.available, 0), 1);
  const pct = Math.min(100, Math.round(spent / total * 100));
  const over = c.available < 0;
  const pc = pace(c, month);
  const avCls = over ? 'neg' : c.available > 0 ? 'pos' : 'muted';
  // Secondary details under a list row: cover hint, daily pace, goal progress.
  const extra = [
    over && (c.id === data.prefs?.payoff_category_id ? `Card debt to fund: ${fmt(-c.available)} · tap to assign` : `Overspent by ${fmt(-c.available)} · tap to cover`),
    overPlan(c) > 0 && <span class="overplan">▲ <span class="overamt">{fmt(overPlan(c))}</span> over plan (spent {fmt(spentOf(c))} of {fmt(c.target)})</span>,
    pc && !over && `${fmt(pc.perDay)}/day for ${pc.daysLeft} day${pc.daysLeft === 1 ? '' : 's'}`,
    c.target > 0 && !over && (c.goal_type === 'by_date' && c.goal_date
      ? (c.available >= c.target ? 'goal reached' : `${fmt(goalNeed(c, month))} this month → ${fmt(c.target)} by ${new Date(c.goal_date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`)
      : (goalNeed(c, month) > 0 ? `${fmt(goalNeed(c, month))} to target` : '')),
  ].filter(Boolean).reduce((out, x, i) => (i ? [...out, ' · ', x] : [x]), []);
  const [val, setVal] = useState(null);
  const [target, setTarget] = useState(null);
  const [note, setNote] = useState(null);
  const [scheduling, setScheduling] = useState(null);   // new scheduled bill from this category's target
  const [add, setAdd] = useState('');
  const doAdd = async () => { const cents = parseMoney(add); if (!cents) return; await assign(c.id, month, c.assigned + cents); ui.toast(`${c.name} now ${fmt(c.available + cents)}`); setAdd(''); };
  const commit = async () => { if (val !== null) { await assign(c.id, month, parseMoney(val)); setVal(null); } };
  const saveCat = async patch => { const { group_name, group_sort, assigned, activity, available, ...row } = c; await put('categories', { ...row, ...patch }); };
  const saveMeta = async () => {
    const patch = {};
    if (target !== null) patch.target = parseMoney(target);
    if (note !== null) patch.note = note.trim();
    if (Object.keys(patch).length) { const { group_name, group_sort, assigned, activity, available, ...row } = c; await put('categories', { ...row, ...patch }); }
    setTarget(null); setNote(null);
  };
  return (
    <div class={'cat ' + view + (open ? ' open' : '') + (picked ? ' picked' : '') + (pour ? ' pour' : '')} id={'cat-' + c.id}>
        <div class="crow" onClick={onToggle}>
          <span class="n"><span class="nline"><Icon data={data} c={c} /><span class="nm">{c.name}</span>{overPlan(c) > 0 && <span class="pill overplan" title={`Spent ${fmt(spentOf(c))} of ${fmt(c.target)} planned`}>▲</span>}{c.target > 0 && goalNeed(c, month) === 0 && !overPlan(c) && <span class="pill">✓</span>}</span>{showGroup && <span class="grp">{c.group_name}</span>}</span>
          <span class="a money">{fmt(c.assigned)}</span>
          <Roll class={'s money ' + (over ? 'neg' : '')} value={spent} />
          <span><Roll class={'av money ' + avCls} value={c.available} /></span>
          <div class={'thin ' + (over ? 'over' : '')}><i style={`width:${over ? 100 : pct}%`} /></div>
        </div>
      {view === 'list' && extra.length > 0 && <div class={'head ' + (over ? 'neg' : '')} onClick={onToggle}>{extra}</div>}
      {c.note && !open && <div class="note" onClick={onToggle}>{c.note}</div>}
      {open && (
        <>
          {closed && <div class="head">🔒 Month closed — assignments locked.</div>}
          <PaidWith data={data} month={month} c={c} />
          <BorrowNote data={data} month={month} c={c} />
          <div class="edit" style={closed ? 'opacity:.5;pointer-events:none' : ''}>
            <label class="head" style="display:flex;flex-direction:column;gap:2px">Assigned this month
              <input class="num" inputMode="decimal" value={val ?? (c.assigned / 100).toFixed(2)} onFocus={e => e.target.select()}
                onInput={e => setVal(e.target.value)} onBlur={commit} onKeyDown={e => e.key === 'Enter' && e.target.blur()} aria-label="Assigned this month" />
            </label>
            {over && <button class="primary" onClick={() => setCovering(true)}>Cover {fmt(-c.available)}</button>}
            {c.assigned > 0 && <button class="ghost" onClick={() => assign(c.id, month, 0)}>Zero</button>}
            <button onClick={() => setMoving(true)}>Move…</button>
          </div>
          {covering && <CoverSheet data={data} month={month} ids={[c.id]} ui={ui} onClose={() => setCovering(false)} />}
          {moving && <MoveSheet c={c} data={data} month={month} rta={rta} ui={ui} onClose={() => setMoving(false)} />}
          <div class="addrow" style={closed ? 'display:none' : ''}>
            <span class="lbl">Add</span>
            <input class="num" inputMode="decimal" placeholder="0.00" value={add} onInput={e => setAdd(e.target.value)} aria-label="Amount to add"
              onKeyDown={e => { if (e.key === 'Enter') doAdd(); }} />
            <button class="primary" disabled={!parseMoney(add)} onClick={doAdd}>+ {fmt(parseMoney(add) || 0)}</button>
          </div>
          <div class="head">{rta > 0 ? <>Ready to assign: <b class="money">{fmt(rta)}</b> · <button class="link" style="font-size:12px" onClick={() => setAdd((rta / 100).toFixed(2))}>use all</button></> : 'Nothing left in Ready to Assign'}</div>
          <div class="trendwrap"><Trend c={c} data={data} month={month} /></div>
          <div class="recentwrap"><RecentForCategory c={c} data={data} ui={ui} /></div>
          <div class="grid2" style="margin-top:4px">
            <label class="head">Goal
              <Select value={c.goal_type || 'monthly'} onChange={e => saveCat({ goal_type: e.target.value })}>
                <option value="monthly">Refill to amount each month</option>
                <option value="by_date">Save amount by a date</option>
              </Select>
            </label>
            <label class="head">{c.goal_type === 'by_date' ? 'Save up' : 'Monthly target'}<input class="num" inputMode="decimal" value={target ?? (c.target ? (c.target / 100).toFixed(2) : '')} placeholder="none" onInput={e => setTarget(e.target.value)} onBlur={saveMeta} /></label>
          </div>
          {c.target > 0 && c.goal_type !== 'by_date' && !data.scheduled.some(s => s.category_id === c.id && !s.deleted) && (
            <button class="link schedlink" onClick={() => setScheduling({ payee: c.name.replace(/^\p{Extended_Pictographic}\s*/u, ''), amount: -c.target, category_id: c.id, frequency: 'monthly' })}>⟳ Schedule {fmt(c.target)} as a monthly bill</button>
          )}
          {scheduling && <Editor data={data} row={scheduling} onClose={() => setScheduling(null)} />}
          {c.goal_type === 'by_date' && (
            <div class="grid2">
              <label class="head">By<input type="date" value={c.goal_date || ''} onChange={e => saveCat({ goal_date: e.target.value || null })} /></label>
              <span class="head" style="align-self:end">{c.goal_date && c.target ? `${fmt(goalNeed(c, month))}/month for ${Math.max(1, monthsUntil(month, c.goal_date) + 1)} months` : 'Set amount and date'}</span>
            </div>
          )}
          <NameField data={data} c={c} ui={ui} />
          <IconField data={data} c={c} />
          <label class="head">Note<input value={note ?? c.note ?? ''} placeholder="e.g. renews Jan 15" onInput={e => setNote(e.target.value)} onBlur={saveMeta} /></label>
          <div class="row">
            <button class="ghost" style="font-size:12px" onClick={() => setMerging(m => !m)}>{merging ? 'Cancel' : 'Delete / merge…'}</button>
          </div>
          {merging && <MergeCategory c={c} data={data} ui={ui} onDone={() => setMerging(false)} />}
        </>
      )}
    </div>
  );
}

/**
 * Tapping Ready to Assign: the money in your budget (to compare with your bank) and where it is, plus
 * holding money for next month.
 */
function ReadySheet({ start, data, v, month, nextName, closed, onClose }) {
  useModal(onClose);
  const [tab, setTab] = useState(start || 'check');   // two tabs, so each fits on a phone screen without scrolling
  const [val, setVal] = useState((v.held_for_next / 100).toFixed(2));
  const next = addMonths(month, 1);
  const cents = parseMoney(val);
  const max = v.ready_to_assign + v.held_for_next;
  const save = async () => { await assign(HOLD, next, Math.max(0, cents)); onClose(); };
  const rows = v.groups.flatMap(g => g.rows);
  const inCats = rows.reduce((s, r) => s + Math.max(0, r.available), 0);   // overspending not taken off
  const txsTo = data.txs.filter(t => t.date.slice(0, 7) <= month);
  const isDebt = a => a.type === 'credit' || a.type === 'loan';
  const live = data.accounts.filter(a => !a.closed && !a.deleted);
  const bank = balances(live.filter(a => a.on_budget && !isDebt(a)), txsTo);
  const bankTotal = bank.reduce((s, a) => s + a.balance, 0);
  const debts = balances(live.filter(isDebt), txsTo).filter(a => a.balance !== 0);
  const cov = coverageAll(data, month);
  const forCards = debts.filter(a => a.type === 'credit').reduce((s, a) => s + (cov[a.id]?.ready || 0), 0);
  const later = v.assigned_future;   // held for next month and any assigned to later months
  const borrowed = v.borrowed_from_next;   // next month's money already used here: not in the bank
  const sum = v.ready_to_assign + inCats + later + forCards - borrowed;
  const mc = moneyCheck(data, month);
  const ui = useUI();
  const diff = bankTotal - sum;
  const L = ({ l, val: x, cls, sub }) => <div class="rl"><span>{l}{sub && <span class="head"> {sub}</span>}</span><b class={'money ' + (cls || '')}>{fmt(x)}</b></div>;
  return createPortal((
    <div class="scrim">
      <div class="sheet readysheet" role="dialog" aria-modal="true" aria-label="Ready to assign">
        <div class="handle" />
        <div class="row between"><b>Money in your budget</b><button class="ghost" onClick={onClose}>Close</button></div>
        <div class="seg" role="tablist">
          <button role="tab" aria-selected={tab === 'check'} class={tab === 'check' ? 'on' : ''} onClick={() => setTab('check')}>Bank check</button>
          <button role="tab" aria-selected={tab === 'hold'} class={tab === 'hold' ? 'on' : ''} onClick={() => setTab('hold')}>Hold for {nextName}{v.held_for_next ? ` · ${fmt(v.held_for_next)}` : ''}</button>
        </div>
        {tab === 'check' && <>
        <div class="card inner">
          <span class="eyebrow">Bank check{month < ym() ? ` · end of ${monthLabel(month).split(' ')[0]}` : ''} <Help k="bankcheck" /></span>
          <L l="Ready to assign" val={v.ready_to_assign} cls={v.ready_to_assign < 0 ? 'neg' : 'pos'} />
          <L l="In categories" val={inCats} />
          {later > 0 && <L l={`Held for ${nextName}`} sub={later > v.held_for_next ? '(and later months)' : ''} val={later} />}
          {forCards > 0 && <L l="Set aside to pay cards" sub="(spent on a card, still in the bank)" val={forCards} />}
          {borrowed > 0 && <L l={`Taken from ${nextName}'s money`} sub="(covered overspending; not in the bank yet)" val={-borrowed} cls="neg" />}
          <div class="rl total"><span>Should be in the bank</span><b class="money">{fmt(sum)}</b></div>
          <div class="banklist">
            {bank.map(a => <L l={a.name} val={a.balance} cls={a.balance < 0 ? 'neg' : ''} />)}
            <div class="rl total"><span>Your bank accounts</span><b class="money">{fmt(bankTotal)}</b></div>
          </div>
          {mc.staleBorrow && (
            <div class="warn amber col" style="align-items:stretch;gap:6px">
              <span><b>Something doesn't add up.</b> {fmt(mc.staleBorrow.extra)} "taken from {monthLabel(mc.staleBorrow.month).split(' ')[0]}'s money" no longer covers anything: the overspending it covered was deleted or covered another way. It's not counted, so your figures here are right; clear it to tidy up.</span>
              <button class="primary" onClick={async () => { await clearStaleBorrow(mc.staleBorrow, data); ui.toast('Cleared'); }}>Clear the leftover {fmt(mc.staleBorrow.extra)}</button>
            </div>
          )}
          {diff === 0
            ? <span class="matchok">✓ Matches your bank accounts</span>
            : <span class="matchoff">{diff > 0 ? `${fmt(diff)} more in the bank than budgeted` : `${fmt(-diff)} less in the bank than budgeted`}: usually overspending on a card, card debt not budgeted yet, or uncategorized money. Money check shows which.</span>}
          <span class="head">Compare "Your bank accounts" with what your bank's app shows. Overspending isn't taken off the categories here.</span>
          {bank.some(a => a.tips_pending > 0) && <span class="head tipnote">💵 Your bank's app may show {fmt(bank.reduce((s, a) => s + a.tips_pending, 0))} more for now: tips it hasn't posted yet. They're already counted here.</span>}
        </div>
        {debts.length > 0 && (
          <div class="card inner">
            <span class="eyebrow">Debts</span>
            {debts.map(a => (
              <div class="rl">
                <span>{a.name}<span class="head">{a.type === 'credit' ? ` · ${fmt(cov[a.id]?.ready || 0)} ready to pay${cov[a.id]?.uncovered > 0 ? `, ${fmt(cov[a.id].uncovered)} not covered` : ''}` : a.on_budget ? '' : ' · loan'}{a.tips_pending > 0 ? ` · statement shows ${fmt(Math.abs(a.balance + a.tips_pending))} until ${fmt(a.tips_pending)} in tips post` : ''}</span></span>
                <b class="money neg">{fmt(a.balance)}</b>
              </div>
            ))}
            <span class="head">What you owe. Card spending you've budgeted for is the "set aside" line above; loans are paid from their categories.</span>
          </div>
        )}
        </>}
        {tab === 'hold' && <>
        <p class="head" style="margin:0">Money you hold leaves this month's Ready to Assign and reappears in {nextName}'s. Use it for next month's rent when you get paid at the end of this one.</p>
        <label class="field"><span class="lbl">Amount to hold</span><input class="num" inputMode="decimal" value={val} onInput={e => setVal(e.target.value)} onFocus={e => e.target.select()} disabled={closed} /></label>
        <div class="row" style="flex-wrap:wrap">
          <button class="chip" onClick={() => setVal((max / 100).toFixed(2))}>All {fmt(max)}</button>
          <button class="chip" onClick={() => setVal((Math.max(0, max) / 200).toFixed(2))}>Half</button>
          <button class="chip" onClick={() => setVal('0.00')}>Release all</button>
        </div>
        {cents > max && <div class="neg head">That's {fmt(cents - max)} more than you have available.</div>}
        <div class="row"><button class="primary" style="flex:1" disabled={closed || cents === v.held_for_next} onClick={save}>{cents ? `Hold ${fmt(cents)}` : v.held_for_next ? 'Release the hold' : 'Hold'}</button></div>
        </>}
      </div>
    </div>
  ), document.body);
}

const shortMonth = m => monthLabel(m).split(' ')[0];
const dayOf = d => (d ? new Date(d + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');

/**
 * Money moved between months to cover overspending, shown like a category until it's repaid:
 * "Owed to December" in the month that borrowed, "Paying back November" in the month after.
 * Tap for what it covered, when, and Undo.
 */
function Borrows({ data, month, ui }) {
  const [open, setOpen] = useState(null);   // the borrowing month whose details are open
  const prev = addMonths(month, -1);
  const out = borrowItems(data, month), back = borrowItems(data, prev);
  const Row = ({ m, b, label, sub }) => (
    <button type="button" class="borrowrow" onClick={() => setOpen(m)} aria-label={`${label}: ${fmt(b.owed)}. Show details`}>
      <span class="col" style="min-width:0;flex:1;text-align:left"><b>{label}</b><span class="head">{sub}</span></span>
      <b class="money neg">−{fmt(b.owed)}</b><span class="head" aria-hidden="true">›</span>
    </button>
  );
  const what = b => b.items.filter(x => x.owed > 0).map(x => `${x.name}${x.date ? ' · ' + dayOf(x.date) : ''} · ${fmt(x.owed)}`).join(' · ');
  return (
    <>
      {back.owed > 0 && <Row m={prev} b={back} label={`↩ Paying back ${shortMonth(prev)}`} sub={`${shortMonth(prev)} covered overspending with this month's money: ${what(back)}`} />}
      {out.owed > 0 && <Row m={month} b={out} label={`↪ Owed to ${shortMonth(addMonths(month, 1))}`} sub={what(out)} />}
      {open && <BorrowSheet data={data} month={open} ui={ui} onClose={() => setOpen(null)} />}
    </>
  );
}

function BorrowSheet({ data, month, ui, onClose }) {
  useModal(onClose);
  const b = borrowItems(data, month);
  const next = addMonths(month, 1);
  const total = b.items.reduce((s, x) => s + x.amount, 0);
  if (!b.owed) { setTimeout(onClose, 0); return null; }
  return createPortal((
    <div class="scrim" onClick={e => e.target === e.currentTarget && onClose()}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label={`Owed to ${shortMonth(next)}`}>
        <div class="handle" />
        <div class="row between"><b>{shortMonth(month)} owes {shortMonth(next)} {fmt(b.owed)}</b><button class="ghost" onClick={onClose}>Close</button></div>
        <span class="head">Overspending in {shortMonth(month)} was covered with {shortMonth(next)}'s money. {shortMonth(next)}'s Ready to assign starts {fmt(b.owed)} lower to pay it back.{total > b.owed ? ` Money that came in during ${shortMonth(month)} has already paid back ${fmt(total - b.owed)}.` : ` Money that comes in during ${shortMonth(month)} pays it back first, by itself.`}</span>
        <div class="col" style="gap:6px">
          {b.items.filter(x => x.owed > 0).map(x => (
            <div class="borrowitem row between">
              <span class="col" style="min-width:0"><b>{x.name}</b><span class="head">{x.date ? `Covered ${dayOf(x.date)}` : 'Covered earlier'}{x.amount !== x.owed ? ` · ${fmt(x.amount)}, ${fmt(x.amount - x.owed)} paid back` : ''}</span></span>
              <span class="row" style="gap:8px;flex:none"><b class="money neg">−{fmt(x.owed)}</b>
                {x.cat && <button class="ghost small" onClick={async () => { await undoBorrow(data, month, x); ui.toast(`${x.name} is overspent again`); }}>Undo</button>}</span>
            </div>
          ))}
        </div>
        <span class="head">Undo takes the money back out of the category, so it's overspent again, and {shortMonth(next)} no longer pays for it.</span>
      </div>
    </div>
  ), document.body);
}

/** On a category covered with next month's money: when, and how much is still owed. */
function BorrowNote({ data, month, c }) {
  const mine = borrowItems(data, month).items.filter(x => x.cat === c.id && x.owed > 0);
  if (!mine.length) return null;
  return <div class="head borrownote">↪ Covered {mine.map(x => `${fmt(x.owed)} on ${dayOf(x.date)}`).join(' and ')} with {shortMonth(addMonths(month, 1))}'s money.</div>;
}

/** How this month's spending in a category was paid: credit cards (each) versus cash or debit. */
function PaidWith({ data, month, c }) {
  const p = spendSplit(data, month, c.id);
  if (!p.spent) return null;
  const card = cardPartOfOverspend(data, month, c);
  return (
    <div class="paidwith">
      <div class="pwbar" aria-hidden="true"><i class="pwcard" style={`width:${Math.round(p.card / p.spent * 100)}%`} /></div>
      <div class="row between head">
        <span><span class="pwdot pwcard" /> On cards <b class="money">{fmt(p.card)}</b>{p.cards.length > 1 || (p.cards.length === 1 && p.cash) ? <> ({p.cards.map(x => `${x.name} ${fmt(x.amount)}`).join(', ')})</> : p.cards.length === 1 ? <> ({p.cards[0].name})</> : null}</span>
        <span><span class="pwdot" /> Cash or debit <b class="money">{fmt(p.cash)}</b></span>
      </div>
      {card > 0 && <span class="head">{fmt(card)} of the overspending is on a card. Cover it now to set money aside for that card, or leave it: at month end it moves to your payoff category.</span>}
    </div>
  );
}

/** Move money from this category to another (or to/from Ready to Assign). */
function MoveSheet({ c, data, month, rta, ui, onClose }) {
  useModal(onClose);
  const v = monthView(data, month);
  const rows = []; for (const g of v.groups) for (const r of g.rows) rows.push(r);
  const [dir, setDir] = useState(c.available > 0 ? 'out' : 'in');     // out: from this category; in: into it
  const [other, setOther] = useState('');                               // '' = Ready to Assign
  const [val, setVal] = useState('');
  const cents = parseMoney(val);
  const src = dir === 'out' ? c : (other ? rows.find(r => r.id === other) : null);
  const srcAvail = dir === 'out' ? c.available : (other ? (rows.find(r => r.id === other)?.available || 0) : rta);
  const go = async () => {
    if (!cents || cents > srcAvail) return;
    const from = dir === 'out' ? c.id : other, to = dir === 'out' ? other : c.id;
    const name = id => id ? rows.find(r => r.id === id)?.name : 'Ready to assign';
    beginBatch(`Moved ${fmt(cents)} from ${name(from)} to ${name(to)}`);
    try {
      if (from) { const r = rows.find(x => x.id === from); await assign(from, month, r.assigned - cents); }
      if (to) { const r = rows.find(x => x.id === to); await assign(to, month, r.assigned + cents); }
    } finally { endBatch(); }
    ui.toast(`Moved ${fmt(cents)} → ${name(to)}`); onClose();
  };
  return createPortal((
    <div class="scrim">
      <div class="sheet" role="dialog" aria-modal="true" aria-label="Move money">
        <div class="handle" />
        <div class="seg">
          <button class={dir === 'out' ? 'on' : ''} onClick={() => setDir('out')}>From {c.name}</button>
          <button class={dir === 'in' ? 'on' : ''} onClick={() => setDir('in')}>Into {c.name}</button>
        </div>
        <div class="field"><span class="lbl">{dir === 'out' ? 'To' : 'From'}</span>
          <Select value={other} onChange={e => setOther(e.target.value)}>
            <option value="">Ready to assign ({fmt(rta)})</option>
            {rows.filter(r => r.id !== c.id).map(r => <option value={r.id}>{r.group_name}: {r.name} ({fmt(r.available)})</option>)}
          </Select>
        </div>
        <div class="field"><span class="lbl">Amount</span><input class="num" inputMode="decimal" value={val} placeholder="0.00" onInput={e => setVal(e.target.value)} autoFocus /></div>
        <div class="row" style="flex-wrap:wrap">
          <button class="chip" onClick={() => setVal((Math.max(0, srcAvail) / 100).toFixed(2))}>All {fmt(Math.max(0, srcAvail))}</button>
          {dir === 'in' && c.available < 0 && <button class="chip" onClick={() => setVal((-c.available / 100).toFixed(2))}>Cover {fmt(-c.available)}</button>}
          {c.target > 0 && dir === 'in' && goalNeed(c, month) > 0 && <button class="chip" onClick={() => setVal((goalNeed(c, month) / 100).toFixed(2))}>To target {fmt(c.target - c.available)}</button>}
        </div>
        {cents > srcAvail && <span class="head neg">Only {fmt(srcAvail)} available there.</span>}
        <div class="row"><button class="primary" style="flex:1" disabled={!cents || cents > srcAvail} onClick={go}>Move {fmt(cents || 0)}</button><button onClick={onClose}>Cancel</button></div>
      </div>
    </div>
  ), document.body);
}

/** One-line age of money under Ready to Assign; tap for the explanation. */
function AomLine({ data, ui }) {
  const a = ageOfMoney(data);
  const verdict = !a ? 'Needs a few more purchases to compute.' : a.days < 10 ? 'Living paycheck to paycheck — dollars get spent within days of arriving.' : a.days < 30 ? 'Getting ahead. Past 30 days you\'re spending last month\'s income.' : a.days < 60 ? 'A full month ahead. Next stop: two.' : 'Two months of buffer — a real cushion.';
  return <button class="aomline" onClick={() => ui.toast(`Age of money: ${a ? a.days + ' days' : '—'}. ${verdict}`)}>Age of money · <b>{a ? `${a.days} day${a.days === 1 ? '' : 's'}` : '—'}</b> ⓘ</button>;
}
function AgeOfMoney({ data }) {
  const a = ageOfMoney(data);
  const [open, setOpen] = useState(false);
  const verdict = !a ? '' : a.days < 10 ? 'Living paycheck to paycheck — every dollar in gets spent within days.' : a.days < 30 ? 'Getting ahead. Past 30 days means you spend last month\'s income this month.' : a.days < 60 ? 'You\'re a full month ahead. Next stop: two.' : 'Two months of buffer. This is what a real emergency cushion feels like.';
  return (
    <div class="card" onClick={() => setOpen(o => !o)} style="cursor:pointer">
      <div class="row between aom">
        <div class="col"><span class="eyebrow">Age of money <Help k="aom" /></span><span class="big">{a ? `${a.days} day${a.days === 1 ? '' : 's'}` : '—'}</span></div>
        <span class="head" style="text-align:right;max-width:55%">{a ? (open ? verdict : 'Tap for what this means') : 'Needs a few more transactions'}</span>
      </div>
      {open && <span class="head">Each purchase is paid with your oldest income first; this is the average age of the dollars behind your last {a?.samples || 10} purchases. It climbs as you leave money unspent — holding for next month, savings categories, not spending down Ready to Assign.</span>}
    </div>
  );
}

/** 6-month spending bars for one category, with the target as a dashed line. */
function Trend({ c, data, month }) {
  const months = []; for (let i = 5; i >= 0; i--) months.push(addMonths(month, -i));
  const spent = months.map(m => -Math.min(0, data.txs.filter(t => t.category_id === c.id && t.date.slice(0, 7) === m).reduce((s, t) => s + t.amount, 0)));
  const max = Math.max(1, c.target || 0, ...spent);
  if (!spent.some(x => x > 0)) return null;
  return (
    <div>
      <div class="row between"><span class="eyebrow">Spending · 6 months</span><span class="head">avg {fmt(Math.round(spent.reduce((a, b) => a + b, 0) / spent.length))}/mo{c.target ? ` · target ${fmt(c.target)}` : ''}</span></div>
      <div class="trend">
        {months.map((m, i) => (
          <div class="b" key={m} title={`${monthLabel(m)}: ${fmt(spent[i])}`}>
            {c.target > 0 && <span class="tgt" style={`bottom:${Math.round(c.target / max * 100)}%`} />}
            <i class={c.target && spent[i] > c.target ? 'over' : ''} style={`height:${Math.max(2, Math.round(spent[i] / max * 100))}%`} />
            <span>{m.slice(5)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Last 3 transactions in a category; tap to edit or delete. */
function RecentForCategory({ c, data, ui }) {
  const acctName = Object.fromEntries(data.accounts.map(a => [a.id, a.name]));
  const all = data.txs.filter(t => t.category_id === c.id).sort(newestFirst);
  if (!all.length) return <Empty icon="🧾" title="No spending here yet" hint="Purchases in this category will show up here." small />;
  return (
    <div style="margin-top:4px">
      <div class="row between"><span class="eyebrow">Recent</span>{all.length > 3 && <a class="link" style="font-size:12px;text-decoration:none;color:var(--pos)" href="#/accounts" onClick={e => { e.preventDefault(); ui.search(c.name); }}>All {all.length} ›</a>}</div>
      {all.slice(0, 3).map(t => (
        <div class="txrow" key={t.id} style="padding:6px 2px">
          <div class="main" onClick={() => ui.open({ tx: t })}>
            <div class="p">{t.transfer_id ? 'Loan payment' : t.payee || '(no payee)'}</div>
            <div class="s">{dayLabel(t.date)} · {acctName[t.account_id]}{t.memo ? ` · ${t.memo}` : ''}</div>
          </div>
          <span class={'money ' + (t.amount > 0 ? 'pos' : '')} style="font-weight:600" onClick={() => ui.open({ tx: t })}>{fmt(t.amount)}</span>
          <button class="ghost" style="min-height:32px;padding:4px 8px" aria-label="Delete" onClick={async () => { await remove('transactions', t.id); ui.toast(`Deleted ${t.payee || 'transaction'}`, { undo: () => restore('transactions', t.id) }); }}>✕</button>
        </div>
      ))}
    </div>
  );
}

/** Delete a category, moving its transactions, assignments, scheduled items and rules to another one. */
function MergeCategory({ c, data, ui, onDone }) {
  const others = data.categories.filter(x => x.id !== c.id);
  const groupName = Object.fromEntries(data.groups.map(g => [g.id, g.name]));
  const [target, setTarget] = useState('');
  const txs = data.txs.filter(t => t.category_id === c.id);
  const months = data.months.filter(b => b.category_id === c.id);
  const sched = data.scheduled.filter(s => s.category_id === c.id);
  const rules = data.rules.filter(r => r.category_id === c.id);
  const hasStuff = txs.length || months.some(b => b.assigned) || sched.length || rules.length;
  const go = async () => {
    if (hasStuff && !target) return;
    const tname = others.find(x => x.id === target)?.name;
    beginBatch(hasStuff ? `Merged ${c.name} into ${tname}` : `Deleted ${c.name}`);
    try {
      for (const t of txs) await put('transactions', { ...t, category_id: target });
      for (const b of months) {
        const existing = data.months.find(x => x.category_id === target && x.month === b.month);
        if (existing) await put('budget_months', { ...existing, assigned: existing.assigned + b.assigned });
        else await put('budget_months', { category_id: target, month: b.month, assigned: b.assigned });
        await put('budget_months', { ...b, deleted: 1 });
      }
      for (const s of sched) await put('scheduled', { ...s, category_id: target });
      for (const r of rules) await put('payee_rules', { ...r, category_id: target });
      const { group_name, group_sort, assigned, activity, available, ...row } = c;
      await put('categories', { ...row, deleted: 1 });
    } finally { endBatch(); }
    ui.toast(hasStuff ? `Merged into ${tname}` : `Deleted ${c.name}`);
    onDone();
  };
  return (
    <div class="col" style="gap:6px;padding:8px;border-radius:10px;background:var(--chip)">
      {hasStuff ? (
        <>
          <span class="head">This category has {txs.length} transaction{txs.length === 1 ? '' : 's'}, {fmt(months.reduce((s, b) => s + b.assigned, 0))} assigned{sched.length ? `, ${sched.length} scheduled` : ''}{rules.length ? `, ${rules.length} rule${rules.length === 1 ? '' : 's'}` : ''}. Move everything to:</span>
          <Select aria-label="Move them to" value={target} onChange={e => setTarget(e.target.value)}>
            <option value="">Choose a category…</option>
            {others.map(x => <option value={x.id}>{groupName[x.group_id]}: {x.name}</option>)}
          </Select>
        </>
      ) : <span class="head">Empty category — safe to delete.</span>}
      <div class="row"><button class="primary" disabled={hasStuff && !target} onClick={go}>{hasStuff ? 'Merge & delete' : 'Delete'}</button><button class="ghost" onClick={onDone}>Cancel</button></div>
      <span class="head">Undo is under Menu › History.</span>
    </div>
  );
}

/** Budget-tab search: matching categories (live, editable) plus matching transactions. */
function BudgetSearch({ view, data, q, v, month, rta, openCat, setOpenCat, ui }) {
  const needle = q.trim().toLowerCase();
  const groups = v.groups.map(g => ({ ...g, rows: g.rows.filter(c => (c.name + ' ' + g.name).toLowerCase().includes(needle)) })).filter(g => g.rows.length);
  const n = groups.reduce((s, g) => s + g.rows.length, 0);
  return (
    <>
      <span class="eyebrow">{n} categor{n === 1 ? 'y' : 'ies'}</span>
      {groups.map(g => (
        <div class="card" key={g.id}>
          <div class="row between"><span class="eyebrow">{g.name}</span><span class="eyebrow money">{fmt(g.rows.reduce((s, r) => s + r.available, 0))} left</span></div>
          {view === 'list' && <ColHeads />}
          <div class="clist">
            {g.rows.map(c => <CategoryRow key={c.id} view={view} c={c} month={month} open={openCat === c.id} onToggle={() => setOpenCat(openCat === c.id ? null : c.id)} rta={rta} ui={ui} data={data} />)}
          </div>
        </div>
      ))}
      {!n && <span class="head">No category matches "{q}".</span>}
      <SearchResults data={data} q={q} />
    </>
  );
}

/** Spending above plan this month, and scheduled charges that now cost more than scheduled. */
function PlanCheck({ data, month, ui, closed, onOpen }) {
  // Folded to one line until opened (remembered on this device).
  const [open, setOpenS] = useState(() => { try { return localStorage.getItem('budget.planOpen') === '1'; } catch { return false; } });
  const setOpen = o => { setOpenS(o); try { localStorage.setItem('budget.planOpen', o ? '1' : '0'); } catch {} };
  const { cats, charges } = planCheck(data, month);
  if (!cats.length && !charges.length) return null;
  const update = async x => {
    beginBatch(`Updated ${x.s.payee} to ${fmt(x.charged)}`);
    try {
      await put('scheduled', { ...x.s, amount: -x.charged });
      const c = data.categories.find(k => k.id === x.s.category_id);
      if (c && c.target === x.planned && c.goal_type !== 'by_date') await put('categories', { ...c, target: x.charged });
    } finally { endBatch(); }
    ui.toast(`${x.s.payee} is now planned at ${fmt(x.charged)}`);
  };
  const items = [
    ...charges.map(x => (
      <div class="planrow tap" role="button" tabIndex={0} onClick={e => { if (!e.target.closest('button')) nav('#/scheduled'); }}>
        <span class="col" style="flex:1;min-width:0"><b>{x.s.payee} costs more now</b><span class="head">Charged <span class="money">{fmt(x.charged)}</span> {/^(Today|Yesterday)$/.test(dayLabel(x.t.date)) ? dayLabel(x.t.date).toLowerCase() : 'on ' + dayLabel(x.t.date)}, scheduled <span class="money">{fmt(x.planned)}</span></span></span>
        <button class="chip" disabled={closed} onClick={() => update(x)}>Update to {fmt(x.charged)}</button>
      </div>
    )),
    ...cats.map(x => (
      <div class="planrow tap" role="button" tabIndex={0} onClick={() => onOpen(x.c.id)} onKeyDown={e => e.key === 'Enter' && onOpen(x.c.id)}>
        <span class="col" style="flex:1;min-width:0"><b>{catIcon(data, x.c) ? catIcon(data, x.c) + ' ' : ''}{x.c.name}</b><span class="head">Spent <span class="money">{fmt(x.spent)}</span> of <span class="money">{fmt(x.c.target)}</span> planned · <span class="money overamt">{fmt(x.over)}</span> over</span></span>
      </div>
    )),
  ];
  return (
    <div class="card plancheck">
      <button type="button" class="row between incomehead" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span class="eyebrow">Over plan <Help k="overplan" /> <span class="chev">{open ? '▾' : '▸'}</span></span>
        <span class="pill overplan">▲ {cats.length + charges.length}</span>
      </button>
      {open && items}
      {open && <span class="head">Spending above a category's monthly target, even when you covered it, and scheduled bills that recently charged more than planned. A good time to raise a target or update a subscription.</span>}
    </div>
  );
}
