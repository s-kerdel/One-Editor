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
import type { Folder, Target } from '../folders';
import { checkPlaceholderPolicy, isVarsFile } from '../placeholders';
import { ToolError, type CallContext, type ToolAnnotations, type ToolDef, type ToolResult } from '../protocol';
import { MAX_EDIT_BYTES, MAX_MOVE_ENTRIES, MAX_MOVE_WALK, MAX_WRITE_BYTES, checkEtag, checkSize, create, etagOf, makeDir, move, overwrite, parseEtag, scopeAt, trashFile, trashFolder, varsFileFor, writeError, type WriteCtx } from '../writes';
import { binWord, count as many, folderSummary, surveyFolder } from '../confirm';
import { dirname } from '../../shared/paths';
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

async function inWritable<T>(env: ToolEnv, args: Record<string, unknown>, client: string, tool: string, fn: (f: Folder, c: WriteCtx) => Promise<T>, o: { quota?: boolean } = {}): Promise<T> {
  const f = env.pool.get(args.folder);
  f.checkWritable(); // and again inside the Workspace slot right before the disk changes (Folder.guard)
  if (o.quota !== false) env.quota.take(); // delete takes it itself: asking the user is not a change
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
      name: 'move',
      title: 'Move or rename',
      description: 'Rename or move a file or folder (with its contents); never overwrites. Links to it are updated.',
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
        inWritable(env, a, ctx.client, 'move', async (f, c) => {
          const from = await f.resolveTarget(a.from, { kind: 'any', exists: 'must' });
          const isDir = !!from.st?.isDirectory();
          if (!isDir && (await f.readText(from.key)).binary) throw new ToolError('EINVAL', `Binary file: ${from.key} cannot be moved here`);
          // sameAs: "Note.md" → "note.md" on a case-insensitive folder is a rename, not a clash.
          const to = await f.resolveTarget(a.to, { kind: isDir ? 'dir' : 'file', exists: 'mustNot', sameAs: from.st ?? undefined });
          if (to.key.toLowerCase().startsWith(`${from.key.toLowerCase()}/`)) throw new ToolError('EINVAL', 'A folder cannot be moved into itself');
          const ws = await f.workspace();
          // Visible files, old → new (link rewrites, placeholder checks). A folder takes everything along: items
          // hidden by name (.git, .env, key files) stay hidden by name. Every entry keeps its visibility: nothing
          // may land in a hidden or excluded place, nothing excluded by a rooted rule may come out of it.
          const pairs = new Map<string, string>();
          let hiddenFiles = 0;
          if (isDir) {
            const inside = await scan(from.key, await fs.promises.realpath(from.abs));
            for (const rel of inside.all) {
              const dest = to.key + rel.slice(from.key.length);
              const was = f.hidden(rel);
              if (was !== f.hidden(dest)) {
                throw new ToolError('EACCES', was ? `Cannot move ${from.key} to ${to.key}: items your exclusions hide there would become visible. Move it in One instead.` : `Cannot move ${from.key} to ${to.key}`);
              }
              if (inside.dirs.has(rel)) continue;
              if (isVarsFile(rel, c.varsFile)) throw new ToolError('ESECRET', `AI apps cannot move variables files (${c.varsFile}).`);
              if (was) hiddenFiles++;
              else pairs.set(rel, dest);
            }
            if (pairs.size > MAX_MOVE_ENTRIES) throw new ToolError('ETOOBIG', `${from.key} holds more than ${MAX_MOVE_ENTRIES.toLocaleString('en')} files: move it in One instead`);
          } else pairs.set(from.key, to.key);
          // Placeholders: no variables file moves; a note may only come under other definitions if the rules
          // allow it there (hidden files are never read: under other definitions, the move is refused).
          if (pairs.has(from.key) && isVarsFile(from.key, c.varsFile)) throw new ToolError('ESECRET', `AI apps cannot move variables files (${c.varsFile}).`);
          if (isVarsFile(to.key, c.varsFile)) throw new ToolError('ESECRET', `AI apps cannot move variables files (${c.varsFile}).`);
          const sameDefs = (await varsFileFor(c, dirname(from.key))) === (await varsFileFor(c, dirname(to.key)));
          if (!sameDefs) {
            if (hiddenFiles) throw new ToolError('ESECRET', `Cannot move ${from.key} to ${to.key}: it holds hidden files that would come under other {{variables}} definitions. Move it in One instead.`);
            for (const [o, n] of pairs) {
              const text = (await f.readText(o)).content;
              await checkPlaceholderPolicy({ path: o, newPath: n, before: text, after: text, scopeBefore: await scopeAt(c, o, text), scopeAfter: await scopeAt(c, n, text), fileName: c.varsFile });
            }
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
      name: 'delete',
      title: 'Delete',
      description: "Move a file or folder to the Recycle Bin. A folder (all it holds) needs the user's OK: show them the summary; only if they agree, call again with confirm.",
      inputSchema: {
        type: 'object',
        properties: { folder: P.folder, path: P.path('File or folder'), if_match: etagParam, confirm: { type: 'string', description: 'Code from the summary, once the user agreed.', maxLength: 20 } },
        required: ['path'],
        additionalProperties: false,
      },
      annotations: ann(true),
      write: true,
      run: (a, ctx) =>
        inWritable(
          env,
          a,
          ctx.client,
          'delete',
          async (f, c) => {
            const t = await f.resolveTarget(a.path, { kind: 'any', exists: 'must' });
            if (t.st?.isDirectory()) return deleteFolder(env, f, c, t, typeof a.confirm === 'string' ? a.confirm : null, ctx);
            env.quota.take();
            if (isVarsFile(t.key, c.varsFile)) throw new ToolError('ESECRET', `AI apps cannot delete variables files (${c.varsFile}).`);
            const read = await f.readText(t.key);
            if (read.binary) throw new ToolError('EINVAL', `Binary file: ${t.key} cannot be deleted here`);
            const stamp = { mtime: read.mtime, size: read.size };
            checkEtag(t.key, { mtimeMs: stamp.mtime, size: stamp.size }, parseEtag(a.if_match));
            const r = await trashFile(c, t, stamp);
            return done(`Deleted ${t.key} (${binWord()})`, null, r.journal);
          },
          { quota: false },
        ),
    },
  ];
}

/** Everything in a folder about to move (files and sub-folders, hidden ones included: walked, never read).
 *  Refuses links (they stay where they are) and special files, and very large folders. */
async function scan(key: string, realDir: string): Promise<{ all: string[]; dirs: Set<string> }> {
  const all: string[] = [];
  const dirs = new Set<string>();
  const cannot = () => new ToolError('EACCES', `Cannot move ${key}: it holds links or special files. Move it in One instead.`);
  const walk = async (dir: string, rel: string) => {
    for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (all.length >= MAX_MOVE_WALK) throw new ToolError('ETOOBIG', `${key} holds more than ${MAX_MOVE_WALK.toLocaleString('en')} entries: move it in One instead`);
      if (e.isSymbolicLink()) throw cannot();
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

/**
 * A folder and everything in it (hidden items too) to the Recycle Bin, after the user's OK: asked through
 * the client when it can (elicitation), else in two steps (a summary and a one-time code, confirm.ts). No
 * undo copy (hidden contents are never read): restored from the bin. One change in the quota, no size cap.
 */
async function deleteFolder(env: ToolEnv, f: Folder, c: WriteCtx, t: Target, code: string | null, ctx: CallContext): Promise<ToolResult> {
  const realDir = await fs.promises.realpath(t.abs).catch((err) => {
    throw writeError(err, t.key);
  });
  const survey = () =>
    surveyFolder(realDir, t.key, (r) => f.hidden(r)).catch((err) => {
      throw err instanceof ToolError ? err : writeError(err, t.key);
    });
  const s = await survey();
  const summary = folderSummary(t.key, s);
  const target = `${f.alias}\0${t.key}`;
  const asked = (await ctx.confirm?.({ message: summary, bind: `delete\0${target}\0${s.fingerprint}` })) ?? 'unsupported';
  const audit = { tool: 'delete (folder)' };
  if (asked === 'unsupported') {
    if (code === null || !code.trim()) {
      const fresh = env.confirmCodes.mint(target, s.fingerprint);
      return { content: [{ type: 'text', text: `${summary} Show this to the user; only if they agree, call delete again with confirm. · confirm: ${fresh}` }], audit: { ...audit, ok: false, code: 'ASKED', note: 'waiting for the user' } };
    }
    const k = env.confirmCodes.take(code, target, s.fingerprint);
    if (k !== 'ok') {
      const why = { unknown: 'that confirm code is not valid', expired: 'that confirm code expired', used: 'that confirm code was used already', other: 'that confirm code is for another folder', changed: 'the folder changed since the summary' }[k];
      const fresh = env.confirmCodes.mint(target, s.fingerprint);
      throw new ToolError('ECONFIRM', `Not deleted: ${why}. ${summary} Ask the user again; only if they agree, call delete with confirm. · confirm: ${fresh}`);
    }
  } else if (asked !== 'yes') {
    throw new ToolError('ECANCELED', asked === 'no' ? 'Not deleted: the user declined' : 'Not deleted: the user did not answer');
  } else if ((await survey()).fingerprint !== s.fingerprint) {
    throw new ToolError('EXTERNAL_CHANGE', 'Not deleted: the folder changed while the user was asked. Try again.');
  }
  env.quota.take();
  try {
    await trashFolder(c, t);
  } catch (err) {
    // A trash call that failed after starting (killed, cancelled at Windows' own prompt) may have moved part of
    // the folder: say what is left instead of "nothing was deleted" (there is no undo copy for folders).
    const left = await surveyFolder(realDir, t.key, (r) => f.hidden(r)).catch(() => null);
    const before = s.files + s.folders;
    if (!left) throw new ToolError('EPARTIAL', `${t.key} is no longer there, but the ${binWord()} reported an error: check the ${binWord()}.`);
    const now = left.files + left.folders;
    if (now < before) throw new ToolError('EPARTIAL', `Partly deleted: ${many(before - now, 'item')} of ${before} went to the ${binWord()}; ${many(now, 'item')} are still in ${t.key}.`);
    throw err;
  }
  return { content: [{ type: 'text', text: `Deleted folder ${t.key} (${many(s.files, 'file')}, ${many(s.folders, 'folder')}) to the ${binWord()}: restore it from there (no undo copy)` }], audit: { ...audit, note: `restore from the ${binWord()}` } };
}
