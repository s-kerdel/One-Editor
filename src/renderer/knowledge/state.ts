// Renderer-side knowledge state: the live index, its build/update lifecycle, and the write
// actions (follow link, rename refactor, link a mention, daily notes, templates).
import { computed, signal } from '@preact/signals';
import { parseWikiLink } from '@shared/wikilinks';
import { dirname, isMarkdown, normalize, stem } from '@shared/paths';
import { app } from '../app/app';
import { noteEdited, refreshTree } from '../app/documents';
import { KnowledgeIndex, extractNote, findHeadingLine, findTagLine, wikiLinkTextFor, applyEdits, type Mention, type TextEdit } from '../../knowledge/index';
import { searchClient, type NotesEvent } from '../search/client';
import { indexDeferred, indexOnDemand } from '../search/demand';
import { logActivity } from '../app/activity';
import { extractor } from './extractor';
import { createRenameRewriter } from '../../knowledge/rename';
import { applyTemplate, dailyNotePath, sanitizeNoteName } from '../../knowledge/templates';
import { isPdfPath, pageFromFragment } from '../pdf/model';

// No note texts here: metadata + link snippets come from the search workers, which hold the text.
// Link data derives in slices between tasks (10k notes: ~1 s of work that must not freeze the UI).
export const index = new KnowledgeIndex({ retainText: false, scheduleDerive: (step) => void pumpDerive(step) });
/** Bumped (coalesced) whenever the index changes — panels read it to re-render. */
export const kv = signal(0);
export const building = signal(false);
/** Links are being derived (time-sliced); queries meanwhile see what is linked so far. */
export const linking = signal(false);
/** Still indexing, for UI hints ("Indexing notes…"); `building` alone drives the build lifecycle. */
export const indexBusy = computed(() => building.value || linking.value);

async function pumpDerive(step: () => boolean): Promise<void> {
  await yieldTask(); // never inside the query (often a render) that started the derive
  linking.value = true;
  try {
    while (!step()) await yieldTask();
  } finally {
    linking.value = index.deriving; // a newer derive keeps its own pump
  }
  if (!index.deriving) kv.value++; // panels re-read the complete links now
}

let generation = 0;
/** Notes this big re-index only after a pause in typing. */
const BIG_NOTE_CHARS = 256 * 1024;
/** Text per extraction job during a build. */
const EXTRACT_JOB_CHARS = 1 << 20;
/** Notes up to this size are re-extracted in-thread on edit (well under 1 ms); bigger ones go to the worker. */
const INLINE_MAX_CHARS = 32 * 1024;
let readyResolve: (() => void) | null = null;
let readyPromise: Promise<void> = Promise.resolve();
let bumpTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleBump() {
  if (bumpTimer) return;
  // While the initial build streams in, refresh panels at a relaxed pace.
  bumpTimer = setTimeout(
    () => {
      bumpTimer = null;
      kv.value++;
    },
    building.value ? 500 : 40,
  );
}

const idle = (): Promise<void> =>
  new Promise((res) => {
    const ric = (globalThis as any).requestIdleCallback as ((cb: () => void, o?: { timeout: number }) => void) | undefined;
    if (ric) ric(() => res(), { timeout: 300 });
    else setTimeout(res, 16);
  });

function whenBooted(): Promise<void> {
  if (app.ready.value) return Promise.resolve();
  return new Promise((res) => {
    const off = app.ready.subscribe((v) => {
      if (v) {
        queueMicrotask(() => off());
        res();
      }
    });
  });
}

/** Unsaved editor content wins over what's on disk. */
function liveContent(path: string): string | undefined {
  const doc = app.docs.get(path);
  if (!doc) return undefined;
  return app.editor?.getContent(path) ?? doc.content;
}

export function whenIndexed(): Promise<void> {
  return readyPromise;
}

// ---------- index updates (sync, or via the extraction worker) ----------

/**
 * Per-path version stamps: an extraction that finishes off-thread only lands if nothing newer
 * (an edit, a save, a delete) touched the note meanwhile.
 */
const stamps = new Map<string, number>();
let clock = 0;
const stamp = (path: string) => {
  const v = ++clock;
  stamps.set(path, v);
  return v;
};

/** Synchronous update: callers query the index right after (link refactors, new notes). */
function updateNow(path: string, text: string) {
  stamp(path);
  index.update(path, text);
}

/** Debounced/background update: big notes are extracted by the worker, small ones right here. */
function updateSoon(path: string, text: string) {
  // On demand, not built yet: nothing to update (and no extraction worker) — the first build reads all.
  if (indexDeferred.value) return;
  if (!isMarkdown(path) || text.length <= INLINE_MAX_CHARS || index.sameText(path, text)) return updateNow(path, text);
  const v = stamp(path);
  void extractor.extract([{ path, text }]).then(
    ([info]) => stamps.get(path) === v && index.update(path, text, info),
    (err) => console.warn('[knowledge] extraction failed', path, err),
  );
}

function removeNow(path: string) {
  stamp(path);
  index.remove(path);
}

let buildStart = 0;
let buildNotes = 0;

/** Notes events wait here and are applied a few ms at a time, in order (typing and clicks interleave). */
const noteQueue: NotesEvent[] = [];
let draining = false;
const NOTES_SLICE_MS = 6;
const yieldTask = () =>
  new Promise<void>((r) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      r();
    };
    ch.port2.postMessage(0);
  });

function queueNotes(e: NotesEvent) {
  noteQueue.push(e);
  if (!draining) void drainNotes();
}

async function drainNotes() {
  draining = true;
  try {
    let t = performance.now();
    while (noteQueue.length) {
      const e = noteQueue.shift()!;
      if (e.kind === 'items' && e.items.length > 32) {
        // Big batch: split so one slice stays short.
        for (let i = 0; i < e.items.length; i += 32) {
          applyNotes({ ...e, items: e.items.slice(i, i + 32), removed: i === 0 ? e.removed : undefined });
          if (performance.now() - t > NOTES_SLICE_MS) {
            await yieldTask();
            t = performance.now();
          }
        }
      } else applyNotes(e);
      if (performance.now() - t > NOTES_SLICE_MS) {
        await yieldTask();
        t = performance.now();
      }
    }
  } finally {
    draining = false;
  }
}

/** The index follows the search workers' notes stream: a rebuild there is a rebuild here. */
function applyNotes(e: NotesEvent) {
  if (e.kind === 'start') {
    generation = e.gen;
    readyResolve?.();
    readyPromise = new Promise((res) => (readyResolve = res));
    building.value = true;
    buildStart = performance.now();
    buildNotes = 0;
    index.clear();
    index.setFiles(app.files.value);
    return;
  }
  if (e.kind === 'items') {
    if (e.gen !== undefined && e.gen !== generation) return;
    for (const it of e.items) {
      if (app.docs.has(it.path)) continue; // the open note's live text wins (doc:changed)
      stamp(it.path);
      index.update(it.path, null, it.info, it.snippets);
      buildNotes++;
    }
    for (const p of e.removed ?? []) if (!app.docs.has(p) && index.note(p)) removeNow(p);
    return;
  }
  if (e.gen !== generation) return;
  index.setFiles(app.files.value);
  for (const d of app.docs.values()) if (isMarkdown(d.path) && !d.binary) updateNow(d.path, liveContent(d.path) ?? d.content);
  building.value = false;
  if (bumpTimer) clearTimeout(bumpTimer);
  bumpTimer = null;
  kv.value++;
  index.warm(); // derive the links now, in slices, so the first panel open has them
  (window as any).__secEditKnowledgeReady = true;
  logActivity({ kind: 'knowledge', trigger: 'index', ms: performance.now() - buildStart, detail: `${index.size.toLocaleString()} notes` });
  readyResolve?.();
  readyResolve = null;
}

/** Unlinked mentions of a note in other notes (scanned by the search workers, which hold the text). */
export async function unlinkedMentionsOf(path: string, limit?: number): Promise<Mention[]> {
  const names = index.mentionNames(path);
  return names.length ? searchClient.mentions(names, path, limit) : [];
}

/** First line where `tag` occurs in a note (its live text, or read from disk). */
export async function tagLineOf(path: string, tag: string): Promise<number | null> {
  const text = liveContent(path) ?? (await app.backend.readFile(path).then((f) => f.content, () => null));
  return text === null ? null : findTagLine(text, tag);
}

// ---------- text edits through the editor (undoable) or the backend ----------

function offsetOf(text: string, line: number, col: number): number {
  let pos = 0;
  for (let i = 0; i < line; i++) {
    const nl = text.indexOf('\n', pos);
    if (nl === -1) return text.length;
    pos = nl + 1;
  }
  return pos + col;
}

/** Applies edits computed by `compute` against the freshest text of `path`. Returns true if it changed. */
export async function editFile(path: string, compute: (text: string) => TextEdit[]): Promise<boolean> {
  const doc = app.docs.get(path);
  if (doc) {
    const cur = app.editor?.getContent(path) ?? doc.content;
    const edits = compute(cur);
    if (!edits.length) return false;
    const next = applyEdits(cur, edits);
    if (app.editor?.applyChanges) app.editor.applyChanges(path, edits);
    else app.editor?.setContent(path, next);
    // Background tabs may not report the change themselves; keep the doc model + autosave in sync.
    if (doc.content !== next) noteEdited(path, next);
    updateNow(path, next);
    return true;
  }
  const file = await app.backend.readFile(path);
  const edits = compute(file.content);
  if (!edits.length) return false;
  const next = applyEdits(file.content, edits);
  await app.backend.writeFile(path, next, { eol: file.eol });
  updateNow(path, next);
  // Our own writes never echo back from the watcher: tell the search index (it serves mentions too).
  app.events.emit('file:updated', path, next);
  return true;
}

// ---------- follow / create links ----------

export async function createNote(path: string, content: string): Promise<boolean> {
  try {
    await app.backend.createFile(path, content);
  } catch (err: any) {
    if (err?.code !== 'EEXIST') {
      app.toast(`Cannot create ${path}: ${err?.message ?? err}`, 'error');
      return false;
    }
  }
  updateNow(path, content);
  app.events.emit('file:updated', path, content);
  await refreshTree().catch(() => {});
  return true;
}

async function anchorLine(path: string, link: { heading?: string; block?: string }): Promise<number | null> {
  if (!link.heading && !link.block) return null;
  let line = index.findAnchor(path, link);
  if (line === null && !index.note(path) && isMarkdown(path)) {
    // Index still building: look at the file directly.
    const text = liveContent(path) ?? (await app.backend.readFile(path).then((f) => f.content, () => ''));
    const info = extractNote(path, text);
    line = link.block ? (info.blocks.find((b) => b.id === link.block)?.line ?? null) : findHeadingLine(info.headings, link.heading!);
  }
  return line;
}

export async function openLink(target: string, fromPath: string, _opts?: { newTab?: boolean }): Promise<void> {
  const link = parseWikiLink(target.replace(/^!?\[\[|\]\]$/g, ''));
  let path = link.target ? index.resolve(link.target, fromPath) : fromPath;
  if (!path && link.target && building.value) {
    // Aliases are only known once the index is built (on demand: this builds it).
    void searchClient.start();
    await whenIndexed();
    path = index.resolve(link.target, fromPath);
  }
  if (!path) {
    const name = sanitizeNoteName(link.target);
    if (!name) return;
    // Obsidian-like: new notes land next to the note that links to them; a path-like target is
    // taken from the workspace root.
    const rel = name.includes('/') ? name : normalize(`${dirname(fromPath)}/${name}`);
    path = isMarkdown(rel) ? rel : `${rel}.md`;
    if (!(await createNote(path, `# ${stem(path)}\n\n`))) return;
    app.toast(`Created ${path}`, 'success', 2500);
    await app.openFile(path, { line: 2 });
    return;
  }
  // [[doc.pdf#page=3]]: the PDF viewer opens at that page.
  const pdfPage = isPdfPath(path) ? pageFromFragment(link.heading) : null;
  if (pdfPage) return app.openFile(path, { line: 0, page: pdfPage });
  const line = await anchorLine(path, link);
  await app.openFile(path, line === null ? undefined : { line });
}

// ---------- rename refactoring ----------

export async function handleRenamed(from: string, to: string): Promise<number> {
  // Old→new for every file involved (a folder rename moves many).
  let pairs = index.rename(from, to);
  for (const old of pairs.keys()) stamp(old); // a pending extraction must not resurrect the old path
  if (!pairs.size) {
    // The file watcher may have applied the move already; reconstruct from the new side.
    pairs = new Map();
    for (const p of [...index.files(), ...app.files.value]) {
      if (p === to) pairs.set(from, to);
      else if (p.startsWith(`${to}/`)) pairs.set(from + p.slice(to.length), p);
    }
    if (!pairs.size && /\.[^/]+$/.test(to)) pairs.set(from, to);
  }
  if (app.settings.value['links.updateOnRename'] === false || !pairs.size) return 0;
  void searchClient.start(); // on demand: updating links needs the index — this builds it
  await whenIndexed();
  const allFiles = new Set([...index.files(), ...app.files.value, ...pairs.values()]);
  for (const old of pairs.keys()) allFiles.delete(old);
  const rewriter = createRenameRewriter(pairs, allFiles);

  // Candidates: for a single file, notes that mention its name at all; a folder move checks every note.
  const moved = new Set(pairs.values());
  let candidates: string[];
  if (pairs.size === 1) {
    // Only notes whose links name the file can need a rewrite (the index has no texts to scan).
    const needle = stem(from).toLowerCase();
    const encoded = encodeURI(stem(from)).toLowerCase();
    candidates = index.notes().filter((n) => {
      if (moved.has(n.path)) return true;
      const live = liveContent(n.path);
      if (live !== undefined) {
        const t = live.toLowerCase();
        return t.includes(needle) || t.includes(encoded);
      }
      return n.links.some((l) => {
        const t = l.target.toLowerCase();
        return t.includes(needle) || t.includes(encoded);
      });
    }).map((n) => n.path);
  } else candidates = index.notes().map((n) => n.path);
  for (const p of moved) if (isMarkdown(p) && !candidates.includes(p)) candidates.push(p);

  let changed = 0;
  let i = 0;
  for (const path of candidates) {
    // Cheap pre-check on the indexed text so untouched closed files are never read from disk.
    const known = liveContent(path);
    if (known !== undefined && !rewriter.edits(known, path).length) continue;
    try {
      if (await editFile(path, (text) => rewriter.edits(text, path))) changed++;
    } catch (err) {
      console.warn('[knowledge] could not update links in', path, err);
    }
    if (++i % 50 === 0) await idle();
  }
  if (changed) app.toast(`Updated links in ${changed} note${changed === 1 ? '' : 's'}`, 'success');
  return changed;
}

// ---------- unlinked mention → link ----------

export async function linkMention(target: string, m: Mention): Promise<boolean> {
  const name = wikiLinkTextFor(target, m.from, (t, f) => index.resolve(t, f));
  const ok = await editFile(m.from, (text) => {
    const from = offsetOf(text, m.line, m.col);
    const found = text.slice(from, from + m.length);
    if (found !== m.text) return [];
    return [{ from, to: from + m.length, insert: found === name ? `[[${name}]]` : `[[${name}|${found}]]` }];
  });
  if (!ok) app.toast('That mention has changed — try again', 'info');
  return ok;
}

/** Links every mention: one edit per note (one undo step), mentions that changed meanwhile are skipped. */
export async function linkMentions(target: string, ms: readonly Mention[]): Promise<number> {
  const byFile = new Map<string, Mention[]>();
  for (const m of ms) byFile.set(m.from, [...(byFile.get(m.from) ?? []), m]);
  let linked = 0;
  for (const [from, list] of byFile) {
    const name = wikiLinkTextFor(target, from, (t, f) => index.resolve(t, f));
    try {
      await editFile(from, (text) => {
        const edits: TextEdit[] = [];
        let last = -1;
        for (const m of [...list].sort((a, b) => a.line - b.line || a.col - b.col)) {
          const at = offsetOf(text, m.line, m.col);
          const found = text.slice(at, at + m.length);
          if (found !== m.text || at < last) continue;
          edits.push({ from: at, to: at + m.length, insert: found === name ? `[[${name}]]` : `[[${name}|${found}]]` });
          last = at + m.length;
        }
        linked += edits.length;
        return edits;
      });
    } catch (err) {
      console.warn('[knowledge] could not link mentions in', from, err);
    }
  }
  if (linked < ms.length) app.toast(`Linked ${linked} of ${ms.length} mentions — the others changed meanwhile`, 'info');
  return linked;
}

// ---------- daily notes + templates ----------

const setting = (key: string, fallback: string): string => {
  const v = app.settings.value[key];
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
};

export function templateFiles(): string[] {
  const folder = normalize(setting('templates.folder', 'templates')).toLowerCase();
  return app.files.value.filter((f) => isMarkdown(f) && f.toLowerCase().startsWith(`${folder}/`)).sort((a, b) => a.localeCompare(b));
}

export async function openDailyNote(now = new Date()): Promise<string | null> {
  if (!app.workspace.value) return null;
  const path = dailyNotePath(now, setting('daily.folder', 'daily'), setting('daily.format', 'YYYY-MM-DD'));
  const existing = app.files.value.find((f) => f.toLowerCase() === path.toLowerCase());
  if (existing) {
    await app.openFile(existing);
    return existing;
  }
  let content = `# ${stem(path)}\n\n`;
  const tplSetting = setting('daily.template', '');
  if (tplSetting) {
    const tpl = index.resolve(tplSetting) ?? templateFiles().find((f) => stem(f).toLowerCase() === tplSetting.toLowerCase());
    if (tpl) content = applyTemplate(await app.backend.readFile(tpl).then((f) => f.content, () => content), { title: stem(path), now });
  }
  if (!(await createNote(path, content))) return null;
  await app.openFile(path, { line: content.split('\n').length - 1 });
  return path;
}

export async function insertTemplate(templatePath: string): Promise<void> {
  const active = app.activePath.value;
  if (!active || !app.editor) {
    app.toast('Open a note first to insert a template', 'info');
    return;
  }
  const tpl = await app.backend.readFile(templatePath);
  const text = applyTemplate(tpl.content, { title: stem(active), dateFormat: setting('templates.dateFormat', 'YYYY-MM-DD'), timeFormat: setting('templates.timeFormat', 'HH:mm') });
  const cur = app.editor.getContent(active) ?? '';
  const c = app.editor.getCursor();
  const at = app.editor.getCursorOffset?.() ?? offsetOf(cur, c.line, c.col);
  if (app.editor.applyChanges) app.editor.applyChanges(active, [{ from: at, to: at, insert: text }], { selection: { anchor: at + text.length } });
  else app.editor.setContent(active, cur.slice(0, at) + text + cur.slice(at));
  app.editor.focus();
}

// ---------- wiring ----------

export function installIndexing() {
  index.onChange(scheduleBump);
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  // Builds (workspace opened, index settings changed) and disk changes arrive as note metadata
  // from the search workers; editor edits are extracted here.
  searchClient.onNotes(queueNotes, { replay: true });
  app.events.on('tree:changed', () => {
    if (building.value) index.setFiles(app.files.value);
    else {
      index.setFiles(app.files.value);
      // Deleted outside the watcher's view (e.g. folder removed) → drop stale notes.
      const files = new Set(app.files.value);
      const gone = index.notes().filter((n) => !files.has(n.path) && !app.docs.has(n.path));
      if (gone.length) {
        for (const n of gone) stamp(n.path);
        index.prune(new Set([...files, ...app.docs.keys()]));
      }
    }
  });
  app.events.on('doc:changed', (path, content) => {
    if (!isMarkdown(path)) return;
    clearTimeout(pending.get(path));
    // Debounced: extraction is cheap, but panels re-render on every index change. A big note waits
    // for a pause in typing: re-extracting 1 MB (and re-linking thousands of links) every 150 ms was
    // most of the main-thread work while typing in it.
    pending.set(
      path,
      setTimeout(
        () => {
          pending.delete(path);
          if (app.docs.has(path)) updateSoon(path, app.docs.get(path)!.content ?? content);
        },
        content.length > BIG_NOTE_CHARS ? 1200 : 150,
      ),
    );
  });
  app.events.on('doc:saved', (path, content) => {
    clearTimeout(pending.get(path));
    pending.delete(path);
    updateSoon(path, content);
  });
  // doc:closed: the search client re-reads the closed note from disk and its notes arrive above.
  app.events.on('file:updated', (path, content) => {
    if (content === undefined) {
      if (!app.docs.has(path)) removeNow(path);
      return;
    }
    if (app.docs.get(path)?.dirty.value) return; // live editor content is newer
    updateSoon(path, content);
  });
  app.events.on('file:renamed', (from, to) => void handleRenamed(from, to).catch((err) => console.warn('[knowledge] rename refactor failed', err)));

  if (app.workspace.value && !(window as any).__secEditKnowledgeReady) {
    building.value = true;
    readyPromise = new Promise((res) => (readyResolve = res));
  }
  // The knowledge index is built by the search workers: make sure they run (after first paint) —
  // unless the index is built on demand (search.indexing): then the first consumer starts them.
  void whenBooted()
    .then(idle)
    .then(() => (indexOnDemand() ? undefined : searchClient.start()));
}
