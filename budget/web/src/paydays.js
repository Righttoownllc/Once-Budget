// When you get paid: a synced setting (household pref 'pay:schedule', a JSON list), with no amount,
// because paychecks change. The payday forecast uses it to know how long money has to last.
// Each schedule: { id, name, freq: 'weekly'|'biweekly'|'semimonthly'|'monthly',
//   start: 'YYYY-MM-DD' (one payday, past or upcoming; weekly, every 2 weeks and monthly),
//   days: [a, b] (twice a month; 31 = the last day), weekend: 'before'|'after'|'same' }
import { setPref } from './store.js';

export const PAY_KEY = 'pay:schedule';
export const FREQS = [['weekly', 'Weekly'], ['biweekly', 'Every 2 weeks'], ['semimonthly', 'Twice a month'], ['monthly', 'Monthly']];
export const WEEKEND = [['before', 'Friday before'], ['after', 'Monday after'], ['same', 'Same day']];

const DAY = 864e5;
const toD = iso => new Date(iso + 'T00:00:00Z');
const toIso = d => d.toISOString().slice(0, 10);
const plus = (iso, n) => toIso(new Date(toD(iso).getTime() + n * DAY));
const lastDay = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const ymd = (y, m, d) => toIso(new Date(Date.UTC(y, m, Math.min(d, lastDay(y, m)))));

export function paySchedules(data) {
  try { const l = JSON.parse(data.prefs?.[PAY_KEY] || '[]'); return Array.isArray(l) ? l.filter(valid) : []; } catch { return []; }
}
const valid = s => s && FREQS.some(f => f[0] === s.freq) && (s.freq === 'semimonthly' ? Array.isArray(s.days) && s.days.length === 2 : /^\d{4}-\d\d-\d\d$/.test(s.start || ''));

export const savePaySchedules = list => setPref(PAY_KEY, JSON.stringify(list));

/** A payday that lands on a weekend moves to the Friday before or Monday after (or stays). */
function shift(iso, weekend) {
  const wd = toD(iso).getUTCDay();
  if (weekend === 'same' || (wd !== 0 && wd !== 6)) return iso;
  if (weekend === 'after') return plus(iso, wd === 6 ? 2 : 1);
  return plus(iso, wd === 6 ? -1 : -2);
}

/** The paydays of one schedule from `from` to `to` (inclusive), after the weekend rule. */
export function payDates(s, from, to) {
  const raw = [], lo = plus(from, -3), hi = plus(to, 3);
  if (s.freq === 'weekly' || s.freq === 'biweekly') {
    const step = s.freq === 'weekly' ? 7 : 14;
    const diff = Math.round((toD(lo) - toD(s.start)) / DAY);
    let cur = diff > 0 ? plus(s.start, Math.ceil(diff / step) * step) : s.start;
    for (let n = 0; cur <= hi && n < 400; n++, cur = plus(cur, step)) raw.push(cur);
  } else {
    const d0 = toD(lo); let y = d0.getUTCFullYear(), m = d0.getUTCMonth();
    const days = s.freq === 'monthly' ? [toD(s.start).getUTCDate()] : [...s.days].map(Number).sort((a, b) => a - b);
    for (let n = 0; n < 40; n++) {
      for (const d of days) raw.push(ymd(y, m, d));
      if (ymd(y, m, 1) > hi) break;
      if (++m > 11) { m = 0; y++; }
    }
  }
  const startAt = s.freq === 'semimonthly' ? '' : s.start;
  return [...new Set(raw.filter(r => r >= startAt).map(r => shift(r, s.weekend)))].filter(d => d >= from && d <= to).sort();
}

/** Every payday of every schedule in [from, to], soonest first: [{ date, label }]. */
export function paydaysBetween(data, from, to) {
  const out = {};
  for (const s of paySchedules(data)) for (const d of payDates(s, from, to)) (out[d] ||= []).push(s.name || '');
  return Object.entries(out).sort(([a], [b]) => a.localeCompare(b)).map(([date, names]) => ({ date, label: names.filter(Boolean).join(' & ') }));
}

const short = iso => toD(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const nth = d => (Number(d) >= 31 ? 'last day' : `${d}${['th', 'st', 'nd', 'rd'][(d % 100 > 10 && d % 100 < 14) || d % 10 > 3 ? 0 : d % 10]}`);

/** "Every 2 weeks" / "Twice a month: 15th and last day" / "Monthly: 1st". */
export function describe(s) {
  if (s.freq === 'semimonthly') return `Twice a month: ${[...s.days].map(Number).sort((a, b) => a - b).map(nth).join(' and ')}`;
  if (s.freq === 'monthly') return `Monthly: ${nth(toD(s.start).getUTCDate())}`;
  if (s.freq === 'weekly') return `Weekly on ${toD(s.start).toLocaleDateString(undefined, { weekday: 'long', timeZone: 'UTC' })}s`;
  return `Every 2 weeks on ${toD(s.start).toLocaleDateString(undefined, { weekday: 'long', timeZone: 'UTC' })}s`;
}
export { short as payShort };
