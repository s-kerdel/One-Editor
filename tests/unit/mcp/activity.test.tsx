// @vitest-environment happy-dom
// Settings → MCP server → Recent activity: newest first, collapsed to the last few calls, a filter (tool, path,
// app, result code), "problems only", marks (✓ ! ↺), Revert only on writes with an undo copy, details on click,
// and everything from the audit log shown as text.
import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { ActivityList, FEW } from '../../../src/renderer/mcp/activity';
import type { McpActivity } from '../../../src/shared/mcp';

const NOW = Date.parse('2026-11-21T12:00:00Z');
const call = (o: Partial<McpActivity> & { t: number }): McpActivity => ({ client: 'LM Studio', transport: 'stdio', tool: 'read_file', folder: 'notes', path: 'a.md', ok: true, code: null, ms: 12, bytes: 2048, journal: null, token: null, ...o });

let el: HTMLElement;
const reverted: McpActivity[] = [];
function mount(rows: McpActivity[]) {
  el = document.createElement('div');
  document.body.append(el);
  reverted.length = 0;
  act(() => render(<ActivityList rows={rows} revert={(r) => reverted.push(r)} now={NOW} />, el));
}
const q = (id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const rows = () => [...el.querySelectorAll('[data-testid="mcp-call"]')] as HTMLElement[];
const tools = () => rows().map((r) => r.querySelector('.se-mcp-tool')!.textContent);
const type = (text: string) =>
  act(() => {
    const i = q('mcp-activity-filter') as HTMLInputElement;
    i.value = text;
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
const problemsOnly = (on: boolean) =>
  act(() => {
    const c = q('mcp-activity-problems') as HTMLInputElement;
    c.checked = on;
    c.dispatchEvent(new Event('change', { bubbles: true }));
  });

/** 12 calls, oldest first here (the list must still show newest first). */
const MANY: McpActivity[] = Array.from({ length: 12 }, (_, i) => call({ t: NOW - (12 - i) * 60_000, tool: `tool_${String(i).padStart(2, '0')}`, path: `n${i}.md` }));

afterEach(() => {
  act(() => render(null, el));
  el.remove();
});

describe('MCP Recent activity list', () => {
  it('no calls: the explanation, no list', () => {
    mount([]);
    expect(q('mcp-activity-empty')?.textContent).toContain('never the text or a search query');
    expect(q('mcp-activity')).toBeNull();
    expect(q('mcp-activity-filter')).toBeNull();
  });

  it('newest first, collapsed to the last few; "Show all N calls" shows every call', () => {
    mount(MANY);
    expect(tools()).toEqual(['tool_11', 'tool_10', 'tool_09', 'tool_08', 'tool_07']);
    expect(rows()).toHaveLength(FEW);
    const toggle = q('mcp-activity-toggle') as HTMLButtonElement;
    expect(toggle.textContent).toBe('Show all 12 calls');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    act(() => toggle.click());
    expect(rows()).toHaveLength(12);
    expect(tools()[0]).toBe('tool_11');
    expect(tools()[11]).toBe('tool_00');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toBe(`Show only the last ${FEW}`);
    act(() => toggle.click());
    expect(rows()).toHaveLength(FEW);
  });

  it('few calls: all shown, no toggle', () => {
    mount(MANY.slice(0, 3));
    expect(rows()).toHaveLength(3);
    expect(q('mcp-activity-toggle')).toBeNull();
  });

  it('a row: time · app · tool · path · duration, with a ✓ mark', () => {
    mount([call({ t: NOW - 5000, client: 'Codex CLI', tool: 'get_outline', path: 'notes/plan.md', ms: 1534 })]);
    const r = rows()[0];
    expect(r.dataset.mark).toBe('ok');
    const mark = r.querySelector('.se-mcp-mark')!;
    expect(mark.textContent).toBe('✓');
    expect(mark.getAttribute('aria-label')).toBe('OK');
    expect(r.querySelector('.se-mcp-time')!.textContent).toMatch(/\d/);
    expect(r.querySelector('.se-mcp-app')!.textContent).toBe('Codex CLI');
    expect(r.querySelector('.se-mcp-where')!.textContent).toBe('notes/plan.md');
    expect(r.querySelector('.se-mcp-ms')!.textContent).toBe('1.5 s');
    expect(q('mcp-call-error')).toBeNull();
  });

  it('no path: the folder stands in (search calls never log their query)', () => {
    mount([call({ t: NOW, tool: 'search', path: null, folder: 'work' })]);
    expect(rows()[0].querySelector('.se-mcp-where')!.textContent).toBe('work');
  });

  it('errors: ! mark, code and short line on the row', () => {
    mount([call({ t: NOW, ok: false, code: 'EACCES', path: '.env' }), call({ t: NOW - 1, ok: false, code: 'EWHATEVER' }), call({ t: NOW - 2, ok: false, code: null })]);
    const [a, b, c] = rows();
    expect(a.dataset.mark).toBe('problem');
    expect(a.querySelector('.se-mcp-mark')!.textContent).toBe('!');
    expect(a.querySelector('[data-testid="mcp-call-error"]')!.textContent).toBe('EACCES · not allowed');
    expect(b.querySelector('[data-testid="mcp-call-error"]')!.textContent).toBe('EWHATEVER');
    expect(c.querySelector('[data-testid="mcp-call-error"]')!.textContent).toBe('error');
  });

  it('Revert only on a write with an undo copy; reverted rows show ↺ and no button', () => {
    const write = call({ t: NOW, tool: 'append_file', journal: 'abc123-0123abcd' });
    mount([
      write,
      call({ t: NOW - 1, tool: 'edit_file', journal: 'abc123-0123abce', reverted: true }),
      call({ t: NOW - 2, tool: 'write_file', journal: null }), // undo copies were off
      call({ t: NOW - 3, tool: 'move_file', ok: false, code: 'EEXIST', journal: 'abc123-0123abcf' }),
      call({ t: NOW - 4, tool: 'read_file' }),
    ]);
    const [w, rev, noUndo, failed, read] = rows();
    expect(w.querySelectorAll('[data-testid="mcp-revert"]')).toHaveLength(1);
    expect(rev.dataset.mark).toBe('reverted');
    expect(rev.querySelector('.se-mcp-mark')!.textContent).toBe('↺');
    expect(rev.querySelector('[data-testid="mcp-reverted"]')!.textContent).toBe('reverted');
    expect(rev.querySelector('[data-testid="mcp-revert"]')).toBeNull();
    for (const r of [noUndo, failed, read]) expect(r.querySelector('[data-testid="mcp-revert"]')).toBeNull();
    expect(el.querySelectorAll('[data-testid="mcp-revert"]')).toHaveLength(1);

    act(() => (w.querySelector('[data-testid="mcp-revert"]') as HTMLButtonElement).click());
    expect(reverted).toEqual([write]);
    expect(q('mcp-call-details')).toBeNull(); // Revert is not the row's details toggle
  });

  it('filter: tool, path, app and result code, case-insensitive, across every call', () => {
    const rowsIn = [
      ...MANY,
      call({ t: NOW - 30 * 60_000, client: 'Claude Desktop', tool: 'list_files', path: 'Projects/Plan.md' }),
      call({ t: NOW - 40 * 60_000, ok: false, code: 'ENOENT', tool: 'read_file', path: 'gone.md' }),
    ];
    mount(rowsIn);
    expect(q('mcp-activity-filter')!.getAttribute('placeholder')).toBe('Filter 14 calls');
    type('tool_00'); // the oldest: beyond the collapsed few
    expect(tools()).toEqual(['tool_00']);
    expect(q('mcp-activity-count')!.textContent).toBe('1 of 14 calls');
    expect(q('mcp-activity-toggle')).toBeNull();
    type('plan.MD');
    expect(tools()).toEqual(['list_files']);
    type('claude');
    expect(tools()).toEqual(['list_files']);
    type('enoent');
    expect(tools()).toEqual(['read_file']);
    type('not found');
    expect(tools()).toEqual(['read_file']);
    type('nothing like this');
    expect(rows()).toHaveLength(0);
    expect(q('mcp-activity-none')!.textContent).toBe('No call matches “nothing like this”.');
    type('  ');
    expect(rows()).toHaveLength(FEW);
    expect(q('mcp-activity-count')).toBeNull();
  });

  it('problems only: refused and failed calls, newest first, combined with the filter', () => {
    const rowsIn = [...MANY, call({ t: NOW - 50 * 60_000, ok: false, code: 'EACCES', tool: 'write_file' }), call({ t: NOW - 1000, ok: false, code: 'EINVAL', tool: 'search' })];
    mount(rowsIn);
    expect(q('mcp-activity-problems')!.parentElement!.textContent).toContain('Problems only (2)');
    problemsOnly(true);
    expect(tools()).toEqual(['search', 'write_file']);
    expect(rows().every((r) => r.dataset.mark === 'problem')).toBe(true);
    expect(q('mcp-activity-count')!.textContent).toBe('2 of 14 calls');
    type('eacces');
    expect(tools()).toEqual(['write_file']);
    type('tool_03');
    expect(q('mcp-activity-none')!.textContent).toBe('No refused or failed call matches “tool_03”.');
    type('');
    problemsOnly(false);
    expect(rows()).toHaveLength(FEW);
  });

  it('problems only with none: says so', () => {
    mount(MANY);
    problemsOnly(true);
    expect(rows()).toHaveLength(0);
    expect(q('mcp-activity-none')!.textContent).toBe('No refused or failed calls.');
  });

  it('a click on a row shows its details (folder, file, answer size, undo copy); again hides them', () => {
    mount([call({ t: NOW, tool: 'append_file', folder: 'notes', path: 'log.md', bytes: 3300, journal: 'abc123-0123abcd' })]);
    const open = q('mcp-call-open') as HTMLButtonElement;
    expect(open.getAttribute('aria-expanded')).toBe('false');
    act(() => open.click());
    expect(open.getAttribute('aria-expanded')).toBe('true');
    const more = q('mcp-call-details')!.textContent!;
    expect(more).toContain('Folder notes');
    expect(more).toContain('File log.md');
    expect(more).toContain('Answer 3.2 KB');
    expect(more).toContain('Undo copy kept');
    act(() => open.click());
    expect(q('mcp-call-details')).toBeNull();
  });

  it('open details stay with their row when newer calls arrive on top', () => {
    const old = call({ t: NOW - 60_000, tool: 'get_outline' });
    el = document.createElement('div');
    document.body.append(el);
    const draw = (list: McpActivity[]) => act(() => render(<ActivityList rows={list} revert={() => {}} now={NOW} />, el));
    draw([old]);
    act(() => (q('mcp-call-open') as HTMLButtonElement).click());
    draw([call({ t: NOW, tool: 'search' }), old]);
    const [fresh, kept] = rows();
    expect(fresh.querySelector('[data-testid="mcp-call-details"]')).toBeNull();
    expect(kept.querySelector('[data-testid="mcp-call-details"]')).not.toBeNull();
  });

  it('log fields are text, never markup', () => {
    const HOSTILE = '<img src=x onerror="globalThis.__pwned=1">';
    mount([call({ t: NOW, client: HOSTILE, path: HOSTILE, ok: false, code: HOSTILE })]);
    expect(el.querySelector('img')).toBeNull();
    expect(rows()[0].querySelector('.se-mcp-app')!.textContent).toBe(HOSTILE);
    expect((globalThis as { __pwned?: number }).__pwned).toBeUndefined();
  });
});
