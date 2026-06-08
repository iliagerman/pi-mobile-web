#!/usr/bin/env bash
#
# Install Pi Mobile Web as a user systemd service so it starts on boot and is
# restarted on any failure. Run this ON THE HOME SERVER as the app user.
#
# Uses a *user* service (systemctl --user) so no root/sudo is needed. For it to
# start at boot without an interactive login, user lingering must be enabled:
#
#     sudo loginctl enable-linger "$USER"     # one time, needs sudo once
#
# Usage:
#   ./scripts/install-service.sh
#   PI_WEB_TOKEN='choose-a-long-random-passphrase' ./scripts/install-service.sh
#
set -euo pipefail

SERVICE_UNIT="pi-mobile-web.service"
RESTART_UNIT="pi-mobile-web-restart.service"
PATH_UNIT="pi-mobile-web-restart.path"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST_DIR="${HOME}/.config/systemd/user"
NPM_BIN="$(command -v npm)"
NPM_BIN_DIR="$(dirname "${NPM_BIN}")"
SERVICE_PATH="${NPM_BIN_DIR}:${PATH}:/usr/local/bin:/usr/bin:/bin:/snap/bin"
PI_WEB_TOKEN_VALUE="${PI_WEB_TOKEN:-}"

# systemctl --user needs these when invoked over a non-interactive SSH session.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"

if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
  echo "WARNING: lingering is not enabled for ${USER}." >&2
  echo "         The service will NOT start at boot until you run:" >&2
  echo "             sudo loginctl enable-linger ${USER}" >&2
fi

sed_escape() {
  printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}

systemd_env_escape() {
  printf '%s' "$1" | sed -e 's/[\\"]/\\&/g'
}

render_unit() {
  local source_file="$1"
  local target_file="$2"
  sed \
    -e "s|__REPO_ROOT__|$(sed_escape "${REPO_ROOT}")|g" \
    -e "s|__NPM_BIN__|$(sed_escape "${NPM_BIN}")|g" \
    -e "s|__SERVICE_PATH__|$(sed_escape "${SERVICE_PATH}")|g" \
    -e "s|__PI_WEB_TOKEN__|$(sed_escape "$(systemd_env_escape "${PI_WEB_TOKEN_VALUE}")")|g" \
    "${source_file}" > "${target_file}"
}

mkdir -p "${DEST_DIR}"
render_unit "${REPO_ROOT}/deploy/${SERVICE_UNIT}" "${DEST_DIR}/${SERVICE_UNIT}"
render_unit "${REPO_ROOT}/deploy/${RESTART_UNIT}" "${DEST_DIR}/${RESTART_UNIT}"
render_unit "${REPO_ROOT}/deploy/${PATH_UNIT}" "${DEST_DIR}/${PATH_UNIT}"
echo "Installed ${DEST_DIR}/${SERVICE_UNIT}"
echo "Installed ${DEST_DIR}/${RESTART_UNIT}"
echo "Installed ${DEST_DIR}/${PATH_UNIT}"

systemctl --user daemon-reload
systemctl --user enable --now "${SERVICE_UNIT}"
systemctl --user enable --now "${PATH_UNIT}"

echo
systemctl --user --no-pager status "${SERVICE_UNIT}" | head -8
echo
systemctl --user --no-pager status "${PATH_UNIT}" | head -8
echo
echo "Manage with:"
echo "  systemctl --user status pi-mobile-web                      # current state"
echo "  systemctl --user restart pi-mobile-web                     # apply code changes / rebuild"
echo "  systemctl --user status pi-mobile-web-restart.path         # file-change watcher state"
echo "  systemctl --user disable --now pi-mobile-web-restart.path  # stop auto-restarts"
echo "  journalctl --user -u pi-mobile-web -f                      # follow app logs"
