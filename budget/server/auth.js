import { hasPassword, deviceFor, cookieFrom } from './pairing.js';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { personFor, userById, adminUser, roleIn, ensureHome } from './access.js';
import { adoptDevices } from './pairing.js';
import { db } from './db.js';

// AUTH_MODE=open       -> no login of its own; protect the server however you like (LAN only,
//                         VPN, Cloudflare Access...). A Cloudflare Access token, when present and
//                         CF_ACCESS_TEAM/AUD are set, is still verified and names who made a change.
// AUTH_MODE=password   -> one server password (set on first visit); each browser/phone holds its
//                         own device key (cookie or Authorization: Bearer). See pairing.js.
// AUTH_MODE=local      -> everyone is LOCAL_USER_EMAIL (LAN testing)
// AUTH_MODE=cloudflare -> require a valid Cloudflare Access JWT on every request
const MODE = process.env.AUTH_MODE || 'open';
const TEAM = process.env.CF_ACCESS_TEAM;   // e.g. "myteam" for myteam.cloudflareaccess.com
const AUD = process.env.CF_ACCESS_AUD;     // Application Audience tag from Zero Trust
const LOCAL_EMAIL = process.env.LOCAL_USER_EMAIL || 'local@home';

// Password mode with CF_ACCESS_TEAM and CF_ACCESS_AUD set: home (no Cloudflare) uses the server
// password and paired devices, and a verified Cloudflare sign-in (away) is accepted as that person.
export const HYBRID = MODE === 'password' && !!TEAM && !!AUD;
// CF_ACCESS_CERTS: only for testing against a stand-in key server; normally left unset.
const certs = () => new URL(process.env.CF_ACCESS_CERTS || `https://${TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`);
let jwks;
if ((MODE === 'open' || HYBRID) && TEAM && AUD) {
  jwks = createRemoteJWKSet(certs());
} else if (MODE === 'cloudflare') {
  if (!TEAM) throw new Error('AUTH_MODE=cloudflare needs CF_ACCESS_TEAM');
  if (!AUD) console.warn('CF_ACCESS_AUD is not set. Open the app through Cloudflare once and the log will print the value to use.');
  jwks = createRemoteJWKSet(certs());
}
/** The email of a verified Cloudflare Access sign-in on this request, or null. */
export async function cfEmail(c) {
  if (!jwks || !AUD) return null;
  const token = c.req.header('cf-access-jwt-assertion') || getCookie(c.req.header('cookie'), 'CF_Authorization');
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: `https://${TEAM}.cloudflareaccess.com`, audience: AUD });
    return payload.email ? String(payload.email).toLowerCase() : null;
  } catch { return null; }
}
// Read the aud claim without verifying — only used to help the admin discover it.
const peekAud = token => { try { const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); return Array.isArray(p.aud) ? p.aud[0] : p.aud; } catch { return null; } };

export async function auth(c, next) {
  let email;
  if (MODE === 'local') {
    email = LOCAL_EMAIL;
  } else if (MODE === 'password') {
    if (!hasPassword()) {   // Cloudflare sign-ins keep working while the password isn't created yet
      const e = HYBRID ? await cfEmail(c) : null;
      if (e) { c.set('viaCf', true); return pick(c, personFor(e), next); }
      return c.json({ error: 'setup', message: 'Open this server in a browser to create its password.' }, 401);
    }
    const bearer = (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '');
    const dev = deviceFor(bearer || cookieFrom(c.req.header('cookie')));
    if (!dev) {
      const e = HYBRID ? await cfEmail(c) : null;   // away, through Cloudflare, without a paired key
      if (e) { c.set('viaCf', true); return pick(c, personFor(e), next); }
      return c.json({ error: 'unauthenticated', needsLogin: true }, 401);
    }
    c.set('device', dev);
    // A paired device is its person; devices from before people existed belong to the admin.
    let person = dev.user_id ? userById(dev.user_id) : null;
    if (!person && !dev.user_id) { person = adminUser() || personFor(LOCAL_EMAIL); adoptDevices(person.id); }
    if (!person) return c.json({ error: 'unauthenticated', needsLogin: true }, 401);   // the person was removed
    return pick(c, ensureHome(person), next);
  } else if (MODE === 'open') {
    const token = c.req.header('cf-access-jwt-assertion') || getCookie(c.req.header('cookie'), 'CF_Authorization');
    email = LOCAL_EMAIL;
    if (token && jwks) {
      try {
        const { payload } = await jwtVerify(token, jwks, { issuer: `https://${TEAM}.cloudflareaccess.com`, audience: AUD });
        if (payload.email) email = payload.email;
      } catch {
        return c.json({ error: 'invalid token' }, 401);   // a token that fails is never treated as "no token"
      }
    }
  } else {
    const token = c.req.header('cf-access-jwt-assertion') || getCookie(c.req.header('cookie'), 'CF_Authorization');
    if (!token) return c.json({ error: 'unauthenticated' }, 401);
    if (!AUD) {
      const aud = peekAud(token);
      const msg = aud ? `Add to docker-compose.yml:  - CF_ACCESS_AUD=${aud}   then Compose Up.` : 'Could not read the Access token.';
      console.warn('[setup] ' + msg);
      return c.json({ error: 'setup', message: msg, aud }, 503);
    }
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: `https://${TEAM}.cloudflareaccess.com`,
        audience: AUD,
      });
      email = payload.email;
    } catch (e) {
      return c.json({ error: 'invalid token' }, 401);
    }
    if (!email) return c.json({ error: 'no email in token' }, 401);
  }
  // local, and open without a Cloudflare sign-in: one shared person, so no separation at all.
  if (email === LOCAL_EMAIL && (MODE === 'local' || MODE === 'open')) {
    const known = db.prepare('SELECT 1 FROM users WHERE email = ?').get(email);
    const first = db.prepare('SELECT id FROM households ORDER BY created_at LIMIT 1').get();
    return pick(c, known || !first ? personFor(email) : personFor(email, { invitedTo: first.id }), next, true);
  }
  return pick(c, personFor(email.toLowerCase()), next);
}

// Which budget this request is for: the X-Budget header (the app and browser send it for budgets
// other than your main one), otherwise your main budget. Only budgets the person belongs to: any
// other id answers exactly like one that doesn't exist, so nobody learns what else is on the server.
async function pick(c, user, next, shared = false) {
  c.set('user', user);
  c.set('shared', shared);
  const want = c.req.header('x-budget') || user.household_id;
  const role = shared ? (db.prepare('SELECT 1 FROM households WHERE id = ?').get(want) ? 'owner' : null) : roleIn(want, user.id);
  if (!role) return c.json({ error: 'no such budget', budget: want }, 404);
  c.set('hh', want);
  c.set('role', role);
  await next();
}

/** Route guard: only the budget's owners. */
export const ownerOnly = async (c, next) => (c.get('role') === 'owner' ? next() : c.json({ error: "Only this budget's owner can do that." }, 403));
/** Route guard: only the server's admin (password mode: whoever knows the server password). */
export const adminOnly = async (c, next) => (c.get('user')?.is_admin ? next() : c.json({ error: "Only the server's admin can do that." }, 403));

function getCookie(header, name) {
  if (!header) return null;
  const m = header.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

export const authMode = MODE;
