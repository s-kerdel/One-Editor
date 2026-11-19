# sec-edit user guide

**Open a folder, then edit.** Everything below is optional detail. Jump to what you need.

| I want to… | Go to |
|---|---|
| Open folders and files | [1. Folders and files](#1-folders-and-files) |
| Read a PDF | [PDF files](#pdf-files) |
| Write notes faster | [2. Writing notes](#2-writing-notes) |
| Link notes together | [3. Links and knowledge](#3-links-and-knowledge) |
| Find something | [4. Search](#4-search) |
| Format code | [5. Code and formatting](#5-code-and-formatting) |
| Read or export a note | [6. Preview and export](#6-preview-and-export) |
| Make a PDF of a note | [Export to PDF](#export-to-pdf) |
| Run commands / use Claude Code | [7. Terminal and Claude Code](#7-terminal-and-claude-code) |
| See changes, commit, push | [8. Git](#8-git) |
| Change how it behaves | [9. Settings](#9-settings) |
| Open this folder in a web browser (phone, tablet, another PC) | [Browser mode](#browser-mode-web-server) |
| Put `{{host}}`, `{{user}}`… in commands | [10. Variables & targets](#10-variables--targets) |
| Turn a pasted curl / JSON / log into a clean block | [11. Smart paste](#11-smart-paste) |
| Fix a problem | [12. Troubleshooting](#12-troubleshooting) |

> `Ctrl` = `Cmd` on macOS. **Forgot a shortcut?** `Ctrl+Shift+P` lists every command.

---

## 1. Folders and files

**A workspace is just a folder.** Nothing is added to it, except attachments you paste.

| Do this | How |
|---|---|
| Open a folder | Drag it onto the window, or run `sec-edit.exe C:\notes` |
| Open a file | `Ctrl+P`, type part of the name, `Enter` |
| New note | `Ctrl+N`, then type its name |
| Rename / delete | `F2` / `Del` in the file tree |
| Move | Drag the file onto a folder |
| Close tab | `Ctrl+W`, **double-click the tab name**, middle-click the tab, or its × |
| Switch tabs | `Ctrl+Tab` (most recently used first) |

### Sidebar styles

**Pick one in Settings → Appearance → Sidebar style** (or palette: "Switch sidebar style").

| Style | Looks like | Panels |
|---|---|---|
| **Shelf** (default) | Workspace card on top, a **Jump to…** pill (`Ctrl+P`), Recent notes, a colour per top-level folder, the editor as a raised card | Pills under the jump pill; the active pill shows its name |
| **Classic** | IDE-style: icon bar on the far left, dense tree with guides, full-width status bar | Icon bar; click the open panel again to hide the sidebar |

Both: `Ctrl+Shift+B` hides / shows the sidebar. In Shelf, the sidebar button at the top (or at the start of the tab strip when hidden) does the same.

**Hidden stays hidden.** The sidebar comes back the way you left it after a restart or refresh — shown or hidden, same width.

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
- **Tidy up:** click a section title to collapse it. Collapsed sections stay collapsed.
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

### Saving

- **Autosave is on.** It saves shortly after you stop typing.
- `Ctrl+S` saves right away.
- **Line endings and encoding are kept** as they were (CRLF, BOM, UTF-16, Windows-1252).

### When a file changes outside sec-edit

| Your copy | What happens |
|---|---|
| **No unsaved edits** | The file reloads silently |
| **Unsaved edits** | A banner appears. You choose which version to keep |

### Deleting

- Files go to the **Recycle Bin**, not gone forever.
- If the bin is unavailable, sec-edit asks before deleting permanently.

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

- **Counts** are in each header. Collapsed parts stay collapsed.
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
| Jump to a heading | `Ctrl+Shift+O` (this file) · `Ctrl+T` (workspace) |

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
| `#` | Headings in the workspace |
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
| **Images** | Images from your folder are **embedded** (`![](img.png)`, `![[img.png]]`). `https://` images too |
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

## 8. Git

**Open a folder that is a git repository. That's it.** sec-edit uses **your installed git**, so your login, SSH keys and Windows Credential Manager just work. No git installed? Git features stay hidden (one hint tells you).

### See what changed

| Where | What you see |
|---|---|
| **File tree** | A letter at the end of the row: **M** modified · **A** added · **U** untracked (new) · **R** renamed · **!** merge conflict. Ignored files are **dimmed**. A folder with changes gets a small **dot** |
| **Status bar** | The **branch**, `↑2` / `↓1` (commits to push / to pull) and a dot when something is uncommitted. **Click it**: copy the branch name, **Show changes** (tree lists changed files only), Diff with last commit |
| **Editor** | **Bars** next to the text: green = added, blue = changed, red wedge = lines deleted. They update **while you type** |

**Undo one change:** click a bar → the old lines appear → **Revert this change**. `Ctrl+Z` brings your edit back.

**Compare a whole file:** right-click it (tree or tab) → **Diff with last commit**. Or `Ctrl+Shift+P` → "Diff with last commit". Switch **Unified / Side by side** at the top. `F7` jumps to the next change, `Esc` closes.

### Commit and push (`Ctrl+Shift+G`)

1. Open the **Git** panel (`Ctrl+Shift+G` or the branch pill in the sidebar).
2. Hover a file → **+** to stage it (or **+** on the group header for all). **−** unstages.
3. Type a message → **`Ctrl+Enter`** (or **Commit**). Nothing staged? It offers to stage everything.
4. **↑ Push** / **↓ Pull** at the top. A new branch shows **Publish** instead.

| Also | How |
|---|---|
| Fix the last commit | Tick **Amend the last commit** (the old message is filled in) |
| Commit and push in one go | **Commit & push** |
| Let Claude write the message | **✦** next to Commit: types a prompt into Claude Code. **You** press Enter |
| Throw away changes | Hover → **↺**. It **always asks**. New files go to the **Recycle Bin** |
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

In the compare view: **Swap sides**, **Ignore whitespace**, **Copy as patch**, Unified / Side by side. `Esc` closes it; nothing is changed or saved.

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
| | Corners | Rounded |
| | Density | Comfortable |
| | Font size | 15 px |
| | Editor font | System |
| | Line height | 1.65 |
| | Content width | Readable |
| | Zoom (desktop only) | 100% |
| | Window frame (desktop only) | Integrated (no title bar) |
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
| | Excluded folders | `node_modules`, `.git`, `dist`, `build`, `vendor`, `.next`, `.cache`, `__pycache__` |
| | Confirm before deleting | On |
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
| **Get the link** | **Copy link** or **Open** in the info box. The status bar pill **🌐 :4317** opens it again |
| **See it all** | Palette → **"Web server: Show info"** (folder, address, access, limits) |
| **Stop** | **Stop server**, palette → **"Stop web server"**, or quit sec-edit |

| Option | Choices |
|---|---|
| **Port** | Empty = automatic (4317, else the next free one) · or a fixed port |
| **Who can connect** | **This computer** (default, 127.0.0.1 only) · **Network (LAN)** |

- **The link holds a secret key.** Without it the server refuses every request. Share it only with people you trust.
- **Network (LAN) is opt-in, and asked every time:** anyone on your network with the link can **read and edit** this folder. It is plain HTTP: trusted networks only, not public Wi-Fi.
- **Windows:** the first network start shows a **firewall prompt** for sec-edit. Allow **Private networks** only.
- **Nothing starts on its own.** Opening another folder stops it. Quitting sec-edit stops it.
- **Own tabs:** the browser keeps its own open tabs, tree and layout per folder (the first visit starts from the desktop's). The desktop's stay as they were.
- **Settings are shared:** a change in the browser shows up in the desktop app at once, and the other way round.
- **Same folder, same port:** the browser remembers things per address (environment pick, recent files). So a folder gets its last port again. If that port is taken, the info box says so: browser state for this folder then starts empty.
- **In the browser:** no terminal · secrets of `{{variables}}` stay in that tab's memory only · PDF export = the browser's print dialog · one server at a time.
- **Without the desktop app:** `Start web server.cmd` (Windows) or `start-web.sh` (Linux) next to the program.

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
| **Phone / other PC cannot open the web server link** | Settings → Browser mode → **Network (LAN)**, then use the **network** address (not `127.0.0.1`), same Wi-Fi. Windows: allow sec-edit through the firewall (Windows Security → Firewall → Allow an app) |
| **"Port … is in use"** (web server) | Leave **Port** empty (automatic), or pick another one |
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
| **Everything looks broken** | `F12` opens developer tools (desktop). Check the console |
