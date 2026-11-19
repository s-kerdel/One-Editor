// Sidebar panels: Outline, Backlinks (+ unlinked mentions, outgoing, unresolved) and Tags.
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { dirname, isMarkdown, stem } from '@shared/paths';
import { app } from '../app/app';
import { getCommand } from '../app/commands';
import * as searchModule from '../search';
import { extractHeadings, type Backlink, type Mention, type Snippet, type TagNode } from '../../knowledge/index';
import { index, indexBusy, kv, linkMention, openLink, tagLineOf, unlinkedMentionsOf } from './state';
import { notesWithoutIncoming, orphanNotes } from '../../knowledge/connections';
import { searchClient } from '../search/client';

/** These panels read the index: opening one builds it when it is built on demand (search.indexing). */
const useIndexBuild = () => useEffect(() => void searchClient.start(), []);
/** "Indexing… 1,200 / 4,000 files" while the build runs (what is shown meanwhile is partial). */
function indexingText() {
  const p = searchClient.progress.value;
  return p && p.total ? `Indexing… ${p.done.toLocaleString()} / ${p.total.toLocaleString()} files` : 'Indexing…';
}
import { Chevron, IconCollapse, IconExpand, IconFile, IconFilePlus, IconGraph, IconHash, IconLink, IconSearch } from './icons';

// Section open/closed state survives switching sidebar tabs.
const sectionState = signal<Record<string, boolean>>({ linked: true, unlinked: true, outgoing: false, unresolved: false, orphans: false, noIncoming: false });
export function openSection(id: string) {
  sectionState.value = { ...sectionState.value, [id]: true };
}

function Empty({ children }: { children: ComponentChildren }) {
  return <div class="se-kn-empty">{children}</div>;
}

function PanelHead({ title, sub, children }: { title: string; sub?: string | null; children?: ComponentChildren }) {
  return (
    <div class="se-kn-head">
      <span class="se-kn-title">{title}</span>
      {sub && (
        <span class="se-kn-sub" title={sub}>
          {sub}
        </span>
      )}
      <span class="se-kn-spacer" />
      {children}
    </div>
  );
}

function Section({ id, title, count, children }: { id: string; title: string; count: number | null; children: ComponentChildren }) {
  const open = !!sectionState.value[id];
  return (
    <section class="se-kn-section" data-section={id}>
      <button class="se-kn-section-head" aria-expanded={open} onClick={() => (sectionState.value = { ...sectionState.value, [id]: !open })}>
        <Chevron open={open} />
        <span>{title}</span>
        <span class="se-kn-count">{count === null ? '…' : count}</span>
      </button>
      {open && <div class="se-kn-section-body">{children}</div>}
    </section>
  );
}

function Context({ s }: { s: Snippet }) {
  return (
    <>
      {s.text.slice(0, s.start)}
      <mark>{s.text.slice(s.start, s.end)}</mark>
      {s.text.slice(s.end)}
    </>
  );
}

function FileGroup({ path, count, children }: { path: string; count: number; children: ComponentChildren }) {
  const [open, setOpen] = useState(true);
  const dir = dirname(path);
  return (
    <div class="se-kn-group" data-file={path}>
      <div class="se-kn-file" title={path}>
        <button class="se-kn-twisty" aria-label={open ? 'Collapse' : 'Expand'} onClick={() => setOpen(!open)}>
          <Chevron open={open} />
        </button>
        <span class="se-kn-file-name" onClick={() => void app.openFile(path)}>
          {isMarkdown(path) ? stem(path) : path.slice(path.lastIndexOf('/') + 1)}
        </span>
        {dir && <span class="se-kn-file-dir">{dir}</span>}
        <span class="se-kn-count">{count}</span>
      </div>
      {open && <div class="se-kn-items">{children}</div>}
    </div>
  );
}

function groupBy<T extends { from: string }>(items: T[]): Array<[string, T[]]> {
  const map = new Map<string, T[]>();
  for (const it of items) {
    const l = map.get(it.from);
    if (l) l.push(it);
    else map.set(it.from, [it]);
  }
  return [...map];
}

// ---------------------------------------------------------------- Outline

const collapsedHeadings = signal<Set<string>>(new Set());

export function OutlinePanel() {
  const path = app.activePath.value;
  const [, setTick] = useState(0);
  const [cursorLine, setCursorLine] = useState(0);
  const [filter, setFilter] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    const refresh = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setTick((n) => n + 1));
    };
    const offs = [
      app.events.on('doc:changed', (p) => p === app.activePath.value && refresh()),
      app.events.on('doc:opened', refresh),
      app.events.on('file:updated', (p) => p === app.activePath.value && refresh()),
    ];
    return () => {
      cancelAnimationFrame(raf);
      offs.forEach((o) => o());
    };
  }, []);

  useEffect(() => {
    let off: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attach = () => {
      const ed = app.editor;
      if (!ed) {
        timer = setTimeout(attach, 50); // editor mounts in a sibling effect
        return;
      }
      const sync = () => setCursorLine(ed.getCursor().line);
      sync();
      off = ed.onCursor(sync);
    };
    attach();
    return () => {
      clearTimeout(timer);
      off?.();
    };
  }, [path]);

  const md = !!path && isMarkdown(path);
  const content = md ? (app.editor?.getContent(path!) ?? app.docs.get(path!)?.content ?? '') : '';
  const headings = useMemo(() => extractHeadings(content), [content]);

  let activeIdx = -1;
  for (let i = 0; i < headings.length; i++) if (headings[i].line <= cursorLine) activeIdx = i;

  useEffect(() => {
    listRef.current?.querySelector('.se-kn-ol-row.active')?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx, path]);

  if (!path) return <Empty>Open a note to see its outline.</Empty>;
  if (!md) return <Empty>Outline is available for Markdown notes.</Empty>;

  const collapsed = collapsedHeadings.value;
  const key = (i: number) => `${path}\n${headings[i].slug}`;
  const toggle = (i: number) => {
    const next = new Set(collapsed);
    if (!next.delete(key(i))) next.add(key(i));
    collapsedHeadings.value = next;
  };
  const q = filter.trim().toLowerCase();

  // Depth follows nesting, not the raw level, so an h1→h3 jump indents once.
  const rows: Array<{ i: number; depth: number; hasChildren: boolean }> = [];
  const stack: number[] = [];
  let hideBelow = Infinity;
  headings.forEach((h, i) => {
    while (stack.length && stack[stack.length - 1] >= h.level) stack.pop();
    const depth = stack.length;
    stack.push(h.level);
    if (q) {
      if (h.text.toLowerCase().includes(q)) rows.push({ i, depth: 0, hasChildren: false });
      return;
    }
    if (h.level > hideBelow) return;
    hideBelow = Infinity;
    const hasChildren = i + 1 < headings.length && headings[i + 1].level > h.level;
    rows.push({ i, depth, hasChildren });
    if (hasChildren && collapsed.has(key(i))) hideBelow = h.level;
  });

  const anyCollapsed = headings.some((_, i) => collapsed.has(key(i)));
  const setAll = (collapse: boolean) => {
    const next = new Set(collapsed);
    headings.forEach((h, i) => {
      const parent = i + 1 < headings.length && headings[i + 1].level > h.level;
      if (collapse && parent) next.add(key(i));
      else next.delete(key(i));
    });
    collapsedHeadings.value = next;
  };

  return (
    <div class="se-kn se-kn-outline">
      <PanelHead title="Outline" sub={stem(path)}>
        {headings.length > 1 && (
          <button class="se-kn-btn" title={anyCollapsed ? 'Expand all' : 'Collapse all'} aria-label={anyCollapsed ? 'Expand all' : 'Collapse all'} onClick={() => setAll(!anyCollapsed)}>
            {anyCollapsed ? <IconExpand /> : <IconCollapse />}
          </button>
        )}
      </PanelHead>
      {headings.length > 8 && <input class="se-kn-filter" type="search" placeholder="Filter headings…" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />}
      {headings.length === 0 ? (
        <Empty>
          No headings yet. Start a line with <code>#</code> to add one.
        </Empty>
      ) : (
        <div class="se-kn-ol" ref={listRef} role="tree">
          {rows.map(({ i, depth, hasChildren }) => {
            const h = headings[i];
            const isCollapsed = collapsed.has(key(i));
            return (
              <div
                key={`${h.line}:${h.slug}`}
                class={`se-kn-ol-row lvl-${h.level}${i === activeIdx ? ' active' : ''}`}
                role="treeitem"
                aria-level={h.level}
                data-line={h.line}
                style={{ paddingLeft: `${6 + depth * 14}px` }}
                title={h.text}
                onClick={() => {
                  app.editor?.reveal({ line: h.line, col: 0 });
                  setCursorLine(h.line);
                }}
              >
                {hasChildren ? (
                  <button
                    class="se-kn-twisty"
                    aria-label={isCollapsed ? 'Expand' : 'Collapse'}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(i);
                    }}
                  >
                    <Chevron open={!isCollapsed} />
                  </button>
                ) : (
                  <span class="se-kn-twisty-gap" />
                )}
                <span class="se-kn-ol-text">{h.text || <em>(empty heading)</em>}</span>
                <span class="se-kn-ol-level">H{h.level}</span>
              </div>
            );
          })}
          {q && rows.length === 0 && <Empty>No headings match.</Empty>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Backlinks

function BacklinkRow({ b }: { b: Backlink }) {
  return (
    <div class="se-kn-ctx" data-line={b.line} onClick={() => void app.openFile(b.from, { line: b.line, col: b.col, length: b.length })}>
      <Context s={b.context} />
    </div>
  );
}

function MentionRow({ m, target }: { m: Mention; target: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <div class="se-kn-ctx se-kn-mention" data-line={m.line} onClick={() => void app.openFile(m.from, { line: m.line, col: m.col, length: m.length })}>
      <span class="se-kn-ctx-text">
        <Context s={m.context} />
      </span>
      <button
        class="se-kn-link-btn"
        disabled={busy}
        title={`Turn this mention into a [[${stem(target)}]] link`}
        onClick={(e) => {
          e.stopPropagation();
          setBusy(true);
          void linkMention(target, m).finally(() => setBusy(false));
        }}
      >
        <IconLink /> Link
      </button>
    </div>
  );
}

/** Folder-wide note lists (orphans, no incoming links): capped, the count says how many there are. */
const MAX_NOTE_ROWS = 300;
function NoteList({ paths, empty }: { paths: string[]; empty: string }) {
  if (!paths.length) return <Empty>{indexBusy.value ? indexingText() : empty}</Empty>;
  return (
    <div class="se-kn-items flat">
      {paths.slice(0, MAX_NOTE_ROWS).map((p) => (
        <div key={p} class={`se-kn-out${p === app.activePath.value ? ' current' : ''}`} title={p} data-path={p} onClick={() => void app.openFile(p)}>
          <span class="se-kn-ico">
            <IconFile />
          </span>
          <span class="se-kn-out-name">{stem(p)}</span>
          {dirname(p) && <span class="se-kn-file-dir">{dirname(p)}</span>}
        </div>
      ))}
      {paths.length > MAX_NOTE_ROWS && <Empty>{(paths.length - MAX_NOTE_ROWS).toLocaleString()} more…</Empty>}
    </div>
  );
}

export function BacklinksPanel({ onOpenGraph }: { onOpenGraph?: () => void }) {
  useIndexBuild();
  const path = app.activePath.value;
  const version = kv.value;
  const sections = sectionState.value;
  const backlinks = useMemo(() => (path ? index.backlinks(path) : []), [path, version]);
  const outgoing = useMemo(() => {
    if (!path || !sections.outgoing) return [];
    // One row per distinct destination.
    const seen = new Map<string, { path: string | null; label: string; target: string; count: number }>();
    for (const o of index.outgoing(path)) {
      if (o.path === path) continue;
      const k = o.path ?? `?${o.link.target.toLowerCase()}`;
      const e = seen.get(k);
      if (e) e.count++;
      else seen.set(k, { path: o.path, label: o.path ? (isMarkdown(o.path) ? stem(o.path) : o.path) : o.link.target, target: o.link.target, count: 1 });
    }
    return [...seen.values()];
  }, [path, version, sections.outgoing]);
  const outgoingCount = useMemo(() => (path ? new Set(index.outgoing(path).filter((o) => o.path !== path).map((o) => o.path ?? `?${o.link.target.toLowerCase()}`)).size : 0), [path, version]);
  // Re-read after every edit: the header count is O(1); the list (top 300) only while the section is open.
  const unresolvedCount = useMemo(() => index.unresolvedCount(), [version]);
  const unresolved = useMemo(() => (sections.unresolved ? index.unresolvedLinks(300) : []), [version, sections.unresolved]);
  // O(notes) once per index change, cheap per note (adjacency is cached in the index).
  const unlinkedNotes = useMemo(() => {
    const notes = index.notes().map((n) => n.path);
    return { orphans: orphanNotes(index, notes), noIncoming: notesWithoutIncoming(index, notes) };
  }, [version]);

  // Unlinked mentions scan every note's text (in the search workers) — keep it off the keystroke path.
  const [mentions, setMentions] = useState<{ path: string; list: Mention[] } | null>(null);
  useEffect(() => {
    if (!path || !sections.unlinked) return;
    let live = true;
    const t = setTimeout(() => void unlinkedMentionsOf(path).then((list) => live && setMentions({ path, list })), mentions?.path === path ? 300 : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [path, version, sections.unlinked]);
  const mentionList = mentions && mentions.path === path ? mentions.list : null;

  const head = (
    <PanelHead title="Backlinks" sub={path ? stem(path) : null}>
      {indexBusy.value && <span class="se-kn-busy" title="Indexing notes…" />}
      {onOpenGraph && path && (
        <button class="se-kn-btn" title="Open local graph" aria-label="Open local graph" onClick={onOpenGraph}>
          <IconGraph />
        </button>
      )}
    </PanelHead>
  );

  const unresolvedSection = (
    <Section id="unresolved" title="Unresolved links in folder" count={unresolvedCount}>
      {unresolvedCount === 0 ? (
        <Empty>Every link points to an existing file.</Empty>
      ) : (
        unresolved.slice(0, 300).map((u) => (
          <div class="se-kn-group" key={u.target}>
            <div class="se-kn-file unresolved" title={`Create "${u.target}"`}>
              <span class="se-kn-ico">
                <IconFilePlus />
              </span>
              <span class="se-kn-file-name" onClick={() => void openLink(u.target, u.sources[0].from)}>
                {u.target}
              </span>
              <span class="se-kn-count">{u.sources.length}</span>
            </div>
            <div class="se-kn-items">
              {u.sources.slice(0, 20).map((s) => (
                <div class="se-kn-ctx se-kn-src" onClick={() => void app.openFile(s.from, { line: s.line, col: s.col, length: s.length })}>
                  {stem(s.from)}
                  <span class="se-kn-file-dir">line {s.line + 1}</span>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </Section>
  );

  const folderSections = (
    <>
      {unresolvedSection}
      <Section id="orphans" title="Orphan notes" count={indexBusy.value && !unlinkedNotes.orphans.length ? null : unlinkedNotes.orphans.length}>
        <NoteList paths={unlinkedNotes.orphans} empty="Every note links somewhere or is linked from somewhere." />
      </Section>
      <Section id="noIncoming" title="Notes without incoming links" count={indexBusy.value && !unlinkedNotes.noIncoming.length ? null : unlinkedNotes.noIncoming.length}>
        <NoteList paths={unlinkedNotes.noIncoming} empty="Every note is linked from another note." />
      </Section>
    </>
  );

  if (!path)
    return (
      <div class="se-kn se-kn-backlinks">
        {head}
        <Empty>Open a note to see what links to it.</Empty>
        {folderSections}
      </div>
    );

  return (
    <div class="se-kn se-kn-backlinks">
      {head}
      <Section id="linked" title="Linked mentions" count={backlinks.length}>
        {backlinks.length === 0 ? (
          <Empty>{indexBusy.value ? indexingText() : 'No notes link here yet.'}</Empty>
        ) : (
          groupBy(backlinks).map(([from, items]) => (
            <FileGroup key={from} path={from} count={items.length}>
              {items.map((b) => (
                <BacklinkRow key={`${b.line}:${b.col}`} b={b} />
              ))}
            </FileGroup>
          ))
        )}
      </Section>
      <Section id="unlinked" title="Unlinked mentions" count={mentionList ? mentionList.length : sections.unlinked ? null : null}>
        {!mentionList ? (
          <Empty>Searching…</Empty>
        ) : mentionList.length === 0 ? (
          <Empty>No plain-text mentions of “{stem(path)}”.</Empty>
        ) : (
          groupBy(mentionList).map(([from, items]) => (
            <FileGroup key={from} path={from} count={items.length}>
              {items.map((m) => (
                <MentionRow key={`${m.line}:${m.col}`} m={m} target={path} />
              ))}
            </FileGroup>
          ))
        )}
      </Section>
      <Section id="outgoing" title="Outgoing links" count={outgoingCount}>
        {outgoing.length === 0 ? (
          <Empty>This note doesn’t link anywhere.</Empty>
        ) : (
          <div class="se-kn-items flat">
            {outgoing.map((o) => (
              <div
                key={o.path ?? `?${o.target}`}
                class={`se-kn-out${o.path ? '' : ' unresolved'}`}
                title={o.path ?? `Not created yet — click to create "${o.target}"`}
                onClick={() => (o.path ? void app.openFile(o.path) : void openLink(o.target, path))}
              >
                <span class="se-kn-ico">{o.path ? <IconFile /> : <IconFilePlus />}</span>
                <span class="se-kn-out-name">{o.label}</span>
                {o.count > 1 && <span class="se-kn-count">{o.count}</span>}
              </div>
            ))}
          </div>
        )}
      </Section>
      {folderSections}
    </div>
  );
}

// ---------------------------------------------------------------- Tags

const selectedTag = signal<string | null>(null);
const collapsedTags = signal<Set<string>>(new Set());

/** Search integration is optional: use it only if the search module exposes an entry point. */
function searchForTag(): ((tag: string) => void) | null {
  const fn = (searchModule as any).openSearch;
  if (typeof fn === 'function') return (tag) => fn(`tag:${tag}`);
  const cmd = getCommand('search.query');
  if (cmd) return (tag) => void (cmd.run as (q?: string) => void)(`tag:${tag}`);
  return null;
}

function TagRow({ node, depth, filter }: { node: TagNode; depth: number; filter: string }) {
  const collapsed = collapsedTags.value.has(node.tag) && !filter;
  const selected = selectedTag.value?.toLowerCase() === node.tag.toLowerCase();
  const kids = node.children;
  return (
    <>
      <div
        class={`se-kn-tag${selected ? ' active' : ''}`}
        data-tag={node.tag}
        style={{ paddingLeft: `${6 + depth * 14}px` }}
        title={`#${node.tag}`}
        onClick={() => (selectedTag.value = selected ? null : node.tag)}
      >
        {kids.length ? (
          <button
            class="se-kn-twisty"
            aria-label={collapsed ? 'Expand' : 'Collapse'}
            onClick={(e) => {
              e.stopPropagation();
              const next = new Set(collapsedTags.value);
              if (!next.delete(node.tag)) next.add(node.tag);
              collapsedTags.value = next;
            }}
          >
            <Chevron open={!collapsed} />
          </button>
        ) : (
          <span class="se-kn-twisty-gap" />
        )}
        <span class="se-kn-tag-hash">
          <IconHash />
        </span>
        <span class="se-kn-tag-name">{node.name}</span>
        <span class="se-kn-count">{node.count}</span>
      </div>
      {!collapsed && kids.map((c) => <TagRow key={c.tag} node={c} depth={depth + 1} filter={filter} />)}
    </>
  );
}

function filterTags(nodes: TagNode[], q: string): TagNode[] {
  if (!q) return nodes;
  const out: TagNode[] = [];
  for (const n of nodes) {
    const kids = filterTags(n.children, q);
    if (n.tag.toLowerCase().includes(q)) out.push(n);
    else if (kids.length) out.push({ ...n, children: kids });
  }
  return out;
}

export function TagsPanel() {
  useIndexBuild();
  const version = kv.value;
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<'name' | 'count'>('name');
  const tree = useMemo(() => index.tags(), [version]);
  const q = filter.trim().replace(/^#/, '').toLowerCase();
  const shown = useMemo(() => {
    const f = filterTags(tree, q);
    if (sort === 'name') return f;
    const byCount = (list: TagNode[]): TagNode[] => [...list].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).map((n) => ({ ...n, children: byCount(n.children) }));
    return byCount(f);
  }, [tree, q, sort]);
  const tag = selectedTag.value;
  const notes = useMemo(() => (tag ? index.notesWithTag(tag) : []), [tag, version]);
  const search = tag ? searchForTag() : null;

  return (
    <div class="se-kn se-kn-tags">
      <PanelHead title="Tags">
        {indexBusy.value && <span class="se-kn-busy" title="Indexing notes…" />}
        <button class="se-kn-btn text" title="Toggle sort order" onClick={() => setSort(sort === 'name' ? 'count' : 'name')}>
          {sort === 'name' ? 'A–Z' : 'Count'}
        </button>
      </PanelHead>
      {tree.length > 6 && <input class="se-kn-filter" type="search" placeholder="Filter tags…" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />}
      {tree.length === 0 ? (
        <Empty>
          {indexBusy.value ? (
            indexingText()
          ) : (
            <>
              No tags yet. Write <code>#tag</code> in a note or add <code>tags:</code> to its frontmatter.
            </>
          )}
        </Empty>
      ) : (
        <div class="se-kn-tagtree" role="tree">
          {shown.map((n) => (
            <TagRow key={n.tag} node={n} depth={0} filter={q} />
          ))}
          {shown.length === 0 && <Empty>No tags match.</Empty>}
        </div>
      )}
      {tag && (
        <div class="se-kn-tag-notes" data-tag-notes={tag}>
          <div class="se-kn-section-head static">
            <span class="se-kn-tag-pill">#{tag}</span>
            <span class="se-kn-count">{notes.length}</span>
            <span class="se-kn-spacer" />
            {search && (
              <button class="se-kn-btn" title={`Search for tag:${tag}`} aria-label="Search for this tag" onClick={() => search(tag)}>
                <IconSearch />
              </button>
            )}
          </div>
          <div class="se-kn-items flat">
            {notes.map((p) => (
              <div
                key={p}
                class={`se-kn-out${p === app.activePath.value ? ' current' : ''}`}
                title={p}
                onClick={() =>
                  void tagLineOf(p, tag).then((line) => app.openFile(p, line === null ? undefined : { line }))
                }
              >
                <span class="se-kn-ico">
                  <IconFile />
                </span>
                <span class="se-kn-out-name">{stem(p)}</span>
                {dirname(p) && <span class="se-kn-file-dir">{dirname(p)}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
