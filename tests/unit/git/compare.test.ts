// Compare text: `git diff --no-index --histogram` runner + hunk parser (backend), and the renderer's
// pure helpers (git hunks → merge-view changes, built-in fallback, patches).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { diffTexts, parsePatchHunks, COMPARE_MAX_BYTES } from '../../../src/backend/git-compare';
import { gitEnv } from '../../../src/backend/git';
import { BackendService } from '../../../src/backend/service';
import { builtinHunks, formatPatch, hunksToChanges, hunkStats, relabelPatch } from '../../../src/renderer/git/compare-diff';
import { BASE, testEnv, tmpDir } from './helpers';

const runner = async (git = 'git') => {
  const tmpRoot = await tmpDir('compare-tmp');
  return { git: git === 'git' ? (execFileSync('which', ['git'], { encoding: 'utf8' }).trim() as string) : git, env: gitEnv(testEnv()), tmpRoot };
};
const empty = (dir: string) => fs.readdirSync(dir).length === 0;

describe('diffTexts (git --no-index)', () => {
  it('differences → git hunks + a patch that names only "a" / "b"; temp files removed', async () => {
    const r = await runner();
    const a = 'one\ntwo\nthree\nfour\nfive\n';
    const b = 'one\nTWO\nthree\nfour\nfive\nsix\n';
    const res = await diffTexts(r, a, b, {});
    expect(res.engine).toBe('git');
    if (res.engine !== 'git') return;
    expect(res.hunks).toEqual([
      { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 },
      { oldStart: 5, oldCount: 0, newStart: 5, newCount: 1 },
    ]);
    expect(res.patch).toContain('-two\n+TWO\n');
    expect(res.patch).toContain('--- a/a\n+++ b/b');
    expect(res.patch).not.toContain(r.tmpRoot);
    expect(empty(r.tmpRoot)).toBe(true);
  });

  it('identical texts (after CRLF → LF) need no git at all', async () => {
    const r = await runner('/definitely/not/git');
    expect(await diffTexts(r, 'a\r\nb\r\n', 'a\nb\n', {})).toEqual({ engine: 'git', hunks: [], patch: '' });
  });

  it('Ignore whitespace (--ignore-all-space)', async () => {
    const r = await runner();
    const a = 'if (x) {\n  y();\n}\n';
    const b = 'if (x) {\n\ty( );\n}\n';
    expect((await diffTexts(r, a, b, {})) as { hunks: unknown[] }).toMatchObject({ hunks: [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 }] });
    expect(await diffTexts(r, a, b, { ignoreWhitespace: true })).toEqual({ engine: 'git', hunks: [], patch: '' });
  });

  it('unicode and missing trailing newlines', async () => {
    const r = await runner();
    const res = await diffTexts(r, 'ünï 😀\nsame', 'ÜNÏ 😀\nsame\n', {});
    if (res.engine !== 'git') throw new Error(res.reason);
    expect(res.patch).toContain('-ünï 😀');
    expect(res.patch).toContain('+ÜNÏ 😀');
    expect(res.hunks).toEqual([{ oldStart: 0, oldCount: 2, newStart: 0, newCount: 2 }]);
  });

  it('git unavailable or failing → engine "none" (caller falls back); still cleans up', async () => {
    expect(await diffTexts(null, 'a', 'b', {})).toEqual({ engine: 'none', reason: 'git was not found' });
    const bad = path.join(BASE, 'bad-git.sh');
    fs.writeFileSync(bad, '#!/bin/sh\necho "fatal: nope" >&2\nexit 2\n', { mode: 0o755 });
    const r = await runner(bad);
    expect(await diffTexts(r, 'a', 'b', {})).toEqual({ engine: 'none', reason: 'fatal: nope' });
    expect(empty(r.tmpRoot)).toBe(true);
  });

  it('validates input and caps the size', async () => {
    const r = await runner();
    await expect(diffTexts(r, 42, 'b', {})).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(diffTexts(r, 'x'.repeat(COMPARE_MAX_BYTES + 1), 'b', {})).rejects.toMatchObject({ code: 'ETOOBIG' });
    // Multi-byte characters count as bytes, not as string length.
    await expect(diffTexts(r, 'é'.repeat(COMPARE_MAX_BYTES / 2 + 1), 'b', {})).rejects.toMatchObject({ code: 'ETOOBIG' });
  });

  it('through BackendService.git("diffTexts"): no folder needed, temp dir in the config dir', async () => {
    const cfg = await tmpDir('compare-cfg');
    const s = new BackendService(cfg, {}, {}, { env: testEnv() });
    const res = await s.git('diffTexts', 'a\n', 'b\n');
    expect(res).toMatchObject({ engine: 'git', hunks: [{ oldStart: 0, oldCount: 1, newStart: 0, newCount: 1 }] });
    expect(empty(path.join(cfg, 'tmp'))).toBe(true);
    s.dispose();
  });
});

describe('parsePatchHunks', () => {
  it('splits a context hunk into exact -/+ blocks', () => {
    const patch = ['--- a/a', '+++ b/b', '@@ -1,7 +1,7 @@', ' a', '-b', '+B', ' c', ' d', '-e', ' f', '+g', '\\ No newline at end of file'].join('\n');
    expect(parsePatchHunks(patch)).toEqual([
      { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 },
      { oldStart: 4, oldCount: 1, newStart: 4, newCount: 0 },
      { oldStart: 6, oldCount: 0, newStart: 5, newCount: 1 },
    ]);
  });

  it('empty sides and several @@ sections', () => {
    expect(parsePatchHunks('@@ -0,0 +1,2 @@\n+x\n+y\n')).toEqual([{ oldStart: 0, oldCount: 0, newStart: 0, newCount: 2 }]);
    expect(parsePatchHunks('@@ -1,2 +0,0 @@\n-x\n-y\n')).toEqual([{ oldStart: 0, oldCount: 2, newStart: 0, newCount: 0 }]);
    expect(parsePatchHunks('@@ -1 +1 @@\n-a\n+b\n@@ -10,2 +10,2 @@\n x\n-y\n+z\n')).toEqual([
      { oldStart: 0, oldCount: 1, newStart: 0, newCount: 1 },
      { oldStart: 10, oldCount: 1, newStart: 10, newCount: 1 },
    ]);
  });

  it('blank context lines (diff.suppressBlankEmpty) count as context', () => {
    expect(parsePatchHunks('@@ -1,3 +1,3 @@\n\n-b\n+B\n c\n')).toEqual([{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 }]);
  });
});

describe('renderer helpers', () => {
  it('hunksToChanges: blocks at the right offsets, word-level inside', () => {
    const a = 'keep\nthe quick fox\nkeep\n';
    const b = 'keep\nthe slow fox\nkeep\nnew\n';
    const changes = hunksToChanges(a, b, [
      { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 },
      { oldStart: 3, oldCount: 0, newStart: 3, newCount: 1 },
    ]);
    const shown = changes.map((c) => [a.slice(c.fromA, c.toA), b.slice(c.fromB, c.toB)]);
    expect(shown).toEqual([
      ['quick', 'slow'],
      ['', 'new\n'],
    ]);
  });

  it('built-in fallback: line hunks, optional whitespace blindness, stats', () => {
    expect(builtinHunks('a\nb\nc', 'a\nB\nc')).toEqual([{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 }]);
    expect(builtinHunks('a\n  b\nc', 'a\n\tb \nc', true)).toEqual([]);
    expect(hunkStats([{ oldStart: 0, oldCount: 2, newStart: 0, newCount: 3 }])).toEqual({ added: 3, removed: 2 });
  });

  it('formatPatch output is a patch git can apply', async () => {
    const a = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const lines = a.split('\n');
    lines[2] = 'changed 2';
    lines.splice(20, 1);
    lines.splice(25, 0, 'inserted');
    const b = lines.join('\n');
    const patch = formatPatch(a, b, builtinHunks(a, b), 'x', 'x');
    const dir = await tmpDir('compare-apply');
    fs.writeFileSync(path.join(dir, 'x'), a);
    fs.writeFileSync(path.join(dir, 'p.diff'), patch);
    execFileSync('git', ['apply', '--unidiff-zero', 'p.diff'], { cwd: dir, env: testEnv() });
    expect(fs.readFileSync(path.join(dir, 'x'), 'utf8')).toBe(b);
  });

  it('relabelPatch rewrites only the header', () => {
    const p = 'diff --git a/a b/b\nindex 1..2 100644\n--- a/a\n+++ b/b\n@@ -1 +1 @@\n--- a dash line\n+++ a plus line\n';
    expect(relabelPatch(p, 'notes/x.md · lines 3–4', 'Clipboard')).toBe('--- a/notes/x.md · lines 3–4\n+++ b/Clipboard\n@@ -1 +1 @@\n--- a dash line\n+++ a plus line\n');
  });
});
