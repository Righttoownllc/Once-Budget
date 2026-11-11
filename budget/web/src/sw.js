/* Custom service worker: Workbox precache for the app shell + push notifications. */
import { precacheAndRoute, createHandlerBoundToURL, cleanupOutdatedCaches } from 'workbox-precaching';
import { registerRoute, NavigationRoute } from 'workbox-routing';
import { NetworkOnly } from 'workbox-strategies';

self.skipWaiting();
self.addEventListener('activate', () => self.clients.claim());
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// API is never cached; the app keeps its own copy in IndexedDB.
registerRoute(({ url }) => url.pathname.startsWith('/api/'), new NetworkOnly());
// SPA fallback for navigations. Cloudflare Access's own pages (/cdn-cgi/…, e.g. the app's
// browser sign-in) must reach Cloudflare, and the server's own pages (password setup, sign-in,
// Pair a phone) must reach the server, not be answered with the cached app. (Workbox matches the
// path with its ?query, so /pair?for=… must match too.)
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/api\//, /^\/cdn-cgi\//, /^\/(setup|login|logout|pair|people)([/?#]|$)/] }));

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'Once Budget', body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Once Budget', {
    body: data.body || '', tag: data.tag || 'budget', icon: '/icon.svg', badge: '/icon.svg',
    data: { url: data.url || '/' }, vibrate: [40, 30, 40],
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) { c.navigate(url); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});

self.addEventListener('message', e => { if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting(); });
