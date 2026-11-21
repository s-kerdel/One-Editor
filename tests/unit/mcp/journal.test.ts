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
  it('drops groups older than the age cap, then the oldest earlier-session group while over the size cap', async () => {
    const dir = path.join(tmp, 'caps');
    let now = Date.UTC(2026, 0, 1);
    const opts = { now: () => now, maxAgeMs: () => 10 * DAY, maxBytes: 2500 };
    const earlier = new Journal(dir, opts); // a session that ended
    const old = earlier.newGroup();
    await earlier.add(old, entry, Buffer.alloc(1000));
    now += 5 * DAY;
    const mid = earlier.newGroup();
    await earlier.add(mid, entry, Buffer.alloc(1000));
    now += 6 * DAY; // `old` is 11 days old now
    const j = new Journal(dir, opts);
    const fresh = j.newGroup();
    await j.add(fresh, entry, Buffer.alloc(1000));
    await j.prune(true);
    expect(fs.readdirSync(dir).sort()).toEqual([mid, fresh].sort());
    const big = j.newGroup();
    await j.add(big, entry, Buffer.alloc(1500)); // over 2500 bytes: the earlier session's goes, this session's stay
    await j.prune(true);
    expect(fs.readdirSync(dir).sort()).toEqual([fresh, big].sort());
  });

  it('one session cannot flush the history: no eviction of this session or the last 24 h; EQUOTA instead', async () => {
    const dir = path.join(tmp, 'flush');
    let now = Date.UTC(2026, 0, 1);
    const opts = { now: () => now, maxBytes: 4000 };
    const user = new Journal(dir, opts); // the edits a user may want back: 3 days and 2 hours old
    const g3d = user.newGroup();
    await user.add(g3d, entry, Buffer.alloc(1000));
    now += 3 * DAY - 2 * 3600_000;
    const g2h = user.newGroup();
    await user.add(g2h, entry, Buffer.alloc(1000));
    now += 2 * 3600_000;
    const attacker = new Journal(dir, opts);
    // Room for one copy: the 3-day-old group goes (older than 24 h, earlier session), the 2-hour-old stays.
    await attacker.reserve(2500);
    await attacker.add(attacker.newGroup(), entry, Buffer.alloc(2500));
    expect(fs.readdirSync(dir)).toContain(g2h);
    // Full of this session and the last 24 h: refused, nothing more evicted.
    await expect(attacker.reserve(2000)).rejects.toMatchObject({ code: 'EQUOTA' });
    expect(fs.readdirSync(dir)).toContain(g2h);
    // A per-session byte quota too.
    const small = new Journal(path.join(tmp, 'session'), { sessionBytes: 3000 });
    await small.reserve(2000);
    await expect(small.reserve(2000)).rejects.toMatchObject({ code: 'EQUOTA', message: expect.stringMatching(/session/) });
    // A delete's copy is forced even with undo copies off; one too big for a copy is refused.
    const off = new Journal(path.join(tmp, 'off'), { enabled: () => false });
    await off.reserve(10); // not forced: no-op
    await off.reserve(10, true);
    await expect(off.reserve(17 * 1024 * 1024, true)).rejects.toMatchObject({ code: 'EQUOTA' });
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
