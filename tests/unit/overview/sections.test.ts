// @vitest-environment happy-dom
// The overview's open / closed rule: a default until the user decides, then the user's choice.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { collapsedSections, isSectionOpen, sectionOpen, setSectionCollapsed } from '../../../src/renderer/overview/sections';

const KEY = 'sec-edit-overview-sections';

beforeEach(() => {
  localStorage.clear();
  collapsedSections.value = {};
});

describe('section open state', () => {
  it('never touched: follows the default, both ways', () => {
    expect(sectionOpen({}, 'tasks', true)).toBe(true);
    expect(sectionOpen({}, 'tasks', false)).toBe(false);
    // Unrelated choices don't leak; prototype names are not choices.
    expect(sectionOpen({ code: true }, 'tasks', true)).toBe(true);
    expect(sectionOpen({}, 'constructor', false)).toBe(false);
  });

  it('an explicit choice wins over the default, both ways', () => {
    expect(sectionOpen({ tasks: true }, 'tasks', true)).toBe(false);
    expect(sectionOpen({ tasks: false }, 'tasks', false)).toBe(true);
  });

  it('a toggle is stored as a choice (open too) and survives a reload of the module', async () => {
    setSectionCollapsed('connections', false);
    setSectionCollapsed('code', true);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ connections: false, code: true });
    expect(isSectionOpen('connections', false)).toBe(true);
    expect(isSectionOpen('code', true)).toBe(false);
    vi.resetModules();
    const fresh = await import('../../../src/renderer/overview/sections');
    expect(fresh.collapsedSections.value).toEqual({ connections: false, code: true });
  });

  it('reads what older builds stored (only `true` = collapsed) and drops junk', async () => {
    localStorage.setItem(KEY, JSON.stringify({ code: true, 'cn-in': true, bad: 'x', n: 1 }));
    vi.resetModules();
    const fresh = await import('../../../src/renderer/overview/sections');
    expect(fresh.collapsedSections.value).toEqual({ code: true, 'cn-in': true });
    expect(fresh.isSectionOpen('code', true)).toBe(false);
    expect(fresh.isSectionOpen('outline', true)).toBe(true); // untouched before: now follows the default
    localStorage.setItem(KEY, '{not json');
    vi.resetModules();
    expect((await import('../../../src/renderer/overview/sections')).collapsedSections.value).toEqual({});
  });
});
