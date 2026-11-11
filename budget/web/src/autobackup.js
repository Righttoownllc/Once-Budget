// Automatic backups on the phone (bridge v11): one JSON per budget per day it's used, newest 14
// kept by the app (and in a chosen folder, if any). Written when the app opens and when it goes to
// the background, only if something changed since the last one.
import { isNative, BRIDGE_VERSION, callNative, budgetId, isLocal } from './platform.js';
import { db, TABLES, putMany, beginBatch, endBatch } from './store.js';
import { today } from './budget.js';

export const hasAutoBackup = () => isNative && BRIDGE_VERSION >= 11;
const KEY = () => 'budget.autoBackup.' + budgetId();
// On by default for offline budgets. A budget synced with a server is backed up by the server, so
// copies on the phone are optional there (off unless switched on).
const ON_KEY = () => 'budget.autoBackupOn.' + budgetId();
export const autoBackupOn = () => { try { const v = localStorage.getItem(ON_KEY()); return v === null ? isLocal() : v === '1'; } catch { return isLocal(); } };
export const setAutoBackupOn = on => { try { localStorage.setItem(ON_KEY(), on ? '1' : '0'); } catch {} };
export const lastAutoBackup = () => { try { return JSON.parse(localStorage.getItem(KEY()) || 'null'); } catch { return null; } };

/** Same shape as Export JSON, so a backup imports anywhere. */
async function snapshot() {
  const out = { version: 1, exported_at: Date.now(), data: {} };
  let sig = 0, n = 0;
  for (const t of TABLES) {
    const rows = await db[t].toArray();
    for (const r of rows) { n++; if ((r.updated_at || 0) > sig) sig = r.updated_at || 0; }
    out.data[t] = rows.filter(r => !r.deleted);
  }
  return { out, sig: `${n}:${sig}` };
}

let running = false;
/** force: Back up now (ignores "nothing changed"). Returns the native result, or null if skipped. */
export async function autoBackup(force = false) {
  if (!hasAutoBackup() || running || (!force && !autoBackupOn())) return null;
  running = true;
  try {
    const { out, sig } = await snapshot();
    const last = lastAutoBackup(), date = today();
    if (!force && last && last.sig === sig) return null;   // nothing new since the last backup
    if (!out.data.accounts.length && !out.data.transactions.length && !force) return null;   // empty budget
    const r = await callNative('backup.auto', { budget: budgetId(), date, text: JSON.stringify(out) });
    try { localStorage.setItem(KEY(), JSON.stringify({ sig, date, at: Date.now(), folderError: r.folderError || null })); } catch {}
    return r;
  } catch { return null; }
  finally { running = false; }
}
if (typeof document !== 'undefined' && hasAutoBackup()) {
  document.addEventListener('visibilitychange', () => { if (document.hidden) autoBackup(); });
  setTimeout(() => autoBackup(), 8000);   // once the budget has settled after opening
}

export const listAutoBackups = () => callNative('backup.autoList', { budget: budgetId() }).then(r => r.list);
export const backupFolder = () => callNative('backup.folder');
export const pickBackupFolder = () => callNative('backup.pickFolder');
export const clearBackupFolder = () => callNative('backup.clearFolder');

/**
 * Puts this budget back exactly as it was in a backup: rows in the backup are written, rows made
 * since are removed. One batch, so Undo (or History) reverses the whole restore.
 */
export async function restoreAutoBackup(date) {
  const { text } = await callNative('backup.autoRead', { budget: budgetId(), date });
  const json = JSON.parse(text);
  let n = 0;
  beginBatch(`Restore backup from ${date}`);
  try {
    for (const t of TABLES) {   // one bulk write per table (hundreds of single writes take seconds)
      const rows = json.data?.[t] || [], keep = new Set(rows.map(r => r.id));
      const gone = (await db[t].toArray()).filter(r => !r.deleted && !keep.has(r.id)).map(r => ({ ...r, deleted: 1 }));
      const all = gone.concat(rows.map(r => ({ ...r, deleted: 0 })));
      if (all.length) await putMany(t, all, `Restore backup from ${date}`);
      n += rows.length;
    }
  } finally { endBatch(); }
  return n;
}
