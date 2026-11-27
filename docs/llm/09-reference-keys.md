# 09 - Reference: key bindings

> **WHEN TO READ THIS:** before you bind any key, global or local.
> **WHAT YOU GET:** the **global keybinding allocation** table (which keys are taken, by whom) and the terminal key rules.
> **NEXT FILE:** `09-reference-rules.md`

**Do not read this file whole.** Find your keyword, then read only that section:

```bash
grep -n "keyword" docs/llm/09-reference*.md
```

## Global keybinding allocation (avoid conflicts)

**Check this table before binding a key. Add your key to it.**

| Owner | Keys |
|---|---|
| shell | `Mod-s` save, `Mod-w` close tab, `Mod-n` new note, `Mod-Shift-n` new window (desktop only, see below), `Mod-Shift-b` sidebar, `Mod-Alt-k` Bookmarks panel, `Mod-Alt-z` zen mode (also in `APP_KEYS_IN_TERMINAL`), `Mod-e` toggle edit/preview, `Mod-\` split, `Ctrl-Tab`/`Ctrl-Shift-Tab` tabs, `Mod-,` settings, `Mod-=`/`Mod--`/`Mod-0` zoom, `Mod-Shift-i` developer tools (desktop, Windows/Linux; macOS `Cmd-Alt-i` is the default app menu's, so the command only *displays* it — binding it too would toggle twice). |
| search | `Mod-p`/`Mod-o` quick open, `Mod-Shift-p`/`F1` palette, `Mod-Shift-f` find in files, `Mod-Shift-h` replace in files, `Mod-Shift-o` go to heading, `Mod-t` workspace symbol/heading |
| format | `Shift-Alt-f` format document, `Mod-Alt-f` format selection/code block |
| editor (CM-local, not global) | `Mod-b` bold, `Mod-i` italic, `Mod-k` link, `Mod-f`/`Mod-h` in-file find/replace, `Mod-d`, `Mod-/`, `Mod-Enter` toggle checkbox, `Alt-Up/Down` move line, `Mod-Shift-v` paste exactly as copied (plain text, no trailing-whitespace trim, no smart paste), `/` slash menu, `Alt-F10` focus formatting toolbar, code files only: `F12` go to definition, `Shift-F12` find usages, `Mod`+click go to definition (multi-cursor is `Alt`+click), … |
| knowledge | `Mod-Alt-o` outline, `Mod-Alt-l` backlinks, `Mod-Alt-g` graph |
| git | `Mod-Shift-g` Source control panel, `Alt-F5` / `Shift-Alt-F5` next / previous change; pane-local `Mod-Enter` commit; diff view `F7` / `Shift-F7`, `Esc`, editable diff: `Mod-F7` revert the block at the cursor (compare: apply it to the right side), compare: `Mod-Shift-F7` apply the block at the cursor to the left side, `Mod-s` saves the diff's file(s) (key filter while it is open), `Mod-z` / `Mod-y` / `Mod-Shift-z` reach the diff's own undo when no editor in it has focus (window capture, only while a diff with an editable side is open) |
| overview | `Mod-Alt-b` toggle file overview (right sidebar) |
| nav | `Alt-ArrowLeft` / `Alt-ArrowRight` go back / forward (macOS: `Mod-[` / `Mod-]`); mouse side buttons (`button` 3 / 4, window capture, not a key). |
| pdf (viewer-local, focus inside `.se-pdf` only; beats shell's UI zoom via `addGlobalKeyFilter`) | `Mod-f` find, `Mod-=`/`Mod--`/`Mod-0` + `Ctrl`-wheel zoom, `Mod-g` page box |
| terminal | ``Mod-` `` toggle / focus / hide panel, ``Mod-Shift-` `` (+ `Mod-Shift-~`) new terminal. |
| terminal (xterm-local, focused terminal only) | `Mod-Shift-c`/`Mod-Shift-v` copy/paste, `Mod-f` find, `Shift-Insert`/`Ctrl-Insert`; Windows also `Ctrl-c` (with a selection) / `Ctrl-v`; macOS `Cmd-c/v/f/a/k` (a real Cmd chord; a Ctrl chord that arrives as Cmd follows the Windows rules, below) |

## Notes per owner

### shell

- **`F12` is no longer DevTools** (it moved in v0.5.4: Go to definition)
- **`Mod-Shift-n` = New window** (`window.new` in `app/shell.ts`):
  - desktop only: registered only when `app.backend.newWindow` exists, so browser mode leaves `Ctrl+Shift+N` to the browser;
  - in `APP_KEYS_IN_TERMINAL`: it passes through a focused terminal (xterm.js sends nothing for Ctrl+Shift+letter);
  - macOS File → New Window (`main/app-menu.ts`) only *shows* `CmdOrCtrl+Shift+N`: `registerAccelerator: false`, the renderer's command owns the key (page and terminal alike).

### nav

- **Precedence:** global, so they beat CodeMirror's default `Alt-ArrowLeft/Right` (`cursorSyntaxLeft/Right`; on macOS `Mod-[` / `Mod-]` = indent less / more), as in VS Code.
  - Those stay in the palette ("Editor: Move cursor to syntax node start / end") and on `Tab` / `Shift-Tab`.
  - `Shift-Alt-ArrowLeft/Right` (select syntax) is untouched.
- Not in `APP_KEYS_IN_TERMINAL`: in a focused terminal `Alt-←/→` stays readline's word move (the side buttons work there).
- On a focused ← → button (local, the browser's own context-menu keys): `Shift-F10` / `ContextMenu` open its recent-places list

### terminal

- **macOS also ``Ctrl-` `` / ``Ctrl-Shift-` ``** (shown in hints): ``Cmd-` `` is the OS's "cycle windows" and may never reach the page.
- **The macOS menu (`main/app-menu.ts`) has no Reload accelerators.**
  - Cmd/Ctrl+R would kill the shells; Ctrl+R is readline's reverse-search.
  - Dev builds keep Reload as a key-less menu item.
- Also `Mod-Alt-a` AI changes panel (in `APP_KEYS_IN_TERMINAL`; command in `terminal/install.ts`, key in `ui.PANEL_KEYS`).

## Keys while a terminal has focus

- While a terminal has focus **only** `APP_KEYS_IN_TERMINAL` (`src/renderer/terminal/keys.ts`) reach global commands on Windows/Linux — everything else goes to the shell (readline's `Ctrl-w/e/n/t/k/b/r`, F-keys for htop/mc).
- Add a key there only if it must beat the shell.

## macOS terminal keys

- **macOS terminal keys are decided by the modifiers the event carries, never by the keyboard's labels** (`keys.ts`; `tests/unit/terminal/keys.test.ts` covers both keyboards):

- **Control key (no Cmd) = the shell's**, always: `Ctrl-r/c/d/z/l/a/e/w/u/k`… reach xterm.js untouched.
- Only ``Ctrl-` ``, ``Ctrl-Shift-` `` and `Ctrl-Tab` / `Ctrl-Shift-Tab` are the app's (`MAC_CTRL_KEYS`); a global command bound to another `Ctrl-…` key does not run in a terminal.
- The macOS menu (`main/app-menu.ts`) must hold **no accelerator without Cmd** (Electron resolves every role there to a Cmd chord; a Cmd-less key equivalent would run before the page), and main has no `before-input-event` / `globalShortcut`.

- **A real Cmd chord** keeps the Mac conventions: `Cmd-c/v/f/a/k` are the terminal's, every other app key wins, nothing is sent to the shell.

- **A Ctrl chord that arrives as a Cmd chord is read as that Ctrl chord.**
  - Cause: a Windows-style remap (Karabiner-Elements "Windows shortcuts": `Ctrl+<key>` → `Cmd+<key>` in every app that is not on its list of terminal emulators; One is not).
  - `APP_KEYS_IN_TERMINAL` decides what the app keeps (so `Cmd-w/e/n/k/a` go to the shell).
  - `Cmd-c` copies only with a selection (else `^C`). `Cmd-v` pastes. `Cmd-f` finds.
  - Every other letter and `[ \ ]` is sent as its control byte by the view (`term.input`: xterm.js encodes nothing for Cmd+letter).
  - The view sends it with `preventDefault` (else the menu's `Cmd-w` Close Window / `Cmd-z` / `Cmd-a` would run too).
- `createCmdTracker` recognises it from the event stream: the remapper lets go of Control and presses Cmd for the user ≤ `REMAP_GAP_MS` (30 ms) apart (Karabiner: a fixed 5 ms; left Control: keyup first, right Control: Cmd first), fingers are slower; it holds for as long as that Cmd stays down.
- Setting **`terminal.cmdSendsCtrl`**: `auto` (detect; default) | `on` (every Cmd chord in the terminal: for swaps that leave no trace, e.g. System Settings → Modifier Keys) | `off`.
- The tracker is fed by `watchModifiers(window)` in `entry.ts` (macOS only); the global key filter and the view ask the same instance.
