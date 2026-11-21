// Overview panel plumbing: live document text (debounced), cursor-driven highlight without
// re-rendering on every cursor move, roving keyboard focus for the lists. Section state: ./sections.
import type { RefObject } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ReadonlySignal } from '@preact/signals';
import type { KnowledgeApi } from '../../knowledge/index';
import { app } from '../app/app';
import * as ui from '../app/ui';
import { loadKnowledge } from '../knowledge';

// ---------------------------------------------------------------- live document

/**
 * The active document's current text. Re-renders on open / reload / save at once, and on typing
 * after a short debounce (longer for huge notes) so a keystroke never waits for a rescan.
 * `refresh()` skips the debounce (after the panel itself edited the doc, e.g. a task toggle).
 */
export function useLiveContent(path: string | null): { content: string | null; refresh(): void } {
  const [, bump] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!path) return;
    const now = (p: string) => {
      if (p !== path) return;
      clearTimeout(timer.current);
      bump((n) => n + 1);
    };
    const later = (p: string) => {
      if (p !== path) return;
      clearTimeout(timer.current);
      const size = app.docs.get(path)?.content.length ?? 0;
      timer.current = setTimeout(() => bump((n) => n + 1), size > 300_000 ? 400 : 150);
    };
    const offs = [app.events.on('doc:changed', later), app.events.on('doc:opened', now), app.events.on('doc:saved', now), app.events.on('file:updated', now)];
    return () => {
      clearTimeout(timer.current);
      offs.forEach((o) => o());
    };
  }, [path]);
  const doc = path ? app.docs.get(path) : undefined;
  return {
    content: doc ? (doc.content ?? null) : null,
    refresh: () => {
      clearTimeout(timer.current);
      bump((n) => n + 1);
    },
  };
}

// ---------------------------------------------------------------- cursor

/**
 * `derive(cursorLine)` evaluated now, and again on every cursor move — but the component only
 * re-renders when the derived value changes (e.g. the cursor entered another section).
 */
export function useCursorDerived<T>(derive: (line: number) => T): T {
  const fn = useRef(derive);
  fn.current = derive;
  const last = useRef<T | undefined>(undefined);
  const [, force] = useState(0);
  const value = derive(ui.cursorInfo.peek()?.line ?? -1);
  last.current = value;
  useEffect(
    () =>
      ui.cursorInfo.subscribe((c) => {
        const v = fn.current(c?.line ?? -1);
        if (v !== last.current) {
          last.current = v;
          force((n) => n + 1);
        }
      }),
    [],
  );
  return value;
}

// ---------------------------------------------------------------- knowledge index

export type Knowledge = KnowledgeApi & { changed: ReadonlySignal<number>; isBuilding(): boolean };

/** The link index (`app.knowledge`) once its chunk is loaded; re-renders when the index changes. */
export function useKnowledge(): Knowledge | null {
  const k = (app as { knowledge?: Knowledge }).knowledge;
  const [, bump] = useState(0);
  useEffect(() => {
    if (!k) void loadKnowledge().then(() => bump((n) => n + 1), () => {});
  }, [!!k]);
  if (k) void k.changed.value; // subscribe
  return k ?? null;
}

// ---------------------------------------------------------------- keyboard: roving focus

/** Scrolls the panel body (only) so `el` is visible — scrollIntoView would also nudge the app's own
 *  overflow:hidden containers. */
export function keepInView(el: HTMLElement, margin = 8) {
  const scroller = el.closest<HTMLElement>('.se-ov-body');
  if (!scroller) return;
  const s = scroller.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (r.top < s.top + margin) scroller.scrollTop -= s.top + margin - r.top;
  else if (r.bottom > s.bottom - margin) scroller.scrollTop += r.bottom - (s.bottom - margin);
}

const rowsOf = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLElement>('[data-row]'));

/**
 * One tab stop per list (the last focused row, else the highlighted one, else the first);
 * ↑/↓/Home/End move between rows, Enter activates. `onKey` handles anything else (→/← in trees,
 * Space on tasks) and returns true when it consumed the key.
 */
export function useRoving(ref: RefObject<HTMLElement | null>, onKey?: (e: KeyboardEvent, row: HTMLElement, index: number) => boolean | void) {
  const st = useRef({ key: null as string | null, refocus: -1 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rows = rowsOf(el);
    if (!rows.length) return;
    const s = st.current;
    let stop = (s.key && rows.find((r) => r.dataset.key === s.key)) || el.querySelector<HTMLElement>('[data-row].is-active') || rows[0];
    // The focused row went away (a toggled task left the list): keep the keyboard user in place.
    if (s.refocus >= 0 && !el.contains(document.activeElement)) {
      stop = rows[Math.min(s.refocus, rows.length - 1)];
      stop.focus({ preventScroll: true });
      keepInView(stop);
    }
    s.refocus = -1;
    for (const r of rows) r.tabIndex = r === stop ? 0 : -1;
  });
  return {
    onFocusIn(e: FocusEvent) {
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-row]');
      if (!row || !ref.current) return;
      st.current.key = row.dataset.key ?? null;
      for (const r of rowsOf(ref.current)) r.tabIndex = r === row ? 0 : -1;
    },
    onKeyDown(e: KeyboardEvent) {
      const el = ref.current;
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-row]');
      if (!el || !row || e.altKey || e.metaKey) return;
      const rows = rowsOf(el);
      const i = rows.indexOf(row);
      let next = -1;
      if (e.ctrlKey) {
        if (onKey?.(e, row, i)) e.preventDefault();
        return;
      }
      if (e.key === 'ArrowDown') next = Math.min(i + 1, rows.length - 1);
      else if (e.key === 'ArrowUp') next = Math.max(i - 1, 0);
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = rows.length - 1;
      else if (onKey?.(e, row, i)) {
        e.preventDefault();
        return;
      } else if (e.key === 'Enter') {
        e.preventDefault();
        row.click();
        return;
      } else return;
      e.preventDefault();
      rows[next].focus({ preventScroll: true });
      keepInView(rows[next]);
    },
    /** Call before an action that may remove the focused row. */
    refocusAt(index: number) {
      st.current.refocus = index;
    },
  };
}
