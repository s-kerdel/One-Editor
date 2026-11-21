// Write tools: listed only while some shared folder is read-write (ToolDef.write); each refuses a read-only
// folder itself (Folder.checkWritable, and again in the commit guard). Every path goes through
// Folder.resolveTarget; every change lands through writes.ts (Workspace write path + guard + journal) and the
// placeholder rules (placeholders.ts). Answers are one plain line: what changed, the new etag, the undo id.
import fs from 'node:fs';
import path from 'node:path';
import { toLf } from '../../backend/textcodec';
import { isMarkdown } from '../../shared/paths';
import { applyEdits, createRenameRewriter } from '../../knowledge/rename';
import { appendText, patchText, replaceUnique, type PatchTarget } from '../edits';
import type { Folder } from '../folders';
import { checkPlaceholderPolicy, isVarsFile } from '../placeholders';
import { ToolError, type ToolAnnotations, type ToolDef, type ToolResult } from '../protocol';
import { MAX_EDIT_BYTES, MAX_MOVE_ENTRIES, MAX_WRITE_BYTES, checkEtag, checkSize, create, etagOf, makeDir, move, overwrite, parseEtag, scopeAt, trashFile, writeError, type WriteCtx } from '../writes';
import type { ToolEnv } from './common';
import { P, etagPart, line } from './format';
import { readyIndex } from './search';

const ann = (destructive: boolean): ToolAnnotations => ({ readOnlyHint: false, destructiveHint: destructive, idempotentHint: false, openWorldHint: false });
const etagParam = { type: 'string' as const, description: 'etag from read_file: change only if unchanged since.', maxLength: 40 };
/** One plain line: what changed · new etag · undo id (the history group; Revert is in One's Settings). */
const done = (what: string, etag?: string | null, journal?: string, ...more: string[]): ToolResult => ({
  content: [{ type: 'text', text: line(what, etag && etagPart(etag), ...more, journal && `undo: ${journal.slice(-8)}`) }],
  journal,
});

async function inWritable<T>(env: ToolEnv, args: Record<string, unknown>, client: string, tool: string, fn: (f: Folder, c: WriteCtx) => Promise<T>): Promise<T> {
  const f = env.pool.get(args.folder);
  f.checkWritable(); // and again inside the Workspace slot right before the disk changes (Folder.guard)
  env.quota.take();
  const varsFile = String(env.settings()['variables.fileName'] ?? '').trim() || 'variables.md';
  return f.use(() => fn(f, { folder: f, journal: env.journal, client, tool, trash: env.trash, varsFile }));
}

function oneTarget(a: Record<string, unknown>): PatchTarget {
  const which = (['heading', 'block', 'frontmatter_key'] as const).filter((k) => typeof a[k] === 'string' && (a[k] as string).trim());
  if (which.length !== 1) throw new ToolError('EINVAL', 'Pass exactly one of: heading, block, frontmatter_key');
  const k = which[0];
  return k === 'heading' ? { heading: a.heading as string } : k === 'block' ? { block: a.block as string } : { frontmatter_key: a.frontmatter_key as string };
}

export function writeTools(env: ToolEnv): ToolDef[] {
  return [
    {
      name: 'write_file',
      title: 'Write a file',
      description: 'Create a note, or replace a whole file (pass if_match). Prefer replace_text / patch_file / append_file for small changes.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: P.folder,
          path: P.path('File path, e.g. notes/todo.md'),
          content: { type: 'string', description: 'Complete new text.', maxLength: MAX_WRITE_BYTES },
          if_match: etagParam,
          if_none_match: { type: 'string', description: '"*" = create only.', enum: ['*'] },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      annotations: ann(true),
      write: true,
      run: (a, ctx) =>
        inWritable(env, a, ctx.client, 'write_file', async (f, c) => {
          const want = parseEtag(a.if_match);
          if (want && a.if_none_match === '*') throw new ToolError('EINVAL', 'Pass if_match or if_none_match, not both');
          checkSize(String(a.content), MAX_WRITE_BYTES);
          const text = toLf(String(a.content));
          const t = await f.resolveTarget(a.path, { kind: 'file', exists: 'may' });
          if (!t.st) {
            if (want) throw new ToolError('ENOENT', `${t.key} does not exist (deleted or moved since you read it?)`);
            const r = await create(c, t, text);
            return done(`Created ${t.key}`, r.etag, r.journal);
          }
          if (a.if_none_match === '*' || !want) throw new ToolError('EEXIST', `${t.key} exists: pass if_match (its etag from read_file) to replace it.`);
          checkEtag(t.key, t.st, want);
          const read = await f.readText(t.key);
          checkEtag(t.key, { mtimeMs: read.mtime, size: read.size }, want);
          const r = await overwrite(c, t, read, text, 'write');
          return done(`Saved ${t.key}`, r.etag, r.journal);
        }),
    },
    {
      name: 'append_file',
      title: 'Add to a file',
      description: 'Add text at the end of a file, or at the start (after the frontmatter).',
      inputSchema: {
        type: 'object',
        properties: {
          folder: P.folder,
          path: P.path('File path'),
          content: { type: 'string', description: 'Text to add.', maxLength: MAX_EDIT_BYTES },
          position: { type: 'string', description: 'end (default) or start.', enum: ['end', 'start'] },
          create: { type: 'boolean', description: 'Create the file if missing.' },
          if_match: etagParam,
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      annotations: ann(false),
      write: true,
      run: (a, ctx) =>
        inWritable(env, a, ctx.client, 'append_file', async (f, c) => {
          checkSize(String(a.content), MAX_EDIT_BYTES);
          const add = toLf(String(a.content));
          const t = await f.resolveTarget(a.path, { kind: 'file', exists: 'may' });
          if (!t.st) {
            if (a.create !== true) throw new ToolError('ENOENT', `Not found: ${t.key} (create: true makes it)`);
            const r = await create(c, t, appendText('', add, 'end'));
            return done(`Created ${t.key}`, r.etag, r.journal);
          }
          const read = await f.readText(t.key);
          checkEtag(t.key, { mtimeMs: read.mtime, size: read.size }, parseEtag(a.if_match));
          const r = await overwrite(c, t, read, appendText(read.content, add, a.position === 'start' ? 'start' : 'end'), 'append');
          return done(`Appended to ${t.key}`, r.etag, r.journal);
        }),
    },
    {
      name: 'patch_file',
      title: 'Change one section',
      description: 'Change one part of a note: a heading section, a ^block or a frontmatter key (pass one).',
      inputSchema: {
        type: 'object',
        properties: {
          folder: P.folder,
          path: P.path('Note path'),
          operation: { type: 'string', description: 'append, prepend, replace or delete.', enum: ['append', 'prepend', 'replace', 'delete'] },
          heading: { type: 'string', description: 'Heading, or "Parent > Child".', maxLength: 500 },
          block: { type: 'string', description: 'Block id.', maxLength: 100 },
          frontmatter_key: { type: 'string', description: 'Frontmatter key.', maxLength: 100 },
          content: { type: 'string', description: 'Text (not for delete). Frontmatter: one line.', maxLength: MAX_EDIT_BYTES },
          create_target: { type: 'boolean', description: 'Add the heading / key if missing.' },
          if_match: etagParam,
        },
        required: ['path', 'operation'],
        additionalProperties: false,
      },
      annotations: ann(true),
      write: true,
      run: (a, ctx) =>
        inWritable(env, a, ctx.client, 'patch_file', async (f, c) => {
          const target = oneTarget(a);
          const op = a.operation as 'append' | 'prepend' | 'replace' | 'delete';
          if (op !== 'delete' && typeof a.content !== 'string') throw new ToolError('EINVAL', `content is needed for ${op}`);
          checkSize(String(a.content ?? ''), MAX_EDIT_BYTES);
          const t = await f.resolveTarget(a.path, { kind: 'file', exists: 'must' });
          if (!isMarkdown(t.key)) throw new ToolError('EINVAL', `Not a Markdown note: ${t.key}`);
          const read = await f.readText(t.key);
          checkEtag(t.key, { mtimeMs: read.mtime, size: read.size }, parseEtag(a.if_match));
          const next = patchText(read.content, target, op, toLf(String(a.content ?? '')), { createTarget: a.create_target === true });
          if (next === read.content) return done(`No change: ${t.key}`, etagOf({ mtime: read.mtime, size: read.size }));
          const r = await overwrite(c, t, read, next, 'patch');
          return done(`Patched ${t.key}`, r.etag, r.journal);
        }),
    },
    {
      name: 'replace_text',
      title: 'Replace text',
      description: 'Replace one exact piece of text; "old" must occur exactly once.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: P.folder,
          path: P.path('File path'),
          old: { type: 'string', description: 'Exact text, unique in the file.', maxLength: 64 * 1024 },
          new: { type: 'string', description: 'Replacement ("" removes).', maxLength: MAX_EDIT_BYTES },
          if_match: etagParam,
        },
        required: ['path', 'old', 'new'],
        additionalProperties: false,
      },
      annotations: ann(true),
      write: true,
      run: (a, ctx) =>
        inWritable(env, a, ctx.client, 'replace_text', async (f, c) => {
          checkSize(String(a.new), MAX_EDIT_BYTES, 'new');
          const t = await f.resolveTarget(a.path, { kind: 'file', exists: 'must' });
          const read = await f.readText(t.key);
          checkEtag(t.key, { mtimeMs: read.mtime, size: read.size }, parseEtag(a.if_match));
          const next = replaceUnique(read.content, toLf(String(a.old)), toLf(String(a.new)));
          const r = await overwrite(c, t, read, next, 'replace');
          return done(`Replaced in ${t.key}`, r.etag, r.journal);
        }),
    },
    {
      name: 'move_file',
      title: 'Move or rename',
      description: 'Rename or move a file or folder; never overwrites. Links to it are updated.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: P.folder,
          from: P.path('Current path'),
          to: P.path('New path (must not exist)'),
          update_links: { type: 'boolean', description: 'Rewrite links to it (default: on).' },
        },
        required: ['from', 'to'],
        additionalProperties: false,
      },
      annotations: ann(false),
      write: true,
      run: (a, ctx) =>
        inWritable(env, a, ctx.client, 'move_file', async (f, c) => {
          const from = await f.resolveTarget(a.from, { kind: 'any', exists: 'must' });
          const isDir = !!from.st?.isDirectory();
          if (!isDir && (await f.readText(from.key)).binary) throw new ToolError('EINVAL', `Binary file: ${from.key} cannot be moved here`);
          // sameAs: "Note.md" → "note.md" on a case-insensitive folder is a rename, not a clash.
          const to = await f.resolveTarget(a.to, { kind: isDir ? 'dir' : 'file', exists: 'mustNot', sameAs: from.st ?? undefined });
          if (to.key.toLowerCase().startsWith(`${from.key.toLowerCase()}/`)) throw new ToolError('EINVAL', 'A folder cannot be moved into itself');
          const ws = await f.workspace();
          // Every file that moves, old → new. A folder must hold nothing hidden, excluded or linked, and nothing
          // of it may land somewhere hidden or excluded (`docs/private` excluded: moving src → docs is refused
          // when src/private exists).
          const pairs = new Map<string, string>();
          if (isDir) {
            const inside = await scan(f, from.key, await fs.promises.realpath(from.abs));
            for (const rel of inside.all) {
              const dest = to.key + rel.slice(from.key.length);
              if (f.hidden(dest)) throw new ToolError('EACCES', `Cannot move ${from.key} to ${to.key}`);
              if (!inside.dirs.has(rel)) pairs.set(rel, dest);
            }
          } else pairs.set(from.key, to.key);
          // Placeholders: no variables file moves, and no note lands under a variables file that makes one of
          // its code blocks secret.
          for (const [o, n] of pairs) {
            if (isVarsFile(o, c.varsFile) || isVarsFile(n, c.varsFile)) throw new ToolError('ESECRET', `AI apps cannot move variables files (${c.varsFile}).`);
            const text = (await f.readText(o)).content;
            await checkPlaceholderPolicy({ path: o, newPath: n, before: text, after: text, scopeBefore: await scopeAt(c, o, text), scopeAfter: await scopeAt(c, n, text), fileName: c.varsFile });
          }
          const update = typeof a.update_links === 'boolean' ? a.update_links : env.settings()['links.updateOnRename'] !== false;
          let rewrite: ((p: string, text: string) => string | null) | null = null;
          let candidates: string[] = [];
          if (update) {
            const { ix, partial } = await readyIndex(env, f);
            if (partial) throw new ToolError('EBUSY', 'Link index still building: retry shortly, or pass update_links: false');
            const all = new Set(ws.filePaths().filter((p) => !f.hidden(p)));
            const rw = createRenameRewriter(pairs, all);
            rewrite = (p, text) => {
              const edits = rw.edits(text, p);
              return edits.length ? applyEdits(text, edits) : null;
            };
            const set = new Set<string>();
            for (const old of pairs.keys()) {
              for (const s of ix.knowledge.backlinkSources(old)) set.add(pairs.get(s) ?? s);
              if (isMarkdown(old)) set.add(pairs.get(old)!);
            }
            candidates = [...set].filter(isMarkdown).sort();
          }
          const group = env.journal.newGroup();
          await move(c, from, to);
          const st = isDir ? null : await fs.promises.stat(path.join(ws.root, ...to.key.split('/'))).catch(() => null);
          // First in the group, so a revert undoes the link rewrites before moving it back.
          await env.journal.add(group, { client: c.client, tool: c.tool, root: f.root, folder: f.alias, op: 'move', path: from.key, to: to.key, dir: isDir, after: st ? { mtime: st.mtimeMs, size: st.size } : null }, null).catch((err) => console.error('[mcp] journal', err));
          f.changed([...pairs].flatMap(([o, n]) => [{ type: 'unlink' as const, path: o }, { type: 'add' as const, path: n }]));
          const updated: string[] = [];
          const failed: string[] = [];
          for (const p of candidates) {
            try {
              const t = await f.resolveTarget(p, { kind: 'file', exists: 'must' });
              const read = await f.readText(t.key);
              const next = rewrite!(t.key, read.content);
              if (next === null) continue;
              await overwrite(c, t, read, next, 'relink', group);
              updated.push(t.key);
            } catch {
              failed.push(p);
            }
          }
          const names = (l: string[]) => l.slice(0, 10).join(', ') + (l.length > 10 ? ` +${l.length - 10} more` : '');
          const links = updated.length ? `links updated: ${names(updated)}` : '';
          const notUpdated = failed.length ? `links NOT updated: ${names(failed)}` : '';
          return done(`Moved ${from.key} → ${to.key}`, st ? etagOf({ mtime: st.mtimeMs, size: st.size }) : null, env.journal.enabled ? group : undefined, links, notUpdated);
        }),
    },
    {
      name: 'create_folder',
      title: 'Create a folder',
      description: 'Create a folder (and missing parents).',
      inputSchema: { type: 'object', properties: { folder: P.folder, path: P.path('New folder path') }, required: ['path'], additionalProperties: false },
      annotations: ann(false),
      write: true,
      run: (a, ctx) =>
        inWritable(env, a, ctx.client, 'create_folder', async (f, c) => {
          const t = await f.resolveTarget(a.path, { kind: 'dir', exists: 'mustNot' });
          const r = await makeDir(c, t);
          return done(`Created folder ${t.key}`, null, r.journal);
        }),
    },
    {
      name: 'delete_file',
      title: 'Delete a file',
      description: 'Move one file to the Recycle Bin (never permanent; folders not supported).',
      inputSchema: { type: 'object', properties: { folder: P.folder, path: P.path('File path'), if_match: etagParam }, required: ['path'], additionalProperties: false },
      annotations: ann(true),
      write: true,
      run: (a, ctx) =>
        inWritable(env, a, ctx.client, 'delete_file', async (f, c) => {
          const t = await f.resolveTarget(a.path, { kind: 'file', exists: 'must' });
          if (isVarsFile(t.key, c.varsFile)) throw new ToolError('ESECRET', `AI apps cannot delete variables files (${c.varsFile}).`);
          const read = await f.readText(t.key);
          if (read.binary) throw new ToolError('EINVAL', `Binary file: ${t.key} cannot be deleted here`);
          const stamp = { mtime: read.mtime, size: read.size };
          checkEtag(t.key, { mtimeMs: stamp.mtime, size: stamp.size }, parseEtag(a.if_match));
          const r = await trashFile(c, t, stamp);
          return done(`Deleted ${t.key} (Recycle Bin)`, null, r.journal);
        }),
    },
  ];
}

/** Everything in a folder about to move (files and sub-folders); refuses hidden, excluded or linked entries
 *  and very large folders. */
async function scan(f: Folder, key: string, realDir: string): Promise<{ all: string[]; dirs: Set<string> }> {
  const all: string[] = [];
  const dirs = new Set<string>();
  // Which entry is not said (a client could probe the exclusions name by name).
  const cannot = () => new ToolError('EACCES', `Cannot move ${key}: it holds entries AI apps cannot change (hidden, excluded or linked)`);
  const walk = async (dir: string, rel: string) => {
    for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (all.length >= MAX_MOVE_ENTRIES) throw new ToolError('ETOOBIG', `${key} holds more than ${MAX_MOVE_ENTRIES} entries: move it in One instead`);
      if (f.hidden(r) || e.isSymbolicLink()) throw cannot();
      if (e.isDirectory()) {
        all.push(r);
        dirs.add(r);
        await walk(path.join(dir, e.name), r);
      } else if (e.isFile()) all.push(r);
      else throw cannot();
    }
  };
  try {
    await walk(realDir, key);
  } catch (err) {
    throw err instanceof ToolError ? err : writeError(err, key);
  }
  return { all, dirs };
}
