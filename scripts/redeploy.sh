#!/usr/bin/env bash
# Rebuild + restart server + restart daemon. Always works.
#
# Steady state: `restart` RPC over the Unix socket → daemon self-exits →
# launchd KeepAlive respawns from the latest bundle. No sudo.
#
# Bootstrap fallback: if the running daemon predates the `restart` RPC
# (e.g. you just added a new RPC method), or the socket is missing, this
# script auto-falls back to `sudo launchctl kickstart -k` once. After that,
# future redeploys are sudo-free again.
#
# Usage:  ./scripts/redeploy.sh
#         npm run redeploy
set -euo pipefail

cd "$(dirname "$0")/.."

SOCK=/tmp/amberfocus.sock

# --- Read PID via status RPC. Returns "" on any failure. ---
get_pid() {
  python3 - "$SOCK" <<'PY' 2>/dev/null || true
import socket, json, sys
try:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(1.5)
    s.connect(sys.argv[1])
    s.sendall(b'{"jsonrpc":"2.0","id":1,"method":"status"}\n')
    data = b""
    while not data.endswith(b"\n"):
        chunk = s.recv(4096)
        if not chunk: break
        data += chunk
    s.close()
    print(json.loads(data.decode()).get("result", {}).get("pid", ""))
except Exception:
    pass
PY
}

# --- Send the `restart` RPC. Echoes raw reply. ---
send_restart() {
  python3 - "$SOCK" <<'PY' 2>/dev/null || true
import socket, sys
try:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(2)
    s.connect(sys.argv[1])
    s.sendall(b'{"jsonrpc":"2.0","id":1,"method":"restart"}\n')
    data = b""
    while not data.endswith(b"\n"):
        chunk = s.recv(4096)
        if not chunk: break
        data += chunk
    s.close()
    print(data.decode().strip())
except Exception as e:
    print(f"__ERR__:{e}")
PY
}

# --- Wait until socket exists (up to 10s). Returns 0 on success. ---
wait_for_socket() {
  for _ in {1..40}; do
    [[ -S "$SOCK" ]] && return 0
    sleep 0.25
  done
  return 1
}

# --- Wait for new daemon PID different from $1 (up to 10s). Echoes new PID. ---
wait_for_new_pid() {
  local old_pid="$1"
  for _ in {1..40}; do
    sleep 0.25
    local new_pid
    new_pid="$(get_pid)"
    if [[ -n "$new_pid" && "$new_pid" != "$old_pid" ]]; then
      echo "$new_pid"
      return 0
    fi
  done
  return 1
}

echo "==> build"
npm run build

echo "==> restart server (user LaunchAgent, no sudo)"
launchctl kickstart -k "gui/$(id -u)/com.amberfocus.server" 2>/dev/null || true

# --- Wait for socket; if absent, daemon isn't running → bootstrap with sudo. ---
if ! wait_for_socket; then
  echo "==> daemon socket missing — running one-time sudo kickstart"
  sudo launchctl kickstart -k system/com.amberfocus.daemon
  wait_for_socket || { echo "ERROR: daemon never came up after sudo kickstart"; exit 1; }
fi

OLD_PID="$(get_pid)"
if [[ -z "$OLD_PID" ]]; then
  echo "ERROR: daemon socket present but status RPC failed"
  exit 1
fi

echo "==> restart daemon via RPC (no sudo)"
RESTART_REPLY="$(send_restart)"

# --- Detect a daemon that predates the `restart` RPC and fall back to sudo. ---
if [[ "$RESTART_REPLY" == *'"Method not found"'* || "$RESTART_REPLY" == *"-32601"* ]]; then
  echo "==> running daemon predates restart RPC — one-time sudo kickstart to load new code"
  sudo launchctl kickstart -k system/com.amberfocus.daemon
  wait_for_socket || { echo "ERROR: daemon never came up after sudo kickstart"; exit 1; }
  NEW_PID="$(get_pid)"
  if [[ -z "$NEW_PID" || "$NEW_PID" == "$OLD_PID" ]]; then
    echo "ERROR: daemon did not actually restart"
    exit 1
  fi
  echo "==> daemon back up (pid $NEW_PID, was $OLD_PID) via sudo bootstrap"
  exit 0
fi

if [[ "$RESTART_REPLY" != *'"scheduled":true'* ]]; then
  echo "ERROR: unexpected restart reply: $RESTART_REPLY"
  exit 1
fi

echo "==> waiting for daemon to come back (was pid $OLD_PID)"
NEW_PID="$(wait_for_new_pid "$OLD_PID")" || {
  echo "ERROR: daemon did not respawn within 10s. Check: launchctl print system/com.amberfocus.daemon"
  exit 1
}
echo "==> daemon back up (pid $NEW_PID, was $OLD_PID)"
