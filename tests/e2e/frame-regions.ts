// Integrated window frame: what the OS will treat as "drag the window", computed the way Chromium and
// Electron do it, so tests can compare it with what the user sees.
//   Blink (LayoutObject::AddDraggableRegions): every visible LayoutBox whose (inherited) app-region is
//   drag / no-drag sends its FULL border box, in layout-tree order — never clipped by an ancestor's overflow.
//   Electron (shell/browser/ui/drag_util.cc): a point drags exactly when the last rect containing it is drag.
// So a box scrolled out of its container still cuts a no-drag hole wherever it lies (behind the shelf head, …).
import type { Page } from '@playwright/test';

export interface RegionReport {
  /** Points where the visible element says one thing and the window's hit-test region another. */
  mismatches: string[];
  /** Boxes with an app-region that reach outside what their scrolling / clipping ancestors show, over a drag area. */
  leaks: string[];
  /** How many drag / no-drag boxes Blink would send (sanity check: the frame really is integrated). */
  regions: { drag: number; noDrag: number };
  /** For each of `opts.probes`: would a press there drag the window? */
  probes: boolean[];
}

/** Emulates the window's drag region and checks it against the page (sampled every `step` CSS px). */
export function appRegionReport(page: Page, opts: { step?: number; probes?: Array<{ x: number; y: number }> } = {}): Promise<RegionReport> {
  return page.evaluate(({ step, probes }) => {
    const modes = new Map<Element, string>();
    const mode = (el: Element) => {
      let m = modes.get(el);
      if (m === undefined) {
        const cs = getComputedStyle(el);
        m = (cs.getPropertyValue('app-region') || cs.getPropertyValue('-webkit-app-region') || 'none').trim();
        modes.set(el, m);
      }
      return m;
    };
    const describe = (el: Element) => {
      const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).join('.') : '';
      const p = el.getAttribute('data-path');
      return `${el.localName}${cls}${p ? `[data-path="${p}"]` : ''}`;
    };
    // Replaced elements are boxes even when display: inline; other inline elements (LayoutInline) send nothing.
    const REPLACED = new Set(['img', 'svg', 'video', 'canvas', 'iframe', 'input', 'select', 'textarea', 'button', 'object', 'embed']);
    type Box = { el: Element; drag: boolean; l: number; t: number; r: number; b: number };
    const boxes: Box[] = [];
    for (const el of document.querySelectorAll('*')) {
      const m = mode(el);
      if (m !== 'drag' && m !== 'no-drag') continue;
      if (el instanceof SVGElement && el.ownerSVGElement) continue; // SVG content: not a LayoutBox
      const cs = getComputedStyle(el);
      if (cs.visibility !== 'visible' || cs.display === 'none' || cs.display === 'contents') continue;
      if (cs.display === 'inline' && !REPLACED.has(el.localName)) continue;
      if (!el.getClientRects().length) continue;
      const r = el.getBoundingClientRect();
      boxes.push({ el, drag: m === 'drag', l: r.left, t: r.top, r: r.right, b: r.bottom });
    }
    const inside = (b: Box, x: number, y: number) => x >= b.l && x < b.r && y >= b.t && y < b.b;
    // Electron's rule: the last box containing a point decides.
    const lastBoxAt = (x: number, y: number) => {
      let last: Box | null = null;
      for (const b of boxes) if (inside(b, x, y)) last = b;
      return last;
    };
    const drags = boxes.filter((b) => b.drag && b.r > b.l && b.b > b.t);

    // The OS controls (Window Controls Overlay) take their own clicks: nothing of ours matters under them.
    const wco = (navigator as any).windowControlsOverlay;
    const ctl = wco?.visible ? (wco.getTitlebarAreaRect() as DOMRect) : null;
    const underControls = (x: number, y: number) => !!ctl && x >= ctl.x + ctl.width && y < ctl.y + ctl.height;

    // 1. Sampled points: drag-ness of the window region vs. the app-region of the element actually shown there.
    // Hit-testing follows rounded corners, the region doesn't: a mismatch only counts if it also holds
    // 1.5px away in all four directions (a real hole is wider than an anti-aliased corner).
    const verdict = (x: number, y: number) => {
      const last = lastBoxAt(x, y);
      const shown = document.elementFromPoint(x, y);
      const expected = !!shown && mode(shown) === 'drag';
      if (!!last?.drag === expected) return null;
      return expected
        ? `dead drag spot: ${shown ? describe(shown) : '?'} looks draggable, but no-drag ${last ? describe(last.el) : '(nothing)'} lies on it`
        : `stolen click: ${shown ? describe(shown) : '?'} (${shown ? mode(shown) : '?'}) is under drag ${describe(last!.el)}`;
    };
    const seen = new Set<number>();
    const tally = new Map<string, { n: number; x: number; y: number }>();
    const W = innerWidth;
    for (const d of drags) {
      for (let y = Math.max(0, Math.ceil(d.t / step) * step); y < Math.min(innerHeight, d.b); y += step) {
        for (let x = Math.max(0, Math.ceil(d.l / step) * step); x < Math.min(W, d.r); x += step) {
          const key = y * W + x;
          if (seen.has(key)) continue;
          seen.add(key);
          const px = x + 0.5;
          const py = y + 0.5;
          if (underControls(px, py)) continue;
          const what = verdict(px, py);
          if (!what || [[-1.5, 0], [1.5, 0], [0, -1.5], [0, 1.5]].some(([dx, dy]) => verdict(px + dx, py + dy) !== what)) continue;
          const t = tally.get(what);
          if (t) t.n += step * step;
          else tally.set(what, { n: step * step, x: px, y: py });
        }
      }
    }
    const mismatches = [...tally].sort((a, b) => b[1].n - a[1].n).map(([w, t]) => `${w} (~${t.n} px², e.g. at ${t.x},${t.y})`);

    // 2. Boxes outside their visible area: the part a clipping ancestor hides must not overlap a drag box.
    const leaks: string[] = [];
    for (const b of boxes) {
      let l = 0, t = 0, r = W, bt = innerHeight;
      // Walk the containing-block chain: positioned boxes escape some clipping ancestors.
      let escape: 'none' | 'abs' | 'fixed' = 'none';
      for (let e = b.el.parentElement, child: Element = b.el; e; child = e, e = e.parentElement) {
        const ccs = getComputedStyle(child);
        if (ccs.position === 'fixed') escape = 'fixed';
        else if (ccs.position === 'absolute' && escape === 'none') escape = 'abs';
        const cs = getComputedStyle(e);
        const makesCb = cs.transform !== 'none' || cs.filter !== 'none' || /paint|layout|strict|content/.test(cs.contain);
        if (escape === 'fixed' && !makesCb) continue;
        if (escape === 'abs' && cs.position === 'static' && !makesCb) continue;
        escape = 'none';
        const cx = cs.overflowX !== 'visible';
        const cy = cs.overflowY !== 'visible';
        if (!cx && !cy) continue;
        const er = e.getBoundingClientRect();
        if (cx) (l = Math.max(l, er.left + e.clientLeft)), (r = Math.min(r, er.left + e.clientLeft + e.clientWidth));
        if (cy) (t = Math.max(t, er.top + e.clientTop)), (bt = Math.min(bt, er.top + e.clientTop + e.clientHeight));
      }
      // Hidden parts of the box (up to four bands around the visible rect), 1px slack for rounding.
      const parts = [
        { l: b.l, t: b.t, r: Math.min(b.r, l - 1), b: b.b },
        { l: Math.max(b.l, r + 1), t: b.t, r: b.r, b: b.b },
        { l: b.l, t: b.t, r: b.r, b: Math.min(b.b, t - 1) },
        { l: b.l, t: Math.max(b.t, bt + 1), r: b.r, b: b.b },
      ].filter((p) => p.r > p.l && p.b > p.t);
      const over = drags.find((d) => d.el !== b.el && parts.some((p) => Math.min(p.r, d.r) - Math.max(p.l, d.l) > 1 && Math.min(p.b, d.b) - Math.max(p.t, d.t) > 1));
      if (over) leaks.push(`${b.drag ? 'drag' : 'no-drag'} ${describe(b.el)} reaches outside its visible area, over drag ${describe(over.el)}`);
    }
    return {
      mismatches,
      leaks,
      regions: { drag: drags.length, noDrag: boxes.filter((b) => !b.drag).length },
      probes: probes.map((p) => !!lastBoxAt(p.x, p.y)?.drag),
    };
  }, { step: opts.step ?? 2, probes: opts.probes ?? [] });
}

/** Browser mode: render as the integrated-frame desktop window does (same CSS; the class is all it takes). */
export async function forceIntegratedFrame(page: Page) {
  await page.evaluate(() => {
    const s = (window as any).__secEdit;
    s.backend.frame = 'integrated';
    s.settings.value = { ...s.settings.value }; // re-render the layout with the frame class
  });
  await page.locator('.se-root.frame-integrated').waitFor();
}

/** Opens `paths` as tabs, in order (each opens right of the previous). */
export async function openTabs(page: Page, paths: string[]) {
  await page.evaluate(async (list) => {
    for (const p of list) await (window as any).__secEdit.openFile(p);
  }, paths);
}

/** Scrolls the tab strip to a fraction of its overflow (0 = start, 1 = end) and waits for the next frame. */
export async function scrollTabs(page: Page, at: number) {
  return page.evaluate(async (at) => {
    const strip = document.querySelector<HTMLElement>('.se-tabs')!;
    strip.scrollLeft = Math.round((strip.scrollWidth - strip.clientWidth) * at);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { scrollLeft: strip.scrollLeft, overflow: strip.scrollWidth - strip.clientWidth };
  }, at);
}

/** Markdown files for a long tab strip (written into the test's own workspace copy). */
export const manyNotes = (n: number) => Array.from({ length: n }, (_, i) => `many/tab-note-${String(i + 1).padStart(2, '0')}.md`);
