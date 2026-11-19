// Renderer-side knowledge state: the live index, its build/update lifecycle, and the write
// actions (follow link, rename refactor, link a mention, daily notes, templates).
import { signal } from '@preact/signals';
import { parseWikiLink } from '@shared/wikilinks';
import { dirname, isMarkdown, normalize, stem } from '@shared/paths';
import { app } from '../app/app';
import { noteEdited, refreshTree } from '../app/documents';
import { streamAllText } from '../app/workspace-text';
import { KnowledgeIndex, extractNote, findHeadingLine, wikiLinkTextFor, applyEdits, type Mention, type TextEdit } from '../../knowledge/index';
import { extractor } from './extractor';
import { createRenameRewriter } from '../../knowledge/rename';
import { applyTemplate, dailyNotePath, sanitizeNoteName } from '../../knowledge/templates';

export const index = new KnowledgeIndex();
/** Bumped (coalesced) whenever the index changes — panels read it to re-render. */
export const kv = signal(0);
export const building = signal(false);

let generation = 0;
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
  if (!isMarkdown(path) || text.length <= INLINE_MAX_CHARS || index.text(path) === text) return updateNow(path, text);
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

async function buildIndex() {
  const gen = ++generation;
  readyResolve?.();
  readyPromise = new Promise((res) => (readyResolve = res));
  const done = readyResolve!;
  building.value = true;
  index.clear();
  index.setFiles(app.files.value);
  try {
    // Launch speed: never compete with boot/first paint.
    await whenBooted();
    await idle();
    if (gen !== generation) return;
    const seen: string[] = [];
    const jobs: Promise<void>[] = [];
    // Same paged read as the search indexer. Each ~1 MB page is extracted by the worker while the
    // next one is read; the main thread only clones texts out and stores the results.
    for await (const page of streamAllText()) {
      if (gen !== generation) return;
      let docs: Array<{ path: string; text: string }> = [];
      let versions: number[] = [];
      let chars = 0;
      // ~1 MB per extraction job: a big page spreads over the extraction workers.
      const flush = () => {
        if (!docs.length) return;
        const d = docs;
        const v = versions;
        docs = [];
        versions = [];
        chars = 0;
        jobs.push(
          extractor.extract(d).then((infos) => {
            if (gen !== generation) return;
            for (let i = 0; i < d.length; i++) if (stamps.get(d[i].path) === v[i]) index.update(d[i].path, d[i].text, infos[i]);
          }),
        );
      };
      for (const f of page) {
        seen.push(f.path);
        if (!isMarkdown(f.path)) continue; // knowledge = Markdown notes only
        const text = liveContent(f.path) ?? f.content;
        docs.push({ path: f.path, text });
        versions.push(stamp(f.path));
        if ((chars += text.length) >= EXTRACT_JOB_CHARS) flush();
      }
      flush();
    }
    await Promise.all(jobs);
    if (gen !== generation) return;
    index.setFiles([...app.files.value, ...seen]);
  } catch (err) {
    console.warn('[knowledge] index build failed', err);
  } finally {
    if (gen === generation) {
      building.value = false;
      if (bumpTimer) clearTimeout(bumpTimer);
      bumpTimer = null;
      kv.value++;
      (window as any).__secEditKnowledgeReady = true;
    }
    done();
  }
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
    // Aliases are only known once the index is built.
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
  await whenIndexed();
  const allFiles = new Set([...index.files(), ...app.files.value, ...pairs.values()]);
  for (const old of pairs.keys()) allFiles.delete(old);
  const rewriter = createRenameRewriter(pairs, allFiles);

  // Candidates: for a single file, notes that mention its name at all; a folder move checks every note.
  const moved = new Set(pairs.values());
  let candidates: string[];
  if (pairs.size === 1) {
    const needle = stem(from).toLowerCase();
    const encoded = encodeURI(stem(from)).toLowerCase();
    candidates = index.notes().filter((n) => {
      if (moved.has(n.path)) return true;
      const t = (liveContent(n.path) ?? index.text(n.path) ?? '').toLowerCase();
      return t.includes(needle) || t.includes(encoded);
    }).map((n) => n.path);
  } else candidates = index.notes().map((n) => n.path);
  for (const p of moved) if (isMarkdown(p) && !candidates.includes(p)) candidates.push(p);

  let changed = 0;
  let i = 0;
  for (const path of candidates) {
    // Cheap pre-check on the indexed text so untouched closed files are never read from disk.
    const known = liveContent(path) ?? index.text(path);
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

  app.events.on('workspace:opened', () => void buildIndex());
  app.events.on('index:stale', () => void buildIndex()); // ignore rules / size cap changed
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
    // Debounced: extraction is cheap, but panels re-render on every index change.
    pending.set(
      path,
      setTimeout(() => {
        pending.delete(path);
        if (app.docs.has(path)) updateSoon(path, app.docs.get(path)!.content ?? content);
      }, 150),
    );
  });
  app.events.on('doc:saved', (path, content) => {
    clearTimeout(pending.get(path));
    pending.delete(path);
    updateSoon(path, content);
  });
  app.events.on('doc:closed', (path) => {
    // Unsaved edits may have been discarded: fall back to what's on disk.
    if (!isMarkdown(path) || !index.note(path)) return;
    app.backend.readFile(path).then((f) => !app.docs.has(path) && updateSoon(path, f.content), () => {});
  });
  app.events.on('file:updated', (path, content) => {
    if (content === undefined) {
      if (!app.docs.has(path)) removeNow(path);
      return;
    }
    if (app.docs.get(path)?.dirty.value) return; // live editor content is newer
    updateSoon(path, content);
  });
  app.events.on('file:renamed', (from, to) => void handleRenamed(from, to).catch((err) => console.warn('[knowledge] rename refactor failed', err)));

  if (app.workspace.value) void buildIndex();
}
