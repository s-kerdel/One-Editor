# One user guide

**Open a folder, then edit.** Everything below is optional detail. Jump to what you need.

| I want to… | Go to |
|---|---|
| Open folders and files | [1. Folders and files](#1-folders-and-files) |
| Read a PDF | [PDF files](#pdf-files) |
| Write notes faster | [2. Writing notes](#2-writing-notes) |
| Link notes together | [3. Links and knowledge](#3-links-and-knowledge) |
| Find something | [4. Search](#4-search) |
| Format code | [5. Code and formatting](#5-code-and-formatting) |
| Jump to where a function or class is defined | [Go to definition](#go-to-definition) |
| Read or export a note | [6. Preview and export](#6-preview-and-export) |
| Make a PDF of a note | [Export to PDF](#export-to-pdf) |
| Run commands / use Claude Code | [7. Terminal and Claude Code](#7-terminal-and-claude-code) |
| See changes, commit, push | [8. Git](#8-git) |
| Write full screen, without distractions | [Zen mode](#zen-mode) |
| Change how it behaves | [9. Settings](#9-settings) |
| Open this folder in a web browser (phone, tablet, another PC) | [Browser mode](#browser-mode-web-server) |
| Let an AI app (LM Studio, Codex CLI, Claude) read or edit my notes | [MCP server](#mcp-server-ai-apps) |
| Know when One itself needs a security rebuild | [Security updates](#security-updates) |
| Put `{{host}}`, `{{user}}`… in commands | [10. Variables & targets](#10-variables--targets) |
| Turn a pasted curl / JSON / log into a clean block | [11. Smart paste](#11-smart-paste) |
| Fix a problem | [12. Troubleshooting](#12-troubleshooting) |

> `Ctrl` = `Cmd` on macOS. **Forgot a shortcut?** `Ctrl+Shift+P` lists every command.

---

## 1. Folders and files

**A workspace is just a folder.** Nothing is added to it, except attachments you paste.

| Do this | How |
|---|---|
| Open a folder | Drag it onto the window, or run `One.exe C:\notes` |
| Open a file | `Ctrl+P`, type part of the name, `Enter` |
| New note | `Ctrl+N`, then type its name |
| Rename / delete | `F2` / `Del` in the file tree |
| Move | Drag the file onto a folder |
| **Select several** | `Ctrl`+click, `Shift`+click, `Shift+↑/↓`, `Ctrl+A` in the file tree ([below](#select-several-files)) |
| **Bookmark** a file or folder | Right-click → **Bookmark** (tree or tab). Panel: `Ctrl+Alt+K` ([below](#bookmarks)) |
| Close tab | `Ctrl+W`, **double-click the tab name**, middle-click the tab, or its × |
| Switch tabs | `Ctrl+Tab` (most recently used first) |
| **Go back / forward** | `Alt+←` / `Alt+→` (macOS: `Cmd+[` / `Cmd+]`), the **← → buttons** at the left of the status bar, or the **mouse side buttons** anywhere in the window |

**A workspace stays inside its folder.** A link in it (symlink, Windows junction) that points **outside** the folder is not shown, opened, searched or written through. Links to places **inside** the folder work as before. Need that other folder? Open it itself.

**Go back returns to where you were**: the previous file (reopened if you closed it), or the spot before a big jump (find, go to line, outline, a click far away). PDFs go back to the page before a link or a typed page. Typing and small cursor moves are not steps.

**The ← → buttons** sit at the **far left of the status bar**: `← → │ folder › path…`. Same spot in Shelf and Classic.

**Zen mode** hides the status bar, so the buttons go with it. The shortcuts and side buttons still work. Want them? Settings → Appearance → Zen mode → **Keep the status bar**.

| | |
|---|---|
| **Greyed out** | Nothing to go back / forward to yet |
| **Jump several steps** | **Right-click or hold** an arrow → the recent places that way (file + heading or line), listed **above** the arrow. Click one |
| **Keyboard** | `Tab` to an arrow · `Shift+F10` (or the menu key) opens the list · `↑` `↓` `Enter` · `Esc` closes it |
| **Hide them** | Settings → Appearance → **Back and forward buttons** (the `│` goes too). The shortcuts and side buttons keep working |

### Select several files

| Do this | How |
|---|---|
| Add / remove one row | `Ctrl`+click (macOS: `Cmd`+click) |
| A range | `Shift`+click, or `Shift+↑` / `Shift+↓` (also `Shift+Home` / `End` / `PgUp` / `PgDn`) |
| Add a range | `Ctrl+Shift`+click |
| Everything shown | `Ctrl+A` while the tree has focus |
| **Back to one row** | `Esc`, a plain click, or a plain arrow key |

The tree's foot says **"N selected"**. The **focused row** (where the arrows go on from) has a ring.

**What works on a selection** — right-click a selected row, or press the key:

| Action | What happens |
|---|---|
| **Open** (`Enter`) | The files open as tabs; folders are skipped. **At most 20** at once. |
| **Delete** (`Del`) | **One question** with the count and the first names. A selected folder takes its selected children along. |
| **Move** | Drag any selected row onto a folder: **all of them move** and stay selected. A folder never goes into itself: that drop is refused. |
| **Copy paths** / **Copy relative paths** | One path per line, in tree order. |
| **Bookmark N items** | All of them go to [Bookmarks](#bookmarks). A selected folder takes its selected children along. |
| **Stage changes** / **Unstage** | In a git folder: the files among them that can be. |

- **One-item actions are hidden** while several rows are selected: rename, new note / folder here, duplicate, reveal, export, diff. `F2` renames the focused row only.
- **Rows that disappear leave the selection**: deleted, moved, filtered out, or inside a folder you fold. Files changing on disk keep it.
- Right-clicking a row **outside** the selection selects just that row.

### Bookmarks

**Pin the files and folders you use most.** The **Bookmarks** panel (bookmark icon, 4th in the sidebar) lists them in your order. `Ctrl+Alt+K` opens it.

| Do this | How |
|---|---|
| **Add** | Right-click a file, folder or tab → **Bookmark** · several selected rows → **Bookmark N items** · palette: "Bookmark current file" · the **+** in the panel |
| **Add by dragging** | Drag tree rows or a tab onto the **Bookmarks icon** (rest on it to open the panel), or into the panel at the place you want |
| **Open** | Click a file. A **folder unfolds** right there as a small tree (click its files and folders) |
| **Reorder** | Drag a bookmark up or down · `Alt+↑` / `Alt+↓` · right-click → Move up / down |
| **Name it** | Right-click → **Rename bookmark…** (or `F2`). Only the bookmark is renamed, never the file. Empty = the file name again |
| **Remove** | The **✕** on hover · right-click → Remove bookmark · `Del` · or **Remove bookmark** in the tree / tab menu |

- **Renames and moves are followed**: in One (rename, drag to another folder) and **outside** it (Explorer, git, a script). A renamed folder takes the bookmarks inside it along.
- **Gone?** A bookmark whose file or folder is missing shows **greyed** with a **Remove** button. Restored from the bin: it is normal again.
- **Git colours** show like in the file tree (Settings → Files → Git colours in the file tree).
- **Kept per folder, in One's own data folder** (`bookmarks/` next to `settings.json`) — **never in your folder**. Desktop app and browser mode share them.
- Keyboard in the panel: `↑` `↓` move, `Enter` opens, `→` / `←` unfold / fold, `Esc` back to the text.

### Sidebar styles

**Pick one in Settings → Appearance → Sidebar style** (or palette: "Switch sidebar style").

| Style | Looks like | Panels |
|---|---|---|
| **Shelf** (default) | Workspace card on top, a **Jump to…** pill (`Ctrl+P`), Recent notes, a colour per top-level folder, the editor as a raised card | Pills under the jump pill; the active pill shows its name |
| **Classic** | IDE-style: icon bar on the far left, dense tree with guides, full-width status bar | Icon bar; click the open panel again to hide the sidebar |

Both: `Ctrl+Shift+B` hides / shows the sidebar. In Shelf, the sidebar button at the top (or at the start of the tab strip when hidden) does the same. Classic: click the open panel's icon.

**Hidden stays hidden.** The sidebar comes back the way you left it after a restart or refresh — shown or hidden, same width.

### Sidebar menu (order, hide)

**Arrange the panel pills / icons the way you work.** Default: Files · Search · Git · Bookmarks │ Outline · Backlinks · Tags.

| Do this | How |
|---|---|
| **Hide one** | Right-click its pill or icon → **Hide …** |
| **Reorder, show again** | Right-click → **Customize sidebar…** (or Settings → Appearance → **Sidebar menu**, palette: "Customize sidebar menu") |
| In that list | Drag by **⠿** · the **↑ / ↓** buttons · `Alt+↑` / `Alt+↓` on a focused entry · the checkbox shows / hides |
| **Back to the default** | **Reset to default** under the list (or its ↺) |

- **A hidden panel still works**: its shortcut (`Ctrl+Shift+F`, `Ctrl+Alt+K`…) or the palette ("View: Show Files"…) opens it. While it is open its pill shows; it goes once you switch.
- **At least one** entry stays: the last checkbox is locked.
- **Panels added in a later version** appear at their default place, shown. Your order and hidden ones stay.
- Both sidebar styles and the zen strip use the same order. It is there from the first frame: nothing jumps at startup.

**A calmer tree** (Settings, both styles, combine freely):

| Setting | Choices | What changes |
|---|---|---|
| Appearance → **Folder colours** | **Per top-level folder** (default) · **One colour** | One colour: every folder icon alike (Classic always looks like this) |
| Appearance → **Folder colour** | Grey (default) · swatches · **+** any colour | The one colour. Tuned per theme so it stays visible. **↺** = grey again |
| Files → **Git colours in the file tree** | On (default) · Off | Off: no git colours, letters or dots in the tree. Git keeps working (Source control, branch, change bars). Palette: "Toggle git colours in file tree" |

### Zen mode

**`Ctrl+Alt+Z` goes full screen and folds the panels away.** Again to leave. Or the **zen button** bottom left (next to the theme and settings buttons; Classic: in the icon bar).

| | |
|---|---|
| **Stays** | Your tabs. The status bar only if you keep it |
| **Thin strips** | Sidebar on the left. File overview on the right (only if it was open) |
| **Peek at a panel** | Click its icon on a strip, or use its shortcut (`Ctrl+Shift+F`, `Ctrl+Alt+B`…). It opens over the text |
| **Close the peek** | Click back in the text, press `Esc`, or click the icon again |
| **Hidden** | Terminal, process explorer (Classic: also the icon bar) |
| **Leave** | `Ctrl+Alt+Z` · zen button at the **bottom of the left strip** · zen button at the **right end of the tab strip** |
| **Options** | Settings → Appearance → Zen mode: **Full screen** (on), **Keep the status bar** (off) |

- **Leaving puts everything back** exactly as it was: sidebar, width, panel, overview, terminal, window size.
- **Left full screen another way** (the OS, or holding `Esc` in a browser)? Zen stays and keeps working. Leave it as usual.
- **Already full screen** before zen? It stays full screen when you leave zen.
- **Remembered:** still in zen after a refresh or restart. The desktop app goes full screen again.
- **Browser mode:** full screen only starts from a key press or click, so after a refresh zen comes back without it. In Chrome / Edge a short `Esc` stays the editor's (close find, palette): **hold `Esc`** to leave full screen.
- **"Keep the file tree" is gone.** The left strip opens the tree in one click. An old setting is ignored.
- **No title bar and Full screen off?** The tab strip still **moves the window**; the window buttons stay at the right.

### File overview (right sidebar)

**`Ctrl+Alt+B` shows a map of the open file on the right.** Or click the panel button at the right end of the tab strip.

| Section | Shows | Click / `Enter` |
|---|---|---|
| **Outline** | Headings (code files: classes, functions, methods) | Jump there |
| **Code blocks** | Language + the **command** in each block | Jump there · **copy** button or `Ctrl+C` |
| **Tasks** | Done / total, the open ones | Jump · **checkbox or `Space` ticks it** (`Ctrl+Z` undoes) |
| **Connections** | Small graph · notes linking here · links · mentions · shared tags · related notes | Open that note (see [Connected notes](#connected-notes)) |
| **Info** | Words, reading time, lines, size, modified · tags · properties | Tag → search for it |

- **It follows you.** The section the cursor is in is highlighted, and the list updates while you type.
- **Fold:** the arrow before a heading, or **1 / 2 / All** to show only the top levels.
- **Keyboard:** `Tab` into a list, `↑` `↓` to move, `←` `→` to fold, `Enter` to jump.
- **Counts:** every list shows how many entries it has in its header, open or closed. `0` = empty.
- **Opens by itself:** a section with entries starts open, an empty one starts closed. **Connections** starts closed (its count still shows).
- **Your choice wins:** click a section title to open or close it. That choice is remembered and stays, even when the section fills up or empties.
  Untouched sections keep following their content: a first task opens **Tasks**, deleting the last one closes it.
- **Width:** drag its left edge. Double-click the edge to reset. Drag it to the window edge to hide it.
- **Remembered:** shown or hidden, same width, after a restart or refresh.

### Window frame (title bar)

**By default there is no Windows title bar.** Minimize, maximize and close sit at the right end of the tab strip.

| Do this | How |
|---|---|
| **Move the window** | Drag the **empty part of the tab strip** (or the space above the folder name) |
| **Maximize / restore** | **Double-click** that empty space, or the maximize button |
| **Snap Layouts** (Windows 11) | Hover the **maximize button** — they work as usual |
| **Get the title bar back** | Settings → Appearance → **Window frame: Native** → **Restart now** |

- **Restart is safe.** Unsaved changes are saved first, or you are asked (Cancel keeps the app open).
- **Double-clicking a tab** still closes it. Only empty strip space maximizes.
- **File overview open?** The buttons sit above it instead. Its top strip drags the window too.
- The **window title** (taskbar, Alt+Tab) still shows the open note.

### Status bar

```
← → │ folder › path · git · env ········ Ln 3, Col 1 · words · LF · UTF-8 · Markdown · Live │ MCP · 🌐 :4317 · ⛨ 3
```

**The right end shows what is switched on.** Usually it is empty (no `│` either).

| Icon | Shows when | Click |
|---|---|---|
| **MCP** | The MCP server is on. Grey: no AI app connected. **Green**: an app is connected (count from 2; a short flash on each call) | Settings → MCP server → **Recent activity** |
| **🌐 :4317** | The web server runs (browser mode) | The info box: **Open**, **Copy link**, **Stop server** |
| **⛨ 3** | The last security check found something (red: high / critical) | The findings |

Hover an icon for details (MCP: which app, last call). Desktop app only.

### Saving

- **Autosave is on.** It saves shortly after you stop typing.
- `Ctrl+S` saves right away.
- **Line endings and encoding are kept** as they were (CRLF, BOM, UTF-16, Windows-1252).

### When a file changes outside One

| Your copy | What happens |
|---|---|
| **No unsaved edits** | The file reloads silently |
| **Unsaved edits** | A banner appears. You choose which version to keep |

### Deleting

- Files go to the **Recycle Bin**, not gone forever.
- If the bin is unavailable, One asks before deleting permanently.
- **Several at once:** [select them](#select-several-files), then `Del`. One question covers them all; without a bin, One asks once for the rest.

### PDF files

**Click a `.pdf`** (tree, `Ctrl+P`, a `[[doc.pdf]]` link) → it opens in a **viewer tab**. Same in browser mode.

| Do this | How |
|---|---|
| **Go to a page** | Type it in the **page box** (`Ctrl+G`), `Enter` · or ▲ / ▼ |
| **Zoom** | `Ctrl+=` / `Ctrl+-` / **`Ctrl`+wheel** · `Ctrl+0` = fit width · the zoom list (Fit width, Fit page, %) |
| **Find in the PDF** | `Ctrl+F`, type · `Enter` / `Shift+Enter` = next / previous · `Esc` closes |
| **Copy text** | Select it with the mouse, `Ctrl+C` |
| **Dark pages** | ☾ button (top right) inverts the pages. Remembered |
| **Scroll** | Wheel, arrows, `PgUp` / `PgDn`, `Home` / `End` (click the page first) |
| **Link to a page** | `[[doc.pdf#page=3]]` opens at page 3 |

- **Links inside the PDF:** page links jump; web links open in your browser **only when you click them**.
- **Changed on disk?** It reloads and stays on the same page.
- **Not searched:** PDF text is not in **Find in files** (no OCR). `Ctrl+F` inside the open PDF works.
- **Safe by design:** no PDF JavaScript, no forms, nothing sent anywhere.

---

## 2. Writing notes

### View modes

| Mode | Shows | Switch |
|---|---|---|
| **Live** | Formatted text. Markdown syntax appears where the cursor is | Status bar, bottom right |
| **Source** | Raw Markdown | Status bar |
| **Split** | Editor + preview side by side | `Ctrl+\` |
| **Reading** | Preview only | `Ctrl+E` |

### Text width

**Click the page button left of the view-mode buttons** (top right). Each click goes one step:

| Width | Use it for |
|---|---|
| **Readable** (default) | Prose: a comfortable line length |
| **Wide** | Tables and long code blocks |
| **Full** | Edge to edge |

- Also: palette → **"View: Content width…"**, or Settings → Appearance → Content width.
- The button only shows for Markdown files. Code files always use the full width.

### Slash menu

**Type `/`** at the start of a line or after a space, then keep typing to filter. `Enter` inserts.

| Group | Items |
|---|---|
| **Lists** | Bullet list · Numbered list · Task list |
| **Blocks** | Quote · Divider · Table · Code block · Callout · Math block · Mermaid diagram · Footnote |
| **Insert** | Image… · Date / time · Link to note · Embed note · Properties · Template… |
| **Other** | Run command… |

### Lists

| Keys | Does |
|---|---|
| `Enter` | Continues the list. On an empty item it ends the list |
| `Tab` / `Shift+Tab` | Indent / outdent the item **and its children** |
| `Ctrl+Enter` | Toggle the checkbox |

Numbered lists **renumber themselves** as you edit.

### Tables

1. Insert one: `/table`.
2. `Tab` / `Shift+Tab` moves between cells and re-aligns the pipes.
3. `Enter` adds a row. `Enter` on an empty last row leaves the table.

### Images and pasting

| You paste or drop… | You get |
|---|---|
| **An image** (screenshot, file) | Saved as an attachment, inserted as `![[name.png]]` |
| **Rich text** (web page, Word, Google Docs) | Clean Markdown |
| **A file from the tree** | A `[[link]]` or `![[embed]]` |
| **Terminal / AI output** padded with spaces | **Trailing spaces removed** from every line (also tabs, NBSP); blank lines at the end dropped |
| **A terminal copy that is one long line** (Windows Terminal pads every row to the window width) | **Split back into its lines**; a line that wrapped over two rows stays one line |
| Anything with `Ctrl+Shift+V` | **Exactly as copied**: plain text, no trimming, no conversion |

**Where attachments go:** Settings → Attachments. Default is the `attachments/` folder.

### Trailing whitespace

**On by default, and quiet:** pasted text loses its trailing spaces; saving cleans only the lines you edited.

| When | What happens | Setting (Editor → Trailing whitespace) |
|---|---|---|
| **Paste** | Trailing spaces off every pasted line | **Trim pasted text** — notes / code files: On |
| **Save** | Trailing spaces off the **lines you edited** since opening / last save. Other lines are never touched → **no noise in git diffs** | **Trim on save** — Off / **Edited lines** / All lines |
| **Autosave while you type** | The line with the cursor is skipped (your space survives). It is cleaned when the cursor leaves it or on `Ctrl+S` | — |
| **Any time** | Palette or right-click → **Trim trailing whitespace** (selection, else the whole file) | — |

- **Markdown hard breaks stay:** two spaces at a line end before a line with text. Turn off: **Keep Markdown hard breaks**. Code blocks and frontmatter are always trimmed.
- **Terminal rows:** found by their width (40–400 columns). Rows with CJK / emoji (two columns each) don't line up, so that paste stays one line — just without its trailing spaces.
- **`.editorconfig` wins:** `trim_trailing_whitespace = true` → all lines, `= false` → never.
- **Undo** after a save undoes your edit, not the cleanup.

### Embeds

```markdown
![[Other note]]            whole note
![[Other note#Section]]    one section
![[Other note#^block-id]]  one block
![[diagram.png]]           image
![[manual.pdf#page=3]]     PDF card → opens the viewer at page 3
```

Embeds render in live preview and in the preview. They are read-only there.

### Properties (frontmatter)

**The YAML block at the top of a note shows as a form** in live preview.

```markdown
---
tags: [project, php]
due: 2026-12-01
done: false
---
```

- Click a value to edit it. Types: text, number, checkbox, date, list, tags.
- Put the cursor inside the block (or use Source mode) to edit the raw YAML.
- Add one with `/properties`.

### Autocomplete

| Type | Suggests |
|---|---|
| `[[` | Notes. `[[Note#` suggests its headings |
| `#` | Existing tags |
| ```` ``` ```` | Code block languages |

---

## 3. Links and knowledge

**Link with `[[Note name]]`.** Click a link to follow it. In source text, `Ctrl+click`.

| Syntax | Means |
|---|---|
| `[[Note]]` | Link to a note |
| `[[Note#Heading]]` | Link to a heading |
| `[[Note\|shown text]]` | Link with different text |
| `#tag`, `#project/sub` | Tag, nested tag |

**`Ctrl` + hover** over a link shows a preview of that note (see [Link preview](#link-preview)).

### Panels

| Panel | Open | Shows |
|---|---|---|
| **Outline** | `Ctrl+Alt+O` | Headings of the current note (the **file overview**, `Ctrl+Alt+B`, shows them on the right — with code blocks, tasks and links) |
| **Backlinks** | `Ctrl+Alt+L` | Notes linking here · **unlinked mentions** · outgoing links · unresolved links · orphan notes · notes without incoming links |
| **Tags** | Command "Open tags" | All tags with counts |
| **Graph** | `Ctrl+Alt+G` | All notes and their links |
| **Local graph** | Command "Open local graph" | Only the current note's neighbours |

**Unlinked mention** = the note's name appears as plain text somewhere. One click turns it into a link.

### Connected notes

**Everything about how a note is linked, in one place:** file overview (`Ctrl+Alt+B`) → **Connections**.

| Part | Shows | Click |
|---|---|---|
| **Local graph** | The note and its neighbours. **1 / 2** = direct links only, or links of links too | A dot opens that note · `Ctrl` + wheel zooms · the graph button opens it big |
| **Linked from** | Each note linking here, **with the line** the link is in | Jumps to that line |
| **Links to** | What this note links to. Missing notes are dashed | Open it · **Create** makes the missing note |
| **Unlinked mentions** | Where the note's name is plain text | **Link** one · **Link all** |
| **Shared tags** | This note's tags and how many other notes have them | Lists those notes |
| **Related** | Notes that link to the same notes, are linked from the same notes, or share tags | Open it |

- **Closed at first.** The header counts the notes linked to or from this one. Click it to open; that is remembered.
- **Counts** are in each part's header, also when it is closed. **Unlinked mentions** shows `…` while it searches your notes.
- **Empty parts start closed**, parts with entries open — until you click one. Your choice is remembered.
- **Live:** it follows the open note and your typing.
- **Index built on demand?** You see this note's own links and tags, and a **Build now** button for the rest.

**Find loose ends** (command palette, `Ctrl+Shift+P`):

| Command | Lists |
|---|---|
| **Show orphan notes** | Notes with no links in or out |
| **Show notes without incoming links** | Notes nothing links to |

Both open in the **Backlinks** panel, with counts.

### Link preview

**Hold `Ctrl` (`Cmd` on macOS) and hover a link.** After a moment a small preview of the linked note appears.

- Works for `[[wikilinks]]` and `[text](note.md)`, in the editor and the reading view.
- `[[Note#Heading]]` shows **that section**; `[[Note#^block]]` that block.
- It goes away when you move off, scroll, click or press `Esc`. `Ctrl+click` still opens the link.
- **Without `Ctrl`:** Settings → Links & notes → **Link preview on hover** → *Always* (or *Off*).

### Renaming keeps links working

1. Rename or move a note (`F2`, or drag it).
2. **Every `[[link]]` to it is rewritten.** A message shows how many notes changed.

Turn this off in Settings → Links & notes → **Update links on rename**.

### Daily notes

**Run "Open today's daily note"** from the palette (`Ctrl+Shift+P`, type `daily`).

- Creates `daily/2026-11-19.md` if it does not exist, then opens it.
- Folder, file name pattern and template: Settings → Links & notes.

### Templates

1. Put Markdown files in a **`templates/`** folder.
2. Insert one with `/template` or the command "Insert template".

| Variable | Becomes |
|---|---|
| `{{title}}` | Name of the current note |
| `{{date}}` | Today, e.g. `2026-11-19` |
| `{{time}}` | Now, e.g. `14:05` |
| `{{date:DD-MM-YYYY}}` | Today in a custom format |

**Date tokens:** `YYYY` `YY` `MMMM` `MMM` `MM` `M` `DD` `D` `dddd` `ddd` `HH` `H` `mm` `ss`. Text in `[brackets]` is copied as is.

---

## 4. Search

### Which search do I use?

| Goal | Keys |
|---|---|
| Open a file by name | `Ctrl+P` |
| Run a command | `Ctrl+Shift+P` |
| Find text in **all files** | `Ctrl+Shift+F` |
| Replace in **all files** | `Ctrl+Shift+H` |
| Find / replace in **this file** | `Ctrl+F` / `Ctrl+H` |
| Jump to a heading or code symbol | `Ctrl+Shift+O` (this file) · `Ctrl+T` (workspace) |
| Jump to where a name is defined | `Ctrl+click` / `F12` (see [Go to definition](#go-to-definition)) |

### When the index is built

**At launch** (default): the search index builds in the background right after start.

**On demand** (Settings → Search → **Build the index**): nothing is indexed until you need it.

- It builds the first time you **find in files**, open **backlinks**, **tags** or the **graph**, or rename a note that others link to.
- Opening a file by name (`Ctrl+P`) does not build it.
- Until then the status bar shows **Search index: on demand**. Click it to build now.
- Once built it stays up to date until you close the app. Unchanged files are read from the cache.

### Find in files

**Paste anything. It is searched literally.** Commands with flags and punctuation work as they are:

```text
git push --force-with-lease
kubectl get pods -o wide
php artisan migrate:fresh
```

Narrow it down only when you need to:

| Type this | Finds |
|---|---|
| `"exact phrase"` | The exact phrase |
| `deploy -staging` | "deploy", skipping files that contain "staging" |
| `\-staging` | The literal text `-staging` |
| `nginx OR apache` | Either word |
| `/user_\d+/` | Regular expression |

| Filter | Limits results to |
|---|---|
| `path:notes/work` | Path matches |
| `file:todo` | File name matches |
| `ext:php,sql` | Extensions |
| `lang:sql` | Files or code blocks in that language |
| `in:code` | Code. Also `in:text` `in:heading` `in:frontmatter` `in:link` |
| `tag:project` | Notes with that tag |
| `case:yes` | Case-sensitive |

- **Negate a filter** with `-`: `-path:archive`.
- **Case is smart:** all lowercase ignores case; a capital letter makes it exact.
- **Typos:** when nothing matches, close matches are shown and marked `≈`.
- **Chips under the box** show how your query was understood.

| Keys | Does |
|---|---|
| `F4` / `Shift+F4` | Next / previous result |
| `Alt+C` / `Alt+W` / `Alt+R` | Match case / whole word / regex |

### Replace in files

1. `Ctrl+Shift+H`, type the search and the replacement.
2. Replace **one line**, **one file**, or **everything** (`Ctrl+Enter`).

With regex on, the replacement understands `$1`, `$<name>`, `\n`, and `\U` `\L` for case.

### Quick open prefixes

| Type in `Ctrl+P` | Mode |
|---|---|
| `name` | Files. Recent ones first |
| `name#heading` | A heading inside that file |
| `name:42` | Line 42 of that file |
| `>` | Commands |
| `#` | Headings and **code symbols** in the workspace (also `Ctrl+T`) |
| `@` | Headings / symbols in this file |
| `:` | Go to line |

---

## 5. Code and formatting

**`Shift+Alt+F` formats the current file.** `Ctrl+Alt+F` formats the selection, or the code block under the cursor.

| Formats | Languages |
|---|---|
| **Web** | JavaScript, TypeScript, JSX/TSX, JSON, CSS, SCSS, Less, HTML, Vue |
| **Backend** | **PHP** (PER-CS / PSR-12 style, 4 spaces), **SQL** (uppercase keywords) |
| **Config and docs** | YAML, XML, GraphQL, shell scripts, Markdown |

### Language of a file

**Click the language name in the status bar** (bottom right, e.g. `Markdown`, `PHP`).

1. A list opens. **Type to filter**, `↑` `↓` to move, `Enter` to pick, `Esc` to cancel.
2. **Auto-detect** = by file extension (the default). **Plain text** = no highlighting.
3. The choice is **remembered per file**. It follows a rename and is forgotten when you delete the file.

- Also: palette → **"Change language mode…"**.
- A `.md` file switched to another language becomes a plain code view (no live preview).

### Code blocks inside notes

- `Ctrl+Alt+F` with the cursor in a code block formats **that block**.
- Command **"Format all code blocks in note"** does all of them.

### Which options win?

```text
.prettierrc   >   .editorconfig   >   Settings → Formatting   >   language defaults
```

The nearest config file above the edited file is used.

### Format on save

1. Settings → Formatting → **Format on save**.
2. It runs when **you** press `Ctrl+S`. Autosave never reformats while you type.

### Editing keys

| Keys | Does |
|---|---|
| `Ctrl+/` | Toggle line comment |
| `Ctrl+D` | Select the next match too (multi-cursor) |
| `Alt+↑` / `Alt+↓` | Move line |
| `Shift+Alt+↓` | Duplicate line |
| `Ctrl+G` | Go to line |
| `Ctrl+Shift+[` / `]` | Fold / unfold |
| `F12` / `Ctrl+click` | Go to definition |
| `Shift+F12` | Find usages |

### Go to definition

**`Ctrl+click` a name, or put the cursor on it and press `F12`.** One jumps to where it is defined, also in another file. **`Alt+←` takes you back.**

| Keys | Does |
|---|---|
| `Ctrl+click` (macOS `Cmd+click`) | Go to definition. Hold `Ctrl` first: the name under the pointer gets underlined |
| `F12` | Go to definition of the name at the cursor |
| `Shift+F12` | **Find usages**: Find in files for that name (whole word, exact case, same language) |
| `Alt+←` (macOS `Cmd+[`) | Back to where you were |

Also in the editor's **right-click menu** and the palette: **Go to definition**, **Find usages**. Code files only.

- **Several matches?** A small list opens: name, kind, `file:line` and the line itself. Type to filter, `↑` `↓`, `Enter`.
- **No match?** A message says so, with a **Search in files** button.
- **Index still building?** It says **Indexing…** and tries again once the index is ready.
- **`Ctrl+T`** lists code symbols of the whole folder too (classes, functions, methods), next to headings.

**How it looks for the definition:**

1. **Imports first.**
   - **PHP:** `use` statements (also `as` aliases and `use App\{A, B}`), the file's `namespace`, fully qualified names. Classes are located through **PSR-4**: `composer.json` (`autoload` and `autoload-dev`) and `vendor/composer/autoload_psr4.php`. So a jump can land **in `vendor/`**, which search never indexes. These files are only read, never run.
   - **JS / TS:** relative `import … from './x'`, `export … from`, `require('./x')`, `import('./x')`. Package names (`react`) are not followed.
   - **Python:** `from .module import name`.
2. **Members.** `$this->save()`, `self::`, `static::`, `parent::`, `this.load()`, `self.run()` look in the current class, its traits, then its parent classes (up to 5 levels). `User::find()` / `Store.create()` look in that class.
3. **Same file, then the same language** across the folder. `new X` prefers classes, `->x(` methods, `x(` functions. A PHP call never jumps into JavaScript. Blade counts as PHP, `.vue` as JavaScript.

**Languages:** PHP, JavaScript / TypeScript (JSX, TSX, Vue), Python, Go, Rust, Java, C#, Kotlin, Swift, Dart, C / C++, shell, Lua, SQL, Ruby, CSS custom properties (`--x`), SCSS (`$var`, `@mixin`, `@function`), Less variables.

**Limits** (name-based, no language server):

- **No types.** `$order->total()` on a variable of unknown type lists **every** `total()` method to pick from.
- Definitions are recognised **per line**. A definition split over several lines, or a line over 400 characters, can be missed.
- Files the search index skips (git-ignored, minified, very large) are reached only through imports / PSR-4, not by name.
- In **Markdown** notes `Ctrl+click` follows links, as before.
- **Browser mode:** the browser may keep `F12` for its own developer tools. Use `Ctrl+click` or the right-click menu.

---

## 6. Preview and export

**`Ctrl+E` toggles reading view.** `Ctrl+\` shows editor and preview side by side, scrolling together.

| Renders | Syntax |
|---|---|
| **Callouts** | `> [!note] Title` (also `tip`, `warning`, …). Add `-` to fold: `> [!tip]-` |
| **Math** | `$inline$` and `$$block$$` |
| **Diagrams** | A code block with language `mermaid` |
| **Highlight** | `==text==` |
| **Comments** (hidden) | `%%text%%` |
| **Footnotes** | `text[^1]` and `[^1]: note` |
| **Task lists** | `- [ ]` (clickable in the preview) |

### Images from the internet

A note can show images from a web address (`![](https://…)`). Loading one tells that server **you opened the note** (and your IP address). So by default they **don't load**:

| You see | Do this |
|---|---|
| A bar: **"This note loads images from the internet"** | **Load** = this note, until you restart · **Always for this folder** = remembered for the folder |
| A dashed box where the image goes | That image, not loaded yet |

- **Default for every folder:** Settings → Preview → **Images from the internet**: **Ask** (the bar) · **Always load** · **Never load** (no bar).
- **Change a folder's choice:** palette → **"Images from the internet: …"** (always load / never load / use the default).
- Same rule in **live preview**, link previews, embeds and **exports** (HTML / PDF show the dashed box instead).
- Images **from your folder** always show.

### Copy and Run show what you get

- **Copy** / **Run** take the code from the **note's text**, never from what the page draws.
- A code block with **hidden characters** (invisible or text-direction marks) gets a **"hidden characters"** badge: what you copy differs from what you see.
- Shell code blocks **wrap long lines**, so nothing hides off to the right.
- HTML in a note can't make its own Copy / Run buttons or cover the app.

### Export

| Command (in `Ctrl+Shift+P`) | Result |
|---|---|
| **Export note to PDF…** | A `.pdf` file — see below |
| **Export note to HTML** | One standalone `.html` file |
| **Copy as HTML** | Rich text on the clipboard, for mail or docs |

### Export to PDF

**Run "Export note to PDF…" → pick where to save → done.** The toast has **Open** and **Show in folder**.

1. Open a Markdown note (any view mode).
2. Start the export: palette (`Ctrl+Shift+P`), **right-click in the editor**, or **right-click the tab** (also in the file tree).
3. The save dialog suggests **`<note>.pdf` next to the note**. Next time it suggests the **folder you picked last** (per workspace).

| In the PDF | Notes |
|---|---|
| **Theme** | Always **light** on white paper, also with the dark app theme |
| **Code** | Same colours as the preview. Long lines **wrap**, nothing is cut off |
| **Math, diagrams** | Math as real typeset formulas. **Mermaid** diagrams as sharp vector graphics |
| **Images** | Images from your folder are **embedded** (`![](img.png)`, `![[img.png]]`). `https://` images only when the note may load them ([Images from the internet](#images-from-the-internet)) |
| **Links** | Stay **clickable**. Headings become **PDF bookmarks** |
| **Page breaks** | Headings never end a page. Short code blocks, table rows, images and callouts are not split |
| **Not included** | The properties block (frontmatter). Videos and audio become a small label |

**Force a new page:** put one of these on its own line.

| Write | Works in |
|---|---|
| `\pagebreak` or `\newpage` | PDF export and Print |
| `<div class="page-break"></div>` | PDF export and Print |

The preview shows a dashed **"page break"** line there.

**Paper settings:** Settings → **Export**.

| Setting | Choices | Default |
|---|---|---|
| **PDF page size** | A4 · Letter · Legal | A4 |
| **PDF margins** | Narrow (12 mm) · Normal (20 mm) · Wide (32 mm at the sides) | Normal |
| **Page numbers** | Footer "page / total" (desktop app) | On |

**Browser mode** (`sec-edit serve`): there is no PDF engine on the server. The command opens the **print dialog** instead — choose **"Save as PDF"** as the printer. Page size and margins still apply.

---

## 7. Terminal and Claude Code

**Press `` Ctrl+` ``.** A terminal opens at the bottom of the editor, **in your folder**. Desktop app only.

| Do this | How |
|---|---|
| Open / focus / hide | `` Ctrl+` `` |
| New terminal (default profile) | `` Ctrl+Shift+` ``, or the **⊕ PowerShell 7** pill (shows your default) |
| Pick a profile | **▾** next to it → a card with every shell. `↑` `↓` choose, `Enter` opens |
| Make one the default | **★** on its row (or press `D`) |
| Bigger panel | **⤢** fills the editor area. Click again to go back |
| Hide the panel | **⌄** — your terminals **keep running** |
| Clear, restart, rename, copy all output | **⋯** (also right-click a tab) |
| Rename a tab | Double-click it |
| Close (kills the shell) | **×** on the tab, or middle-click |
| Copy / paste | `Ctrl+Shift+C` / `Ctrl+Shift+V`, or right-click |
| Find in the output | `Ctrl+F` |
| Open a link or file | `Ctrl+click` it (`src/a.ts:12:3` opens at that line) |
| Resize | Drag the top edge. Double-click it to reset |

No terminal open yet? The panel shows **tiles** for every profile — click one.

> **Keys go to the shell** while it has focus (`Ctrl+W`, `Ctrl+R`…). Only a few stay with the app: `` Ctrl+` ``, `Ctrl+Shift+P`, `Ctrl+P`, `Ctrl+S`, `Ctrl+,`, `Ctrl+Tab`, zoom.

### Which shell?

| Windows | Linux / macOS |
|---|---|
| **PowerShell 7** if installed, else Windows PowerShell | Your login shell (`$SHELL`) |
| Also: Command Prompt, **Git Bash**, every **WSL** distro (e.g. *Ubuntu 24.04*) | Also: Bash, Zsh, Fish |

Each profile has a coloured badge: **blue** PowerShell · **grey** Command Prompt · **orange** Git Bash · **teal** WSL · **green** Unix shells · **spark** Claude Code.

- **Folder inside WSL** (`\\wsl.localhost\Ubuntu\…`)? New terminals open **in that distro**.
- **Always the same shell?** Palette → **"Terminal: Select default shell…"**.

### Run a code block

1. Hover a `bash` / `sh` / `console` / `powershell` / `cmd` code block.
2. Click **▶_** (next to copy), or right-click inside it → **Run in terminal**.
3. The command is **typed, not run**. **Press Enter** yourself.

- `console` blocks: the `$ ` prompts and the output lines are left out.
- Want it to press Enter too? Settings → Terminal → **"Run in terminal" presses Enter**.

### Claude Code

**Needs the `claude` CLI.** The app only starts it; no API keys, no network calls.

| Do this | How |
|---|---|
| Start Claude in your folder | **▾** → **Claude Code** (or its tile), or palette → **"Claude: Open Claude Code"** |
| Ask about the open file | Palette or editor right-click → **"Claude: Ask about this file"** |
| Ask about some lines | Select them → **"Claude: Ask about selection"** |

1. The prompt is **typed for you**, e.g. `@notes/a.md lines 12-30: …`.
2. **You** add your question and **press Enter**. Nothing is sent before that.
3. Claude's terminal is **reused** for the next question.

- **Not installed?** The ▾ card shows the install command with a **Copy** button. Install, then **Refresh list**.
- **WSL as default shell?** Claude is looked for **inside that distro**.

### Follow Claude's edits (preview)

**Claude edits a file → One shows it.** Only for Claude started from One (the steps above).

1. The file **opens** at the changed lines, which **flash green** for a few seconds.
2. A note says **"Claude edited `src/a.php`"**. In a git folder it has a **Diff** button.
3. Your cursor **stays in the terminal**. Typing in another file? One only shows the note.

- **Every edit is shown**, in order. Several quick edits flash **together**; each fades by itself.
- **Changed this turn:** a thin **green bar** left of every line Claude changed.
  - It stays until your **next prompt** to Claude.
  - It moves along when you type above it.
  - Other files Claude changed get their bars when you open them.
  - Remove them now: palette → **"Claude: Clear change marks"**.
- **Unsaved edits are yours.** Such a file is not reloaded or marked: you get the usual **changed on disk** banner.
- **Many files at once?** One jumps to the newest; the files in between keep their bars.

- **Turn it off:** palette → **"Claude: Toggle follow edits"**, or Settings → Terminal. Applies to **new** Claude terminals.
- **Your Claude settings are not changed.** One passes its own hooks with `claude --settings`.
- **Not followed (yet):** files Claude changes through shell commands; files outside the open folder (never opened).
- **Windows without WSL:** needs **Git Bash** (Claude Code runs hooks with it).

## 8. Git

**Open a folder that is a git repository, and trust it once.** One uses **your installed git**, so your login, SSH keys and Windows Credential Manager just work. No git installed? Git features stay hidden (one hint tells you).

### Trust a folder first

**Git is off until you trust the folder.** A repository's own settings can make git run programs (hooks, filters), so a folder from someone else starts with no git at all: no marks, no branch, no change bars.

1. The status bar shows **Git: not trusted**. Click it (or press `Ctrl+Shift+G`).
2. The panel asks: *"This folder is a git repository… Trust this folder?"*
3. Click **Trust**. Git appears. **Not now** leaves it off.

- **Asked once per folder.** Remembered on this computer, not inside the folder.
- **Change your mind:** Source control panel → **⋯** → **Stop trusting this folder** (also in the branch menu).
- **Folders you already used** before this version stay trusted.

### See what changed

| Where | What you see |
|---|---|
| **File tree** | A letter at the end of the row: **M** modified · **A** added · **U** untracked (new) · **R** renamed · **!** merge conflict. Ignored files are **dimmed**. A folder with changes gets a small **dot**. Too busy? Settings → Files → **Git colours in the file tree: Off** |
| **Status bar** | The **branch**, `↑2` / `↓1` (commits to push / to pull) and a dot when something is uncommitted. **Click it**: copy the branch name, **Show changes** (tree lists changed files only), Diff with last commit |
| **Editor** | **Bars** next to the text: green = added, blue = changed, red wedge = lines deleted. They update **while you type** |

**Undo one change:** click a bar → the old lines appear → **Revert this change**. `Ctrl+Z` brings your edit back.

**Compare a whole file:** right-click it (tree or tab) → **Diff with last commit**. Or `Ctrl+Shift+P` → "Diff with last commit". Switch **Unified / Side by side** at the top. `F7` jumps to the next change, `Esc` closes.

**Same view as in Source control:** each block has its **Include in commit** box, the file has one at the top. See [Commit and push](#commit-and-push-ctrlshiftg).

**Edit right in the diff.** The header says **Working copy · editable** when you can.

| I want to… | Do this |
|---|---|
| Change a line | **Type** in the working copy (side by side: the **right** side) |
| Save | **`Ctrl+S`** (autosave works too). The tab shows the unsaved dot until then |
| Put one block back as it was | **Revert** on the block (side by side: the **→** between the sides), or **`Ctrl+F7`** at the cursor |
| Take that back | **`Ctrl+Z`** |
| Find text | `Ctrl+F` |

- It **is** the file: the same text as its tab. Close the diff any time, **nothing is lost** (the file gets a tab if it had none).
- **Read-only:** the last commit (left side), old commits in **History**, deleted files.

### Commit and push (`Ctrl+Shift+G`)

1. Open the **Git** panel (`Ctrl+Shift+G` or the branch pill in the sidebar).
2. **Tick the files** that go into the commit. The button follows: **Commit 3 files**.
3. Type a message → **`Ctrl+Enter`** (or **Commit**). Nothing ticked? It offers to include everything.
4. **↑ Push** / **↓ Pull** at the top. A new branch shows **Publish** instead.

**Only part of a file?** Click the file (not its box) → its changes open. Each block has its own **Include in commit** box. The file's box then shows **–** (partly). **Diff with last commit** (tree, tab, palette, status bar) opens the same view with the same boxes.

| Box | Means |
|---|---|
| ☑ | In the commit |
| ☐ | Not in the commit (your edits stay, nothing is lost) |
| – | Partly in. Click: the whole file goes in |

- **Header box**: everything in / everything out. "3 of 7 selected" next to it.
- **Keyboard**: `↑` / `↓` between files, **`Space`** ticks, `Enter` shows the changes.
- A box **is** git's staging area (`git add`). A terminal sees the same. Your files are never changed.
- Parts of a file: only for files in the last commit. New, deleted and binary files go in whole.
- **Edited in the diff, not saved yet?** Ticking a block **saves first**, then puts that block in. New blocks get their box after the save.

| Also | How |
|---|---|
| Fix the last commit | Tick **Amend the last commit** (the old message is filled in) |
| Commit and push in one go | **& push** next to Commit |
| Let Claude write the message | **✦** next to Commit: types a prompt into Claude Code. **You** press Enter |
| Throw away changes | Hover → **↺**. It **always asks**. New files go to the **Recycle Bin**. Ticked parts are kept |
| Switch branch | **Branches** → click one (many? type in the filter box). Uncommitted changes? It warns first |
| New branch | **Branches** → **+** |
| Old versions | **History** → click a commit → click a file to see its change. Scroll down for older commits |

> **Big repositories:** Branches and History load **only when you open them**, in the background. They never slow down the tree marks, change bars or diffs. Too slow? You get **Retry**, not an empty list.

### Merge conflicts

1. Conflicted files sit at the top under **Merge conflicts**. Click one to open it.
2. In the editor each conflict is **coloured** with buttons: **Accept current · Accept incoming · Accept both**. Or just edit the text.
3. **✓ Mark resolved** on the file. Then **Commit merge**.

### Compare two texts

**Right-click in the editor.** Works in any folder (git repository or not).

| I want to compare… | Do this |
|---|---|
| My selection (or the whole file) with the **clipboard** | **Compare Text with Clipboard** |
| Two parts of my files | Select the first part → **Select Text for Compare**. Go to the second (any file) → **Compare Text with Previous Selection** |
| A whole file with the clipboard | Right-click the file in the tree, or its tab → **Compare with Clipboard** |

In the compare view: **Swap sides**, **Ignore whitespace**, **Copy as patch**, Unified / Side by side. `Esc` closes it.

**Two whole files?** Open the first → **Select Text for Compare** (no selection = the whole file). Open the second → **Compare Text with Previous Selection**.

**Apply a block to the other side.** Works towards every side that is **a whole file of your folder**.

| I want to… | Do this |
|---|---|
| Copy a block to the **left** file | Side by side: **←** between the sides. Unified: **Apply to ‹left name›** on the block. Or **`Ctrl+Shift+F7`** at the cursor |
| Copy a block to the **right** file | **→** / **Apply to ‹right name›**, or **`Ctrl+F7`** at the cursor |
| Take it back | **`Ctrl+Z`** (`Ctrl+Y` redoes) |
| Type in a file | Side by side: type in either file. Unified: the right one |
| Save | **`Ctrl+S`** saves both files (autosave works too) |

- It **is** the file: the tab gets the unsaved dot, a file without a tab gets one. Close the compare any time, **nothing is lost**.
- **Read-only:** the clipboard, a selection, a text you selected earlier that changed since. They only **give** blocks: there is no arrow pointing at them.
- **Ignore whitespace** on: the arrows are greyed out (the tooltip says why). Switch it off to apply.

- The diff is **git's own** (`git diff --histogram`). No git installed? A built-in diff is used and the header says "built-in diff".
- The remembered selection is kept **in memory only**, and dropped when you open another folder.
- Don't want it in the menu? Settings → Editor → **Compare text**.

### Big folders, several projects, WSL

- **Repositories in WSL** (`\\wsl.localhost\Ubuntu\…`): git runs **inside the distro**, not through Windows. Much faster. Settings → Files → **Run git inside WSL** (Auto / Off). A distro without git (e.g. `docker-desktop`) uses Windows git.
- **A folder with several projects** (each its own repository): marks and change bars work for all of them. The Git panel has a **repository picker** at the top. The status bar shows the repository of the open file.
- **When does git run?** Only after something changed: a save (½ s later), files changing on disk (1½ s later), a commit / checkout elsewhere, or coming back to the window after 10 s. Never while the window is **minimised**: it catches up once when you return. Slow repositories are checked less often.
- A small **spinner** next to the branch means git is working right now.
- **Status slow after copying a project / a big checkout?** git keeps a timestamp cache. When status has to re-read many unchanged files, the app refreshes that cache once, when nothing else runs (like `git status` in a terminal would). **Files, staging and history stay as they are.** It waits while another git is busy (`index.lock`). Settings → Files → **Keep git status fast** (on by default).

### When git needs you

Sign-in, an SSH passphrase, or "choose merge or rebase": the app **never guesses**. The error box has **Open in terminal**: the same git command is **typed for you** in the terminal, where git can ask. **You** press Enter. (Browser mode: **Copy command**.)

> **Not included on purpose:** force-push, reset, rebase, `git clean`. Use the terminal for those.

## 9. Settings

**Press `Ctrl+,`.** Changes apply at once and are saved automatically.

| Do this | How |
|---|---|
| Find a setting | Type in the search box (`php`, `wrap`, `daily`…) |
| Jump to a group | Click it in the left list |
| See what you changed | A **blue dot** marks it. The count is bottom left |
| Undo a change | Click the **↺ button** next to the control |
| Look up a shortcut | Section **Keyboard shortcuts**. The search box filters it too |

### All settings

| Section | Setting | Default |
|---|---|---|
| **Appearance** | Theme | Dark |
| | Accent colour | Blue |
| | Sidebar style | Shelf |
| | Sidebar menu (order, hidden panels) | Files · Search · Git · Bookmarks · Outline · Backlinks · Tags, all shown |
| | Folder colours / Folder colour | Per top-level folder / Grey |
| | Corners | Rounded |
| | Density | Comfortable |
| | Font size | 15 px |
| | Editor font | System |
| | Line height | 1.65 |
| | Content width | Readable |
| | Zoom (desktop only) | 100% |
| | Window frame (desktop only) | Integrated (no title bar) |
| | Back and forward buttons (left of the status bar) | On |
| | Zen mode: Full screen / Keep the status bar | On / Off |
| **Editor** | View mode | Live |
| | Formatting toolbar in live mode | On |
| | Line numbers in Markdown source & split mode | On |
| | Word wrap | On |
| | Spellcheck | Off |
| | Smart paste | Off |
| | Trim pasted text (notes / code files) | On / On |
| | Trim on save (notes / code files) | Edited lines / Edited lines |
| | Keep Markdown hard breaks | On |
| **Files** | Autosave | On |
| | Autosave delay | 800 ms |
| | Show hidden files | Off |
| | Excluded folders | `node_modules`, `.git`, `dist`, `build`, `vendor`, `.next`, `.cache`, `__pycache__` (names, `*.log`, `docs/build`, `**/secrets`, `private/*.md`) |
| | Confirm before deleting | On |
| | Git colours in the file tree | On |
| **Formatting** | Format on save | Off |
| | Print width | 80 |
| | Tab width | 4 for PHP, 2 elsewhere |
| | Indent with tabs | Off |
| | Quotes | Single for PHP, double elsewhere |
| | PHP version | 8.3 |
| | SQL keyword case | UPPERCASE |
| **Links & notes** | Update links on rename | On |
| | Link preview on hover | With Ctrl / Cmd |
| | Daily notes folder | `daily` |
| | Daily note name | `YYYY-MM-DD` |
| | Daily note template | None |
| | Templates folder | `templates` |
| | Date format / Time format | `YYYY-MM-DD` / `HH:mm` |
| **Search** | Build the index | At launch |
| **Attachments** | Save pasted files to | One folder in the workspace |
| | Attachments folder | `attachments` |
| **Preview** | Single line breaks | Off |
| | Images from the internet | Ask |
| **Export** | PDF page size | A4 |
| | PDF margins | Normal |
| | Page numbers (desktop only) | On |
| **Variables & targets** | Show values | On |
| | Variables file name | `variables.md` |
| | Production environments | `prod\|production\|live` |
| | Fill in values on export | On |
| **Terminal** (desktop only) | Default shell | Automatic |
| | Terminal font size | 13 px |
| | Scrollback (per terminal) | 2000 lines |
| | "Run in terminal" presses Enter | Off |
| | Keep a terminal ready (next one opens instantly) | Off |
| | GPU acceleration | Automatic (only on a hardware GPU) |
| **Browser mode** (desktop only) | Port | Automatic (4317, else the next free one) |
| | Who can connect | This computer |
| **MCP server** (desktop only) | Text per read | 16 kB |
| | Results per call | 25 |
| | Also allow code and config files | Off |
| | Keep undo copies of AI edits | On |
| | Keep undo copies for | 30 days |
| **Security updates** (desktop only) | Check automatically every week | Off |

### Make it yours (Appearance)

**Everything here applies while you click** — no restart, no flash on the next launch. (Only exception: **Window frame**, see [Window frame](#window-frame-title-bar).)

| Setting | Choices | What changes |
|---|---|---|
| **Accent colour** | 11 swatches, or **+** for any colour | Links, buttons, active tab, selection, focus ring |
| **Corners** | Rounded · Square | Every card, button, pill and menu |
| **Density** | Compact · Comfortable · Spacious | Height of file rows, tabs, menus, status bar |
| **Editor font** | System · Serif · Mono · Custom… | Markdown text. Custom = any installed font |
| **Line height** | 1.2 – 2.4 | Space between lines of Markdown text |
| **Content width** | Readable · Wide · Full | Width of the text column |

- **The accent is tuned per theme.** The same pick is lightened in dark and darkened in light, so it stays readable.
- **Line numbers** never show in live or reading view. Code files always have them.

### Attachment locations

| Option | A paste in `notes/work/a.md` goes to |
|---|---|
| **One folder in the workspace** | `attachments/` |
| **Same folder as the note** | `notes/work/` |
| **Subfolder next to the note** | `notes/work/attachments/` |

### Where the settings file lives

| OS | Path |
|---|---|
| Windows | `%APPDATA%\sec-edit\settings.json` |
| Linux | `~/.config/sec-edit/settings.json` |
| macOS | `~/Library/Application Support/sec-edit/settings.json` |

Settings are **global**, not per folder.

### Browser mode (web server)

**Open this folder in a web browser** — on this computer, or from your phone / another PC on the same network. The desktop app keeps running; the browser edits the same files.

| Do this | How |
|---|---|
| **Start** | Settings → **Browser mode** → **Start web server**, or palette → **"Start web server"** |
| **Get the link** | **Copy link** or **Open** in the info box. **🌐 :4317** at the right end of the status bar opens it again |
| **See it all** | Palette → **"Web server: Show info"** (folder, address, access, limits) |
| **Stop** | **Stop server**, palette → **"Stop web server"**, or quit One |

| Option | Choices |
|---|---|
| **Port** | Empty = automatic (4317, else the next free one) · or a fixed port |
| **Who can connect** | **This computer** (default, 127.0.0.1 only) · **Network (LAN)** |

- **The link holds a secret key.** Without it the server refuses every request. Share it only with people you trust.
- **What the link opens:** the files of **this folder** (read, change, delete — git included) and the **app settings** you share with the desktop (theme, editor…). **Not** other folders on this computer, not the terminal, not your secrets.
- **The key stays in that browser tab** (not a cookie, not in image addresses). A new tab needs the link again. **Open** starts the browser with a one-time link.
- **Network (LAN) is opt-in, and asked every time:** anyone on your network with the link gets the above. It is plain HTTP: trusted networks only, not public Wi-Fi.
- **Windows:** the first network start shows a **firewall prompt** for One. Allow **Private networks** only.
- **Nothing starts on its own.** Opening another folder stops it. Quitting One stops it.
- **Own tabs:** the browser keeps its own open tabs, tree and layout per folder (the first visit starts from the desktop's). The desktop's stay as they were.
- **Settings are shared:** a change in the browser shows up in the desktop app at once, and the other way round.
- **Same folder, same port:** the browser remembers things per address (environment pick, recent files). So a folder gets its last port again. If that port is taken, the info box says so: browser state for this folder then starts empty.
- **In the browser:** no terminal · secrets of `{{variables}}` stay in that tab's memory only · PDF export = the browser's print dialog · one server at a time.
- **Without the desktop app:** `Start web server.cmd` (Windows) or `start-web.sh` (Linux) next to the program. Started that way on this computer, the browser can switch folders; with `--host` (another address) it serves that one folder only.

### MCP server (AI apps)

**Let AI apps search, read and (if you allow it) edit the folders you share.** LM Studio, Codex CLI, Claude Desktop and Claude Code talk to One over the Model Context Protocol (MCP). Off by default, **read-only** unless you allow changes per folder, every change undoable. Desktop app only. Works with One closed too.

**Set it up (3 steps)**

1. Settings → **MCP server** → pick your app under **Client setup** → switch it **on** (One asks once). Its setup, with a fresh **access token**, is now on the clipboard.
2. Paste it where the table below says → **restart that app**.
3. **Add folders…** → pick a notes folder (or several: see below) → **Add read-only** (or **Add and allow changes**).

**Share folders: one question**

1. **Add folders…** → pick one, or **Ctrl+click** (macOS: **Cmd+click**) / **Shift+click** several → **Select Folder**.
2. One asks **once** for the whole step: what it adds (its name for the AI: path), what it skips (with why).
3. Choose: **Add read-only** · **Add and allow changes** (tick **Also code and config files** if the AI may change those too) · **Cancel** (the default: adds nothing).

- The choice applies to every folder of that step. No further question for them.

- **Skipped, with a reason:** already shared, a whole drive, your home folder itself, One's own data folder, not a folder, over the limit of 32.
- **Nothing left to add?** You only see the reasons and **OK**.
- **Same folder name twice** (`a\notes`, `b\notes`): the AI sees `notes` and `notes-2`, numbered in path order.
- **Later changes** per folder (read-only → read-write, code files on) still ask, one folder at a time.
- Running AI apps see the new folders within a second: restart nothing.

**Updated One and an app stopped working?** Copy the setup again: **a token is now required** (see Access tokens).

| App | Where the snippet goes |
|---|---|
| **LM Studio** | `~/.lmstudio/mcp.json` (Windows: `%USERPROFILE%\.lmstudio\mcp.json`). In LM Studio: Program → Install → Edit mcp.json |
| **Codex CLI** | `~/.codex/config.toml` (Windows: `%USERPROFILE%\.codex\config.toml`) |
| **Claude Desktop** | `%APPDATA%\Claude\claude_desktop_config.json` |
| **Claude Code** | Run the copied `claude mcp add …` line once in a terminal |

Example for One in `C:\Apps\One` (Settings shows your real paths):

```json
{
  "mcpServers": {
    "one": {
      "command": "C:\\Apps\\One\\One.exe",
      "args": ["C:\\Apps\\One\\resources\\app.asar.unpacked\\dist\\mcp\\cli.mjs", "--stdio"],
      "env": { "ELECTRON_RUN_AS_NODE": "1", "ONE_MCP_TOKEN": "one_…" }
    }
  }
}
```

```toml
# Codex CLI: ~/.codex/config.toml
[mcp_servers.one]
command = 'C:\Apps\One\One.exe'
args = ['C:\Apps\One\resources\app.asar.unpacked\dist\mcp\cli.mjs', '--stdio']
env = { ELECTRON_RUN_AS_NODE = '1', ONE_MCP_TOKEN = 'one_…' }
```

- **No Node.js needed:** One's own program runs the server (`ELECTRON_RUN_AS_NODE=1` = "run as a script runner, no window").
- **Launchers** next to the program do the same: `One MCP.cmd` (Windows), `one-mcp.sh` (Linux).
- **Claude Code inside WSL** (One on Windows): `claude mcp add --scope user one -- cmd.exe /c "C:\Apps\One\One MCP.cmd"`
- **Options** (add after `--stdio`): `--folder <name>` = only that folder · `--read-only` = never writes, whatever Settings say.

**Access tokens** (one per app)

| Do | How |
|---|---|
| **Another app** | Type its name → **New token for another app…** → One asks → its setup is copied |
| **Copy setup again** | Pick the app under Client setup → **Copy setup** on its token |
| **Regenerate** | New token, old one stops at once → paste the new setup |
| **Revoke** | One asks → that app stops at once (a running server exits) |

- **The token is in the app's `env` block** (`ONE_MCP_TOKEN`), never in the command line: process lists show those.
- **One keeps only a fingerprint** (SHA-256) in `mcp.json`. To copy again later, the token itself is kept encrypted by your OS keyring (`mcp-tokens.json`, not the vault).
- **No keyring** (some Linux desktops): a token is copied once, when it is made. Lost it? **Regenerate**.
- **The page never sees a token:** One copies the setup itself. Settings shows the name, when it was made and last used, and its first 4 characters.
- **Copy setup asks first**, and One **clears the clipboard after 2 minutes** (if it still holds the setup).
- **Windows clipboard history (Win+V) and cloud clipboard sync keep their own copy.** Turn them off (Settings → System → Clipboard) before copying, or **Regenerate** the token if it was synced.
- **Recent activity names the token** ("LM Studio"), not what the app calls itself.

**What the AI can do**

| Tool | Does |
|---|---|
| `list_folders` · `list_files` | The shared folders · files and subfolders (paged) |
| `search` | Full text, same syntax as **Find in files** (below). `mode`: `lines` (default) · `files` (paths + counts) · `names` (fuzzy file names) · `headings` |
| `get_outline` | Headings with line ranges, `^blocks`, frontmatter keys (code: functions) |
| `read_file` | A file's text in pages, only one `heading` / `block` / `frontmatter_key`, or a line range |
| `list_tags` · `get_links` | Tags · links and backlinks (`show=related`: notes sharing links or tags) |

**Filters the AI uses** (typed into the search query, as in Find in files)

| Query | Finds |
|---|---|
| `deploy path:notes/ -path:archive` | "deploy" under `notes/`, not in `archive` |
| `select ext:php,sql` · `deploy lang:sql` | In PHP or SQL files · in SQL files and SQL code blocks |
| `tag:project in:heading` | Notes tagged `project`, the hit in a heading |

- **All filters:** `path:` `file:` `ext:` `lang:` `tag:` `in:` `case:yes`. A `-` in front negates; `ext:` and `lang:` take comma lists.
- **`in:` values:** `code` · `block` (= `fence`) · `inline` · `text` · `heading` · `frontmatter` (= `fm` `meta` `yaml`) · `link` · `path`.
- **No regular expressions** over MCP: `/…/` is searched as plain text.

**How it saves tokens** (small local models)

1. `search` with `mode=files` → which files.
2. `get_outline` → which part.
3. `read_file` with `heading` (or `offset_line` + `max_lines` around a hit) → only that part.
4. Asked again? `if_none_match` with the etag → just "unchanged".

- **Answers are plain text:** one summary line, then rows or the file's own text. No JSON.
- **Short tool descriptions** (they go with every message); `folder` only shows up when you share more than one folder.

Only in **Read-write** folders:

| Tool | Does |
|---|---|
| `write_file` | Creates a file, or replaces a whole one (only with the `etag` from `read_file`: never over a newer version) |
| `append_file` | Adds text at the end, or at the start (after the frontmatter) |
| `patch_file` | Changes one heading section, `^block` or frontmatter key: append · prepend · replace · delete |
| `replace_text` | Replaces one exact piece of text (it must occur once), or every match in that file (`all`) |
| `replace_in_files` | Replaces exact text in many files at once; `query` picks them with search filters (`path:` `ext:` `tag:` `lang:` `file:`); `preview` only counts |
| `move` | Renames / moves a file or folder (with everything in it), never overwrites; updates links to it (**Update links on rename**). `paths` + `to_folder`: up to 100 items in one call, **keeping their subfolders** (`notes/a/x.md` + `notes/b/y.md` → `archive/a/x.md` + `archive/b/y.md`); `flat: true` puts all directly in `to_folder`; `to_paths` gives each its own new path. Existing folders are reused; an existing file is never overwritten, and a folder is never merged into one of the same name |
| `create_folder` · `delete` | New folder · files or folders to the **Recycle Bin** (`paths`: up to 100). File deletes keep undo copies (even with undo copies off), or are refused |
| `undo` | Undoes one of **its own changes from this session** (the `undo:` code of that answer): everything of that call, only if you have not edited those files since. Anything older, or from another app: **Revert** in One. A deleted folder: restore it from the Recycle Bin |

**Fewer calls, one Revert**

1. **Preview first:** `replace_in_files` with `preview: true` → `14 matches in 6 files` and the list. Nothing changes.
2. **Apply:** the same call without `preview`. Files where the change would touch a `{{secret}}` line are skipped and named; the rest are written.
3. **One row, one Revert:** a batch (`replace_in_files`, `move` / `delete` with `paths`) is one row in **Recent activity** (`replace_in_files ×6`). Its **Revert** undoes all of it (deleted folders: from the Recycle Bin).

- Up to 200 files per `replace_in_files`; each changed file counts toward the per-session change limit.
- A batch goes on past an item that fails and answers one line per item (`ok …` or the reason).

**Which AI actions ask you first**

| Asks first | Does not ask (Revert undoes it) |
|---|---|
| Deleting a **folder** (alone or in a batch) | Writing, editing, appending, one `replace_text` |
| Deleting **more than 10** items in one call | Moves and renames, also in a batch (nothing is lost) |
| `replace_in_files` on **more than 10** files | Deleting up to 10 files (undo copies) · creating folders |

1. **Your AI app asks you** what will happen, e.g. `Delete folder "old-project" and everything in it? 120 files, 14 folders, 37 MB (including hidden items such as .git, .env). It goes to the Recycle Bin; if the bin is off or too small for it, it is deleted permanently.` or `Replace "v1" with "v2" in 14 files (31 matches): "a.md", "b.md", "c.md" and 11 more?`
2. **Yes** → it happens, in one step. **No**, closing the question or no answer within 2 minutes → nothing happens.
3. **Apps that can't ask** show you that summary in the chat first. The AI goes ahead only after **you** agree there (it then sends a one-time code: valid 5 minutes, only for exactly that action on exactly those files).

- **Restore a deleted folder from the Recycle Bin** (Trash on a Mac). It keeps no undo copy, so **Recent activity** lists it as `delete (folder)` without a Revert button.
- **Windows: no extra Windows prompt.** If the Recycle Bin is off or too small for the folder, Windows deletes it permanently, and the question says so. Elsewhere: not on a fixed local drive → nothing is deleted. Mac: only on the volume with your Trash. Linux: only into your trash.
- **Moving a folder** takes everything in it along, hidden items too (they stay hidden). Refused: links inside, a destination in a hidden or excluded place, and content your exclusions hide that would become visible.

**Let it make changes (Read-write)**

1. Settings → **MCP server** → **Shared folders** → **Read-write** on that folder.
2. One asks once (native dialog). **Read-only** again is one click, no question.
3. Restart nothing: running AI apps see the change within a second.

- **Read-only is the default** for every folder you add.
- **Notes only by default:** `.md`, `.markdown`, `.txt`. Code and config files (`.json`, `.yaml`, `.ts`…) only with **Code files** on that folder (One asks; off by default).
- **Never, whatever you allow:** scripts, programs and shortcuts (`.bat`, `.cmd`, `.ps1`, `.vbs`, `.js`, `.py`, `.exe`, `.lnk`, `.url`, `desktop.ini`…), images, PDFs and other binaries, hidden files, key files and excluded folders. A refused place always gets the same answer ("Cannot change …"), so an AI cannot probe your exclusions.

**`{{placeholders}}` stay yours** (they fill in values and secrets when you copy or run a block)

| The AI may | The AI may not |
|---|---|
| Use names your variables file gives a plain value (`{{host}}`) | Change your **variables file** (`variables.md`, any folder), create, move or delete one |
| Use built-ins: `{{date}}` `{{time}}` `{{title}}` `{{target}}` `{{env}}` | Change frontmatter `vars` / `target` / `env` / `secrets`, or a code block's `{…}` attributes |
| Edit lines and blocks without secrets | Add or change **any line with a secret name**, anywhere in the note (text, any code block, frontmatter), or the lines **right above and below** it |
| Add code blocks below your secrets | Change a code block that holds a secret, or the code fences above a secret line |

- **Secret** = listed in `secrets:`, or its value is `vault` / `vault:…` (also `TARGET.field` and the bare field), a value that uses one, or **a name nothing defines** (One would fill it from what you typed before).
- **No variables file** between the note and the shared folder? Then every name but the built-ins counts as secret, everywhere in the note. `{{ title }}` in a Vue snippet still works; `{{ user.name }}` does not.
- **Frontmatter is read the way One reads it:** quoted (`"vars":`), `? vars` or other unusual spellings of these keys are refused, and so is frontmatter that does not parse.
- **Still check new blocks before you Run them:** an AI may add a block *without* placeholders that uses a shell variable an existing block of yours exports (`export TOKEN={{api_key}}` … `curl -H "$TOKEN" …`). Run the AI's block only if you trust it.
- **Links are never followed** (symlinks, junctions): the AI only sees and changes files where they really are.
- **A limit per session:** at most 60 changes a minute and 500 per connection, so a runaway AI cannot rewrite a whole folder.
- **Your encoding stays:** CRLF line ends, a BOM, UTF-16 and Windows-1252 files are written back the same way. Text a Windows-1252 file cannot hold is refused instead of mangled.
- **Open tabs follow:** a change shows up in an open tab right away. With unsaved edits in that tab you get the usual **changed on disk** banner (keep yours or take the AI's).
- Big edits are refused (2 MB per `write_file`, 256 kB per smaller edit).

**Undo an AI change (Revert)**

- **Recent activity** shows a **Revert** button on every change. It puts back exactly what was there before (a move: the move *and* the links it updated).
- Only while the file is still as the AI left it. Edited since? Revert says so and changes **nothing**.
- A reverted row says *reverted*. Revert of a new file moves it to the Recycle Bin.
- **Revert works on a folder that is read-only again:** it only puts back what was there.
- **Undo → Keep undo copies of AI edits** (Settings → MCP server, on by default): the old text of each change, in `mcp-history` in the app data folder, for **30 days** (1–365) and at most 100 MB.
- **Switching it off asks first.** Changes from then on get no Revert. File deletes still keep a copy (deleted folders: restore them from the Recycle Bin).
- **An AI cannot flush your history:** copies from the last 24 hours and of the running connection are never dropped for space. Full? New AI changes are refused until older copies expire (64 MB per connection at most).
- **Two very busy AI sessions** can fill the 100 MB with copies that are all protected. New AI changes then get "history is full" for up to 24 hours. Your files are safe (nothing is changed without a copy); edit in One meanwhile.

**What stays private**

- **Only the folders you list.** Never the rest of the computer, your secrets (the `{{variables}}` vault), settings, git or the terminal.
- **Always invisible:** hidden files and folders (`.git`, `.env`, `.obsidian`…), key files (`*.pem`, `*.key`, `id_rsa`, `*.kdbx`, `*.gpg`, `wallet.dat`, `*.tfstate`…), your **Excluded folders** (also patterns like `**/secrets` or `private/*.md`), and links. The AI gets "not found", the same as for a file that does not exist. Hidden files and key files stay invisible even with an empty exclude list.
- **A broken settings file never opens things up:** if `settings.json` cannot be read, a starting MCP server refuses to run and a running one keeps your last exclusions.
- **A secret typed into a normal note *is* readable.** Keep secrets in the vault.
- **Excluded folders are a normal setting:** removing an entry from **Excluded folders** makes that folder visible to AI apps at once, without a question. Check the list before sharing a folder.
- **Read-only unless you say so**, per folder (see above). `--read-only` in the client setup keeps an AI app read-only whatever the folder says.
- **See it in the status bar** (right end): **MCP** shows while the MCP server is on. **Grey** = no app connected. **Green** (+ a count from 2) = an AI app is connected; it flashes briefly on each call. Hover: which app, and when it last asked. Click: **Recent activity**.
- **Off = off:** running servers stop within a second. A removed folder or revoked token is gone at once.
- **Edge cases:** a heading that is only `#` counts as empty (no section). Frontmatter key lines over 10,000 characters are ignored by `read_file` / `patch_file`.

**Answer size** (Settings → MCP server → Answer size)

| Setting | Default | Meaning |
|---|---|---|
| **Text per read** | 16 kB (≈ 4,000 tokens) | Longer files come in pages |
| **Results per call** | 25 | Search hits, files, headings, tags, links per call (file lists: 4×) |

Small local model (8k context)? Keep the defaults or go lower. Big context (128k)? Raise both.

**Recent activity:** the last 50 calls, **newest first**: ✓ ok, **!** refused or failed, ↺ reverted, with time, app, tool, file and duration on one line.

- Shows the last 5; **Show all N calls** opens the rest.
- **Filter** by tool, file, folder, app or result; **Problems only** keeps the refused and failed calls.
- **Click a row** for details (folder, full path, size, date). **Revert** sits on write rows that kept an undo copy.
- Refreshed while Settings is open. Never the text or your search words. Kept in `mcp-audit.jsonl` in the app data folder (1 MB, then rotated).

### Security updates

**One tells you when *this build* needs a rebuild.** Settings → **Security updates** → **Check now** (any time), or switch on **Check automatically every week** (off by default). Desktop app only.

| It checks | Where | You see |
|---|---|---|
| A **newer Electron patch** (= Chromium security fixes) | endoflife.date | 🟠 |
| **End of support** for your Electron major (45 days ahead, or passed) | endoflife.date | 🟠 |
| **Known vulnerabilities** in Electron and the libraries this build ships | api.osv.dev | 🔴 high / critical · 🟠 moderate / low |
| A newer Electron major | endoflife.date | listed only, no shield |

**Reading the shield**

- **No shield** at the right end of the status bar = the last check found nothing (or no check has run yet).
- **Shield + number** = that many 🔴 / 🟠 findings. **Red** shield: at least one high / critical.
- **Click it** → the list: library, **shipped version → fixed version**, one line, **Details** (opens the advisory).
- A library finding **may not affect One** (it depends on how the library is used): check the link.
- **What to do:** rebuild One with updated Electron / libraries (e.g. ask Claude: *"update Electron and release"*). Findings **disappear on their own** in a build that ships the fixed versions.

**What was checked** (Settings → Security updates, under Check now)

| Line | Shows | Mark |
|---|---|---|
| **Electron** | the version this build ships | ✓ / ! |
| **Newest patch** | newest patch of that line, "up to date" or "a newer patch is out" | ✓ / ! / ? (not listed) |
| **Support** | "Supported until *date* (*n* days left)", or "Ended" | ✓ / ! (45 days or less, or ended) |
| **Packages** | "*N* packages checked against OSV.dev, *X* with known vulnerabilities" | ✓ / ! |
| **Sources** / **Checked** | endoflife.date and OSV.dev (links), the time of the check and how long it took | |

- **Show all *N* packages** → every package + version: **OK**, or the advisory, its severity and the fixed version. Problems first; type to filter.
- A part that **failed** says so in plain words (e.g. *"Not checked: OSV.dev failed (No answer in time)"*).
- Kept with the result: still there after a restart. A build with other versions shows it again after the next check.

**When it runs**

- **Check now:** always, whether the switch is on or off. Nothing else changes.
- **Check automatically every week** on: **once after launch**, only if the last check is **7 days** old (also right after you switch it on).
- No background timer. Offline or an error: **nothing pops up**; Settings shows "Last check failed".
- Palette: **"Security updates: Show findings"** / **"Security updates: Check now"**.

**What is sent** (nothing else: no ids, no file or folder names, no cookies)

- **endoflife.date:** a plain request for the public list of Electron releases. Nothing about you or One.
- **api.osv.dev:** the **names and versions** of Electron and the libraries in this build (the same for everyone on this version).
- Both see your **IP address**, like any website.

The last result (findings + what was checked) is kept in `update-check.json` in the app's data folder, so the shield and the summary are there at launch without a request. The **shield** shows the last check's problems, whether that check ran automatically or from **Check now**.

---

## 10. Variables & targets

**Write `{{name}}` in a note. The value comes from the nearest `variables.md`.** The file on disk keeps `{{name}}`; only the display, copy and run use the value.

```bash
ssh {{user}}@{{ip}}          # shows:  ssh administrator@10.0.0.10
Get-ADUser -Server {{WS01.ip}}
```

### Quick start

1. Create **`variables.md`** in your project folder (palette → **"Variables: Open variables.md"** makes one).
2. Put a **```yaml block** in it (example below). Text around it is fine.
3. Pick an **environment** and a **target** in the status bar: **`env: lab ▾`** and **`⌖ DC01 ▾`**.
4. In **live mode** every `{{…}}` shows its value as a **chip**. Copy / ▶ Run use the values.

### Example `variables.md`

````markdown
# Lab variables

Only the **first** yaml code block is read. Comments are kept when the app writes values.

```yaml
# Values for every environment
vars:
  domain: corp.local        # AD domain
  share: ADMIN$
  ns: default
  port: 8080

# Values that live in the encrypted vault, never in this file
secrets: [db_pass, password]

# One row per machine: any fields you like
targets:
  DC01:     { ip: 10.0.0.10, user: administrator, os: windows, domain: corp.local }
  WS01:     { ip: 10.0.0.21, user: alice,         os: windows, domain: corp.local }
  Linux-WS: { ip: 10.0.0.30, user: root,          os: ubuntu,  password: vault }

envs:
  lab:
    vars:
      ns: lab
  prod:
    vars:
      ns: prod
      db_pass: vault:prod-db   # explicit vault key
    targets:
      DC01: { ip: 192.168.1.10 }   # overrides DC01's ip in prod only
```
````

### Placeholders

| Write | You get |
|---|---|
| `{{ns}}` | The value for the active environment |
| `{{ip}}`, `{{user}}`, `{{os}}`… | A field of the **active target** |
| `{{WS01.ip}}` | That target's field, **whatever target is active** |
| `{{port:22}}` | `22` when `port` is not defined |
| `{{date}}` `{{time}}` `{{title}}` | Today, now, the note's name (`{{date:DD.MM.YYYY}}` picks a format) |
| `{{target}}` `{{env}}` | The active target / environment name |

### Which value wins?

1. **Code block attribute** — ```` ```bash {target=Linux-WS env=lab} ```` (that block only).
2. **The note's frontmatter** — `vars:`, `target:`, `env:`. **The note always beats variables.md.**
3. **variables.md** (nearest one, walking up from the note's folder) — target field → environment `vars` → top-level `vars`.

Built-ins (`{{date}}`…) only fill names nobody defined. **Hover a chip** to see where its value came from, e.g. *"overridden in this note (variables.md has ADMIN$)"*.

```markdown
---
target: WS01          # this note always uses WS01
vars:
  share: C$           # beats variables.md for this note
---
```

### Chips (live mode)

| Do this | How |
|---|---|
| See the source | **Hover** the chip |
| Change a value | **Click** it → type → `Enter`. Written into variables.md (or the note) — comments stay |
| Add a missing one | Click the yellow **`{{name}}?`** chip, pick where to save it |
| See a secret | Hold **`Alt`** while hovering `••••` |
| Show raw placeholders | Palette → **"Variables: Show values / Show placeholders"** |

- **Source mode** and split's left pane always show the raw `{{…}}`.
- **Reading view** and **exports** show values. Secrets are **always** `••••` there.
- Typing **`{{`** suggests every defined name with its value.

### Environments and targets

- **Status bar:** `env: lab ▾` and `⌖ DC01 ▾`. Click → search → pick. Remembered per folder.
- **Red pill = production.** Names matching `prod|production|live` (Settings → Variables & targets).
- **⚠ OS hint** on a code block: `powershell` on a linux target, `bash` on a windows target.

### Copy, run, many targets

| Action | Result |
|---|---|
| **Copy** button | The command **with values**, real secrets included |
| **▶ Run in terminal** | Same, typed into the terminal — **you press Enter** |
| **⌖ Copy / Run for targets…** | Tick targets → one command per target (`# --- DC01 ---` between them), or **one terminal tab per target** (pre-filled, never run) |
| Something missing | A small form asks for it. Remembered for this folder. Tick **Save to variables.md** to keep it there |

### Secrets

| | Desktop app | Browser mode |
|---|---|---|
| Where the value lives | **Encrypted vault** in the app's data folder (Windows DPAPI / macOS Keychain / Linux keyring) | **Memory only**, until the tab closes |
| In variables.md / notes | Never — only `vault`, `vault:key` or the name in `secrets:` | Never |
| Preview, PDF, HTML, Copy as HTML | `••••` | `••••` |

- **Mark a secret:** list it under `secrets:`, or write `vault` / `vault:<key>` as its value.
- **Set it:** click its `🔒 name` chip, or copy the command once and type it in the form.
- **A `vault:<key>` secret is shared between folders.** The first time **another** folder uses one, One asks: *"This folder wants to use the secret … Allow?"* Say **Allow** only for a folder you trust. Asked once per folder. Plain `vault` secrets belong to their folder and are never asked about.
- **Browser mode keeps secrets in memory** on purpose: they never reach the server or a file. Linux without a keyring does the same.

### Problems

| Problem | Fix |
|---|---|
| Chip shows `{{name}}?` | Not defined: click it to add it, or check the name |
| Red squiggle in variables.md | YAML error — hover it. Until it is fixed, **the last good version is used** |
| Wrong value | Hover the chip: it says where the value came from |

## 11. Smart paste

**Off by default.** Turn on: Settings → Editor → **Smart paste**.

After a paste a small **"Paste as…"** chip appears for a few seconds. Ignore it and **your paste stays as it is**. `Esc` or typing hides it. One `Ctrl+Z` undoes either way.

| You paste | Offered |
|---|---|
| **JSON** | Pretty ```` ```json ```` block |
| **curl …** | Formatted ```` ```bash ```` with `\` line breaks, **or "as template"**: host, ids → `{{host}}`, `{{id}}` (into variables.md); tokens, passwords, cookies, API keys → `{{token}}`… (into the vault) |
| **Stack trace / compiler output** | ```` ```log ```` block — **`Ctrl+click`** a `file:line` to open it |
| **CSV / TSV / Excel cells** | Markdown table |
| **SQL** | Formatted ```` ```sql ```` |
| **Code from VS Code** | Fenced block in its language |
| **Something that looks like a secret** | ⚠ **Replace with `{{variable}}`** — the value goes to the vault, not the note |

## 12. Troubleshooting

| Problem | Fix |
|---|---|
| **Windows blocks the exe** | SmartScreen → **More info → Run anyway** |
| **App is slow to start** | Do not run it from `\\wsl$`. Copy the folder to a Windows drive |
| **A folder is missing in the tree** | Settings → Files → **Excluded folders**, or turn on **Show hidden files** |
| **Search misses a new file** | Run the command **"Rebuild search index"** |
| **The app uses CPU or memory and I don't know why** | Command **"Developer: Process explorer"**: every process, thread and worker with CPU, memory and what it is doing. Stop a stuck git or terminal command there. **Copy as text** for a bug report |
| **Formatting fails** | The message names the syntax error. File types without a formatter say so |
| **Formatting ignores my settings** | A `.prettierrc` or `.editorconfig` in the folder wins |
| **Zoom keys do nothing** | Browser mode uses the browser's zoom |
| **Phone / other PC cannot open the web server link** | Settings → Browser mode → **Network (LAN)**, then use the **network** address (not `127.0.0.1`), same Wi-Fi. Windows: allow One through the firewall (Windows Security → Firewall → Allow an app) |
| **"Port … is in use"** (web server) | Leave **Port** empty (automatic), or pick another one |
| **AI app: MCP server "failed" or "exited"** | Settings → **MCP server** must be **on** with at least one folder. Restart the app after pasting the snippet. Its MCP log shows One's message (e.g. "switched off") |
| **AI app: "no access token" / "token is not valid"** | Settings → **MCP server** → **Copy setup** (or **Regenerate**) for that app → paste → restart the app |
| **AI app: "is read-only"** | Settings → **MCP server** → that folder → **Read-write** (One asks once) |
| **AI app: "changed since you read it"** | The file was edited meanwhile (in One or elsewhere). Normal: the AI reads it again and retries; nothing was overwritten |
| **Revert: "changed after the MCP change"** | The file was edited after the AI's change, so Revert leaves it alone. Undo by hand, or use the editor's history |
| **AI app finds nothing / "not found"** | The file may be hidden (dot file, key file, Excluded folders) or outside the shared folders. Search needs a moment on the first call in a big folder: try again |
| **I want the Windows title bar back** | Settings → Appearance → **Window frame: Native** → **Restart now** |
| **Can't drag the window** | Drag the **empty** part of the tab strip (not a tab or button) |
| **Spellcheck did not turn on** | Restart the desktop app |
| **PDF export says "close it in other apps"** | The PDF is open in a viewer (Windows locks it). Close it, or save under another name |
| **An image is missing in the PDF** | It shows as "Image not found: …". Check the path, or the image is over 20 MB |
| **Terminal opens in my home folder, not the project** | Your `~/.bashrc` (or WSL's) ends with `cd ~`. Remove that line |
| **cmd says "UNC paths are not supported"** | Normal for `\\wsl…` folders: the app `pushd`s there for you. Prefer PowerShell or the WSL shell |
| **New terminals open slowly** (PowerShell, WSL) | The shell itself takes a moment to start. Settings → Terminal → **Keep a terminal ready**: the next one is already running |
| **Need more history in a terminal** | Settings → Terminal → **Scrollback** (each 1000 lines ≈ 1.5–2 MB per terminal) |
| **A shell is missing in ▾** | Install it, then **▾ → Refresh list** |
| **Claude Code says "Not installed"** | **Copy** the install command in the ▾ card, run it, check `claude --version`, then **Refresh list** |
| **`` Ctrl+` `` does nothing** | Some keyboard layouts have no backtick key: palette → **"Terminal: Toggle panel"** |
| **Git is slow on a `\\wsl.localhost` folder** | Settings → Files → **Run git inside WSL** must be **Auto**, and the distro needs git (`sudo apt install git` inside WSL) |
| **Marks look stale after a big checkout** | Run `git status` once in a terminal: git then refreshes its index and every later check is fast again |
| **No git marks / no branch in the status bar** | Is it a git repository (a `.git` folder here or above)? Is git installed (`git --version` in a terminal)? Settings → Files → **Git status** must be on |
| **Compare with Clipboard says the browser blocked it** | Browser mode only: allow clipboard access for the page (address bar → site settings), then try again |
| **"git refuses this repository (safe.directory)"** | The folder belongs to another user (USB stick, network drive). Run `git config --global --add safe.directory <folder>` in a terminal, if you trust it |
| **Push / pull says "sign in"** | Click **Open in terminal**, press Enter, log in there once. After that the app can push too |
| **Everything looks broken** | `Ctrl+Shift+I` (macOS `Cmd+Alt+I`) opens developer tools (desktop). Check the console |
