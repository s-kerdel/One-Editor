// Low-level change *hints*. Watchers only say "something happened at <rel>"; the Workspace reconciles
// hints against its index (stat + diff), so event semantics are identical on every OS and our own
// writes never echo back.
//
// Strategy per OS (chosen for robustness, not cleverness):
//  - win32 / darwin: one native recursive fs.watch (ReadDirectoryChangesW / FSEvents). A single handle on
//    the root, so Explorer can still rename/delete subfolders (per-dir handles lock them on Windows).
//  - linux: one inotify watch per *indexed* directory. Excluded folders (node_modules) are never watched,
//    which keeps us far from inotify limits; Node's recursive mode on Linux would watch everything.
//  - fallback: polling rescan (network drives, \\wsl$ shares, watcher errors).
import fs from 'node:fs';
import path from 'node:path';
import { watchHint } from './pathsafe';

export interface HintSink {
  hint(rel: string): void;
  /** Watcher lost events (overflow / error): diff the whole tree. */
  rescan(): void;
}

export type WatchMode = 'recursive' | 'perdir' | 'poll';

export interface WatchBackend {
  readonly mode: WatchMode;
  /** perdir only: start watching a directory (rel '' = root). */
  addDir(rel: string): void;
  /** perdir only: stop watching a directory and everything below it. */
  removeDir(rel: string): void;
  close(): void;
}

export function defaultWatchMode(): WatchMode {
  const forced = process.env.SEC_EDIT_WATCH as WatchMode | undefined;
  if (forced === 'recursive' || forced === 'perdir' || forced === 'poll') return forced;
  return process.platform === 'linux' ? 'perdir' : 'recursive';
}

// Windows also reports alternate data streams ("x.zip:Zone.Identifier"): map them to the file itself.
const toRel = (filename: string | Buffer) => watchHint(String(filename), path, process.platform === 'win32');

export function createWatchBackend(root: string, sink: HintSink, mode: WatchMode = defaultWatchMode(), pollMs = 4000): WatchBackend {
  if (mode === 'recursive') {
    try {
      return recursiveBackend(root, sink, pollMs);
    } catch {
      return pollBackend(sink, pollMs);
    }
  }
  if (mode === 'perdir') return perDirBackend(root, sink);
  return pollBackend(sink, pollMs);
}

function recursiveBackend(root: string, sink: HintSink, pollMs: number): WatchBackend {
  let watcher: fs.FSWatcher | null = null;
  let fallback: WatchBackend | null = null;
  let closed = false;
  const start = () => {
    watcher = fs.watch(root, { recursive: true, persistent: false }, (_type, filename) => {
      if (filename == null || filename === '') sink.rescan(); // buffer overflow: we lost track
      else sink.hint(toRel(filename));
    });
    watcher.on('error', () => {
      watcher?.close();
      watcher = null;
      if (closed) return;
      // Typical on Windows when the root is renamed/deleted or a network share drops: degrade to polling.
      fallback = pollBackend(sink, pollMs);
      sink.rescan();
    });
  };
  start();
  return {
    mode: 'recursive',
    addDir() {},
    removeDir() {},
    close() {
      closed = true;
      watcher?.close();
      fallback?.close();
    },
  };
}

function perDirBackend(root: string, sink: HintSink): WatchBackend {
  const watchers = new Map<string, fs.FSWatcher>();
  let exhausted = false;
  const backend: WatchBackend = {
    mode: 'perdir',
    addDir(rel) {
      if (watchers.has(rel) || exhausted) return;
      try {
        const w = fs.watch(rel ? path.join(root, ...rel.split('/')) : root, { persistent: false }, (_type, filename) => {
          if (filename == null || filename === '') sink.hint(rel);
          else sink.hint(rel ? `${rel}/${toRel(filename)}` : toRel(filename));
        });
        w.on('error', () => {
          w.close();
          watchers.delete(rel);
          sink.hint(rel);
        });
        watchers.set(rel, w);
      } catch (err: any) {
        // ENOSPC = inotify watch limit. Keep what we have; the rest of the tree still works, just unwatched.
        if (err?.code === 'ENOSPC') {
          exhausted = true;
          console.warn('[sec-edit] inotify watch limit reached; some folders are not watched');
        }
      }
    },
    removeDir(rel) {
      for (const [k, w] of watchers) {
        if (k === rel || (rel === '' ? true : k.startsWith(rel + '/'))) {
          w.close();
          watchers.delete(k);
        }
      }
    },
    close() {
      for (const w of watchers.values()) w.close();
      watchers.clear();
    },
  };
  return backend;
}

function pollBackend(sink: HintSink, ms: number): WatchBackend {
  const timer = setInterval(() => sink.rescan(), ms);
  timer.unref?.();
  return { mode: 'poll', addDir() {}, removeDir() {}, close: () => clearInterval(timer) };
}
