// Declarative list of every user setting: one entry drives the control, its description, the
// search index and reset-to-default. Pure (no DOM, no app singleton) so it is unit-testable.
import { DEFAULT_SETTINGS } from '@shared/api';
import { MCP_WRITES_ENABLED } from '@shared/mcp';
import { normalizeKey } from './commands';
import { TERMINAL_SECTION, TERMINAL_SETTING_DEFS } from '../terminal/settings';

export type SectionId = 'appearance' | 'editor' | 'files' | 'search' | 'formatting' | 'links' | 'attachments' | 'preview' | 'export' | 'variables' | 'terminal' | 'webserver' | 'mcp' | 'updates' | 'shortcuts';

export interface SectionDef {
  id: SectionId;
  title: string;
  icon: string;
  blurb?: string;
  /** Not shown at all in the browser build (e.g. Browser mode: starting a server from the desktop app). */
  desktopOnly?: boolean;
}

export const SECTIONS: SectionDef[] = [
  { id: 'appearance', title: 'Appearance', icon: 'monitor' },
  { id: 'editor', title: 'Editor', icon: 'pencil' },
  { id: 'files', title: 'Files', icon: 'folder' },
  { id: 'search', title: 'Search & indexing', icon: 'search', blurb: 'Skipped files stay in the file tree; they are only left out of search and links.' },
  { id: 'formatting', title: 'Formatting', icon: 'braces', blurb: 'A .prettierrc or .editorconfig in the folder overrides these.' },
  { id: 'links', title: 'Links & notes', icon: 'link', blurb: 'Date formats use YYYY MM DD HH mm tokens; [text] is copied literally.' },
  { id: 'attachments', title: 'Attachments', icon: 'image' },
  { id: 'preview', title: 'Preview', icon: 'eye' },
  { id: 'export', title: 'Export', icon: 'printer', blurb: 'Paper settings for “Export note to PDF…”.' },
  { id: 'variables', title: 'Variables & targets', icon: 'database', blurb: '{{name}} placeholders, environments and targets from the nearest variables.md.' },
  { ...TERMINAL_SECTION },
  // Settings.tsx shows the live server state + Start / Stop above the rows (src/renderer/webserver).
  { id: 'webserver', title: 'Browser mode', icon: 'globe', blurb: 'Open this folder in a web browser: on this computer, or from other devices on your network.', desktopOnly: true },
  // Settings.tsx shows on/off, the shared folders, client setup and activity above the rows (src/renderer/mcp).
  { id: 'mcp', title: 'MCP server', icon: 'plug', blurb: 'Let AI apps (LM Studio, Codex CLI, Claude…) read the folders you share, through the Model Context Protocol.', desktopOnly: true },
  // Settings.tsx shows the last check + "Check now" + what is sent above the row (src/renderer/updates).
  { id: 'updates', title: 'Security updates', icon: 'shield', blurb: 'Tells you when this build needs a rebuild: a newer Electron patch, a known vulnerability, end of support.', desktopOnly: true },
  { id: 'shortcuts', title: 'Keyboard shortcuts', icon: 'keyboard' },
];

export interface Choice {
  v: unknown;
  label: string;
  icon?: string;
}

export type Control =
  | { type: 'toggle' }
  | { type: 'segmented'; options: Choice[] }
  | { type: 'select'; options: Choice[] }
  | { type: 'number'; min: number; max: number; step?: number; stepper?: boolean; unit?: string; placeholder?: string }
  | { type: 'text'; placeholder?: string; mono?: boolean }
  | { type: 'list'; placeholder?: string }
  /** Curated swatches (v = '#rrggbb', '' = theme default) plus a custom colour input. */
  | { type: 'color'; swatches: Choice[]; base?: string }
  /** Font presets (v = CSS font-family, '' = default) plus a free-text "Custom" entry. */
  | { type: 'font'; presets: Choice[]; placeholder?: string };

export interface SettingDef {
  key: string;
  section: SectionId;
  label: string;
  /** One line, shown under the label. */
  description: string;
  /** Extra search terms. */
  keywords?: string[];
  /** `null` = "not set" (the consumer picks a per-language / built-in default). */
  default: unknown;
  control: Control;
  /** DOM id of the control (stable; tests and <label for> use it). */
  id: string;
  /** Only works in the desktop app. */
  desktopOnly?: boolean;
  /** Greyed out unless this predicate holds for the current settings. */
  enabledWhen?: (s: Record<string, unknown>) => boolean;
  /** Sub-heading inside the section (consecutive settings with the same group sit under it). */
  group?: string;
}

const D = DEFAULT_SETTINGS;

/** Accent swatches: '' is the built-in blue; the rest are derived per theme by app/accent.ts. */
export const ACCENT_SWATCHES: Choice[] = [
  { v: '', label: 'Blue (default)' },
  { v: '#6366f1', label: 'Indigo' },
  { v: '#8b5cf6', label: 'Violet' },
  { v: '#d946ef', label: 'Magenta' },
  { v: '#ec4899', label: 'Pink' },
  { v: '#ef4444', label: 'Red' },
  { v: '#f97316', label: 'Orange' },
  { v: '#eab308', label: 'Yellow' },
  { v: '#22c55e', label: 'Green' },
  { v: '#14b8a6', label: 'Teal' },
  { v: '#8b94a5', label: 'Graphite' },
];

/** One folder colour: '' = classic's grey (--ft-folder, per theme); picks are tuned per theme (app/accent.ts). */
export const FOLDER_SWATCHES: Choice[] = [{ v: '', label: 'Grey (default)' }, { v: '#7aa2f7', label: 'Blue' }, ...ACCENT_SWATCHES.slice(1, -1)];

export const FONT_PRESETS: Choice[] = [
  { v: '', label: 'System' },
  { v: "Charter, 'Iowan Old Style', Georgia, Cambria, 'Times New Roman', serif", label: 'Serif' },
  { v: 'var(--font-mono)', label: 'Mono' },
];
const idFor = (key: string) => `set-${key.replace(/\./g, '-')}`;

type Draft = Omit<SettingDef, 'id'> & { id?: string };
const defs: Draft[] = [
  // ---- Appearance ----
  {
    key: 'theme',
    section: 'appearance',
    label: 'Theme',
    description: 'Dark, light, or follow the operating system.',
    keywords: ['color', 'colour', 'dark mode', 'light mode'],
    default: D.theme,
    control: {
      type: 'segmented',
      options: [
        { v: 'dark', label: 'Dark', icon: 'moon' },
        { v: 'light', label: 'Light', icon: 'sun' },
        { v: 'system', label: 'System', icon: 'monitor' },
      ],
    },
  },
  {
    key: 'accentColor',
    section: 'appearance',
    label: 'Accent colour',
    description: 'Colour of links, buttons, the active tab and selections. Tuned per theme to stay readable.',
    keywords: ['color', 'highlight', 'tint', 'brand', 'link colour', 'selection'],
    default: D.accentColor ?? '',
    control: { type: 'color', swatches: ACCENT_SWATCHES },
  },
  {
    key: 'sidebarStyle',
    section: 'appearance',
    label: 'Sidebar style',
    description: 'Shelf: workspace card, panel pills and a floating editor. Classic: an IDE-style icon bar.',
    keywords: ['layout', 'activity bar', 'menu', 'left menu', 'vscode', 'compact'],
    default: D.sidebarStyle ?? 'shelf',
    control: {
      type: 'segmented',
      options: [
        { v: 'shelf', label: 'Shelf', icon: 'sidebar' },
        { v: 'classic', label: 'Classic', icon: 'columns' },
      ],
    },
  },
  {
    key: 'tree.folderColors',
    section: 'appearance',
    label: 'Folder colours',
    description: 'Shelf style: a colour per top-level folder. One colour: every folder alike, in both styles.',
    keywords: ['folder', 'colour', 'color', 'hue', 'tree', 'icon', 'calm', 'grey', 'gray', 'file tree'],
    default: 'hue',
    control: {
      type: 'segmented',
      options: [
        { v: 'hue', label: 'Per top-level folder' },
        { v: 'one', label: 'One colour' },
      ],
    },
  },
  {
    key: 'tree.folderColor',
    section: 'appearance',
    label: 'Folder colour',
    description: 'The colour of every folder when they share one. Tuned per theme to stay visible.',
    keywords: ['folder', 'colour', 'color', 'tree', 'icon', 'grey', 'gray', 'file tree'],
    default: '',
    control: { type: 'color', swatches: FOLDER_SWATCHES, base: 'var(--ft-folder)' },
    enabledWhen: (s) => s['tree.folderColors'] === 'one',
  },
  {
    key: 'cornerStyle',
    section: 'appearance',
    label: 'Corners',
    description: 'Rounded cards, buttons and pills — or crisp square edges everywhere.',
    keywords: ['radius', 'rounded', 'square', 'sharp', 'border'],
    default: D.cornerStyle ?? 'rounded',
    control: {
      type: 'segmented',
      options: [
        { v: 'rounded', label: 'Rounded' },
        { v: 'square', label: 'Square' },
      ],
    },
  },
  {
    key: 'uiDensity',
    section: 'appearance',
    label: 'Density',
    description: 'Height of file rows, tabs, menus and the status bar.',
    keywords: ['compact', 'spacious', 'comfortable', 'spacing', 'padding', 'row height', 'tab height'],
    default: D.uiDensity ?? 'comfortable',
    control: {
      type: 'segmented',
      options: [
        { v: 'compact', label: 'Compact' },
        { v: 'comfortable', label: 'Comfortable' },
        { v: 'spacious', label: 'Spacious' },
      ],
    },
  },
  {
    key: 'fontSize',
    id: 'set-font-size',
    section: 'appearance',
    label: 'Font size',
    description: 'Text size in the editor and the preview.',
    keywords: ['text size', 'bigger', 'smaller'],
    default: D.fontSize,
    control: { type: 'number', min: 10, max: 32, stepper: true, unit: 'px' },
  },
  {
    key: 'editorFont',
    section: 'appearance',
    label: 'Editor font',
    description: 'Font for Markdown text. Custom takes any installed font, e.g. Cascadia Code.',
    keywords: ['typeface', 'font family', 'monospace', 'serif', 'sans'],
    default: D.editorFont,
    control: { type: 'font', presets: FONT_PRESETS, placeholder: 'Font name, e.g. Georgia' },
  },
  {
    key: 'editorLineHeight',
    section: 'appearance',
    label: 'Line height',
    description: 'Space between lines of Markdown text in the editor and the preview.',
    keywords: ['line spacing', 'leading', 'airy', 'dense'],
    default: D.editorLineHeight ?? 1.65,
    control: { type: 'number', min: 1.2, max: 2.4, step: 0.05, stepper: true },
  },
  {
    key: 'contentWidth',
    section: 'appearance',
    label: 'Content width',
    description: 'Width of the Markdown text column. Also the button left of the view modes.',
    keywords: ['readable', 'wide', 'full width', 'line length', 'column', 'margin', 'max width'],
    default: D.contentWidth ?? 'readable',
    control: {
      type: 'segmented',
      options: [
        { v: 'readable', label: 'Readable' },
        { v: 'wide', label: 'Wide' },
        { v: 'full', label: 'Full' },
      ],
    },
  },
  {
    key: 'zoom',
    section: 'appearance',
    label: 'Zoom',
    description: 'Scales the whole window. Also Ctrl + = / − / 0.',
    keywords: ['scale', 'magnify', 'ui size'],
    default: D.zoom ?? 1,
    desktopOnly: true,
    control: { type: 'select', options: [] }, // filled from ZOOM_STEPS by the UI
  },
  {
    key: 'windowFrame',
    section: 'appearance',
    label: 'Window frame',
    description: 'Integrated: minimize/maximize/close in the tab strip, no title bar. Applies after a restart.',
    keywords: ['title bar', 'titlebar', 'window controls', 'frameless', 'minimize', 'maximize', 'close', 'caption', 'chrome', 'native', 'snap'],
    default: D.windowFrame ?? 'integrated',
    desktopOnly: true,
    control: {
      type: 'segmented',
      options: [
        { v: 'integrated', label: 'Integrated' },
        { v: 'native', label: 'Native' },
      ],
    },
  },
  // ---- Appearance → Zen mode (View: Toggle zen mode, app/zen.tsx) ----
  // `zen.keepFileTree` (zen before the strips) is gone on purpose: a stored value is ignored (app/zen-impl.ts).
  {
    key: 'zen.fullScreen',
    section: 'appearance',
    group: 'Zen mode',
    label: 'Full screen',
    description: 'Zen mode (Ctrl+Alt+Z) fills the screen. Off: the window keeps its size.',
    keywords: ['zen', 'distraction free', 'focus', 'fullscreen', 'full screen', 'f11', 'writing'],
    default: true,
    control: { type: 'toggle' },
  },
  {
    key: 'zen.keepStatusBar',
    section: 'appearance',
    group: 'Zen mode',
    label: 'Keep the status bar',
    description: 'Zen mode hides the status bar. On: it stays at the bottom.',
    keywords: ['zen', 'distraction free', 'focus', 'status', 'word count', 'writing'],
    default: false,
    control: { type: 'toggle' },
  },

  // ---- Editor ----
  {
    key: 'viewMode',
    section: 'editor',
    label: 'View mode',
    description: 'Live preview, raw source, editor + preview side by side, or reading view.',
    keywords: ['live preview', 'source', 'split', 'reading', 'preview'],
    default: D.viewMode,
    control: {
      type: 'segmented',
      options: [
        { v: 'live', label: 'Live' },
        { v: 'source', label: 'Source' },
        { v: 'split', label: 'Split' },
        { v: 'preview', label: 'Reading' },
      ],
    },
  },
  {
    key: 'formatToolbar',
    section: 'editor',
    label: 'Formatting toolbar in live mode',
    description: 'Bold, headings, lists… above the editor while in live preview.',
    keywords: ['toolbar', 'buttons', 'bold', 'italic', 'wysiwyg'],
    default: D.formatToolbar ?? true,
    control: { type: 'toggle' },
  },
  {
    key: 'markdownLineNumbers',
    section: 'editor',
    label: 'Line numbers in Markdown source & split mode',
    description: 'Never shown in live preview or reading view. Code files always have them.',
    keywords: ['gutter', 'line number'],
    default: D.markdownLineNumbers ?? true,
    control: { type: 'toggle' },
  },
  { key: 'wordWrap', section: 'editor', label: 'Word wrap', description: 'Wrap long lines instead of scrolling sideways.', keywords: ['line wrap', 'soft wrap'], default: D.wordWrap, control: { type: 'toggle' } },
  {
    key: 'spellcheck',
    section: 'editor',
    label: 'Spellcheck',
    description: 'Underline misspelled words in Markdown notes. The desktop app needs a restart.',
    keywords: ['spelling', 'typo', 'dictionary'],
    default: D.spellcheck,
    control: { type: 'toggle' },
  },
  {
    key: 'editor.focusMode',
    section: 'editor',
    label: 'Focus mode',
    description: 'Dim everything in a Markdown note except the paragraph you are writing.',
    keywords: ['dim', 'distraction free', 'zen', 'writing', 'paragraph'],
    default: false,
    control: { type: 'toggle' },
  },
  {
    key: 'editor.typewriter',
    section: 'editor',
    label: 'Typewriter scrolling',
    description: 'Keep the line you are typing on in the middle of the screen (Markdown).',
    keywords: ['center', 'centre', 'scroll', 'writing', 'cursor'],
    default: false,
    control: { type: 'toggle' },
  },
  {
    key: 'editor.smartPaste',
    section: 'editor',
    label: 'Smart paste',
    description: 'After a paste, offer “Paste as…”: JSON, curl, stack traces, tables, SQL, code, secrets.',
    keywords: ['paste', 'json', 'curl', 'csv', 'sql', 'stack trace', 'format'],
    default: false,
    control: { type: 'toggle' },
  },
  {
    key: 'compare.enabled',
    section: 'editor',
    label: 'Compare text',
    description: 'Right-click: compare text with the clipboard or with a selection you marked earlier.',
    keywords: ['diff', 'compare', 'clipboard', 'selection', 'git'],
    default: true,
    control: { type: 'toggle' },
  },
  // ---- Editor → Trailing whitespace (src/renderer/whitespace) ----
  {
    key: 'editor.trimPaste.markdown',
    section: 'editor',
    group: 'Trailing whitespace',
    label: 'Trim pasted text in notes',
    description: 'Strip trailing spaces from each pasted line (terminal padding). Ctrl+Shift+V pastes as copied.',
    keywords: ['trailing', 'spaces', 'whitespace', 'paste', 'terminal', 'strip', 'markdown'],
    default: true,
    control: { type: 'toggle' },
  },
  {
    key: 'editor.trimPaste.code',
    section: 'editor',
    group: 'Trailing whitespace',
    label: 'Trim pasted text in code files',
    description: 'The same for code files.',
    keywords: ['trailing', 'spaces', 'whitespace', 'paste', 'terminal', 'strip', 'code'],
    default: true,
    control: { type: 'toggle' },
  },
  {
    key: 'editor.trimOnSave.markdown',
    section: 'editor',
    group: 'Trailing whitespace',
    label: 'Trim on save in notes',
    description: 'Edited lines only = no noise in git diffs. A .editorconfig trim_trailing_whitespace wins.',
    keywords: ['trailing', 'spaces', 'whitespace', 'save', 'strip', 'markdown', 'editorconfig'],
    default: 'changed',
    control: {
      type: 'segmented',
      options: [
        { v: 'off', label: 'Off' },
        { v: 'changed', label: 'Edited lines' },
        { v: 'all', label: 'All lines' },
      ],
    },
  },
  {
    key: 'editor.trimOnSave.code',
    section: 'editor',
    group: 'Trailing whitespace',
    label: 'Trim on save in code files',
    description: 'The same for code files. Autosave never trims the line you are typing on.',
    keywords: ['trailing', 'spaces', 'whitespace', 'save', 'strip', 'code', 'editorconfig'],
    default: 'changed',
    control: {
      type: 'segmented',
      options: [
        { v: 'off', label: 'Off' },
        { v: 'changed', label: 'Edited lines' },
        { v: 'all', label: 'All lines' },
      ],
    },
  },
  {
    key: 'editor.trimOnSave.keepMarkdownBreaks',
    section: 'editor',
    group: 'Trailing whitespace',
    label: 'Keep Markdown hard breaks',
    description: 'Two trailing spaces before text (a Markdown hard break) survive trimming; code blocks don’t.',
    keywords: ['hard break', 'two spaces', 'br', 'markdown', 'trailing'],
    default: true,
    control: { type: 'toggle' },
  },

  // ---- Files ----
  { key: 'autosave', section: 'files', label: 'Autosave', description: 'Save shortly after you stop typing.', keywords: ['auto save', 'save automatically'], default: D.autosave, control: { type: 'toggle' } },
  {
    key: 'autosaveDelayMs',
    section: 'files',
    label: 'Autosave delay',
    description: 'How long to wait after the last keystroke.',
    keywords: ['debounce', 'milliseconds'],
    default: D.autosaveDelayMs,
    control: { type: 'number', min: 150, max: 60000, step: 50, unit: 'ms' },
    enabledWhen: (s) => s.autosave !== false,
  },
  { key: 'showHiddenFiles', section: 'files', label: 'Show hidden files', description: 'List files and folders whose name starts with a dot.', keywords: ['dotfiles', '.env'], default: D.showHiddenFiles, control: { type: 'toggle' } },
  {
    key: 'excludeGlobs',
    section: 'files',
    label: 'Excluded folders',
    description: 'Hidden from the tree and search. Names, *.log, docs/build, **/secrets, private/*.md.',
    keywords: ['ignore', 'node_modules', 'glob', 'exclude', '**'],
    default: D.excludeGlobs,
    control: { type: 'list', placeholder: 'node_modules, *.log, docs/build, **/secrets' },
  },
  { key: 'confirmDelete', section: 'files', label: 'Confirm before deleting', description: 'Ask before moving files to the trash.', keywords: ['trash', 'recycle bin', 'remove'], default: D.confirmDelete ?? true, control: { type: 'toggle' } },
  {
    key: 'git.enabled',
    section: 'files',
    label: 'Git status',
    description: 'Show changed files, the branch and change bars when the folder is a git repository.',
    keywords: ['git', 'version control', 'vcs', 'branch', 'modified', 'diff', 'changes'],
    default: true,
    control: { type: 'toggle' },
  },
  {
    key: 'git.changeBars',
    section: 'files',
    label: 'Change bars in the editor',
    description: 'Mark lines added, changed or deleted since the last commit next to the text.',
    keywords: ['git', 'diff', 'changes', 'modified lines', 'margin'],
    default: true,
    control: { type: 'toggle' },
    enabledWhen: (s) => s['git.enabled'] !== false,
  },
  {
    key: 'git.treeColors',
    section: 'files',
    label: 'Git colours in the file tree',
    description: 'Colour changed files and show their letters and folder dots. Off: a calm tree; git keeps working.',
    keywords: ['git', 'colour', 'color', 'marks', 'modified', 'untracked', 'letters', 'dots', 'calm', 'focus', 'decorations'],
    default: true,
    control: { type: 'toggle' },
    enabledWhen: (s) => s['git.enabled'] !== false,
  },
  {
    key: 'git.wslRouting',
    section: 'files',
    label: 'Run git inside WSL',
    description: 'For folders under \\\\wsl.localhost: use the distro’s own git (much faster). Off: Windows git.',
    keywords: ['git', 'wsl', 'linux', 'ubuntu', 'slow', 'performance', 'windows'],
    default: 'auto',
    control: {
      type: 'segmented',
      options: [
        { v: 'auto', label: 'Auto' },
        { v: 'off', label: 'Off' },
      ],
    },
    enabledWhen: (s) => s['git.enabled'] !== false,
  },
  {
    key: 'git.refreshIndex',
    section: 'files',
    label: 'Keep git status fast',
    description: 'Refresh git’s internal timestamp cache when status is slow. Files and staging stay as they are.',
    keywords: ['git', 'index', 'slow', 'performance', 'refresh', 'update-index', 'cache'],
    default: true,
    control: { type: 'toggle' },
    enabledWhen: (s) => s['git.enabled'] !== false,
  },

  // ---- Search & indexing (read by the backend: service.ts indexOptionsFrom; workers by search/client.ts) ----
  {
    key: 'search.indexing',
    section: 'search',
    label: 'Build the index',
    description: 'On demand: when you first search or open backlinks. Switching to it applies next launch.',
    keywords: ['index', 'on demand', 'lazy', 'launch', 'startup', 'background', 'workers'],
    default: 'launch',
    control: {
      type: 'segmented',
      options: [
        { v: 'launch', label: 'At launch' },
        { v: 'onDemand', label: 'On demand' },
      ],
    },
  },
  {
    key: 'search.respectGitignore',
    section: 'search',
    label: 'Skip git-ignored files',
    description: 'Leave out what .gitignore, .git/info/exclude and your global git excludes ignore.',
    keywords: ['gitignore', 'ignore', 'build output', 'coverage', 'index'],
    default: true,
    control: { type: 'toggle' },
  },
  {
    key: 'search.skipLockfiles',
    section: 'search',
    label: 'Skip lockfiles',
    description: 'package-lock.json, yarn.lock, composer.lock, Cargo.lock and similar.',
    keywords: ['lock', 'dependencies', 'index'],
    default: true,
    control: { type: 'toggle' },
  },
  {
    key: 'search.skipMinified',
    section: 'search',
    label: 'Skip minified bundles',
    description: 'Files like app.min.js, style.min.css and source maps (*.map).',
    keywords: ['min.js', 'source map', 'bundle', 'index'],
    default: true,
    control: { type: 'toggle' },
  },
  {
    key: 'search.maxFileSizeKB',
    section: 'search',
    label: 'Largest file to index',
    description: 'Bigger files can still be opened, they are just not searched.',
    keywords: ['size', 'limit', 'kb', 'index'],
    default: 2048,
    control: { type: 'number', min: 16, max: 16384, step: 256, unit: 'KB' },
  },
  {
    key: 'search.workers',
    section: 'search',
    label: 'Indexing threads',
    description: 'Big folders are indexed and searched on this many cores. 0 = automatic.',
    keywords: ['cores', 'cpu', 'parallel', 'performance', 'index'],
    default: 0,
    control: { type: 'number', min: 0, max: 16, step: 1, stepper: true },
  },

  // ---- Formatting ----
  {
    key: 'formatOnSave',
    section: 'formatting',
    label: 'Format on save',
    description: 'Format when you press Ctrl+S. Autosaves never reformat.',
    keywords: ['prettier', 'beautify', 'autoformat'],
    default: D.formatOnSave,
    control: { type: 'toggle' },
  },
  {
    key: 'format.printWidth',
    section: 'formatting',
    label: 'Print width',
    description: 'Wrap code at this column. Empty = 80.',
    keywords: ['line length', 'max line', 'columns', 'prettier'],
    default: null,
    control: { type: 'number', min: 20, max: 400, placeholder: '80' },
  },
  {
    key: 'format.tabWidth',
    section: 'formatting',
    label: 'Tab width',
    description: 'Spaces per indent level. Empty = 4 for PHP, 2 for everything else.',
    keywords: ['indent', 'indentation', 'spaces'],
    default: null,
    control: { type: 'number', min: 1, max: 16, placeholder: 'Auto' },
  },
  { key: 'format.useTabs', section: 'formatting', label: 'Indent with tabs', description: 'Use tab characters instead of spaces.', keywords: ['tabs', 'spaces', 'indent'], default: false, control: { type: 'toggle' } },
  {
    key: 'format.singleQuote',
    section: 'formatting',
    label: 'Quotes',
    description: 'Preferred string quotes. Language default = single for PHP, double elsewhere.',
    keywords: ['single quote', 'double quote', 'strings'],
    default: null,
    control: {
      type: 'select',
      options: [
        { v: null, label: 'Language default' },
        { v: true, label: "Single '…'" },
        { v: false, label: 'Double "…"' },
      ],
    },
  },
  {
    key: 'format.phpVersion',
    section: 'formatting',
    label: 'PHP version',
    description: 'Oldest PHP the formatted code must run on (controls e.g. trailing commas).',
    keywords: ['php', 'psr', 'per-cs'],
    default: null,
    control: {
      type: 'select',
      options: [{ v: null, label: 'Default (8.3)' }, ...['8.5', '8.4', '8.3', '8.2', '8.1', '8.0', '7.4', '7.3', '7.2', '7.1', '7.0', '5.6'].map((v) => ({ v, label: `PHP ${v}` }))],
    },
  },
  {
    key: 'format.sqlKeywordCase',
    section: 'formatting',
    label: 'SQL keyword case',
    description: 'How SELECT, FROM, WHERE… are written after formatting.',
    keywords: ['sql', 'uppercase', 'lowercase', 'keywords'],
    default: 'upper',
    control: {
      type: 'select',
      options: [
        { v: 'upper', label: 'UPPERCASE' },
        { v: 'lower', label: 'lowercase' },
        { v: 'preserve', label: 'Keep as typed' },
      ],
    },
  },

  // ---- Links & notes ----
  {
    key: 'links.updateOnRename',
    section: 'links',
    label: 'Update links on rename',
    description: 'Renaming or moving a file rewrites the [[links]] that point to it.',
    keywords: ['wikilinks', 'refactor', 'move', 'backlinks'],
    default: true,
    control: { type: 'toggle' },
  },
  {
    key: 'links.hoverPreview',
    section: 'links',
    label: 'Link preview on hover',
    description: 'Hovering a link shows the start of the linked note, or its #section.',
    keywords: ['hover', 'popover', 'page preview', 'peek', 'tooltip', 'wikilinks', 'ctrl', 'cmd'],
    default: 'mod',
    control: {
      type: 'segmented',
      options: [
        { v: 'mod', label: 'With Ctrl / Cmd' },
        { v: 'hover', label: 'Always' },
        { v: 'off', label: 'Off' },
      ],
    },
  },
  { key: 'daily.folder', section: 'links', label: 'Daily notes folder', description: 'Where daily notes are created.', keywords: ['journal', 'today', 'diary'], default: 'daily', control: { type: 'text', mono: true, placeholder: 'daily' } },
  {
    key: 'daily.format',
    section: 'links',
    label: 'Daily note name',
    description: 'File name pattern, e.g. YYYY-MM-DD or YYYY/MM/DD for subfolders.',
    keywords: ['journal', 'date format', 'today'],
    default: 'YYYY-MM-DD',
    control: { type: 'text', mono: true, placeholder: 'YYYY-MM-DD' },
  },
  {
    key: 'daily.template',
    section: 'links',
    label: 'Daily note template',
    description: 'Name of a note used as the starting content. Empty = just a heading.',
    keywords: ['journal', 'today', 'boilerplate'],
    default: '',
    control: { type: 'text', placeholder: 'None' },
  },
  {
    key: 'templates.folder',
    section: 'links',
    label: 'Templates folder',
    description: 'Markdown files in this folder show up under “Insert template”.',
    keywords: ['snippets', 'boilerplate', 'slash'],
    default: 'templates',
    control: { type: 'text', mono: true, placeholder: 'templates' },
  },
  {
    key: 'templates.dateFormat',
    section: 'links',
    label: 'Date format',
    description: 'Used by {{date}} in templates and by “Date / time” in the / menu.',
    keywords: ['template', 'today', 'slash'],
    default: 'YYYY-MM-DD',
    control: { type: 'text', mono: true, placeholder: 'YYYY-MM-DD' },
  },
  {
    key: 'templates.timeFormat',
    section: 'links',
    label: 'Time format',
    description: 'Used by {{time}} in templates and by “Date / time” in the / menu.',
    keywords: ['template', 'now', 'slash', 'clock'],
    default: 'HH:mm',
    control: { type: 'text', mono: true, placeholder: 'HH:mm' },
  },

  // ---- Attachments ----
  {
    key: 'attachments.location',
    section: 'attachments',
    label: 'Save pasted files to',
    description: 'Where pasted or dropped images and files are stored.',
    keywords: ['images', 'paste', 'drop', 'screenshots', 'location'],
    default: 'root',
    control: {
      type: 'select',
      options: [
        { v: 'root', label: 'One folder in the workspace' },
        { v: 'note', label: 'Same folder as the note' },
        { v: 'subfolder', label: 'Subfolder next to the note' },
      ],
    },
  },
  {
    key: 'attachments.folder',
    section: 'attachments',
    label: 'Attachments folder',
    description: 'Folder name used by the two folder options above.',
    keywords: ['images', 'paste', 'assets', 'media'],
    default: 'attachments',
    control: { type: 'text', mono: true, placeholder: 'attachments' },
    enabledWhen: (s) => s['attachments.location'] !== 'note',
  },

  // ---- Preview ----
  {
    key: 'preview.lineBreaks',
    section: 'preview',
    label: 'Single line breaks',
    description: 'Show a single Enter as a line break in the preview (strict Markdown joins the lines).',
    keywords: ['newline', 'br', 'hard break', 'soft break'],
    default: false,
    control: { type: 'toggle' },
  },
  {
    key: 'preview.remoteImages',
    section: 'preview',
    label: 'Images from the internet',
    description: 'Ask: a note shows a bar to load them (a folder can be always allowed). Also live preview.',
    keywords: ['remote', 'external', 'tracking', 'privacy', 'http', 'web', 'load images', 'block'],
    default: 'ask',
    control: {
      type: 'segmented',
      options: [
        { v: 'ask', label: 'Ask' },
        { v: 'always', label: 'Always load' },
        { v: 'never', label: 'Never load' },
      ],
    },
  },

  // ---- Export ----
  {
    key: 'export.pdfPageSize',
    section: 'export',
    label: 'PDF page size',
    description: 'Paper size of exported PDFs.',
    keywords: ['pdf', 'paper', 'a4', 'letter', 'legal', 'print'],
    default: 'A4',
    control: {
      type: 'segmented',
      options: [
        { v: 'A4', label: 'A4' },
        { v: 'Letter', label: 'Letter' },
        { v: 'Legal', label: 'Legal' },
      ],
    },
  },
  {
    key: 'export.pdfMargins',
    section: 'export',
    label: 'PDF margins',
    description: 'White space around the text: narrow 12 mm, normal 20 mm, wide 32 mm at the sides.',
    keywords: ['pdf', 'margin', 'print', 'page'],
    default: 'normal',
    control: {
      type: 'segmented',
      options: [
        { v: 'narrow', label: 'Narrow' },
        { v: 'normal', label: 'Normal' },
        { v: 'wide', label: 'Wide' },
      ],
    },
  },
  {
    key: 'export.pdfPageNumbers',
    section: 'export',
    label: 'Page numbers',
    description: 'Footer with “page / total” on every page of an exported PDF.',
    keywords: ['pdf', 'footer', 'numbering', 'print'],
    default: true,
    control: { type: 'toggle' },
    desktopOnly: true,
  },
  // ---- Variables (src/renderer/variables) ----
  {
    key: 'variables.showValues',
    section: 'variables',
    label: 'Show values',
    description: 'Live mode and preview show {{placeholders}} as their values (source mode stays raw).',
    keywords: ['placeholders', 'chips', 'resolve', 'targets', 'env'],
    default: true,
    control: { type: 'toggle' },
  },
  {
    key: 'variables.fileName',
    section: 'variables',
    label: 'Variables file name',
    description: 'The nearest file with this name, walking up from the note’s folder, holds the values.',
    keywords: ['variables.md', 'yaml', 'targets', 'environments'],
    default: 'variables.md',
    control: { type: 'text', placeholder: 'variables.md', mono: true },
  },
  {
    key: 'variables.dangerEnvs',
    section: 'variables',
    label: 'Production environments',
    description: 'Environment names (regex alternatives) that tint the status-bar pill red.',
    keywords: ['prod', 'production', 'live', 'danger', 'warning'],
    default: 'prod|production|live',
    control: { type: 'text', placeholder: 'prod|production|live', mono: true },
  },
  {
    key: 'variables.resolveOnExport',
    section: 'variables',
    label: 'Fill in values on export',
    description: 'PDF / HTML export and Copy as HTML use the values (secrets are always masked).',
    keywords: ['pdf', 'html', 'export', 'placeholders'],
    default: true,
    control: { type: 'toggle' },
  },
  // ---- Terminal (src/renderer/terminal/settings.ts) ----
  ...TERMINAL_SETTING_DEFS,
  // ---- Browser mode (read by shared/web-server.ts optionsFromSettings when "Start web server" runs) ----
  {
    key: 'webserver.port',
    section: 'webserver',
    label: 'Port',
    description: 'Empty = automatic (4317, or the next free one). Applies the next time the server starts.',
    keywords: ['web server', 'browser mode', 'serve', 'http', 'localhost', 'url'],
    default: null,
    control: { type: 'number', min: 1024, max: 65535, placeholder: 'Auto' },
    desktopOnly: true,
  },
  {
    key: 'webserver.access',
    section: 'webserver',
    label: 'Who can connect',
    description: 'Network: anyone on your network with the link can read and change the files in this folder.',
    keywords: ['web server', 'browser mode', 'serve', 'lan', 'network', 'share', 'phone', 'tablet', 'remote', 'firewall', '0.0.0.0'],
    default: 'local',
    control: {
      type: 'segmented',
      options: [
        { v: 'local', label: 'This computer' },
        { v: 'lan', label: 'Network (LAN)' },
      ],
    },
    desktopOnly: true,
  },
  // ---- MCP server: result sizes (read by the server on every call: shared/mcp.ts limitsFromSettings) ----
  {
    key: 'mcp.maxReadKB',
    section: 'mcp',
    label: 'Text per read',
    description: 'Most text one read returns (longer files come in pages). Small = fits small local models.',
    keywords: ['mcp', 'ai', 'llm', 'context', 'tokens', 'lm studio', 'codex', 'claude', 'read_file', 'page'],
    default: 16,
    control: { type: 'number', min: 4, max: 256, step: 4, stepper: true, unit: 'kB' },
    desktopOnly: true,
    group: 'Answer size',
  },
  {
    key: 'mcp.maxResults',
    section: 'mcp',
    label: 'Results per call',
    description: 'Most search hits, files, headings, tags or links one call returns.',
    keywords: ['mcp', 'ai', 'llm', 'context', 'tokens', 'search', 'limit'],
    default: 25,
    control: { type: 'number', min: 5, max: 200, step: 5, stepper: true },
    desktopOnly: true,
    group: 'Answer size',
  },
  {
    key: 'mcp.allowCode',
    section: 'mcp',
    label: 'Also allow code and config files',
    description: 'Off: AI apps write notes only (.md, .markdown, .txt). Scripts and programs: never.',
    keywords: ['mcp', 'ai', 'write', 'code', 'config', 'json', 'yaml', 'file types', 'extensions'],
    default: false,
    control: { type: 'toggle' },
    desktopOnly: true,
    group: 'Changes',
    enabledWhen: () => MCP_WRITES_ENABLED, // greyed out while this build ships MCP read-only
  },
  {
    key: 'mcp.journal',
    section: 'mcp',
    label: 'Keep undo copies of AI edits',
    description: 'Off: AI changes made from now on keep no copy and cannot be reverted here. Old copies stay.',
    keywords: ['mcp', 'ai', 'undo', 'revert', 'history', 'journal', 'backup', 'restore'],
    default: true,
    control: { type: 'toggle' },
    desktopOnly: true,
    group: 'Undo',
    enabledWhen: () => MCP_WRITES_ENABLED,
  },
  {
    key: 'mcp.journalDays',
    section: 'mcp',
    label: 'Keep undo copies for',
    description: 'Older copies are removed (at most 100 MB in all).',
    keywords: ['mcp', 'ai', 'undo', 'revert', 'history', 'days'],
    default: 30,
    control: { type: 'number', min: 1, max: 365, stepper: true, unit: 'days' },
    desktopOnly: true,
    group: 'Undo',
    enabledWhen: (s) => MCP_WRITES_ENABLED && s['mcp.journal'] !== false,
  },
  // ---- Security updates (opt-in automatic check; main reads it before every automatic check: src/main/update-check.ts) ----
  {
    key: 'updates.check',
    section: 'updates',
    label: 'Check automatically every week',
    description: 'Checks once a week after launch. Off: nothing is sent unless you click Check now.',
    keywords: ['security', 'update', 'electron', 'chromium', 'vulnerability', 'cve', 'patch', 'outdated', 'osv', 'privacy', 'network', 'automatic', 'weekly'],
    default: false,
    control: { type: 'toggle' },
    desktopOnly: true,
  },
];

export const SETTINGS: SettingDef[] = defs.map((d) => ({ ...d, id: d.id ?? idFor(d.key) }));

export const settingByKey = (key: string): SettingDef | undefined => SETTINGS.find((d) => d.key === key);

// ---- values ---------------------------------------------------------------------------------

const same = (a: unknown, b: unknown): boolean => (Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => x === b[i]) : a === b);

/** Current value with "missing" normalised to the default. */
export function valueOf(def: SettingDef, s: Record<string, unknown>): unknown {
  const v = s[def.key];
  return v === undefined || v === null ? def.default : v;
}

export function isChanged(def: SettingDef, s: Record<string, unknown>): boolean {
  return !same(valueOf(def, s), def.default);
}

/** Patch that puts a setting back to its default. `null` (not undefined) so it survives JSON and overwrites the stored value. */
export function resetPatch(def: SettingDef): Record<string, unknown> {
  return { [def.key]: Array.isArray(def.default) ? [...def.default] : def.default };
}

/** "a, b\nc" → ['a', 'b', 'c'] */
export function parseList(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Parses a typed number; null = cleared, undefined = not acceptable (yet). */
export function parseNumber(raw: string, c: { min: number; max: number }, nullable: boolean): number | null | undefined {
  const t = raw.trim();
  if (!t) return nullable ? null : undefined;
  const n = Number(t);
  return Number.isFinite(n) && n >= c.min && n <= c.max ? n : undefined;
}

// ---- search ---------------------------------------------------------------------------------

/** Letters of `q` appear in order within a short stretch of `text` ("phpv" → "PHP version"). */
function loose(q: string, text: string): boolean {
  if (q.length < 3) return false;
  const maxSpan = q.length * 2 + 2;
  for (let start = text.indexOf(q[0]); start !== -1; start = text.indexOf(q[0], start + 1)) {
    let i = start;
    let ok = true;
    for (let k = 1; k < q.length; k++) {
      i = text.indexOf(q[k], i + 1);
      if (i === -1 || i - start >= maxSpan) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

const wordStart = (text: string, q: string) => text.startsWith(q) || text.includes(` ${q}`) || text.includes(`.${q}`);

function scoreToken(q: string, fields: { label: string; key: string; extra: string; description: string }): number {
  const { label, key, extra, description } = fields;
  if (wordStart(label, q)) return 100;
  if (label.includes(q)) return 80;
  if (wordStart(key, q)) return 75;
  if (key.includes(q)) return 70;
  if (extra.includes(q)) return 50;
  if (description.includes(q)) return 30;
  // Fuzzy only on the short fields: a subsequence test against a sentence matches almost anything.
  if (loose(q, label) || loose(q, key)) return 10;
  return 0;
}

const tokens = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean);

/** 0 = no match. Every word of the query has to match somewhere (label, key, keywords, section, description). */
export function scoreSetting(query: string, def: SettingDef): number {
  const qs = tokens(query);
  if (!qs.length) return 1;
  const section = SECTIONS.find((s) => s.id === def.section)?.title ?? '';
  const fields = {
    label: def.label.toLowerCase(),
    key: def.key.toLowerCase(),
    extra: [...(def.keywords ?? []), section].join(' | ').toLowerCase(),
    description: def.description.toLowerCase(),
  };
  let total = 0;
  for (const q of qs) {
    const s = scoreToken(q, fields);
    if (!s) return 0;
    total += s;
  }
  return total;
}

/** Matching settings in registry order (the layout stays stable while you type). */
export function filterSettings(query: string, list: SettingDef[] = SETTINGS): SettingDef[] {
  return query.trim() ? list.filter((d) => scoreSetting(query, d) > 0) : list;
}

/** Best match first — for "jump to the top hit". */
export function rankSettings(query: string, list: SettingDef[] = SETTINGS): SettingDef[] {
  return list
    .map((d, i) => ({ d, i, s: scoreSetting(query, d) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.d);
}

// ---- keyboard shortcuts ---------------------------------------------------------------------

export interface CommandLike {
  id: string;
  title: string;
  category?: string;
  keys?: string[];
  displayKeys?: string[];
  keywords?: string[];
}

export interface ShortcutRow {
  id: string;
  title: string;
  category: string;
  /** Normalised, de-duplicated bindings ("Alt-Shift-f"). */
  keys: string[];
}

/** Commands that have a key binding, sorted by category then title; filtered by `query` (title, category, keys, keywords). */
export function shortcutRows(commands: CommandLike[], query = '', pretty: (key: string) => string = (k) => k): ShortcutRow[] {
  const qs = tokens(query);
  const rows: ShortcutRow[] = [];
  for (const c of commands) {
    // Same chord spelled twice ("Shift-Alt-f" / "Alt-Shift-f", or "Mod-Tab" / "Ctrl-Tab" off macOS) is listed once.
    const seen = new Set<string>();
    const keys = [...(c.keys ?? []), ...(c.displayKeys ?? [])].map(normalizeKey).filter((k) => !seen.has(pretty(k)) && !!seen.add(pretty(k)));
    if (!keys.length) continue;
    // "Editor: Toggle bold" → category "Editor", title "Toggle bold"
    const m = /^([A-Z][\w &]{1,18}):\s+(.+)$/.exec(c.title);
    const category = c.category ?? m?.[1] ?? 'General';
    const title = m && (!c.category || c.category === m[1]) ? m[2] : c.title;
    if (qs.length) {
      const hay = [c.title, category, ...(c.keywords ?? []), ...keys, ...keys.map(pretty)].join(' | ').toLowerCase();
      const short = c.title.toLowerCase();
      if (!qs.every((q) => hay.includes(q) || loose(q, short))) continue;
    }
    rows.push({ id: c.id, title, category, keys });
  }
  return rows.sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
}
