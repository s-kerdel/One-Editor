// Write tools: listed only while some shared folder is read-write (ToolDef.write), and each one refuses a
// read-only folder itself. Every path goes through Folder.resolveTarget; every change is journaled (Revert
// in Settings) and lands through the Workspace write path with the folder's commit-time guard (writes.ts).
import fs from 'node:fs';
import path from 'node:path';
import { toLf } from '../../backend/textcodec';
import { isMarkdown } from '../../shared/paths';
import { applyEdits, createRenameRewriter } from '../../knowledge/rename';
import { appendText, patchText, replaceUnique, type PatchTarget } from '../edits';
import type { Folder } from '../folders';
import { ToolError, type ToolAnnotations, type ToolDef, type ToolResult } from '../protocol';
import { MAX_EDIT_BYTES, MAX_MOVE_ENTRIES, MAX_WRITE_BYTES, checkEtag, checkSize, create, etagOf, makeDir, move, overwrite, parseEtag, trashFile, writeError, type WriteCtx } from '../writes';
import { folderParam, json, notMarkdown, pathParam, type ToolEnv } from './common';
import { readyIndex } from './search';

const ann = (destructive: boolean): ToolAnnotations => ({ readOnlyHint: false, destructiveHint: destructive, idempotentHint: false, openWorldHint: false });
const etagParam = { type: 'string' as const, description: 'The etag read_file gave you: the change is made only if the file is still exactly that.', maxLength: 40 };
const done = (o: Record<string, unknown>, journal?: string): ToolResult => ({ content: [json(o)], journal });

/** The folder argument → a folder this caller may write in (else a clear "read-only" error). */
async function inWritable<T>(env: ToolEnv, args: Record<string, unknown>, client: string, tool: string, fn: (f: Folder, c: WriteCtx) => Promise<T>): Promise<T> {
  const f = env.pool.get(args.folder);
  f.checkWritable(); // and again inside the Workspace slot right before the disk changes (Folder.guard)
  env.quota.take();
  return f.use(() => fn(f, { folder: f, journal: env.journal, client, tool, trash: env.trash }));
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
      description: 'Creates a text file, or replaces a whole existing one. To create: path + content. To replace: also pass if_match (the etag from read_file). For small changes prefer replace_text, patch_file or append_file.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: folderParam,
          path: pathParam('File to write (parent folders are created).'),
          content: { type: 'string', description: 'The complete new text of the file.', maxLength: MAX_WRITE_BYTES },
          if_match: etagParam,
          if_none_match: { type: 'string', description: 'Pass "*" to only create: fails if the file already exists.', enum: ['*'] },
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
            return done({ path: t.key, created: true, etag: r.etag }, r.journal);
          }
          if (a.if_none_match === '*' || !want) throw new ToolError('EEXIST', `${t.key} already exists. To replace it, pass if_match with its etag from read_file.`);
          checkEtag(t.key, t.st, want);
          const read = await f.readText(t.key);
          checkEtag(t.key, { mtimeMs: read.mtime, size: read.size }, want);
          const r = await overwrite(c, t, read, text, 'write');
          return done({ path: t.key, created: false, etag: r.etag }, r.journal);
        }),
    },
    {
      name: 'append_file',
      title: 'Add to a file',
      description: 'Adds text at the end of a file (or at the start, after the frontmatter) without rewriting the rest.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: folderParam,
          path: pathParam('File to add to.'),
          content: { type: 'string', description: 'Text to add (a line break is put between it and the existing text).', maxLength: MAX_EDIT_BYTES },
          position: { type: 'string', description: 'end (default) or start (after the frontmatter).', enum: ['end', 'start'] },
          create: { type: 'boolean', description: 'Create the file when it does not exist (default false).' },
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
            if (a.create !== true) throw new ToolError('ENOENT', `Not found: ${t.key} (pass create: true to make it)`);
            const r = await create(c, t, appendText('', add, 'end'));
            return done({ path: t.key, created: true, etag: r.etag }, r.journal);
          }
          const read = await f.readText(t.key);
          checkEtag(t.key, { mtimeMs: read.mtime, size: read.size }, parseEtag(a.if_match));
          const r = await overwrite(c, t, read, appendText(read.content, add, a.position === 'start' ? 'start' : 'end'), 'append');
          return done({ path: t.key, etag: r.etag }, r.journal);
        }),
    },
    {
      name: 'patch_file',
      title: 'Change one section',
      description:
        'Changes one part of a Markdown note: a heading section, a block (^id) or a frontmatter key (pass exactly one). operation: append (at the end of it), prepend (at its start), replace (its content; a heading line is kept), delete (all of it). For a frontmatter key: replace sets the value, append / prepend add a list item.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: folderParam,
          path: pathParam('Markdown note.'),
          operation: { type: 'string', description: 'append, prepend, replace or delete.', enum: ['append', 'prepend', 'replace', 'delete'] },
          heading: { type: 'string', description: 'Heading text, or nested headings joined with " > " (e.g. "Plans > 2026").', maxLength: 500 },
          block: { type: 'string', description: 'Block id, with or without ^.', maxLength: 100 },
          frontmatter_key: { type: 'string', description: 'A key of the YAML frontmatter.', maxLength: 100 },
          content: { type: 'string', description: 'The text to add or put in (not needed for delete). For a frontmatter key: one line, e.g. done or [a, b].', maxLength: MAX_EDIT_BYTES },
          create_target: { type: 'boolean', description: 'Add the heading or frontmatter key when it does not exist (default false).' },
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
          if (!isMarkdown(t.key)) throw notMarkdown(t.key);
          const read = await f.readText(t.key);
          checkEtag(t.key, { mtimeMs: read.mtime, size: read.size }, parseEtag(a.if_match));
          const next = patchText(read.content, target, op, toLf(String(a.content ?? '')), { createTarget: a.create_target === true });
          if (next === read.content) return done({ path: t.key, changed: false, etag: etagOf({ mtime: read.mtime, size: read.size }) });
          const r = await overwrite(c, t, read, next, 'patch');
          return done({ path: t.key, etag: r.etag }, r.journal);
        }),
    },
    {
      name: 'replace_text',
      title: 'Replace text',
      description: 'Replaces one exact piece of text in a file. "old" must occur exactly once (copy it from read_file, with enough context to be unique).',
      inputSchema: {
        type: 'object',
        properties: {
          folder: folderParam,
          path: pathParam('File to change.'),
          old: { type: 'string', description: 'The exact text to replace (it must occur once).', maxLength: 64 * 1024 },
          new: { type: 'string', description: 'The text to put in its place ("" removes it).', maxLength: MAX_EDIT_BYTES },
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
          return done({ path: t.key, etag: r.etag }, r.journal);
        }),
    },
    {
      name: 'move_file',
      title: 'Move or rename',
      description: 'Renames or moves a file or folder inside the folder. Never overwrites. Links to it in other notes are updated (as set in One) unless update_links is false.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: folderParam,
          from: pathParam('What to move.'),
          to: pathParam('The new path (must not exist yet).'),
          update_links: { type: 'boolean', description: 'Rewrite links that point to it (default: One’s "Update links on rename" setting, usually on).' },
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
          // Every file that moves: old → new path. A folder must hold nothing hidden, excluded or linked
          // (moving it must not carry such things to a place where they would be visible).
          const pairs = new Map<string, string>();
          if (isDir) {
            const inside = await scan(f, from.key, (await fs.promises.realpath(from.abs)));
            for (const rel of inside) pairs.set(rel, to.key + rel.slice(from.key.length));
          } else pairs.set(from.key, to.key);
          const update = typeof a.update_links === 'boolean' ? a.update_links : env.settings()['links.updateOnRename'] !== false;
          let rewrite: ((p: string, text: string) => string | null) | null = null;
          let candidates: string[] = [];
          if (update) {
            const { ix, partial } = await readyIndex(env, f);
            if (partial) throw new ToolError('EBUSY', 'The link index is still being built: try again in a moment, or pass update_links: false');
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
          return done({ from: from.key, to: to.key, links_updated: updated, ...(failed.length ? { links_not_updated: failed } : {}) }, env.journal.enabled ? group : undefined);
        }),
    },
    {
      name: 'create_folder',
      title: 'Create a folder',
      description: 'Creates a folder (and missing parent folders).',
      inputSchema: { type: 'object', properties: { folder: folderParam, path: pathParam('The new folder.') }, required: ['path'], additionalProperties: false },
      annotations: ann(false),
      write: true,
      run: (a, ctx) =>
        inWritable(env, a, ctx.client, 'create_folder', async (f, c) => {
          const t = await f.resolveTarget(a.path, { kind: 'dir', exists: 'mustNot' });
          const r = await makeDir(c, t);
          return done({ path: t.key, created: true }, r.journal);
        }),
    },
    {
      name: 'delete_file',
      title: 'Delete a file',
      description: 'Moves one text file to the Recycle Bin (never a permanent delete; folders cannot be deleted here). Fails, deleting nothing, when there is no Recycle Bin for it.',
      inputSchema: { type: 'object', properties: { folder: folderParam, path: pathParam('File to delete.'), if_match: etagParam }, required: ['path'], additionalProperties: false },
      annotations: ann(true),
      write: true,
      run: (a, ctx) =>
        inWritable(env, a, ctx.client, 'delete_file', async (f, c) => {
          const t = await f.resolveTarget(a.path, { kind: 'file', exists: 'must' });
          const read = await f.readText(t.key);
          if (read.binary) throw new ToolError('EINVAL', `Binary file: ${t.key} cannot be deleted here`);
          const stamp = { mtime: read.mtime, size: read.size };
          checkEtag(t.key, { mtimeMs: stamp.mtime, size: stamp.size }, parseEtag(a.if_match));
          const r = await trashFile(c, t, stamp);
          return done({ path: t.key, deleted: true, where: 'Recycle Bin' }, r.journal);
        }),
    },
  ];
}

/** Files in a folder about to move; refuses hidden, excluded or linked entries and very large folders. */
async function scan(f: Folder, key: string, realDir: string): Promise<string[]> {
  const files: string[] = [];
  let n = 0;
  const walk = async (dir: string, rel: string) => {
    for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (++n > MAX_MOVE_ENTRIES) throw new ToolError('ETOOBIG', `${key} holds more than ${MAX_MOVE_ENTRIES} entries: move it in One instead`);
      if (f.hidden(r) || e.isSymbolicLink()) throw new ToolError('EACCES', `${key} contains hidden, excluded or linked items: move it in One instead`);
      if (e.isDirectory()) await walk(path.join(dir, e.name), r);
      else if (e.isFile()) files.push(r);
      else throw new ToolError('EACCES', `${key} contains special files: move it in One instead`);
    }
  };
  try {
    await walk(realDir, key);
  } catch (err) {
    throw err instanceof ToolError ? err : writeError(err, key);
  }
  return files;
}
