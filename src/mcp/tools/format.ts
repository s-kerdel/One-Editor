// Plain-text answers for every tool (read, search, links, and the write tools). Local models with small
// context windows read these best and cheapest: no JSON keys repeated per row, no escaped quotes.
//   first line  = a summary: `path · etag … · lines 1-40 of 300` (parts joined by " · ")
//   then        = rows (`  12: text`) or the raw file text, unescaped
//   last line   = a hint only when something was cut (`more: offset_line=41`)
// Errors stay one line, `CODE: message` (protocol.ts). Paths are folder-relative, never host paths.
import type { PropSchema, ToolResult } from '../protocol';

/** Joins the present parts of a summary line with " · " (false / null / '' are left out). */
export function line(...parts: Array<string | number | false | null | undefined>): string {
  return parts.filter((p) => p !== false && p !== null && p !== undefined && p !== '').join(' · ');
}

/** One text block: the lines joined with "\n". */
export function reply(...lines: Array<string | false | null | undefined>): ToolResult {
  return { content: [{ type: 'text', text: lines.filter((l): l is string => typeof l === 'string').join('\n') }] };
}

/** A summary line plus a body taken as is (file text: never escaped or re-indented). */
export function withBody(head: string, body: string): ToolResult {
  return { content: [{ type: 'text', text: `${head}\n${body}` }] };
}

export const etagPart = (etag: string) => `etag ${etag}`;

/** "1 file" / "3 files". */
export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Keeps leading rows while their text (plus newlines) stays within `budget` characters. */
export function fitRows(rows: readonly string[], budget: number): { rows: string[]; cut: boolean } {
  let used = 0;
  const out: string[] = [];
  for (const r of rows) {
    if (used + r.length + 1 > budget && out.length) return { rows: out, cut: true };
    used += r.length + 1;
    out.push(r);
  }
  return { rows: out, cut: false };
}

/** Keeps whole groups (a file and its lines) while within `budget`; a first group too big is cut by rows. */
export function fitGroups(groups: readonly string[][], budget: number): { rows: string[]; groups: number; cut: boolean } {
  let used = 0;
  const out: string[] = [];
  let n = 0;
  for (const g of groups) {
    const size = g.reduce((s, r) => s + r.length + 1, 0);
    if (used + size > budget) {
      if (!n) {
        const f = fitRows(g, budget);
        return { rows: f.rows, groups: 1, cut: true };
      }
      return { rows: out, groups: n, cut: true };
    }
    used += size;
    out.push(...g);
    n++;
  }
  return { rows: out, groups: n, cut: false };
}

/** One row of text from a file, on one line and bounded (snippets, link context). */
export function oneLine(s: string, max = 160): string {
  const t = s.replace(/[\r\n]+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// ---- parameters shared by the tools (short: they are sent to the model on every turn) -----------------

export const P = {
  folder: { type: 'string', description: 'Folder from list_folders.', maxLength: 64 },
  path: (what = 'File, e.g. notes/todo.md') => ({ type: 'string', description: `${what}.`, maxLength: 1024 }) satisfies PropSchema,
  limit: (def: string) => ({ type: 'integer', description: `Max ${def}.`, minimum: 1, maximum: 1000 }) satisfies PropSchema,
} satisfies Record<string, PropSchema | ((...a: never[]) => PropSchema)>;
