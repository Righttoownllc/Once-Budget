import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db as sqlite, listHouseholds, renameHousehold, deleteHousehold } from './db.js';
import { personFor, userById, adminUser, makeAdmin, ROLES, setRole, canChangeAll, mayWrite, authorsOf, setColor, COLORS, ensureHome, roleIn, newHousehold, budgetsOf, membersOf, addMember, removeMember, dropHousehold, people, addPerson, removePerson, label } from './access.js';
import { epochOf, newEpoch } from './db.js';
import { db, SYNC_TABLES, upsert, softDelete, list, changesSince, transaction, backupNow, now, listBackups, restoreFrom, integrityCheck, lastIntegrity, hasDailyBackup } from './db.js';
import { auth, authMode, ownerOnly, adminOnly, cfEmail, HYBRID } from './auth.js';
import { hasPassword, setPassword, checkPassword, newDevice, deviceFor, removeDevice, newPairCode, takePairCode, awayAddress, setAwayAddress, homeAddress, setHomeAddress, isPrivate, pairOpenPage, allowed, failed, cookieFrom, sessionCookie, setupPage, loginPage, pairPage } from './pairing.js';
import { publicKey, subscribe as pushSubscribe, unsubscribe as pushUnsubscribe, subCount, remindDue, sendToHousehold } from './push.js';
import { accountBalances, monthView, spendingReport } from './budget.js';

const here = dirname(fileURLToPath(import.meta.url));
export const VERSION = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version;
const CHANGELOG = JSON.parse(readFileSync(join(here, '..', 'CHANGELOG.json'), 'utf8'));
const WEB_DIR = join(here, '..', 'web', 'dist');
const PORT = Number(process.env.PORT || 8080);

const app = new Hono();

app.get('/healthz', c => c.json({ ok: true, auth: authMode, version: VERSION }));
app.get('/api/version', c => c.json({ version: VERSION, changelog: CHANGELOG }));

// ---- AUTH_MODE=password: first-run password, browser sign-in, phone pairing (pairing.js) ----
if (authMode === 'password') {
  const ip = c => c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0].trim() || c.env?.incoming?.socket?.remoteAddress || '?';
  const secure = c => (c.req.header('x-forwarded-proto') || new URL(c.req.url).protocol.replace(':', '')) === 'https';
  const origin = c => `${c.req.header('x-forwarded-proto') || new URL(c.req.url).protocol.replace(':', '')}://${c.req.header('x-forwarded-host') || c.req.header('host')}`;
  const signedIn = c => deviceFor(cookieFrom(c.req.header('cookie')));
  const admin = () => adminUser() || personFor(process.env.LOCAL_USER_EMAIL || 'local@home');
  // The person a signed-in browser belongs to (devices from before people existed are the admin's).
  const viewerOf = d => { const u = d.user_id ? userById(d.user_id) : admin(); return u ? { id: u.id, admin: !!u.is_admin, name: label(u) } : null; };
  // Who is looking at a server page: a signed-in browser, or (Cloudflare accepted too) a Cloudflare sign-in.
  const viewer = async c => {
    const d = signedIn(c); if (d) return viewerOf(d);
    const e = HYBRID ? await cfEmail(c) : null; if (!e) return null;
    const u = personFor(e); return { id: u.id, admin: !!u.is_admin, name: label(u) };
  };
  const back = (msg, forId) => `/pair?ok=${encodeURIComponent(msg)}${forId ? `&for=${encodeURIComponent(forId)}` : ''}`;
  // Switching an existing Cloudflare server to password mode: the password is created through
  // Cloudflare, signed in as the admin, so nobody else on the network can claim the server first.
  // (A server whose admin has no email, or a new one, is set up from the home network as before.)
  // Switching an existing Cloudflare server to password mode: the password is created through
  // Cloudflare by someone who already owned the server's first (main) budget, and they become the
  // admin. Nobody else on the network, and no newcomer, can claim the server first.
  // (A new, empty server is set up from the home network as before.)
  const setupGate = async c => {
    if (!HYBRID) return null;
    const first = db.prepare('SELECT id FROM households ORDER BY created_at LIMIT 1').get();
    const known = db.prepare("SELECT COUNT(*) n FROM users WHERE email LIKE '%@%' AND email NOT LIKE 'person:%' AND email != ?").get(process.env.LOCAL_USER_EMAIL || 'local@home').n;
    if (!first || !known) return null;
    const e = await cfEmail(c);
    if (!e) return `This server already has budgets, so its password can only be created through your Cloudflare address (signed in), not from ${new URL(c.req.url).host}.`;
    const u = personFor(e);
    if (roleIn(first.id, u.id) !== 'owner') return `You're signed in to Cloudflare as ${e}, which isn't an owner of this server's main budget. Sign in as the person who set the server up.`;
    return u;
  };
  app.get('/setup', async c => { if (hasPassword()) return c.redirect('/login'); const g = await setupGate(c); return c.html(setupPage(typeof g === 'string' ? g : ''), typeof g === 'string' ? 403 : 200); });
  app.post('/setup', async c => {
    if (hasPassword()) return c.redirect('/login');
    const g = await setupGate(c); if (typeof g === 'string') return c.html(setupPage(g), 403);
    const f = await c.req.parseBody();
    const pw = String(f.password || '');
    if (pw.length < 8) return c.html(setupPage('Use at least 8 characters.'), 400);
    if (pw !== String(f.again || '')) return c.html(setupPage("The two passwords don't match."), 400);
    if (g) makeAdmin(g.id);   // whoever creates it through Cloudflare is the admin
    setPassword(pw);
    const d = newDevice('First browser', 'browser', admin().id);
    c.header('Set-Cookie', sessionCookie(d.token, secure(c)));
    // Next: the app's setup tutorial (accounts, paycheck, bills, everyday amounts), which ends with
    // connecting a phone. A server that already has a budget with accounts (moved or restored) goes
    // straight to the budget instead.
    const has = sqlite.prepare('SELECT COUNT(*) AS n FROM accounts a JOIN members m ON m.household_id = a.household_id WHERE m.user_id = ? AND a.deleted = 0').get(admin().id).n;
    return c.redirect(has ? '/#/budget' : '/#/setup');
  });
  app.get('/login', c => (!hasPassword() ? c.redirect('/setup') : c.html(loginPage())));
  app.post('/login', async c => {
    if (!allowed(ip(c), 'login')) return c.html(loginPage('Too many tries. Wait 10 minutes and try again.'), 429);
    const f = await c.req.parseBody();
    if (!checkPassword(String(f.password || ''))) { failed(ip(c), 'login'); return c.html(loginPage('That password is not right.'), 401); }
    const d = newDevice(String(f.name || '').trim() || (c.req.header('user-agent') || 'Browser').replace(/^.*\((?:[^;)]*;\s*)?([^;)]+).*$/, '$1').slice(0, 40), 'browser', admin().id);
    c.header('Set-Cookie', sessionCookie(d.token, secure(c)));
    return c.redirect('/');
  });
  // Someone the admin added signs a browser in with the code shown for them under Pair a phone.
  app.post('/login/code', async c => {
    if (!allowed(ip(c), 'pair')) return c.html(loginPage('Too many tries. Wait 10 minutes and try again.'), 429);
    const f = await c.req.parseBody();
    const got = takePairCode(f.code);
    if (!got) { failed(ip(c), 'pair'); return c.html(loginPage("That code isn't valid. Codes work once, for 10 minutes: ask for a new one."), 401); }
    const uid = got.user_id || admin().id;
    if (!userById(uid)) return c.html(loginPage('That person was removed from this server.'), 401);
    const d = newDevice(String(f.name || '').trim() || 'Browser', 'browser', uid);
    c.header('Set-Cookie', sessionCookie(d.token, secure(c)));
    return c.redirect('/');
  });
  app.get('/logout', c => { const d = signedIn(c); if (d) removeDevice(d.id); c.header('Set-Cookie', sessionCookie('', secure(c)).replace(/Max-Age=\d+/, 'Max-Age=0')); return c.redirect('/login'); });
  app.get('/pair', async c => {
    if (!hasPassword()) return c.redirect('/setup');
    const v = await viewer(c); if (!v) return c.redirect(signedIn(c) ? '/logout' : '/login');
    const forId = v.admin && userById(c.req.query('for') || '') ? c.req.query('for') : v.id;   // only the admin pairs for others
    const mine = v.admin ? budgetsOf(v.id).map(b => ({ id: b.id, name: b.name })) : [];
    return c.html(await pairPage(origin(c), newPairCode(forId), c.req.query('ok') || '', v, v.admin ? people() : [], mine, forId));
  });
  // The QR code's link: no sign-in needed (the code in it is the secret, and it works once).
  app.get('/pair/open', c => {
    const code = String(c.req.query('c') || '').replace(/\D/g, '').slice(0, 6);
    const u = String(c.req.query('u') || '');
    if (code.length !== 6 || !/^https?:\/\//.test(u)) return c.text('This pairing link is incomplete. Show a new code on Pair a phone.', 400);
    const a = String(c.req.query('a') || '');
    return c.html(pairOpenPage(u, /^https?:\/\//.test(a) ? a : '', code));
  });
  app.post('/pair/home', async c => { const v = await viewer(c); if (!v?.admin) return c.redirect('/login'); const f = await c.req.parseBody(); const u = String(f.home || '').trim().replace(/\/+$/, ''); if (u && !/^https?:\/\//.test(u)) return c.redirect(back('The home address must start with http:// or https://')); setHomeAddress(u); return c.redirect(back(u ? 'Home address saved' : 'Home address removed')); });
  app.post('/pair/away', async c => { const v = await viewer(c); if (!v) return c.redirect('/login'); if (!v.admin) return c.redirect(back('Only the admin can change the server address')); const f = await c.req.parseBody(); const u = String(f.away || '').trim().replace(/\/+$/, ''); if (u && !/^https?:\/\//.test(u)) return c.redirect(back('The away address must start with http:// or https://')); setAwayAddress(u); return c.redirect(back(u ? 'Away address saved' : 'Away address removed')); });
  app.post('/pair/remove', async c => { const v = await viewer(c); if (!v) return c.redirect('/login'); const f = await c.req.parseBody(); removeDevice(String(f.id || ''), v?.admin ? null : v?.id || '-'); return c.redirect(back('Device removed')); });
  app.post('/people/add', async c => {
    const v = await viewer(c); if (!v?.admin) return c.redirect('/login');
    const f = await c.req.parseBody();
    try { const p = addPerson(f.name, String(f.budget || 'new'), v.id, String(f.role || 'spender')); return c.redirect(back(`Added ${p.name}. Scan this code with their phone, or type it on their browser's sign-in page.`, p.id)); }
    catch (e) { return c.redirect(back(e.message)); }
  });
  app.post('/people/remove', async c => {
    const v = await viewer(c); if (!v?.admin) return c.redirect('/login');
    const f = await c.req.parseBody();
    try { const name = label(userById(String(f.id || ''))); removePerson(String(f.id || '')); return c.redirect(back(`Removed ${name}`)); }
    catch (e) { return c.redirect(back(e.message)); }
  });
  // The phone's side of pairing: a valid code buys a device key. No other sign-in needed.
  app.post('/api/pair', async c => {
    if (!hasPassword()) return c.json({ error: 'This server has no password yet. Open it in a browser first.' }, 409);
    if (!allowed(ip(c), 'pair')) return c.json({ error: 'Too many tries. Wait 10 minutes.' }, 429);
    const b = await c.req.json().catch(() => ({}));
    const got = takePairCode(b.code);
    if (!got) { failed(ip(c), 'pair'); return c.json({ error: "That code isn't valid. Codes work once, for 10 minutes: show a new one under Pair a phone." }, 401); }
    if (isPrivate(origin(c)) && !homeAddress()) setHomeAddress(origin(c));   // paired at home: that's the home address
    const d = newDevice(String(b.name || 'Phone').slice(0, 60), 'phone', got.user_id && userById(got.user_id) ? got.user_id : admin().id);
    return c.json({ token: d.token, away: awayAddress() || null, version: VERSION });
  });
  // HTML pages need a signed-in browser (assets and the API decide for themselves).
  app.use('*', async (c, next) => {
    const p = c.req.path;
    const isPage = c.req.method === 'GET' && !p.startsWith('/api/') && !p.startsWith('/assets/') && !/\.[a-z0-9]+$/i.test(p) || p === '/index.html';
    if (isPage && !signedIn(c) && !(HYBRID && await cfEmail(c))) return c.redirect(hasPassword() ? '/login' : '/setup');
    await next();
  });
}

const api = new Hono();
api.use('*', auth);

const me = u => ({ id: u.id, email: u.email.startsWith('person:') || u.email === (process.env.LOCAL_USER_EMAIL || 'local@home') ? null : u.email, name: label(u), is_admin: !!u.is_admin });
// shared: whether people here are told apart (open/local mode: one shared person for everyone).
// Password mode: who may create the server password when there isn't one yet. On a server that
// already has budgets, an owner of its first (main) budget, who then becomes the admin.
const mayCreatePassword = u => {
  if (authMode !== 'password' || hasPassword()) return false;
  const first = db.prepare('SELECT id FROM households ORDER BY created_at LIMIT 1').get();
  return !first || roleIn(first.id, u.id) === 'owner';
};
// cloudflare: whether Cloudflare sign-ins (and so sharing by email) work on this server.
api.get('/me', c => c.json({ user: me(c.get('user')), auth: authMode, budget: c.get('hh'), role: c.get('role'), separate: !c.get('shared'), password: authMode === 'password' ? { set: hasPassword(), canCreate: mayCreatePassword(c.get('user')), canChange: hasPassword() && !!c.get('user').is_admin, needCurrent: !(HYBRID && c.get('viaCf')), home: homeAddress() || null } : null, cloudflare: authMode === 'cloudflare' || HYBRID || (authMode === 'open' && !!process.env.CF_ACCESS_AUD) }));

// Budgets this person belongs to. Each is stored apart from the others (its own household), and
// all of them are in the nightly backup. Requests pick one with the X-Budget header.
const allBudgets = () => db.prepare("SELECT id, name, created_at, 'owner' AS role FROM households ORDER BY created_at").all();
api.get('/budgets', c => { const u = c.get('user'); return c.json({ main: u.household_id, list: listHouseholds(c.get('shared') ? allBudgets() : budgetsOf(u.id)) }); });
api.post('/budgets', async c => { const { name } = await c.req.json().catch(() => ({})); return c.json(newHousehold(name, c.get('user').id)); });
const ownerOf = (c, id) => (c.get('shared') ? !!db.prepare('SELECT 1 FROM households WHERE id = ?').get(id) : roleIn(id, c.get('user').id) === 'owner');
api.patch('/budgets/:id', async c => {
  if (!ownerOf(c, c.req.param('id'))) return c.json({ error: "Only this budget's owner can rename it." }, 403);
  const { name } = await c.req.json().catch(() => ({}));
  if (!name || !name.trim()) return c.json({ error: 'name required' }, 400);
  renameHousehold(c.req.param('id'), name); return c.json({ ok: true });
});
api.delete('/budgets/:id', async c => {
  const id = c.req.param('id'), u = c.get('user');
  if (!ownerOf(c, id)) return c.json({ error: "Only this budget's owner can delete it." }, 403);
  const { confirm } = await c.req.json().catch(() => ({}));
  if (confirm !== 'YES') return c.json({ error: 'confirm must be YES' }, 400);
  if ((c.get('shared') ? allBudgets() : budgetsOf(u.id)).length <= 1) return c.json({ error: "This is your only budget, so it can't be deleted. Erase it instead under Settings › Data." }, 400);
  try { return c.json(deleteHousehold(id, () => dropHousehold(id))); } catch (e) { return c.json({ error: e.message }, 400); }
});

// Who can open a budget. Everyone in it can see the list; owners add and remove people.
// Cloudflare (and open mode with Cloudflare sign-in): people are added by email; they see the budget
// when they first sign in. Password mode: people the admin added on the server's Pair a phone page.
const memberOk = (c, id) => ownerOf(c, id) || !!roleIn(id, c.get('user').id);
api.get('/budgets/:id/members', c => {
  if (!memberOk(c, c.req.param('id'))) return c.json({ error: 'no such budget' }, 404);
  const u = c.get('user');
  return c.json({ colors: COLORS, members: membersOf(c.req.param('id')).map(m => ({ ...m, you: m.id === u.id })), people: authMode === 'password' ? people().map(p => ({ id: p.id, name: p.name })) : null });
});
api.post('/budgets/:id/members', async c => {
  const id = c.req.param('id');
  if (!ownerOf(c, id)) return c.json({ error: "Only this budget's owner can share it." }, 403);
  const b = await c.req.json().catch(() => ({}));
  let person = null;
  if (b.person) person = authMode === 'password' ? userById(b.person) : null;
  else if (authMode === 'cloudflare' || authMode === 'open' || HYBRID) {
    const email = String(b.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: 'Type their email address, the one they sign in to Cloudflare with.' }, 400);
    person = personFor(email, { invitedTo: id });
  }
  if (!person) return c.json({ error: authMode === 'local' ? 'This server uses AUTH_MODE=local: everyone already shares every budget.' : 'Choose someone to share with.' }, 400);
  const was = roleIn(id, person.id);
  try {
    if (was) { if (ROLES.includes(b.role)) setRole(id, person.id, b.role); }
    else addMember(id, person.id, ROLES.includes(b.role) ? b.role : 'spender');
  } catch (e) { return c.json({ error: e.message }, 400); }
  return c.json({ ok: true, members: membersOf(id) });
});
api.delete('/budgets/:id/members/:uid', c => {
  const id = c.req.param('id'), uid = c.req.param('uid'), u = c.get('user');
  if (uid !== u.id && !ownerOf(c, id)) return c.json({ error: "Only this budget's owner can remove people." }, 403);
  if (uid === u.id && budgetsOf(u.id).length <= 1) return c.json({ error: "This is your only budget, so you can't leave it." }, 400);
  try { removeMember(id, uid); } catch (e) { return c.json({ error: e.message }, 400); }
  return c.json({ ok: true, members: membersOf(id) });
});
// Password mode: create the server password from the app (when there isn't one) or change it (the
// admin, with the current one). Same rules as the server's own setup page.
api.post('/server-password', async c => {
  if (authMode !== 'password') return c.json({ error: 'This server does not use a password.' }, 400);
  const u = c.get('user');
  const { password, current } = await c.req.json().catch(() => ({}));
  const pw = String(password || '');
  if (pw.length < 8) return c.json({ error: 'Use at least 8 characters.' }, 400);
  if (!hasPassword()) {
    if (!mayCreatePassword(u)) return c.json({ error: "Only an owner of this server's main budget can create its password." }, 403);
    makeAdmin(u.id); setPassword(pw);
    return c.json({ ok: true, created: true });
  }
  if (!u.is_admin) return c.json({ error: "Only the server's admin can change its password." }, 403);
  // Signed in through Cloudflare as the admin: Cloudflare already vouched for them, so a forgotten
  // password can be replaced without the old one.
  if (HYBRID && (await cfEmail(c)) === u.email) { setPassword(pw); return c.json({ ok: true, changed: true }); }
  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0].trim() || '?';
  if (!allowed(ip, 'login')) return c.json({ error: 'Too many tries. Wait 10 minutes and try again.' }, 429);
  if (!checkPassword(String(current || ''))) { failed(ip, 'login'); return c.json({ error: 'The current password is not right.' }, 403); }
  setPassword(pw);
  return c.json({ ok: true, changed: true });
});

// Password mode: a one-time pairing code for the person asking (it signs a device in as them).
// The app uses it when it's connected through Cloudflare and the home address refuses it for want
// of this phone's key: it fetches a code through Cloudflare and pairs at home by itself.
api.post('/pair-code', c => (authMode === 'password' && hasPassword() ? c.json({ code: newPairCode(c.get('user').id) }) : c.json({ error: authMode === 'password' ? 'Create the server password first (Settings › Sync & server › Server password).' : 'This server does not pair phones.' }, 400)));

// Who entered this budget's transactions (names and colours for the initials on each one).
api.get('/authors', c => c.json({ authors: authorsOf(c.get('hh')) }));
// Someone's colour in a budget: owners set anyone's, and everyone their own.
api.post('/budgets/:id/members/:uid/color', async c => {
  const id = c.req.param('id'), uid = c.req.param('uid');
  if (uid !== c.get('user').id && !ownerOf(c, id)) return c.json({ error: "Only this budget's owner can change someone else's colour." }, 403);
  if (!memberOk(c, id)) return c.json({ error: 'no such budget' }, 404);
  const { color } = await c.req.json().catch(() => ({}));
  if (color && !COLORS.includes(color)) return c.json({ error: 'Pick one of the colours shown.' }, 400);
  return setColor(id, uid, color || null) ? c.json({ ok: true }) : c.json({ error: 'Not in this budget' }, 404);
});

// Password mode: the admin's list of people, for sharing. Names only.
api.get('/people', c => c.json(authMode === 'password' ? people().map(p => ({ id: p.id, name: p.name })) : []));

// Full snapshot for first load / new device.
api.get('/bootstrap', c => {
  const hh = c.get('hh');
  const data = {};
  for (const t of SYNC_TABLES) data[t] = db.prepare(`SELECT * FROM ${t} WHERE household_id = ?`).all(hh);
  const cursor = db.prepare('SELECT COALESCE(MAX(seq),0) AS s FROM change_log WHERE household_id = ?').get(hh).s;
  return c.json({ cursor, data, version: VERSION, role: c.get('role'), actor: c.get('user').email, epoch: epochOf(hh) });
});

// Push local changes, pull everything newer than cursor.
api.post('/sync', async c => {
  const hh = c.get('hh');
  const body = await c.req.json();
  const cursor = Number(body.cursor || 0);
  const incoming = body.changes || {};
  const applied = {};
  let conflicts = 0;
  const role = c.get('role'), actor = c.get('user').email;
  // Changes this person's level doesn't allow are refused; the server's own version of each such
  // row goes back (current), or none if it never existed here, so the device puts it back.
  const refused = {}, current = {};
  transaction(() => {
    for (const t of SYNC_TABLES) {
      applied[t] = 0;
      for (const row of incoming[t] || []) {
        if (!row || !row.id) continue;
        const prev = db.prepare(`SELECT * FROM ${t} WHERE id = ? AND household_id = ?`).get(row.id, hh);
        if (!mayWrite(role, actor, t, prev)) { (refused[t] ||= []).push(row.id); if (prev) (current[t] ||= []).push(prev); continue; }
        const r = upsert(t, row, hh, actor); if (r.conflict) conflicts++; else applied[t]++;
      }
    }
  });
  return c.json({ applied, conflicts, refused, current, role, actor, epoch: epochOf(hh), version: VERSION, ...changesSince(hh, cursor) });
});

// Simple REST for scripting / curl testing.
const rowOk = (c, t, id) => mayWrite(c.get('role'), c.get('user').email, t, id ? db.prepare(`SELECT * FROM ${t} WHERE id = ? AND household_id = ?`).get(id, c.get('hh')) : undefined);
const notAllowed = c => c.json({ error: c.get('role') === 'viewer' ? 'You can view this budget but not change it.' : 'You can add purchases in this budget, and change the ones you added. Ask an owner for anything else.' }, 403);
/** Route guard: people who can change everything in the budget (owners and members). */
const editorsOnly = async (c, next) => (canChangeAll(c.get('role')) ? next() : notAllowed(c));
for (const t of SYNC_TABLES) {
  api.get(`/${t}`, c => c.json(list(t, c.get('hh'))));
  api.post(`/${t}`, async c => { const b = await c.req.json(); return rowOk(c, t, b.id) ? c.json(upsert(t, b, c.get('hh'), c.get('user').email)) : notAllowed(c); });
  api.put(`/${t}/:id`, async c => (rowOk(c, t, c.req.param('id')) ? c.json(upsert(t, { ...(await c.req.json()), id: c.req.param('id'), updated_at: now() }, c.get('hh'), c.get('user').email)) : notAllowed(c)));
  api.delete(`/${t}/:id`, c => (rowOk(c, t, c.req.param('id')) ? c.json(softDelete(t, c.req.param('id'), c.get('hh'))) : notAllowed(c)));
}

// Convenience: create both legs of a transfer in one call.
api.post('/transfer', async (c, next) => (c.get('role') === 'viewer' ? notAllowed(c) : next()), async c => {
  const hh = c.get('hh');
  const { from_account_id, to_account_id, amount, date, memo = '' } = await c.req.json();
  const transfer_id = crypto.randomUUID();
  const ts = now();
  transaction(() => {
    upsert('transactions', { account_id: from_account_id, date, amount: -Math.abs(amount), memo, transfer_id, payee: 'Transfer', updated_at: ts }, hh);
    upsert('transactions', { account_id: to_account_id, date, amount: Math.abs(amount), memo, transfer_id, payee: 'Transfer', updated_at: ts }, hh);
  });
  return c.json({ transfer_id });
});

api.get('/balances', c => c.json(accountBalances(c.get('hh'))));
api.get('/budget/:month', c => c.json(monthView(c.get('hh'), c.req.param('month'))));
api.get('/reports/spending', c => c.json(spendingReport(c.get('hh'), c.req.query())));

// Reconcile: mark all cleared transactions up to today as reconciled, snapshot balance.
api.post('/accounts/:id/reconcile', editorsOnly, async c => {
  const hh = c.get('hh');
  const id = c.req.param('id');
  const { balance } = await c.req.json();   // statement balance in cents
  const ts = now();
  transaction(() => {
    db.prepare(`UPDATE transactions SET cleared = 2, updated_at = ? WHERE household_id = ? AND account_id = ? AND cleared = 1 AND deleted = 0`).run(ts, hh, id);
    for (const r of db.prepare('SELECT id FROM transactions WHERE account_id = ? AND updated_at = ?').all(id, ts))
      db.prepare('INSERT INTO change_log (household_id, tbl, row_id, at) VALUES (?,?,?,?)').run(hh, 'transactions', r.id, ts);
    upsert('accounts', { id, reconciled_balance: balance, reconciled_at: ts, updated_at: ts }, hh);
  });
  return c.json({ ok: true });
});

// Push reminders
api.get('/push/key', c => c.json({ key: publicKey(), subscribed: subCount(c.get('hh')) }));
api.post('/push/subscribe', async c => { const sub = await c.req.json(); return c.json({ id: pushSubscribe(c.get('hh'), c.get('user').email, sub) }); });
api.post('/push/unsubscribe', async c => { const { endpoint } = await c.req.json(); pushUnsubscribe(c.get('hh'), endpoint); return c.json({ ok: true }); });
api.post('/push/test', async c => c.json({ sent: await sendToHousehold(c.get('hh'), { title: 'Budget reminders are on', body: 'You\'ll get a note the morning a scheduled bill is due.', url: '/#/budget', tag: 'test' }) }));

// Backups: list, restore, integrity
api.get('/backups', ownerOnly, c => c.json(listBackups(c.get('hh'))));
api.post('/restore', ownerOnly, async c => {
  const { file, confirm } = await c.req.json();
  if (confirm !== 'YES') return c.json({ error: 'confirm must be YES' }, 400);
  try { return c.json(restoreFrom(file, c.get('hh'))); } catch (e) { return c.json({ error: e.message }, 400); }
});
api.get('/integrity', c => c.json(lastIntegrity(c.get('hh'))));
api.post('/integrity/run', editorsOnly, c => c.json(integrityCheck(c.get('hh'))));

// Full reset: wipes every row for this household (all tables + change log) after a
// safety backup. Nothing is re-seeded, so an import afterwards has no duplicates.
api.post('/reset', ownerOnly, async c => {
  const hh = c.get('hh');
  const { confirm } = await c.req.json();
  if (confirm !== 'YES') return c.json({ error: 'confirm must be YES' }, 400);
  const backup = backupNow();
  transaction(() => {
    for (const t of SYNC_TABLES) db.prepare(`DELETE FROM ${t} WHERE household_id = ?`).run(hh);
    db.prepare('DELETE FROM change_log WHERE household_id = ?').run(hh);
  });
  newEpoch(hh);
  return c.json({ ok: true, backup });
});

// Backup / export / import
api.post('/backup', editorsOnly, c => c.json({ file: backupNow() }));
api.get('/export', c => {
  const hh = c.get('hh');
  const data = {};
  for (const t of SYNC_TABLES) data[t] = db.prepare(`SELECT * FROM ${t} WHERE household_id = ? AND deleted = 0`).all(hh);
  c.header('Content-Disposition', `attachment; filename="budget-export-${new Date().toISOString().slice(0, 10)}.json"`);
  return c.json({ version: 1, exported_at: now(), data });
});
api.post('/import', editorsOnly, async c => {
  const hh = c.get('hh');
  const { data } = await c.req.json();
  let n = 0;
  transaction(() => {
    for (const t of SYNC_TABLES) for (const row of data?.[t] || []) { upsert(t, { ...row, updated_at: now() }, hh); n++; }
  });
  return c.json({ imported: n });
});

// The UI files the Android app downloads to update its screens without a new APK. Only the app's
// own files are listed (no service worker or PWA manifest), each with a checksum the app verifies.
const WEB_PKG = existsSync(join(here, '..', 'web', 'package.json')) ? JSON.parse(readFileSync(join(here, '..', 'web', 'package.json'), 'utf8')) : {};
let uiManifest = null;
function buildUiManifest() {
  if (!existsSync(WEB_DIR)) return null;
  const files = [];
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = full.slice(WEB_DIR.length + 1).split('\\').join('/');
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (/^(sw\.js|sw\.mjs|registerSW\.js|manifest\.webmanifest)$/.test(rel) || rel.startsWith('workbox-') || rel.endsWith('.woff')) continue;
      const buf = readFileSync(full);
      files.push({ path: rel, size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') });
    }
  };
  walk(WEB_DIR);
  return { version: VERSION, minBridge: Number(WEB_PKG.minBridge || 1), files };
}
api.get('/app/manifest', c => c.json(uiManifest ||= buildUiManifest() || { version: VERSION, minBridge: 1, files: [] }));

app.route('/api', api);

// Static PWA with SPA fallback.
if (existsSync(WEB_DIR)) {
  // Never let a CDN (Cloudflare caches .js by default) or the browser hold on to the files
  // that decide which build is running. Hashed /assets/* are safe to cache forever.
  app.use('/*', async (c, next) => {
    await next();
    const p = c.req.path;
    // no-transform: proxies (Cloudflare's script injection, email obfuscation...) must hand over the files
    // byte for byte; the Android app checks every one against /api/app/manifest.
    if (p.startsWith('/assets/')) c.header('Cache-Control', 'public, max-age=31536000, immutable, no-transform');
    else if (p === '/' || p === '/index.html' || p === '/sw.js' || p === '/registerSW.js' || p === '/manifest.webmanifest' || p.startsWith('/workbox-'))
      c.header('Cache-Control', 'no-cache, no-store, must-revalidate, no-transform');
    else c.header('Cache-Control', 'no-cache, no-transform');
  });
  app.use('/*', serveStatic({ root: WEB_DIR.replace(process.cwd() + '/', '') }));
  const index = readFileSync(join(WEB_DIR, 'index.html'), 'utf8');
  app.get('*', c => { c.header('Cache-Control', 'no-cache, no-store, must-revalidate, no-transform'); return c.html(index); });
} else {
  app.get('/', c => c.text('API running. Web build not found in web/dist.'));
}

// Scheduled jobs (server local time, so set TZ in the compose file):
//  from 03:00 the day's backup + integrity check (catches up if the server was off at 3);
//  08:00 "due today" push reminders. Backups are kept 14 days (KEEP_DAYS).
const REMIND_HOUR = Number(process.env.REMIND_HOUR || 8);
setInterval(() => {
  const d = new Date();
  if (d.getHours() >= 3 && !hasDailyBackup()) {
    backupNow('daily');
    for (const h of db.prepare('SELECT id FROM households').all()) { try { integrityCheck(h.id); } catch (e) { console.error('integrity', e); } }
  }
  if (d.getHours() === REMIND_HOUR && d.getMinutes() === 0) {
    const iso = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    remindDue(iso).then(n => n && console.log(`sent ${n} due reminders`)).catch(e => console.error('remind', e));
  }
}, 60_000);

serve({ fetch: app.fetch, port: PORT }, () => console.log(`budget v${VERSION} on :${PORT} (auth=${authMode}, data=${process.env.DATA_DIR || 'default'})`));
