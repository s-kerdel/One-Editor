// Graph view: canvas renderer + force simulation (lazy-loaded; nothing here runs at startup).
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { stem } from '@shared/paths';
import { app } from '../app/app';
import { buildGraph, type GraphNode } from '../../knowledge/graph';
import { GraphRenderer } from './graph-canvas';
import { building, index, kv, openLink } from './state';
import { IconClose } from './icons';

export interface GraphViewProps {
  local?: boolean;
  onClose: () => void;
}

export default function GraphView({ local: startLocal, onClose }: GraphViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<GraphRenderer | null>(null);
  const active = app.activePath.value;
  const [local, setLocal] = useState(!!startLocal && !!active);
  const [depth, setDepth] = useState(2);
  const [showTags, setShowTags] = useState(false);
  const [showOrphans, setShowOrphans] = useState(true);
  const [showUnresolved, setShowUnresolved] = useState(false);
  const [filter, setFilter] = useState('');
  const [hovered, setHovered] = useState<GraphNode | null>(null);
  const version = kv.value;

  const data = useMemo(
    () => buildGraph(index, { showTags, showOrphans, showUnresolved, filter, local: local && active ? { path: active, depth } : null }),
    [version, showTags, showOrphans, showUnresolved, filter, local, depth, local ? active : null],
  );

  useEffect(() => {
    const r = new GraphRenderer(
      canvasRef.current!,
      (node, e) => {
        if (node.kind === 'tag') {
          setFilter(`tag:${node.id.slice(1)}`);
          return;
        }
        if (node.kind === 'unresolved') void openLink(node.label, app.activePath.value ?? '');
        else void app.openFile(node.id);
        // Ctrl/Cmd-click keeps the graph open to keep exploring.
        if (!(e.ctrlKey || e.metaKey)) onClose();
      },
      setHovered,
    );
    renderer.current = r;
    (canvasRef.current as any).__graph = r;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      r.dispose();
    };
  }, []);

  useEffect(() => {
    renderer.current?.setData(data, active);
  }, [data]);
  useEffect(() => {
    renderer.current?.setActive(active);
  }, [active]);

  const notes = data.nodes.filter((n) => n.kind === 'note').length;
  const toggle = (label: string, value: boolean, set: (v: boolean) => void, title: string) => (
    <label class={`se-kn-g-toggle${value ? ' on' : ''}`} title={title}>
      <input type="checkbox" checked={value} onChange={(e) => set((e.target as HTMLInputElement).checked)} />
      {label}
    </label>
  );

  return (
    <div class="se-kn-graph-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div class="se-kn-graph" role="dialog" aria-label="Graph view">
        <div class="se-kn-g-bar">
          <div class="se-kn-seg" role="tablist">
            <button class={local ? '' : 'on'} role="tab" aria-selected={!local} onClick={() => setLocal(false)}>
              Global
            </button>
            <button class={local ? 'on' : ''} role="tab" aria-selected={local} disabled={!active} title={active ? `Notes around ${stem(active)}` : 'Open a note first'} onClick={() => setLocal(true)}>
              Local
            </button>
          </div>
          {local && (
            <div class="se-kn-seg" title="How many links away from the current note">
              {[1, 2, 3].map((d) => (
                <button class={depth === d ? 'on' : ''} onClick={() => setDepth(d)} aria-label={`Depth ${d}`}>
                  {d}
                </button>
              ))}
            </div>
          )}
          <input class="se-kn-filter se-kn-g-filter" type="search" placeholder="Filter: name or tag:project" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
          {toggle('Tags', showTags, setShowTags, 'Show tags as nodes')}
          {toggle('Orphans', showOrphans, setShowOrphans, 'Show notes without any links')}
          {toggle('Unresolved', showUnresolved, setShowUnresolved, 'Show links to notes that do not exist yet')}
          <span class="se-kn-spacer" />
          <button class="se-kn-btn text" title="Fit to view (or double-click the background)" onClick={() => renderer.current?.fit(true)}>
            Fit
          </button>
          <button class="se-kn-btn" title="Close (Esc)" aria-label="Close graph" onClick={onClose}>
            <IconClose />
          </button>
        </div>
        <div class="se-kn-g-body">
          <canvas ref={canvasRef} class="se-kn-g-canvas" />
          {data.nodes.length === 0 && (
            <div class="se-kn-g-empty">{building.value ? 'Indexing notes…' : local ? 'This note has no links yet.' : filter ? 'Nothing matches this filter.' : 'No notes to show.'}</div>
          )}
          <div class="se-kn-g-legend">
            <span>
              <i class="dot note" /> {notes} note{notes === 1 ? '' : 's'}
            </span>
            <span>{data.edges.length / 2} links</span>
            {showTags && (
              <span>
                <i class="dot tag" /> tags
              </span>
            )}
            {showUnresolved && (
              <span>
                <i class="dot unresolved" /> unresolved
              </span>
            )}
            {active && (
              <span>
                <i class="dot active" /> current
              </span>
            )}
          </div>
          <div class="se-kn-g-hint">{hovered ? (hovered.kind === 'note' || hovered.kind === 'file' ? hovered.id : hovered.label) : 'Scroll to zoom · drag to pan · click a note to open'}</div>
        </div>
      </div>
    </div>
  );
}
