// External changes (backend fs events): keep the tree and the open documents in step with the disk.
// Lazy: loaded by documents.ts on the first fs event, so none of this is parsed at launch.
import type { FileData, FsEvent, TreeNode } from '@shared/api';
import { app } from './app';
import * as ui from './ui';
import { basename } from '@shared/paths';
import { filesUnder, findNode, insertNode, removeNode } from './tree-model';
import { isImagePath } from './icons';
import { clearConflict, setConflict } from './documents';
import { replaceFromDisk } from './doc-save';

/** Applies backend watcher events. Returns the same object if nothing changed. */
export function applyFsEvents(tree: TreeNode, events: FsEvent[]): TreeNode {
  let t = tree;
  for (const ev of events) {
    if (!ev.path) continue;
    switch (ev.type) {
      case 'add':
        if (findNode(t, ev.path)?.kind !== 'file') t = insertNode(t, { name: basename(ev.path), path: ev.path, kind: 'file', mtime: ev.mtime });
        break;
      case 'addDir':
        if (findNode(t, ev.path)?.kind !== 'dir') t = insertNode(t, { name: basename(ev.path), path: ev.path, kind: 'dir', children: [] });
        break;
      case 'unlink':
      case 'unlinkDir':
        t = removeNode(t, ev.path);
        break;
      case 'change':
        break;
    }
  }
  return t;
}

/** Conflict resolution: take the disk version. */
export function reloadFromDisk(path: string) {
  const doc = app.docs.get(path);
  const c = ui.conflicts.value.get(path);
  if (!doc || !c) return;
  doc.saved = c.disk;
  doc.mtime = c.mtime;
  doc.content = c.disk;
  clearConflict(path);
  replaceFromDisk(path, c.disk);
  doc.dirty.value = false;
}

export async function handleFsEvents(events: FsEvent[]) {
  const oldTree = app.tree.value;
  if (oldTree) {
    const next = applyFsEvents(oldTree, events);
    if (next !== oldTree) {
      app.tree.value = next;
      app.events.emit('tree:changed', next);
    }
  }
  const reads: string[] = [];
  const changed: string[] = [];
  for (const ev of events) {
    if (ev.type === 'unlink' || ev.type === 'unlinkDir') {
      const gone = ev.type === 'unlink' ? [ev.path] : filesUnder(findNode(oldTree, ev.path));
      for (const p of gone) {
        app.events.emit('file:updated', p, undefined);
        if (app.docs.has(p)) ui.setIn(ui.deletedOnDisk, p, true);
      }
    } else if (ev.type === 'add' || ev.type === 'change') {
      // Only open documents are read here (conflicts, reloads); the indexers re-read everything else
      // themselves, coalesced and off this thread — a build writing 5,000 files costs one event.
      if (app.docs.has(ev.path)) reads.push(ev.path);
      else changed.push(ev.path);
    }
  }
  if (changed.length) app.events.emit('files:changed', changed);
  // Bounded parallel reads.
  let i = 0;
  const worker = async () => {
    while (i < reads.length) await reconcileFile(reads[i++]);
  };
  await Promise.all(Array.from({ length: Math.min(8, reads.length) }, worker));
}

async function reconcileFile(path: string) {
  const doc = app.docs.get(path);
  if (!doc && isImagePath(path)) return; // nothing to tell listeners about an image's bytes
  if (doc?.binary && /\.pdf$/i.test(path)) {
    // Never read as text (size cap, a full read per save): the open viewer reloads the bytes itself.
    ui.setIn(ui.deletedOnDisk, path, false);
    app.events.emit('binary:changed', path);
    return;
  }
  let f: FileData;
  try {
    f = await app.backend.readFile(path);
  } catch {
    return;
  }
  if (f.binary) return;
  ui.setIn(ui.deletedOnDisk, path, false);
  if (doc && !doc.binary) {
    const current = app.editor?.getContent(path) ?? doc.content;
    if (f.content === doc.saved) doc.mtime = f.mtime;
    else if (f.content === current) {
      doc.saved = f.content;
      doc.mtime = f.mtime;
      doc.dirty.value = false;
      clearConflict(path);
    } else if (!doc.dirty.value) {
      // Clean doc → follow the disk silently (the editor keeps cursor + undo history).
      doc.saved = doc.content = f.content;
      doc.mtime = f.mtime;
      doc.eol = f.eol;
      replaceFromDisk(path, f.content);
      doc.dirty.value = false;
    } else {
      setConflict(path, f.content, f.mtime);
    }
  }
  app.events.emit('file:updated', path, f.content);
}
