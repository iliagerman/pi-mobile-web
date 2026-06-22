# Claude Notes for Pi Mobile Web

## Homeserver deployment

Use SSH alias `homeserver`. The app lives at:

```text
/home/ilia/codebase/personal/pi-mobile-web
```

It runs as a user systemd service:

```bash
systemctl --user status pi-mobile-web
```

The service runs `npm start`, which runs `npm run build` and then `node dist/server.js`. The app listens locally on port `8787`.

The service must start with the `pi-hr` Headroom alias equivalent. systemd does not expand shell aliases, so the active homeserver setup uses a drop-in:

```text
~/.config/systemd/user/pi-mobile-web.service.d/headroom-openai.conf
```

with:

```ini
[Service]
Environment="OPENAI_BASE_URL=http://127.0.0.1:8788/v1"
Environment="PI_MOBILE_WEB_PI_ALIAS=pi-hr"
Environment="PI_MOBILE_WEB_MODEL=openai/gpt-5.5"
```

This mirrors the interactive alias:

```bash
alias pi-hr='OPENAI_BASE_URL=http://127.0.0.1:8788/v1 pi --model openai/gpt-5.5'
```

Do not change `ExecStart` to `pi-hr`; that alias runs the `pi` CLI, while this app is a Node/SDK service.

## Deploy checklist

1. Validate locally:

```bash
npm run typecheck
npm run build
```

2. Ensure files are present on the homeserver. Syncthing may already sync this repo, but verify before restarting:

```bash
ssh homeserver 'cd /home/ilia/codebase/personal/pi-mobile-web && git status --short'
```

For touched files, compare checksums if unsure:

```bash
shasum -a 256 <files>
ssh homeserver 'cd /home/ilia/codebase/personal/pi-mobile-web && sha256sum <files>'
```

If needed, push files with `rsync` while preserving paths:

```bash
rsync -av public/ homeserver:/home/ilia/codebase/personal/pi-mobile-web/public/
rsync -av src/ homeserver:/home/ilia/codebase/personal/pi-mobile-web/src/
```

3. Validate and restart remotely:

```bash
ssh homeserver 'set -e; cd /home/ilia/codebase/personal/pi-mobile-web; npm run typecheck; npm run build; systemctl --user daemon-reload; systemctl --user restart pi-mobile-web; sleep 8; curl -fsS http://127.0.0.1:8787/api/health; echo; systemctl --user --no-pager status pi-mobile-web | head -25'
```

Verify the `pi-hr` Headroom equivalent env after restart:

```bash
ssh homeserver 'python3 - <<"PY"
import subprocess
pid=subprocess.check_output(["systemctl","--user","show","pi-mobile-web","-p","MainPID","--value"], text=True).strip()
for item in open(f"/proc/{pid}/environ","rb").read().split(b"\0"):
    if item.startswith((b"OPENAI_BASE_URL=", b"PI_MOBILE_WEB_PI_ALIAS=", b"PI_MOBILE_WEB_MODEL=")):
        print(item.decode())
PY'
```

If curl fails right after restart, wait a few seconds because `npm start` builds before listening.

4. Check logs if anything looks wrong:

```bash
ssh homeserver 'journalctl --user -u pi-mobile-web -n 80 --no-pager'
```

## Static/PWA cache note

If adding a new file under `public/` that the browser imports (for example `markdown.js`), update `public/sw.js` too:

- bump `CACHE_NAME`
- add the asset to `APP_SHELL`

This prevents installed mobile/PWA clients from using stale cached app shell files.

## Current state

As of 2026-06-20, the homeserver service was restarted with the latest fix and verified healthy via:

```bash
ssh homeserver 'curl -fsS http://127.0.0.1:8787/api/health'
# {"status":"ok"}
```
