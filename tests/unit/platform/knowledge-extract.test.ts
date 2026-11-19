// Knowledge extraction off the main thread: worker entry, in-thread fallback, index plumbing, and the
// linear URL / tag scanners (must match the regexes they replaced exactly).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { extractNote, findTagsInLine, forEachUrl, maskUrls } from '../../../src/knowledge/extract';
import { KnowledgeIndex } from '../../../src/knowledge/index';
import { extractInline, extractor } from '../../../src/renderer/knowledge/extractor';

// ---- reference implementations (the previous regex versions) ----
const OLD_URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const OLD_TAG_RE = /(^|[\s(>,;:!?*_~=])#([\p{L}\p{N}_][\p{L}\p{N}_\-/]*)/gu;
const WIKI_RE = /(!?)\[\[([^\[\]\n]+?)\]\]/g;
const MD_LINK_RE = /(!?)\[((?:[^\[\]\\]|\\.)*)\]\(\s*(?:<([^<>\n]*)>|((?:[^()\s\\]|\\.|\([^()\s]*\))+))(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*\)/g;
const blank = (s: string) => ' '.repeat(s.length);
function oldTags(masked: string) {
  if (masked.indexOf('#') === -1) return [];
  const clean = masked.replace(WIKI_RE, blank).replace(MD_LINK_RE, blank).replace(OLD_URL_RE, blank);
  const out: Array<{ tag: string; col: number }> = [];
  OLD_TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OLD_TAG_RE.exec(clean))) {
    const tag = m[2].replace(/\/+$/, '');
    if (tag && !/^\d+$/.test(tag)) out.push({ tag, col: m.index + m[1].length });
  }
  return out;
}

// Deterministic fuzz over the characters that matter to both scanners.
function fuzz(n: number, seed: number): string[] {
  const alphabet = ['a', 'Z', '9', '_', '-', '.', '+', ':', '/', '//', '://', '#', ' ', '\t', '\u00a0', '\u3000', '(', '>', ',', '[[', ']]', '](', ')', '!', '*', '=', '~', 'é', 'ß', '日', '😀', 'http', 'HTTPS://', 'x-y.z', '#tag', '/#', '\\'];
  let s = seed;
  const rnd = (m: number) => ((s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff) % m);
  return Array.from({ length: n }, () => Array.from({ length: 1 + rnd(24) }, () => alphabet[rnd(alphabet.length)]).join(''));
}

describe('linear URL scanner', () => {
  const cases = [
    'see https://example.com/a?b=c#frag and http://x.y',
    'foo.bar.baz://x a+b-c.d://y _http://z x_https://q',
    'http:// nothing after',
    'a://b://c d://e',
    'urls:(https://x.dev/a) <http://y>',
    'mailto:me@x.com is not a URL; ftp://host/file',
    '9http://no ütf://x é://y',
    '',
    '://',
    'x://\u00a0y',
  ];
  it('finds the same spans as /\\b[a-z][a-z0-9+.-]*:\\/\\/\\S+/gi', () => {
    for (const line of [...cases, ...fuzz(4000, 7)]) {
      const want = [...line.matchAll(OLD_URL_RE)].map((m) => [m.index!, m.index! + m[0].length]);
      const got: number[][] = [];
      forEachUrl(line, (a, b) => got.push([a, b]));
      expect(got, JSON.stringify(line)).toEqual(want);
      expect(maskUrls(line)).toBe(line.replace(OLD_URL_RE, blank));
    }
  });

  // Timing budget: retried so a burst of CPU contention from the parallel suite can't fail it; a real regression fails every attempt.
  it('is linear on pathological input (long dotted runs before a ://)', { retry: 2 }, () => {
    const line = `${'a.'.repeat(200_000)}x ${'b.'.repeat(200_000)}://y`;
    const t = performance.now();
    maskUrls(line);
    expect(performance.now() - t).toBeLessThan(200);
  });
});

describe('tag scanner', () => {
  it('matches the previous global-regex implementation', () => {
    const cases = ['#a#b', '#a_#b', 'x #tag/sub/ y', '(#one) >#two ,#three', '#123 #1a #_x', 'foo#bar &#39;', '[[#nope]] [x](#nope) https://x.dev/#nope #yes', '*#em* ~#tilde =#eq', '#日本 #😀 #é-x'];
    for (const line of [...cases, ...fuzz(4000, 11)]) expect(findTagsInLine(line), JSON.stringify(line)).toEqual(oldTags(line));
  });
});

describe('extraction worker entry', () => {
  let posted: any[] = [];
  const g = globalThis as any;
  let prevSelf: unknown;
  beforeAll(async () => {
    prevSelf = g.self;
    g.self = { postMessage: (m: unknown) => posted.push(m), onmessage: null };
    await import('../../../src/knowledge/extract-worker');
  });
  afterAll(() => {
    g.self = prevSelf;
  });

  it('extracts the docs of a message, in order, like extractNote', () => {
    posted = [];
    const docs = [
      { path: 'a.md', text: '---\ntags: [x]\n---\n# A\nsee [[b]] #t https://u.dev/#no' },
      { path: 'dir/b.md', text: '## B ^blk\n- [ ] task\n[md](a.md#A)' },
    ];
    g.self.onmessage({ data: { type: 'extract', id: 7, docs } });
    expect(posted).toEqual([{ type: 'extracted', id: 7, infos: docs.map((d) => extractNote(d.path, d.text)) }]);
    // The result survives a structured clone (what postMessage does).
    expect(structuredClone(posted[0].infos)).toEqual(posted[0].infos);
  });

  it('reports failures for the request instead of dying', () => {
    posted = [];
    g.self.onmessage({ data: { type: 'extract', id: 8, docs: [{ path: 'x.md', text: null }] } });
    expect(posted[0]).toMatchObject({ type: 'error', id: 8 });
  });
});

describe('extractor client', () => {
  it('falls back to in-thread extraction when Worker is unavailable', async () => {
    expect(typeof (globalThis as any).Worker).toBe('undefined');
    const docs = [{ path: 'n.md', text: '# N\n[[x]] #y' }];
    expect(await extractor.extract(docs)).toEqual([extractNote('n.md', docs[0].text)]);
    expect(extractor.mode).toBe('inline');
    expect(await extractor.extract([])).toEqual([]);
  });

  it('moves pending jobs to the main thread when the worker fails', async () => {
    const workers: any[] = [];
    class FakeWorker {
      onmessage: any;
      onerror: any;
      onmessageerror: any;
      posted: any[] = [];
      constructor() {
        workers.push(this);
      }
      postMessage(m: any) {
        this.posted.push(m);
      }
      terminate() {}
    }
    vi.stubGlobal('Worker', FakeWorker);
    vi.resetModules();
    try {
      const { extractor: fresh } = await import('../../../src/renderer/knowledge/extractor');
      const a = fresh.extract([{ path: 'a.md', text: '[[b]]' }]);
      const b = fresh.extract([{ path: 'b.md', text: '#tag' }]);
      expect(fresh.mode).toBe('worker');
      expect(workers[0].posted.map((m: any) => m.id)).toEqual([1, 2]);
      // First job answered by the worker, then the worker dies: the second finishes in-thread.
      workers[0].onmessage({ data: { type: 'extracted', id: 1, infos: [extractNote('a.md', '[[b]]')] } });
      expect((await a)[0].links[0].target).toBe('b');
      workers[0].onerror({ message: 'boom', preventDefault() {} });
      expect((await b)[0].tags).toEqual(['tag']);
      expect(fresh.mode).toBe('inline');
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it('extractInline yields between slices but returns everything in order', async () => {
    const docs = Array.from({ length: 300 }, (_, i) => ({ path: `n${i}.md`, text: `# ${i}\n${'[[x]] #t '.repeat(400)}` }));
    const out = await extractInline(docs);
    expect(out.map((n) => n.path)).toEqual(docs.map((d) => d.path));
  });
});

describe('KnowledgeIndex with precomputed metadata', () => {
  it('update(path, text, info) is equivalent to extracting in place', () => {
    const a = new KnowledgeIndex();
    const b = new KnowledgeIndex();
    const notes: Array<[string, string]> = [
      ['a.md', '---\naliases: [Alpha]\n---\n# A\n[[b]] [[Gamma]] #x'],
      ['b.md', '# B\nback to [[Alpha]]'],
      ['c/Gamma.md', '#x/y\n[[nowhere]]'],
    ];
    for (const [p, t] of notes) a.update(p, t);
    for (const [p, t] of notes) b.update(p, t, extractNote(p, t));
    for (const p of ['a.md', 'b.md', 'c/Gamma.md']) {
      expect(b.note(p)).toEqual(a.note(p));
      expect(b.backlinks(p)).toEqual(a.backlinks(p));
    }
    expect(b.unresolvedLinks()).toEqual(a.unresolvedLinks());
    expect(b.tags()).toEqual(a.tags());
  });

  it('a folder rename reuses metadata (path + title updated, nothing re-parsed)', () => {
    const idx = new KnowledgeIndex();
    idx.update('old/One.md', '# One\n[[Two]] #t');
    idx.update('old/Two.md', '# Two');
    idx.rename('old', 'new');
    expect(idx.note('new/One.md')).toEqual(extractNote('new/One.md', '# One\n[[Two]] #t'));
    expect(idx.note('new/One.md')!.title).toBe('One');
    expect(idx.backlinks('new/Two.md').map((b) => b.from)).toEqual(['new/One.md']);
    expect(idx.note('old/One.md')).toBeUndefined();
  });
});
