// Sidebar menu customisation: the merge rule the bar is drawn with (ui.menuPanels: stored order + hidden set over
// the registered panels, new panels at their default place, at least one entry) and what gets stored (toPref).
import { describe, it, expect } from 'vitest';
import { menuPanels } from '../../../src/renderer/app/ui';
import { readPref, toPref } from '../../../src/renderer/app/panel-menu';

const DEFAULT = ['files', 'search', 'git', 'bookmarks', 'outline', 'backlinks', 'tags'];
const reg = (ids = DEFAULT) => ids.map((id) => ({ id }));
const ids = (l: Array<{ id: string }>) => l.map((p) => p.id);
const bar = (pref: unknown, open?: string, panels = reg()) => ids(menuPanels(panels, pref, open));

describe('menuPanels (the first frame draws this)', () => {
  it('no setting: the registered (default) order', () => {
    expect(bar(null)).toEqual(DEFAULT);
    expect(bar(undefined)).toEqual(DEFAULT);
    expect(bar({})).toEqual(DEFAULT);
  });

  it('a stored order and hidden set', () => {
    expect(bar({ order: ['tags', 'files', 'search', 'git', 'bookmarks', 'outline', 'backlinks'], hidden: ['git', 'outline'] })).toEqual(['tags', 'files', 'search', 'bookmarks', 'backlinks']);
  });

  it('a panel added in a later version goes in after its default predecessor, shown', () => {
    // Stored before "bookmarks" existed (and with git hidden): it lands right after git, visible.
    expect(bar({ order: ['tags', 'files', 'search', 'git', 'outline', 'backlinks'], hidden: ['git'] })).toEqual(['tags', 'files', 'search', 'bookmarks', 'outline', 'backlinks']);
    expect(bar({ order: ['git', 'files', 'search', 'outline', 'backlinks', 'tags'] }, undefined)).toEqual(['git', 'bookmarks', 'files', 'search', 'outline', 'backlinks', 'tags']);
    // Several new ones keep their default order; a new first panel goes first.
    expect(bar({ order: ['tags', 'outline'] })).toEqual(['files', 'search', 'git', 'bookmarks', 'tags', 'outline', 'backlinks']);
    expect(bar({ order: ['search', 'files'] }, undefined, reg(['new', 'files', 'search']))).toEqual(['new', 'search', 'files']);
  });

  it('stored ids nobody registers are skipped (they keep their place in the setting)', () => {
    expect(bar({ order: ['calendar', 'search', 'files', 'git', 'bookmarks', 'outline', 'backlinks', 'tags'], hidden: ['calendar'] })).toEqual(['search', 'files', 'git', 'bookmarks', 'outline', 'backlinks', 'tags']);
  });

  it('a hidden panel shows while it is open', () => {
    expect(bar({ hidden: ['bookmarks'] })).toEqual(['files', 'search', 'git', 'outline', 'backlinks', 'tags']);
    expect(bar({ hidden: ['bookmarks'] }, 'bookmarks')).toEqual(DEFAULT);
  });

  it('at least one entry stays', () => {
    expect(bar({ hidden: DEFAULT })).toEqual(['files']);
    expect(bar({ order: ['tags', 'files'], hidden: DEFAULT })).toEqual(['tags']); // the first in the user's order
    expect(bar({ order: [...DEFAULT].reverse(), hidden: DEFAULT })).toEqual(['tags']);
    expect(bar({ hidden: DEFAULT }, 'git')).toEqual(['git']);
  });

  it('a hand-edited value never throws', () => {
    for (const v of ['files', 5, true, [], { order: 'files', hidden: 7 }, { order: [null, 3, {}], hidden: [null] }, { order: { 0: 'tags' } }]) expect(bar(v), JSON.stringify(v)).toHaveLength(DEFAULT.length);
  });
});

describe('toPref (what the setting stores)', () => {
  const none = readPref(null);
  it('the default arrangement stores null, so later panels follow the defaults exactly', () => {
    expect(toPref(DEFAULT, [], none, DEFAULT)).toBeNull();
    expect(toPref(DEFAULT, new Set(), readPref({ order: DEFAULT, hidden: ['git'] }), DEFAULT)).toBeNull();
  });
  it('stores the whole order and the hidden ids', () => {
    const order = ['search', 'files', 'git', 'bookmarks', 'outline', 'backlinks', 'tags'];
    expect(toPref(order, ['tags'], none, DEFAULT)).toEqual({ order, hidden: ['tags'] });
    expect(toPref(DEFAULT, new Set(['git', 'git', 'nope']), none, DEFAULT)).toEqual({ order: DEFAULT, hidden: ['git'] });
  });
  it("another build's panels keep their place and hidden flag", () => {
    const prev = readPref({ order: ['files', 'calendar', 'search', 'git', 'bookmarks', 'outline', 'backlinks', 'tags', 'far'], hidden: ['calendar', 'git'] });
    const order = ['search', 'files', 'git', 'bookmarks', 'outline', 'backlinks', 'tags'];
    expect(toPref(order, [], prev, DEFAULT)).toEqual({ order: ['search', 'files', 'calendar', 'git', 'bookmarks', 'outline', 'backlinks', 'tags', 'far'], hidden: ['calendar'] });
  });
  it('readPref drops what is not a list of strings', () => {
    expect(readPref({ order: ['a', 1, null, 'b'], hidden: 'x' })).toEqual({ order: ['a', 'b'], hidden: [] });
    expect(readPref('junk')).toEqual({ order: [], hidden: [] });
  });
});
