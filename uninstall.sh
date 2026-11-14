#!/usr/bin/env bash
# Remove Herdr Session Save & Restore from a Herdr app home.
set -euo pipefail

APP_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
PURGE=0

usage() {
  cat <<'EOF'
Usage: ./uninstall.sh [options]

Removes the main-sessions layout, the sessions-chrome mod, and the two
shortcuts (only when they still point to this package). Saved sessions,
settings.json and the auto-restore setting are kept unless --purge is given.

Options:
  --app-home PATH   Herdr app home (default: $HERDR_APP_HOME or ~/.config/herdr-app)
  --purge           Also delete sessions.json and sessions.auto_restore
  -h, --help        Show this help
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
    --purge)
      PURGE=1
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

if [ ! -d "$APP_HOME" ]; then
  echo "error: Herdr app home not found at: $APP_HOME" >&2
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$APP_HOME/backups/herdr-sessions-removed-$STAMP"
mkdir -p "$BACKUP/layouts" "$BACKUP/mods"

if command -v herdr-app >/dev/null 2>&1; then
  HERDR_APP_HOME="$APP_HOME" herdr-app do layout.switch '{"name":"main"}' >/dev/null 2>&1 || true
fi

if [ -f "$APP_HOME/layouts/main-sessions.json" ]; then
  cp -a "$APP_HOME/layouts/main-sessions.json" "$BACKUP/layouts/"
  rm -f "$APP_HOME/layouts/main-sessions.json"
fi
if [ -f "$APP_HOME/layouts/.state/main-sessions.json" ]; then
  mkdir -p "$BACKUP/layouts/.state"
  cp -a "$APP_HOME/layouts/.state/main-sessions.json" "$BACKUP/layouts/.state/"
  rm -f "$APP_HOME/layouts/.state/main-sessions.json"
fi
if [ -d "$APP_HOME/mods/sessions-chrome" ]; then
  cp -a "$APP_HOME/mods/sessions-chrome" "$BACKUP/mods/"
  rm -rf "$APP_HOME/mods/sessions-chrome"
fi

if command -v python3 >/dev/null 2>&1; then
  APP_HOME="$APP_HOME" PURGE="$PURGE" python3 - <<'PY'
import json
import os
import sys
import tempfile

home = os.environ["APP_HOME"]
purge = os.environ.get("PURGE") == "1"
keys_path = os.path.join(home, "keys.json")
binds = {
    "ctrl-shift-s": "sessions-chrome.save",
    "ctrl-shift-r": "sessions-chrome.restore",
}

def write_json(path, data):
    mode = 0o644
    try:
        mode = os.stat(path).st_mode & 0o777
    except FileNotFoundError:
        pass
    fd, tmp = tempfile.mkstemp(prefix=".json.", dir=os.path.dirname(path) or ".")
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

try:
    with open(keys_path, "r", encoding="utf-8") as f:
        keys = json.load(f)
except FileNotFoundError:
    keys = None
except Exception as exc:
    print(f"warning: cannot read {keys_path}: {exc}; shortcuts left untouched", file=sys.stderr)
    keys = None

if isinstance(keys, dict) and isinstance(keys.get("global"), dict):
    global_keys = keys["global"]
    for key, action in binds.items():
        if global_keys.get(key) == action:
            del global_keys[key]
    write_json(keys_path, keys)

if purge:
    sessions_path = os.path.join(home, "sessions.json")
    try:
        os.unlink(sessions_path)
    except FileNotFoundError:
        pass

    settings_path = os.path.join(home, "settings.json")
    try:
        with open(settings_path, "r", encoding="utf-8") as f:
            settings = json.load(f)
    except FileNotFoundError:
        settings = None
    except Exception as exc:
        print(f"warning: cannot read {settings_path}: {exc}; auto-restore setting left untouched", file=sys.stderr)
        settings = None

    if isinstance(settings, dict):
        sessions = settings.get("sessions")
        if isinstance(sessions, dict):
            sessions.pop("auto_restore", None)
            if not sessions:
                settings.pop("sessions", None)
            write_json(settings_path, settings)
PY
else
  echo "warning: python3 not found; keys.json and settings.json were not changed" >&2
fi

echo "Removed successfully. Files kept for reference in: $BACKUP"
if [ "$PURGE" -eq 1 ]; then
  echo "Purged sessions.json and the auto-restore setting."
else
  echo "Kept sessions.json and settings.json. Use --purge to remove them too."
fi
