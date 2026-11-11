import { useMemo, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { useModal } from '../main.jsx';
import { monthView, ym, fmt } from '../budget.js';
import { Icon, catIcon } from '../icons.jsx';

/**
 * Category field: shows the chosen category; tapping opens CatPicker, a full-height grid of
 * category tiles grouped like the budget, each with what's left. `income` limits to income
 * categories, `spending` excludes them; omit both for all. `suggest`: category ids shown first.
 */
export function CatInput({ data, value, onChange, placeholder = 'Category…', income, spending, noneLabel = '—', small, suggest, month }) {
  const [open, setOpen] = useState(false);
  const current = data.categories.find(c => c.id === value);
  return (
    <>
      <button type="button" class={'catbtn' + (small ? ' small' : '') + (current ? '' : ' empty')} onClick={() => setOpen(true)}>
        <span>{current && catIcon(data, current) ? catIcon(data, current) + ' ' : ''}{current ? current.name : placeholder}</span><span class="chev" aria-hidden="true">▾</span>
      </button>
      {open && <CatPicker data={data} value={value} income={income} spending={spending} noneLabel={noneLabel} suggest={suggest} month={month}
        onPick={id => { onChange(id); setOpen(false); }} onClose={() => setOpen(false)} />}
    </>
  );
}

/** The tile sheet. Rendered on <body> so it sits above whatever sheet opened it. */
export function CatPicker({ data, value, onPick, onClose, income, spending, noneLabel = '—', suggest = [], month, title }) {
  useModal(onClose);
  const [q, setQ] = useState('');
  const gmap = Object.fromEntries(data.groups.map(g => [g.id, g]));
  const v = useMemo(() => monthView(data, month || ym()), [data, month]);
  const left = useMemo(() => Object.fromEntries(v.groups.flatMap(g => g.rows).map(r => [r.id, r.available])), [v]);
  const groups = useMemo(() => [...data.groups]
    .filter(g => (income ? g.is_income : spending ? !g.is_income : true))
    .sort((a, b) => (a.is_income ? 1 : 0) - (b.is_income ? 1 : 0) || a.sort - b.sort || a.name.localeCompare(b.name))
    .map(g => ({ ...g, cats: data.categories.filter(c => c.group_id === g.id && (!c.hidden || c.id === value)).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name)) }))
    .filter(g => g.cats.length), [data.groups, data.categories, income, spending, value]);
  const ok = id => { const c = data.categories.find(x => x.id === id); return c && groups.some(g => g.id === c.group_id); };
  const sug = [...new Set(suggest.filter(Boolean))].filter(ok).slice(0, 6).map(id => data.categories.find(c => c.id === id));
  const needle = q.trim().toLowerCase();
  const shown = needle ? groups.map(g => ({ ...g, cats: g.cats.filter(c => (c.name + ' ' + g.name).toLowerCase().includes(needle)) })).filter(g => g.cats.length) : groups;

  const Tile = ({ c }) => {
    const a = left[c.id], isInc = gmap[c.group_id]?.is_income;
    const tone = isInc || a === undefined ? '' : a < 0 ? ' neg' : a === 0 ? ' zero' : ' pos';
    return (
      <button type="button" class={'ctile' + tone + (c.id === value ? ' on' : '')} onClick={() => onPick(c.id)}>
        <span class="nm"><Icon data={data} c={c} />{c.name}</span>
        {!isInc && a !== undefined && <span class="money amt">{fmt(a)}</span>}
      </button>
    );
  };
  return createPortal(
    <div class="scrim">
      <div class="sheet catsheet" role="dialog" aria-modal="true" aria-label="Choose a category">
        <div class="handle" />
        <div class="row between"><b>{title || (income ? 'Income category' : 'Choose a category')}</b><button class="ghost" onClick={onClose}>Close</button></div>
        <input type="search" class="catsearch" placeholder="Search categories" value={q} onInput={e => setQ(e.target.value)} />
        <div class="catscroll">
          {!needle && <div class="ctiles"><button type="button" class={'ctile none' + (!value ? ' on' : '')} onClick={() => onPick(null)}><span class="nm">{noneLabel}</span></button></div>}
          {!needle && sug.length > 0 && <><span class="eyebrow">Suggested</span><div class="ctiles">{sug.map(c => <Tile c={c} />)}</div></>}
          {shown.map(g => <><span class="eyebrow">{g.name}</span><div class="ctiles">{g.cats.map(c => <Tile c={c} />)}</div></>)}
          {needle && !shown.length && <span class="head" style="padding:12px 4px">No category matches "{q}".</span>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
