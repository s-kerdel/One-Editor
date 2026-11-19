// Knowledge module entry — startup stub. Registers panels, commands and key bindings right away;
// the implementation (index, panels, link actions: ./impl) loads once the app is idle after boot,
// or earlier when a panel/command/link needs it.
import { app } from '../app/app';
import { registerCommands } from '../app/commands';
import { afterBootIdle, lazy, lazyComponent, withModule } from '../app/lazy';
import { ICON_BACKLINKS, ICON_OUTLINE, ICON_TAGS } from './panel-icons';

type Impl = typeof import('./impl');
const impl = lazy<Impl>(() =>
  import('./impl').then((m) => {
    m.installKnowledgeImpl();
    return m;
  }),
);

/** Loads the knowledge implementation (idempotent); `(app as any).knowledge` exists afterwards. */
export const loadKnowledge = () => impl.load();

function showPanel(id: string) {
  app.sidebarVisible.value = true;
  app.sidebarPanel.value = id; // the panel component pulls the chunk itself
}

export function installKnowledge() {
  // Until the chunk arrives, following a link waits for it (replaced by the real one on load).
  app.openLink = async (target, from, opts) => (await impl.load()).openLink(target, from, opts);

  const panel = (pick: (m: Impl) => Impl['OutlinePanel']) => lazyComponent(() => impl.load().then(pick));
  app.registerPanel({ id: 'outline', title: 'Outline', icon: ICON_OUTLINE, order: 30, component: panel((m) => m.OutlinePanel) });
  app.registerPanel({ id: 'backlinks', title: 'Backlinks', icon: ICON_BACKLINKS, order: 31, component: panel((m) => m.BacklinksPanelWithGraph) });
  app.registerPanel({ id: 'tags', title: 'Tags', icon: ICON_TAGS, order: 32, component: panel((m) => m.TagsPanel) });

  registerCommands([
    { id: 'knowledge.outline', title: 'Open outline', category: 'Notes', keys: ['Mod-Alt-o'], keywords: ['headings', 'toc', 'table of contents'], run: () => showPanel('outline') },
    { id: 'knowledge.backlinks', title: 'Open backlinks', category: 'Notes', keys: ['Mod-Alt-l'], keywords: ['links', 'mentions', 'references'], run: () => showPanel('backlinks') },
    { id: 'knowledge.tags', title: 'Open tags', category: 'Notes', keywords: ['hashtag'], run: () => showPanel('tags') },
    { id: 'knowledge.graph', title: 'Open graph view', category: 'Notes', keys: ['Mod-Alt-g'], keywords: ['network', 'map', 'links'], run: () => withModule(impl, (m) => m.openGraph(false)) },
    { id: 'knowledge.localGraph', title: 'Open local graph (current note)', category: 'Notes', keywords: ['network', 'neighbours'], when: () => !!app.activePath.value, run: () => withModule(impl, (m) => m.openGraph(true)) },
    { id: 'knowledge.dailyNote', title: "Open today's daily note", category: 'Notes', keywords: ['journal', 'today', 'diary'], when: () => !!app.workspace.value, run: () => withModule(impl, (m) => void m.openDailyNote()) },
    { id: 'knowledge.insertTemplate', title: 'Insert template', category: 'Notes', keywords: ['snippet', 'boilerplate'], run: () => withModule(impl, (m) => m.openTemplatePicker(), { typeahead: true }) },
    {
      id: 'knowledge.unresolved',
      title: 'Show unresolved links',
      category: 'Notes',
      keywords: ['broken', 'missing', 'dangling'],
      run: () =>
        withModule(impl, (m) => {
          showPanel('backlinks');
          m.openSection('unresolved');
          requestAnimationFrame(() => document.querySelector('[data-section="unresolved"]')?.scrollIntoView({ block: 'start' }));
        }),
    },
  ]);

  // Never on the launch path: the index is only needed once the user starts navigating.
  afterBootIdle(() => void impl.load().catch((err) => console.warn('[knowledge] failed to load', err)));
}
