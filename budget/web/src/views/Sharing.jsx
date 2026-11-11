import { useEffect, useState } from 'preact/hooks';
import { useUI } from '../main.jsx';
import { apiFetch, isNative } from '../platform.js';
import { ask } from '../dialog.js';
import { Help } from './Info.jsx';
import { refreshAuthors } from '../authors.js';
import { Select } from './Pick.jsx';

// The levels a budget can be shared at (the server enforces them).
export const LEVELS = [
  ['owner', 'Owner', 'Everything, including sharing, renaming, erasing and restoring it'],
  ['member', 'Change everything', 'Accounts, categories, money, schedules and rules'],
  ['spender', 'Add purchases', 'Adds purchases and changes the ones they added; nothing else'],
  ['viewer', 'View only', 'Sees everything, changes nothing'],
];
const levelOf = r => LEVELS.find(l => l[0] === r) || LEVELS[1];
const call = async (path, opts = {}) => {
  const r = await apiFetch(path, { ...opts, headers: { 'content-type': 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Server answered ' + r.status);
  return j;
};

/**
 * Who can open this budget (Settings › Sync & server). How people are told apart depends on the
 * server's AUTH_MODE: Cloudflare by email, password by the people its admin added, and open or
 * local not at all (everyone who reaches the server sees every budget, which this says plainly).
 */
export function SharingCard({ me }) {
  const ui = useUI();
  const [info, setInfo] = useState(null);
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState('');
  const [person, setPerson] = useState('');
  const [busy, setBusy] = useState(false);
  const [level, setLevelPick] = useState('spender');
  const [coloring, setColoring] = useState(null);   // member id whose colour is being picked
  const hh = me?.budget, owner = me?.role === 'owner';
  const load = () => call(`/api/budgets/${hh}/members`).then(setInfo).catch(() => setInfo(null));
  useEffect(() => { if (me?.separate && hh) load(); }, [hh, me?.separate]);
  if (!me) return null;

  if (!me.separate) return (
    <div class="card sharing">
      <span class="eyebrow">Who can open this budget <Help k="sharing" /></span>
      <span class="head">Everyone who can reach your server can open every budget on it: it runs with <b>AUTH_MODE={me.auth}</b>, which doesn't tell people apart. That's fine for one household on a home network. To give people their own budgets, switch the server to <b>password</b> (home network) or <b>cloudflare</b> (from anywhere).</span>
    </div>
  );
  if (!info) return null;

  const run = async (fn, msg) => { setBusy(true); try { const j = await fn(); if (msg) ui.toast(msg); await load(); return j; } catch (e) { ui.toast(e.message); } finally { setBusy(false); } };
  const share = () => run(async () => {
    await call(`/api/budgets/${hh}/members`, { method: 'POST', body: JSON.stringify(person ? { person, role: level } : { email: email.trim(), role: level }) });
    setAdding(false); setEmail(''); setPerson('');
  }, 'Shared');
  const remove = async m => {
    const self = m.you;
    if (!(await ask(self ? "You won't see it on the server any more. A copy stays on this device." : `${m.label} won't be able to open this budget any more. Their own budgets aren't touched.`, { title: self ? 'Leave this budget?' : `Stop sharing with ${m.label}?`, ok: self ? 'Leave' : 'Stop sharing', danger: true }))) return;
    run(() => call(`/api/budgets/${hh}/members/${m.id}`, { method: 'DELETE' }), self ? 'You left this budget' : `Stopped sharing with ${m.label}`);
  };
  const setColor = (m, color) => run(async () => { await call(`/api/budgets/${hh}/members/${m.id}/color`, { method: 'POST', body: JSON.stringify({ color }) }); setColoring(null); refreshAuthors(true); });
  const initials = n => (n || '').split('@')[0].replace(/[^\p{L}\p{N}]/gu, ' ').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
  const setLevel = (m, role) => run(() => call(`/api/budgets/${hh}/members`, { method: 'POST', body: JSON.stringify(me.auth === 'password' && !m.email ? { person: m.id, role } : { email: m.email, role }) }), `${m.label}: ${levelOf(role)[1]}`);
  const ids = new Set(info.members.map(m => m.id));
  const choices = (info.people || []).filter(p => !ids.has(p.id));

  return (
    <div class="card sharing">
      <span class="eyebrow">Who can open this budget <Help k="sharing" /></span>
      {info.members.map(m => (
        <div class="memrow" key={m.id}>
        <div class="row between" style="gap:8px">
          <button type="button" class="who tinted big" style={`background:${m.color}`} disabled={!(owner || m.you) || busy}
            aria-label={owner || m.you ? `${m.label}'s colour: change it` : `${m.label}'s colour`} onClick={() => setColoring(coloring === m.id ? null : m.id)}>{initials(m.label)}</button>
          <span class="col" style="min-width:0;flex:1"><b>{m.label}{m.you ? ' (you)' : ''}</b>
            {owner && !m.you
              ? <Select class="levelpick" aria-label={`What ${m.label} can do`} value={m.role} disabled={busy} onChange={e => setLevel(m, e.target.value)}>{LEVELS.map(([k, l]) => <option value={k}>{l}</option>)}</Select>
              : <span class="head"><b>{levelOf(m.role)[1]}</b>: {levelOf(m.role)[2]}</span>}</span>
          <span class="row" style="gap:4px;flex:none">
            {(owner || m.you) && info.members.length > 1 && !(m.you && m.role === 'owner' && info.members.filter(x => x.role === 'owner').length < 2) && <button class="ghost small neg" disabled={busy} onClick={() => remove(m)}>{m.you ? 'Leave' : 'Remove'}</button>}
          </span>
        </div>
        {coloring === m.id && (
          <div class="swatches" role="radiogroup" aria-label={`Colour for ${m.label}`}>
            {(info.colors || []).map(c => <button type="button" role="radio" aria-checked={c === m.color} aria-label={c} class={'swatch' + (c === m.color ? ' on' : '')} style={`background:${c}`} onClick={() => setColor(m, c)} />)}
            <span class="head" style="flex-basis:100%">The colour of {m.you ? 'your' : `${m.label}'s`} initials on transactions in this budget.</span>
          </div>
        )}
        </div>
      ))}
      {owner && !adding && <button disabled={busy} onClick={() => setAdding(true)}>+ Share this budget</button>}
      {owner && adding && <>
        {me.auth === 'password' && choices.length > 0 && (
          <label class="field"><span class="lbl">Share with</span>
            <Select value={person} onChange={e => { setPerson(e.target.value); setEmail(''); }}><option value="">Choose a person…</option>{choices.map(p => <option value={p.id}>{p.name}</option>)}</Select></label>
        )}
        {(me.auth !== 'password' || me.cloudflare) && <>
          <label class="field"><span class="lbl">{me.auth === 'password' ? 'Or email' : 'Email'}</span><input type="email" inputMode="email" autocomplete="off" placeholder="the email they sign in to Cloudflare with" value={email} onInput={e => { setEmail(e.target.value); setPerson(''); }} /></label>
          <span class="head">They see this budget the next time they open your server. Your Cloudflare Access policy must let their email in too.</span>
        </>}
        {me.auth === 'password' && <span class="head">Someone new who won't use Cloudflare? {isNative ? "On your server's Pair a phone page (in a browser)" : <a href="/pair" class="link">On Pair a phone</a>}, Add a person gives them a code to sign in with.</span>}
        <label class="field"><span class="lbl">They can</span>
          <Select value={level} onChange={e => setLevelPick(e.target.value)}>{LEVELS.filter(l => l[0] !== 'owner').map(([k, l]) => <option value={k}>{l}</option>)}</Select></label>
        <span class="head">{levelOf(level)[2]}. You can change this any time.</span>
        <div class="row"><button class="ghost" onClick={() => setAdding(false)}>Cancel</button><button class="primary" style="flex:1" disabled={(!person && !email.includes('@')) || busy} onClick={share}>Share</button></div>
      </>}
      {!owner && <span class="head">Only an owner can share this budget or change who's in it.</span>}
    </div>
  );
}

/**
 * Password mode: create the server password from here when there isn't one (an owner of the main
 * budget, who becomes the admin), or change it (the admin, with the current one). Phones and
 * browsers already signed in stay signed in; the password is only for signing in again.
 */
export function ServerPasswordCard({ me, onDone }) {
  const ui = useUI();
  const [open, setOpen] = useState(false);
  const [cur, setCur] = useState(''), [pw, setPw] = useState(''), [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const p = me?.password;
  if (!p || (!p.canCreate && !p.canChange)) return null;
  const creating = !p.set;
  const bad = pw.length < 8 ? 'At least 8 characters' : pw !== again ? "The two don't match" : '';
  const save = async () => {
    setBusy(true);
    try {
      await call('/api/server-password', { method: 'POST', body: JSON.stringify({ password: pw, current: cur }) });
      ui.toast(creating ? 'Server password created. You can now sign in at home and pair phones.' : 'Server password changed');
      setOpen(false); setCur(''); setPw(''); setAgain(''); onDone && onDone();
    } catch (e) { ui.toast(e.message); }
    setBusy(false);
  };
  return (
    <div class="card form">
      <span class="eyebrow">Server password</span>
      <span class="head">{creating
        ? "Your server doesn't have a password yet. Create one to sign in to it at home (its local address) and to pair phones there. You become the server's admin."
        : 'Signs browsers in to your server at home. Phones and browsers already signed in stay signed in.'}</span>
      {!open ? <button class={creating ? 'primary' : ''} onClick={() => setOpen(true)}>{creating ? 'Create server password' : 'Change server password'}</button> : <>
        {!creating && p.needCurrent && <label>Current password<input type="password" autocomplete="current-password" value={cur} onInput={e => setCur(e.target.value)} /></label>}
        <label>{creating ? 'Password' : 'New password'} <span class="head">(at least 8 characters)</span><input type="password" autocomplete="new-password" value={pw} onInput={e => setPw(e.target.value)} /></label>
        <label>Type it again<input type="password" autocomplete="new-password" value={again} onInput={e => setAgain(e.target.value)} /></label>
        {pw && bad && <span class="head neg">{bad}</span>}
        <span class="head">Write it down somewhere safe.{me.cloudflare ? ' If you forget it, open your server through Cloudflare, signed in as yourself, and set a new one here without the old one.' : ' There\'s no "forgot password".'}</span>
        <div class="row"><button class="ghost" onClick={() => setOpen(false)}>Cancel</button><button class="primary" style="flex:1" disabled={!!bad || (!creating && p.needCurrent && !cur) || busy} onClick={save}>{creating ? 'Create' : 'Change'}</button></div>
      </>}
    </div>
  );
}

/**
 * Opened through Cloudflare on a server that also has a password: a one-time code to sign a browser
 * in at the home address (where Cloudflare isn't in the way) as this same person.
 */
export function HomeCodeCard({ me }) {
  const ui = useUI();
  const [code, setCode] = useState(null);
  if (!me?.password?.set || !me.cloudflare || !me.separate) return null;
  const get = async () => { try { setCode((await call('/api/pair-code', { method: 'POST' })).code); } catch (e) { ui.toast(e.message); } };
  return (
    <div class="card form">
      <span class="eyebrow">Signing in at home</span>
      <span class="head">At your server's home address{me.password.home ? <> (<b>{me.password.home}</b>)</> : ''}, a browser signs in without Cloudflare. Without the server password, use a one-time code: it signs that browser in as you, with your budgets.</span>
      {!code ? <button onClick={get}>Get a code to sign in at home</button> : <>
        <div class="homecode">{code.slice(0, 3)} {code.slice(3)}</div>
        <span class="head">On the home address's sign-in page, under <b>Sign in with a code</b>. Works once, for 10 minutes.</span>
        <button class="ghost" onClick={get}>New code</button>
      </>}
    </div>
  );
}
