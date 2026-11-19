// Launch-speed helpers: features register cheap stubs at startup (commands, key bindings, sidebar
// panels) and pull their implementation chunk on first use or once the app is idle.
import type { ComponentType } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { app } from './app';

export interface Lazy<M> {
  /** Starts (or joins) the chunk load. */
  load(): Promise<M>;
  /** The module once loaded — lets callers stay synchronous after the first use. */
  peek(): M | null;
}

export function lazy<M>(loader: () => Promise<M>): Lazy<M> {
  let mod: M | null = null;
  let p: Promise<M> | null = null;
  return {
    load: () =>
      (p ??= loader().then(
        (m) => (mod = m),
        (err) => {
          p = null; // allow a retry on the next use
          throw err;
        },
      )),
    peek: () => mod,
  };
}

/**
 * Runs `fn` with the module: synchronously when it is loaded, else after the chunk arrives.
 * With `typeahead`, characters typed while the chunk loads are replayed into whatever input `fn`
 * focuses (Ctrl+P right after launch, then typing a file name, must not leak into the editor).
 */
export function withModule<M>(l: Lazy<M>, fn: (m: M) => unknown, opts: { typeahead?: boolean } = {}): void | Promise<void> {
  const m = l.peek();
  if (m) {
    fn(m);
    // Even when loaded, the input only takes focus after the next render: bridge that gap too.
    if (opts.typeahead) holdKeys(Promise.resolve());
    return;
  }
  const p = l.load().then(
    (mod) => void fn(mod),
    (err) => {
      console.error(err);
      app.toast('Could not load this feature', 'error');
    },
  );
  if (opts.typeahead) holdKeys(p);
  return p;
}

const isTextInput = (el: Element | null): el is HTMLInputElement | HTMLTextAreaElement => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
const REPLAYED_KEYS = new Set(['Escape', 'Enter', 'ArrowDown', 'ArrowUp']);
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));

// One shared queue: overlapping holds (two shortcuts in a row) must never replay a key twice.
// Entries are runs of typed text or single control keys ("\0Escape").
let held: { queue: string[]; token: number; stop(): void } | null = null;

function insertText(target: Element | null, text: string) {
  if (isTextInput(target)) {
    target.setRangeText(text, target.selectionStart ?? target.value.length, target.selectionEnd ?? target.value.length, 'end');
    target.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
  } else if (target instanceof HTMLElement && target.isContentEditable) {
    document.execCommand('insertText', false, text); // nothing opened: the text belongs to the editor
  }
}

/**
 * Holds keys typed until `done` settles and whatever it opened has taken focus, then replays them
 * there in order: text into the focused input, Escape/Enter/arrows as key events. Without this,
 * keys typed in the few ms between a shortcut and its overlay mounting land in the editor or vanish.
 */
export function holdKeys(done: Promise<unknown>, maxWaitMs = 600): void {
  if (typeof window === 'undefined') return;
  const before = document.activeElement;
  if (!held) {
    const onKey = (e: KeyboardEvent) => {
      if (!held || !e.isTrusted || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      const q = held.queue;
      const last = q[q.length - 1];
      const text = last !== undefined && last[0] !== '\0';
      if (e.key.length === 1) {
        if (text) q[q.length - 1] = last + e.key;
        else q.push(e.key);
      } else if (e.key === 'Backspace' && text) {
        if (last.length > 1) q[q.length - 1] = last.slice(0, -1);
        else q.pop();
      } else if (REPLAYED_KEYS.has(e.key)) q.push(`\0${e.key}`);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    held = { queue: [], token: 0, stop: () => window.removeEventListener('keydown', onKey, true) };
  }
  const token = ++held.token; // the most recent hold decides where the keys go
  const release = async () => {
    // Drain in order; keys typed while we wait for a render keep queueing behind.
    for (let h = held; h && h.token === token && h.queue.length; h = held) {
      const item = h.queue.shift()!;
      const target = document.activeElement;
      if (item[0] !== '\0') {
        insertText(target, item);
        if (h.queue.length) await nextFrame(); // let the result list catch up before Enter / arrows
      } else {
        target?.dispatchEvent(new KeyboardEvent('keydown', { key: item.slice(1), bubbles: true, cancelable: true }));
        if (h.queue.length) await nextFrame();
      }
    }
    if (held?.token === token) {
      held.stop();
      held = null;
    }
  };
  void done.finally(() => {
    const t0 = performance.now();
    let frames = 0;
    let settled = false;
    const finish = () => {
      settled = true;
      window.removeEventListener('focusin', check, true);
    };
    // Checked on every focus change (no added latency once the input is there) and once per frame.
    function check(): boolean {
      if (settled) return true;
      if (held?.token !== token) return finish(), true; // superseded by a newer hold
      const el = document.activeElement;
      // Focus moved into what was opened → that is the target. An element that already had focus
      // counts after two frames (e.g. Mod-Shift-f pressed again inside the search box) — unless an
      // overlay just opened: its input takes focus a render later, and the old one must not win.
      const moved = !!el && el !== document.body && el !== before;
      if (!moved && !(frames >= 2 && isTextInput(el) && !app.overlay.value) && performance.now() - t0 <= maxWaitMs) return false;
      finish();
      void release();
      return true;
    }
    window.addEventListener('focusin', check, true);
    const poll = () => {
      if (check()) return;
      frames++;
      requestAnimationFrame(poll);
    };
    poll();
  });
}

/** A component that renders nothing until its chunk is loaded (sidebar panels, overlays). */
export type LazyComponent<P> = ComponentType<P> & {
  /** Resolve the chunk ahead of time; once settled, the component renders synchronously
   *  (no empty first frame → no layout jump when it pops in). */
  preload(): Promise<void>;
};

export function lazyComponent<P extends object = {}>(load: () => Promise<ComponentType<P>>): LazyComponent<P> {
  let Loaded: ComponentType<P> | null = null;
  const preload = () =>
    load().then((c) => {
      Loaded = c;
    });
  function LazyComponent(props: P) {
    const [, tick] = useState(0);
    // Whether THIS render had the component. preload() can resolve between a null render and its
    // effect; without a re-render that instance would stay empty for good.
    const renderedLoaded = Loaded !== null;
    useEffect(() => {
      if (Loaded) {
        if (!renderedLoaded) tick((n) => n + 1);
        return;
      }
      let alive = true;
      load().then(
        (c) => {
          Loaded = c;
          if (alive) tick((n) => n + 1);
        },
        (err) => console.error(err),
      );
      return () => {
        alive = false;
      };
    }, []);
    return Loaded ? <Loaded {...props} /> : null;
  }
  return Object.assign(LazyComponent, { preload });
}

/** Runs `fn` when the main thread is idle (first paint and session restore always win). */
export function onIdle(fn: () => void, timeout = 1500): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(fn, { timeout });
  else setTimeout(fn, 50);
}

/** Runs `fn` on idle once the app has booted (`app.ready`). */
export function afterBootIdle(fn: () => void, timeout?: number): void {
  if (app.ready.value) return onIdle(fn, timeout);
  const off = app.ready.subscribe((v) => {
    if (!v) return;
    queueMicrotask(() => off());
    onIdle(fn, timeout);
  });
}
