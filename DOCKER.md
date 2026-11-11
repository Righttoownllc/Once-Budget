# Run your own Once Budget server (optional)

The Once Budget app works fully offline with no server. Run this only if you want your budget synced
between phones and a browser, and new screens delivered to the app without an app update. The
server is yours: RightToOwn LLC never sees it or your data.

## What you need

- A computer that's always on at home: a NAS (Unraid, Synology, TrueNAS), a Raspberry Pi 4 or 5,
  a mini PC, or an always-on Windows or Mac computer.
- Docker on it (built into Unraid and Synology; Docker Desktop on Windows/Mac).
- About 200 MB of disk, plus your data (a small SQLite file and 14 days of backups).

## Install

The server is published as a ready-made image, `ghcr.io/righttoownllc/once-budget`, for PCs and NAS boxes
(amd64) and Raspberry Pi (arm64). Pick your setup:

### Unraid
1. Until Once Budget is in Community Applications, save its template on the server. Open the Unraid
   terminal (**>_** at the top right) and paste:
   ```
   wget -O /boot/config/plugins/dockerMan/templates-user/my-OnceBudget.xml https://raw.githubusercontent.com/righttoownllc/Once-Budget/main/budget/unraid/once-budget.xml
   ```
   Then **Docker › Add Container**, and choose **OnceBudget** in the **Template** list.
2. Leave the defaults (port 8085, data in `/mnt/user/appdata/once-budget/data`), set your time zone, and
   tap **Apply**.
3. Updates: **Docker › Check for updates › Update**.

### Synology (Container Manager)
1. **Container Manager › Registry**, search `ghcr.io/righttoownllc/once-budget`, download `latest`.
2. **Image › Run**: port 8085 → 8080, add a folder (for example `docker/once-budget`) mounted at `/data`,
   add the variables `TZ` (your time zone) and `AUTH_MODE=password`, and tick **auto-restart**.
   Optionally add `PUID` and `PGID` (your user's IDs, from `id` over SSH) so the files in that folder
   are yours; otherwise they belong to user 1000.
3. Updates: **Image › Update**.

### Raspberry Pi, Linux, Windows or Mac (Docker Compose)
1. Make a folder, put `docker-compose.example.yml` in it as `docker-compose.yml`, and set your time
   zone.
2. `docker compose up -d`
3. Updates: `docker compose pull && docker compose up -d`

## First visit: create the password

Open `http://<server-address>:8085` in a browser (for example `http://192.168.1.10:8085`). The first
visit asks you to **create the server password**. Write it down: your data stays on your own
hardware, so there's no "forgot password". After that, any browser signs in with it, and each
browser or phone gets its own key that you can remove under **Pair a phone › Devices**.

Next comes a short **setup**: your accounts, your paycheck, your regular bills and roughly what you
spend on everyday things. Skip any step. The last step, **Connect your phone**, opens the pairing
code (below), or tap **Not now** and pair later from **Settings › Sync & server › Pair a phone**.

## Connect the Android app: scan a code

1. On the server's web page, open **Settings › Sync & server › Pair a phone** (or go to
   `http://<server-address>:8085/pair`). A QR code and a 6-digit code appear; they work once, for
   10 minutes.
2. On the phone, open the **camera app** and point it at the QR code. Once Budget opens and asks
   **Connect this budget to your server?** Tap **Connect**.
3. If both the phone and the server already have a budget, Budget asks whether to use the server's
   or merge both, and keeps a safety copy of the phone's first.

No camera handy? In Once Budget: **Settings › Sync & server › Pair with a code**, type the server's
address and the 6-digit code.

Budget never asks for camera permission: your phone's own camera app reads the code and hands it to
Budget.

## Using it away from home

Don't forward the port on your router. Instead:

- **Tailscale (recommended, free):** install Tailscale on the server and on the phone, signed in to
  the same account. The server gets an address like `http://100.64.1.2:8085` that works from
  anywhere. Put it in **Pair a phone › Address from away** before pairing, and phones switch to it
  automatically when they're out.
- **Your own domain with Cloudflare Tunnel** (advanced): see *Reaching it from outside* below.

**Older setups** (`AUTH_MODE=open` or `cloudflare`) keep working: in the app, **Settings › Sync &
server › Set up by address instead…** connects with home and away addresses as before.

### Home and Cloudflare together

`AUTH_MODE=cloudflare` refuses every request that didn't come through Cloudflare, so the server's
home address (its local IP) only says *unauthenticated*. To have both, use **`AUTH_MODE=password`
and keep `CF_ACCESS_TEAM` and `CF_ACCESS_AUD`**. Then:

- **Away**, through your Cloudflare hostname, a Cloudflare sign-in is accepted as that person, as
  before. Each person still sees only their own and shared budgets.
- **At home**, the server password signs browsers in, and phones pair with a code.
- The admin is the same person either way, so the budgets are the same.

Switching an existing Cloudflare server:

1. Change `AUTH_MODE=cloudflare` to `AUTH_MODE=password` (leave the two `CF_ACCESS_…` lines) and
   restart the container. Phones connected through Cloudflare keep syncing.
2. Create the server password **through your Cloudflare address**, signed in as yourself (an owner
   of the main budget): in the app or the browser, **Settings › Sync & server › Server password ›
   Create server password** (or open `/setup` on the Cloudflare address). On a server that already
   has budgets, the password can't be created from the home network, so nobody else there can
   claim it first. Whoever creates it is the server's admin.
3. On **Pair a phone**, set **Address from away** to your Cloudflare address.
4. On the phone: **Settings › Sync & server › Pair with a code (to sync at home too)**, and enter
   the server's local address and the code (or scan the QR code with the camera). The phone keeps
   its Cloudflare sign-in for away and now also syncs directly at home.

**Server password** in the same place changes it later (with the current password). Forgot it?
Open the server through Cloudflare, signed in as the admin, and set a new one there without the
old one.

To go back to Cloudflare only, set `AUTH_MODE=cloudflare` again.

Data lives in the folder mounted at `/data`: `budget.db` plus nightly backups in `data/backups/`.

## Several budgets

One server can hold several completely separate budgets (a household, a business, a shared trip).
Each is stored apart inside the server's database, and all are in the nightly backup. In the
browser: **Menu › Budgets** to create, rename, switch and delete them (delete asks for YES and
takes a backup first). In the app: **Menu › Budgets › On your server › Add to this phone**, or
pick the server budget when connecting. Budgets that live only on the phone (offline) are an app
feature; a browser never keeps a budget that isn't on the server.

## Other people on your server

Each budget belongs to the people in it; nobody else on the server can open it or see that it
exists. Owners share a budget from **Settings › Sync & server › Who can open this budget**.

- **`AUTH_MODE=password`:** you (whoever knows the server password) are the **admin**. On **Pair a
  phone**, **Add a person** gives them a name and either an empty budget of their own or one of
  yours to share, then shows a one-time code for them: scan it with their phone, or type it on a
  browser's sign-in page (**Sign in with a code**). They never learn the server password.
- **`AUTH_MODE=cloudflare`:** each person is their Cloudflare Access email. Let them into your
  Access policy; the first time they open the server they get an empty budget of their own. Share
  one with them by typing their email in the app.
- **`AUTH_MODE=open` / `local`:** no separation. Everyone who reaches the server sees every budget.

When sharing, the owner picks a level: **Change everything**, **Add purchases** (only adding
purchases and changing their own) or **View only**. The server enforces it on every change. Only
owners can rename, delete, erase or restore a budget, or see its backups. The server's files
and nightly backups still hold everyone's budgets, so whoever runs the server could read them.
Upgrading from before 1.40 keeps things as they were: everyone who had signed in owns every
existing budget (the first of them is the admin), and newcomers start with only their own.

## Protecting it

**`AUTH_MODE=password` (recommended, the default in the example compose file):** the server's own
password, set on the first visit. Browsers sign in with it; phones pair with a one-time code and
keep their own key. Wrong passwords and codes are slowed down (5 password tries, 10 code tries per
10 minutes). Remove a lost phone under **Pair a phone › Devices with access**.

`AUTH_MODE=open` means the server has no login of its own: **anything that can reach port 8085
can read and change the budget.** That's fine on a home network. Never forward port 8085 on your
router. To reach it from outside, pick one:

- **VPN (simplest):** Tailscale or WireGuard. Use the server's VPN address as the away address;
  nothing is exposed to the internet.
- **Cloudflare Tunnel + Access:** a tunnel to `http://<server-ip>:8085` with an Access policy
  (email codes, Google, GitHub…). Set `CF_ACCESS_TEAM` and `CF_ACCESS_AUD` in the compose file so
  the server also verifies the Access token and records who made each change. In the app, use the
  public hostname as the away address and sign in:
  - **Sign in here:** email codes, GitHub and similar.
  - **Sign in with browser:** works with every login type, including Google.
  - **Service token:** create one in Zero Trust, allow it in the policy (Service Auth) and enter
    it under *Cloudflare service token*. Never expires; changes are recorded as "local".
- **Your own reverse proxy** (Caddy, nginx, Traefik) with authentication in front.

Sessions through Cloudflare last as long as your Access application's session duration (up to a
month). When it runs out the app shows **Sign in again to sync** and keeps changes on the phone
until then.

## Updating

With the published image: Unraid **Update**, Synology **Image › Update**, or
`docker compose pull && docker compose up -d`. Built from source: replace the source folder and run
`docker compose up -d --build`. Phones connected
to the server show **Update ready** the next time they sync; one tap loads the new screens.
Native parts of the app (tap-to-pay capture, notifications) still update through the app store.

## Other settings

| Variable | Default | |
|---|---|---|
| `TZ` | UTC | Time zone for the 03:00 backup and reminders |
| `KEEP_DAYS` | 14 | Days of backups kept in `data/backups/`: one nightly copy per day (`budget-daily-YYYY-MM-DD.db`, overwritten if taken again that day), and manual/safety copies are removed after this many days (the newest 3 always stay) |
| `REMIND_HOUR` | 8 | Hour for "bill due today" push to *browsers* (the app schedules its own) |
| `AUTH_MODE` | open | `password` (recommended: server password + phone pairing; with the two Cloudflare settings below, Cloudflare sign-ins work too); `open`; `cloudflare` (require an Access token on every request, which blocks the home address); `local` (LAN testing) |
| `CF_ACCESS_TEAM`, `CF_ACCESS_AUD` | — | Verify Cloudflare Access tokens. With `AUTH_MODE=password`: also accept Cloudflare sign-ins (home and away together) |
