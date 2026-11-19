// Apply replacements across files. Open docs go through the editor (undoable, autosave applies);
// closed files are written via the backend with their original EOL and an mtime guard.
import { app } from '../app/app';
import { noteEdited } from '../app/documents';
import { applyEdits, planReplace } from '../../search/replace';
import type { SearchOptions } from '../../search/types';
import { searchClient } from './client';

export interface ReplaceTarget {
  path: string;
  /** Restrict to hits on these 0-based lines (replace one row). */
  lines?: number[];
}

export interface UndoEntry {
  path: string;
  before: string;
  after: string;
  open: boolean;
}

export interface ReplaceOutcome {
  files: number;
  replaced: number;
  errors: string[];
  undo: UndoEntry[];
}

async function currentContent(path: string): Promise<{ content: string; mtime?: number; eol?: 'lf' | 'crlf'; open: boolean }> {
  const doc = app.docs.get(path);
  if (doc) return { content: app.editor?.getContent(path) ?? doc.content, open: true };
  const f = await app.backend.readFile(path);
  return { content: f.content, mtime: f.mtime, eol: f.eol, open: false };
}

function setOpenDoc(path: string, before: string, after: string, edits?: Array<{ from: number; to: number; insert: string }>) {
  if (edits && app.editor?.applyChanges) app.editor.applyChanges(path, edits);
  else app.editor?.setContent(path, after);
  // Editors only emit change events for the active view; keep doc state + index in sync for the rest.
  const now = app.editor?.getContent(path) ?? after;
  const doc = app.docs.get(path);
  if (doc && doc.content !== now) noteEdited(path, now);
  else if (!doc) searchClient.upsert(path, now);
  void before;
}

export async function replaceInFiles(targets: ReplaceTarget[], query: string, opts: SearchOptions, replacement: string): Promise<ReplaceOutcome> {
  const out: ReplaceOutcome = { files: 0, replaced: 0, errors: [], undo: [] };
  for (const t of targets) {
    try {
      const cur = await currentContent(t.path);
      const plan = planReplace(t.path, cur.content, query, opts, replacement, t.lines);
      if (plan.error) {
        out.errors.push(plan.error);
        break;
      }
      if (!plan.edits.length) continue;
      const after = applyEdits(cur.content, plan.edits);
      if (cur.open) setOpenDoc(t.path, cur.content, after, plan.edits);
      else {
        await app.backend.writeFile(t.path, after, { expectedMtime: cur.mtime, eol: cur.eol });
        searchClient.upsert(t.path, after);
      }
      out.files++;
      out.replaced += plan.edits.length;
      out.undo.push({ path: t.path, before: cur.content, after, open: cur.open });
    } catch (err) {
      out.errors.push(`${t.path}: ${(err as Error).message}`);
    }
  }
  return out;
}

/** Revert a replace batch, skipping files that changed since. */
export async function undoReplace(entries: UndoEntry[]): Promise<{ reverted: number; skipped: string[] }> {
  let reverted = 0;
  const skipped: string[] = [];
  for (const u of entries) {
    try {
      const cur = await currentContent(u.path);
      if (cur.content !== u.after) {
        skipped.push(u.path);
        continue;
      }
      if (cur.open) setOpenDoc(u.path, u.after, u.before);
      else {
        await app.backend.writeFile(u.path, u.before, { expectedMtime: cur.mtime, eol: cur.eol });
        searchClient.upsert(u.path, u.before);
      }
      reverted++;
    } catch {
      skipped.push(u.path);
    }
  }
  return { reverted, skipped };
}
