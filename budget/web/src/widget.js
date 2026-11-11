// Home-screen widget (Android, bridge v10). The widget can't read the budget itself, so the open
// budget sends it a small snapshot whenever the numbers change. It stays on the phone.
import { isNative, BRIDGE_VERSION, callNative, budgetId, moneyHidden } from './platform.js';
import { monthView, ym, monthLabel, fmt } from './budget.js';
import { cashForecast } from './features.js';

export function widgetSnapshot(data) {
  const v = monthView(data, ym());
  const rows = v.groups.flatMap(g => g.rows).filter(r => !r.hidden && (r.assigned || r.activity || r.available));
  const lowest = [...rows].sort((a, b) => a.available - b.available).slice(0, 3);
  const bad = cashForecast(data, 35).find(f => f.short);
  const short = iso => new Date(iso + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return {
    budget: budgetId(),
    month: monthLabel(ym()).split(' ')[0],
    rta: fmt(v.ready_to_assign), rtaNeg: v.ready_to_assign < 0,
    cats: lowest.map(r => ({ n: r.name, v: fmt(r.available), neg: r.available < 0 })),
    // Plain words only (no amount), so it can show even with balances hidden.
    warn: bad ? `${bad.a.name} dips below zero ${short(bad.short.date)}` : '',
    hidden: moneyHidden(),
    at: Date.now(),
  };
}

let timer = 0, last = '', lastData = null;
export function sendWidget(data = lastData) {
  if (!isNative || BRIDGE_VERSION < 10 || !data) return;
  lastData = data;
  clearTimeout(timer);
  timer = setTimeout(() => {
    const s = widgetSnapshot(data), key = JSON.stringify({ ...s, at: 0 });
    if (key !== last) callNative('widget.update', s).then(() => { last = key; }).catch(() => {});
  }, 1200);
}
if (typeof window !== 'undefined') addEventListener('budget:privacy', () => sendWidget());
