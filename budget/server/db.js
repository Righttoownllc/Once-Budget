import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, copyFileSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR || join(here, '..', '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });
export const DB_PATH = join(DATA_DIR, 'budget.db');

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));

// Additive migrations: ALTER TABLE is idempotent-guarded by checking columns.
function addCol(tbl, col, def) {
  const have = db.prepare(`PRAGMA table_info(${tbl})`).all().some(c => c.name === col);
  if (!have) db.exec(`ALTER TABLE ${tbl} ADD COLUMN ${col} ${def}`);
}
addCol('categories', 'target', 'INTEGER NOT NULL DEFAULT 0');   // monthly target in cents
addCol('categories', 'note', "TEXT NOT NULL DEFAULT ''");
addCol('category_groups', 'is_income', 'INTEGER NOT NULL DEFAULT 0');  // income categories feed Ready to Assign
addCol('transactions', 'split_id', 'TEXT');                               // parts of one receipt share a split_id
addCol('transactions', 'created_by', 'TEXT');                             // email of whoever entered it
addCol('categories', 'goal_type', "TEXT NOT NULL DEFAULT 'monthly'");     // monthly (refill to target) | by_date (save target by goal_date)
addCol('categories', 'goal_date', 'TEXT');
addCol('transactions', 'tip_pending', 'INTEGER NOT NULL DEFAULT 0');           // cents of tip included in amount that the bank hasn't posted yet
addCol('transactions', 'bank_ref', 'TEXT');
// When a transaction was entered (ms). Set once, never changed: the order within a day. Rows from
// before get their last-changed time, so nothing moves.
addCol('transactions', 'created_at', 'INTEGER');
// A budget's "epoch" changes whenever its rows are replaced wholesale (restore, erase), which the
// change log can't describe (deleted rows leave no entry). Devices that see a new epoch download
// the budget again instead of keeping rows the server no longer has.
addCol('households', 'epoch', 'INTEGER NOT NULL DEFAULT 0');
export const epochOf = hh => db.prepare('SELECT epoch FROM households WHERE id = ?').get(hh)?.epoch || 0;
export const newEpoch = hh => db.prepare('UPDATE households SET epoch = ? WHERE id = ?').run(now(), hh);
db.exec('UPDATE transactions SET created_at = updated_at WHERE created_at IS NULL');                               // the bank's own id for an imported row (exact duplicate check)                                // 'YYYY-MM-DD' for by_date goals

// v0.9.9: budget_months used to carry UNIQUE(household_id, category_id, month), which made a
// sync fail outright whenever two devices created the slot independently. Rebuild without it;
// uniqueness is now enforced by upsert() retiring the older row.
{
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='budget_months'").get()?.sql || '';
  if (/UNIQUE/i.test(sql)) {
    db.exec(`BEGIN;
      CREATE TABLE budget_months_new (
        id TEXT PRIMARY KEY, household_id TEXT NOT NULL, category_id TEXT NOT NULL, month TEXT NOT NULL,
        assigned INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
      INSERT INTO budget_months_new SELECT id, household_id, category_id, month, assigned, updated_at, deleted FROM budget_months;
      DROP TABLE budget_months;
      ALTER TABLE budget_months_new RENAME TO budget_months;
      CREATE INDEX IF NOT EXISTS bm_slot ON budget_months(household_id, category_id, month);
      COMMIT;`);
  }
}

// Tables that participate in sync, in dependency order.
export const SYNC_TABLES = ['accounts', 'category_groups', 'categories', 'budget_months', 'transactions', 'scheduled', 'payee_rules', 'household_prefs'];

const COLS = {}, DEFAULTS = {};
for (const t of SYNC_TABLES) {
  const info = db.prepare(`PRAGMA table_info(${t})`).all();
  COLS[t] = info.map(c => c.name);
  // Columns that can't be null but have a default: a null from a client means "use the default",
  // so one odd row can't fail the whole sync with a constraint error.
  DEFAULTS[t] = Object.fromEntries(info.filter(c => c.notnull && c.dflt_value != null).map(c => [c.name, db.prepare(`SELECT ${c.dflt_value} v`).get().v]));
}

export function now() { return Date.now(); }

/** Insert or update a row (last-write-wins on updated_at) and log the change. */
export function upsert(tbl, row, householdId, actor = null) {
  if (!SYNC_TABLES.includes(tbl)) throw new Error('bad table');
  const cols = COLS[tbl];
  const clean = {};
  for (const c of cols) if (c in row) clean[c] = row[c] == null && c in DEFAULTS[tbl] ? DEFAULTS[tbl][c] : row[c];
  clean.household_id = householdId;
  if (tbl === 'transactions') {   // the entry time is kept as first recorded; a new row without one gets now
    const had = db.prepare('SELECT created_at FROM transactions WHERE id = ?').get(clean.id || '');
    if (had?.created_at) clean.created_at = had.created_at;
    else if (!clean.created_at) clean.created_at = Number(row.updated_at) || now();
  }
  clean.id = clean.id || randomUUID();
  clean.updated_at = clean.updated_at || now();
  clean.deleted = clean.deleted ? 1 : 0;
  if (tbl === 'transactions' && actor) {
    const prev = db.prepare('SELECT created_by FROM transactions WHERE id = ?').get(clean.id);
    clean.created_by = (prev && prev.created_by) || clean.created_by || actor;
  }

  // Ids are global; a row must never move from one budget (household) to another, which the
  // ON CONFLICT(id) update below would otherwise do. Refuse it and let the caller report it.
  const owner = db.prepare(`SELECT household_id FROM ${tbl} WHERE id = ?`).get(clean.id);
  if (owner && owner.household_id !== householdId) return { id: clean.id, skipped: true, conflict: 'other_budget' };

  const existing = db.prepare(`SELECT updated_at FROM ${tbl} WHERE id = ? AND household_id = ?`).get(clean.id, householdId);
  if (existing && existing.updated_at > clean.updated_at) return { id: clean.id, skipped: true };

  // budget_months is unique per (household, category, month). If a different row already
  // holds that slot, retire it so the incoming row wins instead of the insert failing.
  if (tbl === 'budget_months' && clean.category_id && clean.month && !clean.deleted) {
    const clash = db.prepare('SELECT id FROM budget_months WHERE household_id = ? AND category_id = ? AND month = ? AND id != ?')
      .all(householdId, clean.category_id, clean.month, clean.id);
    for (const c of clash) {
      db.prepare('UPDATE budget_months SET deleted = 1, updated_at = ? WHERE id = ?').run(clean.updated_at, c.id);
      db.prepare('INSERT INTO change_log (household_id, tbl, row_id, at) VALUES (?,?,?,?)').run(householdId, 'budget_months', c.id, clean.updated_at);
    }
  }

  const keys = Object.keys(clean);
  const sql = `INSERT INTO ${tbl} (${keys.join(',')}) VALUES (${keys.map(k => '@' + k).join(',')})
    ON CONFLICT(id) DO UPDATE SET ${keys.filter(k => k !== 'id').map(k => `${k}=excluded.${k}`).join(',')}`;
  db.prepare(sql).run(clean);
  db.prepare('INSERT INTO change_log (household_id, tbl, row_id, at) VALUES (?,?,?,?)').run(householdId, tbl, clean.id, clean.updated_at);
  return { id: clean.id };
}

export function softDelete(tbl, id, householdId) {
  return upsert(tbl, { id, deleted: 1, updated_at: now() }, householdId);
}

export function list(tbl, householdId, where = '', params = []) {
  return db.prepare(`SELECT * FROM ${tbl} WHERE household_id = ? AND deleted = 0 ${where}`).all(householdId, ...params);
}

/** Everything changed since `cursor` (a change_log seq). */
export function changesSince(householdId, cursor, limit = 2000) {
  const logs = db.prepare(
    'SELECT seq, tbl, row_id FROM change_log WHERE household_id = ? AND seq > ? ORDER BY seq LIMIT ?'
  ).all(householdId, cursor, limit);
  const out = Object.fromEntries(SYNC_TABLES.map(t => [t, []]));
  const seen = new Set();
  let last = cursor;
  for (const l of logs) {
    last = l.seq;
    const key = l.tbl + ':' + l.row_id;
    if (seen.has(key)) continue;
    seen.add(key);
    const row = db.prepare(`SELECT * FROM ${l.tbl} WHERE id = ?`).get(l.row_id);
    if (row) out[l.tbl].push(row);
  }
  return { cursor: last, changes: out, more: logs.length === limit };
}

let depth = 0;   // nested calls join the outer transaction
export function transaction(fn) {
  if (depth) { depth++; try { return fn(); } finally { depth--; } }
  db.exec('BEGIN'); depth = 1;
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  finally { depth = 0; }
}

/**
 * Copy the live database to data/backups/.
 * Nightly copies are budget-daily-YYYY-MM-DD.db (one per day, overwritten); the newest KEEP_DAYS
 * (default 14) are kept. Other copies (Backup now, and the safety copies taken before a restore,
 * erase or delete) are budget-<time>.db and are removed after KEEP_DAYS days, always keeping the
 * newest few.
 */
const KEEP_DAYS = Math.max(1, Number(process.env.KEEP_DAYS || 14));
const localDay = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
export const dailyBackupName = (d = new Date()) => `budget-daily-${localDay(d)}.db`;
export function backupNow(kind = 'manual') {
  const dir = join(DATA_DIR, 'backups');
  mkdirSync(dir, { recursive: true });
  const target = join(dir, kind === 'daily' ? dailyBackupName() : `budget-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  if (existsSync(target)) unlinkSync(target);   // VACUUM INTO won't overwrite
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  pruneBackups(dir);
  return target;
}
function pruneBackups(dir) {
  const all = readdirSync(dir).filter(f => f.endsWith('.db')).map(f => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  const daily = all.filter(x => x.f.startsWith('budget-daily-')).sort((a, b) => b.f.localeCompare(a.f));
  for (const { f } of daily.slice(KEEP_DAYS)) unlinkSync(join(dir, f));
  const cutoff = Date.now() - KEEP_DAYS * 864e5;
  const other = all.filter(x => !x.f.startsWith('budget-daily-'));
  for (const { f, t } of other.slice(3)) if (t < cutoff) unlinkSync(join(dir, f));
}
export const hasDailyBackup = () => existsSync(join(DATA_DIR, 'backups', dailyBackupName()));

/** Backup files, with how much of this budget (household) each holds. */
export function listBackups(hh) {
  const dir = join(DATA_DIR, 'backups');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.db')).map(f => {
    const st = statSync(join(dir, f));
    let counts = null;
    try { const b = new DatabaseSync(join(dir, f), { readOnly: true }); const n = t => b.prepare(`SELECT COUNT(*) c FROM ${t} WHERE deleted=0 AND household_id = ?`).get(hh).c; counts = { transactions: n('transactions'), accounts: n('accounts'), categories: n('categories') }; b.close(); } catch {}
    return { file: f, size: st.size, mtime: st.mtimeMs, counts };
  }).sort((a, b) => b.mtime - a.mtime);
}

/** Replace this household's rows with the ones in a backup file (after backing up first). */
export function restoreFrom(file, householdId) {
  const path = join(DATA_DIR, 'backups', file);
  if (!/^[\w.-]+\.db$/.test(file) || !existsSync(path)) throw new Error('no such backup');
  const pre = backupNow();
  db.exec(`ATTACH DATABASE '${path.replace(/'/g, "''")}' AS bk`);
  try {
    transaction(() => {
      for (const t of SYNC_TABLES) {
        const have = db.prepare(`PRAGMA bk.table_info(${t})`).all().map(c => c.name);
        if (!have.length) continue;
        const cols = COLS[t].filter(c => have.includes(c));
        db.prepare(`DELETE FROM ${t} WHERE household_id = ?`).run(householdId);
        db.prepare(`INSERT INTO ${t} (${cols.join(',')}) SELECT ${cols.join(',')} FROM bk.${t} WHERE household_id = ?`).run(householdId);
      }
      db.prepare('DELETE FROM change_log WHERE household_id = ?').run(householdId);
      const ts = now();
      for (const t of SYNC_TABLES) for (const r of db.prepare(`SELECT id FROM ${t} WHERE household_id = ?`).all(householdId))
        db.prepare('INSERT INTO change_log (household_id, tbl, row_id, at) VALUES (?,?,?,?)').run(householdId, t, r.id, ts);
    });
  } finally { db.exec('DETACH DATABASE bk'); }
  newEpoch(householdId);
  return { restored: file, backup_before: pre };
}

/** The money-check identity, computed server side: cash in on-budget accounts must equal
 *  categories available + held future + ready-to-assign. Also flags orphans. */
export function integrityCheck(householdId) {
  const issues = [];
  const cash = db.prepare(`SELECT COALESCE(SUM(t.amount),0) v FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE t.household_id=? AND t.deleted=0 AND a.deleted=0 AND a.on_budget=1`).get(householdId).v;
  const orphanTx = db.prepare(`SELECT COUNT(*) c FROM transactions t LEFT JOIN accounts a ON a.id=t.account_id WHERE t.household_id=? AND t.deleted=0 AND (a.id IS NULL OR a.deleted=1)`).get(householdId).c;
  if (orphanTx) issues.push(`${orphanTx} transaction(s) on a missing account`);
  const orphanCat = db.prepare(`SELECT COUNT(*) c FROM transactions t LEFT JOIN categories c ON c.id=t.category_id WHERE t.household_id=? AND t.deleted=0 AND t.category_id IS NOT NULL AND (c.id IS NULL OR c.deleted=1)`).get(householdId).c;
  if (orphanCat) issues.push(`${orphanCat} transaction(s) in a deleted category`);
  const halfTransfers = db.prepare(`SELECT COUNT(*) c FROM transactions t WHERE t.household_id=? AND t.deleted=0 AND t.transfer_id IS NOT NULL AND (SELECT COUNT(*) FROM transactions x WHERE x.transfer_id=t.transfer_id AND x.deleted=0)<>2`).get(householdId).c;
  if (halfTransfers) issues.push(`${halfTransfers} transfer leg(s) without a partner`);
  const dupSlots = db.prepare(`SELECT COUNT(*) c FROM (SELECT category_id, month, COUNT(*) n FROM budget_months WHERE household_id=? AND deleted=0 GROUP BY 1,2 HAVING n>1)`).get(householdId).c;
  if (dupSlots) issues.push(`${dupSlots} duplicate budget slot(s)`);
  const detail = { cash, issues, checked_at: new Date().toISOString() };
  db.prepare('INSERT INTO integrity (household_id, at, ok, detail) VALUES (?,?,?,?) ON CONFLICT(household_id) DO UPDATE SET at=excluded.at, ok=excluded.ok, detail=excluded.detail')
    .run(householdId, now(), issues.length ? 0 : 1, JSON.stringify(detail));
  return { ok: !issues.length, ...detail };
}
export const lastIntegrity = hh => { const r = db.prepare('SELECT * FROM integrity WHERE household_id = ?').get(hh); return r ? { at: r.at, ok: !!r.ok, ...JSON.parse(r.detail) } : null; };

// ---- users / households -------------------------------------------------

/** Budgets (households, rows kept apart by household_id) with their sizes; `rows` = which ones. */
export function listHouseholds(rows) {
  return rows.map(h => ({
    ...h,
    accounts: db.prepare('SELECT COUNT(*) c FROM accounts WHERE household_id = ? AND deleted = 0 AND closed = 0').get(h.id).c,
    transactions: db.prepare('SELECT COUNT(*) c FROM transactions WHERE household_id = ? AND deleted = 0').get(h.id).c,
    // Most recent change from any device (ms epoch), or when the budget was created.
    updated_at: db.prepare('SELECT MAX(at) m FROM change_log WHERE household_id = ?').get(h.id).m || h.created_at,
  }));
}
export const renameHousehold = (id, name) => db.prepare('UPDATE households SET name = ? WHERE id = ?').run(name.trim(), id);
/** Deletes a budget and everything in it (after a backup). `before` runs first, inside the same transaction. */
export function deleteHousehold(id, before = () => {}) {
  const backup = backupNow();
  transaction(() => {
    before();
    for (const t of SYNC_TABLES) db.prepare(`DELETE FROM ${t} WHERE household_id = ?`).run(id);
    for (const t of ['change_log', 'integrity', 'push_subs']) { try { db.prepare(`DELETE FROM ${t} WHERE household_id = ?`).run(id); } catch {} }
    db.prepare('DELETE FROM households WHERE id = ?').run(id);
  });
  return { ok: true, backup };
}

export function seedHousehold(hh) {
  const groups = [
    ['Bills', ['Rent / Mortgage', 'Electric', 'Water', 'Internet', 'Phone', 'Insurance']],
    ['Everyday', ['Groceries', 'Gas', 'Dining Out', 'Household']],
    ['Debt', ['Loan Payments']],
    ['Savings Goals', ['Emergency Fund', 'Vacation']],
  ];
  let gs = 0;
  for (const [gname, cats] of groups) {
    const gid = randomUUID();
    upsert('category_groups', { id: gid, name: gname, sort: gs++ }, hh);
    let cs = 0;
    for (const c of cats) upsert('categories', { group_id: gid, name: c, sort: cs++ }, hh);
  }
}
