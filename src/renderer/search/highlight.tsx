// Render text with highlighted character positions (fuzzy) or ranges (full-text hits).
import type { ComponentChildren } from 'preact';
import type { MatchRange } from '../../search/types';

export function HighlightPositions({ text, positions, offset = 0 }: { text: string; positions: number[]; offset?: number }) {
  if (!positions.length) return <>{text}</>;
  const set = new Set(positions.map((p) => p - offset).filter((p) => p >= 0 && p < text.length));
  if (!set.size) return <>{text}</>;
  const out: ComponentChildren[] = [];
  let buf = '';
  let on = false;
  const flush = () => {
    if (!buf) return;
    out.push(on ? <mark class="se-fz">{buf}</mark> : buf);
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    const h = set.has(i);
    if (h !== on) {
      flush();
      on = h;
    }
    buf += text[i];
  }
  flush();
  return <>{out}</>;
}

export function HighlightRanges({ text, ranges, cls = 'se-hit' }: { text: string; ranges: MatchRange[]; cls?: string }) {
  if (!ranges.length) return <>{text}</>;
  const out: ComponentChildren[] = [];
  let pos = 0;
  for (const r of ranges) {
    if (r.start < pos) continue;
    if (r.start > pos) out.push(text.slice(pos, r.start));
    out.push(<mark class={cls}>{text.slice(r.start, r.end)}</mark>);
    pos = r.end;
  }
  if (pos < text.length) out.push(text.slice(pos));
  return <>{out}</>;
}
