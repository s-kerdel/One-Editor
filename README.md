# One

*(formerly sec-edit; settings, sessions and secrets stay in the `sec-edit` data folder.)*

**A fast Markdown + code editor that works directly on your folders.** Obsidian-style notes, but **no vaults and no sync**: open any folder and edit.

| | |
|---|---|
| **Desktop app** | Electron. Windows first, Linux/macOS too. |
| **Browser mode** | A small local server. Handy from WSL. |
| **Full guide** | [`docs/USER-GUIDE.md`](docs/USER-GUIDE.md) |

---

## Run on Windows

**1. Build the package** (from WSL/Linux, no Windows tools needed):

```bash
npm install
npm run package:win
```

**2. Copy the zip out of WSL:**

```bash
explorer.exe release      # opens the folder in Windows Explorer
```

Drag **`One-win32-x64.zip`** to a Windows drive, e.g. `C:\Apps`.

**3. Unzip anywhere and run `One.exe`.**

> **SmartScreen warning?** The exe is unsigned. Click **More info → Run anyway** (once).

**4. Optional: right-click menu.** Double-click **`Add to Explorer menu.cmd`** in the app folder.

- Adds **"Open with One"** to files and folders.
- Current user only, no admin. Undo with `Remove from Explorer menu.cmd`.

### Open a folder or file

```bat
One.exe C:\notes                 :: open a folder
One.exe C:\notes\todo.md         :: open a file (inside its folder)
```

- A second launch **hands the path to the running window**.
- **Drag & drop** a folder or file onto the window also works.

---

## Browser mode

```bash
npm run build
npm run serve -- ~/notes --open
```

- Prints a **URL with an access token** and opens it.
- Listens on **127.0.0.1 only** by default. Options: `--port 4317`, `--host`, `--open`.
- **Zoom** uses the browser's own zoom here.
- **From the desktop app:** Settings → **Browser mode** → **Start web server** (or the palette). See the [user guide](docs/USER-GUIDE.md#browser-mode-web-server).

---

## Features

| Area | What you get |
|---|---|
| **Editor** | **Live preview** (syntax hides until the cursor is on it) · source, split and reading view · **`/` slash menu** · smart lists (indent, renumber, checkboxes) · table editing (`Tab` between cells) · **paste images** → saved as attachments · paste rich text → Markdown · `![[embeds]]` · **properties** editor for YAML frontmatter · `[[link]]`, `#tag` and code-language autocomplete |
| **Code** | Syntax highlighting · line comments, folding, multi-cursor · **formatting** for PHP, SQL, JS/TS, JSON, CSS/SCSS/Less, HTML, Vue, XML, YAML, GraphQL, shell, Markdown · format code blocks inside notes · respects `.prettierrc` and `.editorconfig` |
| **Search** | **Find in files** that takes pasted commands literally (`git push --force-with-lease`) · filters (`path:` `ext:` `lang:` `in:code` `tag:`) · `"phrase"`, `-exclude`, `OR`, `/regex/` · typo-tolerant fallback · **replace in files** · quick open and command palette |
| **Knowledge** | **Backlinks** + unlinked mentions · **outline** · **tags** · **graph** (global and local) · **renaming a file updates its links** · daily notes · templates |
| **Preview** | Callouts, footnotes, `==highlight==`, math (KaTeX), Mermaid diagrams · export to HTML · print |
| **PDF export** | **"Export note to PDF…"** (palette, editor or tab right-click) → a real PDF with code colours, math, diagrams and images. A4 / Letter / Legal, margins and page numbers in Settings → Export. Browser mode: the print dialog ("Save as PDF") |
| **Files** | Atomic saves · autosave · CRLF, BOM and encoding preserved · external changes detected · delete goes to the Recycle Bin |
| **Window** | **No Windows title bar** by default: minimize / maximize / close sit at the end of the tab strip, which is also where you drag the window. Native buttons, so **Snap Layouts** (hover maximize) and double-click-to-maximize work. Want the old title bar? Settings → Appearance → **Window frame: Native** → **Restart now** |
| **Layout** | **Two sidebar styles:** **Shelf** (default: workspace card, jump pill, panel pills, colour per folder, recent notes, editor as a card) or **Classic** (IDE-style icon bar). Switch in Settings → Appearance, or palette → "Switch sidebar style" |
| **Look** | **Accent colour** (swatches or any colour) · **rounded or square** corners · **density** (compact / comfortable / spacious) · editor font, line height · **text width** readable / wide / full. All in Settings → Appearance, applied live |
| **File overview** | **`Ctrl+Alt+B`** or the panel button at the end of the tab strip: a **right sidebar** for the open file — **outline** (code: classes / functions / methods), **code blocks** (copy a command in one click), **tasks** (tick them off), **links + backlinks**, **info** (words, reading time, size, tags). Follows the cursor. Remembered across restarts |
| **Status bar** | Click the **language** (bottom right) to change a file's highlighting — searchable list, remembered per file |
| **Terminal** (desktop) | **`` Ctrl+` ``** opens a terminal **in your folder**, at the bottom of the editor. Tabs with **coloured profile badges**, a **launcher** (`⊕ PowerShell 7 ▾`: every profile — PowerShell 7, Windows PowerShell, Command Prompt, Git Bash, **WSL distros**; Bash / Zsh / Fish elsewhere — ★ picks the default), **maximize** and **hide** (shells keep running), find, copy/paste, colours follow the theme. **Ctrl+click** a link or a path like `src/a.ts:12:3` to open it. Shell code blocks get a **▶ Run in terminal** button: it **types the command, you press Enter** |
| **Git** | If the folder is a git repository: **tree marks** (M / A / U / D / R / ! for conflicts, ignored files dimmed, a dot on folders with changes) · **branch in the status bar** (↑ ahead / ↓ behind, dirty dot; click → copy name, "Show changes" filters the tree) · **change bars** next to the text (added / changed / deleted, live while you type; click a bar → old lines + **Revert this change**) · **Diff with last commit** (unified or side by side). **`Ctrl+Shift+G` Git panel:** stage / unstage, discard (always asks; new files go to the Recycle Bin), **commit** (`Ctrl+Enter`, amend), **fetch / pull / push** with your own git login, branches, history, merge conflicts (**Accept current / incoming / both** in the editor). Uses **your installed git**. No force-push, no reset |
| **Compare text** | Right-click in the editor: **Compare Text with Clipboard** · **Select Text for Compare** → **Compare Text with Previous Selection** (any two files, code or notes). Uses **git's own diff** (`--histogram`; built-in diff when git is missing). Unified or side by side, word-level highlights, **Swap sides**, **Ignore whitespace**, **Copy as patch**. Tree / tab right-click: **Compare with Clipboard**. Off switch: Settings → Editor → **Compare text** |
| **Variables & targets** | Write **`{{host}}`, `{{user}}`, `{{WS01.ip}}`** in commands; values come from the **nearest `variables.md`** (a YAML block: vars, **environments**, **targets**). Live mode shows **chips** with the value (hover = source, click = edit, file stays raw). **`env: lab ▾`** / **`⌖ DC01 ▾`** in the status bar (prod tinted red). Copy / ▶ Run use the values; missing ones are asked for. **Copy / Run for several targets**. **Secrets** in an encrypted vault (desktop), `••••` in preview and exports |
| **Smart paste** (opt-in) | After a paste: **"Paste as…"** JSON block · formatted **curl** or curl **as template** (`{{host}}`, `{{token}}`) · stack trace → log block with clickable `file:line` · CSV / Excel → table · SQL formatted · VS Code code fenced in its language · **secret → `{{variable}}`**. Settings → Editor → Smart paste |
| **Claude Code** (desktop) | If `claude` is installed: **"Claude Code"** in the launcher, plus **Claude: Ask about this file / selection** (palette or editor right-click). It **types** a prompt like `@notes/a.md lines 12-30`; **you review and press Enter**. No API keys, no network calls from the app |

**Every setting has a control:** press `Ctrl+,`. The search box there also finds shortcuts.

---

## Keyboard shortcuts

`Ctrl` = `Cmd` on macOS. The **full, live list** is in **Settings → Keyboard shortcuts**.

### Go and search

| Keys | Action |
|---|---|
| `Ctrl+P` / `Ctrl+O` | Quick open (go to file) |
| `Ctrl+Shift+P` / `F1` | Command palette |
| `Ctrl+Shift+O` | Go to heading / symbol in this file |
| `Ctrl+T` | Go to heading in the workspace |
| `Ctrl+G` | Go to line |
| `Ctrl+Shift+F` | Find in files |
| `Ctrl+Shift+H` | Replace in files |
| `F4` / `Shift+F4` | Next / previous search result |
| `Ctrl+F` / `Ctrl+H` | Find / replace in this file |

### Files, tabs and view

| Keys | Action |
|---|---|
| `Ctrl+N` | New note |
| `Ctrl+S` | Save |
| `Ctrl+W` | Close tab (or **double-click the tab name**) |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab (recently used) |
| `Ctrl+E` | Toggle editing ↔ reading view |
| `Ctrl+\` | Toggle split preview |
| `Ctrl+Shift+B` | Toggle sidebar (**remembered** across restarts) |
| `Ctrl+Alt+B` | Toggle **file overview** (right sidebar, remembered) |
| `Ctrl+Alt+O` / `Ctrl+Alt+L` / `Ctrl+Alt+G` | Outline / backlinks / graph |
| `Ctrl+,` | Settings |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom in / out / reset (**desktop only**) |
| `F12` | Developer tools (**desktop only**) |
| `` Ctrl+` `` | **Terminal** panel: open / focus / hide (**desktop only**) |
| `` Ctrl+Shift+` `` | New terminal |
| `F2` / `Del` in the file tree | Rename / delete |

### Writing

| Keys | Action |
|---|---|
| `/` | Slash (insert) menu |
| `Ctrl+B` / `Ctrl+I` | Bold / italic |
| `Ctrl+Shift+X` | Strikethrough |
| `Ctrl+K` | Insert link |
| `Ctrl+1` … `Ctrl+6` | Heading 1 … 6 |
| `Ctrl+Enter` | Toggle checkbox |
| `Tab` / `Shift+Tab` | Indent / outdent list item |
| `Ctrl+Shift+V` | Paste exactly as copied (plain text, trailing spaces kept) |

### Git

| Keys | Action |
|---|---|
| `Ctrl+Shift+G` | Git panel (stage, commit, push, branches, history) |
| `Ctrl+Enter` | Commit (in the message box) |
| `Alt+F5` / `Shift+Alt+F5` | Next / previous change in this file |
| `Esc` | Close the change peek |

### Terminal (when it has focus)

| Keys | Action |
|---|---|
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | Copy / paste (Windows also: `Ctrl+C` with a selection, `Ctrl+V`) |
| `Ctrl+F` | Find in the terminal output |
| `Ctrl+click` | Open a link or a file path |
| Other `Ctrl` keys | **Go to the shell** (`Ctrl+W`, `Ctrl+E`, `Ctrl+R`…). Still the app's: `` Ctrl+` ``, `Ctrl+Shift+P`, `Ctrl+P`, `Ctrl+S`, `Ctrl+,`, `Ctrl+Tab`, zoom |

### Code

| Keys | Action |
|---|---|
| `Shift+Alt+F` | **Format document** |
| `Ctrl+Alt+F` | Format selection / code block at cursor |
| `Ctrl+/` | Toggle line comment |
| `Ctrl+D` | Add selection to next match |
| `Alt+↑` / `Alt+↓` | Move line up / down |
| `Shift+Alt+↓` | Duplicate line |
| `Ctrl+Shift+[` / `Ctrl+Shift+]` | Fold / unfold at cursor |
| `Ctrl+Alt+[` / `Ctrl+Alt+]` | Fold all / unfold all |

---

## Search query syntax

**Plain text is searched literally**, so pasted commands just work. Operators are opt-in:

| Type this | Finds |
|---|---|
| `kubectl get pods -o wide` | Lines with all of these words (`-o` is a flag, not an exclusion) |
| `"exact phrase"` | The exact phrase |
| `deploy -staging` | "deploy", but not in files with "staging" |
| `\-staging` | The literal text `-staging` |
| `nginx OR apache` | Either word |
| `/user_\d+/` | Regular expression (add `i` for ignore case: `/foo/i`) |

**Filters** (prefix with `-` to negate, e.g. `-path:archive`):

| Filter | Limits results to |
|---|---|
| `path:notes/work` | Files whose path matches |
| `file:todo` | Files whose **name** matches |
| `ext:php,sql` | File extensions |
| `lang:sql` | Files or code blocks in that language |
| `in:code` | Code only. Also `in:text`, `in:heading`, `in:frontmatter`, `in:link` |
| `tag:project` | Notes with that tag (also nested: `project/x`) |
| `case:yes` | Force case-sensitive (`case:no` = insensitive) |

- **Case:** smart by default. Lowercase query = ignore case; any capital = match case.
- **Toggles in the panel:** match case `Alt+C`, whole word `Alt+W`, regex `Alt+R`.

**Quick open prefixes** (`Ctrl+P`):

| Prefix | Mode |
|---|---|
| *(none)* | Files. Also `file#heading` and `file:42` |
| `>` | Commands |
| `#` | Headings in the workspace |
| `@` | Headings / symbols in this file |
| `:` | Go to line |

---

## Develop

| Command | Does |
|---|---|
| `npm run build` | Renderer (Vite) + Electron/server entries (esbuild) |
| `npm run electron -- <folder>` | Desktop app from the build |
| `npm run serve -- <folder> --open` | Browser mode |
| `npm run package:win` / `package:linux` | Ready-to-run build + zip in `release/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run analyze` | What is in the startup JS bundle |

### Tests

| Command | Covers |
|---|---|
| `npx vitest run` | Unit tests |
| `npx playwright test` | Browser E2E (real server per worker) |
| `npm run test:electron` | Real Electron app under Xvfb |

On WSL start Xvfb first: `~/.local/xvfb/start-xvfb.sh :99`.

---

## Architecture

```
 ┌──────────────── renderer (Preact + signals, one codebase) ────────────────┐
 │  shell: layout · tree · tabs · settings      editor (CodeMirror, lazy)    │
 │  search · knowledge · format (workers)       preview (markdown-it, lazy)  │
 │                    platform/: picks the transport ↓                        │
 └───────────────┬───────────────────────────────────────┬───────────────────┘
       Electron IPC (preload bridge)            HTTP RPC + SSE (token)
 ┌───────────────┴──────────────┐         ┌──────────────┴─────────────────┐
 │ src/main  (Electron main)    │         │ src/server  (browser mode)     │
 │ app:// protocol + code cache │         │ 127.0.0.1 only, Host-checked   │
 │ terminal: node-pty (ConPTY)  │         │ no terminal (ENOTSUP)          │
 └───────────────┬──────────────┘         └──────────────┬─────────────────┘
                 └──────────── src/backend ──────────────┘
          Workspace: tree index · atomic saves · encodings · watcher → events
```

- **Paths** crossing the boundary are workspace-relative POSIX (`notes/a.md`).
- **Heavy parts load lazily** (highlighter, formatter, math, diagrams), so startup stays fast.
- **Contributor rules and extension points:** [`docs/AGENTS.md`](docs/AGENTS.md).

---

## Where things are stored

| Data | Location |
|---|---|
| **Settings**, recent folders, sessions, window state | `%APPDATA%\sec-edit` (Windows) · `~/.config/sec-edit` (Linux) · `~/Library/Application Support/sec-edit` (macOS) |
| **Your notes** | Only in the folders you open |

Pasted images are saved into your folder (default: `attachments/`). Nothing else is written there.

---

## Licence

**GPL-3.0-or-later.** See [`LICENSE`](LICENSE).
