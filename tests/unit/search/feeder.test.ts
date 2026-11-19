// Shard 0's feeder pulls the text from the backend's index channel and routes it to its peers:
// the resulting sharded index answers exactly like one index fed the same files; incremental
// refreshes upsert / drop just the changed files and report note metadata.
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { startServer, type RunningServer } from '../../../src/server/server';
import { SearchHost } from '../../../src/search/host';
import { Feeder, fetchJson } from '../../../src/search/feeder';
import { ShardedSearch } from '../../../src/search/shards';
import { SearchEngine } from '../../../src/search/engine';
import type { FromWorker, NoteItem, ToWorker } from '../../../src/search/protocol';

const TMP = path.resolve(__dirname, '../../../.tmp/unit-feeder');
let server: RunningServer;
let dir: string;

beforeAll(async () => {
  await fsp.mkdir(TMP, { recursive: true });
  dir = await fsp.mkdtemp(path.join(TMP, 'ws-'));
  for (let i = 0; i < 200; i++) {
    fs.mkdirSync(path.join(dir, `f${i % 5}`), { recursive: true });
    fs.writeFileSync(path.join(dir, `f${i % 5}`, `note-${i}.md`), `# Note ${i}\n\nrollback deploy ${i} see [[note-${(i + 1) % 200}]]\n`);
  }
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"rollback": true}');
  server = await startServer({ root: dir, port: 0, rendererDir: dir, configDir: path.join(dir, '..', `${path.basename(dir)}-cfg`) });
});
afterAll(async () => {
  await server?.close();
  await fsp.rm(dir, { recursive: true, force: true });
});

function cluster(n: number) {
  const out: Array<{ shard: number; m: FromWorker }> = [];
  let s!: ShardedSearch;
  const hosts = Array.from({ length: n }, (_, i) => new SearchHost((m) => (out.push({ shard: i, m }), s.onMessage(i, m)), () => new Promise((r) => setTimeout(r, 0))));
  s = new ShardedSearch(hosts.map((h) => ({ post: (m: ToWorker) => h.handle(m) })));
  const feeder = new Feeder((m) => hosts[0].handle(m), hosts.slice(1).map((h) => ({ postMessage: (m: ToWorker) => h.handle(m) })), (m) => out.push({ shard: 0, m }), fetchJson);
  return { s, hosts, feeder, out };
}

describe('feeder', () => {
  it('feeds every shard from the index channel; same answers as one index', async () => {
    const src = { base: new URL('api/index/', server.origin).toString(), token: server.token, header: 'x-sec-edit-token' };
    const { s, hosts, feeder, out } = cluster(3);
    s.reset(1);
    await feeder.feed(1, src, 64 * 1024);
    await new Promise((r) => setTimeout(r, 50));
    expect(out.filter((o) => o.m.type === 'indexed').length).toBe(3);
    expect(hosts.reduce((n, h) => n + h.engine.size, 0)).toBe(200); // the lockfile is skipped
    const notes = out.flatMap((o) => (o.m.type === 'notes' ? o.m.items : [])) as NoteItem[];
    expect(notes.length).toBe(200);
    expect(notes[0].snippets.length).toBe(notes[0].info.links.length);
    expect(out.some((o) => o.m.type === 'progress' && o.m.total === 200)).toBe(true);
    const one = new SearchEngine();
    one.reset(fs.readdirSync(dir).flatMap((d) => (fs.statSync(path.join(dir, d)).isDirectory() ? fs.readdirSync(path.join(dir, d)).map((f) => ({ path: `${d}/${f}`, content: fs.readFileSync(path.join(dir, d, f), 'utf8') })) : [])));
    for (const q of ['rollback deploy 17', 'note-3', 'rolback']) {
      const a = one.search(q);
      const b = await s.search(q, {}, q);
      expect({ ...b, tookMs: 0 }).toEqual({ ...a, tookMs: 0 });
    }

    // Incremental: one edited, one deleted, one new file → just those.
    fs.writeFileSync(path.join(dir, 'f0', 'note-0.md'), '# Note 0\n\nchanged zebracorn text\n');
    fs.rmSync(path.join(dir, 'f1', 'note-1.md'));
    fs.writeFileSync(path.join(dir, 'f2', 'brand-new.md'), '# New\n\nzebracorn arrives\n');
    out.length = 0;
    const paths = ['f0/note-0.md', 'f1/note-1.md', 'f2/brand-new.md'];
    await feeder.refresh(7, src, paths, s.shardMap(paths));
    await new Promise((r) => setTimeout(r, 20));
    expect(out.find((o) => o.m.type === 'refreshed')?.m).toMatchObject({ id: 7, files: 2, removed: 1 });
    expect((await s.search('zebracorn', {}, 'z'))?.results.map((r) => r.path).sort()).toEqual(['f0/note-0.md', 'f2/brand-new.md']);
    expect((await s.search('rollback deploy 1 see', {}, 'r'))?.results.some((r) => r.path === 'f1/note-1.md')).toBe(false);
    const upd = out.filter((o) => o.m.type === 'notes').flatMap((o) => (o.m.type === 'notes' ? [...o.m.items.map((i) => i.path), ...(o.m.removed ?? [])] : []));
    expect(upd.sort()).toEqual(paths.slice().sort());
  });
});
