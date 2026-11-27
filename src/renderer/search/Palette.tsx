// Omnibox: one input, several modes chosen by prefix (VS Code-style):
//   (none)  files (recent first) · `file#heading` · `file:42` · plus "Found in content" from the index
//   >       commands (title/keywords/category/id, recent first, keybindings shown)
//   #       headings + code symbols across the workspace   @  headings/symbols in the current file
//   :       go to line in the current file
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { app } from '../app/app';
import { listCommands, loadCommandSources, prettyKey, type Command } from '../app/commands';
import { basename, dirname } from '@shared/paths';
import { fuzzyFilter, fuzzyMatch } from '../../search/fuzzy';
import { outline, type OutlineItem } from '../../search/symbols';
import type { HeadingHit, SearchMatch } from '../../search/types';
import { searchClient } from './client';
import { indexDeferred, indexOnDemand } from './demand';
import { HighlightPositions, HighlightRanges } from './highlight';
import { IconCommand, IconHeading, IconLine, IconSearch, IconSymbol, fileIcon } from './icons';
import { getRecentCommands, getRecentFiles, touchRecentCommand } from './state';

type Item =
  | { kind: 'file'; path: string; positions: number[]; recent?: boolean; line?: number; col?: number }
  | { kind: 'command'; cmd: Command; positions: number[]; recent?: boolean; via?: string }
  | { kind: 'heading'; path: string; line: number; col?: number; level: number; text: string; positions: number[]; detail?: string; showPath: boolean; container?: string }
  | { kind: 'line'; path: string; line: number; col?: number }
  | { kind: 'content'; path: string; m: SearchMatch; fuzzy?: boolean };

interface Section {
  label?: string;
  items: Item[];
}

const MAX_FILES = 60;

/** The previous file query's full match set: typing on (the query only grows) searches just these. */
let narrow: { q: string; files: readonly string[]; matched: string[] } | null = null;

/** Membership in the current file list, built once per list (`includes` per recent file cost ~5 ms per key at 50k). */
let known: { files: readonly string[]; set: Set<string> } | null = null;
const isFile = (files: readonly string[], p: string) => {
  if (known?.files !== files) known = { files, set: new Set(files) };
  return known.set.has(p);
};

function fileItems(q: string): Item[] {
  const files = app.files.value;
  const recent = getRecentFiles().filter((p) => isFile(files, p));
  const rank = new Map(recent.map((p, i) => [p, i]));
  if (!q) {
    // Only the first MAX_FILES are shown: stop there instead of mapping every file (~14 ms at 50k).
    const out: Item[] = recent.slice(0, MAX_FILES).map((path) => ({ kind: 'file' as const, path, positions: [], recent: true }));
    for (let i = 0; i < files.length && out.length < MAX_FILES; i++) if (!rank.has(files[i])) out.push({ kind: 'file' as const, path: files[i], positions: [] });
    return out;
  }
  // A query that extends the previous one matches a subset of its matches (same order → same ranking).
  const pool = narrow && narrow.files === files && q.startsWith(narrow.q) ? narrow.matched : files;
  const matched: string[] = [];
  const scored = fuzzyFilter(q, pool, (p) => p, 400, { path: true, collect: matched });
  narrow = { q, files, matched };
  const n = Math.max(1, q.replace(/\s/g, '').length);
  return scored
    .map(({ item, match }) => {
      const r = rank.get(item);
      // recency matters, but never lets a weak match beat a strong one
      const boost = r === undefined ? 0 : (6 - Math.min(5, r)) * n * 0.8;
      return { item, score: match.score + boost, match };
    })
    .sort((a, b) => b.score - a.score || a.item.length - b.item.length)
    .slice(0, MAX_FILES)
    .map(({ item, match }) => ({ kind: 'file' as const, path: item, positions: match.positions, recent: rank.has(item) }));
}

function commandItems(q: string): Item[] {
  const cmds = listCommands();
  const recent = getRecentCommands();
  const rank = new Map(recent.map((id, i) => [id, i]));
  if (!q) {
    const sorted = [...cmds].sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999) || a.title.localeCompare(b.title));
    return sorted.map((cmd) => ({ kind: 'command' as const, cmd, positions: [], recent: rank.has(cmd.id) }));
  }
  const out: Array<{ it: Item; score: number }> = [];
  for (const cmd of cmds) {
    let best: { score: number; positions: number[]; via?: string } | null = null;
    const t = fuzzyMatch(q, cmd.title, { caseSensitive: false });
    if (t) best = { score: t.score, positions: t.positions };
    if (cmd.category) {
      const full = `${cmd.category}: ${cmd.title}`;
      const c = fuzzyMatch(q, full, { caseSensitive: false });
      if (c && (!best || c.score * 0.95 > best.score)) {
        const off = cmd.category.length + 2;
        best = { score: c.score * 0.95, positions: c.positions.filter((p) => p >= off).map((p) => p - off) };
      }
    }
    for (const kw of cmd.keywords ?? []) {
      const k = fuzzyMatch(q, kw, { caseSensitive: false });
      if (k && (!best || k.score * 0.8 > best.score)) best = { score: k.score * 0.8, positions: [], via: kw };
    }
    const idm = fuzzyMatch(q, cmd.id, { caseSensitive: false });
    if (idm && (!best || idm.score * 0.7 > best.score)) best = { score: idm.score * 0.7, positions: [], via: cmd.id };
    if (!best) continue;
    const r = rank.get(cmd.id);
    const boost = r === undefined ? 0 : (10 - Math.min(9, r)) * 1.5;
    out.push({ it: { kind: 'command', cmd, positions: best.positions, recent: r !== undefined, via: best.via }, score: best.score + boost });
  }
  out.sort((a, b) => b.score - a.score || (a.it as { cmd: Command }).cmd.title.localeCompare((b.it as { cmd: Command }).cmd.title));
  return out.map((x) => x.it);
}

function currentOutline(): { path: string; items: OutlineItem[] } | null {
  const path = app.activePath.value;
  if (!path) return null;
  const content = app.editor?.getContent(path) ?? app.docs.get(path)?.content ?? '';
  return { path, items: outline(path, content) };
}

function outlineItems(q: string): Item[] {
  const o = currentOutline();
  if (!o) return [];
  const mapped = o.items.map((h) => ({ h, m: q ? fuzzyMatch(q, h.text) : { score: 0, positions: [] } }));
  const hits = mapped.filter((x) => x.m) as Array<{ h: OutlineItem; m: { score: number; positions: number[] } }>;
  if (q) hits.sort((a, b) => b.m.score - a.m.score || a.h.line - b.h.line);
  return hits.map(({ h, m }) => ({ kind: 'heading' as const, path: o.path, line: h.line, level: h.level, text: h.text, positions: m.positions, detail: h.detail, showPath: false }));
}

function parseLineSpec(s: string): { line: number; col?: number } | null {
  const m = /^(\d+)(?:[:,](\d+))?$/.exec(s.trim());
  return m ? { line: Math.max(0, Number(m[1]) - 1), col: m[2] ? Math.max(0, Number(m[2]) - 1) : undefined } : null;
}

function KeyCombo({ k }: { k: string }) {
  const parts = prettyKey(k).split(/\+(?!$)/);
  return (
    <span class="se-keys">
      {parts.map((p) => (
        <kbd>{p}</kbd>
      ))}
    </span>
  );
}

function modeOf(q: string): 'commands' | 'wsHeadings' | 'outline' | 'line' | 'files' {
  if (q.startsWith('>')) return 'commands';
  if (q.startsWith('#')) return 'wsHeadings';
  if (q.startsWith('@')) return 'outline';
  if (q.startsWith(':')) return 'line';
  return 'files';
}

const PLACEHOLDER: Record<ReturnType<typeof modeOf>, string> = {
  commands: 'Run a command…',
  wsHeadings: 'Go to heading or symbol in workspace…',
  outline: 'Go to heading / symbol in this file…',
  line: 'Go to line (e.g. :42 or :42:5)…',
  files: 'Go to file…   > commands   # headings   @ in file   : line',
};

/** While the index builds (on demand: the first content search started it), say so — with progress. */
function indexingNote(): string | null {
  if (searchClient.status.value !== 'indexing') return null;
  const p = searchClient.progress.value;
  return p && p.total ? `Indexing… ${p.done.toLocaleString()} / ${p.total.toLocaleString()} files` : 'Indexing…';
}

export function Palette({ initial = '' }: { initial?: string }) {
  const [q, setQ] = useState(initial);
  const [sel, setSel] = useState(0);
  const [asyncItems, setAsyncItems] = useState<{ key: string; content: Item[]; headings: Item[]; loading: boolean }>({ key: '', content: [], headings: [], loading: false });
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const picked = useRef(false);
  const latest = useRef<{ q: string; flat: Item[] }>({ q: '', flat: [] });

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    // On demand: going to a file by name needs no index; content / workspace-heading hits start it.
    if (!indexOnDemand()) void searchClient.start();
    return () => {
      if (!picked.current) requestAnimationFrame(() => app.overlay.value === null && app.editor?.focus());
    };
  }, []);

  const mode = modeOf(q);
  const body = mode === 'files' ? q : q.slice(1);
  const fileHash = mode === 'files' ? /^(.+?)#(.*)$/.exec(q) : null;
  const fileLine = mode === 'files' && !fileHash ? /^(.+?):(\d+)(?::(\d+))?$/.exec(q.trim()) : null;

  // Commands without keys register lazily (addCommandSource): list them once they are in.
  const [cmdsLoaded, setCmdsLoaded] = useState(0);
  useEffect(() => void loadCommandSources().then(() => setCmdsLoaded((n) => n + 1)), []);
  const syncSections: Section[] = useMemo(() => {
    switch (mode) {
      case 'commands':
        return [{ items: commandItems(body.trim()) }];
      case 'outline': {
        const items = outlineItems(body.trim());
        return [{ label: app.activePath.value ? basename(app.activePath.value) : undefined, items }];
      }
      case 'line': {
        const path = app.activePath.value;
        const spec = parseLineSpec(body);
        return path && spec ? [{ items: [{ kind: 'line', path, line: spec.line, col: spec.col }] }] : [];
      }
      case 'wsHeadings':
        return [];
      case 'files': {
        if (fileHash) return [];
        if (fileLine) {
          const spec = { line: Math.max(0, Number(fileLine[2]) - 1), col: fileLine[3] ? Number(fileLine[3]) - 1 : undefined };
          return [{ items: fileItems(fileLine[1].trim()).map((it) => ({ ...(it as Extract<Item, { kind: 'file' }>), line: spec.line, col: spec.col })) }];
        }
        const items = fileItems(q.trim());
        return [{ label: !q.trim() && items.some((i) => (i as { recent?: boolean }).recent) ? 'Recently opened' : q.trim() ? 'Files' : undefined, items }];
      }
    }
  }, [q, mode, cmdsLoaded]);

  // async: workspace headings, `file#heading`, and content hits from the full-text index
  const asyncKey = `${mode}|${q}`;
  useEffect(() => {
    const fileCount = syncSections.reduce((n, s) => n + s.items.length, 0);
    const contentQuery = mode === 'files' && !fileHash && !fileLine && q.trim().length >= 3 && fileCount < 6;
    // Index built on demand and not yet: going to a file by name must not build it (a note says how).
    const wantContent = contentQuery && !indexDeferred.value;
    const wantHeadings = mode === 'wsHeadings' || !!fileHash;
    if (!wantContent && !wantHeadings) {
      setAsyncItems({ key: asyncKey, content: [], headings: [], loading: false });
      return;
    }
    setAsyncItems((s) => ({ ...s, loading: true }));
    const t = setTimeout(async () => {
      let headings: Item[] = [];
      let content: Item[] = [];
      if (wantHeadings) {
        // Code symbols ride along (each file's best few, ranked with the headings).
        const hq = fileHash ? { query: fileHash[2].trim(), fileQuery: fileHash[1].trim(), limit: 80, symbols: true } : { query: body.trim(), limit: 80, symbols: true };
        const hits: HeadingHit[] = (await searchClient.headings(hq)) ?? [];
        headings = hits.map((h) => ({ kind: 'heading' as const, path: h.path, line: h.line, col: h.col, level: h.level, text: h.text, positions: h.positions, showPath: true, detail: h.kind, container: h.container }));
      }
      if (wantContent) {
        const r = await searchClient.search(q.trim(), { limit: 8, maxMatchesPerFile: 1, matchPaths: false }, 'palette');
        if (r && !r.error) content = r.results.filter((x) => x.matches[0]).map((x) => ({ kind: 'content' as const, path: x.path, m: x.matches[0], fuzzy: x.fuzzy }));
      }
      setAsyncItems({ key: asyncKey, content, headings, loading: false });
    }, wantHeadings ? 30 : 110);
    return () => clearTimeout(t);
  }, [asyncKey]);

  const sections: Section[] = [...syncSections];
  if (asyncItems.key === asyncKey) {
    if (asyncItems.headings.length) sections.push({ label: fileHash ? 'Headings' : undefined, items: asyncItems.headings });
    if (asyncItems.content.length) sections.push({ label: 'Found in content', items: asyncItems.content });
  }
  const flat = sections.flatMap((s) => s.items);
  latest.current = { q, flat };
  const selIdx = Math.min(sel, Math.max(0, flat.length - 1));

  useEffect(() => {
    listRef.current?.querySelector('.se-pal-item.selected')?.scrollIntoView({ block: 'nearest' });
  }, [selIdx, q]);

  const close = () => (app.overlay.value = null);

  // Keyboard flow: after picking, typing must continue in the editor (unless the action moved focus itself).
  const refocus = () =>
    requestAnimationFrame(() => {
      if (app.overlay.value === null && (!document.activeElement || document.activeElement === document.body)) app.editor?.focus();
    });
  const open = (path: string, reveal?: { line: number; col?: number; length?: number }) => void app.openFile(path, reveal).then(refocus, refocus);

  const pick = (it: Item | undefined) => {
    if (!it) return;
    picked.current = true;
    close();
    switch (it.kind) {
      case 'file':
        open(it.path, it.line !== undefined ? { line: it.line, col: it.col } : undefined);
        break;
      case 'command':
        touchRecentCommand(it.cmd.id);
        // Run after closing: the command may open another overlay.
        setTimeout(() => void Promise.resolve(it.cmd.run()).then(refocus, refocus), 0);
        break;
      case 'heading':
        open(it.path, { line: it.line, col: it.col });
        break;
      case 'line':
        open(it.path, { line: it.line, col: it.col });
        break;
      case 'content':
        open(it.path, { line: it.m.line, col: it.m.col ?? it.m.start, length: it.m.length ?? it.m.end - it.m.start });
        break;
    }
  };

  const onKey = (e: KeyboardEvent) => {
    const n = latest.current.flat.length;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) setSel((s) => (n ? (Math.min(s, n - 1) + 1) % n : 0));
    else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey && !e.shiftKey)) setSel((s) => (n ? (Math.min(s, n - 1) - 1 + n) % n : 0));
    else if (e.key === 'PageDown') setSel((s) => Math.min(n - 1, s + 10));
    else if (e.key === 'PageUp') setSel((s) => Math.max(0, s - 10));
    else if (e.key === 'Enter') {
      // Use the freshest list even if a render is still pending (fast typists + Enter).
      const cur = (e.currentTarget as HTMLInputElement).value;
      if (cur !== latest.current.q) {
        const m = modeOf(cur);
        const items = m === 'commands' ? commandItems(cur.slice(1).trim()) : m === 'files' && !/#|:\d/.test(cur) ? fileItems(cur.trim()) : latest.current.flat;
        pick(items[0]);
      } else pick(latest.current.flat[selIdx]);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  let idx = -1;
  const empty = !flat.length && !asyncItems.loading;
  return (
    <div class="se-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div class="se-palette se-omnibox" role="dialog" aria-label={mode === 'commands' ? 'Command palette' : 'Quick open'}>
        <div class="se-pal-inputrow">
          <span class="se-pal-mode">{mode === 'commands' ? <IconCommand /> : mode === 'wsHeadings' || mode === 'outline' ? <IconHeading /> : mode === 'line' ? <IconLine /> : <IconSearch />}</span>
          <input
            ref={input}
            class="se-palette-input"
            value={q}
            spellcheck={false}
            autocomplete="off"
            placeholder={PLACEHOLDER[mode]}
            aria-label={PLACEHOLDER[mode]}
            role="combobox"
            aria-expanded="true"
            aria-controls="se-pal-list"
            onInput={(e) => {
              setQ((e.target as HTMLInputElement).value);
              setSel(0);
            }}
            onKeyDown={onKey}
          />
        </div>
        <ul class="se-palette-list" id="se-pal-list" role="listbox" ref={listRef}>
          {sections.map((s) => (
            <>
              {s.label && s.items.length > 0 && <li class="se-pal-section" role="presentation">{s.label}</li>}
              {s.items.map((it) => {
                idx++;
                const i = idx;
                return (
                  <li
                    class={`se-pal-item se-pal-${it.kind}${i === selIdx ? ' selected' : ''}`}
                    role="option"
                    aria-selected={i === selIdx}
                    data-command-id={it.kind === 'command' ? it.cmd.id : undefined}
                    data-path={'path' in it ? it.path : undefined} onMouseDown={(e) => (e.preventDefault(), pick(it))} onMouseMove={() => i !== selIdx && setSel(i)}>
                    {renderItem(it)}
                  </li>
                );
              })}
            </>
          ))}
          {empty && <li class="se-pal-empty">{emptyText(mode, q)}</li>}
          {indexDeferred.value && mode === 'files' && q.trim().length >= 3 && <li class="se-pal-empty">File contents are indexed on demand. Ctrl+Shift+F searches them.</li>}
          {asyncItems.loading && !flat.length && <li class="se-pal-empty">{indexingNote() ?? 'Searching…'}</li>}
        </ul>
        <div class="se-pal-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>&gt;</kbd> commands
          </span>
          <span>
            <kbd>#</kbd> headings
          </span>
          <span>
            <kbd>@</kbd> in file
          </span>
          <span>
            <kbd>:</kbd> line
          </span>
        </div>
      </div>
    </div>
  );
}

function emptyText(mode: ReturnType<typeof modeOf>, q: string) {
  if (mode === 'commands') return 'No matching commands';
  if (mode === 'outline') return app.activePath.value ? 'No headings or symbols in this file' : 'No file open';
  if (mode === 'line') return app.activePath.value ? 'Type a line number' : 'No file open';
  if (mode === 'wsHeadings') return q.trim().length > 1 ? 'No matching headings or symbols' : 'No headings. Type to find code symbols too';
  return q.trim() ? 'No matching files' : 'No files';
}

function renderItem(it: Item) {
  switch (it.kind) {
    case 'file': {
      const base = basename(it.path);
      const dir = dirname(it.path);
      const off = it.path.length - base.length;
      return (
        <>
          <span class="se-pal-icon">{fileIcon(it.path)}</span>
          <span class="se-pal-main">
            <span class="se-pal-label">
              <HighlightPositions text={base} positions={it.positions} offset={off} />
            </span>
            {dir && (
              <span class="se-pal-desc">
                <HighlightPositions text={dir} positions={it.positions.filter((p) => p < dir.length)} />
              </span>
            )}
          </span>
          {it.line !== undefined && <span class="se-pal-meta">line {it.line + 1}</span>}
          {it.recent && <span class="se-pal-meta">recent</span>}
        </>
      );
    }
    case 'command': {
      const k = (it.cmd.keys ?? it.cmd.displayKeys)?.[0];
      return (
        <>
          <span class="se-pal-icon">
            <IconCommand />
          </span>
          <span class="se-pal-main">
            {it.cmd.category && <span class="se-pal-cat">{it.cmd.category}: </span>}
            {(() => {
              // Titles like "File: Save" carry their own category: render it muted.
              const pre = it.cmd.category ? null : /^([^:]{1,24}): /.exec(it.cmd.title);
              const off = pre ? pre[0].length : 0;
              return (
                <>
                  {pre && (
                    <span class="se-pal-cat">
                      <HighlightPositions text={pre[0]} positions={it.positions} />
                    </span>
                  )}
                  <span class="se-pal-label">
                    <HighlightPositions text={it.cmd.title.slice(off)} positions={it.positions} offset={off} />
                  </span>
                </>
              );
            })()}
            {it.via && <span class="se-pal-desc">{it.via}</span>}
          </span>
          {it.recent && <span class="se-pal-meta">recently used</span>}
          {k && <KeyCombo k={k} />}
        </>
      );
    }
    case 'heading':
      return (
        <>
          <span class="se-pal-icon">{it.detail ? <IconSymbol /> : <IconHeading />}</span>
          <span class="se-pal-main" style={{ paddingLeft: `${Math.max(0, it.level - 1) * (it.showPath ? 0 : 12)}px` }}>
            <span class="se-pal-label">
              <HighlightPositions text={it.text} positions={it.positions} />
            </span>
            {it.showPath && (
              <span class="se-pal-desc">
                {it.container ? `${it.container} · ` : ''}
                {it.path}
              </span>
            )}
          </span>
          <span class="se-pal-meta">{it.detail ?? `H${it.level}`}</span>
        </>
      );
    case 'line':
      return (
        <>
          <span class="se-pal-icon">
            <IconLine />
          </span>
          <span class="se-pal-main">
            <span class="se-pal-label">
              Go to line {it.line + 1}
              {it.col !== undefined ? `, column ${it.col + 1}` : ''}
            </span>
            <span class="se-pal-desc">{basename(it.path)}</span>
          </span>
        </>
      );
    case 'content': {
      const m = it.m;
      const ranges = m.ranges ?? [{ start: m.start, end: m.end }];
      const indent = m.lineText.length - m.lineText.trimStart().length;
      const cut = Math.max(indent, (ranges[0]?.start ?? 0) > 48 ? ranges[0].start - 30 : indent);
      return (
        <>
          <span class="se-pal-icon">{fileIcon(it.path)}</span>
          <span class="se-pal-main">
            <span class="se-pal-label se-pal-snippet">
              {cut > indent && '…'}
              <HighlightRanges text={m.lineText.slice(cut)} ranges={ranges.map((r) => ({ start: r.start - cut, end: r.end - cut })).filter((r) => r.end > 0)} />
            </span>
            <span class="se-pal-desc">
              {it.path}:{m.line + 1}
            </span>
          </span>
          {m.context === 'code' && m.lang && <span class="se-badge se-badge-code">{m.lang}</span>}
          {it.fuzzy && <span class="se-badge se-badge-fuzzy">≈</span>}
        </>
      );
    }
  }
}

export function openPalette(initial = '') {
  app.overlay.value = () => <Palette initial={initial} />;
}

