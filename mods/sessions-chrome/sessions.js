// Save and restore every space, tab and running program, on this computer and
// on connected machines. AI agents come back with their own "continue last
// session" flag (opencode --continue, codex resume --last, ...).
//
// A snapshot is plain JSON in ~/.config/herdr-app/sessions.json. Auto-restore
// is an app setting: settings.json -> sessions.auto_restore.

import {
  appHome, exec, home, machines, notify, panes, readTextFile, setShared,
  shared, spaces, terminals, writeTextFile,
} from "herdr";

const SNAPSHOT_VERSION = 1;

// How each agent resumes its most recent session. Values are inserted right
// after the program name. A person can override any of them in settings.json:
//   { "sessions": { "continue": { "opencode": ["--continue"] } } }
// false means "start fresh" for that agent.
const CONTINUE = {
  opencode: ["--continue"],
  pi: ["--continue"],
  pig: ["--continue"],
  claude: ["--continue"],
  "claude-code": ["--continue"],
  codex: ["resume", "--last"],
  gemini: ["--resume"],
  crush: ["--continue"],
  copilot: ["--continue"],
  cursor: ["--continue"],
  "cursor-agent": ["--continue"],
  amp: ["--continue"],
  grok: ["--continue"],
  kimi: ["--continue"],
  kiro: ["--resume"],
  "kiro-cli": ["--resume"],
  qoder: ["--continue"],
  hermes: ["--continue"],
  "dsh-tui": ["--continue"],
  antigravity: ["--continue"],
  agy: ["--continue"],
};

const AGENT_KEYS = new Set([
  ...Object.keys(CONTINUE),
  "agent", "claude", "codex", "gemini", "opencode", "pi",
]);

let busy = null;   // "save" | "restore" while an operation runs
let appBin = null; // the herdr-app CLI, for commands that return ids

const file = () => `${appHome()}/sessions.json`;
const settingsFile = () => `${appHome()}/settings.json`;
const wait = (cx, ms) => new Promise((resolve) => cx.timer.after(ms, () => resolve()));

function stripEmpty(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

async function readSnapshot() {
  try {
    const raw = await readTextFile(file());
    if (!raw) return null;
    const snapshot = JSON.parse(raw);
    return snapshot && Array.isArray(snapshot.spaces) ? snapshot : null;
  } catch {
    return null;
  }
}

async function readSettings() {
  const raw = await readTextFile(settingsFile());
  if (!raw) return { raw, data: {} };
  return { raw, data: JSON.parse(raw) };
}

export async function autoRestoreEnabled() {
  try {
    return Boolean((await readSettings()).data?.sessions?.auto_restore);
  } catch {
    return false;
  }
}

export async function setAutoRestore(on) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { raw, data } = await readSettings();
      const next = JSON.parse(JSON.stringify(data));
      next.sessions = { ...(next.sessions ?? {}), auto_restore: Boolean(on) };
      await writeTextFile(settingsFile(), JSON.stringify(next, null, 2) + "\n", raw);
      setShared("sessions.auto_restore", Boolean(on));
      notify({
        title: on ? "Auto-restore on" : "Auto-restore off",
        body: on ? "Saved sessions will come back when Herdr starts." : "Saved sessions stay until you restore them yourself.",
        level: "info",
      });
      return true;
    } catch {
      // The Settings screen may have written settings.json meanwhile: read again.
    }
  }
  notify({ title: "Couldn't change auto-restore", body: "settings.json could not be written.", level: "error" });
  return false;
}

// Seconds since the app started (exec's parent), or null where ps can't say.
async function appAge() {
  try {
    const r = await exec("sh", ["-c", 'ps -o etime= -p "$PPID"']);
    const match = r.stdout.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
    if (!match) return null;
    const [, days, hours, minutes, seconds] = match.map((x) => Number(x) || 0);
    return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
  } catch {
    return null;
  }
}

async function cli() {
  if (appBin) return appBin;
  for (const candidate of ["herdr-app", `${home()}/.local/bin/herdr-app`]) {
    try {
      const r = await exec(candidate, ["--version"]);
      if (r.code === 0) {
        appBin = candidate;
        return candidate;
      }
    } catch {}
  }
  throw new Error("herdr-app was not found in PATH.");
}

// Runs an app command through the app's own CLI so the result names the new
// space, tab, pane and terminal. `run()` only returns null.
async function appDo(command, args = {}) {
  const binary = await cli();
  const r = await exec(binary, ["do", command, JSON.stringify(stripEmpty(args))]);
  let parsed = null;
  try { parsed = JSON.parse(r.stdout || "null"); } catch {}
  if (r.code !== 0 || parsed?.error) {
    const reason = parsed?.error?.message ?? parsed?.error ?? (r.stderr || r.stdout || "command failed");
    throw new Error(`${command}: ${String(reason).trim().split("\n").slice(-2).join(" ")}`);
  }
  return parsed && typeof parsed === "object" ? parsed : {};
}

function panesOfTab(tabId) {
  return panes().filter((p) => p.tab === tabId && p.terminal);
}

function commandOf(pane, terminal) {
  const fg = terminal?.foreground?.argv;
  if (Array.isArray(fg) && fg.length) return [...fg];
  const argv = terminal?.argv;
  if (Array.isArray(argv) && argv.length) return [...argv];
  return null;
}

function liveCwd(pane, terminal) {
  return terminal?.foreground?.cwd || pane?.cwd || terminal?.cwd || null;
}

// `pane.app` can lag behind a program that already exited (it remembers the
// last agent that reported). The terminal's live foreground is the truth.
function agentKeyOf(pane, terminal) {
  const report = terminal?.report?.app ?? terminal?.status?.app ?? null;
  const key = terminal?.program?.key ?? pane?.program?.key ?? null;
  const name = terminal?.foreground?.name ?? null;
  if (report) return report;
  if (terminal?.program?.agent || pane?.program?.agent) return key ?? name;
  if (AGENT_KEYS.has(key)) return key;
  if (AGENT_KEYS.has(name)) return name;
  return key ?? name ?? null;
}

function isAgent(pane, terminal) {
  const program = terminal?.program ?? pane?.program ?? {};
  return Boolean(
    program.agent
    || terminal?.report?.app
    || terminal?.status?.app
    || AGENT_KEYS.has(agentKeyOf(pane, terminal))
    || AGENT_KEYS.has(terminal?.foreground?.name),
  );
}

function customContinue(settings, key) {
  const configured = settings?.sessions?.continue;
  if (!configured || !Object.prototype.hasOwnProperty.call(configured, key)) return undefined;
  const value = configured[key];
  if (value === false || value === null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string");
  return [];
}

function continueArgs(settings, key) {
  const custom = customContinue(settings, key);
  if (custom !== undefined) return custom;
  return CONTINUE[key] ?? [];
}

function alreadyContinues(argv, args) {
  if (!args.length) return false;
  const rest = argv.slice(1);
  // Already asked to continue/resume a session in any of the usual spellings.
  if (rest.some((a) => a === "--continue" || a === "-c" || a === "--resume" || a === "-r" || a === "--session" || a === "-s" || a === "resume")) return true;
  if (args[0] === "resume") return rest.some((a) => a === "--last" || a === "last");
  return args.some((a) => rest.includes(a));
}

function restoreArgv(saved, settings) {
  let argv = Array.isArray(saved.argv) && saved.argv.length ? [...saved.argv] : null;
  if (!saved.agent) return argv;
  const key = saved.program || saved.app || (argv?.[0] ?? null);
  if (!key) return argv;
  const args = continueArgs(settings, key);
  if (!args.length) return argv;
  if (!argv) {
    const command = saved.command || key;
    return [command, ...args];
  }
  if (alreadyContinues(argv, args)) return argv;
  return [argv[0], ...args, ...argv.slice(1)];
}

function describePane(pane, terminal, space) {
  const program = terminal?.program ?? pane.program ?? {};
  const wasShell = program.shell === true;
  const argv = wasShell ? null : commandOf(pane, terminal);
  const agent = isAgent(pane, terminal);
  return {
    argv: agent && !argv ? null : argv,
    command: argv?.[0] ?? terminal?.foreground?.name ?? null,
    agent,
    program: agentKeyOf(pane, terminal),
    app: terminal?.report?.app ?? terminal?.status?.app ?? null,
    cwd: liveCwd(pane, terminal) || space.folder || null,
    title: pane.title ?? terminal?.title ?? "",
    focused: Boolean(pane.focused),
    zoomed: Boolean(pane.zoomed),
  };
}

function snapshotNow() {
  const allTerminals = new Map(terminals().map((t) => [t.address, t]));
  const result = {
    version: SNAPSHOT_VERSION,
    saved_at: Date.now(),
    app: "herdr-app",
    spaces: [],
  };
  for (const space of spaces()) {
    const tabs = [...(space.tabs ?? [])]
      .sort((a, b) => a.index - b.index)
      .map((tab) => {
        const mine = panesOfTab(tab.id)
          .map((pane) => ({ pane, created: allTerminals.get(pane.terminal)?.created_ms ?? 0 }))
          .sort((a, b) => a.created - b.created || String(a.pane.pane).localeCompare(String(b.pane.pane)))
          .map(({ pane }) => describePane(pane, allTerminals.get(pane.terminal), space));
        return {
          id: tab.id,
          index: tab.index,
          name: tab.name,
          named: Boolean(tab.named),
          active: Boolean(tab.active),
          settled: Boolean(tab.settled),
          panes: mine,
        };
      })
      .filter((tab) => tab.panes.length);
    if (!tabs.length) continue;
    result.spaces.push({
      id: space.id,
      index: space.index,
      name: space.name,
      named: Boolean(space.named),
      folder: space.folder,
      machine: space.machine ?? null,
      active: Boolean(space.active),
      tabs,
    });
  }
  return result;
}

export async function sessionSummary() {
  const snapshot = await readSnapshot();
  if (!snapshot) return null;
  const programs = snapshot.spaces.reduce(
    (n, space) => n + space.tabs.reduce((m, tab) => m + tab.panes.length, 0),
    0,
  );
  return { saved_at: snapshot.saved_at, spaces: snapshot.spaces.length, programs };
}

export async function saveSession(cx) {
  if (busy) return;
  busy = "save";
  setShared("sessions.busy", "save");
  cx?.notify();
  try {
    const snapshot = snapshotNow();
    if (!snapshot.spaces.length) throw new Error("There are no spaces with running programs to save.");
    const text = JSON.stringify(snapshot, null, 2) + "\n";
    for (let attempt = 0; ; attempt++) {
      const raw = await readTextFile(file());
      try {
        await writeTextFile(file(), text, raw);
        break;
      } catch (error) {
        if (attempt >= 2) throw error;
      }
    }
    setShared("sessions.saved_at", snapshot.saved_at);
    const programs = snapshot.spaces.reduce(
      (n, space) => n + space.tabs.reduce((m, tab) => m + tab.panes.length, 0),
      0,
    );
    notify({
      title: "Sessions saved",
      body: `${snapshot.spaces.length} ${snapshot.spaces.length === 1 ? "space" : "spaces"} · ${programs} ${programs === 1 ? "program" : "programs"}`,
      level: "success",
    });
  } catch (error) {
    notify({ title: "Couldn't save sessions", body: String(error?.message ?? error), level: "error" });
  } finally {
    busy = null;
    setShared("sessions.busy", null);
    cx?.notify();
  }
}

function spaceScore(saved, current, savedPaneCwds, currentPaneCwds) {
  if ((saved.machine ?? null) !== (current.machine ?? null)) return -1;
  if (saved.id && current.id === saved.id) return 1000;
  // A named space is identified by that name. A different one, even in the
  // same folder, is a different space (restore must not merge into it).
  if (saved.named) return saved.name === current.name ? 80 : -1;
  let score = 0;
  if (saved.name === current.name) score += 40;
  if (saved.folder && current.folder === saved.folder) score += 20;
  for (const cwd of savedPaneCwds) {
    if (currentPaneCwds.has(cwd)) {
      score += 12;
      break;
    }
  }
  return score;
}

function tabScore(saved, current) {
  if (saved.id && current.id === saved.id) return 1000;
  // Same for names: a named tab that isn't this one must not be reused just
  // because its number happens to match.
  if (saved.named) return saved.name === current.name ? 60 : -1;
  let score = 0;
  if (saved.name === current.name) score += 30;
  if (saved.index === current.index) score += 2;
  return score;
}

function currentSpacePaneCwds(space) {
  const tabIds = new Set((space.tabs ?? []).map((t) => t.id));
  return new Set(panes().filter((p) => tabIds.has(p.tab) && p.cwd).map((p) => p.cwd));
}

function claimedSpaces() {
  return new Set();
}

function findSpace(saved, claimed) {
  const current = spaces().filter((s) => !claimed.has(s.id));
  const savedPaneCwds = new Set(saved.tabs.flatMap((t) => t.panes.map((p) => p.cwd)).filter(Boolean));
  let best = null;
  for (const space of current) {
    const score = spaceScore(saved, space, savedPaneCwds, currentSpacePaneCwds(space));
    if (score > 0 && (!best || score > best.score)) best = { space, score };
  }
  return best?.space ?? null;
}

function findTab(space, saved, claimed) {
  let best = null;
  for (const tab of space.tabs ?? []) {
    if (claimed.has(tab.id)) continue;
    const score = tabScore(saved, tab);
    if (score > 0 && (!best || score > best.score)) best = { tab, score };
  }
  return best?.tab ?? null;
}

function sameCwd(a, b) {
  return (a ?? "").replace(/\/+$/, "") === (b ?? "").replace(/\/+$/, "");
}

// argv as saved can be a shell wrapper (`bash -c "sleep 120"`) while the live
// foreground is the program it started (`sleep 120`). Treat those as the same
// program so restoring twice doesn't add a second copy.
function commandsEquivalent(savedArgv, currentArgv) {
  if (!savedArgv?.length || !currentArgv?.length) return false;
  if (JSON.stringify(savedArgv) === JSON.stringify(currentArgv)) return true;
  const shell = savedArgv.findIndex((arg) => /(^|\/)(sh|bash|zsh|dash|ksh|fish|nu|elvish|xonsh)$/.test(arg));
  if (shell === -1) return false;
  const c = savedArgv.indexOf("-c", shell + 1);
  if (c === -1) return false;
  let script = savedArgv.slice(c + 1).join(" ").trim();
  if (script.startsWith("exec ")) script = script.slice(5);
  return script === currentArgv.join(" ");
}

function sameProgram(saved, pane, terminal) {
  if (!sameCwd(saved.cwd, liveCwd(pane, terminal))) return false;
  const currentAgent = isAgent(pane, terminal);
  if (saved.agent) {
    if (!currentAgent) return false;
    const currentKey = agentKeyOf(pane, terminal);
    return !saved.program || !currentKey || saved.program === currentKey || saved.app === currentKey;
  }
  const isShell = terminal?.program?.shell === true || pane.program?.shell === true;
  if (!saved.argv) return isShell;
  if (currentAgent || isShell) return false;
  const current = commandOf(pane, terminal);
  return Boolean(current) && commandsEquivalent(saved.argv, current);
}

function paneKey(tabId, index) {
  return `${tabId}:${index}`;
}

async function addPane(basePane, saved, settings, ctx, savedTab, index) {
  const argv = restoreArgv(saved, settings);
  const args = stripEmpty({
    argv,
    folder: saved.cwd || undefined,
    place: "right",
  });
  await appDo("pane.focus", { pane: basePane });
  let out;
  try {
    out = await appDo("terminal.open", args);
  } catch {
    out = await appDo("pane.split", stripEmpty({ direction: "right", pane: basePane, argv }));
  }
  ctx.panes++;
  const pane = out.pane ?? panes().find((p) => p.terminal === out.terminal)?.pane ?? basePane;
  if (out.tab) ctx.tabIds.set(savedTab.id, out.tab);
  ctx.paneIds.set(paneKey(savedTab.id, index), pane);
  return pane;
}

async function createTab(spaceId, savedTab, settings, ctx) {
  const first = savedTab.panes[0];
  const out = await appDo("tab.new", stripEmpty({
    space: spaceId,
    name: savedTab.named ? savedTab.name : undefined,
    folder: first?.cwd || undefined,
    argv: first ? restoreArgv(first, settings) : undefined,
  }));
  ctx.tabs++;
  const tabId = out.tab;
  ctx.tabIds.set(savedTab.id, tabId);
  if (first) {
    ctx.panes++;
    const pane = out.pane ?? panes().find((p) => p.terminal === out.terminal)?.pane ?? null;
    ctx.paneIds.set(paneKey(savedTab.id, 0), pane);
  }
  let base = ctx.paneIds.get(paneKey(savedTab.id, 0)) ?? null;
  for (let i = 1; i < savedTab.panes.length; i++) {
    if (!base) {
      const out2 = await appDo("terminal.open", stripEmpty({
        argv: restoreArgv(savedTab.panes[i], settings),
        folder: savedTab.panes[i].cwd || undefined,
        place: "tab",
      }));
      ctx.panes++;
      base = out2.pane ?? panes().find((p) => p.terminal === out2.terminal)?.pane ?? null;
      ctx.paneIds.set(paneKey(savedTab.id, i), base);
    } else {
      base = await addPane(base, savedTab.panes[i], settings, ctx, savedTab, i);
    }
  }
  await applyTabExtras(tabId, savedTab, ctx);
  return { tabId, base };
}

async function restoreTabPanes(space, savedTab, settings, ctx, claimedTabs) {
  const current = spaces().find((s) => s.id === space.id);
  if (!current) return null;
  const tab = findTab(current, savedTab, claimedTabs);
  if (!tab) {
    const created = await createTab(space.id, savedTab, settings, ctx);
    if (created?.tabId) claimedTabs.add(created.tabId);
    return created;
  }
  claimedTabs.add(tab.id);
  ctx.tabIds.set(savedTab.id, tab.id);
  const currentPanes = panesOfTab(tab.id);
  const used = new Set();
  const all = terminals();
  const terminalFor = (pane) => all.find((t) => t.address === pane.terminal) ?? null;
  let base = (currentPanes.find((p) => p.focused) ?? currentPanes[0])?.pane ?? null;
  for (let i = 0; i < savedTab.panes.length; i++) {
    const saved = savedTab.panes[i];
    const found = currentPanes.find((pane) => !used.has(pane.pane) && sameProgram(saved, pane, terminalFor(pane)));
    if (found) {
      used.add(found.pane);
      ctx.skipped++;
      ctx.paneIds.set(paneKey(savedTab.id, i), found.pane);
      if (!base) base = found.pane;
      continue;
    }
    if (!base) {
      const out = await appDo("terminal.open", stripEmpty({
        argv: restoreArgv(saved, settings),
        folder: saved.cwd || undefined,
        place: "tab",
      }));
      ctx.panes++;
      base = out.pane ?? panes().find((p) => p.terminal === out.terminal)?.pane ?? null;
      if (out.tab) ctx.tabIds.set(savedTab.id, out.tab);
      ctx.paneIds.set(paneKey(savedTab.id, i), base);
    } else {
      base = await addPane(base, saved, settings, ctx, savedTab, i);
    }
  }
  await applyTabExtras(tab.id, savedTab, ctx);
  return { tabId: tab.id, base };
}

async function applyTabExtras(tabId, savedTab, ctx) {
  if (!tabId) return;
  const zoomed = savedTab.panes.findIndex((p) => p.zoomed);
  if (zoomed !== -1) {
    const pane = ctx.paneIds.get(paneKey(savedTab.id, zoomed));
    if (pane) {
      try { await appDo("pane.zoom", { pane }); } catch {}
    }
  }
  if (savedTab.settled) {
    try { await appDo("tab.settle", { id: tabId }); } catch {}
  }
}

async function waitForMachines(cx, snapshot) {
  // null is this computer; its document must be ready before matching saved ids.
  const names = [null, ...new Set(snapshot.spaces.map((s) => s.machine).filter(Boolean))];
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const waiting = names.filter((name) => {
      const machine = machines().find((m) => (m.name ?? null) === name);
      return !machine || machine.layout === "loading";
    });
    if (!waiting.length) return;
    await wait(cx, 200);
  }
}

export async function restoreSession({ cx, auto = false } = {}) {
  if (busy) return false;
  busy = "restore";
  setShared("sessions.busy", "restore");
  cx?.notify();
  let changed = false;
  const ctx = {
    spaces: 0, tabs: 0, panes: 0, skipped: 0, errors: [],
    spaceIds: new Map(), tabIds: new Map(), paneIds: new Map(),
  };
  try {
    const snapshot = await readSnapshot();
    if (!snapshot) {
      if (!auto) notify({ title: "No saved sessions", body: "Save sessions first.", level: "info" });
      return false;
    }
    let settings = {};
    try { settings = (await readSettings()).data; } catch {}
    if (auto) await waitForMachines(cx, snapshot);
    const claimed = claimedSpaces();
    for (const savedSpace of snapshot.spaces) {
      if (savedSpace.machine) {
        const machine = machines().find((m) => m.name === savedSpace.machine);
        if (!machine || machine.layout !== "ready") {
          if (!auto) ctx.errors.push(`${savedSpace.machine}: machine unavailable`);
          continue;
        }
      }
      let space = findSpace(savedSpace, claimed);
      if (!space) {
        const firstTab = savedSpace.tabs[0];
        if (!firstTab || !firstTab.panes.length) continue;
        const first = firstTab.panes[0];
        const out = await appDo("space.new", stripEmpty({
          name: savedSpace.named ? savedSpace.name : undefined,
          folder: first.cwd || savedSpace.folder || undefined,
          tab: firstTab.named ? firstTab.name : undefined,
          argv: restoreArgv(first, settings),
          machine: savedSpace.machine || undefined,
        }));
        ctx.spaces++;
        changed = true;
        ctx.spaceIds.set(savedSpace.id, out.space);
        claimed.add(out.space);
        ctx.tabIds.set(firstTab.id, out.tab);
        ctx.panes++;
        const firstPane = out.pane ?? panes().find((p) => p.terminal === out.terminal)?.pane ?? null;
        ctx.paneIds.set(paneKey(firstTab.id, 0), firstPane);
        let base = firstPane;
        for (let i = 1; i < firstTab.panes.length; i++) {
          base = await addPane(base, firstTab.panes[i], settings, ctx, firstTab, i);
          changed = true;
        }
        await applyTabExtras(out.tab, firstTab, ctx);
        const current = spaces().find((s) => s.id === out.space);
        const claimedTabs = new Set([out.tab]);
        for (const savedTab of savedSpace.tabs.slice(1)) {
          const beforePanes = ctx.panes;
          const opened = current
            ? await restoreTabPanes(current, savedTab, settings, ctx, claimedTabs)
            : await createTab(out.space, savedTab, settings, ctx);
          if (opened) {
            ctx.tabIds.set(savedTab.id, opened.tabId);
            claimedTabs.add(opened.tabId);
          }
          if (ctx.panes > beforePanes) changed = true;
        }
        space = spaces().find((s) => s.id === out.space) ?? null;
      } else {
        claimed.add(space.id);
        ctx.spaceIds.set(savedSpace.id, space.id);
        const claimedTabs = new Set();
        for (const savedTab of savedSpace.tabs) {
          const beforeTabs = new Set((space.tabs ?? []).map((t) => t.id));
          const beforePanes = ctx.panes;
          const opened = await restoreTabPanes(space, savedTab, settings, ctx, claimedTabs);
          if (opened) {
            ctx.tabIds.set(savedTab.id, opened.tabId);
            if (!beforeTabs.has(opened.tabId)) changed = true;
          }
          if (ctx.panes > beforePanes) changed = true;
        }
      }
    }

    // Put the person back where they were (same space, tab and focused pane).
    const activeSpace = snapshot.spaces.find((s) => s.active);
    if (activeSpace) {
      const spaceId = ctx.spaceIds.get(activeSpace.id) ?? activeSpace.id;
      if (spaces().some((s) => s.id === spaceId)) {
        try { await appDo("space.select", { id: spaceId }); } catch {}
        const activeTab = activeSpace.tabs.find((t) => t.active);
        if (activeTab) {
          const tabId = ctx.tabIds.get(activeTab.id) ?? activeTab.id;
          if (panes().some((p) => p.tab === tabId)) {
            try {
              await appDo("tab.unsettle", { id: tabId });
              await appDo("tab.select", { id: tabId });
            } catch {}
            const focused = activeTab.panes.findIndex((p) => p.focused);
            if (focused !== -1) {
              const pane = ctx.paneIds.get(paneKey(activeTab.id, focused));
              if (pane) {
                try { await appDo("pane.focus", { pane }); } catch {}
              }
            }
          }
        }
      }
    }

    const count = ctx.panes;
    const errorText = ctx.errors.length ? `; ${ctx.errors[0]}` : "";
    if (changed || !auto || ctx.errors.length) {
      notify({
        title: ctx.errors.length ? "Sessions partly restored" : changed ? "Sessions restored" : "Sessions already open",
        body: `${ctx.spaces} new ${ctx.spaces === 1 ? "space" : "spaces"} · ${count} ${count === 1 ? "program" : "programs"} started${ctx.skipped ? ` · ${ctx.skipped} already running` : ""}${errorText}`,
        level: ctx.errors.length ? "warning" : "success",
      });
    }
    return changed;
  } catch (error) {
    notify({ title: "Couldn't restore sessions", body: String(error?.message ?? error), level: "error" });
    return false;
  } finally {
    busy = null;
    setShared("sessions.busy", null);
    cx?.notify();
  }
}

// Called once by the sidebar footer when Herdr starts with this layout shown.
export async function autoRestore(cx) {
  try {
    if (!(await autoRestoreEnabled())) return;
    const snapshot = await readSnapshot();
    if (!snapshot || !snapshot.spaces.length) return;
    const age = await appAge();
    // No `ps` (some platforms): auto-restore is unavailable; the button still works.
    if (age === null || age > 45) return;
    const token = String(Math.floor((Date.now() - age * 1000) / 1000));
    if (shared("sessions.auto_token") === token) return;
    await restoreSession({ cx, auto: true });
    setShared("sessions.auto_token", token);
  } catch (error) {
    setShared("sessions.auto_token", null);
    console.log(`sessions auto-restore: ${error?.message ?? error}`);
  }
}
