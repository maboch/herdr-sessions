# Herdr Session Save & Restore

A Herdr layout and mod that adds **Save sessions**, **Restore sessions** and
**Auto-restore sessions** to the left sidebar, just above Settings.

The saved snapshot covers every space, tab, pane and running program on this
computer and on connected remote machines. AI agents are restored with their
own "continue the last session" flag.

Tested with **Herdr 0.1.15** on Linux. The mod is plain `gpui-kit` JavaScript;
it needs no Node, browser or web view.

## What you get

In the left panel, above **Settings**:

```
Save sessions              Ctrl+Shift+S
Restore sessions           Ctrl+Shift+R
Auto-restore sessions      On / Off
Settings
Add machine
```

- **Save sessions** writes a snapshot to `~/.config/herdr-app/sessions.json`.
  Spaces, tabs, pane folders and the foreground program of every terminal are
  included, locally and on remote machines.
- **Restore sessions** recreates only what is missing. It never kills terminals
  that are still running, and running it twice does not duplicate sessions.
- **Auto-restore sessions** restores the last snapshot when Herdr starts.
  It is **off** by default.

AI agents are started with a continue flag, for example:

| Agent | Restored command |
|---|---|
| OpenCode | `opencode --continue` |
| Pi | `pi --continue` |
| Claude Code | `claude --continue` |
| Codex | `codex resume --last` |
| Gemini | `gemini --resume` |
| Crush | `crush --continue` |
| Copilot | `copilot --continue` |
| Cursor | `cursor-agent --continue` |
| Amp | `amp --continue` |
| Kiro | `kiro-cli --resume` |
| Kimi, Grok, Qoder, Hermes, PiG, Antigravity, DeepSeek Harness | `--continue` / `--resume` defaults |

The full table is in `mods/sessions-chrome/sessions.js` (`CONTINUE`). Any agent
can be overridden in `settings.json`; `false` means "start fresh":

```json
{
  "sessions": {
    "auto_restore": true,
    "continue": {
      "opencode": ["--continue"],
      "codex": ["resume", "--last"],
      "my-agent": false
    }
  }
}
```

## Requirements

- Herdr 0.1.15 (the layout/mod API is from this generation).
- `python3` for the installer's `keys.json` merge.
- `herdr-app` in `PATH` for automatic restore and clipboard-free layout
  switching. Restore falls back to `~/.local/bin/herdr-app` when needed.
- Auto-restore's launch detection uses `ps` (Linux/macOS). On Windows the
  buttons and manual restore still work; auto-start is skipped.

## Install

```sh
cd ~/Praca/git/herdr-sessions
./install.sh
```

The installer:

1. backs up existing files to
   `~/.config/herdr-app/backups/herdr-sessions-<timestamp>/`;
2. installs `layouts/main-sessions.json`;
3. installs `mods/sessions-chrome/`;
4. merges `Ctrl+Shift+S` and `Ctrl+Shift+R` into `keys.json`;
5. runs `herdr-app check` on the installed mod;
6. asks a running Herdr to switch to the `main-sessions` layout.

Useful options:

```sh
./install.sh --no-switch        # do not switch layouts automatically
./install.sh --app-home PATH    # non-default HERDR_APP_HOME
./install.sh --force-keys       # overwrite existing Ctrl+Shift+S/R bindings
```

If the shortcuts are already used by something else, the installer keeps the
existing binding and prints a warning. Add the bindings by hand from
`keys.snippet.json`, or rerun with `--force-keys`.

If Herdr was not running during installation, start it and pick
**main-sessions** with `Ctrl+Shift+L`. The original `main` layout is untouched.

## Usage

- `Ctrl+Shift+S` or **Save sessions** — snapshot the current workspace.
- `Ctrl+Shift+R` or **Restore sessions** — recreate missing spaces, tabs and
  programs from the snapshot.
- Click **Auto-restore sessions** to toggle automatic restore at launch.
  The setting is stored as `sessions.auto_restore` in `settings.json`.

Restoring:

- matches spaces and tabs by their Herdr ids first, then by name/folder;
- leaves already-running terminals alone;
- starts programs in their saved folder;
- starts programs on another machine through that machine's shell, so they get
  the PATH and environment a person gets when typing the command (for example
  `opencode` installed under `~/.opencode/bin`, outside `herdr-core`'s SSH PATH);
- restores extra panes as splits to the right;
- restores settled tabs and zoomed panes where possible;
- selects the saved active space and tab at the end;
- keeps going when a space, tab or pane cannot be restored, and reports what
  failed instead of stopping at the first error.

A recovered shell from herdr-core (for example after a reboot) is left in
place; the missing program is added beside it instead of killing the shell.

### Auto-restore semantics

Auto-restore is called only from the sidebar footer's startup initialization,
and only when `sessions.auto_restore` is true. A token derived from the Herdr
process start time prevents it from running again in the same app session
(mod reloads, re-renders and layout switches do not repeat it). A new Herdr
launch gets a new token and can restore again.

Herdr does not expose a direct "app launched" event to mods, so launch detection
uses the process age (under 45 seconds). In normal use `main-sessions` is the
startup layout, so initialization happens immediately. If Herdr starts on
another layout and you switch to `main-sessions` within those 45 seconds,
auto-restore can run then; after 45 seconds it will not.

## Installed files

```
~/.config/herdr-app/
├── layouts/main-sessions.json
├── mods/sessions-chrome/
│   ├── mod.json
│   ├── main.js
│   ├── sessions.js
│   └── *.svg
├── keys.json                  # two new global bindings
├── settings.json              # sessions.auto_restore after you toggle it
└── sessions.json              # created by Save sessions
```

The layout is a clone of Herdr's `main`; the sidebar chrome is a clone of
Herdr's `workspace-chrome` mod with the session rows added. Herdr's shipped
files stay read-only and are not modified.

## Uninstall

```sh
./uninstall.sh
```

This removes the layout, its state file, the mod and the two shortcuts if they
still point to `sessions-chrome`. It keeps `sessions.json` and `settings.json`.

```sh
./uninstall.sh --purge
```

Also removes `sessions.json` and `sessions.auto_restore`. Herdr switches back
to the `main` layout when it is running.

Both scripts support `--app-home PATH`.

## Build a tarball

After committing (and optionally tagging) the tree:

```sh
./package.sh            # uses git describe --tags --always --dirty
./package.sh 1.0.0      # explicit version
```

It writes `dist/herdr-sessions-<version>.tar.gz` and a `.sha256` file. `dist/`
is intentionally ignored by git.

## Development

```sh
herdr-app check mods/sessions-chrome
```

The app generates `gpui-kit.d.ts` next to a mod on first load; it is
intentionally not committed. The small generic `jsconfig.json` is included so
editors have the runtime's module settings.

## License and credits

The package is licensed under the Apache License 2.0; see `LICENSE` and
`NOTICE`. It includes modified parts of Herdr's `workspace-chrome` mod
(Apache-2.0) and Lucide icons (ISC) as shipped with Herdr.
