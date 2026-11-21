// Go to definition / Find usages — the lazy chunk behind Ctrl/Cmd+click, F12 and Shift+F12 in code
// files (../editor/gotodef.ts forwards them; nothing of this ships at startup). Resolution is the pure
// ../../search/goto/resolve; this module gives it the app: open documents' live text, the backend's
// file RPC (vendor/ is readable though never indexed), the file tree, and the search shards' symbol
// index. One hit → jump; several → a picker; none → a toast with "Search in files".
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { languageForPath } from '@shared/languages';
import type { TreeNode } from '@shared/api';
import { app } from '../app/app';
import { familyLangs } from '../../search/symbols';
import type { DefHit } from '../../search/defs';
import { identAt } from '../../search/goto/context';
import { dirOf } from '../../search/goto/paths';
import { resolveDefinition, type GotoEnv, type GotoRequest, type GotoResult } from '../../search/goto/resolve';
import '../app/overlays.css';
import './gotodef.css';

export type { GotoRequest };

/** Files the resolver may read whole (bigger ones are treated as missing). */
const MAX_READ_CHARS = 4_000_000;
/** How long a lookup waits for the index to finish before giving up quietly. */
const INDEX_WAIT_MS = 20_000;
/** PSR-4 maps are re-read after this (vendor/ is not watched, `composer install` changes it). */
const MEMO_MS = 30_000;

const langOf = (path: string) => languageForPath(path)?.id ?? '';
const short = (name: string) => (name.length > 60 ? `${name.slice(0, 59)}…` : name);

// ---- environment

let memo = new Map<string, unknown>();
let memoAt = 0;
let wired = false;
function freshMemo() {
  if (!wired) {
    wired = true;
    const drop = () => void (memo = new Map());
    app.events.on('workspace:opened', drop);
    app.events.on('file:updated', (p) => /(?:^|\/)composer\.json$|autoload_psr4\.php$/.test(p) && drop());
    app.events.on('files:changed', (ps) => ps.some((p) => /(?:^|\/)composer\.json$|autoload_psr4\.php$/.test(p)) && drop());
  }
  if (performance.now() - memoAt > MEMO_MS) {
    memo = new Map();
    memoAt = performance.now();
  }
  return memo;
}

/** Tree spellings of files and folders (folded when the folder is case-insensitive), rebuilt per tree. */
let treeIdx: { tree: TreeNode | null; fold: boolean; files: Map<string, string>; dirs: Set<string>; complete: boolean } | null = null;
function tree() {
  const t = app.tree.value;
  const fold = app.workspace.value?.caseSensitive === false;
  if (treeIdx && treeIdx.tree === t && treeIdx.fold === fold) return treeIdx;
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const key = (p: string) => (fold ? p.toLowerCase() : p);
  const walk = (n: TreeNode) => {
    if (n.kind === 'file') files.set(key(n.path), n.path);
    else {
      dirs.add(key(n.path));
      n.children?.forEach(walk);
    }
  };
  if (t) walk(t);
  return (treeIdx = { tree: t, fold, files, dirs, complete: !!t && !t.truncated });
}

function known(path: string): string | null | undefined {
  const t = tree();
  const k = t.fold ? path.toLowerCase() : path;
  const hit = t.files.get(k);
  if (hit) return hit;
  // Listed folder, unlisted file → it doesn't exist (excluded folders such as vendor/ are not listed: unknown).
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dir = dirOf(path);
  if (t.complete && !name.startsWith('.') && t.dirs.has(t.fold ? dir.toLowerCase() : dir)) return null;
  return undefined;
}

async function read(path: string): Promise<string | null> {
  const doc = app.docs.get(path);
  if (doc) return doc.binary ? null : (app.editor?.getContent(path) ?? doc.content);
  try {
    const f = await app.backend.readFile(path);
    return f.binary || f.content.length > MAX_READ_CHARS ? null : f.content;
  } catch {
    return null;
  }
}

/**
 * The search implementation (index client). Imported here rather than through the startup stub
 * (./index): a static import of a startup module from this chunk split app/lazy into a chunk of its own.
 */
const loadSearch = () =>
  import('./impl').then((m) => {
    m.installSearchImpl(); // idempotent; the stub's loader calls it too
    return m;
  });

async function makeEnv(): Promise<GotoEnv> {
  const { searchClient } = await loadSearch();
  return {
    read,
    known,
    memo: freshMemo(),
    lookup: (q) => searchClient.definitions(q),
    complete: () => searchClient.status.value === 'ready',
  };
}

// ---- actions

/** Go to definition of the name at `req` (line / col 0-based). */
export async function goToDefinition(req: GotoRequest): Promise<void> {
  const from = app.activePath.value;
  const env = await makeEnv();
  let r = await resolveDefinition(req, env);
  if (!r.ident) return void app.toast('No name at the cursor', 'info', 2200);
  if (r.pending) {
    // The index is still being built: say so (never "not found"), then try once more when it is done.
    const { searchClient } = await loadSearch();
    const p = searchClient.progress.value;
    const toast = app.toast(`Indexing${p?.total ? ` ${p.done.toLocaleString()} / ${p.total.toLocaleString()} files` : '…'} — looking for ${short(r.ident.name)}`, 'info', INDEX_WAIT_MS);
    await Promise.race([searchClient.whenReady(), new Promise((res) => setTimeout(res, INDEX_WAIT_MS))]);
    app.dismissToast(toast);
    if (app.activePath.value !== from) return; // the user moved on
    r = await resolveDefinition(req, env);
    if (r.pending && !r.hits.length) return void app.toast(`Still indexing — try ${short(r.ident!.name)} again in a moment`, 'info', 3500);
  }
  show(r, req);
}

function show(r: GotoResult, req: GotoRequest) {
  const name = short(r.ident!.name);
  if (!r.hits.length) return void app.toast(`No definition found for ${name}`, 'info', 5000, [{ label: 'Search in files', run: () => findUsages(req) }]);
  if (r.self) return void app.toast(`${name} is defined here`, 'info', 3500, [{ label: 'Find usages', run: () => findUsages(req) }]);
  if (r.hits.length === 1) return jump(r.hits[0]);
  openPicker(r.ident!.name, r.hits);
}

function jump(h: DefHit) {
  // A jump inside the file is a navigation however short (Alt+← returns); other files are recorded anyway.
  if (h.path === app.activePath.value) app.markNavigation?.();
  void app.openFile(h.path, { line: h.line, col: h.col });
}

/** Find in files for the name at `req`: whole word, exact case, the file's language family. */
export function findUsages(req: GotoRequest) {
  const lang = langOf(req.path);
  const line = req.content.split('\n', req.line + 1)[req.line] ?? '';
  const id = identAt(line, req.col, lang);
  if (!id) return void app.toast('No name at the cursor', 'info', 2200);
  const langs = /^(--|\$|@)/.test(id.name) ? familyLangs('css') : familyLangs(lang);
  const q = `"${id.name.replace(/"/g, '')}"${langs.length ? ` lang:${langs.join(',')}` : ''} case:yes`;
  app.openSearch?.(q, { wholeWord: true, regex: false });
}

// ---- picker

function openPicker(name: string, hits: DefHit[]) {
  app.overlay.value = () => <DefPicker name={name} hits={hits} />;
}

function matches(h: DefHit, q: string) {
  if (!q) return true;
  const hay = `${h.container ?? ''} ${h.name} ${h.path} ${h.kind}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.includes(w));
}

export function DefPicker({ name, hits }: { name: string; hits: DefHit[] }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const shown = useMemo(() => hits.filter((h) => matches(h, q.trim())), [hits, q]);
  const idx = Math.min(sel, Math.max(0, shown.length - 1));
  useLayoutEffect(() => input.current?.focus(), []); // before the first paint: no typed key is lost
  useEffect(() => list.current?.querySelector('.selected')?.scrollIntoView({ block: 'nearest' }), [idx, q]);

  const close = (refocus = true) => {
    app.overlay.value = null;
    if (refocus) requestAnimationFrame(() => app.editor?.focus());
  };
  const pick = (h: DefHit | undefined) => {
    if (!h) return;
    close(false);
    jump(h);
  };
  const onKey = (e: KeyboardEvent) => {
    const n = shown.length;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown') setSel(n ? (idx + 1) % n : 0);
    else if (e.key === 'ArrowUp') setSel(n ? (idx - 1 + n) % n : 0);
    else if (e.key === 'PageDown') setSel(Math.min(n - 1, idx + 8));
    else if (e.key === 'PageUp') setSel(Math.max(0, idx - 8));
    else if (e.key === 'Home' && e.ctrlKey) setSel(0);
    else if (e.key === 'End' && e.ctrlKey) setSel(n - 1);
    else if (e.key === 'Enter') pick(shown[idx]);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div class="se-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div class="se-palette se-defpick" role="dialog" aria-label={`Definitions of ${name}`} data-testid="definition-picker">
        <div class="se-defpick-head">
          {hits.length} definitions of <code>{name}</code>
        </div>
        <input
          ref={input}
          class="se-palette-input se-defpick-input"
          value={q}
          spellcheck={false}
          autocomplete="off"
          placeholder="Filter by path, class or kind…"
          aria-label="Filter definitions"
          role="combobox"
          aria-expanded="true"
          aria-controls="se-defpick-list"
          onInput={(e) => {
            setQ((e.target as HTMLInputElement).value);
            setSel(0);
          }}
          onKeyDown={onKey}
        />
        <ul class="se-palette-list" id="se-defpick-list" role="listbox" ref={list}>
          {shown.map((h, i) => (
            <li
              key={`${h.path}:${h.line}:${h.col}`}
              class={`se-palette-item se-defpick-row${i === idx ? ' selected' : ''}`}
              role="option"
              aria-selected={i === idx}
              data-path={h.path}
              onMouseDown={(e) => (e.preventDefault(), pick(h))}
              onMouseMove={() => i !== idx && setSel(i)}
            >
              <span class="se-defpick-top">
                <span class="se-defpick-name">
                  {h.container && <span class="se-defpick-cont">{h.container}.</span>}
                  {h.name}
                </span>
                <span class="se-defpick-kind">{h.kind}</span>
                <span class="se-defpick-path">
                  {h.path}:{h.line + 1}
                </span>
              </span>
              {h.text && <span class="se-defpick-src">{h.text}</span>}
            </li>
          ))}
          {!shown.length && <li class="se-defpick-empty">No match</li>}
        </ul>
      </div>
    </div>
  );
}
