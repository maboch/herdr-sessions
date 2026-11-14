import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, props, window, shared, setShared, updates, layout, nextCommand } from "herdr";
import { autoRestore, autoRestoreEnabled, saveSession, restoreSession, sessionSummary, setAutoRestore } from "./sessions.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

export default class WorkspaceChrome extends View {
  init(_props, cx) {
    // The brand block and the footer share this mod; only the footer owns the
    // session buttons, keys and the one auto-restore at startup.
    if (!props()?.footer) return;
    setShared("sessions.busy", null);
    cx.spawn(async (cx) => {
      const on = await autoRestoreEnabled();
      setShared("sessions.auto_restore", on);
      const summary = await sessionSummary();
      setShared("sessions.saved_at", summary?.saved_at ?? null);
      cx.notify();
      if (on) await autoRestore(cx);
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "save") await saveSession(cx);
        else if (command === "restore") await restoreSession({ cx });
        else if (command === "auto") await setAutoRestore(shared("sessions.auto_restore") !== true);
        cx.notify();
      }
    });
  }

  button(id, label, action) {
    const t = theme();
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
  }
  render() {
    const t = theme();
    const collapsed = narrow();
    if (props()?.footer) {
      const busy = shared("sessions.busy");
      const savedAt = Number(shared("sessions.saved_at")) || null;
      const autoOn = shared("sessions.auto_restore") === true;
      const spinner = () => svg("mods/sessions-chrome/spinner.svg").size(14).flex_none().text_color(t.working).spin(900);
      const row = (id, icon, label, dim, action, trailing, tip) => {
        const spinning = (id === "save" && busy === "save") || (id === "restore" && busy === "restore");
        return h_flex().id(id).h(28).px(8).gap(9).items_center().rounded(8)
          .when(collapsed, el => el.relative().w(32).px(0).justify_center().tooltip(tip ?? label))
          .text_color(dim ? t.dim : t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
          .on_click(action)
          .child(spinning ? spinner() : svg(`mods/sessions-chrome/${icon}.svg`).size(14).flex_none())
          .when(!collapsed, el => el.child(div().flex_1().min_w(0).truncate().child(label)))
          .when(!collapsed && Boolean(trailing), el => el.child(trailing));
      };
      const shortcut = (keys) => div().flex_none().text_size(10).text_color(t.dim).child(keys);
      const ready = div().size(6).rounded_full().bg(t.accent);
      const savedHint = savedAt ? `Last saved ${new Date(savedAt).toLocaleString()}` : "No saved session yet";
      const autoPill = div().flex_none().px(6).h(17).rounded(5).flex().items_center().text_size(10.5)
        .bg(autoOn ? t.accent + "22" : t.raised).text_color(autoOn ? t.accent : t.dim)
        .child(autoOn ? "On" : "Off");
      return v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).px(8).pt(4).pb(8).text_size(13)
        .when(collapsed, el => el.px(0).items_center())
        .child(row("save-session", "save-session", busy === "save" ? "Saving…" : "Save sessions", false,
          () => saveSession(), shortcut("Ctrl+Shift+S"), "Save every running program (Ctrl+Shift+S)"))
        .child(row("restore-session", "restore-session", busy === "restore" ? "Restoring…" : "Restore sessions", false,
          () => restoreSession({}), shortcut("Ctrl+Shift+R"), `${savedHint} (Ctrl+Shift+R)`))
        .child(row("auto-restore", "auto-restore", "Auto-restore sessions", true,
          () => setAutoRestore(!autoOn), autoPill, "Restore saved sessions automatically when Herdr starts"))
        .child(row("settings", "settings", "Settings", false, () => run("app.settings"))
          .when(Boolean(updates().app.ready), el => el.child(collapsed ? ready.absolute().top(5).right(6) : ready)))
        .child(row("machine", "plus", "Add machine", true, () => run("mod.open", { name: "machine-add" })));
    }
    return h_flex().size_full().bg(t.chrome).pl(collapsed ? 6 : 14).pr(10).gap(4).items_center().text_size(13.5)
      .when(window()?.platform === "macos" && !window()?.fullscreen && !collapsed, el => el.pl(76))
      .when(!collapsed, el => el.child(h_flex().flex_1().gap(8).items_center().child(image("frame/welcome/herdr.png").size(20).rounded(5)).child(div().font_semibold().text_color(t.foreground).child("Herdr"))))
      .when(!collapsed, el => el.child(this.button("search", svg("mods/sessions-chrome/search.svg").size(15), () => run("mod.open", { name: "picker" }))))
      // On the macOS rail the traffic lights fill the row; the agents list's » unfolds it.
      .when(!(collapsed && window()?.platform === "macos"), el => el.child(this.button("sidebar-toggle", svg("mods/sessions-chrome/sidebar.svg").size(15), toggleSidebar)));
  }
}
