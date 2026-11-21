// Text edits behind the write tools. Pure: LF text in → LF text out (or a ToolError the model can act
// on). Section ranges come from the knowledge document map (code fences and frontmatter never count as
// headings or blocks), so a patch lands where read_section reads.
import { documentMap, findBlock, findSection, type DocumentMap } from '../knowledge/sections';
import { parseFrontmatter } from '../knowledge/extract';
import { ToolError } from './protocol';

export type PatchOp = 'append' | 'prepend' | 'replace' | 'delete';
export type PatchTarget = { heading: string } | { block: string } | { frontmatter_key: string };

const lines = (text: string) => text.split('\n');
const trimEndNl = (s: string) => s.replace(/\n+$/, '');

/** append_file: at the end, or at the start (after the frontmatter). Keeps one newline between. */
export function appendText(text: string, add: string, position: 'end' | 'start'): string {
  const body = trimEndNl(add);
  if (position === 'end') {
    if (!text) return `${body}\n`;
    return `${text}${text.endsWith('\n') ? '' : '\n'}${body}\n`;
  }
  const fm = documentMap(text).frontmatter;
  const ls = lines(text);
  const at = fm ? fm.end + 1 : 0;
  ls.splice(at, 0, ...lines(body));
  return ls.join('\n');
}

/** replace_text: exactly one occurrence of `old`, or a ToolError saying how many there are. */
export function replaceUnique(text: string, old: string, next: string): string {
  if (!old) throw new ToolError('EINVAL', '"old" is empty');
  const first = text.indexOf(old);
  if (first === -1) throw new ToolError('ENOMATCH', 'The text in "old" was not found (it must match exactly, including spaces and line breaks). Read the file again and copy the text.');
  const second = text.indexOf(old, first + 1);
  if (second !== -1) {
    let n = 2;
    for (let i = text.indexOf(old, second + 1); i !== -1; i = text.indexOf(old, i + 1)) n++;
    throw new ToolError('EAMBIGUOUS', `The text in "old" occurs ${n} times. Add surrounding text to "old" so it matches exactly once.`);
  }
  return text.slice(0, first) + next + text.slice(first + old.length);
}

/** patch_file: one operation on one heading section, block or frontmatter key. */
export function patchText(text: string, target: PatchTarget, op: PatchOp, content: string, o: { createTarget?: boolean } = {}): string {
  const map = documentMap(text);
  if ('frontmatter_key' in target) return patchFrontmatter(text, map, target.frontmatter_key.trim(), op, content, !!o.createTarget);
  const ls = lines(text);
  const add = lines(trimEndNl(content));
  if ('block' in target) {
    const b = findBlock(map, target.block);
    if (!b) throw new ToolError('ENOENT', `No block "${target.block.slice(0, 100)}"${map.blocks.length ? `. Blocks: ${map.blocks.slice(0, 30).map((x) => `^${x.id}`).join(', ')}` : ''}`);
    const end = Math.max(b.end, b.line);
    if (op === 'append') ls.splice(end + 1, 0, ...add);
    else if (op === 'prepend') ls.splice(b.start, 0, ...add);
    else if (op === 'delete') ls.splice(b.start, end - b.start + 1);
    else {
      // Keep the block id, so links to ^id keep working.
      const next = [...add];
      if (!next.some((l) => new RegExp(`(^|\\s)\\^${escapeRe(b.id)}\\s*$`).test(l))) {
        if (b.line !== b.end && /^\s*\^[A-Za-z0-9-]+\s*$/.test(ls[b.line])) next.push(ls[b.line]);
        else next[next.length - 1] = `${next[next.length - 1]} ^${b.id}`;
      }
      ls.splice(b.start, end - b.start + 1, ...next);
    }
    return ls.join('\n');
  }
  const path = target.heading.split(' > ').map((s) => s.trim()).filter(Boolean);
  const h = findSection(map, path);
  if (!h) {
    if (!o.createTarget || op === 'delete') throw new ToolError('ENOENT', `No heading "${target.heading.slice(0, 200)}"${map.headings.length ? `. Headings: ${map.headings.slice(0, 30).map((x) => x.text).join(' | ')}` : ''} (create_target: true adds it)`);
    return createHeading(text, map, path, add);
  }
  if (op === 'prepend') ls.splice(h.line + 1, 0, ...add);
  else if (op === 'append') ls.splice(h.end + 1, 0, ...add);
  else if (op === 'replace') ls.splice(h.line + 1, h.end - h.line, ...add);
  else {
    let end = h.end;
    while (end + 1 < ls.length && !ls[end + 1].trim()) end++; // the blank lines that separated it go too
    ls.splice(h.line, end - h.line + 1);
  }
  return ls.join('\n');
}

/** A missing heading: under its deepest existing parent (at the end of that section), else at the end. */
function createHeading(text: string, map: DocumentMap, path: string[], add: string[]): string {
  let parent: ReturnType<typeof findSection> = null;
  let found = 0;
  for (let i = path.length - 1; i > 0 && !parent; i--) {
    parent = findSection(map, path.slice(0, i));
    found = i;
  }
  // Every missing level is created, one level below the previous.
  const base = parent ? parent.level + 1 : 2;
  const missing = path.slice(parent ? found : 0);
  const heads = missing.map((p, i) => `${'#'.repeat(Math.min(6, base + i))} ${p}`);
  if (parent) {
    const ls = lines(text);
    ls.splice(parent.end + 1, 0, '', ...heads, ...add);
    return ls.join('\n');
  }
  const body = trimEndNl(text);
  return `${body}${body ? '\n\n' : ''}${[...heads, ...add].join('\n')}\n`;
}

function patchFrontmatter(text: string, map: DocumentMap, key: string, op: PatchOp, content: string, create: boolean): string {
  if (!/^[A-Za-z0-9_][\w .-]*$/.test(key)) throw new ToolError('EINVAL', `Not a frontmatter key: ${key.slice(0, 60)}`);
  const value = content.trim();
  if (op !== 'delete' && /\n/.test(value)) throw new ToolError('EINVAL', 'Frontmatter values are one line (use [a, b] for a list)');
  const ls = lines(text);
  const fm = map.frontmatter;
  const k = fm?.keys.find((x) => x.key.toLowerCase() === key.toLowerCase());
  if (!k) {
    if (op === 'delete') throw new ToolError('ENOENT', `No frontmatter key "${key}"`);
    if (!create && op !== 'replace') throw new ToolError('ENOENT', `No frontmatter key "${key}" (create_target: true adds it)`);
    const line = op === 'replace' ? `${key}: ${value}` : `${key}:\n  - ${value}`;
    if (!fm) return `---\n${line}\n---\n${text}`;
    ls.splice(fm.end, 0, ...line.split('\n'));
    return ls.join('\n');
  }
  if (op === 'delete') {
    ls.splice(k.line, k.end - k.line + 1);
    return ls.join('\n');
  }
  if (op === 'replace') {
    ls.splice(k.line, k.end - k.line + 1, `${k.key}: ${value}`);
    return ls.join('\n');
  }
  // append / prepend: one item to a list (a scalar or [a, b] becomes a block list).
  const cur = parseFrontmatter(ls.slice(k.line, k.end + 1))[k.key];
  const items = Array.isArray(cur) ? cur.map((x) => String(x ?? '')) : cur === null || cur === undefined || cur === '' ? [] : [String(cur)];
  if (op === 'append') items.push(value);
  else items.unshift(value);
  ls.splice(k.line, k.end - k.line + 1, `${k.key}:`, ...items.map((x) => `  - ${x}`));
  return ls.join('\n');
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
