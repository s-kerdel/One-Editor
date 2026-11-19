// Search module entry — startup stub. Registers the panel, commands and key bindings right away
// but keeps the implementation (panel UI, palette, worker client: ./impl) out of the launch path:
// it loads on first use, or once the app is idle after boot. Public API for other modules:
//   openSearch('tag:foo')            — open the panel with a query (also app.openSearch?.(q))
//   runCommand('search.query')       — hidden command; uses the editor selection
import { app } from '../app/app';
import { registerCommands } from '../app/commands';
import { afterBootIdle, lazy, lazyComponent, withModule } from '../app/lazy';
import { renameRecentFile, touchRecentFile } from './recent';

type Impl = typeof import('./impl');
const impl = lazy<Impl>(() =>
  import('./impl').then((m) => {
    m.installSearchImpl();
    return m;
  }),
);

/** Loads the search implementation (idempotent). */
export const loadSearch = () => impl.load();

/** Open the search panel with `q` and run it immediately. */
export function openSearch(q: string, opts: { replace?: boolean; regex?: boolean } = {}) {
  return withModule(impl, (m) => m.openSearch(q, opts));
}

/** Open the omnibox: '' files · '>' commands · '@' headings in file · '#' headings in workspace · ':' line. */
export function openPalette(initial = '') {
  return withModule(impl, (m) => m.openPalette(initial), { typeahead: true });
}

export function installSearch() {
  app.registerPanel({ id: 'search', title: 'Search', icon: 'search', order: 10, component: lazyComponent(() => impl.load().then((m) => m.SearchPanel)) });
  app.openSearch = (q, opts) => void openSearch(q, opts);

  // MRU for quick open (tracked from the first tab on, long before the palette chunk exists).
  app.events.on('active:changed', (p) => p && touchRecentFile(p));
  app.events.on('file:renamed', (from, to) => renameRecentFile(from, to));

  // Never on the launch path: fetch the chunk and build the index (in a worker) once idle after boot.
  afterBootIdle(() => void impl.load().then((m) => m.searchClient.start()).catch((err) => console.warn('[search] failed to load', err)), 2500);

  const palette = (prefix: string) => () => openPalette(prefix);
  const focus = (replace: boolean) => () => withModule(impl, (m) => m.focusSearch(replace), { typeahead: true });
  registerCommands([
    { id: 'palette.commands', title: 'Show all commands', category: 'View', keys: ['Mod-Shift-p', 'F1'], keywords: ['command palette', 'actions'], run: palette('>') },
    { id: 'palette.files', title: 'Go to file…', category: 'Go', keys: ['Mod-p', 'Mod-o'], keywords: ['quick open', 'open file', 'switcher'], run: palette('') },
    { id: 'search.gotoHeading', title: 'Go to heading / symbol in file…', category: 'Go', keys: ['Mod-Shift-o'], keywords: ['outline', 'symbol', 'toc'], run: palette('@') },
    { id: 'search.gotoWorkspaceHeading', title: 'Go to heading in workspace…', category: 'Go', keys: ['Mod-t'], keywords: ['symbol', 'section', 'title'], run: palette('#') },
    { id: 'search.gotoLine', title: 'Go to line…', category: 'Go', keywords: ['line number', 'jump'], when: () => !!app.activePath.value, run: palette(':') },
    { id: 'search.findInFiles', title: 'Find in files', category: 'Search', keys: ['Mod-Shift-f'], keywords: ['search', 'grep', 'full text'], run: focus(false) },
    { id: 'search.replaceInFiles', title: 'Replace in files', category: 'Search', keys: ['Mod-Shift-h'], keywords: ['substitute', 'rename text'], run: focus(true) },
    { id: 'search.nextResult', title: 'Next search result', category: 'Search', keys: ['F4'], run: () => withModule(impl, (m) => m.stepResult(1)) },
    { id: 'search.prevResult', title: 'Previous search result', category: 'Search', keys: ['Shift-F4'], run: () => withModule(impl, (m) => m.stepResult(-1)) },
    { id: 'search.reindex', title: 'Rebuild search index', category: 'Search', keywords: ['refresh', 'reindex'], run: () => withModule(impl, (m) => m.reindex()) },
    // Hidden API: runCommand('search.query') searches for the selection; openSearch(q) for anything else.
    { id: 'search.query', title: 'Search for…', category: 'Search', hidden: true, run: (q?: unknown) => withModule(impl, (m) => m.openSearch(typeof q === 'string' ? q : m.editorSelection())) },
  ]);
}
