// AUTH_MODE=password: the server has one password, set on the first visit, and every browser or
// phone that uses it holds its own device key (revocable). Phones get theirs by pairing: the signed-in
// browser shows a QR code (and a 6-digit code) that works once, for 10 minutes. Nothing here ever
// talks to anyone but the user's own devices.
import { randomBytes, scryptSync, timingSafeEqual, createHash, randomInt } from 'node:crypto';
import QRCode from 'qrcode';
import { db, now } from './db.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS server_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS pair_codes (code TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
`);
// v1.40: each device and pairing code belongs to a person (users.id). Devices from before belong to the admin.
for (const [t, c] of [['devices', 'user_id'], ['pair_codes', 'user_id']]) if (!db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} TEXT`);

const setting = k => db.prepare('SELECT value FROM server_settings WHERE key = ?').get(k)?.value ?? null;
const setSetting = (k, v) => db.prepare('INSERT INTO server_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
const sha = s => createHash('sha256').update(s).digest('hex');

// ---- password ---------------------------------------------------------------------------------
export const hasPassword = () => !!setting('password');
export function setPassword(pw) {
  const salt = randomBytes(16);
  setSetting('password', `scrypt:${salt.toString('hex')}:${scryptSync(pw, salt, 32).toString('hex')}`);
}
export function checkPassword(pw) {
  const stored = setting('password'); if (!stored || typeof pw !== 'string') return false;
  const [, salt, hash] = stored.split(':');
  const got = scryptSync(pw, Buffer.from(salt, 'hex'), 32);
  return timingSafeEqual(got, Buffer.from(hash, 'hex'));
}

// ---- devices ----------------------------------------------------------------------------------
export function newDevice(name, kind, userId = null) {
  const token = randomBytes(32).toString('base64url');
  const id = randomBytes(8).toString('hex');
  db.prepare('INSERT INTO devices (id, name, kind, token_hash, created_at, last_seen, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, String(name || kind).slice(0, 60), kind, sha(token), now(), now(), userId);
  return { id, token };
}
/** The device for a key, or null. Updates its last-seen time (at most once a minute). */
export function deviceFor(token) {
  if (!token) return null;
  const d = db.prepare('SELECT * FROM devices WHERE token_hash = ?').get(sha(token));
  if (d && now() - d.last_seen > 60_000) db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(now(), d.id);
  return d || null;
}
/** Devices with access: everyone's (userId null) or one person's. */
export const listDevices = (userId = null) => db.prepare(`SELECT id, name, kind, created_at, last_seen, user_id FROM devices ${userId ? 'WHERE user_id = ?' : ''} ORDER BY last_seen DESC`).all(...(userId ? [userId] : []));
export const removeDevice = (id, userId = null) => db.prepare(`DELETE FROM devices WHERE id = ? ${userId ? 'AND user_id = ?' : ''}`).run(id, ...(userId ? [userId] : [])).changes > 0;
/** Gives devices from before people existed to the admin. */
export const adoptDevices = adminId => db.prepare('UPDATE devices SET user_id = ? WHERE user_id IS NULL').run(adminId);

// ---- pairing codes ----------------------------------------------------------------------------
/** A one-time code that signs a phone or browser in as this person. */
export function newPairCode(userId = null) {
  db.prepare('DELETE FROM pair_codes WHERE expires_at < ?').run(now());
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  db.prepare('INSERT OR REPLACE INTO pair_codes (code, expires_at, user_id) VALUES (?, ?, ?)').run(code, now() + 10 * 60_000, userId);
  return code;
}
/** Uses up a pairing code: { user_id } if it was valid, otherwise null. */
export function takePairCode(code) {
  const c = String(code || '').replace(/\D/g, '');
  const row = db.prepare('SELECT user_id FROM pair_codes WHERE code = ? AND expires_at >= ?').get(c, now());
  if (!row) return null;
  db.prepare('DELETE FROM pair_codes WHERE code = ?').run(c);
  return row;
}
export const awayAddress = () => setting('away_url') || '';
// The server's address on the home network. Remembered when the Pair a phone page is opened from a
// private address, or typed on that page. A new phone pairs here: an address behind Cloudflare
// Access would turn it away before it reaches the server.
export const homeAddress = () => setting('home_url') || '';
export const setHomeAddress = u => setSetting('home_url', u || '');
export const isPrivate = u => /^https?:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|localhost|[^/]*\.local\b)/.test(u || '');
export const setAwayAddress = u => setSetting('away_url', u || '');

// ---- slowing down guessing --------------------------------------------------------------------
const tries = new Map();
/** False when this IP has failed too often in the last 10 minutes (5 password / 10 code attempts). */
export function allowed(ip, kind) {
  const k = kind + ':' + ip, t = now();
  const list = (tries.get(k) || []).filter(x => t - x < 10 * 60_000);
  tries.set(k, list);
  return list.length < (kind === 'login' ? 5 : 10);
}
export const failed = (ip, kind) => { const k = kind + ':' + ip; tries.set(k, [...(tries.get(k) || []), now()]); };

// ---- cookies ----------------------------------------------------------------------------------
export const COOKIE = 'budget_session';
export function cookieFrom(header) {
  const m = (header || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
export const sessionCookie = (token, secure) => `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${400 * 86400}${secure ? '; Secure' : ''}`;

// ---- pages (small, self-contained, no scripts from anywhere else) -----------------------------
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · Once Budget</title>
<style>
:root{--ink:#1b2a41;--muted:#6b7280;--line:#e5e7eb;--bg:#f4f5f7;--card:#fff;--pos:#2f855a;--neg:#c53030}
@media (prefers-color-scheme:dark){:root{--ink:#e2e8f0;--muted:#94a3b8;--line:#2b3a50;--bg:#0f172a;--card:#1e293b;--pos:#4ade80;--neg:#f87171}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{background:#1b2a41;color:#fff;padding:22px 16px}header b{font-size:20px}header span{display:block;opacity:.7;font-size:13px;letter-spacing:.06em;text-transform:uppercase}
main{max-width:520px;margin:0 auto;padding:16px;display:flex;flex-direction:column;gap:14px}
.card{background:var(--card);border-radius:16px;padding:18px;display:flex;flex-direction:column;gap:10px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted)}
input{font:inherit;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink)}
input:focus{outline:none;border-color:var(--pos);box-shadow:0 0 0 2px rgba(47,133,90,.25)}
button,.btn{font:inherit;font-weight:600;padding:11px 16px;border:0;border-radius:12px;background:var(--pos);color:#fff;cursor:pointer;text-decoration:none;text-align:center}
.ghost{background:transparent;color:var(--muted)}.err{color:var(--neg);font-weight:600}.muted{color:var(--muted);font-size:14px}
.qr{display:flex;justify-content:center;background:#fff;border-radius:12px;padding:12px}.qr svg{width:240px;height:240px}
.code{font-size:34px;font-weight:700;letter-spacing:.2em;text-align:center;font-variant-numeric:tabular-nums}
.dev{display:flex;justify-content:space-between;align-items:center;gap:10px;border-top:1px solid var(--line);padding-top:8px}
</style></head><body><header><span>Once Budget · your server</span><b>${esc(title)}</b></header><main>${body}</main></body></html>`;
}

export function setupPage(err) {
  return page('Create your server password', `<form class="card" method="post" action="/setup">
<p class="muted" style="margin:0">This password protects your budget on this server. You'll use it to sign in from a browser, and to pair phones. Write it down somewhere safe: there's no "forgot password" (your data stays on your own hardware).</p>
${err ? `<p class="err">${esc(err)}</p>` : ''}
<label>Password (at least 8 characters)<input type="password" name="password" minlength="8" required autofocus autocomplete="new-password"></label>
<label>Type it again<input type="password" name="again" minlength="8" required autocomplete="new-password"></label>
<button>Create password</button></form>`);
}

export function loginPage(err) {
  return page('Sign in', `<form class="card" method="post" action="/login">
${err ? `<p class="err">${esc(err)}</p>` : ''}
<label>Server password<input type="password" name="password" required autofocus autocomplete="current-password"></label>
<label>Name for this device (optional)<input name="name" placeholder="e.g. Kitchen laptop"></label>
<button>Sign in</button></form>
<form class="card" method="post" action="/login/code">
<b>Signing in as someone else?</b>
<p class="muted" style="margin:0">If the server's owner added you, ask them for a code from <b>Pair a phone</b> and type it here. If you use this server through Cloudflare, get one yourself there: <b>Settings › Sync &amp; server › Get a code to sign in at home</b>. You'll see only your own budgets.</p>
<label>6-digit code<input name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="123 456" required></label>
<label>Name for this device (optional)<input name="name" placeholder="e.g. Sam's laptop"></label>
<button>Sign in with a code</button></form>`);
}

/**
 * The pairing page. Everyone signed in can pair their own phone or browser and see their devices.
 * The admin also manages people: add someone (with a budget of their own, or sharing one), show a
 * code for them, see and remove their devices, or remove them.
 * viewer: { id, admin, name }; people: [{ id, name, admin }]; budgets: the admin's [{ id, name }].
 */
export async function pairPage(origin, code, flash, viewer, people = [], budgets = [], forId = null) {
  const away = awayAddress();
  if (isPrivate(origin) && origin !== homeAddress()) setHomeAddress(origin);
  const home = isPrivate(origin) ? origin : homeAddress() || origin;
  // A camera app treats a budget:// link as text (and searches for it), so the QR code is an
  // ordinary web link to a small page on the server that opens Budget, or shows the code to type.
  const q = `u=${encodeURIComponent(home)}${away && away !== home ? `&a=${encodeURIComponent(away)}` : ''}&c=${code}`;
  const svg = await QRCode.toString(`${home}/pair/open?${q}`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  origin = home;
  const devs = listDevices(viewer.admin ? null : viewer.id);
  const who = Object.fromEntries(people.map(p => [p.id, p.name]));
  const when = t => new Date(t).toLocaleString();
  const forName = forId && forId !== viewer.id ? who[forId] : null;
  return page('Pair a phone', `
${flash ? `<p class="card" style="color:var(--pos);font-weight:600">${esc(flash)}</p>` : ''}
<div class="card">
${viewer.admin && people.length > 1 ? `<form method="get" action="/pair" style="display:flex;gap:8px;align-items:end"><label style="flex:1">Pair a phone or browser for<select name="for" style="font:inherit;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink)">${people.map(p => `<option value="${esc(p.id)}"${(forId || viewer.id) === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label><button>Show code</button></form>` : ''}
<p style="margin:0"><b>${forName ? `For ${esc(forName)}:` : 'On your phone:'}</b> connected to your home Wi-Fi, open the camera app, point it at this code and open the link. Then tap <b>Open in Once Budget</b>. (Or in Once Budget: Settings › Sync &amp; server › Pair with a code. In a browser: the sign-in page, Sign in with a code.)</p>
<div class="qr">${svg}</div>
<div class="code">${code.slice(0, 3)} ${code.slice(3)}</div>
<p class="muted" style="margin:0;text-align:center">Works once, for 10 minutes${forName ? `, and signs in as <b>${esc(forName)}</b>: they see only their own budgets` : ''}. Server address in the code: <b>${esc(origin)}</b>${away ? ` and <b>${esc(away)}</b> from away` : ''}</p>
<a class="btn ghost" href="/pair${forId ? `?for=${esc(forId)}` : ''}">New code</a>
</div>
${viewer.admin ? `<div class="card"><b>People</b>
<p class="muted" style="margin:0">Everyone who uses this server. Each person sees only the budgets they belong to; share a budget from Settings › Sync &amp; server in the app.</p>
${people.map(p => `<form class="dev" method="post" action="/people/remove"><span>${esc(p.name)} <span class="muted">· ${p.admin ? 'admin, knows the server password' : `${listDevices(p.id).length} device${listDevices(p.id).length === 1 ? '' : 's'}`}</span></span>${p.admin ? '' : `<input type="hidden" name="id" value="${esc(p.id)}"><a class="btn ghost" href="/pair?for=${esc(p.id)}">Code</a><button class="ghost" onclick="return confirm('Remove ${esc(p.name).replace(/'/g, '')}? Their phones and browsers are signed out. Budgets only they could open become yours.')">Remove</button>`}</form>`).join('')}
</div>
<form class="card" method="post" action="/people/add"><b>Add a person</b>
<label>Name<input name="name" required maxlength="40" placeholder="e.g. Sam"></label>
<label>Their budget<select name="budget" style="font:inherit;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink)"><option value="new">A new, empty budget of their own</option>${budgets.map(b => `<option value="${esc(b.id)}">Share: ${esc(b.name)}</option>`).join('')}</select></label>
<label>If sharing, what they can do<select name="role" style="font:inherit;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink)"><option value="spender">Add purchases (and change their own)</option><option value="viewer">View only</option><option value="member">Change everything</option></select></label>
<button>Add and show their code</button></form>` : ''}
${viewer.admin ? `<form class="card" method="post" action="/pair/home">
<b>Home address</b>
<p class="muted" style="margin:0">This server's address on your home network, for example http://192.168.1.10:8085. New phones pair here, because ${away ? 'your away address is behind Cloudflare, which turns a new phone away' : 'it works without any sign-in'}. It's filled in by itself when you open this page from that address.</p>
<input name="home" value="${esc(homeAddress())}" placeholder="http://192.168.1.10:8085">
<button>Save</button></form>` : ''}
${viewer.admin ? `<form class="card" method="post" action="/pair/away">
<b>Address from away (optional)</b>
<p class="muted" style="margin:0">How phones reach this server outside your home: a Tailscale address (e.g. http://100.64.1.2:8085) or your own domain. Paired phones get it too and switch automatically.</p>
<input name="away" value="${esc(away)}" placeholder="https://budget.example.com">
<button>Save</button></form>` : ''}
<div class="card"><b>${viewer.admin ? 'Devices with access' : 'Your devices'}</b>
${devs.map(d => `<form class="dev" method="post" action="/pair/remove"><span>${esc(d.name)} <span class="muted">· ${viewer.admin && who[d.user_id] ? `${esc(who[d.user_id])} · ` : ''}${d.kind} · last used ${esc(when(d.last_seen))}</span></span><input type="hidden" name="id" value="${esc(d.id)}"><button class="ghost">Remove</button></form>`).join('') || '<p class="muted">None yet.</p>'}
<p class="muted" style="margin:0">Removing a device signs it out; it can pair again with a new code.</p></div>
<a class="btn ghost" href="/">Back to your budget</a>`);
}

/** Where the QR code leads: opens Budget on the phone (or shows the address and code to type). */
export function pairOpenPage(u, a, code) {
  const q = `u=${encodeURIComponent(u)}${a ? `&a=${encodeURIComponent(a)}` : ''}&c=${code}`;
  const intent = `intent://pair?${q}#Intent;scheme=budget;package=com.righttoown.budget;end`;
  const c = String(code).replace(/\D/g, '');
  return page('Pair this phone', `<div class="card">
<p style="margin:0">Open Once Budget to connect it to this server.</p>
<a class="btn" id="open" href="${esc(intent)}">Open in Once Budget</a>
<p class="muted" style="margin:0">Doesn't open? In Once Budget: <b>Settings › Sync &amp; server › Pair with a code</b>, and enter:</p>
<p style="margin:0">Address <b>${esc(u)}</b></p>
<div class="code">${esc(c.slice(0, 3))} ${esc(c.slice(3))}</div>
<p class="muted" style="margin:0;text-align:center">Works once, for 10 minutes.</p></div>
<script>setTimeout(function(){ location.href = ${JSON.stringify(intent)}; }, 300);</script>`);
}
