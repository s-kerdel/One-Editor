import { describe, it, expect } from 'vitest';
import { toggleBold, toggleItalic, toggleStrike, toggleHighlight, toggleInlineCode, insertLink, setHeading, insertCodeBlock, insertCallout, isUrl } from '../../../src/renderer/editor/format';
import { apply } from './helpers';

describe('toggle bold', () => {
  it('wraps a selection', () => {
    expect(apply('a «word» b', toggleBold)).toBe('a **«word»** b');
  });
  it('keeps surrounding whitespace outside the markers', () => {
    expect(apply('a« word »b', toggleBold)).toBe('a **«word»** b');
  });
  it('unwraps when the selection is inside bold', () => {
    expect(apply('a **«word»** b', toggleBold)).toBe('a «word» b');
    expect(apply('a **wo«r»d** b', toggleBold)).toBe('a wo«r»d b');
  });
  it('unwraps when the selection includes the markers', () => {
    expect(apply('a «**word**» b', toggleBold)).toBe('a «word» b');
  });
  it('bolds the word under the cursor, or inserts a pair', () => {
    expect(apply('a wo‸rd b', toggleBold)).toBe('a **wo‸rd** b');
    expect(apply('a word‸', toggleBold)).toBe('a **word‸**');
    expect(apply('a ‸', toggleBold)).toBe('a **‸**');
  });
  it('removes an empty pair and unwraps around the cursor', () => {
    expect(apply('a **‸** b', toggleBold)).toBe('a ‸ b');
    expect(apply('x **bo‸ld** y', toggleBold)).toBe('x bo‸ld y');
  });
  it('applies to every cursor', () => {
    expect(apply('«a» «b»', toggleBold)).toBe('**«a»** **«b»**');
  });
});

describe('toggle italic vs bold', () => {
  it('italic inside bold adds a star layer instead of unwrapping', () => {
    expect(apply('**«x»**', toggleItalic)).toBe('***«x»***');
  });
  it('bold inside italic adds two stars', () => {
    expect(apply('*«x»*', toggleBold)).toBe('***«x»***');
  });
  it('removes the right layer from ***x***', () => {
    expect(apply('***«x»***', toggleItalic)).toBe('**«x»**');
    expect(apply('***«x»***', toggleBold)).toBe('*«x»*');
  });
  it('unwraps _underscore_ emphasis', () => {
    expect(apply('a _wo‸rd_ b', toggleItalic)).toBe('a wo‸rd b');
  });
});

describe('other markers', () => {
  it('strikethrough, highlight and code toggle', () => {
    expect(apply('«x»', toggleStrike)).toBe('~~«x»~~');
    expect(apply('~~«x»~~', toggleStrike)).toBe('«x»');
    expect(apply('«x»', toggleHighlight)).toBe('==«x»==');
    expect(apply('==«x»==', toggleHighlight)).toBe('«x»');
    expect(apply('«x»', toggleInlineCode)).toBe('`«x»`');
    expect(apply('`co‸de`', toggleInlineCode)).toBe('co‸de');
  });
});

describe('insertLink (Mod-k)', () => {
  it('wraps text and puts the cursor in the url', () => {
    expect(apply('«text»', insertLink(null))).toBe('[text](‸)');
  });
  it('uses a URL from the clipboard', () => {
    expect(apply('«text»', insertLink('https://x.dev'))).toBe('[text](https://x.dev)‸');
    expect(apply('a ‸', insertLink('https://x.dev'))).toBe('a [‸](https://x.dev)');
  });
  it('ignores non-URL clipboard text', () => {
    expect(apply('«text»', insertLink('hello world'))).toBe('[text](‸)');
  });
  it('turns a selected URL into the target', () => {
    expect(apply('«https://x.dev»', insertLink(null))).toBe('[‸](https://x.dev)');
  });
  it('inserts an empty link', () => {
    expect(apply('a ‸', insertLink(null))).toBe('a [‸]()');
  });
  it('selects the text of the link the cursor is in', () => {
    expect(apply('[te‸xt](u)', insertLink(null))).toBe('[«text»](u)');
  });
  it('detects URLs', () => {
    expect(isUrl('https://a.b/c?d=e')).toBe(true);
    expect(isUrl('www.example.com')).toBe(true);
    expect(isUrl('not a url')).toBe(false);
  });
});

describe('headings and blocks', () => {
  it('sets, changes and removes heading levels', () => {
    expect(apply('Title‸', setHeading(2))).toBe('## Title‸');
    expect(apply('## Title‸', setHeading(3))).toBe('### Title‸');
    expect(apply('### Title‸', setHeading(3))).toBe('Title‸');
  });
  it('inserts or wraps code blocks', () => {
    expect(apply('‸', insertCodeBlock())).toBe('```‸\n\n```');
    expect(apply('«a\nb»', insertCodeBlock())).toBe('```‸\na\nb\n```');
  });
  it('inserts a callout, quoting a selection', () => {
    expect(apply('‸', insertCallout('note'))).toBe('> [!note] «Title»\n> ');
    expect(apply('«a\nb»', insertCallout('tip'))).toBe('> [!tip] ‸\n> a\n> b');
  });
});
