// Undo history caps (src/mcp/journal.ts): groups past the age go, then the oldest while over the size cap;
// switched off, nothing new is written; damaged entries are refused.
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Journal, readGroup } from '../../../src/mcp/journal';

const tmp = path.resolve(__dirname, '../../../.tmp/mcp/unit', `journal-${crypto.randomBytes(4).toString('hex')}`);
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const DAY = 24 * 3600_000;
const entry = { client: 'c', tool: 'write_file', root: '/r', folder: 'f', op: 'write' as const, path: 'a.md', after: { mtime: 1, size: 1 } };

describe('Journal', () => {
  it('drops groups older than the age cap, then the oldest while over the size cap', async () => {
    const dir = path.join(tmp, 'caps');
    let now = Date.UTC(2026, 0, 1);
    const j = new Journal(dir, { now: () => now, maxAgeMs: () => 10 * DAY, maxBytes: 2500 });
    const old = j.newGroup();
    await j.add(old, entry, Buffer.alloc(1000));
    now += 5 * DAY;
    const mid = j.newGroup();
    await j.add(mid, entry, Buffer.alloc(1000));
    now += 6 * DAY; // `old` is 11 days old now
    const fresh = j.newGroup();
    await j.add(fresh, entry, Buffer.alloc(1000));
    await j.prune(true);
    expect(fs.readdirSync(dir).sort()).toEqual([mid, fresh].sort());
    const big = j.newGroup();
    await j.add(big, entry, Buffer.alloc(1500)); // total now over 2500 bytes: the oldest go first
    await j.prune(true);
    expect(fs.readdirSync(dir)).toEqual([big]);
  });

  it('switched off: add writes nothing', async () => {
    const dir = path.join(tmp, 'off');
    const j = new Journal(dir, { enabled: () => false });
    expect(j.enabled).toBe(false);
    await j.add(j.newGroup(), entry, Buffer.from('x'));
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('reads back a group; refuses bad ids and damaged entries', async () => {
    const dir = path.join(tmp, 'read');
    const j = new Journal(dir);
    const g = j.newGroup();
    await j.add(g, entry, Buffer.from('old'));
    const r = await readGroup(dir, g);
    expect(r.entries[0]).toMatchObject({ op: 'write', path: 'a.md', bytes: true });
    expect(fs.readFileSync(path.join(dir, g, '0.bin'), 'utf8')).toBe('old');
    await expect(readGroup(dir, '../x')).rejects.toMatchObject({ code: 'EINVAL' });
    fs.writeFileSync(path.join(dir, g, '0.json'), JSON.stringify({ ...r.entries[0], op: 'rm -rf' }));
    await expect(readGroup(dir, g)).rejects.toMatchObject({ code: 'EINVAL' });
  });
});
