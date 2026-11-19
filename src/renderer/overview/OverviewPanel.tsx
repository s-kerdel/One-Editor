// File overview for the active file: outline (headings or code symbols), code blocks, tasks, links
// and file info, in collapsible sections. Lazy chunk — see ./index.ts.
import { render, type ComponentChildren, type VNode } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { basename, dirname, isMarkdown, stem } from '@shared/paths';
import { languageForFence } from '@shared/languages';
import { app } from '../app/app';
import * as ui from '../app/ui';
import { FileIcon, Icon, isImagePath } from '../app/icons';
import { findNode } from '../app/tree-model';
import { fileUrl } from '../platform';
import './icons';
import './overview.css';
import { copyBlock, jumpTo, toggleTask } from './actions';
import { indexDeferred } from '../search/demand';
import { startIndexing } from '../search';
import { collapsedSections, keepInView, setSectionCollapsed, useCursorDerived, useKnowledge, useLiveContent, useRoving, type Knowledge } from './hooks';
import {
  activeOutlineIndex,
  docModel,
  foldToLevel,
  formatBytes,
  formatWhen,
  lastAtOrBefore,
  maxDepth,
  readingTimeLabel,
  visibleAncestor,
  visibleOutlineRows,
  type DocModel,
  type OutlineEntry,
} from './model';

// Big outlines (generated docs, 1 MB notes) stay responsive: rows beyond this are summarised.
const MAX_ROWS = 1500;
/** Links are re-rendered on every index change: a 1 MB note links thousands of notes. */
const MAX_LINK_ROWS = 300;

// ---------------------------------------------------------------- building blocks

function Section(props: { id: string; title: string; count?: number | string | null; countTitle?: string; actions?: ComponentChildren; children: ComponentChildren }) {
  const open = !collapsedSections.value[props.id];
  const bodyId = `se-ov-sec-${props.id}`;
  return (
    <section class={`se-ov-sec${open ? ' open' : ''}`} data-section={props.id}>
      <div class="se-ov-sec-head">
        <button class="se-ov-sec-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setSectionCollapsed(props.id, open)}>
          <span class="se-ov-sec-title">{props.title}</span>
          {props.count != null && (
            <span class="se-ov-count" title={props.countTitle}>
              {props.count}
            </span>
          )}
          <Icon name="chevronRight" size={12} class="se-ov-chev" />
        </button>
        {open && props.actions && <div class="se-ov-sec-actions">{props.actions}</div>}
      </div>
      {open && (
        <div class="se-ov-sec-body" id={bodyId}>
          {props.children}
        </div>
      )}
    </section>
  );
}

function Hint({ children }: { children: ComponentChildren }) {
  return <div class="se-ov-hint">{children}</div>;
}

function Rows({ render }: { render: () => ComponentChildren }) {
  return <>{render()}</>;
}

/**
 * The same rows while `sig` holds. Preact skips a component vnode it rendered before, so an edit
 * that changes nothing a list shows costs one string compare instead of re-diffing up to 1,500 rows
 * per section (a 1 MB note: 50–80 ms per refresh). `sig` covers everything the rows show and capture;
 * handlers that need the latest model go through a ref (`useLatest`).
 */
function useRows(sig: string, render: () => ComponentChildren): VNode {
  const ref = useRef<{ sig: string; vnode: VNode } | null>(null);
  if (ref.current?.sig !== sig) ref.current = { sig, vnode: <Rows render={render} /> };
  return ref.current.vnode;
}

function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

const SEP = '\u0001';

/** Hovering / focusing the panel pauses "follow the cursor" scrolling, so it never fights the user. */
function userIsInPanel(el: Element | null) {
  const panel = el?.closest('.se-ov');
  return !!panel && (panel.matches(':hover') || panel.contains(document.activeElement));
}

// ---------------------------------------------------------------- outline

// Symbol kind → [glyph, colour class]. A Map: names like "constructor" must not hit Object.prototype.
const KIND = new Map<string, [glyph: string, cls: string]>([
  ['class', ['C', 'class']],
  ['interface', ['I', 'type']],
  ['type', ['T', 'type']],
  ['enum', ['E', 'type']],
  ['struct', ['S', 'type']],
  ['trait', ['T', 'type']],
  ['function', ['ƒ', 'fn']],
  ['def', ['ƒ', 'fn']],
  ['fn', ['ƒ', 'fn']],
  ['func', ['ƒ', 'fn']],
  ['method', ['m', 'method']],
  ['constructor', ['m', 'method']],
  ['const', ['K', 'const']],
  ['sql', ['T', 'sql']],
]);

function symbolKind(entries: readonly OutlineEntry[], e: OutlineEntry): string {
  const d = e.detail ?? 'function';
  // PHP / Python methods are reported as plain functions: inside a class they're methods.
  if ((d === 'function' || d === 'def') && e.parent >= 0 && /^(class|trait|interface|enum)$/.test(entries[e.parent].detail ?? '')) return 'method';
  return d;
}

/** Fold state per file: folded entry keys + the "show N levels" choice that produced it (if any). */
const folds = signal<Record<string, { set: ReadonlySet<string>; level: number | null }>>({});
const NO_FOLDS = { set: new Set<string>() as ReadonlySet<string>, level: null };

function OutlineSection({ path, model }: { path: string; model: DocModel }) {
  const entries = model.outline;
  const fold = folds.value[path] ?? NO_FOLDS;
  const rows = useMemo(() => visibleOutlineRows(entries, fold.set), [entries, fold.set]);
  const active = useCursorDerived((line) => visibleAncestor(entries, fold.set, activeOutlineIndex(entries, line)));
  const listRef = useRef<HTMLDivElement>(null);
  const setFold = (set: ReadonlySet<string>, level: number | null) => (folds.value = { ...folds.value, [path]: { set, level } });
  const toggle = (e: OutlineEntry) => {
    const next = new Set(fold.set);
    if (!next.delete(e.key)) next.add(e.key);
    setFold(next, null);
  };
  const roving = useRoving(listRef, (ev, row) => {
    const e = entries[Number(row.dataset.i)];
    if (!e) return false;
    const folded = fold.set.has(e.key);
    if (ev.key === 'ArrowRight' && e.hasChildren) {
      if (folded) toggle(e);
      else (row.nextElementSibling as HTMLElement | null)?.focus();
      return true;
    }
    if (ev.key === 'ArrowLeft') {
      if (e.hasChildren && !folded) toggle(e);
      else if (e.parent >= 0) listRef.current?.querySelector<HTMLElement>(`[data-i="${e.parent}"]`)?.focus();
      return true;
    }
    return false;
  });

  // Follow the cursor: keep the current section's row visible (unless the user is in the panel).
  const activeKey = active >= 0 ? entries[active]?.key : null;
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>('.se-ov-ol.is-active');
    if (row && !userIsInPanel(row)) keepInView(row, 24);
  }, [activeKey, path]);

  const md = model.markdown;
  const depth = useMemo(() => maxDepth(entries), [entries]);
  const levels = depth > 1 ? Array.from({ length: Math.min(depth - 1, 5) }, (_, i) => i + 1) : [];
  const actions = levels.length ? (
    <div class="se-ov-levels" role="group" aria-label="Outline depth">
      {levels.map((n) => (
        <button class={`se-ov-lvl-btn${fold.level === n ? ' on' : ''}`} title={n === 1 ? 'Show top level only' : `Show ${n} levels`} aria-pressed={fold.level === n} onClick={() => setFold(foldToLevel(entries, n), n)}>
          {n}
        </button>
      ))}
      <button class={`se-ov-lvl-btn${fold.set.size === 0 ? ' on' : ''}`} title="Expand all" aria-pressed={fold.set.size === 0} onClick={() => setFold(new Set(), null)}>
        All
      </button>
    </div>
  ) : null;

  const shown = rows.length > MAX_ROWS ? rows.slice(0, MAX_ROWS) : rows;
  const live = useLatest({ toggle });
  const sig =
    `${path}${SEP}${md}${SEP}${active}${SEP}${rows.length}\n` +
    shown
      .map(({ i, collapsed }) => {
        const e = entries[i];
        return `${i}${SEP}${e.key}${SEP}${e.line}${SEP}${e.level}${SEP}${e.depth}${SEP}${e.hasChildren ? 1 : 0}${collapsed ? 1 : 0}${SEP}${md ? '' : symbolKind(entries, e)}${SEP}${e.text}`;
      })
      .join('\n');
  const rowNodes = useRows(sig, () => (
    <>
      {shown.map(({ i, collapsed }) => {
        const e = entries[i];
        const kind = md ? null : (KIND.get(symbolKind(entries, e)) ?? KIND.get('function')!);
        return (
          <div
            key={e.key}
            class={`se-ov-row se-ov-ol${md ? ` h${e.level}` : ''}${i === active ? ' is-active' : ''}`}
            role="treeitem"
            aria-level={e.depth + 1}
            aria-expanded={e.hasChildren ? !collapsed : undefined}
            aria-selected={i === active}
            tabIndex={-1}
            data-row
            data-key={e.key}
            data-i={i}
            data-line={e.line}
            style={{ '--d': e.depth }}
            title={`${e.text} — line ${e.line + 1}`}
            onClick={() => jumpTo(path, e.line)}
          >
            {e.hasChildren ? (
              <span
                class="se-ov-twisty"
                aria-hidden="true"
                onClick={(ev) => {
                  ev.stopPropagation();
                  live.current.toggle(e);
                }}
              >
                <Icon name="chevronRight" size={11} class={`se-ov-chev${collapsed ? '' : ' open'}`} />
              </span>
            ) : (
              <span class="se-ov-twisty" />
            )}
            {kind && <span class={`se-ov-kind k-${kind[1]}`}>{kind[0]}</span>}
            <span class="se-ov-text">{e.text}</span>
            {md && <span class="se-ov-tag">H{e.level}</span>}
          </div>
        );
      })}
      {rows.length > MAX_ROWS && <Hint>{(rows.length - MAX_ROWS).toLocaleString()} more — use Ctrl+Shift+O to search them.</Hint>}
    </>
  ));
  return (
    <Section id="outline" title={md ? 'Outline' : 'Symbols'} count={entries.length} actions={actions}>
      {entries.length === 0 ? (
        <Hint>{md ? <>No headings yet. Start a line with <code>#</code> to add one.</> : 'No classes or functions found.'}</Hint>
      ) : (
        <div class="se-ov-list" ref={listRef} role="tree" aria-label={md ? 'Outline' : 'Symbols'} onKeyDown={roving.onKeyDown} onFocusIn={roving.onFocusIn}>
          {rowNodes}
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- code blocks

// Language families share a badge colour, so a shell-heavy note reads at a glance.
const TONE: Record<string, string> = {
  shell: 'shell', powershell: 'shell', bat: 'shell', sql: 'sql', php: 'php', blade: 'php', typescript: 'ts', tsx: 'ts', python: 'ts', go: 'ts',
  javascript: 'js', jsx: 'js', json: 'js', yaml: 'conf', toml: 'conf', ini: 'conf', dockerfile: 'conf', nginx: 'conf', apache: 'conf', makefile: 'conf',
  html: 'web', xml: 'web', css: 'web', scss: 'web', less: 'web', vue: 'web', rust: 'web',
};
const toneOf = (lang: string) => {
  const id = lang ? languageForFence(lang)?.id : undefined;
  return id && Object.hasOwn(TONE, id) ? ` t-${TONE[id]}` : '';
};

function CodeBlocksSection({ path, model }: { path: string; model: DocModel }) {
  const blocks = model.codeBlocks;
  const listRef = useRef<HTMLDivElement>(null);
  const active = useCursorDerived((line) => {
    const i = lastAtOrBefore(blocks, line);
    return i >= 0 && line <= blocks[i].endLine ? i : -1;
  });
  const roving = useRoving(listRef, (e, row) => {
    const b = blocks[Number(row.dataset.i)];
    if (b && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && !getSelection()?.toString()) {
      copyBlock(model, b);
      return true;
    }
    return false;
  });
  const shown = blocks.length > MAX_ROWS ? blocks.slice(0, MAX_ROWS) : blocks;
  // Copy reads the current model: a block's body can change while its row (label, line) does not.
  const live = useLatest({ copy: (i: number) => blocks[i] && copyBlock(model, blocks[i]) });
  const sig = `${path}${SEP}${active}\n` + shown.map((b) => `${b.line}${SEP}${b.lines}${SEP}${b.lang}${SEP}${b.note ?? ''}${SEP}${b.label}`).join('\n');
  const rowNodes = useRows(sig, () =>
    shown.map((b, i) => (
      <div
        key={`${b.line}`}
        class={`se-ov-row se-ov-code${i === active ? ' is-active' : ''}`}
        role="listitem"
        tabIndex={-1}
        data-row
        data-key={`b${b.line}`}
        data-i={i}
        data-line={b.line}
        title={`${b.note ? `${b.note}\n` : ''}${b.label}\n\nLine ${b.line + 1} · ${b.lines} ${b.lines === 1 ? 'line' : 'lines'} · Enter: jump · Ctrl+C: copy`}
        onClick={() => jumpTo(path, b.lines ? b.line + 1 : b.line)}
      >
        <span class={`se-ov-lang${toneOf(b.lang)}`}>{b.lang || 'text'}</span>
        <code class="se-ov-cmd">{b.label || <em>empty</em>}</code>
        {b.lines > 1 && <span class="se-ov-meta">{b.lines}</span>}
        <button
          class="se-ov-mini se-ov-copy"
          tabIndex={-1}
          title="Copy code"
          aria-label="Copy code"
          onClick={(e) => {
            e.stopPropagation();
            live.current.copy(i);
          }}
        >
          <Icon name="copy" size={12} />
        </button>
      </div>
    )),
  );
  return (
    <Section id="code" title="Code blocks" count={blocks.length}>
      {blocks.length === 0 ? (
        <Hint>No code blocks. Fence one with <code>```</code> and a language.</Hint>
      ) : (
        <div class="se-ov-list" ref={listRef} role="list" aria-label="Code blocks" onKeyDown={roving.onKeyDown} onFocusIn={roving.onFocusIn}>
          {rowNodes}
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- tasks

const showDoneTasks = signal(false);

function TasksSection({ path, model, refresh }: { path: string; model: DocModel; refresh: () => void }) {
  const t = model.tasks;
  const total = t.open + t.done;
  const listRef = useRef<HTMLDivElement>(null);
  const showDone = showDoneTasks.value;
  const items = showDone ? t.items : t.items.filter((x) => !x.done);
  const flip = (i: number) => {
    const x = items[i];
    if (!x) return;
    roving.refocusAt(i);
    if (toggleTask(path, x)) refresh();
  };
  const roving = useRoving(listRef, (e, _row, i) => {
    if (e.key !== ' ') return false;
    flip(i);
    return true;
  });
  const pct = total ? Math.round((t.done / total) * 100) : 0;
  const actions =
    t.done > 0 ? (
      <button class={`se-ov-lvl-btn${showDone ? ' on' : ''}`} aria-pressed={showDone} title={showDone ? 'Hide completed tasks' : 'Show completed tasks'} onClick={() => (showDoneTasks.value = !showDone)}>
        Done
      </button>
    ) : null;
  const shown = items.length > MAX_ROWS ? items.slice(0, MAX_ROWS) : items;
  const live = useLatest({ flip });
  const sig = `${path}${SEP}${showDone}\n` + shown.map((x) => `${x.line}${SEP}${x.col}${SEP}${x.done ? 1 : 0}${SEP}${x.depth}${SEP}${x.text}`).join('\n');
  const rowNodes = useRows(sig, () => (
    <>
              {shown.map((x, i) => (
                <div
                  key={`${x.line}`}
                  class={`se-ov-row se-ov-task${x.done ? ' done' : ''}`}
                  role="listitem"
                  aria-label={`${x.done ? 'Done' : 'Open'} task: ${x.text}`}
                  tabIndex={-1}
                  data-row
                  data-key={`t${x.line}`}
                  data-line={x.line}
                  style={{ '--d': Math.min(x.depth, 4) }}
                  title={`${x.text}\n\nLine ${x.line + 1} · Enter: jump · Space: toggle`}
                  onClick={() => jumpTo(path, x.line, x.col + 3)}
                >
                  <span
                    class="se-ov-check"
                    role="checkbox"
                    aria-checked={x.done}
                    aria-label="Toggle task"
                    onClick={(e) => {
                      e.stopPropagation();
                      live.current.flip(i);
                    }}
                  >
                    <Icon name="check" size={10} />
                  </span>
                  <span class="se-ov-text">{x.text || <em>(empty task)</em>}</span>
                </div>
              ))}
    </>
  ));
  return (
    <Section id="tasks" title="Tasks" count={total ? `${t.done}/${total}` : 0} countTitle={`${t.open} open · ${t.done} done`} actions={actions}>
      {total === 0 ? (
        <Hint>No tasks. Type <code>- [ ]</code> to add one.</Hint>
      ) : (
        <>
          <div class="se-ov-progress" title={`${t.done} of ${total} done`}>
            <div class="se-ov-bar" role="progressbar" aria-label="Tasks done" aria-valuemin={0} aria-valuemax={total} aria-valuenow={t.done}>
              <span style={{ width: `${pct}%` }} />
            </div>
            <span class="se-ov-progress-text">
              {t.open === 0 ? 'All done' : `${t.open} open`} · {pct}%
            </span>
          </div>
          {items.length === 0 ? (
            <Hint>Nothing left to do.</Hint>
          ) : (
            <div class="se-ov-list" ref={listRef} role="list" aria-label="Tasks" onKeyDown={roving.onKeyDown} onFocusIn={roving.onFocusIn}>
              {rowNodes}
            </div>
          )}
        </>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- links

interface OutRow {
  key: string;
  path: string | null;
  label: string;
  /** What to follow: `[[target#heading]]` text for wiki links. */
  follow: string;
  wiki: boolean;
  count: number;
  line: number;
  col: number;
}

function outgoingRows(kn: Knowledge, path: string): OutRow[] {
  const seen = new Map<string, OutRow>();
  for (const { link, path: to } of kn.outgoing(path)) {
    if (to === path) continue; // in-note anchors
    const key = to ?? `?${link.target.toLowerCase()}`;
    const hit = seen.get(key);
    if (hit) {
      hit.count++;
      continue;
    }
    const anchor = link.block ? `#^${link.block}` : link.heading ? `#${link.heading}` : '';
    seen.set(key, {
      key,
      path: to,
      label: to ? (isMarkdown(to) ? stem(to) : basename(to)) : link.target,
      follow: `${link.target}${anchor}`,
      wiki: link.kind === 'wiki',
      count: 1,
      line: link.line,
      col: link.col,
    });
  }
  // Resolved first (they're where you'd navigate), then the ones still to be written.
  return [...seen.values()].sort((a, b) => Number(!a.path) - Number(!b.path));
}

function LinksSection({ path }: { path: string }) {
  const kn = useKnowledge();
  const version = kn?.changed.value ?? 0;
  const out = useMemo(() => (kn ? outgoingRows(kn, path) : []), [kn, path, version]);
  const back = useMemo(() => {
    if (!kn) return [];
    const groups = new Map<string, { from: string; items: ReturnType<Knowledge['backlinks']> }>();
    for (const b of kn.backlinks(path)) {
      const g = groups.get(b.from);
      if (g) g.items.push(b);
      else groups.set(b.from, { from: b.from, items: [b] });
    }
    return [...groups.values()];
  }, [kn, path, version]);
  const listRef = useRef<HTMLDivElement>(null);
  const roving = useRoving(listRef);
  const building = !kn || kn.isBuilding();
  const unresolved = out.filter((o) => !o.path).length;

  const follow = (o: OutRow) => {
    if (o.wiki && app.openLink) void app.openLink(o.follow, path);
    else if (o.path) void app.openFile(o.path);
    else jumpTo(path, o.line, o.col); // a broken file link: show where it is
  };

  // Search index built on demand and not yet: say so (this column is often open at launch — it must
  // not start the build by itself).
  if (indexDeferred.value)
    return (
      <Section id="links" title="Links" count={null}>
        <Hint>
          Links and backlinks come from the search index, built on demand.{' '}
          <button class="se-ov-lvl-btn" onClick={() => void startIndexing()}>
            Build now
          </button>
        </Hint>
      </Section>
    );
  return (
    <Section id="links" title="Links" count={kn ? out.length + back.length : null} countTitle={`${out.length} outgoing${unresolved ? ` (${unresolved} not created yet)` : ''} · ${back.length} linking here`}>
      {!kn ? (
        <Hint>Indexing links…</Hint>
      ) : (
        <div class="se-ov-list" ref={listRef} role="list" aria-label="Links" onKeyDown={roving.onKeyDown} onFocusIn={roving.onFocusIn}>
          <div class="se-ov-sub">
            <Icon name="ov-out" size={12} /> Links to <span class="se-ov-sub-n">{out.length}</span>
          </div>
          {out.length === 0 && <Hint>This note doesn’t link anywhere.</Hint>}
          {(out.length > MAX_LINK_ROWS ? out.slice(0, MAX_LINK_ROWS) : out).map((o) => (
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
          {out.length > MAX_LINK_ROWS && <Hint>{(out.length - MAX_LINK_ROWS).toLocaleString()} more links (Ctrl+Alt+G shows them in the graph).</Hint>}
          <div class="se-ov-sub">
            <Icon name="ov-back" size={12} /> Linked from <span class="se-ov-sub-n">{back.length}</span>
            {building && <span class="se-ov-busy" title="Indexing notes…" />}
          </div>
          {back.length === 0 && <Hint>{building ? 'Indexing…' : 'No notes link here yet.'}</Hint>}
          {(back.length > MAX_LINK_ROWS ? back.slice(0, MAX_LINK_ROWS) : back).map((g) =>
            g.items.slice(0, 20).map((b, j) => (
              <div
                key={`${g.from}:${b.line}:${b.col}`}
                class={`se-ov-row se-ov-back${j ? ' cont' : ''}`}
                role="listitem"
                tabIndex={-1}
                data-row
                data-key={`b${g.from}:${b.line}:${b.col}`}
                title={`${g.from} — line ${b.line + 1}\n${b.context.text}`}
                onClick={() => void app.openFile(g.from, { line: b.line, col: b.col, length: b.length })}
              >
                <span class="se-ov-ico">{j === 0 ? <FileIcon path={g.from} size={14} /> : null}</span>
                {j === 0 && <span class="se-ov-name">{isMarkdown(g.from) ? stem(g.from) : basename(g.from)}</span>}
                <span class="se-ov-ctx">
                  {b.context.text.slice(0, b.context.start)}
                  <mark>{b.context.text.slice(b.context.start, b.context.end)}</mark>
                  {b.context.text.slice(b.context.end)}
                </span>
              </div>
            )),
          )}
          {back.length > MAX_LINK_ROWS && <Hint>{(back.length - MAX_LINK_ROWS).toLocaleString()} more notes link here — the Backlinks panel lists them all.</Hint>}
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- info

function propValue(v: unknown): string {
  if (Array.isArray(v)) return v.map(propValue).join(', ');
  if (v == null) return '—';
  return String(v);
}

function Fact({ label, value, title }: { label: string; value: ComponentChildren; title?: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd title={title}>{value}</dd>
    </>
  );
}

interface BinaryMeta {
  size?: number;
  width?: number;
  height?: number;
}
const binaryMeta = new Map<string, BinaryMeta>(); // `${path}@${mtime}` → meta

/** Size (and pixel dimensions for images) of a binary file: docs don't keep them, so ask once. */
function useBinaryMeta(path: string, mtime: number | undefined, enabled: boolean): BinaryMeta | null {
  const key = `${path}@${mtime ?? 0}`;
  const [, bump] = useState(0);
  useEffect(() => {
    if (!enabled || binaryMeta.has(key)) return;
    let alive = true;
    const meta: BinaryMeta = {};
    binaryMeta.set(key, meta);
    const done = () => alive && bump((n) => n + 1);
    app.backend.readFile(path).then((f) => ((meta.size = f.size), done()), () => {});
    if (isImagePath(path)) {
      const img = new Image();
      img.onload = () => ((meta.width = img.naturalWidth), (meta.height = img.naturalHeight), done());
      img.src = fileUrl(app.backend, app.workspace.value?.root ?? '', path);
    }
    return () => {
      alive = false;
    };
  }, [key, enabled]);
  return enabled ? (binaryMeta.get(key) ?? null) : null;
}

function useFileMeta(path: string) {
  const tree = app.tree.value;
  const node = useMemo(() => findNode(tree, path), [tree, path]);
  const doc = app.docs.get(path);
  const mtime = doc?.mtime || node?.mtime;
  const bin = useBinaryMeta(path, mtime, !!doc?.binary);
  return { size: node?.size ?? bin?.size, mtime, doc, bin };
}

function InfoSection({ path, model }: { path: string; model: DocModel | null }) {
  const { size, mtime, doc, bin } = useFileMeta(path);
  const kn = useKnowledge();
  ui.docMetaVersion.value; // EOL / encoding changes
  const md = !!model?.markdown;
  const note = md && model ? (kn?.note(path) ?? model.note) : null;
  const tags = note?.tags ?? [];
  const props = note ? Object.entries(note.props).filter(([k]) => !/^(tags?)$/i.test(k)) : [];
  const s = model?.stats;
  const bytes = model && doc && !doc.binary ? model.bytes : size;
  const lang = !md && model ? (app.editor?.getLanguage?.(path)?.name ?? null) : null;
  return (
    <Section id="info" title="Info">
      <dl class="se-ov-facts">
        {s && md && <Fact label="Words" value={s.words.toLocaleString()} />}
        {s && <Fact label="Characters" value={s.chars.toLocaleString()} />}
        {s && md && <Fact label="Reading time" value={readingTimeLabel(s.words)} />}
        {model && <Fact label="Lines" value={model.lines.toLocaleString()} />}
        {lang && <Fact label="Language" value={lang} />}
        {doc && !doc.binary && <Fact label="Format" value={`${doc.eol === 'crlf' ? 'CRLF' : 'LF'} · ${doc.encoding === 'utf16le' ? 'UTF-16 LE' : doc.encoding === 'utf16be' ? 'UTF-16 BE' : doc.encoding === 'windows-1252' ? 'Windows 1252' : 'UTF-8'}${doc.bom ? ' BOM' : ''}`} />}
        {doc?.binary && <Fact label="Type" value={isImagePath(path) ? `${(path.split('.').pop() ?? '').toUpperCase()} image` : 'Binary file'} />}
        {bin?.width ? <Fact label="Dimensions" value={`${bin.width} × ${bin.height} px`} /> : null}
        {bytes != null && <Fact label="Size" value={formatBytes(bytes)} title={`${bytes.toLocaleString()} bytes${doc?.dirty.value ? ' (unsaved)' : ''}`} />}
        {mtime ? <Fact label="Modified" value={formatWhen(mtime)} title={new Date(mtime).toLocaleString()} /> : null}
      </dl>
      {tags.length > 0 && (
        <div class="se-ov-tags" aria-label="Tags">
          {tags.map((t) =>
            app.openSearch ? (
              <button class="se-ov-pill" title={`Search tag:${t}`} onClick={() => app.openSearch?.(`tag:${t}`)}>
                #{t}
              </button>
            ) : (
              <span class="se-ov-pill">#{t}</span>
            ),
          )}
        </div>
      )}
      {props.length > 0 && (
        <dl class="se-ov-props" aria-label="Properties">
          {props.slice(0, 8).map(([k, v]) => (
            <Fact label={k} value={propValue(v)} title={`${k}: ${propValue(v)}`} />
          ))}
          {props.length > 8 && <dd class="se-ov-more">+{props.length - 8} more</dd>}
        </dl>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- panel

// No close button on purpose: in the window's top-right corner it would sit next to the window's own ×.
function Head({ path }: { path: string | null | undefined }) {
  return (
    <div class="se-ov-head">
      {path === undefined ? null : path ? (
        <>
          <FileIcon path={path} size={16} />
          <span class="se-ov-file" title={path}>
            <span class="se-ov-file-name">{isMarkdown(path) ? stem(path) : basename(path)}</span>
            {dirname(path) && <span class="se-ov-file-dir">{dirname(path)}</span>}
          </span>
        </>
      ) : (
        <span class="se-ov-file se-ov-file-name">File overview</span>
      )}
    </div>
  );
}

export function OverviewPanel() {
  const path = app.activePath.value;
  const { content, refresh } = useLiveContent(path);
  const doc = path ? app.docs.get(path) : undefined;
  const md = ui.isMarkdownView(path);
  const binary = !!doc?.binary;
  const model = path && content != null && !binary ? docModel(path, content, md) : null;

  let body: ComponentChildren;
  // Launch: the session's file opens right after the first frame — show nothing until then, not "No file open".
  const booting = !path && !app.ready.value;
  if (booting) body = null;
  else if (!path) {
    body = (
      <div class="se-ov-empty">
        <Icon name="ov-panel" size={28} />
        <p>No file open</p>
        <span>Open a note or code file to see its outline, code blocks, tasks and links here.</span>
      </div>
    );
  } else if (binary) {
    body = (
      <>
        <Hint>{isImagePath(path) ? 'Images have no outline.' : 'Binary file — nothing to outline.'}</Hint>
        <InfoSection path={path} model={null} />
      </>
    );
  } else if (!model) {
    body = <Hint>Loading…</Hint>;
  } else {
    body = (
      <>
        <OutlineSection path={path} model={model} />
        {md && <CodeBlocksSection path={path} model={model} />}
        {md && <TasksSection path={path} model={model} refresh={refresh} />}
        {md && <LinksSection path={path} />}
        <InfoSection path={path} model={model} />
      </>
    );
  }

  return (
    <div class="se-ov" data-path={path ?? undefined}>
      <Head path={booting ? undefined : path} />
      <div class="se-ov-body">{body}</div>
    </div>
  );
}

export default OverviewPanel;

/** Mounts the panel into any element (tests, the hidden debug command). Returns an unmount. */
export function mountOverview(el: HTMLElement): () => void {
  render(<OverviewPanel />, el);
  return () => render(null, el);
}
