// @vitest-environment happy-dom
// The startup stubs duplicate a little command metadata so key bindings and the palette work before
// the feature chunk arrives. These tests keep stub and real module from drifting apart, and cover
// the "keys typed while a chunk loads" replay.
import { describe, expect, it } from 'vitest';
import { app } from '../../../src/renderer/app/app';
import { getCommand, type Command } from '../../../src/renderer/app/commands';
import { holdKeys, lazy, withModule } from '../../../src/renderer/app/lazy';
import { installFormatLazy } from '../../../src/renderer/app/lazy-features';

const FORMAT_IDS = ['format.document', 'format.selection', 'format.codeBlocks', 'format.toggleOnSave'];
const meta = (c: Command) => ({ id: c.id, title: c.title, category: c.category, keys: c.keys, keywords: c.keywords, hasWhen: !!c.when });
const frame = () => new Promise((r) => setTimeout(r, 40));

describe('lazy feature stubs', () => {
  it('format stub registers the same commands as src/format/install and is replaced by it', async () => {
    const baseSave = async () => true;
    app.saveFile = baseSave;
    installFormatLazy();
    const stubs = FORMAT_IDS.map((id) => getCommand(id)!);
    expect(stubs.every(Boolean)).toBe(true);
    expect(app.saveFile).not.toBe(baseSave); // format-on-save must be honoured before the chunk is in
    const before = stubs.map(meta);

    const real = await import('../../../src/format/install');
    app.saveFile = baseSave; // what the stub's loader does before calling installFormat()
    real.installFormat();
    const after = FORMAT_IDS.map((id) => getCommand(id)!);
    expect(after.map(meta)).toEqual(before);
    after.forEach((c, i) => expect(c, `${c.id} should be the real command now`).not.toBe(stubs[i]));
  });
});

describe('withModule / holdKeys', () => {
  it('runs synchronously once the module is loaded and only loads once', async () => {
    let loads = 0;
    const l = lazy(async () => (++loads, { n: 42 }));
    const seen: number[] = [];
    await withModule(l, (m) => seen.push(m.n));
    expect(withModule(l, (m) => seen.push(m.n))).toBeUndefined();
    expect(seen).toEqual([42, 42]);
    expect(loads).toBe(1);
  });

  it('replays text and Enter typed while loading into the input that takes focus — exactly once', async () => {
    const input = document.createElement('input');
    document.body.append(input);
    const got: string[] = [];
    input.addEventListener('keydown', (e) => got.push(e.key));
    let open!: () => void;
    const loading = new Promise<void>((r) => (open = r));
    holdKeys(loading);
    holdKeys(loading); // a second shortcut while the first is pending must not double the keys
    // The hold ignores untrusted events (its own replays): mark these as real key presses.
    const typed = (k: string) => {
      const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
      Object.defineProperty(e, 'isTrusted', { value: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(typed('a')).toBe(true);
    expect(typed('b')).toBe(true);
    expect(typed('x')).toBe(true);
    expect(typed('Backspace')).toBe(true);
    expect(typed('Enter')).toBe(true);
    expect(input.value).toBe('');
    open();
    input.focus();
    await frame();
    await frame();
    expect(input.value).toBe('ab');
    expect(got).toEqual(['Enter']);
    // Released: later keys are no longer intercepted.
    expect(typed('c')).toBe(false);
  });
});
