# Pi Mobile Web

Private, phone-friendly web UI for running Pi coding-agent sessions across local projects on a home server or workstation.

## Features

- Add server-side project folders and switch between them from the browser.
- Start new Pi sessions or resume existing sessions per project.
- Stream chat over WebSocket with support for slash commands, model switching, thinking-level controls, session renaming, image attachments, and text attachments.
- Optional `PI_WEB_TOKEN` protection for API and WebSocket requests.
- PWA-ready static frontend for phone home-screen install when served over HTTPS.

## Prerequisites

- Node.js 22+ and npm.
- Pi coding agent installed and authenticated for the OS user that runs this app.
- For server auto-start: a Linux host with user `systemd`.
- Optional but recommended for phone access: Tailscale with MagicDNS and HTTPS certificates enabled.

## Install

```bash
git clone git@github.com:iliagerman/pi-mobile-web.git
cd pi-mobile-web
npm ci
```

## Run locally

Development mode with auto-reload:

```bash
npm run dev
```

Production-style run:

```bash
npm run start
```

Open:

```text
http://localhost:8787
```

Use a different port if needed:

```bash
PORT=9000 npm run start
```

## Optional token protection

Set `PI_WEB_TOKEN` before starting the server:

```bash
PI_WEB_TOKEN='choose-a-long-random-passphrase' npm run start
```

Then open the app once with the token in the URL:

```text
http://YOUR_SERVER:8787/?token=choose-a-long-random-passphrase
```

The browser stores the token in local storage and sends it on API/WebSocket requests. Do not commit real tokens to git; use environment variables or a private systemd unit override.

## Run on a Linux server with systemd

Clone the repo into a permanent location on the server and install dependencies:

```bash
git clone git@github.com:iliagerman/pi-mobile-web.git ~/apps/pi-mobile-web
cd ~/apps/pi-mobile-web
npm ci
```

Enable user services at boot once:

```bash
sudo loginctl enable-linger "$USER"
```

Install and start the user service:

```bash
PI_WEB_TOKEN='choose-a-long-random-passphrase' ./scripts/install-service.sh
```

The installer renders the systemd units from `deploy/` with your current repo path and `npm` path, installs them into `~/.config/systemd/user/`, enables the app service, and enables a path watcher that restarts the service after source changes.

Manage the service:

```bash
systemctl --user status pi-mobile-web
systemctl --user restart pi-mobile-web
systemctl --user status pi-mobile-web-restart.path
journalctl --user -u pi-mobile-web -f
```

Disable auto-restarts during long-running Pi work:

```bash
systemctl --user disable --now pi-mobile-web-restart.path
```

Re-enable them later:

```bash
systemctl --user enable --now pi-mobile-web-restart.path
```

## HTTPS for phone/PWA use

Browsers require HTTPS for home-screen installation and service workers. For private home-server access, Tailscale Serve is the simplest option and remains tailnet-only.

Start the app first, then run:

```bash
npm run serve:https
```

Or customize ports:

```bash
PORT=9000 HTTPS_PORT=8443 npm run serve:https
```

Open the `https://<machine>.<tailnet>.ts.net:8443` URL printed by Tailscale. WebSocket streaming upgrades to `wss://` automatically.

Useful Tailscale commands:

```bash
tailscale serve status
tailscale serve --https=8443 off
tailscale serve reset
```

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8787` | HTTP/WebSocket port listened on `0.0.0.0`. |
| `PI_WEB_TOKEN` | empty | Optional token required for API and WebSocket access. |
| `PI_WEB_DATA_DIR` | `~/.pi-mobile-web` | Directory containing `projects.json`, the shared project registry. |

Pi sessions are stored through Pi's normal session manager for each project working directory. The web app runs Pi with the same OS user and permissions as the Node process.

## Validation

```bash
npm run typecheck
npm run build
```

## Security notes

- Run the server as a non-root user.
- Prefer private networking such as Tailscale; do not expose this app directly to the public internet.
- Set `PI_WEB_TOKEN` on shared networks.
- Keep secrets in environment variables or private systemd overrides, not in source files.
- `.gitignore` excludes dependency folders, build artifacts, local runtime data, environment files, private keys/certificates, logs, editor files, and sync-conflict artifacts.
