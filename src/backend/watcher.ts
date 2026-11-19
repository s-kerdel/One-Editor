// Low-level change *hints*. Watchers only say "something happened at <rel>"; the Workspace reconciles
// hints against its index (stat + diff), so event semantics are identical on every OS and our own
// writes never echo back.
//
// Strategy per OS (chosen for robustness, not cleverness):
//  - win32 / darwin: one native recursive fs.watch (ReadDirectoryChangesW / FSEvents). A single handle on
//    the root, so Explorer can still rename/delete subfolders (per-dir handles lock them on Windows).
//  - linux: one inotify watch per *indexed* directory. Excluded folders (node_modules) are never watched,
//    which keeps us far from inotify limits; Node's recursive mode on Linux would watch everything.
//  - WSL / UNC roots (\\wsl.localhost\<distro>\…, \\server\share): every call crosses a slow bridge and
//    recursive fs.watch is unreliable there. Windows + a WSL root: inotifywait run *inside* the distro
//    (`wsl.exe -d <distro> --exec inotifywait -mrq …`), when installed; otherwise `dirpoll`: poll the
//    mtimes of indexed folders only (adaptive 2–10 s, paused while the window is hidden) and diff a
//    changed folder against the workspace index — one stat per folder per tick, one readdir per change.
//  - fallback: polling rescan (watcher errors).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { watchHint } from './pathsafe';
import { isBridgeRoot } from './readpool';
import { fsDelayAsync } from './fsdelay';

export interface HintSink {
  hint(rel: string): void;
  /** Watcher lost events (overflow / error): diff the whole tree. */
  rescan(): void;
}

export type WatchMode = 'recursive' | 'perdir' | 'poll' | 'dirpoll' | 'wsl';

export interface WatchBackend {
  readonly mode: WatchMode;
  /** Wants addDir/removeDir for every indexed folder (perdir, dirpoll). */
  readonly wantsDirs?: boolean;
  /** perdir / dirpoll: start watching a directory (rel '' = root). */
  addDir(rel: string): void;
  /** perdir / dirpoll: stop watching a directory and everything below it. */
  removeDir(rel: string): void;
  /** dirpoll: hold polling (window hidden). */
  pause?(on: boolean): void;
  close(): void;
}

/** What the folder poller needs from the workspace: names it knows in a folder, files worth polling. */
export interface DirPollSource {
  /** Entry names the index has directly inside `rel`. */
  children(rel: string): Set<string>;
  /** Open / recently used files: their content changes do not touch the folder's mtime. */
  hotFiles(): string[];
}

export function defaultWatchMode(root = ''): WatchMode {
  const forced = process.env.SEC_EDIT_WATCH as WatchMode | undefined;
  if (forced === 'recursive' || forced === 'perdir' || forced === 'poll' || forced === 'dirpoll' || forced === 'wsl') return forced;
  if (isBridgeRoot(root)) return process.platform === 'win32' && wslTarget(root) ? 'wsl' : 'dirpoll';
  return process.platform === 'linux' ? 'perdir' : 'recursive';
}

/** `\\wsl.localhost\Ubuntu\home\me\notes` → { distro: 'Ubuntu', path: '/home/me/notes' }. */
export function wslTarget(root: string): { distro: string; path: string } | null {
  const m = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)((?:[\\/][^\\/]*)*)$/i.exec(root);
  if (!m) return null;
  const rest = m[2].replace(/\\/g, '/').replace(/\/+$/, '');
  return { distro: m[1], path: rest || '/' };
}

// Windows also reports alternate data streams ("x.zip:Zone.Identifier"): map them to the file itself.
const toRel = (filename: string | Buffer) => watchHint(String(filename), path, process.platform === 'win32');

export function createWatchBackend(root: string, sink: HintSink, mode: WatchMode = defaultWatchMode(root), pollMs = 4000, src?: DirPollSource, excluded: string[] = []): WatchBackend {
  if (mode === 'dirpoll' && src) return dirPollBackend(root, sink, src);
  if (mode === 'wsl' && src) return wslBackend(root, sink, src, excluded);
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
    wantsDirs: true,
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

/** Runs `fn` over `items` with at most `n` in flight. */
async function eachLimit<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

export interface DirPollOptions {
  minMs?: number;
  maxMs?: number;
  concurrency?: number;
}

/**
 * Polls folder mtimes (adding / removing / renaming an entry bumps its folder's mtime; editing a file's
 * content does not — those are covered for the files that matter via `hotFiles`). A changed folder is
 * read once and diffed against the index: hints for new and vanished names only.
 */
export function dirPollBackend(root: string, sink: HintSink, src: DirPollSource, o: DirPollOptions = {}): WatchBackend {
  const minMs = o.minMs ?? 2000;
  const maxMs = o.maxMs ?? 10_000;
  const dirs = new Map<string, number | undefined>();
  const files = new Map<string, number | undefined>();
  let interval = minMs;
  let timer: NodeJS.Timeout | null = null;
  let paused = false;
  let closed = false;
  let running = false;
  const abs = (rel: string) => (rel ? path.join(root, ...rel.split('/')) : root);
  const stat = async (rel: string) => {
    await fsDelayAsync();
    return fsp.stat(abs(rel)).catch(() => null);
  };
  const schedule = () => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void tick(), interval);
    timer.unref?.();
  };
  const tick = async () => {
    timer = null;
    if (closed || running) return;
    if (paused) return; // resumed by pause(false)
    running = true;
    let changed = false;
    try {
      await eachLimit([...dirs.keys()], o.concurrency ?? 8, async (rel) => {
        const st = await stat(rel);
        const prev = dirs.get(rel);
        if (!dirs.has(rel)) return;
        if (!st) {
          dirs.delete(rel);
          sink.hint(rel); // folder gone: the workspace drops it and everything below
          changed = true;
          return;
        }
        dirs.set(rel, st.mtimeMs);
        if (prev === undefined || prev === st.mtimeMs) return; // first sighting / unchanged
        changed = true;
        await fsDelayAsync();
        const names = await fsp.readdir(abs(rel)).catch(() => null);
        if (!names) return sink.hint(rel);
        const known = src.children(rel);
        const now = new Set(names);
        for (const n of names) if (!known.has(n)) sink.hint(rel ? `${rel}/${n}` : n);
        for (const n of known) if (!now.has(n)) sink.hint(rel ? `${rel}/${n}` : n);
      });
      const hot = src.hotFiles();
      for (const k of [...files.keys()]) if (!hot.includes(k)) files.delete(k);
      await eachLimit(hot, o.concurrency ?? 8, async (rel) => {
        const had = files.has(rel);
        const prev = files.get(rel);
        const st = await stat(rel);
        files.set(rel, st?.mtimeMs);
        if (had && prev !== st?.mtimeMs) {
          sink.hint(rel);
          changed = true;
        }
      });
    } finally {
      running = false;
    }
    interval = changed ? minMs : Math.min(maxMs, Math.round(interval * 1.5));
    schedule();
  };
  schedule();
  return {
    mode: 'dirpoll',
    wantsDirs: true,
    addDir(rel) {
      if (!dirs.has(rel)) dirs.set(rel, undefined);
    },
    removeDir(rel) {
      for (const k of [...dirs.keys()]) if (k === rel || rel === '' || k.startsWith(rel + '/')) dirs.delete(k);
    },
    pause(on) {
      if (paused === on) return;
      paused = on;
      if (!on) {
        interval = minMs;
        schedule();
      }
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * Windows with a `\\wsl.localhost\<distro>\…` root: inotify inside the distro sees every change
 * natively (no polling, nothing crosses the bridge but the changed paths). Needs inotify-tools in the
 * distro; when missing or when it dies, falls back to dirpoll.
 */
export function wslBackend(root: string, sink: HintSink, src: DirPollSource, excluded: string[], spawnFn: typeof spawn = spawn): WatchBackend {
  const target = wslTarget(root);
  const poll = () => dirPollBackend(root, sink, src);
  if (!target) return poll();
  const exclude = excluded.length ? ['--exclude', `(^|/)(${excluded.map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(/|$)`] : [];
  let fallback: WatchBackend | null = null;
  const dirsSeen = new Set<string>();
  let child: ChildProcess | null = null;
  let closed = false;
  try {
    child = spawnFn('wsl.exe', ['-d', target.distro, '--exec', 'inotifywait', '-mrq', '-e', 'modify,create,delete,move,attrib', '--format', '%w%f', ...exclude, target.path], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return poll();
  }
  let buf = '';
  const base = target.path.endsWith('/') ? target.path : target.path + '/';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (d: string) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line.startsWith(base)) sink.hint(line.slice(base.length));
      else if (line === target.path) sink.rescan();
    }
  });
  const fail = () => {
    if (closed || fallback) return;
    fallback = poll(); // inotify-tools missing, watch limit, distro stopped …
    for (const d of dirsSeen) fallback.addDir(d);
    sink.rescan();
  };
  child.on('error', fail);
  child.on('exit', fail);
  return {
    mode: 'wsl',
    wantsDirs: true, // kept for the fallback
    addDir(rel) {
      dirsSeen.add(rel);
      fallback?.addDir(rel);
    },
    removeDir(rel) {
      for (const d of [...dirsSeen]) if (d === rel || rel === '' || d.startsWith(rel + '/')) dirsSeen.delete(d);
      fallback?.removeDir(rel);
    },
    pause(on) {
      fallback?.pause?.(on);
    },
    close() {
      closed = true;
      child?.kill();
      fallback?.close();
    },
  };
}
