import { createPortal } from 'preact/compat';
import { useState } from 'preact/hooks';
import { useModal } from '../main.jsx';

/**
 * An in-app replacement for <select>: Android draws a <select>'s list as a system popup that ignores
 * the app's theme, so this opens the choices in one of the app's own sheets instead.
 * options: [{ value, label, sub? }]; title: the sheet's heading (and the button's label for readers).
 */
export function Pick({ value, options, onChange, title, disabled }) {
  const [open, setOpen] = useState(false);
  const cur = options.find(o => o.value === value);
  return (
    <>
      <button type="button" class="pickbtn" disabled={disabled} aria-haspopup="dialog" aria-label={`${title}: ${cur?.label || 'none'}`} onClick={() => setOpen(true)}>
        <span class="pv">{cur?.label || 'Choose…'}</span><span class="pc" aria-hidden="true">▾</span>
      </button>
      {open && <PickSheet value={value} options={options} title={title} onPick={v => { setOpen(false); if (v !== value) onChange(v); }} onClose={() => setOpen(false)} />}
    </>
  );
}

function PickSheet({ value, options, title, onPick, onClose }) {
  useModal(onClose);
  return createPortal((
    <div class="scrim" onClick={e => e.target === e.currentTarget && onClose()}>
      <div class="sheet picksheet" role="dialog" aria-modal="true" aria-label={title}>
        <div class="handle" />
        <div class="row between"><b>{title}</b><button type="button" class="ghost" onClick={onClose}>Cancel</button></div>
        <div class="picklist" role="listbox" aria-label={title}>
          {options.map(o => (
            <button type="button" role="option" aria-selected={o.value === value} class={'pickopt' + (o.value === value ? ' on' : '')} onClick={() => onPick(o.value)}>
              <span class="col" style="min-width:0"><b>{o.label}</b>{o.sub && <span class="head">{o.sub}</span>}</span>
              {o.value === value && <span class="pk" aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  ), document.body);
}

// Flattens <option> children ({a}: {b}) into their text.
const text = ch => (Array.isArray(ch) ? ch.map(text).join('') : ch == null || ch === false || ch === true ? '' : typeof ch === 'object' ? text(ch.props?.children) : String(ch));
// Every <option> in a <select>'s children (arrays and <optgroup>s included), as Pick options.
function optionsOf(children, group, out = []) {
  for (const ch of [children].flat(Infinity)) {
    if (!ch || typeof ch !== 'object') continue;
    if (ch.type === 'optgroup') optionsOf(ch.props.children, ch.props.label, out);
    else if (ch.type === 'option') { const label = text(ch.props.children); out.push({ value: String(ch.props.value ?? label), label, sub: group, disabled: ch.props.disabled }); }
    else if (ch.props?.children) optionsOf(ch.props.children, group, out);
  }
  return out;
}

/**
 * Drop-in for <select> with <option> children: same value / onChange(e => e.target.value) / name /
 * disabled / aria-label, but the list opens in the app's own sheet (see Pick). With a name, a hidden
 * input carries the value for forms. The sheet's title is the aria-label, or the field's label.
 */
export function Select({ value, onChange, onInput, name, disabled, children, class: cls, className, style, ...rest }) {
  const opts = optionsOf(children);
  const [own, setOwn] = useState(null);   // the choice when nothing controls value
  const cur = value !== undefined && value !== null ? String(value) : own ?? opts[0]?.value;
  const shown = opts.find(o => o.value === cur) || opts[0];
  const [open, setOpen] = useState(null);   // the sheet's title while open
  const pick = v => {
    setOpen(null);
    if (v === cur) return;
    setOwn(v);
    const e = { target: { value: v, name }, currentTarget: { value: v, name } };
    onChange && onChange(e); onInput && onInput(e);
  };
  const titleFor = btn => {
    if (rest['aria-label']) return rest['aria-label'];
    const box = btn.closest('label, .field');
    const t = box ? [...box.childNodes].filter(n => n !== btn && !n.contains?.(btn)).map(n => n.textContent).join(' ').replace(/\s+/g, ' ').trim() : '';
    return t || 'Choose';
  };
  return (
    <>
      <button type="button" {...rest} class={'selectbtn ' + (cls || className || '')} style={style} disabled={disabled} aria-haspopup="dialog"
        onClick={e => setOpen(titleFor(e.currentTarget))}>
        <span class="pv">{shown?.label ?? ''}</span><span class="pc" aria-hidden="true">▾</span>
      </button>
      {name && <input type="hidden" name={name} value={cur ?? ''} />}
      {open && <PickSheet value={cur} options={opts.filter(o => !o.disabled)} title={open} onPick={pick} onClose={() => setOpen(null)} />}
    </>
  );
}
