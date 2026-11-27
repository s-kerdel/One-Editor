// "Find in files" sidebar panel: live as-you-type search with toggles, parsed-query chips, grouped results,
// context badges, keyboard navigation, history, and replace-in-files with preview + undo.
import { effect, signal, untracked } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { app } from '../app/app';
import { sidebarWidth } from '../app/ui';
import { basename, dirname } from '@shared/paths';
import { describeQuery, highlightPattern, parseQuery } from '../../search/query';
import { previewLine } from '../../search/replace';
import type { SearchMatch, SearchOptions, SearchResult } from '../../search/types';
import { searchClient } from './client';
import { HighlightRanges } from './highlight';
import { IconChevron, IconClose, IconCollapse, IconRefresh, IconReplace, fileIcon } from './icons';
import { replaceInFiles, undoReplace, type UndoEntry } from './replaceFiles';
import { collapsed, focusTick, getHistory, matchCase, pushHistory, query, replaceText, response, searching, selected, showReplace, useRegex, wholeWord } from './state';

const DEBOUNCE_MS = 90;
const RENDER_STEP = 400;
const renderLimit = signal(RENDER_STEP);
const undoBatch = signal<{ entries: UndoEntry[]; label: string } | null>(null);
const replaceBusy = signal(false);
const dismissed = signal<Set<string>>(new Set());

export function searchOptions(): SearchOptions {
  return {
    caseSensitive: matchCase.value ? true : 'smart',
    wholeWord: wholeWord.value,
    regex: useRegex.value,
    // Replace works on the literal text (or regex), not on AND-ed terms.
    literal: showReplace.value && !useRegex.value,
    limit: 300,
    maxMatchesPerFile: 100,
  };
}

// ---------------------------------------------------------------- running searches

let timer: ReturnType<typeof setTimeout> | null = null;
let lastKey = '';
let lastQuery = '';

export function runSearchNow() {
  if (timer) clearTimeout(timer);
  timer = null;
  const q = query.value;
  const opts = searchOptions();
  lastKey = JSON.stringify([q, opts]);
  if (q !== lastQuery) {
    lastQuery = q;
    selected.value = -1;
    collapsed.value = new Set();
  }
  if (!q.trim()) {
    response.value = null;
    searching.value = false;
    app.editor?.highlightSearch?.(null);
    return;
  }
  searching.value = true;
  const key = lastKey;
  // Progressive: answers from what is indexed so far; the version bumps while indexing re-run it.
  void searchClient.search(q, opts, 'panel', { progressive: true }).then((r) => {
    if (!r || key !== lastKey) return; // superseded
    searching.value = false;
    // A live refresh (edit elsewhere, index progress) that found the same rows: keep the rendered
    // list — re-diffing hundreds of rows per refresh made typing in a big note stutter.
    const sig = resultSignature(r);
    const prev = response.value;
    if (prev && key === shownKey && sig === shownSig && prev.partial === r.partial && prev.totalFiles === r.totalFiles && prev.totalMatches === r.totalMatches) return;
    shownKey = key;
    shownSig = sig;
    dismissed.value = new Set();
    response.value = r;
    renderLimit.value = RENDER_STEP;
    if (selected.value >= flatRows().length) selected.value = -1;
  });
}

let shownKey = '';
let shownSig = 0;

/** Cheap structural hash of what the list shows (paths, counts, rows). */
function resultSignature(r: { results: SearchResult[] }): number {
  let h = 0x811c9dc5;
  const mix = (s: string) => {
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  };
  for (const x of r.results) {
    mix(x.path);
    h = Math.imul(h ^ x.totalMatches, 0x01000193);
    for (const m of x.matches) {
      h = Math.imul(h ^ (m.line * 31 + m.start * 7 + m.end), 0x01000193);
      mix(m.lineText);
    }
  }
  return h >>> 0;
}

function scheduleSearch(delay = DEBOUNCE_MS) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(runSearchNow, delay);
}

const panelVisible = () => app.sidebarVisible.value && app.sidebarPanel.value === 'search';

let installed = false;
export function installPanelEffects() {
  if (installed) return;
  installed = true;
  // Re-run when the query or toggles change.
  effect(() => {
    void query.value;
    void matchCase.value;
    void wholeWord.value;
    void useRegex.value;
    void showReplace.value;
    scheduleSearch(query.value.length <= 1 ? 140 : DEBOUNCE_MS);
  });
  // Live refresh when the index changes (edits, saves, external changes) while the panel is visible.
  // While changes keep coming (typing in a note, indexing progress) it waits for a pause.
  let lastVersion = -1;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let lastBump = 0;
  effect(() => {
    const v = searchClient.version.value;
    if (v === lastVersion) return;
    const first = lastVersion === -1;
    lastVersion = v; // always: a stale version would turn every later keystroke into a "refresh"
    if (first) return;
    const now = performance.now();
    const burst = now - lastBump < 600;
    lastBump = now;
    // Untracked: typing in the query is handled above, and its short debounce must not be replaced by this slower one.
    if (!untracked(() => !!query.value.trim() && panelVisible())) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(
      () => {
        refreshTimer = null;
        if (!timer) runSearchNow();
      },
      burst ? 800 : 250,
    );
  });
}

// ---------------------------------------------------------------- flat rows + navigation

type Row = { kind: 'file'; r: SearchResult } | { kind: 'match'; r: SearchResult; m: SearchMatch; i: number };

function visibleResults(): SearchResult[] {
  const res = response.value?.results ?? [];
  const d = dismissed.value;
  return d.size ? res.filter((r) => !d.has(r.path)) : res;
}

/**
 * Real hit lines. A file found only by its name / extension (a query like "yaml") carries one synthetic `path` row instead:
 * not a hit to show or fold, the file row itself opens the file.
 */
const hasHits = (r: SearchResult) => r.matches.some((m) => m.context !== 'path');

export function flatRows(): Row[] {
  const rows: Row[] = [];
  const col = collapsed.value;
  for (const r of visibleResults()) {
    rows.push({ kind: 'file', r });
    if (hasHits(r) && !col.has(r.path)) r.matches.forEach((m, i) => rows.push({ kind: 'match', r, m, i }));
  }
  return rows;
}

function applyEditorHighlight() {
  const pq = parseQuery(query.value, { regex: useRegex.value, literal: showReplace.value && !useRegex.value, caseSensitive: matchCase.value ? true : 'smart' });
  const pat = pq.error ? null : highlightPattern(pq);
  app.editor?.highlightSearch?.(pat ? { ...pat, wholeWord: wholeWord.value } : null);
}

export async function openMatch(path: string, m: SearchMatch | null, keepFocus?: HTMLElement | null) {
  if (!m || m.context === 'path') await app.openFile(path, { line: 0 });
  else await app.openFile(path, { line: m.line, col: m.col ?? (m.lineTextOffset ?? 0) + m.start, length: m.length ?? m.end - m.start });
  applyEditorHighlight();
  if (keepFocus) requestAnimationFrame(() => requestAnimationFrame(() => keepFocus.focus()));
}

/** F4 / Shift-F4: step through results (expanding collapsed groups) and open the hit. */
export function stepResult(dir: 1 | -1) {
  if (!response.value?.results.length) return;
  if (collapsed.value.size) collapsed.value = new Set();
  const rows = flatRows();
  let i = selected.value;
  for (let n = 0; n < rows.length; n++) {
    i = (i + dir + rows.length) % rows.length;
    const r = rows[i];
    if (r.kind === 'match' || !hasHits(r.r)) break; // a hit line, or a file found by its name only
  }
  const row = rows[i];
  if (!row || (row.kind === 'file' && hasHits(row.r))) return;
  selected.value = i;
  void openMatch(row.r.path, row.kind === 'match' ? row.m : null);
}

// ---------------------------------------------------------------- replace actions

async function doReplace(targets: Array<{ path: string; lines?: number[] }>) {
  if (replaceBusy.value) return;
  replaceBusy.value = true;
  try {
    const opts = searchOptions();
    const out = await replaceInFiles(targets, query.value, opts, replaceText.value);
    if (out.errors.length) app.toast(out.errors[0], 'error');
    if (out.replaced) {
      const label = `Replaced ${out.replaced} occurrence${out.replaced === 1 ? '' : 's'} in ${out.files} file${out.files === 1 ? '' : 's'}`;
      undoBatch.value = { entries: out.undo, label };
      app.toast(label, 'success');
    }
  } finally {
    replaceBusy.value = false;
    runSearchNow();
  }
}

async function replaceAll() {
  // The visible response may be truncated: fetch every matching path first.
  const all = await searchClient.search(query.value, { ...searchOptions(), limit: 1_000_000, maxMatchesPerFile: 1, fuzzy: false }, 'replace-all');
  if (!all || all.error) return app.toast(all?.error ?? 'Search failed', 'error');
  const paths = all.results.filter((r) => r.totalMatches > 0 && !dismissed.value.has(r.path)).map((r) => r.path);
  await doReplace(paths.map((path) => ({ path })));
}

async function undoLast() {
  const b = undoBatch.value;
  if (!b) return;
  undoBatch.value = null;
  const r = await undoReplace(b.entries);
  app.toast(r.skipped.length ? `Undid ${r.reverted} file(s); ${r.skipped.length} changed since and were skipped` : `Undid replace in ${r.reverted} file(s)`, r.skipped.length ? 'info' : 'success');
  runSearchNow();
}

// ---------------------------------------------------------------- component

// [shown syntax, text inserted on click, label]
const HINTS: Array<[string, string, string]> = [
  ['"exact phrase"', '""', 'phrase'],
  ['-"text"', '-', 'exclude by name and content'],
  ['a OR b', 'OR ', 'either'],
  ['/regex/i', '//', 'regex'],
  ['path:notes/', 'path:', 'folder'],
  ['ext:md', 'ext:', 'extension'],
  ['lang:bash', 'lang:', 'code language'],
  ['in:code', 'in:code ', 'only code'],
  ['in:heading', 'in:heading ', 'headings'],
  ['tag:idea', 'tag:', 'tag'],
  ['case:yes', 'case:yes ', 'match case'],
];

function contextBadge(m: SearchMatch) {
  switch (m.context) {
    case 'code':
      return <span class="se-badge se-badge-code" title={`Code${m.lang ? ` (${m.lang})` : ''}`}>{m.lang || 'code'}</span>;
    case 'inline-code':
      return <span class="se-badge se-badge-inline" title="Inline code">`code`</span>;
    case 'heading':
      return <span class="se-badge se-badge-heading" title="Heading">H{m.headingLevel ?? ''}</span>;
    case 'frontmatter':
      return <span class="se-badge se-badge-fm" title="Frontmatter">yaml</span>;
    case 'link':
      return <span class="se-badge se-badge-link" title="Link">link</span>;
    case 'path':
      return <span class="se-badge se-badge-path" title="File name">name</span>;
    default:
      return null;
  }
}

/** Trim leading context so the first hit is visible in the sidebar's actual width. */
function snippet(m: SearchMatch, availChars: number): { text: string; ranges: SearchMatch['ranges'] & {}; lead: boolean } {
  let text = m.lineText;
  let ranges = m.ranges ?? [{ start: m.start, end: m.end }];
  const indent = text.length - text.trimStart().length;
  let cut = indent;
  const first = ranges[0] ?? { start: 0, end: 0 };
  const firstEnd = Math.min(first.end, first.start + availChars - 6);
  // keep ~8 chars of context before the hit, but only cut when the hit would be off-screen
  if (firstEnd - cut > availChars - 2) cut = Math.max(cut, Math.min(first.start - 8, firstEnd - availChars + 8));
  if (cut > 0 && first.start >= cut) {
    text = text.slice(cut);
    ranges = ranges.map((r) => ({ start: r.start - cut, end: r.end - cut })).filter((r) => r.end > 0);
  }
  return { text, ranges, lead: cut > indent || (m.lineTextOffset ?? 0) > 0 };
}

function plural(n: number, w: string) {
  return `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
}

/** "Indexing 4,210 / 18,000 files" while a (re)build runs; results above it are partial. */
function IndexProgress() {
  const p = searchClient.progress.value;
  return (
    <span class="se-search-progress" data-testid="search-progress">
      <span class="se-spinner" aria-hidden="true" />
      {p && p.total ? `Indexing ${p.done.toLocaleString()} / ${plural(p.total, 'file')}` : 'Indexing workspace…'}
    </span>
  );
}

export function SearchPanel() {
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const histIdx = useRef(-1);

  useEffect(() => {
    void searchClient.start();
  }, []);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    // A panel that mounts late (lazy chunk after a reload) must not take focus from a dialog the user
    // is already typing in (palette, settings).
    if (app.overlay.value && focusTick.value === 0) return;
    // Already in another field of this panel (the replace box, focused before this effect ran after
    // paint): keep it — moving focus now sends the next keystrokes into the query.
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== el && active.matches('input, textarea') && el.closest('.se-search')?.contains(active)) return;
    el.focus();
    el.select();
  }, [focusTick.value]);
  useEffect(() => {
    list.current?.querySelector('.se-sr-row.selected')?.scrollIntoView({ block: 'nearest' });
  }, [selected.value]);

  const res = response.value;
  const rows = flatRows();
  const rowsShown = rows.slice(0, renderLimit.value);
  const opts = searchOptions();
  const pq = query.value.trim() ? parseQuery(query.value, { regex: opts.regex, literal: opts.literal, caseSensitive: opts.caseSensitive }) : null;
  const chips = pq && (pq.hasOperators || pq.filters.length) ? describeQuery(pq) : [];
  const status = searchClient.status.value;
  // ~7.2px per mono char at 12px; minus gutter, line number and badge
  const availChars = Math.max(16, Math.floor(((list.current?.clientWidth || sidebarWidth.value) - 120) / 7.2));

  const onInputKey = (e: KeyboardEvent) => {
    const el = e.currentTarget as HTMLInputElement;
    if (e.altKey && ['c', 'w', 'r'].includes(e.key.toLowerCase())) {
      const k = e.key.toLowerCase();
      if (k === 'c') matchCase.value = !matchCase.value;
      if (k === 'w') wholeWord.value = !wholeWord.value;
      if (k === 'r') useRegex.value = !useRegex.value;
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowUp' && (!el.value || histIdx.current >= 0)) {
      const h = getHistory();
      if (!h.length) return;
      histIdx.current = Math.min(histIdx.current + 1, h.length - 1);
      query.value = h[histIdx.current];
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowDown') {
      if (histIdx.current >= 0) {
        histIdx.current--;
        query.value = histIdx.current >= 0 ? getHistory()[histIdx.current] : '';
      } else if (rows.length) {
        selected.value = rows.findIndex((r) => r.kind === 'match');
        list.current?.focus();
      }
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter') {
      pushHistory(query.value);
      histIdx.current = -1;
      if (timer) runSearchNow();
      const target = rows[selected.value]?.kind === 'match' ? rows[selected.value] : rows.find((r) => r.kind === 'match');
      if (target && target.kind === 'match') {
        selected.value = rows.indexOf(target);
        void openMatch(target.r.path, target.m);
      }
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      app.editor?.focus();
      e.preventDefault();
    }
  };

  const onListKey = (e: KeyboardEvent) => {
    const cur = rows[selected.value];
    const move = (to: number) => {
      selected.value = Math.max(0, Math.min(rows.length - 1, to));
      e.preventDefault();
    };
    switch (e.key) {
      case 'ArrowDown':
        return move(selected.value + 1);
      case 'ArrowUp':
        if (selected.value <= 0) {
          input.current?.focus();
          selected.value = -1;
          e.preventDefault();
          return;
        }
        return move(selected.value - 1);
      case 'Home':
        return move(0);
      case 'End':
        return move(rows.length - 1);
      case 'PageDown':
        return move(selected.value + 15);
      case 'PageUp':
        return move(selected.value - 15);
      case 'ArrowLeft':
        if (cur?.kind === 'match') return move(rows.findIndex((r) => r.kind === 'file' && r.r === cur.r));
        if (cur?.kind === 'file' && hasHits(cur.r)) toggleGroup(cur.r.path, true);
        e.preventDefault();
        return;
      case 'ArrowRight':
        if (cur?.kind === 'file' && hasHits(cur.r)) toggleGroup(cur.r.path, false);
        e.preventDefault();
        return;
      case 'Enter':
        if (cur?.kind === 'file') {
          if (hasHits(cur.r)) toggleGroup(cur.r.path);
          else void openMatch(cur.r.path, null, list.current);
        } else if (cur?.kind === 'match') void openMatch(cur.r.path, cur.m, list.current);
        e.preventDefault();
        return;
      case 'Delete':
        if (cur) dismiss(cur.r.path);
        e.preventDefault();
        return;
      case 'Escape':
        input.current?.focus();
        e.preventDefault();
        return;
    }
  };

  return (
    <div class="se-search" data-testid="search-panel">
      <div class="se-search-head">
        <span class="se-search-title">Search</span>
        <span class="se-search-tools">
          <button class="se-icon-btn" title="Refresh" aria-label="Refresh" onClick={() => runSearchNow()}>
            <IconRefresh />
          </button>
          <button
            class="se-icon-btn"
            title="Collapse / expand all"
            aria-label="Collapse all"
            onClick={() => {
              const all = visibleResults().map((r) => r.path);
              collapsed.value = collapsed.value.size ? new Set() : new Set(all);
            }}
          >
            <IconCollapse />
          </button>
          <button
            class="se-icon-btn"
            title="Clear"
            aria-label="Clear search"
            onClick={() => {
              query.value = '';
              replaceText.value = '';
              input.current?.focus();
            }}
          >
            <IconClose />
          </button>
        </span>
      </div>

      <div class="se-search-form">
        <button class={`se-icon-btn se-replace-toggle${showReplace.value ? ' on' : ''}`} title="Toggle replace (Ctrl+Shift+H)" aria-label="Toggle replace" aria-expanded={showReplace.value} onClick={() => (showReplace.value = !showReplace.value)}>
          <IconChevron open={showReplace.value} />
        </button>
        <div class="se-search-fields">
          <div class={`se-search-box${res?.error ? ' error' : ''}`}>
            <input
              ref={input}
              class="se-search-input"
              type="text"
              spellcheck={false}
              autocomplete="off"
              placeholder="Search text, code, commands…"
              aria-label="Search query"
              value={query.value}
              onInput={(e) => {
                histIdx.current = -1;
                query.value = (e.target as HTMLInputElement).value;
              }}
              onKeyDown={onInputKey}
            />
            <span class="se-toggles">
              <button class={`se-toggle${matchCase.value ? ' on' : ''}`} title="Match case (Alt+C)" aria-label="Match case" aria-pressed={matchCase.value} onClick={() => (matchCase.value = !matchCase.value)}>
                Aa
              </button>
              <button class={`se-toggle se-toggle-ww${wholeWord.value ? ' on' : ''}`} title="Match whole word (Alt+W)" aria-label="Match whole word" aria-pressed={wholeWord.value} onClick={() => (wholeWord.value = !wholeWord.value)}>
                ab
              </button>
              <button class={`se-toggle${useRegex.value ? ' on' : ''}`} title="Use regular expression (Alt+R)" aria-label="Use regular expression" aria-pressed={useRegex.value} onClick={() => (useRegex.value = !useRegex.value)}>
                .*
              </button>
            </span>
          </div>
          {showReplace.value && (
            <div class="se-search-box se-replace-box">
              <input
                class="se-search-input se-replace-input"
                type="text"
                spellcheck={false}
                placeholder={useRegex.value ? 'Replace ($1, $<name>, \\n)' : 'Replace'}
                aria-label="Replace with"
                value={replaceText.value}
                onInput={(e) => (replaceText.value = (e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    void replaceAll();
                  }
                }}
              />
              <button class="se-btn se-replace-all" title="Replace all (Ctrl+Enter)" aria-label="Replace all" disabled={!res?.totalMatches || replaceBusy.value} onClick={() => void replaceAll()}>
                <IconReplace /> All
              </button>
            </div>
          )}
        </div>
      </div>

      {chips.length > 0 && (
        <div class="se-chips" aria-label="Query interpretation">
          {chips.map((c) => {
            // An exclusion is shown in the syntax the user can actually type: a plain word / phrase as
            // `-"word"`. A regex or OR exclusion keeps the plain − prefix (quoting those would be wrong).
            const bare = c.label.replace(/^"|"$/g, '');
            const typable = c.kind === 'exclude' && !c.label.startsWith('/') && !c.label.includes(' OR ');
            const text = typable ? `-"${bare}"` : c.label;
            return (
              <span class={`se-chip se-chip-${c.kind}`} title={c.kind === 'exclude' ? 'Excluded from name and content (prefix \\ to search literally)' : c.kind}>
                {c.kind === 'exclude' ? (typable ? '' : '−') : c.kind === 'nfilter' ? '−' : ''}
                {text}
              </span>
            );
          })}
        </div>
      )}
      {pq?.warnings.map((w) => <div class="se-search-warn">{w}</div>)}

      <div class="se-search-status" aria-live="polite">
        {status === 'indexing' && <IndexProgress />}
        {res?.error ? (
          <span class="se-search-error">{res.error}</span>
        ) : res && query.value.trim() ? (
          <span class="se-search-summary">
            {res.totalMatches || res.totalFiles ? (
              <>
                {plural(res.totalMatches, 'result')} in {plural(res.totalFiles, 'file')} <span class="se-faint">({res.tookMs < 10 ? res.tookMs.toFixed(1) : Math.round(res.tookMs)} ms)</span>
                {res.truncated && <span class="se-faint"> · showing first {res.results.length}</span>}
              </>
            ) : (
              <>No results <span class="se-faint">({res.tookMs.toFixed(1)} ms)</span></>
            )}
          </span>
        ) : null}
        {searching.value && <span class="se-faint"> …</span>}
      </div>

      {res?.fuzzy && res.corrections?.length ? (
        <div class="se-search-fuzzy">
          No exact matches. Showing results for{' '}
          {res.corrections.map((c, i) => (
            <span>
              {i > 0 && ', '}
              <b>{c.to[0]}</b>
              {c.to.length > 1 && <span class="se-faint"> +{c.to.length - 1}</span>}
            </span>
          ))}
        </div>
      ) : null}

      {res?.suggestions?.length ? (
        <div class="se-search-fuzzy se-search-suggest">
          Did you mean{' '}
          {res.suggestions.map((sg, i) => (
            <span>
              {i > 0 && ', '}
              <button class="se-link" onClick={() => (query.value = query.value.split(sg.from).join(sg.to))}>
                {sg.to}
              </button>
            </span>
          ))}
          ?
        </div>
      ) : null}

      {showReplace.value && !useRegex.value && query.value.trim() && <div class="se-search-note">Literal replace · enable <code>.*</code> for regex with <code>$1</code></div>}

      {undoBatch.value && (
        <div class="se-undo-bar">
          <span>{undoBatch.value.label}</span>
          <button class="se-btn" onClick={() => void undoLast()}>
            Undo
          </button>
        </div>
      )}

      {!query.value.trim() && (
        <div class="se-search-hints">
          <div class="se-hints-title">Search exactly (punctuation included)</div>
          <div class="se-hints-examples">
            <code>--force-with-lease</code> <code>User::query()</code> <code>C:\Users</code>
          </div>
          <div class="se-hints-grid">
            {HINTS.map(([syntax, ins, label]) => (
              <button
                class="se-hint"
                title={`Insert ${syntax}`}
                onClick={() => {
                  query.value = (query.value ? query.value + ' ' : '') + ins;
                  input.current?.focus();
                }}
              >
                <code>{syntax}</code>
                <span>{label}</span>
              </button>
            ))}
          </div>
          <div class="se-hints-foot">
            <kbd>↑</kbd> history · <kbd>↓</kbd> results · <kbd>F4</kbd> next hit
          </div>
        </div>
      )}

      <div class="se-search-results" ref={list} tabIndex={0} role="tree" aria-label="Search results" onKeyDown={onListKey}>
        {rowsShown.map((row, idx) => {
          const sel = idx === selected.value;
          if (row.kind === 'file') {
            const r = row.r;
            // A file found only by its name / extension has no hit lines to show: no group to fold, a click opens the file.
            const hits = hasHits(r);
            const open = hits && !collapsed.value.has(r.path);
            const base = basename(r.path);
            const dir = dirname(r.path);
            const off = r.path.length - base.length;
            const baseRanges = (r.pathRanges ?? []).filter((x) => x.end > off).map((x) => ({ start: Math.max(0, x.start - off), end: x.end - off }));
            const dirRanges = (r.pathRanges ?? []).filter((x) => x.start < dir.length).map((x) => ({ start: x.start, end: Math.min(x.end, dir.length) }));
            return (
              <div
                class={`se-sr-row se-sr-file${sel ? ' selected' : ''}`}
                role="treeitem"
                aria-expanded={hits ? open : undefined}
                data-path={r.path}
                title={r.path}
                onClick={() => {
                  selected.value = idx;
                  if (hits) toggleGroup(r.path);
                  else void openMatch(r.path, null);
                }}
              >
                <span class="se-sr-caret">{hits && <IconChevron open={open} />}</span>
                <span class="se-sr-icon">{fileIcon(r.path)}</span>
                <span class="se-sr-name">
                  <HighlightRanges text={base} ranges={baseRanges} cls="se-hit-path" />
                </span>
                {dir && (
                  <span class="se-sr-dir">
                    <HighlightRanges text={dir} ranges={dirRanges} cls="se-hit-path" />
                  </span>
                )}
                {r.fuzzy && <span class="se-badge se-badge-fuzzy" title="Typo-tolerant match">≈</span>}
                <span class="se-sr-actions">
                  {showReplace.value && r.totalMatches > 0 && (
                    <button
                      class="se-icon-btn"
                      title="Replace all in this file"
                      aria-label="Replace all in file"
                      onClick={(e) => {
                        e.stopPropagation();
                        void doReplace([{ path: r.path }]);
                      }}
                    >
                      <IconReplace />
                    </button>
                  )}
                  <button
                    class="se-icon-btn"
                    title="Dismiss"
                    aria-label="Dismiss file"
                    onClick={(e) => {
                      e.stopPropagation();
                      dismiss(r.path);
                    }}
                  >
                    <IconClose />
                  </button>
                </span>
                <span class="se-sr-count">{r.totalMatches || ''}</span>
              </div>
            );
          }
          const m = row.m;
          const sn = snippet(m, availChars);
          const parts = showReplace.value && m.context !== 'path' ? previewLine(sn.text, sn.ranges, query.value, opts, replaceText.value) : null;
          return (
            <div
              class={`se-sr-row se-sr-match${sel ? ' selected' : ''}`}
              role="treeitem"
              data-path={row.r.path}
              data-line={m.line}
              data-context={m.context}
              onClick={() => {
                selected.value = idx;
                void openMatch(row.r.path, m);
              }}
            >
              <span class="se-sr-ln">{m.context === 'path' ? '' : m.line + 1}</span>
              <span class="se-sr-text">
                {sn.lead && <span class="se-faint">…</span>}
                {parts ? parts.map((p) => (p.kind === 'keep' ? p.text : <mark class={p.kind === 'del' ? 'se-del' : 'se-ins'}>{p.text}</mark>)) : <HighlightRanges text={sn.text} ranges={sn.ranges} />}
              </span>
              {contextBadge(m)}
              {showReplace.value && m.context !== 'path' && (
                <span class="se-sr-actions">
                  <button
                    class="se-icon-btn"
                    title="Replace"
                    aria-label="Replace this line"
                    onClick={(e) => {
                      e.stopPropagation();
                      void doReplace([{ path: row.r.path, lines: [m.line] }]);
                    }}
                  >
                    <IconReplace />
                  </button>
                </span>
              )}
            </div>
          );
        })}
        {rows.length > rowsShown.length && (
          <button class="se-btn se-more" onClick={() => (renderLimit.value += RENDER_STEP)}>
            Show more ({(rows.length - rowsShown.length).toLocaleString()} rows)
          </button>
        )}
        {res && res.results.some((r) => r.totalMatches > r.matches.length) && <div class="se-faint se-sr-capped">Some files have more hits than shown. Open the file to see all.</div>}
      </div>
    </div>
  );
}

function toggleGroup(path: string, force?: boolean) {
  const s = new Set(collapsed.value);
  const close = force ?? !s.has(path);
  if (close) s.add(path);
  else s.delete(path);
  collapsed.value = s;
}

function dismiss(path: string) {
  dismissed.value = new Set([...dismissed.value, path]);
}
