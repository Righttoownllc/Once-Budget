import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const CHANGELOG = JSON.parse(readFileSync(new URL('../CHANGELOG.json', import.meta.url), 'utf8'));
const MIN_BRIDGE = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).minBridge || 1;

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(VERSION), __CHANGELOG__: JSON.stringify(CHANGELOG) },
  plugins: [
    preact(),
    // licenses.txt: the full notice of every open-source component that ships, read from the
    // installed packages at build time so it can't drift. Shown under More → About & privacy.
    { name: 'licenses', generateBundle() {
      const lic = m => { const d = new URL(`./node_modules/${m}/`, import.meta.url); const p = JSON.parse(readFileSync(new URL('package.json', d), 'utf8')); return { name: m, version: p.version, license: p.license, text: readFileSync(new URL('LICENSE', d), 'utf8').trim() }; };
      const pkgs = ['preact', 'dexie', '@fontsource/inter', 'workbox-core', 'workbox-precaching', 'workbox-routing', 'workbox-strategies'].map(lic);
      const apache = pkgs.find(p => p.name === 'dexie').text;
      const android = ['androidx.activity:activity', 'androidx.core:core', 'androidx.webkit:webkit', 'org.jetbrains.kotlin:kotlin-stdlib'];
      const out = ['Once Budget by RightToOwn LLC: open-source notices', '', 'App screens (all versions)']
        .concat(pkgs.map(p => `\n==== ${p.name} ${p.version} (${p.license})${p.name.startsWith('workbox') ? ' [browser version only]' : ''} ====\n\n${p.text}`))
        .concat([`\n==== Android app: ${android.join(', ')} (Apache-2.0) ====\n\nCopyright The Android Open Source Project and JetBrains s.r.o. Licensed under the Apache License, Version 2.0 (text below).\n\n${apache}`]);
      this.emitFile({ type: 'asset', fileName: 'licenses.txt', source: out.join('\n') + '\n' });
    } },
    // ui.json tells the Android app which version this build is and the oldest native bridge it runs on.
    { name: 'ui-json', generateBundle() { this.emitFile({ type: 'asset', fileName: 'ui.json', source: JSON.stringify({ version: VERSION, minBridge: MIN_BRIDGE }) }); } },
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      registerType: 'autoUpdate',
      injectRegister: null,   // main.jsx registers it, and only outside the Android app
      includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'icon-mono.svg'],
      manifest: {
        name: 'Once Budget',
        short_name: 'Once Budget',
        description: 'Envelope budget that handles credit cards properly',
        theme_color: '#1b2a41',
        background_color: '#f6f7f9',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/icon-mono.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'monochrome' },
        ],
        shortcuts: [
          { name: 'Add transaction', short_name: 'Add', url: '/#/add', icons: [{ src: '/icon.svg', sizes: 'any' }] },
          { name: 'Accounts', short_name: 'Accounts', url: '/#/accounts', icons: [{ src: '/icon.svg', sizes: 'any' }] },
        ],
      },
      injectManifest: { globPatterns: ['**/*.{js,css,html,svg,webmanifest}', '**/inter-latin-*.woff2'] },
    }),
  ],
  // Relative URLs so the same build runs from the Docker server and from the Android app's assets.
  base: './',
  server: { proxy: { '/api': 'http://localhost:8085', '/healthz': 'http://localhost:8085' } },
});
