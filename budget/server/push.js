// Web push for "due today" reminders. VAPID keys are generated once and kept in DATA_DIR.
import webpush from 'web-push';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, DATA_DIR, now } from './db.js';

const KEY_FILE = join(DATA_DIR, 'vapid.json');
let keys;
if (existsSync(KEY_FILE)) keys = JSON.parse(readFileSync(KEY_FILE, 'utf8'));
else { keys = webpush.generateVAPIDKeys(); writeFileSync(KEY_FILE, JSON.stringify(keys)); }
webpush.setVapidDetails('mailto:budget@localhost', keys.publicKey, keys.privateKey);

export const publicKey = () => keys.publicKey;

export function subscribe(hh, email, sub) {
  const endpoint = sub.endpoint;
  const existing = db.prepare('SELECT id FROM push_subs WHERE household_id = ? AND sub LIKE ?').get(hh, `%${endpoint}%`);
  if (existing) return existing.id;
  const id = randomUUID();
  db.prepare('INSERT INTO push_subs (id, household_id, email, sub, created_at) VALUES (?,?,?,?,?)').run(id, hh, email, JSON.stringify(sub), now());
  return id;
}
export function unsubscribe(hh, endpoint) {
  db.prepare('DELETE FROM push_subs WHERE household_id = ? AND sub LIKE ?').run(hh, `%${endpoint}%`);
}
export const subCount = hh => db.prepare('SELECT COUNT(*) c FROM push_subs WHERE household_id = ?').get(hh).c;

export async function sendToHousehold(hh, payload) {
  const rows = db.prepare('SELECT id, sub FROM push_subs WHERE household_id = ?').all(hh);
  let sent = 0;
  for (const r of rows) {
    try { await webpush.sendNotification(JSON.parse(r.sub), JSON.stringify(payload), { TTL: 60 * 60 * 12 }); sent++; }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) db.prepare('DELETE FROM push_subs WHERE id = ?').run(r.id); else console.error('push', e.statusCode || e.message); }
  }
  return sent;
}

/** Items due today (not auto) → one notification per household. Called by the daily job. */
export async function remindDue(todayIso) {
  const byHh = {};
  for (const s of db.prepare('SELECT household_id, payee, amount, next_date, transfer_to FROM scheduled WHERE deleted = 0 AND auto = 0 AND next_date <= ?').all(todayIso))
    (byHh[s.household_id] ||= []).push(s);
  let total = 0;
  for (const [hh, items] of Object.entries(byHh)) {
    const money = c => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toFixed(2);
    const lines = items.slice(0, 4).map(s => `${s.transfer_to ? 'Transfer' : s.payee} ${money(s.amount)}`);
    const body = lines.join('\n') + (items.length > 4 ? `\n…and ${items.length - 4} more` : '');
    total += await sendToHousehold(hh, { title: items.length === 1 ? 'Bill due today' : `${items.length} bills due today`, body, url: '/#/budget', tag: 'due-' + todayIso });
  }
  return total;
}
