import { describe, expect, it } from 'vitest';
import { attachmentDir, bytesToBase64, bytesToLatin1, extForMime, linkMarkdown, pastedImageName, sanitizeFileName, uniquePath } from '../../../src/renderer/editor/attachments';

describe('attachment naming', () => {
  it('Obsidian-style pasted image names (local time, zero padded)', () => {
    expect(pastedImageName(new Date(2026, 10, 18, 22, 15, 30))).toBe('Pasted image 20261118-221530.png');
    expect(pastedImageName(new Date(2026, 0, 2, 3, 4, 5), 'jpg')).toBe('Pasted image 20260102-030405.jpg');
  });
  it('mime → extension', () => {
    expect(extForMime('image/png')).toBe('png');
    expect(extForMime('IMAGE/JPEG')).toBe('jpg');
    expect(extForMime('image/svg+xml')).toBe('svg');
    expect(extForMime('application/x-unknown')).toBeNull();
  });
  it('file names safe for Windows and [[links]]', () => {
    expect(sanitizeFileName('report: v1?.pdf')).toBe('report v1 .pdf');
    expect(sanitizeFileName('a#b^c[d]|e.png')).toBe('a b c d e.png');
    expect(sanitizeFileName('  trailing dots... ')).toBe('trailing dots');
    expect(sanitizeFileName('con.txt')).toBe('_con.txt');
    expect(sanitizeFileName('')).toBe('attachment');
    expect(sanitizeFileName('日本 画像.png')).toBe('日本 画像.png');
  });
  it('unique paths: " 1", " 2" before the extension', () => {
    const taken = new Set(['attachments/a.png', 'attachments/a 1.png']);
    expect(uniquePath('attachments', 'a.png', (p) => taken.has(p))).toBe('attachments/a 2.png');
    expect(uniquePath('', 'b.png', () => false)).toBe('b.png');
    expect(uniquePath('x', 'noext', (p) => p === 'x/noext')).toBe('x/noext 1');
  });
});

describe('attachment location', () => {
  it('root (default) / note / subfolder', () => {
    expect(attachmentDir('notes/a/b.md', undefined, undefined)).toBe('attachments');
    expect(attachmentDir('notes/a/b.md', 'root', 'media/img')).toBe('media/img');
    expect(attachmentDir('notes/a/b.md', 'root', '')).toBe('');
    expect(attachmentDir('notes/a/b.md', 'note', 'ignored')).toBe('notes/a');
    expect(attachmentDir('top.md', 'note', undefined)).toBe('');
    expect(attachmentDir('notes/a/b.md', 'subfolder', 'assets')).toBe('notes/a/assets');
    expect(attachmentDir('notes/b.md', 'subfolder', undefined)).toBe('notes/attachments');
    expect(attachmentDir('n.md', 'root', '../outside/./x')).toBe('outside/x');
  });
});

describe('links for dropped / pasted files', () => {
  const files = ['notes/Note.md', 'other/Note.md', 'img/logo.png', 'docs/spec.pdf', 'misc/data.csv', 'unique.md'];
  it('shortest resolvable target; images/pdf embedded, notes linked', () => {
    expect(linkMarkdown('unique.md', files, 'x.md')).toBe('[[unique]]');
    expect(linkMarkdown('img/logo.png', files, 'x.md')).toBe('![[logo.png]]');
    expect(linkMarkdown('docs/spec.pdf', files, 'x.md')).toBe('![[spec.pdf]]');
    expect(linkMarkdown('misc/data.csv', files, 'x.md')).toBe('[[data.csv]]');
    expect(linkMarkdown('unique.md', files, 'x.md', true)).toBe('![[unique]]');
  });
  it('ambiguous names fall back to the full path', () => {
    const l = linkMarkdown('other/Note.md', files, 'notes/x.md');
    expect(l).toBe('[[other/Note]]');
  });
});

describe('byte transport', () => {
  it('latin1 string is one char per byte for all 256 values; base64 matches', () => {
    const bytes = new Uint8Array(Array.from({ length: 70_000 }, (_, i) => (i * 31) & 255));
    const s = bytesToLatin1(bytes);
    expect(s.length).toBe(bytes.length);
    for (let i = 0; i < 300; i++) expect(s.charCodeAt(i)).toBe(bytes[i]);
    expect(Buffer.from(bytesToBase64(bytes), 'base64').equals(Buffer.from(bytes))).toBe(true);
  });
});
