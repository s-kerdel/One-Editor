// @vitest-environment happy-dom
// Render tests of the file-overview panel against a fake editor / knowledge index.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/renderer/knowledge', () => ({ loadKnowledge: vi.fn(() => new Promise(() => {})) }));
import { signal } from '@preact/signals';
import { act } from 'preact/test-utils';
import { app, type DocState } from '../../../src/renderer/app/app';
import * as ui from '../../../src/renderer/app/ui';
import { mountOverview } from '../../../src/renderer/overview/OverviewPanel';
import { collapsedSections } from '../../../src/renderer/overview/sections';
import { searchClient } from '../../../src/renderer/search/client';
import type { Mention } from '../../../src/knowledge/index';

const NOTE = `---
tags: [ops]
owner: kerdel
---
# Runbook
intro
## Access
\`\`\`bash
# jump host
ssh deploy@api
\`\`\`
## Services
### Nginx
~~~sh
$ sudo nginx -t
~~~
### Database
- [ ] Run migrations
- [x] Tag release
See [[Deploy checklist]] and [[Grafana]].
# Appendix
`;
const L = (needle: string) => NOTE.split('\n').findIndex((l) => l.includes(needle));

let el: HTMLElement;
let unmount: (() => void) | null = null;
let editor: ReturnType<typeof fakeEditor>;

function setDoc(path: string, content: string, extra: Partial<DocState> = {}) {
  app.docs.set(path, { path, saved: content, content, mtime: Date.now() - 60_000, eol: 'lf', dirty: signal(false), ...extra });
}

function fakeEditor() {
  return {
    reveal: vi.fn(),
    focus: vi.fn(),
    getContent: vi.fn((p?: string) => app.docs.get(p ?? app.activePath.value ?? '')?.content),
    applyChanges: vi.fn((path: string, changes: Array<{ from: number; to: number; insert: string }>) => {
      const d = app.docs.get(path)!;
      let t = d.content;
      for (const c of [...changes].reverse()) t = t.slice(0, c.from) + c.insert + t.slice(c.to);
      d.content = t;
      app.events.emit('doc:changed', path, t);
    }),
    getCursor: () => ({ line: 0, col: 0, selectionLength: 0 }),
    onCursor: () => () => {},
    getLanguage: () => ({ id: 'typescript', name: 'TypeScript', auto: true }),
  };
}

const knowledge = {
  changed: signal(0),
  isBuilding: () => false,
  note: () => undefined,
  outgoing: () => [
    { link: { kind: 'wiki', target: 'Deploy checklist', embed: false, line: L('[[Deploy'), col: 4, length: 20 }, path: 'notes/Deploy checklist.md' },
    { link: { kind: 'wiki', target: 'Grafana', embed: false, line: L('[[Deploy'), col: 30, length: 11 }, path: null },
  ],
  backlinks: () => [
    { from: 'notes/Incident log.md', line: 2, col: 10, length: 14, link: {}, context: { text: 'see [[Runbook]] for the fix', start: 4, end: 15 } },
    { from: 'notes/Incident log.md', line: 5, col: 0, length: 14, link: {}, context: { text: '[[Runbook#Database]]', start: 0, end: 20 } },
  ],
};

function mount() {
  act(() => {
    unmount = mountOverview(el);
  });
}
const $ = (sel: string) => el.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => Array.from(el.querySelectorAll<HTMLElement>(sel));
const rowTexts = (sel: string) => $$(sel).map((r) => r.querySelector('.se-ov-text, .se-ov-cmd')?.textContent);
const key = (target: Element, k: string, init: KeyboardEventInit = {}) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
  });
const click = (target: Element | null) =>
  act(() => {
    (target as HTMLElement).click();
  });

beforeEach(() => {
  el = document.createElement('div');
  document.body.appendChild(el);
  localStorage.clear();
  collapsedSections.value = {};
  app.docs.clear();
  editor = fakeEditor();
  app.editor = editor as never;
  app.preview = null;
  app.settings.value = { ...app.settings.value, viewMode: 'live' };
  (app as { knowledge?: unknown }).knowledge = knowledge;
  app.openLink = vi.fn(async () => {});
  app.openSearch = vi.fn();
  app.openFile = vi.fn(async () => {});
  setDoc('notes/Runbook.md', NOTE);
  app.activePath.value = 'notes/Runbook.md';
  ui.cursorInfo.value = { line: 0, col: 0, selectionLength: 0 };
  app.ready.value = true;
});

afterEach(() => {
  act(() => unmount?.());
  unmount = null;
  el.remove();
  vi.useRealTimers();
});

describe('overview panel', () => {
  it('shows an empty state with no file open — but nothing at all while the app is still booting', () => {
    app.activePath.value = null;
    app.ready.value = false; // launch: the session's file arrives right after the first frame
    mount();
    expect(el.textContent).toBe('');
    expect($('.se-ov-head')).toBeTruthy(); // the band is there from the first frame (layout stays put)
    act(() => void (app.ready.value = true));
    expect(el.textContent).toContain('No file open');
    expect($$('[data-section]')).toHaveLength(0);
  });

  it('renders every section for a Markdown note', () => {
    mount();
    expect($$('[data-section]').map((s) => s.dataset.section)).toEqual(['outline', 'code', 'tasks', 'connections', 'info']);
    expect(rowTexts('.se-ov-ol')).toEqual(['Runbook', 'Access', 'Services', 'Nginx', 'Database', 'Appendix']);
    expect(rowTexts('.se-ov-code')).toEqual(['ssh deploy@api', 'sudo nginx -t']);
    expect($$('.se-ov-code .se-ov-lang').map((b) => b.textContent)).toEqual(['bash', 'sh']);
    expect($('[data-section="tasks"] .se-ov-count')!.textContent).toBe('1/2');
    expect(rowTexts('.se-ov-task')).toEqual(['Run migrations']); // done tasks hidden by default
    expect($('.se-ov-head')!.textContent).toContain('Runbook');
  });

  it('highlights the section holding the cursor — and a cursor move inside it touches no DOM', () => {
    mount();
    act(() => void (ui.cursorInfo.value = { line: L('Run migrations'), col: 0, selectionLength: 0 }));
    expect($('.se-ov-ol.is-active')!.textContent).toContain('Database');
    const mo = new MutationObserver(() => {});
    mo.observe(el, { subtree: true, childList: true, attributes: true, characterData: true });
    act(() => void (ui.cursorInfo.value = { line: L('Tag release'), col: 3, selectionLength: 0 }));
    expect(mo.takeRecords()).toHaveLength(0);
    act(() => void (ui.cursorInfo.value = { line: L('nginx -t'), col: 0, selectionLength: 0 }));
    expect($('.se-ov-ol.is-active')!.textContent).toContain('Nginx');
    expect($('.se-ov-code.is-active')!.textContent).toContain('sudo nginx -t');
    mo.disconnect();
  });

  it('click / Enter jumps: cursor on the heading via editor.reveal (preview: scrolls instead)', () => {
    mount();
    click($$('.se-ov-ol')[2]);
    expect(editor.reveal).toHaveBeenLastCalledWith({ line: L('## Services'), col: 0 });
    key($$('.se-ov-ol')[4], 'Enter');
    expect(editor.reveal).toHaveBeenLastCalledWith({ line: L('### Database'), col: 0 });
    const preview = { scrollToLine: vi.fn(), render() {}, onScroll: () => () => {}, dispose() {} };
    app.preview = preview;
    app.settings.value = { ...app.settings.value, viewMode: 'preview' };
    click($$('.se-ov-ol')[1]);
    expect(preview.scrollToLine).toHaveBeenCalledWith(L('## Access'));
  });

  it('folds per node and collapses to a level', () => {
    mount();
    click($$('.se-ov-ol')[2].querySelector('.se-ov-twisty'));
    expect(rowTexts('.se-ov-ol')).toEqual(['Runbook', 'Access', 'Services', 'Appendix']);
    expect($$('.se-ov-ol')[2].getAttribute('aria-expanded')).toBe('false');
    const lvl = (label: string) => $$('.se-ov-lvl-btn').find((b) => b.textContent === label)!;
    click(lvl('1'));
    expect(rowTexts('.se-ov-ol')).toEqual(['Runbook', 'Appendix']);
    expect(lvl('1').getAttribute('aria-pressed')).toBe('true');
    click(lvl('2'));
    expect(rowTexts('.se-ov-ol')).toEqual(['Runbook', 'Access', 'Services', 'Appendix']);
    click(lvl('All'));
    expect($$('.se-ov-ol')).toHaveLength(6);
  });

  it('keyboard: one tab stop per list, arrows move, ←/→ fold and climb the tree', () => {
    mount();
    const rows = () => $$('.se-ov-ol');
    expect(rows().filter((r) => r.tabIndex === 0)).toHaveLength(1);
    act(() => rows()[0].focus());
    key(rows()[0], 'ArrowDown');
    expect(document.activeElement).toBe(rows()[1]);
    key(rows()[1], 'End');
    expect(document.activeElement).toBe(rows()[5]);
    key(rows()[5], 'Home');
    key(rows()[0], 'ArrowDown');
    key(rows()[1], 'ArrowDown'); // Services
    key(rows()[2], 'ArrowLeft'); // fold it
    expect(rows()).toHaveLength(4);
    key(rows()[2], 'ArrowRight'); // unfold
    expect(rows()).toHaveLength(6);
    act(() => rows()[3].focus()); // Nginx
    key(rows()[3], 'ArrowLeft'); // → parent
    expect(document.activeElement?.textContent).toContain('Services');
    expect(rows().filter((r) => r.tabIndex === 0)).toEqual([rows()[2]]);
  });

  it('code blocks: click jumps to the first code line; copy button and Ctrl+C copy the code', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mount();
    click($$('.se-ov-code')[0]);
    expect(editor.reveal).toHaveBeenLastCalledWith({ line: L('```bash') + 1, col: 0 });
    click($$('.se-ov-code')[0].querySelector('.se-ov-copy'));
    expect(writeText).toHaveBeenLastCalledWith('# jump host\nssh deploy@api');
    key($$('.se-ov-code')[1], 'c', { ctrlKey: true });
    expect(writeText).toHaveBeenLastCalledWith('$ sudo nginx -t');
  });

  it('tasks: the checkbox (or Space) toggles in place through the editor; "Done" shows completed ones', () => {
    mount();
    click($('.se-ov-task .se-ov-check'));
    expect(editor.applyChanges).toHaveBeenCalledTimes(1);
    const [path, [change]] = editor.applyChanges.mock.calls[0];
    expect(path).toBe('notes/Runbook.md');
    expect(NOTE.slice(change.from - 1, change.to + 1)).toBe('[ ]');
    expect(change.insert).toBe('x');
    // The panel refreshed at once (no debounce wait after its own edit): nothing open is left.
    expect($('[data-section="tasks"] .se-ov-count')!.textContent).toBe('2/2');
    expect(el.textContent).toContain('Nothing left to do');
    click($$('.se-ov-lvl-btn').find((b) => b.textContent === 'Done')!);
    expect(rowTexts('.se-ov-task')).toEqual(['Run migrations', 'Tag release']);
    key($$('.se-ov-task')[1], ' ');
    expect(app.docs.get('notes/Runbook.md')!.content).toContain('- [ ] Tag release');
    expect(editor.reveal).not.toHaveBeenCalled();
  });

  it('connections: outgoing links (create missing via openLink), incoming links with their line, related, counts', async () => {
    // The section is its own chunk and reads the real link index.
    const { index } = await import('../../../src/renderer/knowledge/state');
    index.clear();
    const notes: Record<string, string> = {
      'notes/Runbook.md': NOTE,
      'notes/Deploy checklist.md': '# Deploy checklist\n#ops',
      'notes/Incident log.md': '# Incident\n\nsee [[Runbook]] for the fix\n\n\n[[Runbook#Database]]\n',
      'notes/Postmortem.md': '# Postmortem\n[[Deploy checklist]]',
    };
    index.setFiles(Object.keys(notes));
    for (const [p, t] of Object.entries(notes)) index.update(p, t);
    // Opened by the user (it starts collapsed); no canvas in happy-dom: the graph stays folded.
    collapsedSections.value = { connections: false, 'cn-graph': true, 'cn-mentions': true };
    const scan = vi.spyOn(searchClient, 'mentions').mockResolvedValue([]); // no search workers here
    mount();
    await vi.waitFor(() => expect($$('.se-ov-link')).toHaveLength(2));
    const links = $$('.se-ov-link');
    expect(links.map((r) => r.querySelector('.se-ov-text')!.textContent)).toEqual(['Deploy checklist', 'Grafana']);
    expect(links[1].classList.contains('unresolved')).toBe(true);
    expect(links[1].querySelector('.se-cn-create')).toBeTruthy();
    click(links[0]);
    expect(app.openLink).toHaveBeenLastCalledWith('Deploy checklist', 'notes/Runbook.md');
    click(links[1].querySelector('.se-cn-create'));
    expect(app.openLink).toHaveBeenLastCalledWith('Grafana', 'notes/Runbook.md');
    click(links[0].querySelector('.se-ov-mini'));
    expect(editor.reveal).toHaveBeenLastCalledWith({ line: L('[[Deploy'), col: 4 });

    // Incoming links fill in when the (time-sliced) link derive completes; outgoing ones are exact at once.
    await vi.waitFor(() => expect($$('.se-ov-back')).toHaveLength(2));
    const back = $$('.se-ov-back');
    expect(back[0].querySelector('.se-ov-name')!.textContent).toBe('Incident log');
    expect(back[0].querySelector('mark')!.textContent).toBe('[[Runbook]]');
    click(back[1]);
    expect(app.openFile).toHaveBeenLastCalledWith('notes/Incident log.md', { line: 5, col: 0, length: 20 });

    const count = (id: string) => $(`[data-sub="${id}"] .se-cn-n`)?.textContent;
    expect(count('cn-in')).toBe('2');
    expect(count('cn-out')).toBe('2');
    expect($('[data-section="connections"] .se-ov-count')!.textContent).toBe('2'); // Deploy checklist + Incident log
    // Folded sub-sections still count: the graph, and the mentions (the scan runs while Connections is open).
    expect(count('cn-graph')).toBe('2');
    await vi.waitFor(() => expect(count('cn-mentions')).toBe('0'));
    expect(scan).toHaveBeenCalledWith(['Runbook'], 'notes/Runbook.md', 500);
    // Postmortem cites Deploy checklist too (bibliographic coupling).
    expect($$('.se-cn-rel .se-ov-name').map((n) => n.textContent)).toEqual(['Postmortem']);
    // Sub-sections fold and stay folded.
    click($('[data-sub="cn-in"] .se-cn-toggle'));
    expect($$('.se-ov-back')).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem('sec-edit-overview-sections')!)['cn-in']).toBe(true);
    scan.mockRestore();
    index.clear();
  });

  it('info: counts, size, tags (→ search) and properties', () => {
    mount();
    const facts = Object.fromEntries($$('.se-ov-facts dt').map((dt) => [dt.textContent, dt.nextElementSibling!.textContent]));
    expect(facts.Lines).toBe(String(NOTE.split('\n').length));
    expect(Number(facts.Words)).toBeGreaterThan(10);
    expect(facts['Reading time']).toBe('< 1 min');
    expect(facts.Size).toBe(`${NOTE.length} B`);
    expect(facts.Modified).toBe('1 min ago');
    click($('.se-ov-pill'));
    expect(app.openSearch).toHaveBeenCalledWith('tag:ops');
    expect($('.se-ov-props')!.textContent).toContain('owner');
    expect($('.se-ov-props')!.textContent).toContain('kerdel');
  });

  it('section collapse is remembered (and survives a broken localStorage)', () => {
    mount();
    click($('[data-section="code"] .se-ov-sec-toggle'));
    expect($$('.se-ov-code')).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem('sec-edit-overview-sections')!)).toEqual({ code: true });
    act(() => unmount!());
    mount();
    expect($('[data-section="code"] .se-ov-sec-toggle')!.getAttribute('aria-expanded')).toBe('false');
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    click($('[data-section="code"] .se-ov-sec-toggle'));
    expect($$('.se-ov-code')).toHaveLength(2);
    spy.mockRestore();
  });

  it('live: edits re-scan after a short debounce; switching files is immediate', () => {
    vi.useFakeTimers();
    mount();
    act(() => {
      const d = app.docs.get('notes/Runbook.md')!;
      d.content = `${NOTE}## Added\n`;
      app.events.emit('doc:changed', d.path, d.content);
    });
    expect(rowTexts('.se-ov-ol')).not.toContain('Added');
    act(() => void vi.advanceTimersByTime(160));
    expect(rowTexts('.se-ov-ol')).toContain('Added');
    setDoc('code/store.ts', 'export class Store {\n  load() {\n  }\n}\nexport function make() {}\n');
    act(() => void (app.activePath.value = 'code/store.ts'));
    expect($('[data-section="outline"] .se-ov-sec-title')!.textContent).toBe('Symbols');
    expect($$('[data-section]').map((s) => s.dataset.section)).toEqual(['outline', 'info']);
    expect($$('.se-ov-ol').map((r) => [r.querySelector('.se-ov-kind')!.textContent, r.querySelector('.se-ov-text')!.textContent])).toEqual([
      ['C', 'Store'],
      ['m', 'load'],
      ['ƒ', 'make'],
    ]);
    expect(el.textContent).toContain('TypeScript');
  });

  it('binary files: no outline, file info only', async () => {
    app.backend = { kind: 'web', readFile: vi.fn(async () => ({ size: 2048 })) } as never;
    setDoc('data/blob.bin', '', { binary: true });
    app.activePath.value = 'data/blob.bin';
    mount();
    expect(el.textContent).toContain('Binary file: nothing to outline');
    expect($$('[data-section]').map((s) => s.dataset.section)).toEqual(['info']);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(el.textContent).toContain('2.0 KB');
  });
});

// ---------------------------------------------------------------- default open / closed + counts

const PLAIN = '# Plain\nsome text\n## Two\n';
const FENCE = '```';
const sec = (id: string) => $(`[data-section="${id}"]`);
const isOpen = (id: string) => sec(id)!.querySelector('.se-ov-sec-toggle')!.getAttribute('aria-expanded') === 'true';
const headCount = (id: string) => sec(id)!.querySelector('.se-ov-sec-head .se-ov-count')?.textContent ?? null;
const sub = (id: string) => $(`[data-sub="${id}"]`);
const subOpen = (id: string) => sub(id)!.querySelector('.se-cn-toggle')!.getAttribute('aria-expanded') === 'true';
const subCount = (id: string) => sub(id)!.querySelector('.se-cn-n')!.textContent;
const edit = (path: string, content: string) =>
  act(() => {
    app.docs.get(path)!.content = content;
    app.events.emit('doc:changed', path, content);
  });
/** The mention scan held open; `answer` settles every pending call (an index bump restarts the scan). */
function pendingScans() {
  const pending: Array<(m: Mention[]) => void> = [];
  const scan = vi.spyOn(searchClient, 'mentions').mockImplementation(() => new Promise((r) => pending.push(r)));
  return { scan, answer: (m: Mention[]) => pending.splice(0).forEach((r) => r(m)) };
}
const mention = (from: string, line: number): Mention => ({ from, line, col: 0, length: 7, text: 'Runbook', context: { text: 'Runbook here', start: 0, end: 7 } });

describe('overview sections: default open / closed, counts', () => {
  it('never touched: lists with entries start open, empty ones collapsed with 0; Info open (no count); Connections collapsed', () => {
    setDoc('notes/Plain.md', PLAIN);
    app.activePath.value = 'notes/Plain.md';
    mount();
    expect([isOpen('outline'), headCount('outline')]).toEqual([true, '2']);
    expect([isOpen('code'), headCount('code')]).toEqual([false, '0']);
    expect([isOpen('tasks'), headCount('tasks')]).toEqual([false, '0']);
    expect(sec('code')!.querySelector('.se-ov-hint')).toBeNull(); // the body (hint) is not rendered
    expect([isOpen('info'), headCount('info')]).toEqual([true, null]);
    expect(isOpen('connections')).toBe(false);
    expect(headCount('connections')).not.toBeNull(); // "…" until its chunk counts
    expect(localStorage.getItem('sec-edit-overview-sections')).toBeNull(); // defaults are not choices
  });

  it('live: an untouched section opens when it gets entries and collapses when it loses them', () => {
    vi.useFakeTimers();
    setDoc('notes/Plain.md', PLAIN);
    app.activePath.value = 'notes/Plain.md';
    mount();
    edit('notes/Plain.md', `${PLAIN}- [ ] Ship it\n${FENCE}sh\nls\n${FENCE}\n`);
    act(() => void vi.advanceTimersByTime(160));
    expect([isOpen('tasks'), headCount('tasks')]).toEqual([true, '0/1']);
    expect([isOpen('code'), headCount('code')]).toEqual([true, '1']);
    expect(rowTexts('.se-ov-task')).toEqual(['Ship it']);
    edit('notes/Plain.md', '');
    act(() => void vi.advanceTimersByTime(160));
    expect([isOpen('tasks'), isOpen('code'), isOpen('outline')]).toEqual([false, false, false]);
    expect([headCount('tasks'), headCount('code'), headCount('outline')]).toEqual(['0', '0', '0']);
  });

  it('an explicit toggle wins — open while empty, collapsed while full — and is remembered', () => {
    vi.useFakeTimers();
    setDoc('notes/Plain.md', PLAIN);
    app.activePath.value = 'notes/Plain.md';
    mount();
    click(sec('tasks')!.querySelector('.se-ov-sec-toggle'));
    click(sec('outline')!.querySelector('.se-ov-sec-toggle'));
    expect(isOpen('tasks')).toBe(true);
    expect(sec('tasks')!.textContent).toContain('No tasks');
    expect(isOpen('outline')).toBe(false);
    expect(JSON.parse(localStorage.getItem('sec-edit-overview-sections')!)).toEqual({ tasks: false, outline: true });
    // Content changes no longer move them.
    edit('notes/Plain.md', `${PLAIN}## Three\n`);
    act(() => void vi.advanceTimersByTime(160));
    expect([isOpen('outline'), headCount('outline')]).toEqual([false, '3']);
    expect(isOpen('tasks')).toBe(true);
    // Another file, and a fresh mount: same choices.
    act(() => unmount!());
    app.activePath.value = 'notes/Runbook.md';
    mount();
    expect([isOpen('outline'), isOpen('tasks'), isOpen('code')]).toEqual([false, true, true]);
  });

  it('Connections: collapsed by default with its count — no lists, graph or mention scan until opened', async () => {
    const { index } = await import('../../../src/renderer/knowledge/state');
    const { connectionsPerf } = await import('../../../src/renderer/knowledge/Connections');
    index.clear();
    const notes: Record<string, string> = {
      'notes/Runbook.md': NOTE,
      'notes/Deploy checklist.md': '# Deploy checklist\n#ops',
      'notes/Incident log.md': '# Incident\n\nsee [[Runbook]] for the fix\n',
      'notes/Postmortem.md': '# Postmortem\n[[Deploy checklist]]',
    };
    index.setFiles(Object.keys(notes));
    for (const [p, t] of Object.entries(notes)) index.update(p, t);
    const { scan, answer } = pendingScans();
    const graphs = connectionsPerf.graph.length;
    mount();
    await vi.waitFor(() => expect(headCount('connections')).toBe('2')); // Deploy checklist + Incident log
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    expect(isOpen('connections')).toBe(false);
    expect($$('[data-sub]')).toHaveLength(0);
    expect($('.se-cn-graph')).toBeNull();
    expect(scan).not.toHaveBeenCalled();
    expect(connectionsPerf.graph.length).toBe(graphs);

    click(sec('connections')!.querySelector('.se-ov-sec-toggle'));
    expect($$('[data-sub]').map((d) => d.dataset.sub)).toEqual(['cn-graph', 'cn-in', 'cn-out', 'cn-mentions', 'cn-tags', 'cn-related']);
    // Counted ones with entries start open; the mention scan is still running: "…", folded.
    expect([subCount('cn-graph'), subOpen('cn-graph')]).toEqual(['2', true]);
    expect([subCount('cn-in'), subOpen('cn-in')]).toEqual(['1', true]);
    expect([subCount('cn-out'), subOpen('cn-out')]).toEqual(['2', true]);
    expect([subCount('cn-tags'), subOpen('cn-tags')]).toEqual(['1', true]); // #ops
    expect([subCount('cn-related'), subOpen('cn-related')]).toEqual(['1', true]); // Postmortem cites Deploy checklist too
    expect([subCount('cn-mentions'), subOpen('cn-mentions')]).toEqual(['…', false]);
    expect(sub('cn-mentions')!.querySelector('.se-cn-n')!.classList.contains('is-pending')).toBe(true);
    await vi.waitFor(() => expect(scan).toHaveBeenCalled());
    await act(async () => answer([mention('notes/Incident log.md', 0), mention('notes/Deploy checklist.md', 0)]));
    // Known: the count, and (never touched) it opens.
    await vi.waitFor(() => expect([subCount('cn-mentions'), subOpen('cn-mentions')]).toEqual(['2', true]));
    expect($$('.se-cn-mention')).toHaveLength(2);
    // Collapsed again by the user: the count stays.
    click(sub('cn-mentions')!.querySelector('.se-cn-toggle'));
    expect([subCount('cn-mentions'), subOpen('cn-mentions')]).toEqual(['2', false]);
    expect(JSON.parse(localStorage.getItem('sec-edit-overview-sections')!)).toEqual({ connections: false, 'cn-mentions': true });
    scan.mockRestore();
    index.clear();
  });

  it('Connections sub-sections: every one shows a count; empty ones start collapsed; a full scan reads "500+"', async () => {
    const { index } = await import('../../../src/renderer/knowledge/state');
    index.clear();
    setDoc('notes/Lonely.md', '# Lonely\nno links\n');
    index.setFiles(['notes/Lonely.md', 'notes/Runbook.md']);
    index.update('notes/Lonely.md', '# Lonely\nno links\n');
    app.activePath.value = 'notes/Lonely.md';
    const { scan, answer } = pendingScans();
    collapsedSections.value = { connections: false };
    mount();
    await vi.waitFor(() => expect(sub('cn-in')).toBeTruthy());
    await vi.waitFor(() => expect(scan).toHaveBeenCalled());
    await act(async () => answer([]));
    await vi.waitFor(() => expect(subCount('cn-mentions')).toBe('0'));
    expect(headCount('connections')).toBe('0');
    for (const id of ['cn-graph', 'cn-in', 'cn-out', 'cn-mentions', 'cn-tags', 'cn-related']) expect([id, subCount(id), subOpen(id)]).toEqual([id, '0', false]);
    expect($('.se-cn-graph')).toBeNull(); // folded: no canvas
    // Opened by hand: the hint explains the empty list.
    click(sub('cn-tags')!.querySelector('.se-cn-toggle'));
    expect(sub('cn-tags')!.textContent).toContain('This note has no tags.');

    // Another note whose scan hits the cap.
    scan.mockResolvedValue(Array.from({ length: 500 }, (_, i) => mention('notes/Other.md', i)));
    index.update('notes/Runbook.md', NOTE);
    act(() => void (app.activePath.value = 'notes/Runbook.md'));
    await vi.waitFor(() => expect(subCount('cn-mentions')).toBe('500+'));
    expect(subOpen('cn-mentions')).toBe(true);
    expect($$('.se-cn-mention')).toHaveLength(100); // the list stays short
    scan.mockRestore();
    index.clear();
  });
});
