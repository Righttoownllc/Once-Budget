import { monthView, ym, addMonths, fmt, monthLabel, startingIn } from '../budget.js';
import { netWorthSeries } from '../features.js';
import { isNative, callNative } from '../platform.js';
import { nav } from '../main.jsx';
import { catIcon } from '../icons.jsx';
import { BADGES, earned } from '../achievements.js';

/** "Your year": the monthly recap's big sibling (#/recap?year=YYYY). Save as PDF like the recap. */
export function yearStats(data, year) {
  const now = ym();
  const months = []; for (let i = 1; i <= 12; i++) { const m = `${year}-${String(i).padStart(2, '0')}`; if (m <= now) months.push(m); }
  const payoff = data.prefs?.payoff_category_id || null;
  const byCat = {}, perMonth = [];
  let income = 0, spent = 0, onBudget = 0;
  for (const m of months) {
    const v = monthView(data, m);
    let s = 0;
    for (const g of v.groups) for (const r of g.rows) { const x = -Math.min(0, r.activity); s += x; byCat[r.id] = (byCat[r.id] || { c: r, spent: 0 }); byCat[r.id].spent += x; }
    const inc = v.income_total - startingIn(data, m);   // starting balances aren't income
    income += inc; spent += s;
    const used = v.groups.some(g => g.rows.some(r => r.assigned || r.activity));
    if (used && m < now && !v.groups.some(g => g.rows.some(r => r.available < 0 && r.id !== payoff))) onBudget++;
    perMonth.push({ m, income: inc, spent: s, kept: inc - s, used: used || inc > 0 });
  }
  const active = perMonth.filter(p => p.used);
  const best = active.length ? active.reduce((a, b) => (b.kept > a.kept ? b : a)) : null;
  const top = Object.values(byCat).filter(x => x.spent > 0).sort((a, b) => b.spent - a.spent).slice(0, 5);
  const buys = data.txs.filter(t => t.date.slice(0, 4) === String(year) && t.amount < 0 && t.category_id && !t.transfer_id);
  const biggest = buys.reduce((m, t) => (!m || t.amount < m.amount ? t : m), null);
  const visits = {}; for (const t of buys) if (t.payee) visits[t.payee] = (visits[t.payee] || 0) + 1;
  const regular = Object.entries(visits).sort((a, b) => b[1] - a[1])[0];
  const days = new Set(buys.map(t => t.date));
  const first = active[0]?.m;
  const daysCounted = first ? Math.round((Math.min(Date.now(), new Date(`${Number(year) + 1}-01-01`)) - new Date(first + '-01')) / 864e5) : 0;
  // Net worth and debt: end of last year (or first month) → end of this year (or now).
  const nw = netWorthSeries(data, 24);
  const endM = months[months.length - 1];
  const startM = addMonths(`${year}-01`, -1);
  const a = nw.find(p => p.month === startM) || nw.find(p => p.month === first), b = nw.find(p => p.month === endM);
  const starts = data.txs.filter(t => t.date.slice(0, 4) === String(year) && t.payee === 'Starting balance');
  const isDebt = Object.fromEntries(data.accounts.map(x => [x.id, x.type === 'credit' || x.type === 'loan']));
  const nwChange = a && b ? b.net - a.net - starts.reduce((s, t) => s + t.amount, 0) : null;
  const debtDown = a && b ? b.debt - a.debt - starts.filter(t => isDebt[t.account_id]).reduce((s, t) => s + t.amount, 0) : null;
  const got = earned(data);
  const badges = BADGES.filter(x => (got[x.id] || '').startsWith(String(year)));
  return { months: perMonth, income, spent, kept: income - spent, best, top, biggest, regular, noSpend: Math.max(0, daysCounted - days.size), onBudget, nwChange, debtDown, badges, count: buys.length, soFar: endM === now };
}

export function YearRecap({ data, year: y0 }) {
  const year = /^\d{4}$/.test(y0 || '') ? Number(y0) : Number(ym().slice(0, 4));
  const s = yearStats(data, year);
  const title = `Your ${year}`;
  const save = () => (isNative ? callNative('print', { title }) : window.print());
  const rate = s.income ? Math.round((s.kept / s.income) * 100) : 0;
  const maxBar = Math.max(1, ...s.months.map(p => Math.max(p.income, p.spent)));
  const maxCat = s.top[0]?.spent || 1;
  const facts = [
    s.best && s.best.kept > 0 && ['📈', 'Best month', monthLabel(s.best.m).split(' ')[0], `kept ${fmt(s.best.kept)}`],
    s.biggest && ['🧾', 'Biggest purchase', `${fmt(-s.biggest.amount)} at ${s.biggest.payee || 'somewhere'}`, new Date(s.biggest.date + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })],
    s.regular && s.regular[1] > 2 && ['📍', 'Your regular', s.regular[0], `${s.regular[1]} visits`],
    ['🌿', 'No-spend days', String(s.noSpend), ''],
    s.onBudget > 0 && ['🛡️', 'Months on budget', String(s.onBudget), 'nothing overspent'],
    s.debtDown !== null && s.debtDown > 0 && ['⛰️', 'Debt paid down', fmt(s.debtDown), ''],
    s.badges.length > 0 && ['🏅', 'Badges earned', s.badges.map(b => b.icon).join(' '), `${s.badges.length} this year`],
  ].filter(Boolean);

  return (
    <div class="report recap">
      <div class="report-bar no-print">
        <button class="ghost" onClick={() => history.back()} aria-label="Back">✕</button>
        <div class="row" style="gap:2px">
          <button class="ghost" onClick={() => nav('#/recap?year=' + (year - 1))} aria-label="Previous year">‹</button>
          <b class="nowrap">{year}</b>
          <button class="ghost" disabled={year >= Number(ym().slice(0, 4))} onClick={() => nav('#/recap?year=' + (year + 1))} aria-label="Next year">›</button>
        </div>
        <button class="primary" onClick={save}>Save as PDF</button>
      </div>
      <div class="report-page recap-page">
        <div class="rhero year">
          <span class="eyebrow">Your {year}{s.soFar ? ' so far' : ''}</span>
          {s.income || s.spent ? (s.kept >= 0
            ? <h1>You kept <span class="money">{fmt(s.kept)}</span>{s.income ? <>, {rate}% of everything that came in</> : ''}</h1>
            : <h1>You spent <span class="money">{fmt(-s.kept)}</span> more than came in</h1>)
            : <h1>Nothing recorded for {year} yet</h1>}
          {s.count > 0 && <p>{s.count} purchases across {s.months.filter(p => p.used).length} months.</p>}
        </div>
        <div class="rtiles">
          <div class="rtile in"><span>Came in</span><b class="money">{fmt(s.income)}</b></div>
          <div class="rtile out"><span>Went out</span><b class="money">{fmt(s.spent)}</b></div>
          {s.nwChange !== null && <div class={'rtile ' + (s.nwChange >= 0 ? 'in' : 'out')}><span>Net worth</span><b class="money">{s.nwChange >= 0 ? '+' : '−'}{fmt(Math.abs(s.nwChange))}</b></div>}
        </div>
        <h2>Month by month</h2>
        <div class="ybars">
          {s.months.map(p => (
            <div class="ybar" title={`${monthLabel(p.m)}: in ${fmt(p.income)}, out ${fmt(p.spent)}`}>
              <div class="bars"><i class="in" style={`height:${Math.round((p.income / maxBar) * 100)}%`} /><i class="out" style={`height:${Math.round((p.spent / maxBar) * 100)}%`} /></div>
              <span>{monthLabel(p.m).slice(0, 3)}</span>
            </div>
          ))}
        </div>
        <span class="head ylegend"><i class="in" /> in <i class="out" /> out</span>
        {s.top.length > 0 && <>
          <h2>Where it went</h2>
          {s.top.map(x => (
            <div class="rbar">
              <div class="row between"><span>{catIcon(data, x.c) ? catIcon(data, x.c) + ' ' : ''}{x.c.name}</span><b class="money">{fmt(x.spent)}</b></div>
              <div class="bar"><i style={`width:${Math.round((x.spent / maxCat) * 100)}%`} /></div>
            </div>
          ))}
        </>}
        {facts.length > 0 && <>
          <h2>Highlights</h2>
          <div class="rfacts">{facts.map(([icon, label, value, note]) => (
            <div class="rfact"><span class="ico">{icon}</span><span class="col"><span class="lbl">{label}</span><b class={/\$/.test(value) ? 'money' : ''}>{value}</b>{note && <span class="note">{note}</span>}</span></div>
          ))}</div>
        </>}
        <p class="muted rfoot">Made with Once Budget by RightToOwn · {new Date().toLocaleDateString()}</p>
      </div>
    </div>
  );
}
