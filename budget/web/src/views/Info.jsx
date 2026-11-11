import { useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { useModal } from '../main.jsx';
import { HELP } from './help.jsx';

/**
 * A small (i) that opens a pop-up explaining how something works. It's a span with role=button so it
 * can sit inside headings, links and buttons (taps on it don't reach what's behind it).
 */
export function InfoBtn({ title, children, label }) {
  const [open, setOpen] = useState(false);
  const show = e => { e.preventDefault(); e.stopPropagation(); setOpen(true); };
  return (
    <>
      <span role="button" tabIndex={0} class="infobtn" aria-label={label || `How ${title} works`} title={label || `How ${title} works`}
        onClick={show} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') show(e); }}>i</span>
      {open && <InfoSheet title={title} onClose={() => setOpen(false)}>{children}</InfoSheet>}
    </>
  );
}

/** <Help k="rta" />: an (i) with one of the shared explanations in help.jsx. */
export function Help({ k }) {
  const h = HELP[k];
  return h ? <InfoBtn title={h.title}>{h.body}</InfoBtn> : null;
}

function InfoSheet({ title, children, onClose }) {
  useModal(onClose);
  return createPortal((
    <div class="scrim">
      <div class="sheet infosheet fitbody" role="dialog" aria-modal="true" aria-label={title}>
        <div class="handle" />
        <div class="row between"><b>{title}</b><button class="ghost" onClick={onClose}>Close</button></div>
        <div class="infobody grow">{children}</div>
        <button class="primary" onClick={onClose}>Got it</button>
      </div>
    </div>
  ), document.body);
}
