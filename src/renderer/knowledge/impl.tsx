// Knowledge implementation chunk: link index, sidebar panels, graph view, daily notes + templates.
// Loaded by ./index.tsx once the app is idle after boot (or on first use); the index then builds in
// idle slices and the graph is a further lazy chunk.
import type { ComponentType } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { stem } from '@shared/paths';
import { app } from '../app/app';
import './knowledge.css';
import { BacklinksPanel, OutlinePanel, TagsPanel, openSection } from './panels';
import { building, index, insertTemplate, installIndexing, kv, openDailyNote, openLink, templateFiles, whenIndexed } from './state';
import type { GraphViewProps } from './GraphView';
import { extractor } from './extractor';

export { index as knowledgeIndex } from './state';

// ---------- graph overlay (lazy) ----------

export function openGraph(local: boolean) {
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
export const BacklinksPanelWithGraph = () => <BacklinksPanel onOpenGraph={() => openGraph(true)} />;

let installed = false;

/** One-time wiring, run by the lazy loader right after this chunk arrives. */
export function installKnowledgeImpl() {
  if (installed) return;
  installed = true;
  // Public, feature-detectable API (editor autocomplete, preview, search…): `(app as any).knowledge`.
  const api = Object.assign(index, { whenReady: whenIndexed, isBuilding: () => building.value, changed: kv, openLink, extractionMode: () => extractor.mode });
  (app as any).knowledge = api;
  app.openLink = openLink;
  installIndexing();
}
