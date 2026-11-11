import { Shell } from '../main.jsx';
import { APP_VERSION } from '../store.js';
import { isNative } from '../platform.js';

/**
 * About & privacy: RightToOwn's four rules as they apply here, what each permission is for,
 * the privacy policy, and open-source credits. Keep PRIVACY.md (repo root) in step with this.
 */
export const PRIVACY_UPDATED = '2026-11-03';

export function About() {
  const top = <div class="col"><span class="eyebrow">RightToOwn LLC</span><span class="title">About &amp; privacy</span></div>;
  return (
    <Shell route="more" top={top}>
      <div class="card">
        <span class="eyebrow">Once Budget v{APP_VERSION}</span>
        <span>An envelope budget that keeps your data yours. Made by RightToOwn LLC, following the same four rules as all our software:</span>
        <ol class="about-list">
          <li><b>Offline.</b> Works with no internet. Offline is the default, and the app is fully usable without a server.</li>
          <li><b>No accounts.</b> Nothing to sign up for. We never have your data. If you connect a server, it's one you run yourself.</li>
          <li><b>No tracking.</b> No analytics, no crash reports, no ads, no advertising ID. The app loads nothing from the internet on its own.</li>
          <li><b>Portable.</b> Export everything as JSON any time, and save monthly reports as PDF.</li>
        </ol>
      </div>

      {!isNative && (
        <div class="card">
          <span class="eyebrow">In this browser</span>
          <dl class="about-dl">
            <dt>Your budgets</dt><dd>All live on the Once Budget server you run, which backs them up every night. This browser keeps a working copy so it keeps going through short outages and syncs when the server is back; clearing the browser loses nothing.</dd>
            <dt>Never browser-only</dt><dd>A browser can erase its stored data at any time, so it never holds a budget that isn't also on your server. Offline budgets live in the Android app.</dd>
            <dt>Nothing else</dt><dd>No cookies of ours, no analytics, no trackers. If your server is behind Cloudflare Access, its sign-in cookie is Cloudflare's, under your own account.</dd>
          </dl>
        </div>
      )}
      {isNative && (
        <div class="card">
          <span class="eyebrow">What the app can access, and why</span>
          <dl class="about-dl">
            <dt>Internet</dt><dd>Only to reach a Once Budget server address that you enter yourself. In offline mode the app makes no connections at all.</dd>
            <dt>Notifications</dt><dd>To ask "Log $X at Store?" after a tap-to-pay purchase, and for bill reminders you turn on. Optional.</dd>
            <dt>Notification access (Google Wallet)</dt><dd>Optional, off until you turn it on. The app reads only Google Wallet's payment notifications (merchant, amount, card ending) to fill in a transaction. Every other app's notifications are ignored without being read. Nothing leaves the phone.</dd>
            <dt>Files</dt><dd>Only the file you pick in Android's own save/open dialog, for backups and imports. No storage permission.</dd>
          </dl>
        </div>
      )}

      <div class="card" id="privacy">
        <span class="eyebrow">Privacy policy</span>
        <span class="head">Last updated {PRIVACY_UPDATED}</span>
        <p><b>What we collect: nothing.</b> RightToOwn LLC does not collect, receive, store, sell or share any information about you or your budget. The app has no analytics, crash reporting, advertising or tracking code, and no RightToOwn server it reports to.</p>
        <p><b>Where your data lives.</b> Your budget is stored on your device. If you choose to connect your own Once Budget server, it is also stored on that server, which you control. Backups and reports are files you save wherever you choose.</p>
        <p><b>Tap-to-pay capture.</b> If you turn it on, the app reads Google Wallet's payment notifications on your device to pre-fill transactions. The text is processed on the device and kept only until you log or dismiss the purchase (plus the last 20 Wallet notifications, kept on the device for troubleshooting). It is never sent anywhere.</p>
        <p><b>Connecting a server (optional).</b> The app talks only to the addresses you enter. If your server is behind Cloudflare Access, signing in goes through Cloudflare under the account you set up there; Cloudflare's privacy policy applies to that sign-in. RightToOwn LLC is not involved.</p>
        <p><b>Backups.</b> The app opts out of Android's cloud backup, so your budget is not copied to Google Drive. Use Export JSON to keep your own backup.</p>
        <p><b>Deleting your data.</b> Settings › Backups &amp; data › Danger zone › Erase everything, or uninstall the app. Data on your own server is yours to manage there.</p>
        <p><b>Children.</b> The app isn't directed at children and collects nothing from anyone.</p>
        <p><b>Changes.</b> If this policy changes, the new version ships with the app and the date above changes.</p>
        <p><b>Contact.</b> RightToOwn LLC, righttoownllc.com.</p>
      </div>

      <div class="card">
        <span class="eyebrow">Open source</span>
        <p style="margin:0">Once Budget is free software under the <b>GNU Affero General Public License v3</b> (AGPL-3.0): you may use, study, share and change it, and anyone who offers a changed version, including as a server others use, must share their changes under the same licence. Source code: <a class="link" href="https://github.com/righttoownllc/Once-Budget">github.com/righttoownllc/Once-Budget</a></p>
        <span class="head" style="margin-top:6px">Built with:</span>
        <ul class="about-list">
          <li>Preact (MIT), Dexie (Apache 2.0), Inter typeface (SIL Open Font License 1.1)</li>
          {isNative ? <li>AndroidX Activity, Core and WebKit; Kotlin standard library (Apache 2.0)</li> : <li>Workbox (MIT)</li>}
          <li>Server: Hono and jose (MIT), web-push (MPL 2.0)</li>
        </ul>
        <a href="./licenses.txt" class="link" style="font-weight:600;color:var(--pos)">Full license texts ›</a>
      </div>
    </Shell>
  );
}
