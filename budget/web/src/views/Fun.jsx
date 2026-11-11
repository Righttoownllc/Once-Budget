import { Shell, useUI } from '../main.jsx';
import { cashForecast } from '../features.js';
import { verdict } from './Forecast.jsx';
import { fmt, monthLabel } from '../budget.js';
import { streaks, goals, BADGES, earned, MONTHLY, earnedMonthly, monthlyCounts } from '../achievements.js';
import { catIcon } from '../icons.jsx';
import { Help } from './Info.jsx';

const day = iso => new Date(iso + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const mon = m => new Date(m + '-15').toLocaleDateString(undefined, { month: 'short', year: 'numeric' });

/** Budget screen strip: current streaks (only the ones worth showing). Tap for badges. */
export function StreakStrip({ data }) {
  const s = streaks(data);
  const items = [
    s.logging >= 2 && ['🔥', `${s.logging}-day logging streak`],
    s.onBudget >= 1 && ['🛡️', `${s.onBudget} month${s.onBudget === 1 ? '' : 's'} on budget`],
    s.noSpend >= 1 && ['🌿', `${s.noSpend} no-spend day${s.noSpend === 1 ? '' : 's'}`],
  ].filter(Boolean);
  const n = Object.keys(earned(data)).length;
  if (!items.length && !n) return null;
  return (
    <a class="streaks" href="#/badges">
      {items.map(([i, t]) => <span class="streak"><span aria-hidden="true">{i}</span>{t}</span>)}
      {n > 0 && <span class="streak badgecount">🏅 {n}</span>}
    </a>
  );
}

/** A jar that fills as a save-by-date goal fills. */
function Jar({ pct, done }) {
  const h = Math.round(52 * pct);
  return (
    <svg class={'jar' + (done ? ' done' : '')} viewBox="0 0 44 64" aria-hidden="true">
      <defs><clipPath id="jarclip"><path d="M8 12h28v44a6 6 0 0 1-6 6H14a6 6 0 0 1-6-6z" /></clipPath></defs>
      <rect x="10" y="3" width="24" height="8" rx="3" class="lid" />
      <g clip-path="url(#jarclip)"><rect x="0" y={62 - h} width="44" height={h} class="fill" /></g>
      <path d="M8 12h28v44a6 6 0 0 1-6 6H14a6 6 0 0 1-6-6z" class="glass" />
      {done && <text x="22" y="42" text-anchor="middle" class="tick">✓</text>}
    </svg>
  );
}

/** Budget screen card: save-by-date goals with jars and an on-track note. */
export function GoalJars({ data }) {
  const list = goals(data);
  if (!list.length) return null;
  return (
    <div class="card goals">
      <span class="eyebrow">Savings goals</span>
      <div class="goalgrid">
        {list.map(g => (
          <div class={'goal' + (g.done ? ' done' : g.onTrack ? '' : ' behind')}>
            <Jar pct={g.pct} done={g.done} />
            <div class="col" style="min-width:0;gap:2px">
              <b class="n">{catIcon(data, g.c) ? catIcon(data, g.c) + ' ' : ''}{g.c.name}</b>
              <span class="head"><span class="money">{fmt(g.c.available)}</span> of <span class="money">{fmt(g.c.target)}</span> · {Math.round(g.pct * 100)}%</span>
              <span class="note">{g.done ? '🎉 Reached!' : g.eta === null ? `Nothing assigned lately · due ${mon(g.due)}` : g.onTrack ? `On track · ${mon(g.eta)} (due ${mon(g.due)})` : `Behind · at this pace ${mon(g.eta)}, due ${mon(g.due)}`}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** #/badges: earned badges with dates, the rest with how to earn them, and current streaks. */
export function Badges({ data }) {
  const got = earned(data);
  const s = streaks(data);
  const top = (
    <div class="row">
      <a href="#/budget" class="round" style="display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:22px;background:rgba(255,255,255,.12);color:#fff;text-decoration:none;font-size:22px" aria-label="Back">‹</a>
      <div class="col" style="flex:1;margin-left:12px"><span class="eyebrow">{Object.keys(got).length} of {BADGES.length} earned</span><span class="title">Badges, streaks &amp; goals</span></div>
    </div>
  );
  return (
    <Shell route="badges" top={top}>
      <div class="card">
        <span class="eyebrow">Streaks <Help k="streaks" /></span>
        <div class="streakgrid">
          <div><span class="big">🔥 {s.logging}</span><span class="head">days in a row with something logged</span></div>
          <div><span class="big">🛡️ {s.onBudget}</span><span class="head">months in a row with nothing overspent</span></div>
          <div><span class="big">🌿 {s.noSpend}</span><span class="head">no-spend days this month</span></div>
        </div>
      </div>
      <GoalJars data={data} />
      <MonthlyBadges data={data} />
      <div class="card badgecard">
        <span class="eyebrow">Badges · earn each once</span>
        <div class="badgegrid">
          {BADGES.map(b => (
            <div class={'badge' + (got[b.id] ? ' got' : '')}>
              <span class="bi" aria-hidden="true">{got[b.id] ? b.icon : '🔒'}</span>
              <b>{b.title}</b>
              <span class="head">{got[b.id] ? `Earned ${new Date(got[b.id] + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}` : b.hint}</span>
            </div>
          ))}
        </div>
      </div>
    </Shell>
  );
}
/** This month's badges: each can be earned once a month, and they start over on the 1st. */
function MonthlyBadges({ data }) {
  const got = earnedMonthly(data), times = monthlyCounts(data);
  const name = new Date().toLocaleString(undefined, { month: 'long' });
  return (
    <div class="card badgecard">
      <span class="eyebrow">{name}'s badges · {Object.keys(got).length} of {MONTHLY.length}</span>
      <span class="head">New every month: earn each one once in {name}, then they start over on the 1st.</span>
      <div class="badgegrid">
        {MONTHLY.map(b => (
          <div class={'badge' + (got[b.id] ? ' got' : '')}>
            <span class="bi" aria-hidden="true">{got[b.id] ? b.icon : '🔒'}</span>
            <b>{b.title}</b>
            <span class="head">{got[b.id] ? `Earned ${new Date(got[b.id] + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : b.hint}</span>
            {times[b.id] > 1 && <span class="head">Earned {times[b.id]} months</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
export { monthLabel };

/**
 * Budget screen, compact: one line for Payday check (red when an account will dip below zero) and one
 * row of small chips for streaks, savings goals and badges. Streak and badge chips open Badges; a goal
 * chip says how that goal is doing.
 */
export function Glance({ data }) {
  const ui = useUI();
  const fc = cashForecast(data, 35).filter(f => f.scheduled).map(f => ({ f, v: verdict(f) }));
  const pay = fc.find(x => x.v.bad) || fc[0] || null;
  const bad = fc.filter(x => x.v.bad).length;
  const s = streaks(data);
  const gl = goals(data);
  const n = Object.keys(earned(data)).length;
  const chips = [
    s.logging >= 2 && { i: '🔥', t: s.logging, title: `${s.logging} days in a row with something logged` },
    s.onBudget >= 1 && { i: '🛡️', t: s.onBudget, title: `${s.onBudget} month${s.onBudget === 1 ? '' : 's'} in a row with nothing overspent` },
    s.noSpend >= 1 && { i: '🌿', t: s.noSpend, title: `${s.noSpend} no-spend day${s.noSpend === 1 ? '' : 's'} this month` },
  ].filter(Boolean);
  if (!pay && !chips.length && !gl.length && !n) return null;
  const goalMsg = g => `${catIcon(data, g.c) || '🐷'} ${g.c.name}: ${fmt(g.c.available)} of ${fmt(g.c.target)} · ${g.done ? 'reached 🎉' : g.eta === null ? `nothing assigned lately, due ${mon(g.due)}` : g.onTrack ? `on track for ${mon(g.eta)}` : `behind, at this pace ${mon(g.eta)} (due ${mon(g.due)})`}`;
  return (
    <div class={'card glance' + (bad ? ' bad' : '')}>
      {pay && (
        <a class="glancepay" href="#/forecast">
          <span class="txt">{pay.v.bad
            ? `⚠ ${pay.f.a.name} below zero ${day(pay.f.short.date)}${pay.f.short.label ? ` (${pay.f.short.label})` : ''}${bad > 1 ? ` · +${bad - 1} more` : ''}`
            : `✓ ${pay.f.a.name} OK ${pay.f.payday ? `until payday ${day(pay.f.payday.date)}` : 'for 5 weeks'}`}</span>
          <span class="go">Forecast ›</span>
        </a>
      )}
      {(chips.length > 0 || gl.length > 0 || n > 0) && (
        <div class="glancechips">
          {chips.map(c => <a class="gchip" href="#/badges" title={c.title} aria-label={c.title}><span aria-hidden="true">{c.i}</span>{c.t}</a>)}
          {gl.map(g => (
            <button type="button" class={'gchip goal' + (g.done ? ' done' : g.onTrack ? '' : ' behind')} title={goalMsg(g)} onClick={() => ui.toast(goalMsg(g), { plain: true })}>
              <span aria-hidden="true">{catIcon(data, g.c) || '🐷'}</span>{Math.round(g.pct * 100)}%
            </button>
          ))}
          {n > 0 && <a class="gchip badges" href="#/badges" title={`${n} badges earned`} aria-label={`${n} badges earned`}><span aria-hidden="true">🏅</span>{n}</a>}
        </div>
      )}
    </div>
  );
}
