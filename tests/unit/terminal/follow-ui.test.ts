// "Follow Claude's edits", UI side: the queue (every edit is shown, in order), the reload-at-once rule
// (never for unsaved edits), and the "changed this turn" marks (kept per file, moved by edits, cleared
// by the next prompt). Runs on real CodeMirror state behind a stand-in view; no DOM, no Claude.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState, type TransactionSpec } from '@codemirror/state';
import { followAdd, followField, followLines, followSync, lineStarts, MAX_FLASH_LINES, MAX_MARKS_PER_FILE } from '../../../src/renderer/terminal/follow-marks';
import type { TerminalFollowEvent } from '../../../src/shared/terminal';

const h = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...a: any[]) => void>>();
  const emit = (name: string, ...a: unknown[]) => listeners.get(name)?.forEach((cb) => cb(...a));
  const app = {
    activePath: { value: null as string | null },
    docs: new Map<string, { dirty: { value: boolean }; binary?: boolean }>(),
    events: {
      on(name: string, cb: (...a: any[]) => void) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name)!.add(cb);
        return () => listeners.get(name)!.delete(cb);
      },
      emit,
    },
    editor: null as any,
    openFile: null as any,
    toast: null as any,
  };
  return { app, emit, reloads: [] as string[], reload: null as null | ((path: string) => void) };
});
vi.mock('../../../src/renderer/app/app', () => ({ app: h.app }));
vi.mock('../../../src/renderer/git/index', () => ({ getGitStore: () => null }));
vi.mock('../../../src/renderer/app/disk-sync', () => ({
  handleFsEvents: async (events: Array<{ path: string }>) => events.forEach((e) => (h.reloads.push(e.path), h.reload?.(e.path))),
}));

import { clearChangeMarks, FOLLOW_LIMITS, onFollowEvent } from '../../../src/renderer/terminal/follow';

/** One view whose state is swapped per document, like the editor's. */
class World {
  disk = new Map<string, string>();
  states = new Map<string, EditorState>();
  current: string | null = null;
  flashes: Array<{ path: string | null; lines: Array<[number, number]> }> = [];
  opened: string[] = [];
  toasts: string[] = [];
  gate: Promise<void> | null = null;
  view = {
    state: EditorState.create({ doc: '' }),
    hasFocus: false,
    dispatch: (spec: TransactionSpec) => {
      const tr = this.view.state.update(spec);
      for (const fx of tr.effects) if (fx.is(followAdd) && fx.value.until > 0) this.flashes.push({ path: this.current, lines: fx.value.lines });
      this.view.state = tr.state;
    },
  };

  constructor() {
    h.app.docs.clear();
    h.app.activePath.value = null;
    h.app.editor = { getView: () => this.view, getContent: (p: string) => (p === this.current ? this.view.state : this.states.get(p))?.doc.toString() };
    h.app.toast = (text: string) => this.toasts.push(text);
    h.app.openFile = async (path: string) => {
      this.opened.push(path);
      if (this.gate) await this.gate;
      this.activate(path);
    };
    h.reloads.length = 0;
    // The watcher's rule: a clean document follows the disk with one minimal change.
    h.reload = (path) => {
      const next = this.disk.get(path)!;
      const old = this.text(path);
      if (h.app.docs.get(path)?.dirty.value || old === next) return;
      let a = 0;
      while (a < Math.min(old.length, next.length) && old[a] === next[a]) a++;
      let b1 = old.length;
      let b2 = next.length;
      while (b1 > a && b2 > a && old[b1 - 1] === next[b2 - 1]) (b1--, b2--);
      this.view.dispatch({ changes: { from: a, to: b1, insert: next.slice(a, b2) } });
      h.emit('file:updated', path, next);
    };
  }

  text(path: string) {
    return h.app.editor.getContent(path) as string;
  }

  /** What a tab click does: swap the state in, tell the app. */
  activate(path: string) {
    if (this.current) this.states.set(this.current, this.view.state);
    if (!h.app.docs.has(path)) {
      h.app.docs.set(path, { dirty: { value: false } });
      this.states.set(path, EditorState.create({ doc: this.disk.get(path) ?? '' }));
    }
    this.current = path;
    this.view.state = this.states.get(path)!;
    h.app.activePath.value = path;
    h.emit('active:changed', path);
  }

  lines() {
    return followLines(this.view.state);
  }
}

const numbered = (n: number, edits: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => edits[i + 1] ?? `line ${i + 1}`).join('\n');
const edit = (path: string, line: number, text?: string, id = 1): TerminalFollowEvent => ({ id, kind: 'edit', path, lines: [[line, line]], ...(text ? { probe: { line, text } } : {}) });
const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

let w: World;
let clock = 1_000_000;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime((clock += 100_000)); // never back in time between tests
  onFollowEvent({ id: 1, kind: 'prompt' }); // a new turn: nothing left from the test before
  w = new World();
});
afterEach(async () => {
  await settle(10_000); // let the queue and the flash timers run out
  vi.useRealTimers();
});

describe('the queue', () => {
  it('6 quick edits of the open file: 6 flashes, in order, all on screen at once; each fades on its own', async () => {
    w.disk.set('a.ts', numbered(30));
    w.activate('a.ts');
    const changed: Record<number, string> = {};
    for (let k = 1; k <= 6; k++) {
      changed[k * 4] = `edit ${k}`;
      w.disk.set('a.ts', numbered(30, changed)); // Claude wrote the file …
      onFollowEvent(edit('a.ts', k * 4, `edit ${k}`)); // … and the hook reported it
      if (k === 3) await settle(1000);
    }
    await settle(0);
    expect(w.flashes.map((f) => f.lines[0][0])).toEqual([4, 8, 12, 16, 20, 24]);
    expect(w.text('a.ts')).toBe(numbered(30, changed)); // read at once, not after the watcher
    expect(h.reloads.length).toBeGreaterThanOrEqual(2);
    expect(w.lines()).toEqual({ flash: [4, 8, 12, 16, 20, 24], marks: [4, 8, 12, 16, 20, 24] });
    expect(w.toasts).toEqual(['Claude edited a.ts']); // one note for the run, not six
    await settle(3300); // 4.3 s after the first three, 3.3 s after the rest
    expect(w.lines().flash).toEqual([16, 20, 24]);
    await settle(1000);
    expect(w.lines()).toEqual({ flash: [], marks: [4, 8, 12, 16, 20, 24] });
  });

  it('an edit that later edits moved is still shown: found by its text', async () => {
    w.disk.set('a.ts', numbered(10));
    w.activate('a.ts');
    // Both edits are on disk before the first event is handled: edit 1's line 5 is line 6 by now.
    w.disk.set('a.ts', ['inserted above', ...numbered(10, { 5: 'edit one' }).split('\n')].join('\n'));
    onFollowEvent({ ...edit('a.ts', 5, 'edit one'), hint: 'edit one' });
    onFollowEvent(edit('a.ts', 1, 'inserted above'));
    await settle(0);
    expect(w.flashes.map((f) => f.lines)).toEqual([[[6, 6]], [[1, 1]]]);
  });

  it('a document with unsaved edits is never reloaded, flashed or marked', async () => {
    w.disk.set('a.ts', numbered(10));
    w.activate('a.ts');
    w.view.dispatch({ changes: { from: 0, insert: 'mine ' } });
    h.app.docs.get('a.ts')!.dirty.value = true;
    const mine = w.text('a.ts');
    w.disk.set('a.ts', numbered(10, { 3: 'claude' }));
    onFollowEvent({ ...edit('a.ts', 3, 'claude'), hint: 'line 4' });
    await settle(3000);
    expect(h.reloads).toEqual([]);
    expect(w.text('a.ts')).toBe(mine);
    expect(w.lines()).toEqual({ flash: [], marks: [] });
    expect(w.toasts).toEqual(['Claude edited a.ts']);
  });

  it('files changing faster than one a second: jump to the newest, the skipped file keeps its marks and counts', async () => {
    for (const p of ['a.ts', 'b.ts', 'c.ts']) w.disk.set(p, numbered(10));
    onFollowEvent(edit('a.ts', 2));
    onFollowEvent(edit('b.ts', 3));
    onFollowEvent(edit('c.ts', 4));
    await settle(0);
    expect(w.opened).toEqual(['a.ts', 'c.ts']);
    expect(w.current).toBe('c.ts');
    expect(w.flashes.map((f) => f.path)).toEqual(['a.ts', 'c.ts']);
    w.activate('b.ts'); // the user looks at it later
    expect(w.lines()).toEqual({ flash: [], marks: [3] });
    onFollowEvent({ id: 1, kind: 'stop' });
    expect(w.toasts.at(-1)).toBe('Claude changed 3 files this turn');
  });

  it('typing in another file: the editor stays, the marks wait for their file', async () => {
    w.disk.set('a.ts', numbered(10)).set('b.ts', numbered(10));
    w.activate('a.ts');
    w.view.hasFocus = true;
    onFollowEvent(edit('b.ts', 7));
    await settle(0);
    expect(w.opened).toEqual([]);
    expect(w.current).toBe('a.ts');
    w.activate('b.ts');
    expect(w.lines().marks).toEqual([7]);
  });

  it('is capped: edits beyond the queue only leave marks', async () => {
    w.disk.set('b.ts', numbered(100));
    let open!: () => void;
    w.gate = new Promise<void>((r) => (open = r));
    const extra = 5;
    for (let k = 1; k <= 1 + FOLLOW_LIMITS.queue + extra; k++) onFollowEvent(edit('b.ts', k));
    w.gate = null;
    open();
    await settle(0);
    expect(w.flashes).toHaveLength(1 + FOLLOW_LIMITS.queue);
    expect(w.flashes.at(-1)!.lines).toEqual([[1 + FOLLOW_LIMITS.queue + extra, 1 + FOLLOW_LIMITS.queue + extra]]);
    expect(w.lines().marks).toHaveLength(1 + FOLLOW_LIMITS.queue + extra); // the 5 dropped ones too
  });

  it('files per turn are capped', async () => {
    w.disk.set('a.ts', numbered(5));
    w.activate('a.ts');
    w.view.hasFocus = true; // nothing is opened: every file only waits
    const n = FOLLOW_LIMITS.files + 20;
    for (let k = 0; k < n; k++) w.disk.set(`f${k}.ts`, numbered(5));
    for (let k = 0; k < n; k++) onFollowEvent(edit(`f${k}.ts`, 2));
    await settle(0);
    w.activate('f0.ts');
    expect(w.lines().marks).toEqual([2]);
    w.activate(`f${n - 1}.ts`);
    expect(w.lines().marks).toEqual([]);
    onFollowEvent({ id: 1, kind: 'stop' });
    expect(w.toasts.at(-1)).toBe(`Claude changed ${FOLLOW_LIMITS.files} files this turn`);
  });

  it('ignores events it does not know and line ranges that are not ranges', async () => {
    w.disk.set('a.ts', numbered(10));
    w.activate('a.ts');
    for (const bad of [null, {}, { id: 1, kind: 'edit' }, { id: 1, kind: 'run', path: 'a.ts' }, { id: 'x', kind: 'edit', path: 'a.ts' }, { id: 1, kind: 'edit', path: 7 }]) onFollowEvent(bad as unknown as TerminalFollowEvent);
    onFollowEvent({ id: 1, kind: 'edit', path: 'a.ts', lines: [[0, 2], [3, 2], ['1', 2], [1.5, 2], [4], 'x', [5, 6]] as never });
    await settle(0);
    expect(w.flashes.map((f) => f.lines)).toEqual([[[5, 6]]]);
  });
});

describe('"changed this turn" marks', () => {
  it('added → moved by an edit → cleared by the next prompt', async () => {
    w.disk.set('a.ts', numbered(10));
    w.activate('a.ts');
    w.disk.set('a.ts', numbered(10, { 5: 'claude' }));
    onFollowEvent(edit('a.ts', 5, 'claude'));
    await settle(0);
    expect(w.lines().marks).toEqual([5]);
    w.view.dispatch({ changes: { from: 0, insert: 'two\nnew lines\n' } }); // the user types above it
    expect(w.lines().marks).toEqual([7]);
    expect(w.view.state.doc.line(7).text).toBe('claude');
    onFollowEvent({ id: 1, kind: 'stop' }); // the end of the turn keeps them
    expect(w.lines().marks).toEqual([7]);
    onFollowEvent({ id: 1, kind: 'prompt' });
    expect(w.lines().marks).toEqual([]);
  });

  it('a marked line that is deleted takes its mark along', () => {
    let s = EditorState.create({ doc: numbered(6), extensions: [followField] });
    s = s.update({ effects: followAdd.of({ lines: [[2, 3]], turn: 1, until: 0 }) }).state;
    s = s.update({ changes: { from: s.doc.line(1).to, to: s.doc.line(2).to } }).state; // line 2 goes
    expect(followLines(s)).toEqual({ flash: [], marks: [2] }); // the old line 3
  });

  it('Clear change marks: the file on screen now, the other tabs when they are shown, waiting marks never', async () => {
    for (const p of ['a.ts', 'b.ts', 'c.ts']) w.disk.set(p, numbered(10));
    onFollowEvent(edit('a.ts', 2));
    await settle(1500);
    onFollowEvent(edit('b.ts', 3));
    await settle(0);
    w.view.hasFocus = true;
    onFollowEvent(edit('c.ts', 4)); // waits
    await settle(0);
    expect(w.current).toBe('b.ts');
    expect(clearChangeMarks()).toBe(true);
    expect(w.lines().marks).toEqual([]);
    expect(clearChangeMarks()).toBe(false);
    w.activate('a.ts');
    expect(w.lines().marks).toEqual([]);
    w.activate('c.ts');
    expect(w.lines().marks).toEqual([]);
    // A new turn marks again.
    w.view.hasFocus = false;
    onFollowEvent(edit('c.ts', 6));
    await settle(0);
    expect(w.lines().marks).toEqual([6]);
  });

  it('caps: marks per file, lines per flash; a line is marked once', () => {
    let s = EditorState.create({ doc: numbered(MAX_MARKS_PER_FILE + 500), extensions: [followField] });
    s = s.update({ effects: followAdd.of({ lines: [[1, 10]], turn: 1, until: 5 }) }).state;
    s = s.update({ effects: followAdd.of({ lines: [[1, 1e9]], turn: 1, until: 9 }) }).state;
    const { flash, marks } = followLines(s);
    expect(flash).toHaveLength(MAX_FLASH_LINES);
    expect(marks).toHaveLength(MAX_MARKS_PER_FILE);
    expect(new Set(marks).size).toBe(MAX_MARKS_PER_FILE);
    s = s.update({ effects: followAdd.of({ lines: [[MAX_MARKS_PER_FILE + 100, MAX_MARKS_PER_FILE + 100]], turn: 1, until: 0 }) }).state;
    expect(followLines(s).marks).toHaveLength(MAX_MARKS_PER_FILE); // full
    expect(lineStarts(s.doc, [[-5, 2], [2, 3], [NaN, 4] as never], 10)).toEqual([0, 7, 14]);
    // Housekeeping: ended flashes and another turn's marks go.
    s = s.update({ effects: followSync.of({ now: 9, turn: 2 }) }).state;
    expect(followLines(s)).toEqual({ flash: [], marks: [] });
  });
});
