import { useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { useModal, useUI } from '../main.jsx';
import { fmt, parseMoney, dayLabel } from '../budget.js';
import { tipWaiting, tipPosted, tipPostedAs } from '../tips.js';

/**
 * Marking a transaction with a waiting tip as cleared: did the bank post the full amount?
 * Yes clears it; a different amount updates it (and its category) and clears it; Not yet leaves it.
 */
export function TipClear({ tx, onClose }) {
  useModal(onClose);
  const ui = useUI();
  const [other, setOther] = useState(false);
  const [text, setText] = useState('');
  const total = Math.abs(tx.amount), tip = tipWaiting(tx);
  const yes = async () => { await tipPosted(tx); ui.toast(`Cleared ${fmt(total)} at ${tx.payee || 'this purchase'}`, { plain: true }); onClose(); };
  const save = async () => {
    const c = Math.abs(parseMoney(text)); if (!c) return;
    await tipPostedAs(tx, c);
    ui.toast(c === total ? `Cleared ${fmt(c)}` : `Updated to ${fmt(c)} (was ${fmt(total)}) and cleared`, { plain: true });
    onClose();
  };
  return createPortal((
    <div class="scrim">
      <div class="sheet tipclear" role="dialog" aria-modal="true" aria-label="Did the bank post the tip?">
        <div class="handle" />
        <b style="font-size:18px">Did the bank post {fmt(total)}?</b>
        <span class="head">{tx.payee || 'This purchase'} · {dayLabel(tx.date)}. You recorded {fmt(total - tip)} plus a {fmt(tip)} tip. Check the amount your bank shows now.</span>
        {!other ? (
          <>
            <button class="primary" onClick={yes}>Yes, it shows {fmt(total)}</button>
            <button onClick={() => { setOther(true); setText(''); }}>It shows a different amount</button>
            <button class="ghost" onClick={onClose}>Not yet</button>
          </>
        ) : (
          <>
            <label class="field"><span class="lbl">Amount your bank shows</span>
              <input inputMode="decimal" autofocus placeholder={(total / 100).toFixed(2)} value={text} onInput={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') save(); }} />
            </label>
            <span class="head">The purchase changes to this amount, and its category follows.</span>
            <button class="primary" disabled={!parseMoney(text)} onClick={save}>Save and clear</button>
            <button class="ghost" onClick={() => setOther(false)}>Back</button>
          </>
        )}
      </div>
    </div>
  ), document.body);
}
