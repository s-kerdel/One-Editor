// Regression tests for bugs found by the QA journeys (tests/e2e/journey-search.spec.ts).
import { describe, expect, it } from 'vitest';
import { parseQuery } from '../../../src/search/query';
import { engineWith, hitTexts, paths, rows } from '../search/helpers';

const F = '```';
const SHELL = ['# Shell', '', F + 'bash', 'grep -rn "TODO" . | wc -l', 'rm -rf ./node_modules/*', 'tar -xzf a.tar.gz > /dev/null 2>&1', F, '', 'Run `npm run build` before pushing to **main** today.', ''].join('\n');

describe('pasted commands: bare punctuation terms do not create noise rows', () => {
  const e = engineWith({ 'shell.md': SHELL, 'decoy.md': 'grep -rn "FIXME" . | wc -c\n' });

  it('grep -rn "TODO" . | wc -l → one row (the command), not every line containing a dot', () => {
    const r = e.search('grep -rn "TODO" . | wc -l');
    expect(rows(r)).toEqual(['shell.md:3:code/bash:grep -rn "TODO" . | wc -l']);
  });

  it('opening the hit selects the whole pasted command, not only its first word', () => {
    const m = e.search('rm -rf ./node_modules/*').results[0].matches[0];
    expect([m.line, m.col, m.length]).toEqual([4, 0, 'rm -rf ./node_modules/*'.length]);
    const single = e.search('node_modules').results[0].matches[0];
    expect([single.col, single.length]).toEqual([9, 12]);
  });

  it('punctuation terms are still required for a file to match', () => {
    expect(paths(e.search('grep | wc'))).toEqual(['decoy.md', 'shell.md'].sort());
    expect(paths(e.search('rm -rf | wc'))).toEqual(['shell.md']); // both lines exist, "|" is present
    expect(paths(e.search('FIXME >'))).toEqual([]); // decoy.md has no ">"
  });

  it('a punctuation-only query still lists its hits', () => {
    expect(rows(e.search('2>&1'))).toEqual(['shell.md:5:code/bash:2>&1']);
    expect(hitTexts(e.search('|'))).toEqual(['|', '|']);
    expect(hitTexts(e.search('> |'))).toEqual(expect.arrayContaining(['>', '|']));
  });
});

describe('phrases span inline Markdown markers', () => {
  const e = engineWith({ 'shell.md': SHELL, 'code.c': 'char *p = 0;\n' });

  it('"build before pushing" finds "`npm run build` before pushing"', () => {
    const r = e.search('"build before pushing"');
    expect(rows(r)).toEqual(['shell.md:8:inline-code:build` before pushing']);
  });

  it('works across bold markers and for an unquoted multi-word query (single highlighted range)', () => {
    expect(hitTexts(e.search('"pushing to main today"'))).toEqual(['pushing to **main** today']);
    expect(hitTexts(e.search('run build before'))).toContain('run build` before');
  });

  it('exact occurrences win; code files are never matched loosely', () => {
    expect(hitTexts(e.search('"npm run build"'))).toEqual(['npm run build']);
    expect(paths(e.search('"char p"'))).toEqual([]);
    expect(paths(e.search('"build pushing"', { fuzzy: false }))).toEqual([]);
  });
});

describe('a command that exists word for word lists only its exact occurrences', () => {
  const K8S = ['# K8s', '', F + 'sh', 'kubectl get pods --all-namespaces -o wide', 'kubectl logs -f deployment/api --since=10m', F, '', 'Restart with `kubectl rollout restart deployment/web`.', ''].join('\n');
  const e = engineWith({ 'k8s.md': K8S, 'other.md': 'logs of the api deployment: use kubectl, flag -f\n' });

  it('kubectl logs -f deployment/api → the one line, not every kubectl line of that file', () => {
    const r = e.search('kubectl logs -f deployment/api');
    expect(rows(r)).toEqual(['k8s.md:4:code/sh:kubectl logs -f deployment/api']);
    expect(r.results[0].totalMatches).toBe(1);
    expect(r.totalMatches).toBe(1);
  });

  it('without a word-for-word occurrence all terms are still matched anywhere in the file', () => {
    const r = e.search('kubectl api logs');
    expect(paths(r).sort()).toEqual(['k8s.md', 'other.md']);
    expect(r.results.find((x) => x.path === 'k8s.md')!.matches.map((m) => m.line)).toEqual([3, 4, 7]);
  });
});

describe('quotes in the middle of a pasted command', () => {
  const DOCKER = 'docker run --rm -it -v "$PWD":/app -w /app node:20 npm test';
  const e = engineWith({ 'ops.md': ['# Ops', '', F + 'bash', 'make test', DOCKER, 'npm run lint', F, ''].join('\n') });

  it('the query text keeps touching tokens glued ("$PWD":/app)', () => {
    expect(parseQuery('-v "$PWD":/app').text).toBe('-v "$PWD":/app');
    expect(parseQuery('a  "b c"   d path:x e').text).toBe('a "b c" d e');
  });

  it('is still recognised as a word-for-word occurrence: one row, one highlight', () => {
    const r = e.search(DOCKER);
    expect(rows(r)).toEqual([`ops.md:4:code/bash:${DOCKER}`]);
    expect(hitTexts(e.search('-v "$PWD":/app'))).toEqual(['-v "$PWD":/app']);
  });
});
