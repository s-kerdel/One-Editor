// Pure helpers of the PDF viewer (no DOM, no pdf.js): unit-tested in tests/unit/pdf/.
import { isExternalUrl } from '@shared/api';

export const isPdfPath = (p: string | null | undefined): boolean => !!p && /\.pdf$/i.test(p);

/** Zoom presets the Ctrl+± / Ctrl+wheel steps snap to (scale 1 = 100%). */
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
export const MIN_ZOOM = ZOOM_STEPS[0];
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

/** Next preset above (dir 1) / below (dir -1) `scale`; a scale between presets snaps to the neighbour. */
export function stepZoom(scale: number, dir: 1 | -1): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  const eps = 1e-3;
  if (dir > 0) return ZOOM_STEPS.find((s) => s > scale + eps) ?? MAX_ZOOM;
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < scale - eps) return ZOOM_STEPS[i];
  return MIN_ZOOM;
}

export const formatZoom = (scale: number) => `${Math.round(scale * 100)}%`;

/** Page typed in the "x / y" box → a valid 1-based page, or null when it is not a number. */
export function clampPage(input: string | number, numPages: number): number | null {
  const n = typeof input === 'number' ? input : Number(String(input).trim());
  if (!Number.isFinite(n) || numPages < 1) return null;
  return Math.min(numPages, Math.max(1, Math.round(n)));
}

/** `doc.pdf#page=3` (wikilink heading / URL fragment) → 3; anything else → null. */
export function pageFromFragment(frag: string | null | undefined): number | null {
  const m = /^#?page=(\d{1,6})$/i.exec((frag ?? '').trim());
  return m && Number(m[1]) >= 1 ? Number(m[1]) : null;
}

/**
 * What a click on a link in a rendered page does. pdf.js draws internal destinations as `#…` links
 * with their own click handler; everything else is an external URL that only an explicit click hands
 * to the app's safe external-open path (http/https/mailto only), never a navigation of the app window.
 */
export function classifyLink(href: string | null | undefined): 'internal' | 'external' | 'blocked' {
  if (!href) return 'internal'; // no href: pdf.js-handled action (named action, outline entry)
  if (href.startsWith('#')) return 'internal';
  return isExternalUrl(href) ? 'external' : 'blocked';
}
