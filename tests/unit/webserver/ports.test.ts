// The last browser-mode port per folder (browser state is per origin = per port) lives in app data.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { portCandidates, rememberPort, rememberedPort } from '../../../src/server/ports';

const dir = path.resolve(__dirname, '../../../.tmp/webserver/unit-ports');
fs.rmSync(dir, { recursive: true, force: true });
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('port per folder', () => {
  it('tries the asked-for port only, else the remembered one first, then 4317…', () => {
    expect(portCandidates(5000, 4400)).toEqual([5000]);
    const auto = portCandidates(null, null);
    expect(auto[0]).toBe(4317);
    expect(auto).toHaveLength(20);
    const sticky = portCandidates(null, 4319);
    expect(sticky.slice(0, 3)).toEqual([4319, 4317, 4318]);
    expect(new Set(sticky).size).toBe(sticky.length);
    expect(portCandidates(null, 6000)[0]).toBe(6000);
  });

  it('remembers per folder (not in the folder), most recent wins, bounded', async () => {
    const cfg = path.join(dir, 'a');
    expect(await rememberedPort(cfg, '/home/me/notes')).toBeNull();
    await rememberPort(cfg, '/home/me/notes', 4318);
    await rememberPort(cfg, '/home/me/work', 4317);
    expect(await rememberedPort(cfg, '/home/me/notes')).toBe(4318);
    expect(await rememberedPort(cfg, '/home/me/work')).toBe(4317);
    await rememberPort(cfg, '/home/me/notes', 4320);
    expect(await rememberedPort(cfg, '/home/me/notes')).toBe(4320);
    expect(fs.readdirSync(cfg)).toEqual(['web-ports.json']);
    // Several servers starting at once (locked read-modify-write): nobody's entry is lost.
    await Promise.all(Array.from({ length: 12 }, (_, i) => rememberPort(cfg, `/burst/${i}`, 5000 + i)));
    for (let i = 0; i < 12; i++) expect(await rememberedPort(cfg, `/burst/${i}`)).toBe(5000 + i);
    for (let i = 0; i < 200; i++) await rememberPort(cfg, `/f/${i}`, 6000 + (i % 100));
    const m = JSON.parse(fs.readFileSync(path.join(cfg, 'web-ports.json'), 'utf8'));
    expect(Object.keys(m)).toHaveLength(200);
    expect(await rememberedPort(cfg, '/home/me/notes')).toBeNull(); // the oldest dropped off
    expect(await rememberedPort(cfg, '/f/199')).toBe(6099);
  }, 20_000);

  it('ignores a broken or hand-edited file', async () => {
    const cfg = path.join(dir, 'b');
    fs.mkdirSync(cfg, { recursive: true });
    fs.writeFileSync(path.join(cfg, 'web-ports.json'), '{ nope');
    expect(await rememberedPort(cfg, '/x')).toBeNull();
    await rememberPort(cfg, '/x', 4400);
    expect(await rememberedPort(cfg, '/x')).toBe(4400);
    fs.writeFileSync(path.join(cfg, 'web-ports.json'), JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(cfg, 'web-ports.json'), 'utf8'))).map(([k]) => [k, 80]))));
    expect(await rememberedPort(cfg, '/x')).toBeNull();
  });
});
