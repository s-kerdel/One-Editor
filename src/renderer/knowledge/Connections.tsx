// Connections: the file overview's one place for how the current note is linked — a small local
// graph, incoming links with their line, outgoing links (missing ones can be created), unlinked
// mentions (Link / Link all), shared tags and related notes. Lazy chunk, loaded by the overview.
// Everything reads adjacency the knowledge index keeps patched: a note switch costs O(neighbourhood).
import { Fragment, type ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { basename, dirname, isMarkdown, normalize, stem } from '@shared/paths';
import { resolveWikiTarget } from '@shared/wikilinks';
import { app } from '../app/app';
import { addIcons, FileIcon, Icon } from '../app/icons';
import { runCommand } from '../app/commands';
import { indexDeferred } from '../search/demand';
import { searchClient } from '../search/client';
import { collapsedSections, setSectionCollapsed, useRoving } from '../overview/hooks';
import { jumpTo } from '../overview/actions';
import { Hint, Section } from '../overview/parts';
import type { GraphNode } from '../../knowledge/graph';
import type { LinkRef, Mention, NoteInfo } from '../../knowledge/index';
import { localGraph, notesSharingTag, relatedNotes, sharedTags } from '../../knowledge/connections';
import { index, indexBusy, kv, linkMention, linkMentions, openLink, unlinkedMentionsOf } from './state';
import { GraphRenderer } from './graph-canvas';
import './connections.css';

addIcons({
  'cn-graph': 'M8.5 6a2.5 2.5 0 1 1-5 0a2.5 2.5 0 1 1 5 0|M20.5 8a2.5 2.5 0 1 1-5 0a2.5 2.5 0 1 1 5 0|M11.5 18a2.5 2.5 0 1 1-5 0a2.5 2.5 0 1 1 5 0|M8.3 7 15.6 7.7|M6.7 8.4 8.4 15.6|M16.6 10.1 10.6 16.2',
});

// A note linked from thousands of places stays a short list (the Backlinks panel has them all).
const MAX_BACK = 100;
const MAX_OUT = 200;
const MAX_MENTIONS = 100;
const GRAPH_CAP = { 1: 40, 2: 70 } as const;

/** Cost of each render → commit and graph layout (ms): the E2E perf guard reads the last ones. */
export const connectionsPerf = { render: [] as number[], graph: [] as number[] };
const record = (list: number[], ms: number) => {
  list.push(ms);
  if (list.length > 60) list.shift();
};
(globalThis as { __secEditConnectionsPerf?: typeof connectionsPerf }).__secEditConnectionsPerf = connectionsPerf;

const DEPTH_KEY = 'sec-edit-connections-depth';
const graphDepth = signal<1 | 2>(
  (() => {
    try {
      return localStorage.getItem(DEPTH_KEY) === '2' ? 2 : 1;
    } catch {
      return 1;
    }
  })(),
);
function setDepth(d: 1 | 2) {
  graphDepth.value = d;
  try {
    localStorage.setItem(DEPTH_KEY, String(d));
  } catch {
    /* session only */
  }
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
const nameOf = (p: string) => (isMarkdown(p) ? stem(p) : basename(p));

function indexingText() {
  const p = searchClient.progress.value;
  return p && p.total ? `Indexing… ${p.done.toLocaleString()} / ${p.total.toLocaleString()}` : 'Indexing…';
}

// ---------------------------------------------------------------- building blocks

/** A collapsible sub-section; open/closed is remembered with the overview's sections. */
function Sub(props: { id: string; title: string; count?: number | string | null; countTitle?: string; actions?: ComponentChildren; children: ComponentChildren }) {
  const open = !collapsedSections.value[props.id];
  return (
    <div class={`se-cn-sub${open ? ' open' : ''}`} data-sub={props.id}>
      <div class="se-cn-head">
        <button class="se-cn-toggle" aria-expanded={open} onClick={() => setSectionCollapsed(props.id, open)}>
          <Icon name="chevronRight" size={11} class="se-cn-chev" />
          <span class="se-cn-title">{props.title}</span>
          {props.count != null && (
            <span class="se-cn-n" title={props.countTitle}>
              {props.count}
            </span>
          )}
        </button>
        {open && props.actions}
      </div>
      {open && props.children}
    </div>
  );
}

function List({ label, children }: { label: string; children: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  const roving = useRoving(ref);
  return (
    <div class="se-ov-list" ref={ref} role="list" aria-label={label} onKeyDown={roving.onKeyDown} onFocusIn={roving.onFocusIn}>
      {children}
    </div>
  );
}

function Ctx({ s }: { s: { text: string; start: number; end: number } }) {
  return (
    <span class="se-ov-ctx">
      {s.text.slice(0, s.start)}
      <mark>{s.text.slice(s.start, s.end)}</mark>
      {s.text.slice(s.end)}
    </span>
  );
}

// ---------------------------------------------------------------- outgoing

interface OutRow {
  key: string;
  path: string | null;
  label: string;
  /** What to follow: `target#heading` for wiki links. */
  follow: string;
  wiki: boolean;
  count: number;
  line: number;
  col: number;
}

function outRows(self: string, links: Iterable<{ link: LinkRef; path: string | null }>): OutRow[] {
  const seen = new Map<string, OutRow>();
  for (const { link, path } of links) {
    if (path === self || (link.embed && path && !isMarkdown(path))) continue; // in-note anchors, embedded images
    const key = path ?? `?${link.target.toLowerCase()}`;
    const hit = seen.get(key);
    if (hit) {
      hit.count++;
      continue;
    }
    const anchor = link.block ? `#^${link.block}` : link.heading ? `#${link.heading}` : '';
    seen.set(key, { key, path, label: path ? nameOf(path) : link.target, follow: `${link.target}${anchor}`, wiki: link.kind === 'wiki', count: 1, line: link.line, col: link.col });
  }
  // Resolved first (where you'd navigate), then the ones still to be written.
  return [...seen.values()].sort((a, b) => Number(!a.path) - Number(!b.path));
}

/** Without the index (on demand, not built): resolve the note's own links against the file list. */
function resolveCheap(self: string, l: LinkRef, files: readonly string[], set: ReadonlySet<string>): string | null {
  if (l.kind === 'wiki') return l.target ? resolveWikiTarget(l.target, files, self) : self;
  const p = l.target.startsWith('/') ? normalize(l.target) : normalize(`${dirname(self)}/${l.target}`);
  return set.has(p) ? p : set.has(`${p}.md`) ? `${p}.md` : null;
}

function OutgoingRows({ path, rows }: { path: string; rows: OutRow[] }) {
  const follow = (o: OutRow) => {
    if (o.wiki) void (app.openLink ?? openLink)(o.follow, path);
    else if (o.path) void app.openFile(o.path);
    else jumpTo(path, o.line, o.col); // a broken file link: show where it is
  };
  if (!rows.length) return <Hint>This note doesn’t link anywhere yet.</Hint>;
  return (
    <List label="Links to">
      {rows.slice(0, MAX_OUT).map((o) => (
        <div
          key={o.key}
          class={`se-ov-row se-ov-link${o.path ? '' : ' unresolved'}`}
          role="listitem"
          tabIndex={-1}
          data-row
          data-key={`o${o.key}`}
          title={o.path ? `${o.path}${o.count > 1 ? ` · linked ${o.count}×` : ''}` : o.wiki ? `“${o.label}” doesn’t exist yet — click to create it` : `${o.label} not found — click to show the link`}
          onClick={() => follow(o)}
        >
          <span class="se-ov-ico">{o.path ? <FileIcon path={o.path} size={14} /> : <Icon name="filePlus" size={14} />}</span>
          <span class="se-ov-text">{o.label}</span>
          {o.count > 1 && <span class="se-ov-meta">{o.count}×</span>}
          {!o.path && o.wiki && (
            <button
              class="se-cn-btn se-cn-create"
              tabIndex={-1}
              title={`Create “${o.label}” next to this note`}
              onClick={(e) => {
                e.stopPropagation();
                follow(o);
              }}
            >
              Create
            </button>
          )}
          <button
            class="se-ov-mini"
            tabIndex={-1}
            title={`Show the link in this note (line ${o.line + 1})`}
            aria-label="Show the link in this note"
            onClick={(e) => {
              e.stopPropagation();
              jumpTo(path, o.line, o.col);
            }}
          >
            L{o.line + 1}
          </button>
        </div>
      ))}
      {rows.length > MAX_OUT && <Hint>{(rows.length - MAX_OUT).toLocaleString()} more links — the graph shows them all.</Hint>}
    </List>
  );
}

// ---------------------------------------------------------------- local graph

function MiniGraph({ path, version }: { path: string; version: number }) {
  const depth = graphDepth.value;
  const data = useMemo(() => localGraph(index, path, depth, GRAPH_CAP[depth]), [path, version, depth]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<GraphRenderer | null>(null);
  const [hover, setHover] = useState<GraphNode | null>(null);
  useEffect(() => {
    const r = new GraphRenderer(canvas.current!, (n) => n.id !== app.activePath.value && void app.openFile(n.id), setHover, { wheelZoom: 'mod', settleMs: 6, fitPad: 18, maxFit: 1.3 });
    renderer.current = r;
    (canvas.current as unknown as { __graph: GraphRenderer }).__graph = r;
    return () => r.dispose();
  }, []);
  // After paint: the switch itself stays a plain list render.
  useEffect(() => {
    const t0 = performance.now();
    renderer.current?.setData(data, path);
    record(connectionsPerf.graph, performance.now() - t0);
  }, [data]);
  const lonely = data.nodes.length <= 1;
  return (
    <div class={`se-cn-graph${lonely ? ' is-empty' : ''}`} data-nodes={data.nodes.length}>
      <canvas ref={canvas} class="se-cn-canvas" aria-label={`Local graph: ${data.nodes.length - 1} linked notes`} />
      {lonely ? (
        <div class="se-cn-graph-empty">No links yet</div>
      ) : (
        <div class="se-cn-graph-hint">{hover ? hover.label : `${plural(data.nodes.length - 1, 'note')} · ${plural(data.edges.length / 2, 'link')}`}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- mentions

function useMentions(path: string, enabled: boolean, version: number) {
  const [state, setState] = useState<{ path: string; list: Mention[] } | null>(null);
  const same = state?.path === path;
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    // Scans every note's text (in the search workers): never on the keystroke path.
    const t = setTimeout(
      () =>
        void unlinkedMentionsOf(path).then(
          (list) => live && setState({ path, list }),
          () => live && setState({ path, list: [] }),
        ),
      same ? 500 : 0,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [path, enabled, version]);
  const drop = (gone: readonly Mention[]) => setState((s) => (s && s.path === path ? { path, list: s.list.filter((m) => !gone.includes(m)) } : s));
  return { list: same ? state!.list : null, drop };
}

function MentionRows({ path, list, drop }: { path: string; list: Mention[]; drop: (m: Mention[]) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <List label="Unlinked mentions">
      {list.slice(0, MAX_MENTIONS).map((m) => (
        <div
          key={`${m.from}:${m.line}:${m.col}`}
          class="se-ov-row se-cn-mention"
          role="listitem"
          tabIndex={-1}
          data-row
          data-key={`m${m.from}:${m.line}:${m.col}`}
          title={`${m.from} — line ${m.line + 1}\n${m.context.text}`}
          onClick={() => void app.openFile(m.from, { line: m.line, col: m.col, length: m.length })}
        >
          <span class="se-ov-ico">
            <FileIcon path={m.from} size={14} />
          </span>
          <span class="se-ov-name">{nameOf(m.from)}</span>
          <Ctx s={m.context} />
          <button
            class="se-cn-btn se-cn-link"
            disabled={busy}
            tabIndex={-1}
            title={`Turn this mention into a [[${stem(path)}]] link`}
            onClick={(e) => {
              e.stopPropagation();
              setBusy(true);
              void linkMention(path, m)
                .then((ok) => ok && drop([m]))
                .finally(() => setBusy(false));
            }}
          >
            Link
          </button>
        </div>
      ))}
      {list.length > MAX_MENTIONS && <Hint>{(list.length - MAX_MENTIONS).toLocaleString()} more — the Backlinks panel lists them all.</Hint>}
    </List>
  );
}

// ---------------------------------------------------------------- tags + related

function TagRows({ path, tags, known }: { path: string; tags: Array<{ tag: string; count: number }>; known: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const shown = open && known ? notesSharingTag(index, path, open) : [];
  return (
    <List label="Shared tags">
      {tags.map((t) => (
        <Fragment key={t.tag}>
          <div
            class={`se-ov-row se-cn-tag${open === t.tag ? ' is-open' : ''}`}
            role="listitem"
            tabIndex={-1}
            data-row
            data-key={`t${t.tag}`}
            data-tag={t.tag}
            title={known ? `${t.count} other note${t.count === 1 ? '' : 's'} tagged #${t.tag}` : `#${t.tag}`}
            onClick={() => (known && t.count > 0 ? setOpen(open === t.tag ? null : t.tag) : app.openSearch?.(`tag:${t.tag}`))}
          >
            <span class="se-cn-pill">#{t.tag}</span>
            <span class="se-ov-text" />
            {known && <span class="se-ov-meta">{t.count === 0 ? 'only here' : `${t.count} note${t.count === 1 ? '' : 's'}`}</span>}
            {app.openSearch && (
              <button
                class="se-ov-mini"
                tabIndex={-1}
                title={`Search tag:${t.tag}`}
                aria-label={`Search tag:${t.tag}`}
                onClick={(e) => {
                  e.stopPropagation();
                  app.openSearch?.(`tag:${t.tag}`);
                }}
              >
                <Icon name="search" size={11} />
              </button>
            )}
          </div>
          {open === t.tag &&
            shown.map((p) => (
              <div key={`${t.tag}:${p}`} class="se-ov-row se-cn-tagnote" role="listitem" tabIndex={-1} data-row data-key={`t${t.tag}:${p}`} title={p} style={{ '--d': 1 }} onClick={() => void app.openFile(p)}>
                <span class="se-ov-ico">
                  <FileIcon path={p} size={14} />
                </span>
                <span class="se-ov-text">{nameOf(p)}</span>
              </div>
            ))}
        </Fragment>
      ))}
    </List>
  );
}

function reasonOf(r: { links: number; tags: string[] }): string {
  const parts: string[] = [];
  if (r.links) parts.push(`${r.links} shared link${r.links === 1 ? '' : 's'}`);
  if (r.tags.length) parts.push(r.tags.map((t) => `#${t}`).join(' '));
  return parts.join(' · ');
}

// ---------------------------------------------------------------- the section

export interface ConnectionsProps {
  path: string;
  /** The note's metadata from its live text (links, tags): what is shown without the index. Read
   *  only then — extracting a 1 MB note is not free. */
  live: { readonly note: NoteInfo } | null;
}

export function Connections({ path, live }: ConnectionsProps) {
  const t0 = performance.now();
  const version = kv.value;
  const deferred = indexDeferred.value;
  const isBuilding = indexBusy.value;
  const collapsed = collapsedSections.value;
  const files = app.files.value;
  const info = deferred ? undefined : index.note(path);
  const known = !!info;

  const fileSet = useMemo(() => (known ? null : new Set(files)), [files, known]);
  const out = useMemo(() => {
    if (info) return outRows(path, index.outgoing(path));
    const links = live?.note.links ?? [];
    return outRows(
      path,
      links.map((link) => ({ link, path: deferred ? resolveCheap(path, link, files, fileSet!) : link.kind === 'wiki' ? index.resolve(link.target, path) : resolveCheap(path, link, files, fileSet!) })),
    );
  }, [path, version, info, live, deferred, files]);
  const back = useMemo(() => {
    if (deferred) return [];
    const groups = new Map<string, ReturnType<typeof index.backlinks>>();
    for (const b of index.backlinks(path)) {
      const g = groups.get(b.from);
      if (g) g.push(b);
      else groups.set(b.from, [b]);
    }
    return [...groups];
  }, [path, version, deferred]);
  const related = useMemo(() => (known ? relatedNotes(index, path) : []), [path, version, known]);
  const tags = useMemo(() => (known ? sharedTags(index, path) : (live?.note.tags ?? []).map((tag) => ({ tag, count: 0 }))), [path, version, known, live]);
  const mentions = useMentions(path, !deferred && !collapsed['cn-mentions'], version);

  useLayoutEffect(() => record(connectionsPerf.render, performance.now() - t0));

  const backCount = back.reduce((n, [, items]) => n + items.length, 0);
  const missing = out.filter((o) => !o.path).length;
  const neighbours = new Set<string>();
  for (const o of out) if (o.path && isMarkdown(o.path)) neighbours.add(o.path);
  for (const [from] of back) neighbours.add(from);

  const graphActions = (
    <div class="se-cn-actions">
      <div class="se-ov-levels" role="group" aria-label="Graph depth">
        {([1, 2] as const).map((d) => (
          <button class={`se-ov-lvl-btn${graphDepth.value === d ? ' on' : ''}`} aria-pressed={graphDepth.value === d} title={d === 1 ? 'Direct links only' : 'Links of links too'} onClick={() => setDepth(d)}>
            {d}
          </button>
        ))}
      </div>
      <button class="se-cn-icon" title="Open the local graph (bigger)" aria-label="Open the local graph" onClick={() => void runCommand('knowledge.localGraph')}>
        <Icon name="cn-graph" size={13} />
      </button>
    </div>
  );

  const outgoing = (
    <Sub id="cn-out" title="Links to" count={out.length} countTitle={missing ? `${missing} not created yet` : undefined}>
      <OutgoingRows path={path} rows={out} />
    </Sub>
  );

  if (deferred)
    return (
      <Section id="connections" title="Connections" count={null}>
        {outgoing}
        {tags.length > 0 && (
          <Sub id="cn-tags" title="Tags" count={tags.length}>
            <TagRows path={path} tags={tags} known={false} />
          </Sub>
        )}
        <Hint>
          Backlinks, mentions, related notes and the graph come from the search index, built on demand.{' '}
          <button class="se-ov-lvl-btn se-cn-build" onClick={() => void searchClient.start()}>
            Build now
          </button>
        </Hint>
      </Section>
    );

  const mentionList = mentions.list;
  return (
    <Section id="connections" title="Connections" count={neighbours.size} countTitle={`${backCount} incoming · ${out.length} outgoing${missing ? ` (${missing} not created yet)` : ''}`}>
      <Sub id="cn-graph" title="Local graph" actions={graphActions}>
        <MiniGraph path={path} version={version} />
      </Sub>
      <Sub id="cn-in" title="Linked from" count={backCount}>
        {back.length === 0 ? (
          <Hint>{isBuilding ? indexingText() : 'No notes link here yet.'}</Hint>
        ) : (
          <List label="Linked from">
            {back.slice(0, MAX_BACK).map(([from, items]) =>
              items.slice(0, 20).map((b, j) => (
                <div
                  key={`${from}:${b.line}:${b.col}`}
                  class={`se-ov-row se-ov-back${j ? ' cont' : ''}`}
                  role="listitem"
                  tabIndex={-1}
                  data-row
                  data-key={`b${from}:${b.line}:${b.col}`}
                  title={`${from} — line ${b.line + 1}\n${b.context.text}`}
                  onClick={() => void app.openFile(from, { line: b.line, col: b.col, length: b.length })}
                >
                  <span class="se-ov-ico">{j === 0 ? <FileIcon path={from} size={14} /> : null}</span>
                  {j === 0 && <span class="se-ov-name">{nameOf(from)}</span>}
                  <Ctx s={b.context} />
                </div>
              )),
            )}
            {back.length > MAX_BACK && <Hint>{(back.length - MAX_BACK).toLocaleString()} more notes link here — the Backlinks panel lists them all.</Hint>}
          </List>
        )}
      </Sub>
      {outgoing}
      <Sub
        id="cn-mentions"
        title="Unlinked mentions"
        count={collapsed['cn-mentions'] ? null : mentionList ? mentionList.length : '…'}
        actions={
          mentionList && mentionList.length > 1 ? (
            <button
              class="se-cn-btn se-cn-linkall"
              title={`Turn all ${mentionList.length} mentions into [[${stem(path)}]] links`}
              onClick={() => {
                const all = mentionList.slice();
                mentions.drop(all);
                void linkMentions(path, all);
              }}
            >
              Link all
            </button>
          ) : null
        }
      >
        {!mentionList ? (
          <Hint>{isBuilding ? indexingText() : 'Searching…'}</Hint>
        ) : mentionList.length === 0 ? (
          <Hint>No plain-text mentions of “{stem(path)}”.</Hint>
        ) : (
          <MentionRows path={path} list={mentionList} drop={mentions.drop} />
        )}
      </Sub>
      {tags.length > 0 && (
        <Sub id="cn-tags" title="Shared tags" count={tags.length}>
          <TagRows path={path} tags={tags} known />
        </Sub>
      )}
      <Sub id="cn-related" title="Related" count={related.length} countTitle="Notes that link to the same notes, are linked from the same notes or share tags">
        {related.length === 0 ? (
          <Hint>{isBuilding ? indexingText() : 'Nothing related yet — notes that cite the same notes or share tags show up here.'}</Hint>
        ) : (
          <List label="Related notes">
            {related.map((r) => (
              <div key={r.path} class="se-ov-row se-cn-rel" role="listitem" tabIndex={-1} data-row data-key={`r${r.path}`} title={`${r.path}\n${reasonOf(r)}`} onClick={() => void app.openFile(r.path)}>
                <span class="se-ov-ico">
                  <FileIcon path={r.path} size={14} />
                </span>
                <span class="se-ov-name">{nameOf(r.path)}</span>
                <span class="se-ov-ctx">{reasonOf(r)}</span>
              </div>
            ))}
          </List>
        )}
      </Sub>
    </Section>
  );
}

export default Connections;
