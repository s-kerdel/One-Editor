// "Open as text anyway" / "Load all": the backend half — a best-effort decode, the bounded window
// (asText: true) vs. the whole file (asText: 'full') with its ETOOBIG guard, and the flag routing
// through BackendService (the page's `opts` are untrusted).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_AS_TEXT_BYTES, MAX_AS_TEXT_FULL_BYTES } from '../../../src/shared/api';
import { Workspace } from '../../../src/backend/workspace';
import { decode, decodeBestEffort } from '../../../src/backend/textcodec';
import { BackendService } from '../../../src/backend/service';

let dir: string;
let ws: Workspace;
const p = (...s: string[]) => path.join(dir, ...s);

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sec-astext-'));
  ws = new Workspace(dir);
});
afterEach(async () => {
  ws.dispose();
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('decodeBestEffort', () => {
  it('turns what decode() refuses into text, and keeps the binary verdict', () => {
    const bytes = Buffer.from([0x89, 0x50, 0x00, 0x41, 0xff]);
    expect(decode(bytes).binary).toBe(true);
    expect(decode(bytes).text).toBe('');
    const d = decodeBestEffort(bytes);
    // NUL and the invalid bytes become U+FFFD: one character each, so the editor can hold the line.
    expect(d.text).toBe('\uFFFDP\uFFFDA\uFFFD');
    expect(d.binary).toBe(true); // the flag the renderer's save guard keys off
  });

  it('never returns empty for non-empty bytes', () => {
    expect(decodeBestEffort(Buffer.from([0, 0, 0])).text).toBe('\uFFFD\uFFFD\uFFFD');
    expect(decodeBestEffort(Buffer.alloc(0)).text).toBe('');
  });
});

describe('Workspace.readFile({ asText })', () => {
  it('returns nothing without the flag, best-effort text with it, still flagged binary', async () => {
    await fsp.writeFile(p('blob.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d]));
    const plain = await ws.readFile('blob.bin');
    expect(plain.binary).toBe(true);
    expect(plain.content).toBe('');
    const forced = await ws.readFile('blob.bin', { asText: true });
    expect(forced.binary).toBe(true); // never savable from the editor
    expect(forced.content).toContain('\uFFFD');
    expect(forced.size).toBe(8);
  });

  it('reads only a bounded window of a huge binary', async () => {
    const big = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.alloc(MAX_AS_TEXT_BYTES + 4096, 0x41)]);
    await fsp.writeFile(p('big.bin'), big);
    const f = await ws.readFile('big.bin', { asText: true });
    expect(f.binary).toBe(true);
    expect(f.size).toBe(big.length); // the real size is still reported
    expect(f.content.length).toBe(MAX_AS_TEXT_BYTES);
  });

  it('fails closed: even a text file read with the flag comes back marked binary', async () => {
    // No caller can turn a force-opened file into a savable one; the flag is what keeps writes blocked.
    await fsp.writeFile(p('note.md'), 'plain text\n');
    const f = await ws.readFile('note.md', { asText: true });
    expect(f.binary).toBe(true);
    expect(f.content).toBe('plain text\n');
  });

  it("asText: 'full' reads the whole file; the default stays capped next to it", async () => {
    // Just over the window, well under MAX_AS_TEXT_FULL_BYTES: the pair the "Load all" step is built on.
    const big = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.alloc(MAX_AS_TEXT_BYTES + 4096, 0x41)]);
    await fsp.writeFile(p('big.bin'), big);
    const windowed = await ws.readFile('big.bin', { asText: true });
    expect(windowed.content.length).toBe(MAX_AS_TEXT_BYTES);
    const full = await ws.readFile('big.bin', { asText: 'full' });
    expect(full.binary).toBe(true); // all of it is still never savable
    expect(full.size).toBe(big.length);
    expect(full.content.length).toBe(big.length);
  });

  it("refuses asText: 'full' above MAX_AS_TEXT_FULL_BYTES before reading, and caps the same file otherwise", async () => {
    await fsp.writeFile(p('huge.bin'), Buffer.from([0, 1, 2]));
    await fsp.truncate(p('huge.bin'), MAX_AS_TEXT_FULL_BYTES + 1); // sparse: only the size matters to the guard
    await expect(ws.readFile('huge.bin', { asText: 'full' })).rejects.toMatchObject({ code: 'ETOOBIG', message: expect.stringContaining('the limit is 16 MB') });
    const windowed = await ws.readFile('huge.bin', { asText: true });
    expect(windowed.content.length).toBe(MAX_AS_TEXT_BYTES);
    expect(windowed.size).toBe(MAX_AS_TEXT_FULL_BYTES + 1);
  });
});

describe('BackendService.readFile routing', () => {
  let tmp: string;
  let root: string;
  let svc: BackendService;
  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sec-astext-svc-'));
    root = path.join(tmp, 'notes');
    await fsp.mkdir(root, { recursive: true });
    await fsp.writeFile(path.join(root, 'blob.bin'), Buffer.from([0x00, 0x41, 0x00, 0x42]));
    svc = new BackendService(path.join(tmp, 'config'));
    await svc.openWorkspace(root);
  });
  afterEach(async () => {
    svc.dispose();
    await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  });

  it('passes only true and "full" through to the workspace', async () => {
    const forced = await svc.readFile('blob.bin', { asText: true });
    expect(forced.binary).toBe(true);
    expect(forced.content).toBe('\uFFFDA\uFFFDB');
    // Junk from the page is not a force flag: the normal refusal stands.
    for (const junk of [{ asText: 'yes' }, { asText: 1 }, { asText: null }, { asText: 'FULL' }, { asText: 'fullish' }, 'asText', undefined]) {
      const plain = await svc.readFile('blob.bin', junk as never);
      expect(plain.binary).toBe(true);
      expect(plain.content).toBe('');
    }
  });

  it("passes 'full' through: past the window, and ETOOBIG past MAX_AS_TEXT_FULL_BYTES", async () => {
    await fsp.writeFile(path.join(root, 'big.bin'), Buffer.from([0, 0, 0]));
    await fsp.truncate(path.join(root, 'big.bin'), MAX_AS_TEXT_BYTES + 1); // sparse: fast to make, all NUL
    const full = await svc.readFile('big.bin', { asText: 'full' });
    expect(full.content.length).toBe(MAX_AS_TEXT_BYTES + 1);
    expect(full.binary).toBe(true);
    const windowed = await svc.readFile('big.bin', { asText: true });
    expect(windowed.content.length).toBe(MAX_AS_TEXT_BYTES);
    await fsp.truncate(path.join(root, 'big.bin'), MAX_AS_TEXT_FULL_BYTES + 1);
    await expect(svc.readFile('big.bin', { asText: 'full' })).rejects.toMatchObject({ code: 'ETOOBIG' });
  });
});
