import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExternalFiles } from '../../../src/backend/external-files';
import { BackendService } from '../../../src/backend/service';
import { EXT_PREFIX, extAbsOf, extDisplay, extIdOf, isExtPath } from '../../../src/shared/external';

let tmp: string;
let root: string;
let outside: string;
beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sec-ext-'));
  root = path.join(tmp, 'notes');
  outside = path.join(tmp, 'elsewhere');
  await fsp.mkdir(root, { recursive: true });
  await fsp.mkdir(outside, { recursive: true });
  await fsp.writeFile(path.join(root, 'in.md'), 'IN');
  await fsp.writeFile(path.join(outside, 'a.md'), 'one\r\ntwo\r\n');
  await fsp.writeFile(path.join(outside, 'secret.md'), 'SECRET');
});
afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
});

describe('external ids', () => {
  it('round-trips posix and Windows paths', () => {
    expect(extIdOf('/Users/me/a.md')).toBe(`${EXT_PREFIX}/Users/me/a.md`);
    expect(extAbsOf(extIdOf('/Users/me/a.md'), false)).toBe('/Users/me/a.md');
    expect(extIdOf('C:\\x\\a.md')).toBe(`${EXT_PREFIX}/C:/x/a.md`);
    expect(extAbsOf(extIdOf('C:\\x\\a.md'), true)).toBe('C:\\x\\a.md');
    expect(extAbsOf(extIdOf('\\\\srv\\share\\a.md'), true)).toBe('\\\\srv\\share\\a.md');
    expect(extDisplay(extIdOf('C:\\x\\a.md'))).toBe('C:/x/a.md');
  });
  it('refuses malformed ids', () => {
    expect(isExtPath('notes/a.md')).toBe(false);
    expect(extAbsOf('notes/a.md', false)).toBeNull();
    expect(extAbsOf(`${EXT_PREFIX}relative`, false)).toBeNull();
    expect(extAbsOf(`${EXT_PREFIX}/a\0b`, false)).toBeNull();
    expect(extAbsOf(`${EXT_PREFIX}/C:/x`, false)).toBeNull(); // a drive path is not a posix one
    expect(extAbsOf(`${EXT_PREFIX}/x/y`, true)).toBeNull();
  });
});

describe('ExternalFiles allow-list', () => {
  it('serves only allowed files', async () => {
    const x = new ExternalFiles({ pollMs: 100000 });
    const id = await x.allow(path.join(outside, 'a.md'));
    const f = await x.read(id);
    expect(f.content).toBe('one\ntwo\n');
    expect(f.eol).toBe('crlf');
    // The neighbour in the same folder was never opened.
    await expect(x.read(extIdOf(path.join(outside, 'secret.md')))).rejects.toMatchObject({ code: 'EACCES' });
    await expect(x.write(extIdOf(path.join(outside, 'secret.md')), 'x')).rejects.toMatchObject({ code: 'EACCES' });
    x.dispose();
  });

  it('path attacks: .. segments, NUL, relative, wrong prefix, folders, missing files', async () => {
    const x = new ExternalFiles({ pollMs: 100000 });
    const id = await x.allow(path.join(outside, 'a.md'));
    const real = extAbsOf(id, false)!;
    const evil = [
      `${EXT_PREFIX}${path.join(path.dirname(real), '..', 'elsewhere', 'secret.md')}`,
      `${EXT_PREFIX}${real}/../secret.md`,
      `${EXT_PREFIX}${real}\0`,
      `${EXT_PREFIX}../etc/passwd`,
      `${EXT_PREFIX}/etc/passwd`,
      real,
      '',
    ];
    for (const e of evil) await expect(x.read(e)).rejects.toMatchObject({ code: expect.stringMatching(/EACCES/) });
    await expect(x.allow('relative/a.md')).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(x.allow('/a\0b')).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(x.allow(outside)).rejects.toMatchObject({ code: 'EINVAL' }); // a folder
    await expect(x.allow(path.join(outside, 'nope.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(x.allow(42 as any)).rejects.toMatchObject({ code: 'EINVAL' });
    x.dispose();
  });

  it('opens through a link (the one the user opened) but pins the real file', async () => {
    const link = path.join(tmp, 'link.md');
    await fsp.symlink(path.join(outside, 'a.md'), link);
    const x = new ExternalFiles({ pollMs: 100000 });
    const id = await x.allow(link);
    expect(id).toBe(extIdOf(await fsp.realpath(link)));
    expect((await x.read(id)).content).toBe('one\ntwo\n');
    // Swap the real file for a link to another file: refused.
    const real = extAbsOf(id, false)!;
    await fsp.rm(real);
    await fsp.symlink(path.join(outside, 'secret.md'), real);
    await expect(x.read(id)).rejects.toMatchObject({ code: 'EACCES' });
    await expect(x.write(id, 'pwn')).rejects.toMatchObject({ code: 'EACCES' });
    expect(await fsp.readFile(path.join(outside, 'secret.md'), 'utf8')).toBe('SECRET');
    x.dispose();
  });

  it('writes keep EOL / BOM / encoding, detect changes on disk and refuse a read-only file', async () => {
    const p = path.join(outside, 'enc.txt');
    await fsp.writeFile(p, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\r\n')]));
    const x = new ExternalFiles({ pollMs: 100000 });
    const id = await x.allow(p);
    const f = await x.read(id);
    expect(f.bom).toBe(true);
    const w = await x.write(id, 'a\nb\nc\n', { expectedMtime: f.mtime, eol: f.eol, bom: f.bom });
    const bytes = await fsp.readFile(p);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.subarray(3).toString()).toBe('a\r\nb\r\nc\r\n');
    expect((await fsp.stat(p)).mtimeMs).toBe(w.mtime);
    await fsp.writeFile(p, 'changed elsewhere');
    await fsp.utimes(p, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    await expect(x.write(id, 'mine', { expectedMtime: w.mtime })).rejects.toMatchObject({ code: 'EXTERNAL_CHANGE' });
    x.dispose();
  });

  it('reports changes and deletions of allowed files, not its own writes', async () => {
    const x = new ExternalFiles({ pollMs: 100000 });
    const seen: any[] = [];
    x.onEvents((e) => seen.push(...e));
    const p = path.join(outside, 'a.md');
    const id = await x.allow(p);
    await x.read(id);
    await x.write(id, 'mine');
    await x.poll();
    expect(seen).toEqual([]);
    await fsp.writeFile(p, 'theirs, longer');
    await x.poll();
    expect(seen).toEqual([{ type: 'change', path: id, mtime: expect.any(Number) }]);
    seen.length = 0;
    await fsp.rm(p);
    await x.poll();
    expect(seen).toEqual([{ type: 'unlink', path: id }]);
    await x.poll();
    expect(seen).toHaveLength(1); // once
    x.dispose();
  });
});

describe('BackendService and outside files', () => {
  it('without the desktop hook nothing outside is served (server mode)', async () => {
    const s = new BackendService(path.join(tmp, 'cfg'));
    await s.openWorkspace(root);
    await expect(s.openExternalFile(path.join(outside, 'a.md'))).rejects.toMatchObject({ code: 'ENOTSUP' });
    await expect(s.readFile(extIdOf(path.join(outside, 'a.md')))).rejects.toMatchObject({ code: 'EACCES' });
    await expect(s.writeFile(extIdOf(path.join(outside, 'a.md')), 'x')).rejects.toMatchObject({ code: 'EACCES' });
    s.dispose();
  });

  it('with the hook: read / write through the id; no folder operation takes an outside id', async () => {
    const s = new BackendService(path.join(tmp, 'cfg'), { externalFiles: true });
    await s.openWorkspace(root);
    const id = await s.openExternalFile(path.join(outside, 'a.md'));
    expect((await s.readFile(id)).content).toBe('one\ntwo\n');
    await s.writeFile(id, 'new\n');
    expect(await fsp.readFile(path.join(outside, 'a.md'), 'utf8')).toBe('new\r\n');
    for (const op of [() => s.createFile(id), () => s.createDir(id), () => s.rename(id, 'x.md'), () => s.rename('in.md', id), () => s.remove(id), () => s.revealInFolder(id), () => s.writeBinary(id, 'AA==')])
      await expect(async () => op()).rejects.toMatchObject({ code: 'EINVAL' });
    expect(await fsp.readdir(root)).toEqual(['in.md']); // nothing was made inside the folder
    // The folder is unchanged and in-folder files still work.
    expect((await s.readFile('in.md')).content).toBe('IN');
    expect(s.workspace!.root).toBe(root);
    s.dispose();
  });
});
