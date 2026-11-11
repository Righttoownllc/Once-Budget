// Who can open which budget.
//
// Every budget (household) has members: an owner (or several) and members. A request may only use a
// budget its person belongs to; owners alone can rename, delete, reset, restore or share it.
// Who "a person" is depends on AUTH_MODE:
//   cloudflare -> the email Cloudflare Access verified. Someone new gets an empty budget of their own.
//   password   -> the server password belongs to the admin. The admin adds people on the server's
//                 Pair a phone page; each phone or browser is paired to one person.
//   open/local -> one shared person for everyone (open: unless a verified Cloudflare email comes
//                 along), so everyone who can reach the server sees every budget. The app says so.
import { randomUUID } from 'node:crypto';
import { db, now, transaction, seedHousehold as seed } from './db.js';

const addCol = (tbl, col, def) => { if (!db.prepare(`PRAGMA table_info(${tbl})`).all().some(c => c.name === col)) db.exec(`ALTER TABLE ${tbl} ADD COLUMN ${col} ${def}`); };
db.exec(`CREATE TABLE IF NOT EXISTS members (
  household_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', added_at INTEGER NOT NULL,
  PRIMARY KEY (household_id, user_id));
  CREATE TABLE IF NOT EXISTS server_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
addCol('users', 'name', "TEXT NOT NULL DEFAULT ''");
addCol('users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0');
addCol('members', 'color', 'TEXT');   // the person's colour in this budget (their initials on transactions)

// One-time: before v1.40 everyone on a server could open every budget. Keep exactly that for the
// people who already exist (each owns every existing budget), and make the first of them the admin.
// Newcomers from here on start with only their own budget.
if (!db.prepare("SELECT 1 FROM server_settings WHERE key = 'access_v1'").get()) {
  transaction(() => {
    const users = db.prepare('SELECT id FROM users ORDER BY created_at').all();
    const hhs = db.prepare('SELECT id FROM households').all();
    for (const u of users) for (const h of hhs) db.prepare("INSERT OR IGNORE INTO members (household_id, user_id, role, added_at) VALUES (?, ?, 'owner', ?)").run(h.id, u.id, now());
    if (users[0]) db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(users[0].id);
    db.prepare("INSERT INTO server_settings (key, value) VALUES ('access_v1', ?)").run(String(now()));
  });
}

export const userById = id => db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
export const makeAdmin = id => { db.prepare('UPDATE users SET is_admin = 0').run(); db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(id); };
export const adminUser = () => db.prepare('SELECT * FROM users WHERE is_admin = 1 ORDER BY created_at LIMIT 1').get() || null;
// password mode's admin has no email of their own (it's LOCAL_USER_EMAIL), so they're "Admin".
const LOCAL = process.env.LOCAL_USER_EMAIL || 'local@home';
export const label = u => (u ? u.name || (u.email.startsWith('person:') ? 'Someone' : u.email === LOCAL ? (u.is_admin ? 'Admin' : 'Shared sign-in') : u.email) : '');
const hasAnyone = () => !!db.prepare('SELECT 1 FROM users LIMIT 1').get();

export function newHousehold(name, ownerId) {
  const hh = { id: randomUUID(), name: (name || '').trim() || 'New budget', created_at: now() };
  transaction(() => {
    db.prepare('INSERT INTO households (id, name, created_at) VALUES (?,?,?)').run(hh.id, hh.name, hh.created_at);
    seed(hh.id);
    if (ownerId) addMember(hh.id, ownerId, 'owner');
  });
  return hh;
}

/**
 * The person for an identity (email, or 'person:<id>' for password-mode people), created on first use.
 * The very first person on a server is its admin and owns any budgets nobody belongs to yet.
 * Anyone else with no budget gets an empty one of their own. invitedTo: the budget someone is
 * being added to before they've signed in (the caller adds the membership).
 */
export function personFor(email, { name = '', invitedTo = null } = {}) {
  let u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!u && invitedTo) {   // shared with before they ever signed in: that budget is their first
    const id = randomUUID();
    db.prepare('INSERT INTO users (id, email, household_id, created_at, name, is_admin) VALUES (?,?,?,?,?,0)').run(id, email, invitedTo, now(), name);
    return userById(id);
  }
  if (!u) {
    const first = !hasAnyone();
    const orphans = first ? db.prepare('SELECT id FROM households WHERE id NOT IN (SELECT household_id FROM members) ORDER BY created_at').all() : [];
    transaction(() => {
      const id = randomUUID();
      const home = orphans[0]?.id || newHousehold(first ? 'Home' : budgetName(email, name), null).id;
      db.prepare('INSERT INTO users (id, email, household_id, created_at, name, is_admin) VALUES (?,?,?,?,?,?)').run(id, email, home, now(), name, first ? 1 : 0);
      for (const o of orphans.length ? orphans : [{ id: home }]) addMember(o.id, id, 'owner');
      u = userById(id);
    });
  }
  return ensureHome(u);
}
const budgetName = (email, name) => {
  const who = name || (email.startsWith('person:') ? '' : email.split('@')[0]);
  return who ? `${who[0].toUpperCase()}${who.slice(1)}'s budget` : 'My budget';
};

/** Makes sure the person's main budget is one they belong to (it may have been unshared or deleted). */
export function ensureHome(u) {
  if (roleIn(u.household_id, u.id)) return u;
  const next = db.prepare('SELECT household_id FROM members WHERE user_id = ? ORDER BY added_at LIMIT 1').get(u.id)?.household_id
    || newHousehold(budgetName(u.email, u.name), u.id).id;
  db.prepare('UPDATE users SET household_id = ? WHERE id = ?').run(next, u.id);
  return { ...u, household_id: next };
}

export const roleIn = (hh, userId) => db.prepare('SELECT role FROM members WHERE household_id = ? AND user_id = ?').get(hh, userId)?.role || null;
// What someone can do in a budget:
//   owner   everything, including sharing, renaming, erasing and restoring it
//   member  change everything in it (accounts, categories, money, schedules, rules)
//   spender add purchases: add transactions, and change or delete the ones they added; nothing else
//   viewer  see everything, change nothing
export const ROLES = ['owner', 'member', 'spender', 'viewer'];
export function addMember(hh, userId, role = 'member') {
  db.prepare('INSERT INTO members (household_id, user_id, role, added_at) VALUES (?, ?, ?, ?) ON CONFLICT(household_id, user_id) DO UPDATE SET role = excluded.role').run(hh, userId, ROLES.includes(role) ? role : 'member', now());
}
/** Changes someone's level in a budget. A budget always keeps at least one owner. */
export function setRole(hh, userId, role) {
  const was = roleIn(hh, userId);
  if (!was || !ROLES.includes(role)) return false;
  if (was === 'owner' && role !== 'owner' && owners(hh) <= 1) throw new Error('A budget needs an owner. Make someone else an owner first.');
  db.prepare('UPDATE members SET role = ? WHERE household_id = ? AND user_id = ?').run(role, hh, userId);
  return true;
}
export const canChangeAll = role => role === 'owner' || role === 'member';
/**
 * Whether a change to one row is allowed for this role. prev: the row as the server has it (or
 * undefined for a new one); actor: the person's identity (what transactions record in created_by).
 */
export function mayWrite(role, actor, tbl, prev) {
  if (canChangeAll(role)) return true;
  if (role !== 'spender' || tbl !== 'transactions') return false;
  return !prev || prev.created_by === actor;
}
const owners = hh => db.prepare("SELECT COUNT(*) c FROM members WHERE household_id = ? AND role = 'owner'").get(hh).c;
/** Removes someone from a budget. A budget always keeps at least one owner. */
export function removeMember(hh, userId) {
  const r = roleIn(hh, userId);
  if (!r) return false;
  if (r === 'owner' && owners(hh) <= 1) throw new Error('A budget needs an owner. Make someone else an owner first, or delete the budget.');
  db.prepare('DELETE FROM members WHERE household_id = ? AND user_id = ?').run(hh, userId);
  return true;
}
export const membersOf = hh => db.prepare('SELECT u.id, u.email, u.name, u.is_admin, m.role, m.color FROM members m JOIN users u ON u.id = m.user_id WHERE m.household_id = ? ORDER BY m.role DESC, m.added_at').all(hh)
  .map(u => ({ id: u.id, label: label(u), email: u.email.startsWith('person:') || u.email === LOCAL ? null : u.email, role: u.role, color: u.color || defaultColor(u.email) }));

// Colours for people's initials. Each person gets one by default (from who they are), and an
// owner (or the person) can pick another in Who can open this budget.
export const COLORS = ['#2f855a', '#2b6cb0', '#c05621', '#6b46c1', '#b83280', '#2c7a7b', '#975a16', '#c53030', '#4a5568', '#0987a0'];
export const defaultColor = key => { let h = 0; for (const ch of String(key || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; };
export const setColor = (hh, userId, color) => db.prepare('UPDATE members SET color = ? WHERE household_id = ? AND user_id = ?').run(COLORS.includes(color) ? color : null, hh, userId).changes > 0;
/**
 * Who entered this budget's transactions: { [created_by]: { name, color } }, for everyone in it and
 * anyone who entered something before (someone removed from the server shows by the name kept).
 */
export function authorsOf(hh) {
  const out = {};
  for (const r of db.prepare('SELECT DISTINCT created_by FROM transactions WHERE household_id = ? AND created_by IS NOT NULL').all(hh)) {
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(r.created_by);
    out[r.created_by] = { name: u ? label(u) : r.created_by, color: defaultColor(r.created_by) };
  }
  for (const m of db.prepare('SELECT u.*, m.color AS mcolor FROM members m JOIN users u ON u.id = m.user_id WHERE m.household_id = ?').all(hh))
    out[m.email] = { name: label(m), color: m.mcolor || defaultColor(m.email) };
  return out;
}

/** The budgets a person belongs to, with their role, oldest first. */
export const budgetsOf = userId => db.prepare('SELECT h.id, h.name, h.created_at, m.role FROM members m JOIN households h ON h.id = m.household_id WHERE m.user_id = ? ORDER BY h.created_at').all(userId);

/** Deletes a budget for everyone in it; people whose main budget it was move to another of theirs. */
export function dropHousehold(id) {
  const affected = db.prepare('SELECT * FROM users WHERE household_id = ?').all(id);
  db.prepare('DELETE FROM members WHERE household_id = ?').run(id);
  for (const u of affected) {
    const next = db.prepare('SELECT household_id FROM members WHERE user_id = ? ORDER BY added_at LIMIT 1').get(u.id)?.household_id
      || newHousehold(budgetName(u.email, u.name), u.id).id;
    db.prepare('UPDATE users SET household_id = ? WHERE id = ?').run(next, u.id);
  }
}

// ---- password mode: people the admin adds -------------------------------------------------------
// Everyone: people the admin added, and (when Cloudflare sign-ins are accepted too) people known by
// email, so a phone can be paired at home as the same person who signs in through Cloudflare away.
// Identities nobody can sign in as any more (an old built-in name such as me@home or local@home,
// from a test mode) aren't offered: only people the admin added, real emails, and the admin.
const canSignIn = u => u.is_admin || u.email.startsWith('person:') || /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(u.email);
export const people = () => db.prepare('SELECT id, email, name, is_admin FROM users ORDER BY is_admin DESC, created_at').all().filter(canSignIn)
  .map(u => ({ id: u.id, name: u.is_admin ? `${u.email.includes('@') && u.email !== LOCAL ? u.email : u.name || 'You'} (admin)` : label(u), admin: !!u.is_admin }));
/** Adds a person. budget: 'new' (an empty budget of their own) or the id of a budget to share with them. */
export function addPerson(name, budget, byAdminId, role = 'spender') {
  name = String(name || '').trim().slice(0, 40);
  if (!name) throw new Error('Give the person a name');
  if (db.prepare("SELECT 1 FROM users WHERE email LIKE 'person:%' AND lower(name) = lower(?)").get(name)) throw new Error(`There's already someone called ${name}`);
  const id = randomUUID(), email = 'person:' + id;
  transaction(() => {
    const shared = budget && budget !== 'new' && roleIn(budget, byAdminId) ? budget : null;
    const home = shared || newHousehold(budgetName(email, name), null).id;
    db.prepare('INSERT INTO users (id, email, household_id, created_at, name, is_admin) VALUES (?,?,?,?,?,0)').run(id, email, home, now(), name);
    addMember(home, id, shared ? (ROLES.includes(role) && role !== 'owner' ? role : 'spender') : 'owner');
  });
  return userById(id);
}
/** Removes a person and their devices. Budgets only they could open pass to the admin, so nothing is lost. */
export function removePerson(id) {
  const u = userById(id);
  if (!u || u.is_admin) throw new Error("The admin can't be removed");
  const admin = adminUser();
  transaction(() => {
    for (const b of budgetsOf(id)) {
      const others = db.prepare('SELECT COUNT(*) c FROM members WHERE household_id = ? AND user_id != ?').get(b.id, id).c;
      if (!others && admin) addMember(b.id, admin.id, 'owner');
      else if (b.role === 'owner' && owners(b.id) <= 1) db.prepare("UPDATE members SET role = 'owner' WHERE household_id = ? AND user_id = (SELECT user_id FROM members WHERE household_id = ? AND user_id != ? ORDER BY added_at LIMIT 1)").run(b.id, b.id, id);
    }
    db.prepare('DELETE FROM members WHERE user_id = ?').run(id);
    try { db.prepare('DELETE FROM devices WHERE user_id = ?').run(id); } catch {}
    try { db.prepare('UPDATE transactions SET created_by = ? WHERE created_by = ?').run(u.name || 'Someone', u.email); } catch {}
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  });
}
