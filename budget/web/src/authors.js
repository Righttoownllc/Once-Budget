// Who entered each transaction, by name and colour (from your server; remembered for offline).
// Transactions record their author as created_by: an email, or an id for someone added on the
// server's Pair a phone page, which only the server can turn into a name.
import { useEffect, useState } from 'preact/hooks';
import { apiFetch, isLocal } from './platform.js';
import { getMeta, setMeta } from './store.js';

let authors = null, fetched = 0;
const listeners = new Set();
const set = a => { authors = a; listeners.forEach(fn => fn(a)); };
getMeta('authors').then(v => { if (v && !authors) set(v); }).catch(() => {});

export async function refreshAuthors(force = false) {
  if (isLocal() || (!force && Date.now() - fetched < 5 * 60_000)) return;
  fetched = Date.now();
  try {
    const r = await apiFetch('/api/authors');
    if (!r.ok) return;
    const a = (await r.json()).authors || {};
    set(a); setMeta('authors', a).catch(() => {});
  } catch {}
}

const initialsOf = name => (name || '').split('@')[0].replace(/[^\p{L}\p{N}]/gu, ' ').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
/** { name, initials, color } for a created_by value. */
export function author(key) {
  const a = authors?.[key];
  const name = a?.name || (String(key).startsWith('person:') ? 'Someone' : key);
  return { name, initials: initialsOf(name), color: a?.color || null };
}

/** Re-renders when names or colours arrive. */
export function useAuthors() {
  const [, tick] = useState(0);
  useEffect(() => { const fn = () => tick(x => x + 1); listeners.add(fn); refreshAuthors(); return () => listeners.delete(fn); }, []);
  return author;
}
