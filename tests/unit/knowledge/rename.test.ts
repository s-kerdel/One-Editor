import { describe, expect, it } from 'vitest';
import { applyEdits, computeRenameEdits, relativePath, rewriteLinksForRename, rewriteLinksForRenames, wikiLinkTextFor } from '../../../src/knowledge/rename';
import { createLinkResolver } from '@shared/wikilinks';

const files = ['README.md', 'notes/Old.md', 'notes/Other.md', 'notes/sub/Deep.md', 'projects/Plan.md', 'projects/x/Plan.md', 'img/pic one.png', 'docs/guide.md'];
const rw = (text: string, from: string, to: string, file = 'README.md', all = files) => rewriteLinksForRename(text, from, to, file, all);

describe('wikilinks', () => {
  it('rewrites plain, aliased, heading, block and embed links', () => {
    const text = '[[Old]] [[Old|shown]] [[Old#Head]] [[Old#^blk|x]] ![[Old]] ![[Old#Head]]';
    expect(rw(text, 'notes/Old.md', 'notes/New name.md')).toBe('[[New name]] [[New name|shown]] [[New name#Head]] [[New name#^blk|x]] ![[New name]] ![[New name#Head]]');
  });
  it('is case-insensitive and preserves inner whitespace and \\| escapes', () => {
    expect(rw('[[old]] [[ OLD | a ]] | [[Old\\|a]] |', 'notes/Old.md', 'notes/New.md')).toBe('[[New]] [[ New | a ]] | [[New\\|a]] |');
  });
  it('preserves path style and explicit extensions', () => {
    expect(rw('[[notes/Old]] [[notes/Old.md]] [[Old.md|a]] [[notes/Old#H]]', 'notes/Old.md', 'notes/New.md')).toBe('[[notes/New]] [[notes/New.md]] [[New.md|a]] [[notes/New#H]]');
  });
  it('leaves bare links alone when only the folder changes', () => {
    const text = '[[Old]] and [[Old#H|a]]';
    expect(rw(text, 'notes/Old.md', 'archive/Old.md')).toBe(text);
    expect(rw('[[notes/Old]]', 'notes/Old.md', 'archive/2024/Old.md')).toBe('[[archive/2024/Old]]');
  });
  it('uses the full path when the new name is ambiguous', () => {
    // Renaming notes/Old.md → notes/sub/Plan.md: "Plan" from README would hit projects/Plan.md.
    expect(rw('[[Old]]', 'notes/Old.md', 'notes/sub/Plan.md')).toBe('[[notes/sub/Plan]]');
    // ...but from the same folder the bare name wins.
    expect(rw('[[Old]]', 'notes/Old.md', 'notes/sub/Plan.md', 'notes/sub/Deep.md')).toBe('[[Plan]]');
  });
  it('keeps links pointing at the right file when a rename would shadow them', () => {
    // README's [[Plan]] means projects/Plan.md; a new root-level Plan.md would hijack it.
    expect(rw('[[Plan]]', 'notes/Old.md', 'Plan.md')).toBe('[[projects/Plan]]');
  });
  it('rewrites attachments', () => {
    expect(rw('![[pic one.png]] ![[img/pic one.png|200]]', 'img/pic one.png', 'img/photo.png')).toBe('![[photo.png]] ![[img/photo.png|200]]');
  });
  it('has no false positives', () => {
    const text = ['[[Older]] [[Old notes]] [[Other]] [[Unknown]] [[#Old]] [[Other#Old]] [[Other|Old]]', '`[[Old]]` and', '```', '[[Old]]', '```', 'plain Old text, Old.md, notes/Old.md', '[Old](https://example.com/notes/Old.md)'].join('\n');
    expect(rw(text, 'notes/Old.md', 'notes/New.md')).toBe(text);
  });
  it('does not touch a different note with the same name elsewhere', () => {
    // From projects/x/a.md, [[Plan]] is projects/x/Plan.md (same folder) — not the renamed one.
    const text = '[[Plan]] [[projects/Plan]]';
    expect(rw(text, 'projects/Plan.md', 'projects/Roadmap.md', 'projects/x/a.md')).toBe('[[Plan]] [[projects/Roadmap]]');
    expect(rw('[[Plan]]', 'projects/Plan.md', 'projects/Roadmap.md', 'README.md')).toBe('[[Roadmap]]');
  });
  it('accepts the file list from before or after the rename', () => {
    const after = files.filter((f) => f !== 'notes/Old.md').concat('notes/New.md');
    expect(rw('[[Old]]', 'notes/Old.md', 'notes/New.md', 'README.md', after)).toBe('[[New]]');
    expect(rw('[[Old]]', 'notes/Old.md', 'notes/New.md', 'README.md', files)).toBe('[[New]]');
  });
});

describe('markdown links', () => {
  it('rewrites relative links across folders, keeping fragment and title', () => {
    expect(rw('[a](notes/Old.md) [b](notes/Old.md#Some%20head) [c](./notes/Old.md "T") ![d](notes/Old.md)', 'notes/Old.md', 'archive/New.md')).toBe('[a](archive/New.md) [b](archive/New.md#Some%20head) [c](./archive/New.md "T") ![d](archive/New.md)');
    expect(rw('[a](../Old.md) [b](../../README.md)', 'notes/Old.md', 'New.md', 'notes/sub/Deep.md')).toBe('[a](../../New.md) [b](../../README.md)');
    expect(rw('[a](Old.md)', 'notes/Old.md', 'notes/sub/New.md', 'notes/Other.md')).toBe('[a](sub/New.md)');
  });
  it('encodes spaces, and keeps <angle> destinations raw', () => {
    expect(rw('[a](notes/Old.md)', 'notes/Old.md', 'notes/New name (v2).md')).toBe('[a](notes/New%20name%20%28v2%29.md)');
    expect(rw('[a](<img/pic one.png>) ![b](img/pic%20one.png)', 'img/pic one.png', 'img/new pic.png')).toBe('[a](<img/new pic.png>) ![b](img/new%20pic.png)');
  });
  it('updates link text only when it is the file name', () => {
    expect(rw('[Old](notes/Old.md) [Old.md](notes/Old.md) [the old one](notes/Old.md)', 'notes/Old.md', 'notes/New.md')).toBe('[New](notes/New.md) [New.md](notes/New.md) [the old one](notes/New.md)');
  });
  it('handles root-absolute, extension-less and reference-style links', () => {
    expect(rw('[a](/notes/Old.md) [b](notes/Old)\n[ref]: notes/Old.md#h', 'notes/Old.md', 'notes/New.md')).toBe('[a](/notes/New.md) [b](notes/New)\n[ref]: notes/New.md#h');
  });
  it('has no false positives', () => {
    const text = '[a](Old.md) [b](notes/Older.md) [c](notes/Old.md.bak) [d](https://x/notes/Old.md) [e](#Old) `[f](notes/Old.md)`';
    // (Old.md relative to the root README is a different, non-existent file)
    expect(rw(text, 'notes/Old.md', 'notes/New.md')).toBe(text);
  });
  it('fixes relative links inside the moved note itself', () => {
    const text = '[up](../README.md) [sib](Other.md) [[Other]] [ext](https://e.x)';
    expect(rw(text, 'notes/Old.md', 'archive/2024/Old.md', 'archive/2024/Old.md')).toBe('[up](../../README.md) [sib](../../notes/Other.md) [[Other]] [ext](https://e.x)');
    // Renamed in place: nothing to do.
    expect(rw(text, 'notes/Old.md', 'notes/New.md', 'notes/New.md')).toBe(text);
  });
});

describe('edits + multi-rename', () => {
  it('produces minimal edits that only cover the target text', () => {
    const text = 'x [[Old#H|alias]] y [t](notes/Old.md#frag)';
    const edits = computeRenameEdits(text, new Map([['notes/Old.md', 'notes/New.md']]), 'README.md', files);
    expect(edits.map((e) => [text.slice(e.from, e.to), e.insert])).toEqual([['Old', 'New'], ['notes/Old.md#frag', 'notes/New.md#frag']]);
    expect(applyEdits(text, edits)).toBe('x [[New#H|alias]] y [t](notes/New.md#frag)');
  });
  it('handles a folder rename (many files at once)', () => {
    const renames = new Map([['notes/Old.md', 'journal/Old.md'], ['notes/Other.md', 'journal/Other.md'], ['notes/sub/Deep.md', 'journal/sub/Deep.md']]);
    expect(rewriteLinksForRenames('[[Old]] [[notes/Other]] [d](notes/sub/Deep.md) [[notes/sub/Deep|x]]', renames, 'README.md', files)).toBe('[[Old]] [[journal/Other]] [d](journal/sub/Deep.md) [[journal/sub/Deep|x]]');
    // Inside the moved folder, sibling-relative links stay valid; links leaving it are fixed.
    const inner = '[sib](Other.md) [deep](sub/Deep.md) [out](../README.md) [[Old]]';
    expect(rewriteLinksForRenames(inner, renames, 'journal/Old.md', files)).toBe(inner);
    expect(rewriteLinksForRenames('[out](../../docs/guide.md) [up](../Old.md)', new Map([...renames, ['notes/sub/Deep.md', 'journal/deeper/sub/Deep.md']]), 'journal/deeper/sub/Deep.md', files)).toBe('[out](../../../docs/guide.md) [up](../../Old.md)');
  });
  it('works on CRLF-free multi-line documents with correct offsets', () => {
    const text = '# T\n\nfirst [[Old]]\n\n> quote [[Old|a]]\n\n- [x] [[Old#h]]\n';
    expect(rw(text, 'notes/Old.md', 'notes/Renamed.md')).toBe('# T\n\nfirst [[Renamed]]\n\n> quote [[Renamed|a]]\n\n- [x] [[Renamed#h]]\n');
  });
});

describe('helpers', () => {
  it('relativePath', () => {
    expect(relativePath('', 'a/b.md')).toBe('a/b.md');
    expect(relativePath('a', 'a/b.md')).toBe('b.md');
    expect(relativePath('a/c', 'a/b.md')).toBe('../b.md');
    expect(relativePath('x/y', 'b.md')).toBe('../../b.md');
    expect(relativePath('a', 'a/a/b.md')).toBe('a/b.md');
  });
  it('wikiLinkTextFor picks the shortest unambiguous form', () => {
    const r = createLinkResolver(files);
    expect(wikiLinkTextFor('notes/Old.md', 'README.md', r)).toBe('Old');
    expect(wikiLinkTextFor('projects/x/Plan.md', 'README.md', r)).toBe('projects/x/Plan');
    expect(wikiLinkTextFor('projects/x/Plan.md', 'projects/x/a.md', r)).toBe('Plan');
    expect(wikiLinkTextFor('img/pic one.png', 'README.md', r)).toBe('pic one.png');
    expect(wikiLinkTextFor('notes/Old.md', 'README.md', r, { keepExt: true, preferPath: true })).toBe('notes/Old.md');
  });
});
