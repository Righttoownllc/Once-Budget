// Personality: small celebrations and nudges when money moves. Everything here is decoration;
// it never changes data, and all motion is skipped when the device asks for reduced motion.
import { monthView, ym, balances, fmt, goalNeed } from './budget.js';
import { ageOfMoney } from './features.js';
import { haptic } from './platform.js';

export const calm = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

/** A short burst of confetti from the top of the screen. */
export function confetti(n = 70) {
  if (calm() || typeof document === 'undefined') return;
  const box = document.createElement('div');
  box.className = 'confetti';
  const colors = ['#4ade80', '#fbbf24', '#60a5fa', '#f472b6', '#a78bfa', '#2dd4bf'];
  for (let i = 0; i < n; i++) {
    const p = document.createElement('i');
    const dx = (Math.random() - 0.5) * 240;
    p.style.cssText = `left:${Math.random() * 100}%;background:${colors[i % colors.length]};--dx:${dx}px;--r:${(Math.random() * 900 - 450) | 0}deg;animation-delay:${(Math.random() * 250) | 0}ms;animation-duration:${1100 + ((Math.random() * 700) | 0)}ms;${Math.random() < 0.3 ? 'border-radius:50%;width:7px;height:7px;' : ''}`;
    box.appendChild(p);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 2400);
}

/** Briefly shake an element (e.g. a category that just went red). Web Animations, so a redraw can't cancel it. */
export function shake(el) {
  if (!el || calm() || !el.animate) return;
  el.animate([{ transform: 'none' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(-2px)' }, { transform: 'none' }], { duration: 600, easing: 'ease-in-out' });
  el.animate([{ boxShadow: 'inset 3px 0 0 var(--neg)', background: 'var(--neg-bg)' }, { boxShadow: 'inset 3px 0 0 transparent', background: 'transparent' }], { duration: 1400, easing: 'ease-out' });
}

/** Pop an element (a check being cleared). */
export function pop(el) {
  if (!el) return;
  haptic('success');
  if (calm() || !el.animate) return;
  el.animate([{ transform: 'scale(.6)' }, { transform: 'scale(1.3)', boxShadow: '0 0 0 6px rgba(74,222,128,.35)' }, { transform: 'scale(1)', boxShadow: '0 0 0 0 rgba(74,222,128,0)' }], { duration: 450, easing: 'cubic-bezier(.2,1.6,.4,1)' });
}

// ---- milestones ------------------------------------------------------------------------------
// Compares what the budget looks like now with a moment ago and celebrates wins: every dollar
// assigned, a card paid off, a goal reached, age of money passing 30 days. The first look after
// the app opens only records the starting point, so nothing fires just for opening the app.
function snapshot(data) {
  const v = monthView(data, ym());
  const cats = {};
  for (const g of v.groups) for (const c of g.rows) cats[c.id] = { name: c.name, available: c.available, target: c.target || 0, income: !!g.is_income, goal: c.goal_type === 'by_date', need: c.target ? goalNeed(c, ym()) : 0 };
  const cards = {};
  for (const a of balances(data.accounts.filter(a => !a.closed && !a.deleted && (a.type === 'credit' || a.type === 'loan')), data.txs)) cards[a.id] = { name: a.name, balance: a.balance };
  let aom = null; try { aom = ageOfMoney(data)?.days ?? null; } catch {}
  return { rta: v.ready_to_assign, cats, cards, aom };
}

let prev = null;
export function watchMilestones(data, toast) {
  if (!data) return;
  const now = snapshot(data);
  const was = prev; prev = now;
  if (!was) return;
  const wins = [];
  if (was.rta !== 0 && now.rta === 0) wins.push({ msg: '🎉 Every dollar has a job', big: true });
  for (const [id, c] of Object.entries(now.cards)) {
    const b = was.cards[id];
    if (b && b.balance < 0 && c.balance === 0) wins.push({ msg: `💳 ${c.name} is paid off! ${fmt(-b.balance)} cleared`, big: true });
  }
  for (const [id, c] of Object.entries(now.cats)) {
    const b = was.cats[id]; if (!b || c.income) continue;
    if (c.target > 0 && (c.goal ? b.available < c.target && c.available >= c.target : b.need > 0 && c.need === 0)) wins.push(c.goal ? { msg: `🐷 Goal reached: ${c.name} has its full ${fmt(c.target)}!`, big: true } : { msg: `🎯 ${c.name} reached its target of ${fmt(c.target)}` });
    if (b.available >= 0 && c.available < 0) {
      haptic('warn');
      setTimeout(() => shake(document.getElementById('cat-' + id)), 60);
    }
  }
  if (was.aom !== null && now.aom !== null && was.aom < 30 && now.aom >= 30) wins.push({ msg: `⏳ Your money is now ${now.aom} days old — you're living on last month's income`, big: true });
  if (!wins.length) return;
  const w = wins.find(x => x.big) || wins[0];
  if (w.big) confetti();
  haptic('success');
  toast(wins.length > 1 ? `${w.msg} (+${wins.length - 1} more)` : w.msg, { plain: true, win: true });
}
/** Forget the starting point (another budget opened). */
export const resetMilestones = () => { prev = null; };
