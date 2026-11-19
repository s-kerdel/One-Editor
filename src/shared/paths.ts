// POSIX-style workspace-relative path helpers usable in both renderer and Node.

export function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

export function extname(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i).toLowerCase();
}

export function stem(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? b : b.slice(0, i);
}

export function join(...parts: string[]): string {
  return normalize(parts.filter(Boolean).join('/'));
}

/** Collapses '.', '..', duplicate and back-slashes. Never returns a leading slash. */
export function normalize(p: string): string {
  const out: string[] = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

export function isMarkdown(p: string): boolean {
  const e = extname(p);
  return e === '.md' || e === '.markdown' || e === '.mdx';
}
