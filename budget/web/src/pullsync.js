// Pull down at the top of Budget or Accounts to sync now. A small pill follows the finger and
// says "Release to sync"; offline budgets just say so. Touch only; never fires inside a sheet.
import { sync, syncState } from './store.js';
import { isLocal, haptic } from './platform.js';

const LIMIT = 70;   // px of pull that counts
export function initPullSync(toast) {
  if (typeof document === 'undefined') return;
  const pill = document.createElement('div');
  pill.className = 'pullsync';
  document.body.appendChild(pill);
  let y0 = null, dy = 0, armed = false;
  const route = () => (location.hash.split('/')[1] || 'budget').split('?')[0];
  const at = () => (document.scrollingElement?.scrollTop || 0) + (document.body.scrollTop || 0);
  const reset = () => { y0 = null; dy = 0; armed = false; pill.style.transform = ''; pill.classList.remove('on', 'ready'); };
  document.addEventListener('touchstart', e => {
    if (e.touches.length !== 1 || at() > 0 || document.body.classList.contains('modal-open') || !['budget', 'accounts', ''].includes(route())) return;
    y0 = e.touches[0].clientY;
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    if (y0 === null) return;
    dy = e.touches[0].clientY - y0;
    if (dy <= 0 || at() > 0) { reset(); return; }
    const d = Math.min(dy, LIMIT * 1.6);
    pill.classList.add('on');
    pill.style.transform = `translate(-50%, ${d * 0.6}px)`;
    const ready = dy > LIMIT;
    if (ready !== armed) { armed = ready; pill.classList.toggle('ready', ready); if (ready) haptic('tap'); }
    pill.textContent = isLocal() ? 'This budget is offline' : ready ? '↻ Release to sync' : '↓ Pull to sync';
  }, { passive: true });
  document.addEventListener('touchend', async () => {
    if (y0 === null) return;
    const go = armed && !isLocal();
    reset();
    if (!go) return;
    pill.textContent = '↻ Syncing…'; pill.classList.add('on', 'busy');
    try { await sync(); } catch {}
    pill.classList.remove('on', 'busy');
    toast(syncState.lastError ? 'Sync: ' + syncState.lastError : 'Synced ✓', { plain: true });
  });
}
