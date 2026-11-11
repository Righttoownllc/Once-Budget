# Once Budget: Privacy Policy

RightToOwn LLC · Last updated 2026-11-03

This policy covers the Once Budget app for Android and the self-hosted Once Budget server. The same text is in the app under **More › About & privacy**; keep the two in step (`budget/web/src/views/About.jsx`).

## What we collect: nothing

RightToOwn LLC does not collect, receive, store, sell or share any information about you or your budget. The app contains no analytics, crash reporting, advertising or tracking code, and there is no RightToOwn server it reports to. Its built-in web engine has Google Safe Browsing and usage metrics turned off, and the app refuses any network request it didn't make on purpose.

## Where your data lives

Your budget is stored on your device. If you choose to connect your own Once Budget server, it is also stored on that server, which you run and control. Backups (JSON) and reports (PDF) are files you save wherever you choose.

## Permissions

| Permission | Why | Required? |
|---|---|---|
| Internet | Only to reach a Once Budget server address you enter yourself. In offline mode (the default) the app makes no connections. | No |
| Notifications | "Log $X at Store?" after a tap-to-pay purchase, and bill reminders you turn on. | No |
| Notification access | Reads **only Google Wallet's** payment notifications (merchant, amount, card ending) to pre-fill a transaction. Other apps' notifications are ignored without being read. | No, off until you turn it on |
| Files | Only the file you pick in Android's own save/open dialog. No storage permission. | No |

## Tap-to-pay capture

When turned on, the app reads Google Wallet payment notifications on your device. The text is processed on the device and kept only until you log or dismiss the purchase, plus the last 20 Wallet notifications kept on the device for troubleshooting. It is never transmitted.

## Connecting a server (optional)

The app communicates only with the addresses you enter. If your server is behind Cloudflare Access, signing in happens through Cloudflare under the account you configured there, and Cloudflare's privacy policy applies to that sign-in. RightToOwn LLC is not a party to it.

## Backups

The app opts out of Android cloud backup and device-to-device transfer, so your budget is not copied to Google Drive. Use **Export JSON** to keep your own backup.

## Deleting your data

In the app: **More › Danger zone › Erase everything**, or uninstall the app. Data on your own server is yours to manage there.

## Children

The app is not directed at children and collects no information from anyone.

## Changes

If this policy changes, the updated version ships with the app and the date above changes.

## Contact

RightToOwn LLC · righttoownllc.com
