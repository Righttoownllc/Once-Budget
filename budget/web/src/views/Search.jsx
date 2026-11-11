import { useUI } from '../main.jsx';
import { Empty } from './Empty.jsx';
import { fmt, parseMoney, dayLabel, newestFirst } from '../budget.js';

/** Live transaction search used on the Budget tab, Accounts tab and inside an account. */
export function SearchResults({ data, q, account_id }) {
  const ui = useUI();
  const s = q.trim().toLowerCase();
  const cents = parseMoney(s);
  const catName = Object.fromEntries(data.categories.map(c => [c.id, c.name]));
  const acctName = Object.fromEntries(data.accounts.map(a => [a.id, a.name]));
  const hits = data.txs.filter(t => (!account_id || t.account_id === account_id) &&
    (t.payee || '').toLowerCase().includes(s) || (t.memo || '').toLowerCase().includes(s) ||
    (catName[t.category_id] || '').toLowerCase().includes(s) || (cents && Math.abs(t.amount) === Math.abs(cents)))
    .sort(newestFirst).slice(0, 100);
  const total = hits.reduce((x, t) => x + t.amount, 0);
  return (
    <div class="card">
      {!hits.length && <Empty icon="🔍" title="No matches" hint="Try part of a payee, a memo or an amount like 12.50." small />}
      <div class="row between"><span class="eyebrow">{hits.length} result{hits.length === 1 ? '' : 's'}</span><span class="eyebrow money">{fmt(total)}</span></div>
      <div>
        {hits.map(t => (
          <div class="txrow" key={t.id}>
            <div class="main" onClick={() => ui.open({ tx: t })}>
              <div class="p">{t.payee || '(no payee)'}</div>
              <div class="s">{dayLabel(t.date)} · {acctName[t.account_id]}{t.category_id ? ` · ${catName[t.category_id]}` : ''}{t.memo ? ` · ${t.memo}` : ''}</div>
            </div>
            <span class={'money ' + (t.amount > 0 ? 'pos' : '')} style="font-weight:600">{fmt(t.amount)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
