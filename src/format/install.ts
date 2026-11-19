// Editor integration: commands, key bindings, format-on-save and config resolution.
// Only light modules are imported here — the formatter core loads inside the worker on first use.
import { app } from '../renderer/app/app';
import { registerCommands } from '../renderer/app/commands';
import { setBeforeSave } from '../renderer/app/documents';
import { trimForSave } from '../renderer/whitespace/save';
import { updateSettings } from '../renderer/app/settings';
import { formatterForPath, languageForPath } from '../shared/languages';
import { formatInWorker } from './client';
import { ConfigResolver, isConfigFile } from './config';
import { mapCursor, minimalChanges } from './diff';
import type { FormatOptions, FormatRequest, FormatResult } from './types';

const config = new ConfigResolver(async (path) => {
  try {
    return (await app.backend.readFile(path)).content;
  } catch {
    return null;
  }
});

function optionsFor(path: string): Promise<FormatOptions> {
  return config.resolve(path, app.settings.value).catch(() => ({}));
}

interface Selection {
  from: number;
  to: number;
  head: number;
}

function offsetOf(text: string, line: number, col: number): number {
  let off = 0;
  for (let i = 0; i < line; i++) {
    const nl = text.indexOf('\n', off);
    if (nl === -1) return text.length;
    off = nl + 1;
  }
  return Math.min(off + col, text.length);
}

function currentSelection(text: string): Selection {
  const ed = app.editor!;
  const view = ed.getView?.() as { state?: { selection?: { main?: { from: number; to: number; head: number } } } } | undefined;
  const main = view?.state?.selection?.main;
  if (main) return { from: main.from, to: main.to, head: main.head };
  const cur = ed.getCursor();
  const head = Math.min(ed.getCursorOffset?.() ?? offsetOf(text, cur.line, cur.col), text.length);
  return { from: head, to: head, head };
}

/** Replaces the editor text with `after` as minimal changes: one undo step, cursor kept in place. */
function applyToEditor(path: string, before: string, after: string, cursor: number | undefined): boolean {
  const ed = app.editor;
  if (!ed) return false;
  if (ed.getContent(path) !== before) return false; // typed while we were formatting: never clobber
  if (after === before) return true;
  const active = app.activePath.value === path;
  const anchor = active && cursor !== undefined ? Math.max(0, Math.min(cursor, after.length)) : undefined;
  if (ed.applyChanges) {
    ed.applyChanges(path, minimalChanges(before, after), anchor !== undefined ? { selection: { anchor } } : undefined);
    return true;
  }
  const view = active ? (ed.getView?.() as { dispatch?: (tr: unknown) => void } | undefined) : undefined;
  if (view?.dispatch) {
    view.dispatch({ changes: minimalChanges(before, after), selection: anchor !== undefined ? { anchor } : undefined, userEvent: 'format' });
    return true;
  }
  ed.setContent(path, after);
  return true;
}

const STALE = 'Document changed while formatting — nothing applied';

function reportSkipped(r: FormatResult) {
  const w = r.warnings;
  if (!w?.length) return;
  app.toast(w.length === 1 ? `Skipped 1 code block — ${w[0].message}` : `Skipped ${w.length} code blocks — first: ${w[0].message}`, 'error', 7000);
}

function active(): { path: string; text: string } | null {
  const path = app.activePath.value;
  const text = path ? app.editor?.getContent(path) : undefined;
  if (!path || text === undefined) return null;
  return { path, text };
}

function unsupported(path: string) {
  const lang = languageForPath(path);
  app.toast(lang ? `No formatter for ${lang.name} files` : 'No formatter for this file type', 'info');
}

async function run(path: string, text: string, req: FormatRequest, timeoutMs?: number): Promise<FormatResult> {
  return formatInWorker(text, { path, options: await optionsFor(path), ...req }, { timeoutMs });
}

/** "Format document". Returns true when the document is now formatted. */
export async function formatDocument(): Promise<boolean> {
  const doc = active();
  if (!doc) return false;
  if (!formatterForPath(doc.path)) {
    unsupported(doc.path);
    return false;
  }
  const sel = currentSelection(doc.text);
  const r = await run(doc.path, doc.text, { cursorOffset: sel.head });
  if (r.error) {
    app.toast(r.error.message, 'error', 6000);
    return false;
  }
  if (!applyToEditor(doc.path, doc.text, r.text, r.cursorOffset)) {
    app.toast(STALE, 'info');
    return false;
  }
  reportSkipped(r);
  return true;
}

/** "Format all code blocks in note". */
export async function formatCodeBlocksInNote(): Promise<boolean> {
  const doc = active();
  if (!doc) return false;
  if (languageForPath(doc.path)?.id !== 'markdown') {
    app.toast('Format code blocks works in Markdown notes — use Format document here', 'info');
    return false;
  }
  const sel = currentSelection(doc.text);
  const r = await run(doc.path, doc.text, { mode: 'codeblocks', cursorOffset: sel.head });
  if (r.error) {
    app.toast(r.error.message, 'error', 6000);
    return false;
  }
  if (!applyToEditor(doc.path, doc.text, r.text, r.cursorOffset)) {
    app.toast(STALE, 'info');
    return false;
  }
  const n = r.blocksFormatted ?? 0;
  if (r.warnings?.length) reportSkipped(r);
  else app.toast(n ? `Formatted ${n} code block${n === 1 ? '' : 's'}` : 'Code blocks already formatted', n ? 'success' : 'info', 2000);
  return true;
}

/** Formats `text[from,to)` (widened to whole lines) as a stand-alone fragment, keeping its indentation. */
async function formatLines(doc: { path: string; text: string }, sel: Selection): Promise<{ text: string; error?: FormatResult['error'] }> {
  const { text } = doc;
  const from = text.lastIndexOf('\n', sel.from - 1) + 1;
  let to = sel.to > from && text[sel.to - 1] === '\n' ? sel.to - 1 : sel.to;
  const nl = text.indexOf('\n', to);
  to = nl === -1 ? text.length : nl;
  const lines = text.slice(from, to).split('\n');
  const indents = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0]);
  const indent = indents.length ? indents.reduce((a, b) => (b.startsWith(a) ? a : a.startsWith(b) ? b : '')) : '';
  const fragment = lines.map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l.trimStart())).join('\n');
  const r = await run(doc.path, fragment, { snippet: true, options: { ...(await optionsFor(doc.path)), markdownCodeBlocks: true } });
  if (r.error) return { text, error: r.error };
  const body = r.text
    .replace(/\n+$/, '')
    .split('\n')
    .map((l) => (l ? indent + l : l))
    .join('\n');
  return { text: text.slice(0, from) + body + text.slice(to) };
}

/** "Format selection / code block at cursor". */
export async function formatSelection(): Promise<boolean> {
  const doc = active();
  if (!doc) return false;
  if (!formatterForPath(doc.path)) {
    unsupported(doc.path);
    return false;
  }
  const sel = currentSelection(doc.text);
  const isNote = languageForPath(doc.path)?.id === 'markdown';
  let after: string | null = null;

  if (isNote) {
    const r = await run(doc.path, doc.text, { mode: 'block', cursorOffset: sel.head });
    if (!r.error) after = r.text;
    else if (r.error.kind !== 'no-block' || sel.from === sel.to) {
      app.toast(r.error.kind === 'no-block' ? 'Put the cursor in a code block or select text to format' : r.error.message, r.error.kind === 'no-block' ? 'info' : 'error', 6000);
      return false;
    }
  } else if (sel.from === sel.to) return formatDocument();

  if (after === null) {
    const r = await formatLines(doc, sel);
    if (r.error) {
      if (isNote) {
        app.toast(r.error.message, 'error', 6000);
        return false;
      }
      // A partial construct (half a class, one array entry) can't be parsed alone.
      app.toast('Selection is not valid on its own — formatting the whole document', 'info');
      return formatDocument();
    }
    after = r.text;
  }
  if (!applyToEditor(doc.path, doc.text, after, mapCursor(doc.text, after, sel.head))) {
    app.toast(STALE, 'info');
    return false;
  }
  return true;
}

// ---------- format on save ----------

/** Formats for a save: quiet on success, toasts on errors, and never throws or blocks the save. */
async function formatForSave(path: string, content: string): Promise<string> {
  if (!formatterForPath(path)) return content;
  const head = app.activePath.value === path ? currentSelection(content).head : undefined;
  const r = await run(path, content, { cursorOffset: head }, 5000);
  if (r.error) {
    app.toast(`Saved without formatting — ${r.error.message}`, 'error', 6000);
    return content;
  }
  if (r.warnings?.length) reportSkipped(r);
  if (r.text === content) return content;
  // Apply as minimal changes ourselves so the cursor survives; documents.ts then sees no difference.
  return applyToEditor(path, content, r.text, r.cursorOffset) ? r.text : app.editor?.getContent(path) ?? content;
}

let explicitSave = 0; // >0 while a user-initiated save (Mod-s / palette) is running

function installFormatOnSave() {
  // Autosave fires 800ms after typing stops; reformatting then would yank code around
  // mid-thought. So only user-initiated saves format: those go through app.saveFile(),
  // autosave calls the internal saveFile directly.
  const original = app.saveFile;
  if (typeof original === 'function') {
    app.saveFile = async (path?: string) => {
      const target = path ?? app.activePath.value ?? '';
      explicitSave++;
      try {
        if (app.settings.value.formatOnSave && target) {
          const content = app.editor?.getContent(target);
          if (content !== undefined) await formatForSave(target, content).catch((err) => console.warn('[format] on save', err));
        }
        return await original(path);
      } finally {
        explicitSave--;
      }
    };
  }
  setBeforeSave(async (path, content) => {
    // Trailing whitespace (../renderer/whitespace) on every save; an autosave spares the caret's line.
    content = await trimForSave(path, content, { explicit: explicitSave > 0 });
    // Explicit saves were formatted above (cursor-preserving). This hook only covers saves
    // that bypass the wrapper when autosave is off, i.e. every save is deliberate.
    if (explicitSave > 0 || !app.settings.value.formatOnSave || app.settings.value.autosave) return content;
    return formatForSave(path, content);
  });
}

async function toggleFormatOnSave() {
  const next = !app.settings.value.formatOnSave;
  // Single settings write path: applies live, emits settings:changed, coalesces concurrent saves.
  updateSettings({ formatOnSave: next });
  app.toast(`Format on save ${next ? 'enabled' : 'disabled'}`, 'info', 2000);
}

let installed = false;

/** Registers format commands, key bindings and the format-on-save hook. Call after installDocuments(). */
export function installFormat() {
  if (installed) return;
  installed = true;
  const hasDoc = () => !!app.activePath.value;
  registerCommands([
    { id: 'format.document', title: 'Format document', category: 'Format', keys: ['Shift-Alt-f', 'Alt-Shift-f'], keywords: ['prettier', 'beautify', 'php', 'indent', 'pretty'], when: hasDoc, run: () => void formatDocument() },
    { id: 'format.selection', title: 'Format selection / code block at cursor', category: 'Format', keys: ['Mod-Alt-f'], keywords: ['prettier', 'beautify', 'fence'], when: hasDoc, run: () => void formatSelection() },
    { id: 'format.codeBlocks', title: 'Format all code blocks in note', category: 'Format', keywords: ['prettier', 'beautify', 'fence', 'markdown', 'sql', 'php'], when: hasDoc, run: () => void formatCodeBlocksInNote() },
    { id: 'format.toggleOnSave', title: 'Toggle format on save', category: 'Format', keywords: ['prettier', 'autoformat'], run: () => void toggleFormatOnSave() },
  ]);
  installFormatOnSave();
  // E2E / debugging handle, like window.__secEdit.
  (globalThis as any).__secEditFormat = { formatDocument, formatSelection, formatCodeBlocksInNote, toggleFormatOnSave };
  app.events.on('file:updated', (path) => {
    if (isConfigFile(path)) config.invalidate(path);
  });
  app.events.on('doc:saved', (path) => {
    if (isConfigFile(path)) config.invalidate(path);
  });
  // A new folder (or a config file created where we cached a miss) must not see stale config.
  app.events.on('workspace:opened', () => config.invalidate());
  app.events.on('tree:changed', () => config.invalidate());
}
