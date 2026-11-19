// Text frames (indexer → search worker pages): exact round trip, forwarded UTF-8 bytes used as-is,
// and the indexer only forwards disk bytes when they really are the text's UTF-8.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { decodeTextFrame, encodeTextFrame, isTextFrame, type FrameFile } from '../../../src/shared/textframe';
import { Indexer, DEFAULT_INDEX } from '../../../src/backend/indexer';

const TMP = path.resolve(__dirname, '../../../.tmp/unit-textframe');

describe('text frames', () => {
  it('round-trips texts, metadata and the page fields', () => {
    const files: FrameFile[] = [
      { path: 'a.md', content: '# A\n\nplain', mtime: 1.5, eol: 'lf', size: 11 },
      { path: 'dir/ü ñ.md', content: 'naïve 日本 😀 "quotes" \\ back\nslash', mtime: 2, eol: 'crlf', size: 40, bom: true },
      { path: 'w.txt', content: 'cp1252 €', mtime: 3, eol: 'lf', encoding: 'windows-1252' },
      { path: 'empty.md', content: '', mtime: 4, eol: 'lf' },
    ];
    const buf = encodeTextFrame({ nextCursor: 'w.txt', total: 9, done: 4 }, files);
    expect(isTextFrame(buf)).toBe(true);
    const back = decodeTextFrame<{ nextCursor: string; total: number; done: number }>(buf.slice().buffer as ArrayBuffer);
    expect(back.nextCursor).toBe('w.txt');
    expect(back.total).toBe(9);
    expect(back.files).toEqual(files);
  });

  it('uses provided UTF-8 bytes verbatim (no re-encoding)', () => {
    const utf8 = new TextEncoder().encode('forwarded bytes');
    const buf = encodeTextFrame({}, [{ path: 'x.md', content: 'forwarded bytes', mtime: 1, eol: 'lf', utf8 }]);
    expect(decodeTextFrame(buf).files[0].content).toBe('forwarded bytes');
  });

  it('the indexer forwards disk bytes only for plain UTF-8 (not BOM / CRLF / legacy encodings)', async () => {
    await fsp.mkdir(TMP, { recursive: true });
    const dir = await fsp.mkdtemp(path.join(TMP, 'ws-'));
    fs.writeFileSync(path.join(dir, 'plain.md'), 'plain ü text\n');
    fs.writeFileSync(path.join(dir, 'crlf.md'), 'a\r\nb\r\n');
    fs.writeFileSync(path.join(dir, 'bom.md'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('bom')]));
    fs.writeFileSync(path.join(dir, 'ansi.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9])); // "café" in windows-1252
    const ix = new Indexer({ root: dir, cacheFile: null, readThreads: 0, index: DEFAULT_INDEX, foldCase: false });
    ix.setPaths({ version: '1', files: ['plain.md', 'crlf.md', 'bom.md', 'ansi.txt'], ignoreDirs: [], repoDirs: [] });
    const page = await ix.page(null, 1 << 20);
    const by = Object.fromEntries(page.files.map((f) => [f.path, f as FrameFile]));
    expect(by['plain.md'].utf8).toBeDefined();
    for (const p of ['crlf.md', 'bom.md', 'ansi.txt']) expect(by[p].utf8, p).toBeUndefined();
    const back = decodeTextFrame(encodeTextFrame({}, page.files));
    expect(back.files.map((f) => [f.path, f.content])).toEqual([
      ['ansi.txt', 'café'],
      ['bom.md', 'bom'],
      ['crlf.md', 'a\nb\n'],
      ['plain.md', 'plain ü text\n'],
    ]);
    ix.dispose();
    await fsp.rm(dir, { recursive: true, force: true });
  });
});
