import { useState } from 'preact/hooks';
import { setPref, put } from '../store.js';
import { ICONS, catIcon, suggestIcon, Icon } from '../icons.jsx';

export { Icon };

/** Category panel: the category's name (saved on Enter or leaving the box; Undo puts it back). */
export function NameField({ data, c, ui }) {
  const [v, setV] = useState(null);
  const save = async () => {
    const n = (v ?? '').trim();
    setV(null);
    if (!n || n === c.name) return;
    if (data.categories.some(x => x.id !== c.id && !x.deleted && x.group_id === c.group_id && x.name.toLowerCase() === n.toLowerCase())) { ui.toast(`There's already a ${n} in this group`, { plain: true }); return; }
    const row = data.categories.find(x => x.id === c.id);
    await put('categories', { ...row, name: n });
    ui.toast(`Renamed to ${n}`);
  };
  return (
    <label class="head namefield">Name
      <input value={v ?? c.name} onInput={e => setV(e.target.value)} onBlur={save} onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { setV(null); e.target.blur(); } }} />
    </label>
  );
}

/** Category panel: tap the icon to choose another, or none. */
export function IconField({ data, c }) {
  const [open, setOpen] = useState(false);
  const cur = catIcon(data, c);
  const pick = v => { setPref('icon:' + c.id, v); setOpen(false); };
  return (
    <div class="iconfield">
      <span class="head">Icon</span>
      <button type="button" class="iconnow" onClick={() => setOpen(o => !o)} aria-expanded={open}>{cur || '—'}<span class="head">{open ? 'Close' : 'Change'}</span></button>
      {open && (
        <div class="icongrid">
          <button type="button" class={!cur ? 'on' : ''} onClick={() => pick('-')} title="No icon">∅</button>
          {suggestIcon(c.name) && <button type="button" onClick={() => pick('')} title="Suggested">↺</button>}
          {ICONS.map(i => <button type="button" class={cur === i ? 'on' : ''} onClick={() => pick(i)}>{i}</button>)}
        </div>
      )}
    </div>
  );
}
