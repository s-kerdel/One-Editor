// Connections: the file overview's one place for how the current note is linked — a small local
// graph, incoming links with their line, outgoing links (missing ones can be created), unlinked
// mentions (Link / Link all), shared tags and related notes. Lazy chunk, loaded by the overview.
// Everything reads adjacency the knowledge index keeps patched: a note switch costs O(neighbourhood).
// Collapsed (its default) it computes only the header count: no lists, graph, related notes or mention scan.
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
import { useRoving } from '../overview/hooks';
import { isSectionOpen, setSectionCollapsed } from '../overview/sections';
import { jumpTo } from '../overview/actions';
import { Count, Hint, Section, type HeaderCount } from '../overview/parts';
import type { GraphData, GraphNode } from '../../knowledge/graph';
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
/** The mention scan stops here; the count then reads "500+". */
const MENTION_SCAN = 500;
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

/** A collapsible sub-section, same rule as the overview's sections: starts open when it has
 *  entries (`null` = not counted yet: closed), until the user toggles it (remembered). */
function Sub(props: { id: string; title: string; count: HeaderCount; countTitle?: string; actions?: ComponentChildren; children: ComponentChildren }) {
  const n = props.count;
  const open = isSectionOpen(props.id, n !== null && n !== 0);
  return (
    <div class={`se-cn-sub${open ? ' open' : ''}`} data-sub={props.id}>
      <div class="se-cn-head">
        <button class="se-cn-toggle" aria-expanded={open} onClick={() => setSectionCollapsed(props.id, open)}>
          <Icon name="chevronRight" size={11} class="se-cn-chev" />
          <span class="se-cn-title">{props.title}</span>
          <Count n={n} title={props.countTitle} class="se-cn-n" />
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
          title={o.path ? `${o.path}${o.count > 1 ? ` · linked ${o.count}×` : ''}` : o.wiki ? `“${o.label}” doesn’t exist yet. Click to create it` : `${o.label} not found. Click to show the link`}
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
      {rows.length > MAX_OUT && <Hint>{(rows.length - MAX_OUT).toLocaleString()} more links: the graph shows them all.</Hint>}
    </List>
  );
}

// ---------------------------------------------------------------- local graph

function MiniGraph({ path, data }: { path: string; data: GraphData }) {
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
  const [state, setState] = useState<{ path: string; list: Mention[]; seq: number } | null>(null);
  const seq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);
  const same = state?.path === path;
  useEffect(() => {
    if (!enabled) return;
    // Scans every note's text (in the search workers): never on the keystroke path.
    const t = setTimeout(() => {
      const mine = ++seq.current;
      // An index bump restarts the scan, but an older answer still lands until a newer one has:
      // the count shows as soon as one scan finishes.
      const land = (list: Mention[]) => mounted.current && setState((s) => (s && s.seq > mine ? s : { path, list, seq: mine }));
      void unlinkedMentionsOf(path, MENTION_SCAN).then(land, () => land([]));
    }, same ? 500 : 0);
    return () => clearTimeout(t);
  }, [path, enabled, version]);
  const drop = (gone: readonly Mention[]) => setState((s) => (s && s.path === path ? { ...s, list: s.list.filter((m) => !gone.includes(m)) } : s));
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
          title={`${m.from} · line ${m.line + 1}\n${m.context.text}`}
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
      {list.length > MAX_MENTIONS && <Hint>{(list.length - MAX_MENTIONS).toLocaleString()} more: the Backlinks panel lists them all.</Hint>}
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

const NO_SOURCES: readonly string[] = [];

/** Notes linked to or from `path` — the Connections header. Same set as the depth-1 graph. */
function linkedNotes(out: readonly OutRow[], sources: readonly string[]): Set<string> {
  const s = new Set(sources);
  for (const o of out) if (o.path && isMarkdown(o.path)) s.add(o.path);
  return s;
}

export function Connections({ path, live }: ConnectionsProps) {
  const t0 = performance.now();
  const version = kv.value;
  const deferred = indexDeferred.value;
  const isBuilding = indexBusy.value;
  const files = app.files.value;
  const depth = graphDepth.value;
  // Collapsed by default: then only the header count below is computed.
  const open = isSectionOpen('connections', false);
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
  // No context snippets: cheap enough for the header of a collapsed section.
  const sources = useMemo(() => (deferred ? NO_SOURCES : index.backlinkSources(path)), [path, version, deferred]);
  const linked = useMemo(() => linkedNotes(out, sources), [out, sources]);
  // Open only: the lists, the graph, related notes and the mention scan.
  const back = useMemo(() => {
    if (deferred || !open) return [];
    const groups = new Map<string, ReturnType<typeof index.backlinks>>();
    for (const b of index.backlinks(path)) {
      const g = groups.get(b.from);
      if (g) g.push(b);
      else groups.set(b.from, [b]);
    }
    return [...groups];
  }, [path, version, deferred, open]);
  const related = useMemo(() => (known && open ? relatedNotes(index, path) : []), [path, version, known, open]);
  const tags = useMemo(() => (!open ? [] : known ? sharedTags(index, path) : (live?.note.tags ?? []).map((tag) => ({ tag, count: 0 }))), [path, version, known, live, open]);
  const graph = useMemo(() => (open && !deferred ? localGraph(index, path, depth, GRAPH_CAP[depth]) : null), [path, version, depth, open, deferred]);
  const mentions = useMentions(path, open && !deferred, version);

  useLayoutEffect(() => record(connectionsPerf.render, performance.now() - t0));

  const missing = out.filter((o) => !o.path).length;
  const linksTo = `links to ${plural(out.length - missing, 'note')}${missing ? ` (+${missing} not created yet)` : ''}`;
  const head = {
    id: 'connections',
    title: 'Connections',
    count: linked.size,
    countTitle: deferred ? `${plural(linked.size, 'linked note')}: this one ${linksTo} · incoming links need the search index` : `${plural(linked.size, 'linked note')}: ${sources.length} link here, this one ${linksTo}`,
    defaultOpen: false,
  };
  if (!open) return <Section {...head}>{null}</Section>;

  const outgoing = (
    <Sub id="cn-out" title="Links to" count={out.length} countTitle={missing ? `${missing} not created yet` : undefined}>
      <OutgoingRows path={path} rows={out} />
    </Sub>
  );
  const tagsSub = (title: string, known: boolean) => (
    <Sub id="cn-tags" title={title} count={tags.length} countTitle={known ? 'This note’s tags and how many other notes have them' : undefined}>
      {tags.length ? <TagRows path={path} tags={tags} known={known} /> : <Hint>This note has no tags.</Hint>}
    </Sub>
  );

  if (deferred)
    return (
      <Section {...head}>
        {outgoing}
        {tagsSub('Tags', false)}
        <Hint>
          Backlinks, mentions, related notes and the graph come from the search index, built on demand.{' '}
          <button class="se-ov-lvl-btn se-cn-build" onClick={() => void searchClient.start()}>
            Build now
          </button>
        </Hint>
      </Section>
    );

  const backCount = back.reduce((n, [, items]) => n + items.length, 0);
  const graphCount = graph ? graph.nodes.length - 1 : 0;
  const mentionList = mentions.list;
  const mentionCount: HeaderCount = !mentionList ? null : mentionList.length >= MENTION_SCAN ? `${MENTION_SCAN}+` : mentionList.length;
  const graphActions = (
    <div class="se-cn-actions">
      <div class="se-ov-levels" role="group" aria-label="Graph depth">
        {([1, 2] as const).map((d) => (
          <button class={`se-ov-lvl-btn${depth === d ? ' on' : ''}`} aria-pressed={depth === d} title={d === 1 ? 'Direct links only' : 'Links of links too'} onClick={() => setDepth(d)}>
            {d}
          </button>
        ))}
      </div>
      <button class="se-cn-icon" title="Open the local graph (bigger)" aria-label="Open the local graph" onClick={() => void runCommand('knowledge.localGraph')}>
        <Icon name="cn-graph" size={13} />
      </button>
    </div>
  );

  return (
    <Section {...head}>
      <Sub id="cn-graph" title="Local graph" count={graphCount} countTitle={depth === 1 ? 'Notes in the graph: linked to or from this one' : 'Notes in the graph: links and links of links'} actions={graphActions}>
        {graph && <MiniGraph path={path} data={graph} />}
      </Sub>
      <Sub id="cn-in" title="Linked from" count={backCount} countTitle={`${plural(backCount, 'link')} from ${plural(back.length, 'note')}`}>
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
                  title={`${from} · line ${b.line + 1}\n${b.context.text}`}
                  onClick={() => void app.openFile(from, { line: b.line, col: b.col, length: b.length })}
                >
                  <span class="se-ov-ico">{j === 0 ? <FileIcon path={from} size={14} /> : null}</span>
                  {j === 0 && <span class="se-ov-name">{nameOf(from)}</span>}
                  <Ctx s={b.context} />
                </div>
              )),
            )}
            {back.length > MAX_BACK && <Hint>{(back.length - MAX_BACK).toLocaleString()} more notes link here: the Backlinks panel lists them all.</Hint>}
          </List>
        )}
      </Sub>
      {outgoing}
      <Sub
        id="cn-mentions"
        title="Unlinked mentions"
        count={mentionCount}
        countTitle={`Plain-text mentions of “${stem(path)}” in other notes`}
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
      {tagsSub('Shared tags', true)}
      <Sub id="cn-related" title="Related" count={related.length} countTitle="Notes that link to the same notes, are linked from the same notes or share tags">
        {related.length === 0 ? (
          <Hint>{isBuilding ? indexingText() : 'Nothing related yet. Notes that cite the same notes or share tags show up here.'}</Hint>
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
