// Workspace symbol index in the search engine: exact-name lookup (O(1) per name), incremental with the
// rest of the index, workspace symbols for Ctrl+T, and shard merges that equal one index exactly.
import { describe, expect, it } from 'vitest';
import { SearchEngine } from '../../../src/search/engine';
import { SearchHost } from '../../../src/search/host';
import { ShardedSearch } from '../../../src/search/shards';
import { synthDocs } from './synth';

const engine = (docs: Record<string, string>) => {
  const e = new SearchEngine({ defs: true });
  e.reset(Object.entries(docs).map(([path, content]) => ({ path, content })));
  return e;
};
const at = (hits: Array<{ path: string; line: number }>) => hits.map((h) => `${h.path}:${h.line}`);

const DOCS: Record<string, string> = {
  'app/Models/User.php': '<?php\nnamespace App\\Models;\nclass User extends Model\n{\n    public function save() {}\n}\n',
  'app/Http/UserController.php': '<?php\nnamespace App\\Http;\nclass UserController\n{\n    public function save() {}\n    public function index() {}\n}\n',
  'src/user.ts': 'export class User {\n  save() {}\n}\nexport function makeUser() {}\n',
  'notes/user.md': '# User\n\nclass User in a note is no definition\n',
  'styles/app.css': ':root {\n  --gap: 4px;\n}\n',
};

describe('definitions()', () => {
  it('finds every definition of an exact name, sorted by path / line; language filter', () => {
    const e = engine(DOCS);
    expect(at(e.definitions({ names: ['User'] }))).toEqual(['app/Models/User.php:2', 'src/user.ts:0']);
    expect(at(e.definitions({ names: ['save'], langs: ['php', 'blade'] }))).toEqual(['app/Http/UserController.php:4', 'app/Models/User.php:4']);
    expect(e.definitions({ names: ['User'], langs: ['php'] })[0]).toMatchObject({ kind: 'class', ns: 'App\\Models', ext: 'Model', lang: 'php', text: 'class User extends Model', col: 6, end: 5 });
    expect(e.definitions({ names: ['--gap'] })[0]).toMatchObject({ path: 'styles/app.css', kind: 'property' });
    expect(e.definitions({ names: ['nothing'] })).toEqual([]);
  });

  it('matches case-insensitively (PHP names are); callers prefer exact case', () => {
    const e = engine(DOCS);
    expect(at(e.definitions({ names: ['user'] }))).toEqual(['app/Models/User.php:2', 'src/user.ts:0']);
  });

  it('is incremental: edits, removals and renames update the name map', () => {
    const e = engine(DOCS);
    e.upsert({ path: 'src/user.ts', content: 'export class Member {}\n' });
    expect(at(e.definitions({ names: ['User'] }))).toEqual(['app/Models/User.php:2']);
    expect(at(e.definitions({ names: ['Member'] }))).toEqual(['src/user.ts:0']);
    e.remove('app/Models/User.php');
    expect(e.definitions({ names: ['User'] })).toEqual([]);
    e.rename('src', 'lib');
    expect(at(e.definitions({ names: ['Member'] }))).toEqual(['lib/user.ts:0']);
    e.clear();
    expect(e.definitions({ names: ['Member'] })).toEqual([]);
  });

  it('extraction is off the build path: queued, drained in slices, finished by any query that needs it', async () => {
    const e = engine(DOCS);
    expect(e.pendingDefs).toBe(4); // the code files; notes and CSS-free text cost nothing
    e.flushDefs(0); // a slice of (at least) one batch
    expect(e.definitions({ names: ['User'] })).toHaveLength(2); // the query finished the queue
    expect(e.pendingDefs).toBe(0);
    e.upsert({ path: 'src/new.ts', content: 'export function fresh() {}\n' });
    expect(e.headings('fresh', { symbols: true }).map((h) => h.text)).toEqual(['fresh']);

    // A shard drains its queue right after it reports `indexed`, while staying responsive.
    const posts: string[] = [];
    const host = new SearchHost((m) => posts.push(m.type));
    host.handle({ type: 'reset', gen: 1, docs: Object.entries(DOCS).map(([path, content]) => ({ path, content })) });
    expect(posts).toEqual(['indexed']);
    await expect.poll(() => host.engine.pendingDefs).toBe(0);
  });

  it('engines without `defs` (MCP, replace) keep no symbol index', () => {
    const e = new SearchEngine();
    e.reset(Object.entries(DOCS).map(([path, content]) => ({ path, content })));
    expect(e.definitions({ names: ['User'] })).toEqual([]);
  });

  it('lookup stays far below 5 ms with thousands of files defining the same name', () => {
    const docs: Record<string, string> = {};
    for (let i = 0; i < 3000; i++) docs[`src/c${i}.ts`] = `export class C${i} {\n  constructor() {}\n  render() {}\n  a${i}() {}\n}\n`;
    const e = engine(docs);
    e.definitions({ names: ['C7'] }); // warm up
    let t = performance.now();
    const one = e.definitions({ names: ['C2999'] });
    const rare = performance.now() - t;
    t = performance.now();
    const many = e.definitions({ names: ['render'] });
    const common = performance.now() - t;
    expect(one).toHaveLength(1);
    expect(many).toHaveLength(500); // capped
    expect(rare).toBeLessThan(5);
    expect(common).toBeLessThan(30); // 3,000 files, sorted + capped (sharded in the app)
  });
});

describe('workspace symbols (Ctrl+T)', () => {
  it('headings and code symbols in one fuzzy list, with kind and container', () => {
    const e = engine(DOCS);
    const hits = e.headings('user', { symbols: true });
    expect(hits.map((h) => `${h.path}:${h.text}:${h.kind ?? 'H' + h.level}`)).toEqual(expect.arrayContaining(['notes/user.md:User:H1', 'app/Models/User.php:User:class', 'src/user.ts:User:class', 'src/user.ts:makeUser:function']));
    expect(e.headings('user').every((h) => !h.kind)).toBe(true); // without `symbols`: headings only
    expect(e.headings('', { symbols: true }).every((h) => !h.kind)).toBe(true); // empty query: no symbol flood
    expect(e.headings('save', { symbols: true }).find((h) => h.path === 'src/user.ts')).toMatchObject({ container: 'User', level: 2 });
  });

  it('at most 20 symbols per file across the workspace, all of them for a file query', () => {
    const big = Array.from({ length: 200 }, (_, i) => `function handler${i}() {}`).join('\n');
    const e = engine({ 'gen/big.js': big, 'src/a.js': 'function handleIt() {}\n' });
    const hits = e.headings('handle', { symbols: true, limit: 100 });
    expect(hits.filter((h) => h.path === 'gen/big.js')).toHaveLength(20);
    expect(hits.some((h) => h.path === 'src/a.js')).toBe(true);
    expect(e.headings('handler', { symbols: true, fileQuery: 'big', limit: 500 })).toHaveLength(200);
  });
});

describe('sharded symbol index equals one index', () => {
  function sharded(n: number) {
    let s!: ShardedSearch;
    const ports = Array.from({ length: n }, (_, i) => {
      const host = new SearchHost(
        (m) => setTimeout(() => s.onMessage(i, m), 0),
        () => new Promise((r) => setTimeout(r, 0)),
      );
      return { post: (m: Parameters<SearchHost['handle']>[0]) => setTimeout(() => host.handle(m), 0) };
    });
    s = new ShardedSearch(ports);
    return s;
  }
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const code = Array.from({ length: 300 }, (_, i) => ({
    path: `pkg${i % 7}/m${i}.${['ts', 'php', 'py', 'go'][i % 4]}`,
    content: [`class Thing${i % 13} {`, `  run${i % 5}() {}`, '}', `function helper${i % 11}() {}`, `def task${i % 3}(): pass`, `func Serve${i % 4}() {}`].join('\n'),
  }));
  const corpus = [...synthDocs(200, 3), ...code];

  for (const n of [1, 3, 8]) {
    it(`${n} shard(s): definitions + workspace symbols identical`, async () => {
      const one = new SearchEngine({ defs: true });
      one.reset(corpus);
      const s = sharded(n);
      s.reset(1);
      s.append(1, corpus.slice(0, 250), false);
      s.append(1, corpus.slice(250), true);
      const edit = { path: code[4].path, content: 'class Renamed {}\nfunction helper3() {}\n' };
      one.upsert(edit);
      s.upsert([edit]);
      one.rename('pkg2', 'pkg2b');
      s.rename('pkg2', 'pkg2b');
      one.remove(code[9].path);
      s.remove([code[9].path]);
      await settle();
      for (const q of [{ names: ['Thing3'] }, { names: ['helper3'], langs: ['typescript', 'javascript'] }, { names: ['run2', 'task1'] }, { names: ['Renamed'] }, { names: ['thing1'] }, { names: ['helper1'], limit: 7 }]) {
        expect(await s.definitions(q), JSON.stringify(q)).toEqual(one.definitions(q));
      }
      for (const hq of [{ query: 'thing', symbols: true }, { query: 'help', symbols: true, limit: 15 }, { query: 'serve', symbols: true, fileQuery: 'pkg1' }]) {
        expect(await s.headings(hq), JSON.stringify(hq)).toEqual(one.headings(hq.query, hq));
      }
    });
  }
});
