// MCP resources: the files of the shared folders as one://<folder>/<path> (each path segment URI-encoded),
// so clients can attach a note (Claude Code's @ mentions). Reading decodes the segments and hands the path
// to the same resolver as every tool (folders.ts): "%2e%2e" decodes to ".." and is refused there.
import { isMarkdown } from '../shared/paths';
import type { McpLimits } from '../shared/mcp';
import type { FolderPool } from './folders';
import { ToolError, type CallContext, type ResourceProvider } from './protocol';

const PAGE = 200;
/** Resources are attached by the user, not paged by a model: a larger cap than tool reads. */
const MAX_RESOURCE_CHARS = 1024 * 1024;
export const SCHEME = 'one://';

export const resourceUri = (folder: string, rel: string) => `${SCHEME}${folder}/${rel.split('/').map(encodeURIComponent).join('/')}`;

export function parseResourceUri(uri: string): { folder: string; path: string } {
  if (!uri.startsWith(SCHEME) || uri.length > 4096) throw new ToolError('EINVAL', 'Not a one:// resource');
  const rest = uri.slice(SCHEME.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) throw new ToolError('EINVAL', 'Expected one://<folder>/<path>');
  try {
    return { folder: decodeURIComponent(rest.slice(0, slash)), path: rest.slice(slash + 1).split('/').map(decodeURIComponent).join('/') };
  } catch {
    throw new ToolError('EINVAL', 'Malformed resource address');
  }
}

export class Resources implements ResourceProvider {
  constructor(
    private readonly pool: FolderPool,
    private readonly limits: () => McpLimits,
  ) {}

  templates() {
    return [{ uriTemplate: `${SCHEME}{folder}/{+path}`, name: 'file', title: 'File in a shared folder', description: 'A text file of a folder shared in One (see list_folders).', mimeType: 'text/plain' }];
  }

  async list(cursor: string | undefined) {
    const m = /^(\d+):(\d+)$/.exec(cursor ?? '0:0');
    if (!m) throw new ToolError('EINVAL', 'Unknown cursor');
    let fi = Number(m[1]);
    let off = Number(m[2]);
    const folders = this.pool.list();
    const resources: unknown[] = [];
    while (fi < folders.length && resources.length < PAGE) {
      const f = folders[fi];
      const paths = await f.use(() => f.filePaths()).catch(() => [] as string[]);
      paths.sort();
      const take = paths.slice(off, off + PAGE - resources.length);
      for (const p of take) resources.push({ uri: resourceUri(f.alias, p), name: `${f.alias}/${p}`, mimeType: isMarkdown(p) ? 'text/markdown' : 'text/plain' });
      off += take.length; // what was taken, not a page: the next page starts right after it
      if (off >= paths.length) {
        fi++;
        off = 0;
      }
    }
    return { resources, ...(fi < folders.length ? { nextCursor: `${fi}:${off}` } : {}) };
  }

  async read(uri: string, _ctx: CallContext) {
    const { folder, path } = parseResourceUri(uri);
    const f = this.pool.get(folder);
    const file = await f.use(() => f.readText(path));
    if (file.binary) throw new ToolError('EINVAL', `Binary file: ${file.path}`);
    const max = Math.max(this.limits().readChars, MAX_RESOURCE_CHARS);
    const text = file.content.length > max ? `${file.content.slice(0, max)}\n[… cut: the file is longer than ${Math.round(max / 1024)} kB; use read_file with offset_line for the rest]` : file.content;
    return { contents: [{ uri, mimeType: isMarkdown(file.path) ? 'text/markdown' : 'text/plain', text }] };
  }
}
