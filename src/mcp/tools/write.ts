// Write tools: listed only while some shared folder is read-write (ToolDef.write); each refuses a read-only
// folder itself (Folder.checkWritable, and again in the commit guard). Every path goes through
// Folder.resolveTarget; every change lands through writes.ts (Workspace write path + guard + journal) and the
// placeholder rules (placeholders.ts). Answers are one plain line: what changed, the new etag, the undo id.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { toLf } from '../../backend/textcodec';
import { isMarkdown } from '../../shared/paths';
import { applyEdits, createRenameRewriter } from '../../knowledge/rename';
import { appendText, patchText, replaceUnique, type PatchTarget } from '../edits';
import { cleanPath, writeTypeProblem, type Folder, type Target } from '../folders';
import { MCP_CONFIRM_OVER } from '../../shared/mcp';
import { checkPlaceholderPolicy, frozenLines, isVarsFile } from '../placeholders';
import { readGroup, revertGroupReport } from '../journal';
import { ToolError, type CallContext, type ToolAnnotations, type ToolDef, type ToolResult } from '../protocol';
import { MAX_EDIT_BYTES, MAX_MOVE_ENTRIES, MAX_MOVE_WALK, MAX_WRITE_BYTES, checkEtag, checkSize, create, etagOf, makeDir, move, overwrite, parseEtag, scopeAt, trashFile, trashFolder, varsFileFor, writeError, type WriteCtx } from '../writes';
import { batchSummary, binWord, count as many, folderSummary, shownName, shownPath, sizeText, surveyFolder, type Survey } from '../confirm';
import { dirname } from '../../shared/paths';
import type { ToolEnv } from './common';
import { P, etagPart, fitRows, line } from './format';
import { readyIndex } from './search';

/** replace_in_files: files changed per call at most. */
const MAX_REPLACE_FILES = 200;

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
      description: 'Replace exact text in a file: "old" must occur once, or pass all.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: P.folder,
          path: P.path('File path'),
          old: { type: 'string', description: 'Exact text.', maxLength: 64 * 1024 },
          new: { type: 'string', description: 'Replacement ("" removes).', maxLength: MAX_EDIT_BYTES },
          all: { type: 'boolean', description: 'Every match.' },
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
          const old = toLf(String(a.old));
          const nu = toLf(String(a.new));
          if (a.all !== true) {
            const r = await overwrite(c, t, read, replaceUnique(read.content, old, nu), 'replace');
            return done(`Replaced in ${t.key}`, r.etag, r.journal);
          }
          if (!old) throw new ToolError('EINVAL', '"old" is empty');
          const n = countLiteral(read.content, old);
          if (!n) throw new ToolError('ENOMATCH', 'The text in "old" was not found (it must match exactly, including spaces and line breaks).');
          try {
            const r = await overwrite(c, t, read, read.content.split(old).join(nu), 'replace');
            return done(`Replaced ${n} in ${t.key}`, r.etag, r.journal);
          } catch (err) {
            if (!(err instanceof ToolError) || err.code !== 'ESECRET') throw err;
            // Which matches touch a line with a secret {{placeholder}} (or its neighbours): none was changed.
            const frozen = frozenLines(read.content, await scopeAt(c, t.key, read.content));
            const at = matchLines(read.content, old).filter((ls) => ls.some((l) => frozen.has(l))).map((ls) => ls[0] + 1);
            throw at.length ? new ToolError('ESECRET', `Nothing replaced: matches on lines ${at.slice(0, 20).join(', ')} touch a line that uses a secret {{placeholder}} (or the line next to it).`) : err;
          }
        }),
    },
    {
      name: 'replace_in_files',
      title: 'Replace in files',
      description: "Replace exact text in many files; preview: true counts first. Over 10 files needs the user's OK, as delete.",
      inputSchema: {
        type: 'object',
        properties: {
          folder: P.folder,
          find: { type: 'string', description: 'Exact text.', maxLength: 64 * 1024 },
          replace: { type: 'string', description: 'Replacement.', maxLength: MAX_EDIT_BYTES },
          query: { type: 'string', description: 'Filters only: path: ext: tag: lang: file:', maxLength: 500 },
          case_sensitive: { type: 'boolean', description: 'Default: if find has capitals.' },
          preview: { type: 'boolean', description: 'Only count.' },
          confirm: confirmParam,
        },
        required: ['find', 'replace'],
        additionalProperties: false,
      },
      annotations: ann(true),
      write: true,
      run: (a, ctx) => inWritable(env, a, ctx.client, 'replace_in_files', (f, c) => replaceInFiles(env, f, c, a, ctx), { quota: false }),
    },
    {
      name: 'move',
      title: 'Move or rename',
      description: 'Rename or move files or folders (with contents); never overwrites; links are updated.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: P.folder,
          from: P.path('Current path'),
          to: P.path('New path (must not exist)'),
          paths: { type: 'array', items: { type: 'string', maxLength: 1024 }, maxItems: 100, description: 'Several (not with from).' },
          to_folder: P.path('New folder (keeps subfolders)'),
          flat: { type: 'boolean', description: 'No subfolders.' },
          to_paths: { type: 'array', items: { type: 'string', maxLength: 1024 }, maxItems: 100, description: 'Or one new path each.' },
          update_links: { type: 'boolean', description: 'Rewrite links to it (default: on).' },
        },
        additionalProperties: false,
      },
      annotations: ann(false),
      write: true,
      run: (a, ctx) =>
        inWritable(
          env,
          a,
          ctx.client,
          'move',
          async (f, c) => {
            const update = typeof a.update_links === 'boolean' ? a.update_links : env.settings()['links.updateOnRename'] !== false;
            const batch = a.paths !== undefined || a.to_folder !== undefined || a.to_paths !== undefined || a.flat !== undefined;
            if (batch === (a.from !== undefined || a.to !== undefined)) throw new ToolError('EINVAL', 'Pass from + to (one item), or paths + to_folder / to_paths (several)');
            if (!batch) {
              if (a.from === undefined || a.to === undefined) throw new ToolError('EINVAL', 'Pass both from and to');
              env.quota.take();
              const r = await moveOne(env, f, c, a.from, a.to, { update });
              return done(`Moved ${r.from} → ${r.to}`, r.etag, env.journal.enabled ? r.group : undefined, r.links, r.notUpdated);
            }
            if (!Array.isArray(a.paths)) throw new ToolError('EINVAL', 'Pass paths, with to_folder or to_paths');
            const paths = a.paths as string[];
            let dests: string[];
            if (a.to_paths !== undefined) {
              if (a.to_folder !== undefined || a.flat !== undefined) throw new ToolError('EINVAL', 'to_paths replaces to_folder and flat: pass one of them');
              const to = a.to_paths as string[];
              if (to.length !== paths.length) throw new ToolError('EINVAL', `to_paths must name one new path per item (${paths.length}), not ${to.length}`);
              dests = to;
            } else {
              if (typeof a.to_folder !== 'string') throw new ToolError('EINVAL', 'Pass both paths and to_folder (or to_paths)');
              dests = batchDestinations(paths, String(a.to_folder), a.flat === true, f.win);
            }
            // Each item on its own (a failure does not stop the rest); one undo group: one Revert moves all back.
            const group = env.journal.newGroup();
            const rows: string[] = [];
            let moved = 0;
            for (const [i, p] of paths.entries()) {
              try {
                env.quota.take();
                const r = await moveOne(env, f, c, p, dests[i], { update, group });
                moved++;
                rows.push(line(`ok ${r.from} → ${r.to}`, r.links, r.notUpdated));
              } catch (err) {
                const e = err instanceof ToolError ? err : new ToolError('EIO', 'failed');
                rows.push(`${e.code} ${oneItem(p)}: ${e.message}`);
              }
            }
            const head = line(`Moved ${moved} of ${many(rows.length, 'item')}${typeof a.to_folder === 'string' ? ` into ${a.to_folder}` : ''}`, moved && env.journal.enabled ? `undo: ${group.slice(-8)}` : '');
            return { content: [{ type: 'text', text: [head, ...rows].join('\n') }], journal: moved && env.journal.enabled ? group : undefined, isError: moved === 0, audit: { items: rows.length } };
          },
          { quota: false },
        ),
    },
    {
      name: 'undo',
      title: 'Undo',
      description: 'Undo your own change from this session: id = the undo code its answer showed.',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The undo code.', maxLength: 40 } }, required: ['id'], additionalProperties: false },
      annotations: ann(false),
      write: true,
      run: (a) => undoGroup(env, String(a.id)),
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
      description: "Files or folders to the Recycle Bin. Folders or over 10 items need the user's OK: show the summary; call again with confirm only if they agree.",
      inputSchema: {
        type: 'object',
        properties: {
          folder: P.folder,
          path: P.path('File or folder'),
          paths: { type: 'array', items: { type: 'string', maxLength: 1024 }, maxItems: 100, description: 'Several (not with path).' },
          if_match: etagParam,
          confirm: confirmParam,
        },
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
            if ((a.path === undefined) === (a.paths === undefined)) throw new ToolError('EINVAL', 'Pass path (one item) or paths (several)');
            if (a.paths !== undefined) return deleteMany(env, f, c, a.paths as string[], typeof a.confirm === 'string' ? a.confirm : null, ctx);
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
  const audit = { tool: 'delete (folder)' };
  const asked = await askUser(env, ctx, { tool: 'delete', summary: folderSummary(t.key, s), target: `delete\0${f.alias}\0${t.key}`, fingerprint: s.fingerprint, code, recheck: async () => (await survey()).fingerprint, audit, not: 'Not deleted', what: 'the folder' });
  if (asked) return asked;
  env.quota.take();
  await trashFolderOrSay(c, f, t, realDir, s);
  return { content: [{ type: 'text', text: `Deleted folder ${t.key} (${many(s.files, 'file')}, ${many(s.folders, 'folder')}, ${sizeText(s.bytes)}) to the ${binWord()}: restore it from there (no undo copy)` }], audit: { ...audit, note: `restore from the ${binWord()}` } };
}

/** trashFolder; a call that failed after starting may have moved part of it: say what is left (no undo copy). */
async function trashFolderOrSay(c: WriteCtx, f: Folder, t: Target, realDir: string, s: Survey) {
  try {
    await trashFolder(c, t);
  } catch (err) {
    const left = await surveyFolder(realDir, t.key, (r) => f.hidden(r)).catch(() => null);
    const before = s.files + s.folders;
    if (!left) throw new ToolError('EPARTIAL', `${t.key} is no longer there, but the ${binWord()} reported an error: check the ${binWord()}.`);
    const now = left.files + left.folders;
    if (now < before) throw new ToolError('EPARTIAL', `Partly deleted: ${many(before - now, 'item')} of ${before} went to the ${binWord()}; ${many(now, 'item')} are still in ${t.key}.`);
    throw err;
  }
}

/**
 * The user's OK for what Revert cannot undo or what sweeps wide (folder deletes, big batches, replace_in_files
 * over MCP_CONFIRM_OVER files): through the client when it can ask (elicitation / input_required), else two
 * steps (this answer carries a one-time code; the next call with it proceeds). Bound to `target` + the
 * contents' `fingerprint`: a code or an answer for anything else, or for changed contents, asks again.
 * null = go ahead; a result = the question (nothing done); throws when the user said no.
 */
async function askUser(
  env: ToolEnv,
  ctx: CallContext,
  o: { tool: string; summary: string; target: string; fingerprint: string; code: string | null; recheck: () => Promise<string>; audit: Record<string, unknown>; not: string; what: string },
): Promise<ToolResult | null> {
  const asked = (await ctx.confirm?.({ message: o.summary, bind: `${o.target}\0${o.fingerprint}` })) ?? 'unsupported';
  if (asked === 'unsupported') {
    if (o.code === null || !o.code.trim()) {
      const fresh = env.confirmCodes.mint(o.target, o.fingerprint);
      return { content: [{ type: 'text', text: `${o.summary} Show this to the user; only if they agree, call ${o.tool} again with confirm. · confirm: ${fresh}` }], audit: { ...o.audit, ok: false, code: 'ASKED', note: 'waiting for the user' } };
    }
    const k = env.confirmCodes.take(o.code, o.target, o.fingerprint);
    if (k === 'ok') return null;
    const why = { unknown: 'that confirm code is not valid', expired: 'that confirm code expired', used: 'that confirm code was used already', other: 'that confirm code is for something else', changed: `${o.what} changed since the summary` }[k];
    const fresh = env.confirmCodes.mint(o.target, o.fingerprint);
    throw new ToolError('ECONFIRM', `${o.not}: ${why}. ${o.summary} Ask the user again; only if they agree, call ${o.tool} with confirm. · confirm: ${fresh}`);
  }
  if (asked !== 'yes') throw new ToolError('ECANCELED', `${o.not}: the user ${asked === 'no' ? 'declined' : 'did not answer'}`);
  if ((await o.recheck()) !== o.fingerprint) throw new ToolError('EXTERNAL_CHANGE', `${o.not}: ${o.what} changed while the user was asked. Try again.`);
  return null;
}

/** "a.md" or a cut, one-line version of what the client sent (answers only; never shown to the user as a question). */
const oneItem = (p: unknown) => String(p).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200);

/**
 * delete with paths: files to the Recycle Bin with undo copies in ONE group (one Revert restores them all),
 * folders with everything in them. One question for the whole call when it holds a folder or more than
 * MCP_CONFIRM_OVER items. Each item on its own after that (a failure does not stop the rest).
 */
async function deleteMany(env: ToolEnv, f: Folder, c: WriteCtx, paths: string[], code: string | null, ctx: CallContext): Promise<ToolResult> {
  type Item = { arg: string; t?: Target; realDir?: string; survey?: Survey; stamp?: { mtime: number; size: number }; err?: ToolError };
  const items: Item[] = [];
  const seen = new Set<string>();
  for (const arg of paths) {
    const it: Item = { arg };
    items.push(it);
    try {
      const t = await f.resolveTarget(arg, { kind: 'any', exists: 'must' });
      if (seen.has(t.key.toLowerCase())) throw new ToolError('EINVAL', 'listed twice');
      seen.add(t.key.toLowerCase());
      it.t = t;
      if (t.st?.isDirectory()) {
        it.realDir = await fs.promises.realpath(t.abs);
        it.survey = await surveyFolder(it.realDir, t.key, (r) => f.hidden(r));
      } else {
        if (isVarsFile(t.key, c.varsFile)) throw new ToolError('ESECRET', `AI apps cannot delete variables files (${c.varsFile}).`);
        const read = await f.readText(t.key);
        if (read.binary) throw new ToolError('EINVAL', 'binary: not deleted here');
        it.stamp = { mtime: read.mtime, size: read.size };
      }
    } catch (err) {
      it.err = err instanceof ToolError ? err : writeError(err, String(arg));
    }
  }
  const ok = items.filter((i) => !i.err);
  // One fingerprint for the set: every folder's and file's state as surveyed.
  const print = (xs: Item[]) => crypto.createHash('sha256').update(xs.map((i) => `${i.t!.key}\0${i.survey ? i.survey.fingerprint : `${i.stamp!.mtime}-${i.stamp!.size}`}`).join('\n')).digest('base64url');
  if (ok.length && (ok.some((i) => i.survey) || ok.length > MCP_CONFIRM_OVER)) {
    const keys = ok.map((i) => i.t!.key);
    const summary = batchSummary(ok.map((i) => ({ key: i.t!.key, survey: i.survey ?? null, bytes: i.stamp?.size ?? 0 })));
    const recheck = async () => {
      const again: Item[] = [];
      for (const i of ok) {
        if (i.survey) again.push({ ...i, survey: await surveyFolder(i.realDir!, i.t!.key, (r) => f.hidden(r)).catch(() => ({ ...i.survey!, fingerprint: 'gone' })) });
        else {
          const st = await fs.promises.stat(i.t!.abs).catch(() => null);
          again.push({ ...i, stamp: st ? { mtime: st.mtimeMs, size: st.size } : { mtime: -1, size: -1 } });
        }
      }
      return print(again);
    };
    const asked = await askUser(env, ctx, { tool: 'delete', summary, target: `delete-batch\0${f.alias}\0${[...keys].sort().join('\0')}`, fingerprint: print(ok), code, recheck, audit: { items: items.length }, not: 'Not deleted', what: 'the items' });
    if (asked) return asked;
  }
  const group = env.journal.newGroup();
  const rows: string[] = [];
  let files = 0;
  let folders = 0;
  for (const i of items) {
    if (i.err) {
      rows.push(`${i.err.code} ${oneItem(i.arg)}: ${i.err.message}`);
      continue;
    }
    try {
      env.quota.take();
      if (i.survey) {
        await trashFolderOrSay(c, f, i.t!, i.realDir!, i.survey);
        // A note in the group (no copy): `undo` and Revert say it comes back from the bin, never "undone".
        await env.journal.add(group, { client: c.client, tool: c.tool, root: f.root, folder: f.alias, op: 'trash', path: i.t!.key, dir: true, after: null }, null, { force: true }).catch(() => {});
        folders++;
        rows.push(`ok ${i.t!.key} (folder, ${many(i.survey.files, 'file')}: restore it from the ${binWord()})`);
      } else {
        await trashFile(c, i.t!, i.stamp!, group);
        files++;
        rows.push(`ok ${i.t!.key}`);
      }
    } catch (err) {
      const e = err instanceof ToolError ? err : writeError(err, i.t!.key);
      rows.push(`${e.code} ${i.t!.key}: ${e.message}`);
    }
  }
  const head = line(`Deleted ${files + folders} of ${many(items.length, 'item')} (${binWord()})`, files + folders ? `undo: ${group.slice(-8)}` : '');
  return {
    content: [{ type: 'text', text: [head, ...rows].join('\n') }],
    journal: files ? group : undefined,
    isError: files + folders === 0,
    audit: { items: items.length, ...(folders ? { note: `folders: restore from the ${binWord()}` } : {}) },
  };
}

/**
 * replace_in_files: exact text (never a regex) in the visible, writable text files the filters select. preview
 * counts. Apply: one undo group (one Revert), each file guarded by its stamp, each a quota unit; files where
 * the change would touch a secret {{placeholder}} line (or its neighbours), or that changed meanwhile, are
 * skipped and named. Over MCP_CONFIRM_OVER files the user is asked first (bound to find + replace + scope +
 * the files' state).
 */
async function replaceInFiles(env: ToolEnv, f: Folder, c: WriteCtx, a: Record<string, unknown>, ctx: CallContext): Promise<ToolResult> {
  const find = toLf(String(a.find));
  const replace = toLf(String(a.replace));
  if (!find) throw new ToolError('EINVAL', '"find" is empty');
  checkSize(replace, MAX_EDIT_BYTES, 'replace');
  const query = typeof a.query === 'string' ? a.query.trim() : '';
  const { ix } = await readyIndex(env, f);
  const pq = ix.engine.parse(query, { noRegex: true, caseSensitive: 'smart' });
  if (pq.text.trim()) throw new ToolError('EINVAL', `query takes filters only (path: ext: tag: lang: file:); the text goes in find. Not a filter: ${pq.text.trim().slice(0, 60)}`);
  if (pq.filters.some((x) => x.key === 'in')) throw new ToolError('EINVAL', 'in: is not supported here: narrow with path: ext: tag: lang: file:');
  const cs = typeof a.case_sensitive === 'boolean' ? a.case_sensitive : (pq.forcedCase ?? /\p{Lu}/u.test(find));
  const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), cs ? 'gu' : 'giu'); // the literal text, escaped: linear
  const scope = query ? ix.engine.search(query, { noRegex: true, caseSensitive: 'smart', limit: 1_000_000, maxMatchesPerFile: 1 }).results.map((r) => r.path) : ix.engine.paths();
  const visible = await f.visibleOnly(scope);
  const hits: Array<{ path: string; n: number; read: Awaited<ReturnType<Folder['readText']>> }> = [];
  for (const p of [...visible].sort()) {
    if (writeTypeProblem(p, f.allowCode)) continue; // outside the type policy: not a candidate
    const read = await f.readText(p).catch(() => null);
    if (!read || read.binary) continue;
    const n = (read.content.match(re) ?? []).length;
    if (n) hits.push({ path: p, n, read });
  }
  const total = hits.reduce((s, h) => s + h.n, 0);
  const list = (hs: typeof hits) => fitRows(hs.map((h) => `${h.path} (${h.n})`), Math.min(env.limits().readChars, 4000));
  if (!hits.length) return { content: [{ type: 'text', text: 'No matches: nothing to replace' }] };
  if (a.preview === true) {
    const l = list(hits);
    return { content: [{ type: 'text', text: [line(`${many(total, 'match').replace('matchs', 'matches')} in ${many(hits.length, 'file')}`, l.cut && `showing ${l.rows.length}`), ...l.rows].join('\n') }] };
  }
  if (hits.length > MAX_REPLACE_FILES) throw new ToolError('ETOOBIG', `${hits.length} files match: at most ${MAX_REPLACE_FILES} per call. Narrow with path: or ext:`);
  if (hits.length > MCP_CONFIRM_OVER) {
    const print = (hs: Array<{ path: string; mtime: number; size: number }>) => crypto.createHash('sha256').update(hs.map((h) => `${h.path}\0${h.mtime}-${h.size}`).join('\n')).digest('base64url');
    const now = print(hits.map((h) => ({ path: h.path, mtime: h.read.mtime, size: h.read.size })));
    const first = hits.slice(0, 3).map((h) => `"${shownPath(h.path)}"`).join(', ') + (hits.length > 3 ? ` and ${hits.length - 3} more` : '');
    const summary = `Replace "${shownName(find, 60)}" with "${shownName(replace, 60)}" in ${many(hits.length, 'file')} (${many(total, 'match').replace('matchs', 'matches')}): ${first}?`;
    const stampOf = (p: string) => fs.promises.stat(path.join(f.root, ...p.split('/'))).then((st) => ({ mtime: st.mtimeMs, size: st.size }), () => ({ mtime: -1, size: -1 }));
    const recheck = async () => print(await Promise.all(hits.map(async (h) => ({ path: h.path, ...(await stampOf(h.path)) }))));
    const asked = await askUser(env, ctx, { tool: 'replace_in_files', summary, target: `replace\0${f.alias}\0${find}\0${replace}\0${query}\0${cs}`, fingerprint: now, code: typeof a.confirm === 'string' ? a.confirm : null, recheck, audit: { items: hits.length }, not: 'Not replaced', what: 'the files' });
    if (asked) return asked;
  }
  const group = env.journal.newGroup();
  let changed = 0;
  let replaced = 0;
  const skipped: string[] = [];
  for (const h of hits) {
    try {
      env.quota.take();
      const t = await f.resolveTarget(h.path, { kind: 'file', exists: 'must' });
      await overwrite(c, t, h.read, h.read.content.replace(re, () => replace), 'replace', group);
      changed++;
      replaced += h.n;
    } catch (err) {
      const e = err instanceof ToolError ? err : writeError(err, h.path);
      skipped.push(`${h.path} (${e.code === 'ESECRET' ? 'secret line' : e.code === 'EXTERNAL_CHANGE' ? 'changed meanwhile' : e.code})`);
      if (e.code === 'EQUOTA' || e.code === 'ERATE') break;
    }
  }
  const rest = hits.length - changed - skipped.length;
  const skip = skipped.length ? `skipped ${skipped.length}: ${skipped.slice(0, 10).join(', ')}${skipped.length > 10 ? ` +${skipped.length - 10} more` : ''}` : '';
  const head = line(`Replaced ${replaced} in ${many(changed, 'file')}`, skip, rest > 0 && `${rest} not tried (quota)`, changed && env.journal.enabled ? `undo: ${group.slice(-8)}` : '');
  return { content: [{ type: 'text', text: head }], journal: changed && env.journal.enabled ? group : undefined, isError: changed === 0, audit: { items: changed } };
}

const confirmParam = { type: 'string' as const, description: 'Code, once the user agreed.', maxLength: 20 };

/** Non-overlapping occurrences of `old` (as split/join replaces them). */
function countLiteral(text: string, old: string): number {
  let n = 0;
  for (let i = text.indexOf(old); i !== -1; i = text.indexOf(old, i + old.length)) n++;
  return n;
}

/** The 0-based lines each occurrence of `old` spans (plus the line after when it ends with a newline). */
function matchLines(text: string, old: string): number[][] {
  const out: number[][] = [];
  const lineAt = (pos: number) => {
    let n = 0;
    for (let i = text.indexOf('\n'); i !== -1 && i < pos; i = text.indexOf('\n', i + 1)) n++;
    return n;
  };
  for (let i = text.indexOf(old); i !== -1 && out.length < 1000; i = text.indexOf(old, i + old.length)) {
    const a = lineAt(i);
    const b = lineAt(i + old.length);
    out.push(Array.from({ length: b - a + 1 }, (_, k) => a + k));
  }
  return out;
}

/**
 * Where each of `paths` goes in `toFolder`: under the same subfolders as below their common parent folder
 * (notes/a/x.md + notes/b/y.md → to/a/x.md + to/b/y.md; all in one folder → to/x.md, as a flat move), or all
 * directly in it (`flat`). Paths are compared as the resolver cleans them; a bad one fails on its own later.
 */
export function batchDestinations(paths: readonly string[], toFolder: string, flat: boolean, win: boolean): string[] {
  const clean = (p: string) => {
    try {
      return cleanPath(p, { win });
    } catch {
      return String(p).replace(/^\/+|\/+$/g, '');
    }
  };
  const keys = paths.map(clean);
  const to = clean(toFolder);
  const join = (rel: string) => (to ? `${to}/${rel}` : rel);
  if (flat) return keys.map((k) => join(k.split('/').pop() ?? k));
  const parents = keys.map((k) => k.split('/').slice(0, -1));
  let common = parents[0] ?? [];
  for (const p of parents.slice(1)) {
    let i = 0;
    while (i < common.length && i < p.length && (win ? common[i].toLowerCase() === p[i].toLowerCase() : common[i] === p[i])) i++;
    common = common.slice(0, i);
  }
  return keys.map((k) => join(k.split('/').slice(common.length).join('/')));
}

/** One move (a file or a folder with its contents): every rule of `move`. Shares `o.group` in a batch. */
async function moveOne(env: ToolEnv, f: Folder, c: WriteCtx, fromArg: unknown, toArg: unknown, o: { update: boolean; group?: string }) {
  const from = await f.resolveTarget(fromArg, { kind: 'any', exists: 'must' });
  const isDir = !!from.st?.isDirectory();
  if (!isDir && (await f.readText(from.key)).binary) throw new ToolError('EINVAL', `Binary file: ${from.key} cannot be moved here`);
  // sameAs: "Note.md" → "note.md" on a case-insensitive folder is a rename, not a clash.
  const to = await f.resolveTarget(toArg, { kind: isDir ? 'dir' : 'file', exists: 'mustNot', sameAs: from.st ?? undefined }).catch((err) => {
    // Folders are not merged: an existing folder of that name stays as it is (its files are never overwritten).
    if (isDir && err instanceof ToolError && err.code === 'EEXIST') throw new ToolError('EEXIST', `${err.message.replace(/^Already exists: /, '')} exists: folders are not merged. Move what ${from.key} holds instead (paths: ${from.key}/…).`);
    throw err;
  });
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
            let rewrite: ((p: string, text: string) => string | null) | null = null;
  let candidates: string[] = [];
  if (o.update) {
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
  const group = o.group ?? env.journal.newGroup();
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
  return { from: from.key, to: to.key, etag: st ? etagOf({ mtime: st.mtimeMs, size: st.size }) : null, group, links, notUpdated };
}

/** Groups being undone right now (two calls for one group never both run). */
const undoing = new Set<string>();

/**
 * undo: a group THIS process made (its answer showed the code), all or nothing, only onto files still as the
 * change left them (journal.ts revertGroupReport, like Revert in One), only in a folder that is still shared and
 * writable. Marked reverted (shared with One's Revert): once only. The answer is a summary, never file content.
 */
async function undoGroup(env: ToolEnv, id: string): Promise<ToolResult> {
  const group = env.journal.ownGroup(id);
  if (!group) throw new ToolError('EACCES', 'only changes from this session can be undone here; use Revert in One');
  if (undoing.has(group)) throw new ToolError('EBUSY', 'That change is being undone already');
  undoing.add(group);
  try {
    const { entries } = await readGroup(env.journal.dir, group).catch((err) => {
      throw err instanceof ToolError && err.code === 'ENOENT' ? new ToolError('ENOENT', 'That change kept no undo copy (undo copies were off): nothing to undo') : err;
    });
    const f = env.pool.list().find((x) => x.root === entries[0].root && x.alias === entries[0].folder);
    if (!f) throw new ToolError('EACCES', 'That folder is no longer shared here: use Revert in One');
    f.checkWritable(); // and again inside each step (Folder.guard)
    env.quota.take();
    const r = await f.use(() => revertGroupReport(f, env.journal.dir, group, (abs) => env.trash(abs)));
    const parts = [r.restored && `${many(r.restored, 'file')} restored`, r.movedBack && `${r.movedBack} moved back`, r.removed && `${r.removed} created ${r.removed === 1 ? 'item' : 'items'} removed`].filter(Boolean);
    const bin = r.inBin.length ? `; folder${r.inBin.length === 1 ? '' : 's'} ${r.inBin.slice(0, 5).join(', ')}${r.inBin.length > 5 ? ' …' : ''}: restore from the ${binWord()}` : '';
    return { content: [{ type: 'text', text: `Undone: ${parts.join(', ') || 'nothing left to change'}${bin}` }], audit: { items: r.n } };
  } finally {
    undoing.delete(group);
  }
}
