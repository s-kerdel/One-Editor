// @vitest-environment happy-dom
// "AI changes" panel: turns as foldable groups (newest open), rows that open their file, the right-click menus,
// the keys, "reviewed", and one list per agent terminal.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { app } from '../../../src/renderer/app/app';
import * as ui from '../../../src/renderer/app/ui';

let m: typeof import('../../../src/renderer/terminal/changes/Panel');
const opened: string[] = [];
const copied: string[] = [];
const row = (path: string, turn: number, o: object = {}) => ({ path, status: 'modified', additions: 2, deletions: 1, turn, exact: true, ...o });
const ev = (o: object = {}) => ({ id: 1, agent: 'claude', busy: false, turns: 2, files: [row('src/a.ts', 1), row('src/b.ts', 2), row('docs/gone.md', 2, { status: 'deleted', additions: 0, deletions: 4 }), row('new.ts', 2, { status: 'added', exact: false })], ...o });

let host: HTMLElement;
const draw = () => act(() => render(<m.AiChanges />, host));
const send = (e: object) => act(() => m.applyChanges(e));
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => [...host.querySelectorAll<T>(sel)];
const heads = () => $('.se-ai-turn');
const paths = () => $('.se-ai-row').map((r) => r.dataset.path);
const text = (el: Element) => el.textContent!.replace(/\s+/g, ' ').trim();
const menu = async (el: Element) => {
  ui.contextMenu.value = null;
  await act(() => void el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 6 })));
  return ui.contextMenu.value!.items;
};
const pick = (items: ui.MenuItem[], label: string) => act(async () => void (await items.find((i) => i.label === label)!.run!()));
const key = (el: Element, k: string) => act(() => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })));

beforeAll(async () => {
  (app as any).backend = { kind: 'electron', os: 'linux' };
  app.workspace.value = { root: '/w', name: 'w', caseSensitive: true } as never;
  (app as any).openFile = async (p: string) => void opened.push(p);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void copied.push(t) } });
  m = await import('../../../src/renderer/terminal/changes/Panel');
});

beforeEach(async () => {
  opened.length = 0;
  copied.length = 0;
  m.clearChanges('all');
  m.pickList(null);
  host = document.createElement('div');
  document.body.replaceChildren(host);
  await draw();
});

describe('AI changes panel', () => {
  it('names both agents and their settings while there is nothing to show', () => {
    const empty = text($('.se-ai-empty')[0]);
    expect(empty).toContain('Claude Code or Opencode');
    expect(empty).toContain('Follow Opencode’s edits');
    expect(host.querySelector('.se-ai-clear')).toBeNull();
  });

  it('one group per turn, newest first and open; a header folds its turn; a row opens its file', async () => {
    await send(ev());
    expect(heads().map(text)).toEqual(['Turn 2 · 3 files+4 −6', 'Turn 1 · 1 file+2 −1']);
    expect(heads().map((h) => h.getAttribute('aria-expanded'))).toEqual(['true', 'false']);
    expect(paths()).toEqual(['src/b.ts', 'docs/gone.md', 'new.ts']); // the list's own order inside a turn
    expect(text($('.se-ai-sum')[0])).toBe('Claude Code · 4 files · 2 turns +6 −7');
    expect($('.se-ai-row.est').map((r) => r.dataset.path)).toEqual(['new.ts']); // still an estimate: drawn dimmer
    expect($('.se-ai-row').every((r) => r.tagName === 'BUTTON')).toBe(true); // Enter / Space open it: the button's own

    await act(() => heads()[1].click());
    expect(heads().map((h) => h.getAttribute('aria-expanded'))).toEqual(['true', 'true']);
    expect(paths()).toEqual(['src/b.ts', 'docs/gone.md', 'new.ts', 'src/a.ts']);
    await act(() => heads()[0].click());
    expect(paths()).toEqual(['src/a.ts']);

    await act(() => $('.se-ai-row')[0].click());
    expect(opened).toEqual(['src/a.ts']);
    await act(() => heads()[0].click());
    await act(() => $('.se-ai-row.deleted')[0].click()); // nothing to open
    expect(opened).toEqual(['src/a.ts']);
    expect($('.se-ai-row.deleted')[0].getAttribute('aria-disabled')).toBe('true');
  });

  it('a new turn folds the older ones; what the user folded by hand holds until then', async () => {
    await send(ev());
    await act(() => heads()[1].click()); // turn 1 opened by hand
    await send(ev({ files: [row('src/a.ts', 1), row('src/b.ts', 2), row('src/c.ts', 2)] })); // the same turn goes on
    expect(heads().map((h) => h.getAttribute('aria-expanded'))).toEqual(['true', 'true']);
    await send(ev({ busy: true, turns: 3, files: [row('src/a.ts', 1), row('src/b.ts', 2)] }));
    expect(heads().map(text)).toEqual(['Turn 3 · working…+0 −0', 'Turn 2 · 1 file+2 −1', 'Turn 1 · 1 file+2 −1']);
    expect(heads().map((h) => h.getAttribute('aria-expanded'))).toEqual(['true', 'false', 'false']);
    expect(text($('.se-ai-wait')[0])).toBe('Waiting for the first change…');
    expect(text($('.se-ai-live')[0])).toBe('working');
    await send(ev({ busy: true, turns: 3, files: [row('src/a.ts', 3, { additions: 9 }), row('src/b.ts', 2)] })); // a.ts changed again: it moves to turn 3
    expect(heads().map(text)).toEqual(['Turn 3 · 1 file+9 −1', 'Turn 2 · 1 file+2 −1']);
    expect(paths()).toEqual(['src/a.ts']);
  });

  it('right-click on a row: open, diff, reveal, copy, reviewed', async () => {
    await send(ev());
    const items = await menu($('.se-ai-row')[0]);
    expect(items.filter((i) => !i.separator).map((i) => i.label)).toEqual(['Open', 'Show diff vs last commit', 'Reveal in Files', 'Copy path', 'Copy relative path', 'Mark as reviewed']);
    expect(ui.contextMenu.value).toMatchObject({ x: 5, y: 6 });
    await pick(items, 'Open');
    expect(opened).toEqual(['src/b.ts']);
    await pick(items, 'Copy path');
    await pick(items, 'Copy relative path');
    expect(copied).toEqual(['/w/src/b.ts', 'src/b.ts']);
    await pick(items, 'Reveal in Files');
    expect(app.sidebarPanel.value).toBe('files');
    expect(ui.treeSelection.value).toBe('src/b.ts');

    await pick(items, 'Mark as reviewed');
    expect($('.se-ai-row.reviewed').map((r) => r.dataset.path)).toEqual(['src/b.ts']);
    expect((await menu($('.se-ai-row')[0])).at(-1)!.label).toBe('Mark as not reviewed');
    await send(ev({ files: [row('src/a.ts', 1), row('src/b.ts', 2, { additions: 7 })] })); // the agent changed it again
    expect($('.se-ai-row.reviewed')).toEqual([]);

    // A deleted file: nothing to open or reveal, the rest still works.
    await send(ev());
    const gone = await menu($('.se-ai-row.deleted')[0]);
    expect(gone.filter((i) => i.disabled).map((i) => i.label)).toEqual(['Open', 'Reveal in Files']);
  });

  it('right-click on a turn: collapse others, expand all, reviewed, copy the file list', async () => {
    await send(ev({ turns: 3, files: [row('a.ts', 1), row('b.ts', 2), row('c.ts', 3), row('d.ts', 3)] }));
    const items = await menu(heads()[1]); // turn 2 (folded)
    expect(items.filter((i) => !i.separator).map((i) => i.label)).toEqual(['Expand', 'Collapse others', 'Expand all', 'Mark all as reviewed', 'Copy file list']);
    await pick(items, 'Expand all');
    expect(heads().map((h) => h.getAttribute('aria-expanded'))).toEqual(['true', 'true', 'true']);
    await pick(items, 'Collapse others');
    expect(heads().map((h) => h.getAttribute('aria-expanded'))).toEqual(['false', 'true', 'false']);
    expect(paths()).toEqual(['b.ts']);
    await pick(await menu(heads()[0]), 'Copy file list');
    expect(copied).toEqual(['c.ts\nd.ts']);
    await pick(await menu(heads()[1]), 'Mark all as reviewed');
    expect($('.se-ai-row.reviewed').map((r) => r.dataset.path)).toEqual(['b.ts']);
    expect((await menu(heads()[1])).find((i) => i.icon === 'check')!.label).toBe('Mark all as not reviewed');
  });

  it('keys: ↑ ↓ walk headers and rows, ← folds (from a row: to its header first), → unfolds', async () => {
    await send(ev());
    const focused = () => (document.activeElement as HTMLElement).dataset.path ?? `turn ${(document.activeElement as HTMLElement).dataset.turn}`;
    heads()[0].focus();
    await key(document.activeElement!, 'ArrowDown');
    expect(focused()).toBe('src/b.ts');
    await key(document.activeElement!, 'ArrowDown');
    await key(document.activeElement!, 'ArrowUp');
    expect(focused()).toBe('src/b.ts');
    await key(document.activeElement!, 'ArrowLeft'); // a row: back to its turn
    expect(focused()).toBe('turn 2');
    await key(document.activeElement!, 'ArrowLeft'); // the header: fold
    expect(heads()[0].getAttribute('aria-expanded')).toBe('false');
    expect(paths()).toEqual([]);
    await key(heads()[0], 'ArrowRight');
    expect(heads()[0].getAttribute('aria-expanded')).toBe('true');
    await key(heads()[0], 'ArrowRight'); // open already: into its rows
    expect(focused()).toBe('src/b.ts');
    heads()[1].focus();
    await key(heads()[1], 'ArrowRight');
    expect(paths()).toContain('src/a.ts');
  });

  it('two agent terminals: a switcher, each with its own list and name; Clear takes the shown one', async () => {
    await send(ev({ id: 1, agent: 'claude', turns: 1, files: [row('c.ts', 1)] }));
    expect($('.se-ai-tab')).toEqual([]); // one terminal: no switcher
    await send(ev({ id: 2, agent: 'opencode', busy: true, turns: 1, files: [row('o.ts', 1)] }));
    expect($('.se-ai-tab').map(text)).toEqual(['Claude Code', 'Opencode']);
    expect($('.se-ai-tab').map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true']); // the one prompted last
    expect(paths()).toEqual(['o.ts']);
    expect($('.se-ai-live')[0].getAttribute('title')).toBe('Opencode is working');
    await act(() => $('.se-ai-tab')[0].click());
    expect(paths()).toEqual(['c.ts']);
    expect(text($('.se-ai-sum')[0])).toContain('Claude Code · 1 file · 1 turn');
    await send(ev({ id: 3, agent: 'opencode', turns: 1, files: [] }));
    expect($('.se-ai-tab').map(text)).toEqual(['Claude Code', 'Opencode 1', 'Opencode 2']);
    await act(() => m.markEnded(1));
    expect(text($('.se-ai-ended')[0])).toBe('· session ended');
    await act(() => $<HTMLButtonElement>('.se-ai-clear')[0].click());
    expect($('.se-ai-tab').map(text)).toEqual(['Opencode 1', 'Opencode 2']);
  });
});
