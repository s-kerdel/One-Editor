// Wires editor extensions to the app singleton: link following, image URLs, completion data,
// settings + file-list subscriptions.
import type { EditorView } from '@codemirror/view';
import type { Settings } from '@shared/api';
import { dirname, join, normalize } from '@shared/paths';
import { resolveWikiTarget } from '@shared/wikilinks';
import { app } from '../app/app';
import { fileUrl } from '../platform';
import { setEditorHost, type LinkTarget } from './host';
import { scanTags, type CompletionHost } from './complete';

type KnowledgeLike = { tags?: () => unknown; headings?: (p: string) => Array<{ text: string; level: number }> };
const knowledge = () => (app as unknown as { knowledge?: KnowledgeLike }).knowledge;

let resolveCache = new Map<string, string | null>();
let cacheFiles: readonly string[] | null = null;
function resolveCached(target: string, from: string): string | null {
  const files = app.files.value;
  if (files !== cacheFiles) {
    cacheFiles = files;
    resolveCache = new Map();
  }
  const key = `${from}\u0000${target}`;
  let r = resolveCache.get(key);
  if (r === undefined) resolveCache.set(key, (r = resolveWikiTarget(target, files, from)));
  return r;
}

function safeDecode(s: string) {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

/** Workspace path for a relative markdown link target (relative to the note, then fuzzy). */
function resolveRelative(target: string, from: string): string | null {
  const clean = safeDecode(target.split(/[?#]/)[0]);
  if (!clean) return null;
  const files = app.files.value;
  const rel = clean.startsWith('/') ? normalize(clean) : normalize(join(dirname(from), clean));
  if (files.includes(rel)) return rel;
  return resolveCached(clean, from);
}

async function revealHeading(path: string, heading: string | undefined) {
  if (!heading) return;
  const text = app.editor?.getContent(path) ?? '';
  const want = heading.trim().toLowerCase();
  const slug = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(l);
    return m && (m[1].toLowerCase() === want || slug(m[1]) === slug(heading));
  });
  if (idx >= 0) app.editor?.reveal({ line: idx, col: 0 });
}

async function openLink(link: LinkTarget, from: string, opts: { newTab?: boolean }) {
  try {
    if (link.kind === 'url') {
      await app.backend.openExternal(link.target);
      return;
    }
    if (link.kind === 'anchor') {
      await revealHeading(from, link.heading);
      return;
    }
    if (link.kind === 'wiki') {
      if (app.openLink) {
        await app.openLink(link.heading ? `${link.target}#${link.heading}` : link.target, from, opts);
        return;
      }
      let path = link.target ? resolveWikiTarget(link.target, app.files.value, from) : from;
      if (!path) {
        // No knowledge module: create the note next to the current one (Obsidian behaviour).
        const name = /\.[a-z0-9]+$/i.test(link.target) ? link.target : `${link.target}.md`;
        path = normalize(link.target.includes('/') ? name : join(dirname(from), name));
        try {
          await app.backend.createFile(path, '');
        } catch {}
      }
      if (path !== from) await app.openFile(path);
      await revealHeading(path, link.heading);
      return;
    }
    const path = resolveRelative(link.target, from);
    if (!path) {
      app.toast(`Not found: ${link.target}`, 'error');
      return;
    }
    if (path !== from) await app.openFile(path);
    await revealHeading(path, link.heading);
  } catch (err) {
    app.toast(`Cannot open link: ${(err as Error).message}`, 'error');
  }
}

export const completionHost: CompletionHost = {
  files: () => app.files.value,
  async readText(path) {
    const doc = app.docs.get(path);
    if (doc) return app.editor?.getContent(path) ?? doc.content;
    try {
      return (await app.backend.readFile(path)).content;
    } catch {
      return null;
    }
  },
  tags() {
    const counts = new Map<string, number>();
    const add = (name: string | undefined, n: number) => {
      if (!name) return;
      const t = name.replace(/^#/, '');
      counts.set(t, (counts.get(t) ?? 0) + n);
    };
    // knowledge.tags() is a tree of { tag, count, children }; older shapes (string[] / Map) also accepted.
    const walk = (nodes: unknown) => {
      if (nodes instanceof Map) nodes.forEach((v, key) => add(String(key), typeof v === 'number' ? v : 1));
      else if (Array.isArray(nodes))
        for (const t of nodes) {
          if (typeof t === 'string') add(t, 1);
          else if (t && typeof t === 'object') {
            const o = t as { tag?: string; name?: string; count?: number; children?: unknown };
            add(o.tag ?? o.name, o.count ?? 1);
            if (o.children) walk(o.children);
          }
        }
    };
    try {
      walk(knowledge()?.tags?.());
    } catch {}
    for (const d of app.docs.values()) if (/\.(md|markdown|mdx)$/i.test(d.path)) scanTags(d.content, counts);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  },
  headings(path) {
    try {
      const hs = knowledge()?.headings?.(path);
      return Array.isArray(hs) && hs.length ? hs.map((h) => ({ text: h.text, level: h.level })) : null;
    } catch {
      return null;
    }
  },
  recent: () => app.tabs.value.map((t) => t.path),
};

let installed: (() => void) | null = null;

export function installEditorIntegration(ctx: { view: () => EditorView | null; path: () => string | null; refresh: () => void; applySettings: (s: Settings) => void }) {
  installed?.();
  setEditorHost({
    imageUrl(src, from, wiki) {
      if (/^(https?:|data:|blob:)/i.test(src)) return src;
      const ws = app.workspace.value;
      if (!ws || !app.backend) return null;
      const rel = wiki ? resolveCached(src.split('#')[0], from) : resolveRelative(src, from);
      return rel ? fileUrl(app.backend, ws.root, rel) : null;
    },
    wikiExists(target, from) {
      if (!target) return true;
      return resolveCached(target, from) !== null || !app.files.value.length;
    },
    openLink: (link, from, opts) => void openLink(link, from, opts),
    resolveWiki: (target, from) => (target ? resolveCached(target, from) : from),
    readNote: (path) => completionHost.readText(path),
    noteRevision: (path) => revisions.get(path) ?? 0,
  });
  // Embedded notes re-render when their source changes (another tab, external edit, save).
  const revisions = new Map<string, number>();
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  const bump = (path: string) => {
    if (path === ctx.path()) return; // the open note's own keystrokes
    revisions.set(path, (revisions.get(path) ?? 0) + 1);
    const v = ctx.view();
    if (!v || !v.dom.querySelector(`.se-note-embed[data-path="${CSS.escape(path)}"]`)) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => ctx.refresh(), 200);
  };
  const offs = [
    app.events.on('tree:changed', () => ctx.refresh()),
    app.events.on('settings:changed', (s) => ctx.applySettings(s)),
    app.events.on('doc:changed', bump),
    app.events.on('doc:saved', bump),
    app.events.on('file:updated', bump),
  ];
  installed = () => offs.forEach((o) => o());
}
