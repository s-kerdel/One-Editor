// Knowledge implementation chunk: link index, sidebar panels, graph view, daily notes + templates.
// Loaded by ./index.tsx once the app is idle after boot (or on first use); the index then builds in
// idle slices and the graph is a further lazy chunk.
import type { ComponentType } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { stem } from '@shared/paths';
import { app } from '../app/app';
import { registerCommands } from '../app/commands';
import { holdKeys } from '../app/lazy';
import './knowledge.css';
import { BacklinksPanel, OutlinePanel, TagsPanel, openSection } from './panels';
import { building, index, insertTemplate, installIndexing, kv, openDailyNote, openLink, templateFiles, whenIndexed } from './state';
import { searchClient } from '../search/client';
import type { GraphViewProps } from './GraphView';
import { extractor } from './extractor';
import { hoverLink, installLinkPreview, linkPreviewState, type HoverLink } from './link-preview';

export { index as knowledgeIndex } from './state';

// ---------- graph overlay (lazy) ----------

export function openGraph(local: boolean) {
  void searchClient.start(); // the graph is drawn from the index (on demand: this builds it)
  const close = () => {
    app.overlay.value = null;
    app.editor?.focus();
  };
  const Overlay = () => {
    const [View, setView] = useState<ComponentType<GraphViewProps> | null>(null);
    useEffect(() => {
      let alive = true;
      import('./GraphView').then(
        (m) => alive && setView(() => m.default),
        (err) => {
          console.error(err);
          app.toast('Could not load the graph view', 'error');
          close();
        },
      );
      return () => {
        alive = false;
      };
    }, []);
    if (!View) return <div class="se-kn-graph-overlay" />;
    return <View local={local} onClose={close} />;
  };
  app.overlay.value = Overlay;
}

// ---------- template picker ----------

function TemplatePicker() {
  const files = useMemo(templateFiles, []);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const close = () => (app.overlay.value = null);
  const shown = files.filter((f) => stem(f).toLowerCase().includes(q.trim().toLowerCase()));
  const pick = (f: string | undefined) => {
    close();
    if (f) void insertTemplate(f).catch((err) => app.toast(`Template failed: ${err?.message ?? err}`, 'error'));
  };
  return (
    <div class="se-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div class="se-palette se-kn-templates" role="dialog" aria-label="Insert template">
        <input
          ref={input}
          class="se-palette-input"
          placeholder="Insert template…"
          value={q}
          onInput={(e) => {
            setQ((e.target as HTMLInputElement).value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel(Math.min(sel + 1, shown.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel(Math.max(sel - 1, 0));
            } else if (e.key === 'Enter') pick(shown[sel]);
          }}
        />
        <ul class="se-palette-list" role="listbox">
          {shown.map((f, i) => (
            <li class={`se-palette-item${i === sel ? ' selected' : ''}`} role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onMouseDown={() => pick(f)}>
              <span>{stem(f)}</span>
              <span class="se-kn-file-dir">{f}</span>
            </li>
          ))}
          {shown.length === 0 && <li class="se-kn-empty">No matching templates.</li>}
        </ul>
      </div>
    </div>
  );
}

export function openTemplatePicker() {
  if (!app.activePath.value) {
    app.toast('Open a note first to insert a template', 'info');
    return;
  }
  if (!templateFiles().length) {
    const folder = (app.settings.value['templates.folder'] as string) || 'templates';
    app.toast(`No templates found — put Markdown files in a "${folder}/" folder`, 'info', 5000);
    return;
  }
  app.overlay.value = TemplatePicker;
}

export { OutlinePanel, TagsPanel, openDailyNote, openLink, openSection };

function showPanel(id: string) {
  app.sidebarVisible.value = true;
  app.sidebarPanel.value = id;
}

/** Opens the Backlinks panel at one of its sections (unresolved links, orphans, …). */
function showSection(id: string) {
  showPanel('backlinks');
  openSection(id);
  requestAnimationFrame(() => document.querySelector(`.se-kn-backlinks [data-section="${id}"]`)?.scrollIntoView({ block: 'start' }));
}

/** Palette-only commands (no keys): a lazy command source of the startup stub (./index.tsx). */
export function registerKnowledgeCommands() {
  registerCommands([
    { id: 'knowledge.tags', title: 'Open tags', category: 'Notes', keywords: ['hashtag'], run: () => showPanel('tags') },
    { id: 'knowledge.localGraph', title: 'Open local graph (current note)', category: 'Notes', keywords: ['network', 'neighbours'], when: () => !!app.activePath.value, run: () => openGraph(true) },
    { id: 'knowledge.dailyNote', title: "Open today's daily note", category: 'Notes', keywords: ['journal', 'today', 'diary'], when: () => !!app.workspace.value, run: () => void openDailyNote() },
    {
      id: 'knowledge.insertTemplate',
      title: 'Insert template',
      category: 'Notes',
      keywords: ['snippet', 'boilerplate'],
      run: () => {
        holdKeys(Promise.resolve()); // keys typed before the picker's input has focus go into it
        openTemplatePicker();
      },
    },
    { id: 'knowledge.unresolved', title: 'Show unresolved links', category: 'Notes', keywords: ['broken', 'missing', 'dangling'], run: () => showSection('unresolved') },
    { id: 'knowledge.orphans', title: 'Show orphan notes', category: 'Notes', keywords: ['no links', 'isolated', 'unlinked', 'lonely', 'unconnected'], run: () => showSection('orphans') },
    { id: 'knowledge.noIncoming', title: 'Show notes without incoming links', category: 'Notes', keywords: ['no backlinks', 'unreferenced', 'dead ends', 'orphans'], run: () => showSection('noIncoming') },
  ]);
}
export const BacklinksPanelWithGraph = () => <BacklinksPanel onOpenGraph={() => openGraph(true)} />;

let installed = false;

/** One-time wiring, run by the lazy loader right after this chunk arrives. */
export function installKnowledgeImpl() {
  if (installed) return;
  installed = true;
  // Public, feature-detectable API (editor autocomplete, preview, search…): `(app as any).knowledge`.
  // ensure(): consumers that need the index (completion, overview) — builds it when on demand.
  const api = Object.assign(index, {
    whenReady: whenIndexed,
    isBuilding: () => building.value,
    changed: kv,
    openLink,
    extractionMode: () => extractor.mode,
    ensure: () => void searchClient.start(),
    // Link hover preview: the editor reports hovered links here (editor/integration.ts).
    linkPreview: { hover: (link: HoverLink | null, from: string) => hoverLink(link, from, 'editor'), state: linkPreviewState },
  });
  (app as any).knowledge = api;
  app.openLink = openLink;
  installIndexing();
  installLinkPreview();
}
