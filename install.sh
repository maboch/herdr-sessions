#!/usr/bin/env bash
# Install Herdr Session Save & Restore into a Herdr app home.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
SWITCH=1
FORCE_KEYS=0

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

Installs:
  layouts/main-sessions.json
  mods/sessions-chrome/
and merges the two shortcuts into keys.json.

Options:
  --app-home PATH   Herdr app home (default: $HERDR_APP_HOME or ~/.config/herdr-app)
  --no-switch       Do not ask a running Herdr to switch to main-sessions
  --force-keys      Overwrite conflicting ctrl-shift-s / ctrl-shift-r bindings
  -h, --help        Show this help

Existing files are backed up under $APP_HOME/backups/herdr-sessions-<time>/.
The script never changes sessions.json, settings.json or the saved session.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --app-home)
      [ "$#" -ge 2 ] || { echo "error: --app-home needs a path" >&2; exit 2; }
      APP_HOME="$2"
      shift 2
      ;;
    --app-home=*)
      APP_HOME="${1#*=}"
      shift
      ;;
    --no-switch)
      SWITCH=0
      shift
      ;;
    --force-keys)
      FORCE_KEYS=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

command -v python3 >/dev/null 2>&1 || {
  echo "error: python3 is required to merge keys.json" >&2
  exit 1
}

if [ ! -d "$APP_HOME/layouts" ] || [ ! -d "$APP_HOME/mods" ]; then
  echo "error: Herdr app home not found at: $APP_HOME" >&2
  echo "       Start Herdr once, or pass --app-home /path/to/herdr-app-home." >&2
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$APP_HOME/backups/herdr-sessions-$STAMP"
mkdir -p "$BACKUP/layouts" "$BACKUP/mods"

if [ -f "$APP_HOME/layouts/main-sessions.json" ]; then
  cp -a "$APP_HOME/layouts/main-sessions.json" "$BACKUP/layouts/"
fi
if [ -d "$APP_HOME/mods/sessions-chrome" ]; then
  cp -a "$APP_HOME/mods/sessions-chrome" "$BACKUP/mods/"
fi
if [ -f "$APP_HOME/keys.json" ]; then
  cp -a "$APP_HOME/keys.json" "$BACKUP/keys.json"
fi

echo "Installing layout and mod..."
install -m 0644 "$SCRIPT_DIR/layouts/main-sessions.json" "$APP_HOME/layouts/main-sessions.json"
rm -rf "$APP_HOME/mods/sessions-chrome"
mkdir -p "$APP_HOME/mods/sessions-chrome"
cp -a "$SCRIPT_DIR/mods/sessions-chrome/." "$APP_HOME/mods/sessions-chrome/"

echo "Merging keyboard shortcuts into keys.json..."
APP_HOME="$APP_HOME" FORCE_KEYS="$FORCE_KEYS" python3 - <<'PY'
import json
import os
import sys
import tempfile

home = os.environ["APP_HOME"]
force = os.environ.get("FORCE_KEYS") == "1"
path = os.path.join(home, "keys.json")
binds = {
    "ctrl-shift-s": "sessions-chrome.save",
    "ctrl-shift-r": "sessions-chrome.restore",
}

try:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
except FileNotFoundError:
    data = {}
except Exception as exc:
    print(f"error: cannot read {path}: {exc}", file=sys.stderr)
    sys.exit(1)

if not isinstance(data, dict):
    print(f"error: {path} is not a JSON object", file=sys.stderr)
    sys.exit(1)

global_keys = data.setdefault("global", {})
if not isinstance(global_keys, dict):
    print(f"error: {path}: \"global\" is not a JSON object", file=sys.stderr)
    sys.exit(1)

conflicts = []
for key, action in binds.items():
    existing = global_keys.get(key)
    if existing is None or existing == action:
        global_keys[key] = action
    elif force:
        global_keys[key] = action
        print(f"forced {key}: {existing!r} -> {action!r}")
    else:
        conflicts.append((key, existing, action))

mode = 0o644
try:
    mode = os.stat(path).st_mode & 0o777
except FileNotFoundError:
    pass

fd, tmp = tempfile.mkstemp(prefix=".keys.", dir=os.path.dirname(path) or ".")
try:
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.chmod(tmp, mode)
    os.replace(tmp, path)
except Exception:
    try:
        os.unlink(tmp)
    except OSError:
        pass
    raise

for key, existing, action in conflicts:
    print(
        f"warning: {key} is already bound to {existing!r}; kept it. "
        f"Use --force-keys to bind it to {action!r}, or edit keys.json by hand.",
        file=sys.stderr,
    )
PY

if command -v herdr-app >/dev/null 2>&1; then
  echo "Checking the installed mod..."
  if ! HERDR_APP_HOME="$APP_HOME" herdr-app check "$APP_HOME/mods/sessions-chrome"; then
    echo "error: mod check failed. Previous files are in: $BACKUP" >&2
    exit 1
  fi
fi

if [ "$SWITCH" -eq 1 ] && command -v herdr-app >/dev/null 2>&1; then
  if HERDR_APP_HOME="$APP_HOME" herdr-app do layout.switch '{"name":"main-sessions"}' >/dev/null 2>&1; then
    echo "Switched Herdr to the main-sessions layout."
  else
    echo "Herdr is not running (or did not switch). Use Ctrl+Shift+L and choose main-sessions."
  fi
fi

cat <<EOF

Installed successfully.

  Layout:  $APP_HOME/layouts/main-sessions.json
  Mod:     $APP_HOME/mods/sessions-chrome/
  Backup:  $BACKUP

In the left sidebar, above Settings:
  Save sessions      Ctrl+Shift+S
  Restore sessions   Ctrl+Shift+R
  Auto-restore sessions  On/Off

Auto-restore is off by default. Turn it on with the new row, or add:
  "sessions": { "auto_restore": true }
to settings.json.

Saved sessions live in: $APP_HOME/sessions.json
EOF
