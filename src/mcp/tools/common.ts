// Shared pieces of the tool definitions: the `folder` parameter, compact JSON answers, size budgets.
// Answers are sized for small context windows: every list has a row limit (mcp.maxResults) and every
// answer a character budget (mcp.maxReadKB); what does not fit is cut with `truncated` / a cursor.
import type { Settings } from '../../shared/api';
import type { McpLimits } from '../../shared/mcp';
import type { FolderPool, Folder } from '../folders';
import type { Journal } from '../journal';
import { ToolError, type PropSchema, type TextContent, type ToolAnnotations, type ToolResult } from '../protocol';

export interface ToolEnv {
  pool: FolderPool;
  limits(): McpLimits;
  /** How long a search / link call waits for a first index build before answering partially. */
  indexWaitMs: number;
  settings(): Settings;
  /** Undo history of writes (Settings → MCP server → Revert). */
  journal: Journal;
  /** Moves a file or folder to the Recycle Bin / trash; throws when there is none (never deletes for good). */
  trash(abs: string, o?: import('../../backend/trash').TrashOptions): Promise<void>;
  /** Write calls of this session (count and rate). */
  quota: import('../writes').WriteQuota;
}

export const folderParam: PropSchema = { type: 'string', description: 'Folder name from list_folders. Leave out when only one folder is shared.', maxLength: 64 };
export const pathParam = (what: string): PropSchema => ({ type: 'string', description: `${what} Relative to the folder, "/" between parts (e.g. notes/todo.md).`, maxLength: 1024 });
export const limitParam = (what: string): PropSchema => ({ type: 'integer', description: `Most ${what} to return (default and maximum set in One; usually 25).`, minimum: 1, maximum: 1000 });

export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const json = (o: unknown): TextContent => ({ type: 'text', text: JSON.stringify(o) });
export const ok = (...content: TextContent[]): ToolResult => ({ content });

/** The `limit` argument, capped by Settings → MCP server → Results per call. */
export function rowLimit(env: ToolEnv, asked: unknown, fallback?: number): number {
  const max = env.limits().results;
  const n = typeof asked === 'number' ? asked : (fallback ?? max);
  return Math.max(1, Math.min(max, n));
}

/** Keeps leading items while the JSON of all kept items stays within `budget` characters. */
export function fit<T>(items: readonly T[], budget: number): { items: T[]; cut: boolean } {
  let used = 2;
  const out: T[] = [];
  for (const it of items) {
    const n = JSON.stringify(it).length + 1;
    if (used + n > budget && out.length) return { items: out, cut: true };
    used += n;
    out.push(it);
  }
  return { items: out, cut: false };
}

export async function inFolder<T>(env: ToolEnv, args: Record<string, unknown>, fn: (f: Folder) => Promise<T>): Promise<T> {
  const f = env.pool.get(args.folder);
  return f.use(() => fn(f));
}

/** Lines of `text` from `from` (0-based) while within `maxChars`; a single huge line is cut. */
export function takeLines(lines: readonly string[], from: number, maxLines: number, maxChars: number): { text: string; end: number; lineCut: boolean } {
  let used = 0;
  let i = from;
  const out: string[] = [];
  let lineCut = false;
  for (; i < lines.length && out.length < maxLines; i++) {
    const l = lines[i];
    if (used + l.length + 1 > maxChars) {
      if (!out.length) {
        out.push(l.slice(0, Math.max(0, maxChars - 1)));
        lineCut = true;
        i++;
      }
      break;
    }
    used += l.length + 1;
    out.push(l);
  }
  return { text: out.join('\n'), end: i, lineCut };
}

export function etagOf(f: { mtime: number; size: number }): string {
  return `${f.mtime}-${f.size}`;
}

export const notMarkdown = (p: string) => new ToolError('EINVAL', `Not a Markdown note: ${p} (links, sections and tags exist in .md files)`);
