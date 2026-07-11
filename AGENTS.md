# Agent Notes for Pi Mobile Web

## Homeserver deployment

This app runs on the homeserver via SSH alias:

```bash
ssh homeserver
```

Remote app directory:

```text
/home/ilia/codebase/personal/pi-mobile-web
```

User systemd service:

```text
pi-mobile-web.service
```

The unit runs:

```bash
npm start
```

which builds TypeScript (`npm run build`) and then starts `node dist/server.js` on port `8787`.

The homeserver must use the `pi-hr` Headroom alias equivalent when starting this service. Do **not** rely on shell alias expansion in systemd. The active service has a drop-in:

```text
~/.config/systemd/user/pi-mobile-web.service.d/headroom-openai.conf
```

with:

```ini
[Service]
Environment="OPENAI_BASE_URL=http://127.0.0.1:8788/v1"
Environment="PI_MOBILE_WEB_PI_ALIAS=pi-hr"
Environment="PI_MOBILE_WEB_MODEL=openai-codex/gpt-5.6-sol"
```

This mirrors the interactive homeserver alias:

```bash
alias pi-hr='OPENAI_BASE_URL=http://127.0.0.1:8788/v1 pi --model openai-codex/gpt-5.6-sol'
```

Note: the web app starts via Node/SDK, not the `pi` CLI, so systemd uses the alias environment rather than invoking the alias command.

## Fast deploy / restart workflow

From the local repo:

```bash
npm run typecheck
npm run build
```

Then confirm the homeserver copy matches or sync files manually:

```bash
# Check remote status
ssh homeserver 'cd /home/ilia/codebase/personal/pi-mobile-web && git status --short'

# Optional checksum check for touched files
shasum -a 256 public/app.js public/styles.css public/sw.js public/markdown.js src/server.ts
ssh homeserver 'cd /home/ilia/codebase/personal/pi-mobile-web && sha256sum public/app.js public/styles.css public/sw.js public/markdown.js src/server.ts'
```

If files are not synced, use `rsync` for changed source/static files, for example:

```bash
rsync -av public/app.js public/styles.css public/sw.js public/markdown.js src/server.ts \
  homeserver:/home/ilia/codebase/personal/pi-mobile-web/
```

When copying files into subdirectories, preserve their paths, e.g.:

```bash
rsync -av public/ homeserver:/home/ilia/codebase/personal/pi-mobile-web/public/
rsync -av src/ homeserver:/home/ilia/codebase/personal/pi-mobile-web/src/
```

Validate and restart on the homeserver:

```bash
ssh homeserver 'set -e; cd /home/ilia/codebase/personal/pi-mobile-web; npm run typecheck; npm run build; systemctl --user daemon-reload; systemctl --user restart pi-mobile-web; sleep 8; curl -fsS http://127.0.0.1:8787/api/health; echo; systemctl --user --no-pager status pi-mobile-web | head -25'
```

Verify the `pi-hr` Headroom equivalent env is present after restart:

```bash
ssh homeserver 'python3 - <<"PY"
import subprocess
pid=subprocess.check_output(["systemctl","--user","show","pi-mobile-web","-p","MainPID","--value"], text=True).strip()
for item in open(f"/proc/{pid}/environ","rb").read().split(b"\0"):
    if item.startswith((b"OPENAI_BASE_URL=", b"PI_MOBILE_WEB_PI_ALIAS=", b"PI_MOBILE_WEB_MODEL=")):
        print(item.decode())
PY'
```

If health fails immediately after restart, wait a few more seconds: `npm start` rebuilds before `node dist/server.js` begins listening.

Useful logs/status:

```bash
ssh homeserver 'journalctl --user -u pi-mobile-web -n 80 --no-pager'
ssh homeserver 'systemctl --user --no-pager status pi-mobile-web'
```

## PWA/static-cache reminder

When adding or renaming frontend static files in `public/`, update `public/sw.js`:

- bump `CACHE_NAME`
- add the new asset to `APP_SHELL`

Otherwise installed mobile/PWA clients may keep stale cached shell files.

## Current known deployment state

As of 2026-06-20, the homeserver service is running and healthy:

```bash
curl -fsS http://127.0.0.1:8787/api/health
# {"status":"ok"}
```
