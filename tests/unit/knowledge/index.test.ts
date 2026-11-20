import { describe, expect, it } from 'vitest';
import { KnowledgeIndex, findHeadingLine, makeSnippet } from '../../../src/knowledge/index';
import { buildGraph, ForceSim } from '../../../src/knowledge/graph';

function build(files: Record<string, string>) {
  const idx = new KnowledgeIndex();
  idx.setFiles(Object.keys(files));
  for (const [p, t] of Object.entries(files)) idx.update(p, t);
  return idx;
}

const ws = {
  'README.md': '# Welcome\n\n- [[Daily notes]] link\n- also [the cheatsheet](notes/kubernetes.md#Pods) and [[K8s]]\n\n#tag/project #idea',
  'notes/Daily notes.md': '---\ntags: [journal, daily]\n---\n# Daily notes\n\n- [x] Fix bug in [[README]]\n- [ ] see [[Missing note]] and [[missing NOTE|again]]\n\nkubernetes is nice. So is Kube.\n',
  'notes/kubernetes.md': '---\naliases: [K8s, Kube]\ntags: tag/ops\n---\n# Kubernetes cheatsheet\n\n## Pods\n\ntext ^blk1\n\n## Rollouts & more\n',
  'deep/Deep note.md': 'Mentions [[kubernetes#Pods]] and ![[diagram.png]] plus `kubernetes` code and https://kubernetes.io\n\nWelcome to the readme of [[README|the readme]].',
  'notes/img/diagram.png': '',
  'code/app.ts': 'const kubernetes = 1; // [[README]]',
};

describe('KnowledgeIndex queries', () => {
  const idx = build(ws);

  it('resolves names, paths, headings and aliases', () => {
    expect(idx.resolve('daily notes', 'README.md')).toBe('notes/Daily notes.md');
    expect(idx.resolve('kubernetes#Pods')).toBe('notes/kubernetes.md');
    expect(idx.resolve('K8s', 'README.md')).toBe('notes/kubernetes.md');
    expect(idx.resolve('kube')).toBe('notes/kubernetes.md');
    expect(idx.resolve('diagram.png')).toBe('notes/img/diagram.png');
    expect(idx.resolve('#Local', 'README.md')).toBe('README.md');
    expect(idx.resolve('Nope')).toBeNull();
  });

  it('lists backlinks with line and highlighted context', () => {
    const b = idx.backlinks('notes/Daily notes.md');
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ from: 'README.md', line: 2 });
    expect(b[0].context.text).toBe('- [[Daily notes]] link');
    expect(b[0].context.text.slice(b[0].context.start, b[0].context.end)).toBe('[[Daily notes]]');
  });

  it('counts wiki, alias and markdown links as backlinks; ignores non-markdown sources', () => {
    const b = idx.backlinks('notes/kubernetes.md');
    expect(b.map((x) => [x.from, x.link.kind, x.link.target])).toEqual([
      ['deep/Deep note.md', 'wiki', 'kubernetes'],
      ['README.md', 'md', 'notes/kubernetes.md'],
      ['README.md', 'wiki', 'K8s'],
    ]);
    expect(idx.backlinks('README.md').map((x) => x.from)).toEqual(['deep/Deep note.md', 'notes/Daily notes.md']);
    expect(idx.backlinks('notes/img/diagram.png').map((x) => x.from)).toEqual(['deep/Deep note.md']);
  });

  it('finds unlinked mentions of title and aliases, skipping links, code and URLs', () => {
    const m = idx.unlinkedMentions('notes/kubernetes.md');
    expect(m.map((x) => [x.from, x.line, x.text])).toEqual([
      ['notes/Daily notes.md', 8, 'kubernetes'],
      ['notes/Daily notes.md', 8, 'Kube'],
    ]);
    expect(m[0].context.text.slice(m[0].context.start, m[0].context.end)).toBe('kubernetes');
    // "readme" in Deep note is plain text once, and once inside a link alias (not counted).
    expect(idx.unlinkedMentions('README.md').map((x) => [x.from, x.text])).toEqual([['deep/Deep note.md', 'readme']]);
    expect(idx.unlinkedMentions('nope.md')).toEqual([]);
  });

  it('does not match mentions inside longer words', () => {
    const i2 = build({ 'Art.md': '', 'b.md': 'Start the party. art! smart ART_x (Art)' });
    expect(i2.unlinkedMentions('Art.md').map((x) => x.text)).toEqual(['art', 'Art']);
  });

  it('reports outgoing and unresolved links', () => {
    expect(idx.outgoing('README.md').map((o) => o.path)).toEqual(['notes/Daily notes.md', 'notes/kubernetes.md', 'notes/kubernetes.md']);
    expect(idx.outgoing('notes/Daily notes.md').map((o) => o.path)).toEqual(['README.md', null, null]);
    const u = idx.unresolvedLinks();
    expect(u).toHaveLength(1);
    expect(u[0].target).toBe('Missing note');
    expect(u[0].sources.map((s) => [s.from, s.line])).toEqual([['notes/Daily notes.md', 6], ['notes/Daily notes.md', 6]]);
  });

  it('builds a hierarchical tag tree with counts', () => {
    expect(idx.tags()).toEqual([
      { name: 'daily', tag: 'daily', count: 1, children: [] },
      { name: 'idea', tag: 'idea', count: 1, children: [] },
      { name: 'journal', tag: 'journal', count: 1, children: [] },
      { name: 'tag', tag: 'tag', count: 2, children: [
        { name: 'ops', tag: 'tag/ops', count: 1, children: [] },
        { name: 'project', tag: 'tag/project', count: 1, children: [] },
      ] },
    ]);
    expect(idx.notesWithTag('tag')).toEqual(['notes/kubernetes.md', 'README.md']);
    expect(idx.notesWithTag('#tag/project')).toEqual(['README.md']);
    expect(idx.notesWithTag('ta')).toEqual([]);
    expect(idx.tagLine('README.md', 'idea')).toBe(5);
  });

  it('exposes headings and anchors', () => {
    expect(idx.headings('notes/kubernetes.md').map((h) => [h.level, h.text, h.line])).toEqual([[1, 'Kubernetes cheatsheet', 4], [2, 'Pods', 6], [2, 'Rollouts & more', 10]]);
    expect(idx.findAnchor('notes/kubernetes.md', { heading: 'pods' })).toBe(6);
    expect(idx.findAnchor('notes/kubernetes.md', { heading: 'Rollouts more' })).toBe(10);
    expect(idx.findAnchor('notes/kubernetes.md', { heading: 'Kubernetes cheatsheet#Pods' })).toBe(6);
    expect(idx.findAnchor('notes/kubernetes.md', { block: 'blk1' })).toBe(8);
    expect(idx.findAnchor('notes/kubernetes.md', { heading: 'nope' })).toBeNull();
    expect(findHeadingLine([], 'x')).toBeNull();
  });

  it('keeps markdown links strict (no fuzzy basename match)', () => {
    const i2 = build({ 'a/x.md': '[k](kubernetes.md) [ok](../b/kubernetes.md) [abs](/b/kubernetes.md) [noext](../b/kubernetes)', 'b/kubernetes.md': '' });
    expect(i2.outgoing('a/x.md').map((o) => o.path)).toEqual([null, 'b/kubernetes.md', 'b/kubernetes.md', 'b/kubernetes.md']);
  });
});

describe('incremental updates', () => {
  it('reflects edits, new files, deletions and alias changes', () => {
    const idx = build(ws);
    let changes = 0;
    idx.onChange(() => changes++);
    const v = idx.version;
    expect(idx.update('README.md', ws['README.md'])).toBe(false); // identical → no churn
    expect(idx.version).toBe(v);

    idx.update('README.md', '# Welcome\nno links now #newtag');
    expect(idx.backlinks('notes/Daily notes.md')).toEqual([]);
    expect(idx.notesWithTag('idea')).toEqual([]);
    expect(idx.notesWithTag('newtag')).toEqual(['README.md']);
    expect(changes).toBe(1);

    idx.update('notes/Missing note.md', '# now exists');
    expect(idx.unresolvedLinks()).toEqual([]);
    expect(idx.backlinks('notes/Missing note.md')).toHaveLength(2);

    idx.remove('notes/Missing note.md');
    expect(idx.unresolvedLinks()).toHaveLength(1);
    expect(idx.note('notes/Missing note.md')).toBeUndefined();

    idx.update('notes/kubernetes.md', '---\naliases: [Missing note]\n---\n');
    expect(idx.resolve('missing note')).toBe('notes/kubernetes.md');
    expect(idx.resolve('K8s')).toBeNull();
    expect(idx.unresolvedLinks()).toEqual([]);
  });

  it('renames files and folders, keeping content indexed', () => {
    const idx = build(ws);
    expect([...idx.rename('notes/kubernetes.md', 'notes/k8s-guide.md')]).toEqual([['notes/kubernetes.md', 'notes/k8s-guide.md']]);
    expect(idx.note('notes/kubernetes.md')).toBeUndefined();
    expect(idx.note('notes/k8s-guide.md')?.title).toBe('k8s-guide');
    expect(idx.resolve('K8s')).toBe('notes/k8s-guide.md'); // alias survives
    expect(idx.resolve('kubernetes')).toBeNull();

    const moved = idx.rename('notes', 'journal');
    expect(moved.get('notes/Daily notes.md')).toBe('journal/Daily notes.md');
    expect(moved.get('notes/img/diagram.png')).toBe('journal/img/diagram.png');
    expect(idx.resolve('Daily notes')).toBe('journal/Daily notes.md');
    expect(idx.backlinks('journal/Daily notes.md').map((b) => b.from)).toEqual(['README.md']);
    expect(idx.files().some((f) => f.startsWith('notes/'))).toBe(false);
  });

  // setFiles registers a new note's aliases; the update that follows must not register them again.
  it('drops aliases of a note added through setFiles before its first update', () => {
    const idx = new KnowledgeIndex();
    idx.setFiles(['a.md']);
    idx.update('a.md', '[[Ghost]]');
    idx.backlinks('a.md');
    idx.setFiles(['a.md', 'n.md']);
    idx.update('n.md', '---\naliases: [Ghost]\n---\n# new');
    idx.remove('n.md');
    expect(idx.outgoing('a.md').map((o) => o.path)).toEqual([null]);
    expect(idx.resolve('Ghost')).toBeNull();

    const j = new KnowledgeIndex();
    j.setFiles(['a.md']);
    j.update('a.md', '[[Ghost]]');
    j.backlinks('a.md');
    j.setFiles(['a.md', 'n.md']);
    j.update('n.md', '---\naliases: [Ghost]\n---\n# new');
    j.update('n.md', '# alias removed');
    expect(j.outgoing('a.md').map((o) => o.path)).toEqual([null]);
  });

  it('incremental patches match a full rebuild', () => {
    const idx = build(ws);
    idx.backlinks('README.md'); // force derived state so later updates take the patch path
    const steps: Array<[string, string]> = [
      ['README.md', '[[Kube]] [[Ghost]] [[Daily notes]] #a'],
      ['notes/kubernetes.md', '---\naliases: [Ghost]\n---\n[[README]]'],
      ['notes/Daily notes.md', '---\naliases: [Ghost, Kube]\n---\n[[ghost]] [[nowhere]]'],
      ['notes/kubernetes.md', 'no aliases [[nowhere]]'],
      ['deep/Deep note.md', '[[Ghost]] [x](../README.md) [[nowhere]]'],
      ['notes/Daily notes.md', 'plain'],
    ];
    const current: Record<string, string> = { ...ws };
    for (const [p, t] of steps) {
      idx.update(p, t);
      current[p] = t;
      const fresh = build(current);
      for (const f of Object.keys(current)) {
        expect(idx.backlinks(f), `backlinks ${f} after ${p}`).toEqual(fresh.backlinks(f));
        expect(idx.outgoing(f).map((o) => o.path), `outgoing ${f} after ${p}`).toEqual(fresh.outgoing(f).map((o) => o.path));
      }
      expect(idx.unresolvedLinks()).toEqual(fresh.unresolvedLinks());
      expect(idx.tags()).toEqual(fresh.tags());
    }
  });

  it('prunes notes missing from a fresh file list', () => {
    const idx = build(ws);
    idx.prune(['README.md']);
    expect(idx.notes().map((n) => n.path)).toEqual(['README.md']);
    expect(idx.unresolvedLinks().map((u) => u.target).sort()).toEqual(['Daily notes', 'K8s', 'notes/kubernetes.md']);
  });
});

describe('makeSnippet', () => {
  it('truncates long lines around the match', () => {
    const line = `${'a '.repeat(200)}[[Target]]${' b'.repeat(200)}`;
    const s = makeSnippet(line, 400, 10);
    expect(s.text.length).toBeLessThanOrEqual(162);
    expect(s.text.slice(s.start, s.end)).toBe('[[Target]]');
    expect(s.text.startsWith('…') && s.text.endsWith('…')).toBe(true);
  });
  it('accounts for trimmed indentation', () => {
    const s = makeSnippet('    - see [[X]]', 10, 5);
    expect(s.text.slice(s.start, s.end)).toBe('[[X]]');
  });
});

describe('graph', () => {
  const idx = build(ws);
  it('builds nodes and deduped edges', () => {
    const g = buildGraph(idx);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['README.md', 'deep/Deep note.md', 'notes/Daily notes.md', 'notes/kubernetes.md']);
    expect(g.edges.length / 2).toBe(4); // README–Daily, README–k8s, Deep–k8s, Deep–README
    expect(g.nodes.find((n) => n.id === 'README.md')!.degree).toBe(3);
  });
  it('adds tag / unresolved nodes and filters', () => {
    const g = buildGraph(idx, { showTags: true, showUnresolved: true });
    expect(g.nodes.filter((n) => n.kind === 'tag').map((n) => n.label).sort()).toEqual(['#daily', '#idea', '#journal', '#tag/ops', '#tag/project']);
    expect(g.nodes.filter((n) => n.kind === 'unresolved').map((n) => n.label)).toEqual(['Missing note']);
    expect(buildGraph(idx, { filter: 'tag:journal' }).nodes.map((n) => n.id)).toEqual(['notes/Daily notes.md']);
    expect(buildGraph(idx, { filter: 'deep' }).nodes.map((n) => n.id)).toEqual(['deep/Deep note.md']);
    const i2 = build({ ...ws, 'lonely.md': 'nothing' });
    expect(buildGraph(i2).nodes).toHaveLength(5);
    expect(buildGraph(i2, { showOrphans: false }).nodes).toHaveLength(4);
  });
  it('builds a local graph by depth', () => {
    const d1 = buildGraph(idx, { local: { path: 'notes/Daily notes.md', depth: 1 } });
    expect(d1.nodes.map((n) => n.id).sort()).toEqual(['README.md', 'notes/Daily notes.md']);
    const d2 = buildGraph(idx, { local: { path: 'notes/Daily notes.md', depth: 2 } });
    expect(d2.nodes).toHaveLength(4);
    expect(buildGraph(idx, { local: { path: 'nope.md', depth: 2 } }).nodes).toEqual([]);
  });
  // Timing budget: retried so a burst of CPU contention from the parallel suite can't fail it; a real regression fails every attempt.
  it('simulation converges to finite, separated positions', { retry: 2 }, () => {
    const n = 400;
    const edges: number[] = [];
    for (let i = 1; i < n; i++) edges.push(i, Math.floor(i / 3));
    const sim = new ForceSim(n, edges);
    const t0 = performance.now();
    for (let i = 0; i < 300 && !sim.settled; i++) sim.tick();
    const ms = performance.now() - t0;
    expect(sim.settled).toBe(true);
    let minD = Infinity;
    for (let i = 0; i < n; i++) {
      expect(Number.isFinite(sim.x[i]) && Number.isFinite(sim.y[i])).toBe(true);
      for (let j = i + 1; j < n; j++) minD = Math.min(minD, Math.hypot(sim.x[i] - sim.x[j], sim.y[i] - sim.y[j]));
    }
    expect(minD).toBeGreaterThan(1);
    const b = sim.bounds();
    expect(b.maxX - b.minX).toBeLessThan(5000);
    expect(ms).toBeLessThan(3000);
  });
  it('handles coincident points and pinned nodes', () => {
    const sim = new ForceSim(50, [0, 1]);
    sim.x.fill(5);
    sim.y.fill(5);
    sim.fixed[0] = 1;
    for (let i = 0; i < 50; i++) sim.tick();
    expect(sim.x[0]).toBe(5);
    expect([...sim.x].every(Number.isFinite)).toBe(true);
    expect(new Set([...sim.x].map((v) => v.toFixed(2))).size).toBeGreaterThan(10);
  });
});

describe('unresolved links: incremental groups and the top-N query', () => {
  // Skewed link counts (many ties), case variants of one target, edits that add / remove / re-resolve.
  function vault(n: number): Record<string, string> {
    const files: Record<string, string> = {};
    for (let i = 0; i < n; i++) {
      const links = [`[[Missing ${i % 7}]]`, `[[missing ${i % 5}]]`, `[[Gap ${(i * 13) % 97}]]`, `[[Note ${(i * 7) % n}]]`, `[x](../nowhere/${i % 31}.md)`, i % 3 ? `[[Solo ${i}]]` : ''];
      files[`f${i % 9}/Note ${i}.md`] = `# Note ${i}\n${links.join(' ')}\nline two [[Missing ${i % 7}]]`;
    }
    return files;
  }
  const expectTopN = (idx: KnowledgeIndex) => {
    const all = idx.unresolvedLinks();
    expect(idx.unresolvedCount()).toBe(all.length);
    for (const k of [1, 3, 10, 50, 120, all.length - 1, all.length, all.length + 5]) expect(idx.unresolvedLinks(k), `top ${k}`).toEqual(all.slice(0, k));
  };

  it('top-N is exactly the head of the full order; count matches; stays so through edits', () => {
    const files = vault(400);
    const idx = build(files);
    expectTopN(idx);
    const steps: Array<[string, string | null]> = [
      ['f1/Note 10.md', '# Note 10\n[[Missing 3]] [[Brand new gap]] [[MISSING 3]]'],
      ['f2/Note 11.md', '# Note 11\nno links any more'],
      ['f0/Missing 3.md', '# now it exists'], // resolves a popular target (new file → re-derive)
      ['f3/Note 12.md', null], // removed
      ['f1/Note 10.md', '# Note 10\n[[Solo 10]] [[solo 10]] [[Gap 5]]'],
    ];
    const current: Record<string, string> = { ...files };
    for (const [p, t] of steps) {
      if (t === null) {
        idx.remove(p);
        delete current[p];
      } else {
        idx.update(p, t);
        current[p] = t;
      }
      const fresh = build(current);
      expect(fresh.unresolvedCount(), `count before any list (scan path) after ${p}`).toBe(fresh.unresolvedLinks().length);
      expect(idx.unresolvedLinks(), `incremental == fresh after ${p}`).toEqual(fresh.unresolvedLinks());
      expectTopN(idx);
    }
  });
});

describe('tag tree cache', () => {
  it('is shared while tags are unchanged and rebuilt on every kind of tag change', () => {
    const idx = build({ 'a.md': '#x/y text', 'b.md': '---\ntags: [x, z]\n---\nbody', 'c.md': 'no tags' });
    const first = idx.tags();
    idx.update('a.md', '#x/y text, edited without touching tags');
    idx.update('c.md', 'still no tags');
    expect(idx.tags(), 'plain edits keep the cached tree').toBe(first);
    const steps: Array<[string, () => void]> = [
      ['tag added', () => idx.update('c.md', 'now #new')],
      ['tag removed', () => idx.update('a.md', 'text only')],
      ['frontmatter tags changed', () => idx.update('b.md', '---\ntags: [x/deep]\n---\nbody')],
      ['note removed', () => idx.remove('c.md')],
      ['note renamed', () => void idx.rename('b.md', 'moved/b.md')],
      ['cleared', () => idx.clear()],
    ];
    let prev = idx.tags();
    for (const [what, step] of steps) {
      step();
      const now = idx.tags();
      expect(now, what).not.toBe(prev);
      const current = Object.fromEntries(idx.files().filter((f) => idx.text(f) !== undefined).map((f) => [f, idx.text(f)!]));
      expect(now, `${what}: same as a fresh index`).toEqual(build(current).tags());
      prev = now;
    }
  });
});

describe('file-set changes re-resolve only what they can affect (incremental == fresh)', () => {
  // Every resolver rule in play: case twins + "exact spelling wins", same name in several folders
  // (same folder first, then shallowest / shortest), aliases (dangling links they satisfy, competing
  // aliases), markdown relative links (exact paths only), attachments, ./ and ../ targets, path-like
  // targets, `name.md` targets, a `.md.md` file, empty (self) targets.
  const start: Record<string, string> = {
    'README.md': '[[Note]] [[note]] [[NOTE]] [[a/Note]] [[Ghost]] [[img.png]] [[Plan.md]] [[x.md]] [[]] [rel](docs/guide.md) [img](assets/pic.png) [[a\\sub\\Deep]] [[a/sub/.]] [[deep/er/missing/..]]',
    'a/Note.md': '---\naliases: [Ghost]\n---\n[[Note]] [[../README]] [[./sub/Deep]] [[sub/Deep]] [up](../README.md)',
    'b/note.md': '[[Note]] [[Plan]] [[Missing]] [[Ghost]] [x](../c/plan.md)',
    'a/sub/Deep.md': '[[Plan]] [[Note]] [[../Note]] [[..]]',
    'docs/guide.md': '[[Plan]] [[img.png]] [[guide]] [[Twin]]',
    'assets/pic.png': '',
  };
  const ops: Array<[string, (idx: KnowledgeIndex, cur: Record<string, string>) => void]> = [
    ['create a closer same-name note', (i, c) => void i.update((c['a/Plan.md'] = '# plan in a', 'a/Plan.md'), c['a/Plan.md'])],
    ['create the exact-spelling twin', (i, c) => void i.update((c['note.md'] = 'root twin', 'note.md'), c['note.md'])],
    ['create the other twin spelling', (i, c) => void i.update((c['Note.md'] = 'Root Twin [[Twin]]', 'Note.md'), c['Note.md'])],
    ['create a note that satisfies a dangling link', (i, c) => void i.update((c['deep/er/Missing.md'] = 'found', 'deep/er/Missing.md'), c['deep/er/Missing.md'])],
    ['create a note with a competing alias', (i, c) => void i.update((c['Ghostly.md'] = '---\naliases: [ghost, Twin]\n---\nboo', 'Ghostly.md'), c['Ghostly.md'])],
    ['create a note named like an alias (name beats alias)', (i, c) => void i.update((c['z/Ghost.md'] = 'real ghost', 'z/Ghost.md'), c['z/Ghost.md'])],
    ['add an attachment through update', (i, c) => void i.update((c['img.png'] = '', 'img.png'), '')],
    ['create a .md.md note', (i, c) => void i.update((c['q/x.md.md'] = 'odd', 'q/x.md.md'), c['q/x.md.md'])],
    ['create the md-link target', (i, c) => void i.update((c['c/plan.md'] = 'c plan', 'c/plan.md'), c['c/plan.md'])],
    ['delete the picked candidate', (i, c) => (delete c['a/Plan.md'], i.remove('a/Plan.md'))],
    ['delete one twin', (i, c) => (delete c['note.md'], i.remove('note.md'))],
    ['delete the aliased note', (i, c) => (delete c['a/Note.md'], i.remove('a/Note.md'))],
    ['rename a note (links follow or break as fresh says)', (i, c) => ((c['b/Plan.md'] = c['b/note.md']), delete c['b/note.md'], void i.rename('b/note.md', 'b/Plan.md'))],
    ['rename a folder', (i, c) => {
      for (const k of Object.keys(c)) if (k.startsWith('a/')) (c[`moved/${k.slice(2)}`] = c[k]), delete c[k];
      void i.rename('a', 'moved');
    }],
    ['file list adds and drops attachments', (i, c) => {
      delete c['assets/pic.png'];
      c['docs/img.png'] = '';
      i.setFiles(Object.keys(c));
    }],
    ['prune a note the tree lost', (i, c) => (delete c['docs/guide.md'], i.prune(Object.keys(c)))],
    ['re-create a deleted name in another folder', (i, c) => void i.update((c['e/Note.md'] = 'e', 'e/Note.md'), c['e/Note.md'])],
  ];

  const compare = (idx: KnowledgeIndex, cur: Record<string, string>, what: string) => {
    const fresh = build(cur);
    for (const f of Object.keys(cur)) {
      expect(idx.outgoing(f).map((o) => o.path), `outgoing ${f} after: ${what}`).toEqual(fresh.outgoing(f).map((o) => o.path));
      expect(idx.backlinks(f), `backlinks ${f} after: ${what}`).toEqual(fresh.backlinks(f));
    }
    expect(idx.unresolvedLinks(), `unresolved after: ${what}`).toEqual(fresh.unresolvedLinks());
    expect(idx.unresolvedCount(), `unresolved count after: ${what}`).toBe(fresh.unresolvedLinks().length);
  };

  it('each create / delete / rename step, queried after every step', () => {
    const cur = { ...start };
    const idx = build(cur);
    compare(idx, cur, 'start');
    for (const [what, op] of ops) {
      op(idx, cur);
      compare(idx, cur, what);
    }
  });

  it('several steps batched before the next query (one resolver rebuild)', () => {
    const cur = { ...start };
    const idx = build(cur);
    idx.backlinks('README.md'); // derived
    for (let k = 0; k < ops.length; k += 3) {
      for (const [, op] of ops.slice(k, k + 3)) op(idx, cur);
      compare(idx, cur, `batch ${k}`);
    }
  });

  it('edits interleaved with pending file changes resolve against the current file set', () => {
    const cur = { ...start };
    const idx = build(cur);
    idx.backlinks('README.md');
    idx.update((cur['n/New.md'] = 'new', 'n/New.md'), cur['n/New.md']); // pending: added
    idx.update('docs/guide.md', (cur['docs/guide.md'] = '[[New]] [[Plan]]')); // edit before any query
    idx.remove('b/note.md'); // pending: removed
    delete cur['b/note.md'];
    idx.update('README.md', (cur['README.md'] = '[[note]] [[New]]'));
    compare(idx, cur, 'interleaved');
  });
});

describe('time-sliced derive (scheduleDerive)', () => {
  function vault(n: number): Record<string, string> {
    const files: Record<string, string> = {};
    for (let i = 0; i < n; i++) files[`f${i % 7}/Note ${i}.md`] = `---\naliases: [Al ${i % 50}]\n---\n[[Note ${(i * 7) % n}]] [[Al ${(i * 3) % 50}]] [[Gone ${i % 11}]] [up](../f${(i + 1) % 7}/Note%20${(i + 2) % n}.md)`;
    return files;
  }
  const sliced = (files: Record<string, string>) => {
    const steps: Array<() => boolean> = [];
    const idx = new KnowledgeIndex({ scheduleDerive: (step) => void steps.push(step) });
    idx.setFiles(Object.keys(files));
    for (const [p, t] of Object.entries(files)) idx.update(p, t);
    return { idx, steps };
  };
  const finish = (steps: Array<() => boolean>) => {
    let n = 0;
    while (steps.length) {
      const step = steps[0];
      if (step()) steps.shift();
      if (++n > 1e6) throw new Error('derive never finished');
    }
    return n;
  };
  const same = (idx: KnowledgeIndex, cur: Record<string, string>) => {
    const fresh = build(cur);
    for (const f of Object.keys(cur)) expect(idx.backlinks(f), `backlinks ${f}`).toEqual(fresh.backlinks(f));
    expect(idx.unresolvedLinks()).toEqual(fresh.unresolvedLinks());
  };

  it('queries during the derive see partial links, never block; complete == fresh; listeners told once done', () => {
    const cur = vault(3000);
    const { idx, steps } = sliced(cur);
    let told = 0;
    idx.onChange(() => told++);
    idx.warm();
    expect(idx.deriving).toBe(true);
    expect(steps).toHaveLength(1);
    const first = idx.backlinks('f0/Note 0.md'); // partial: no throw, no full derive
    expect(idx.deriving).toBe(true);
    expect(steps[0]()).toBe(false); // one slice, not the whole derive
    const slices = finish(steps);
    expect(slices).toBeGreaterThan(1);
    expect(idx.deriving).toBe(false);
    expect(told).toBe(1);
    expect(first.length).toBeLessThanOrEqual(idx.backlinks('f0/Note 0.md').length);
    same(idx, cur);
  });

  it('edits, new notes, deletions and renames during the derive', () => {
    const cur = vault(1500);
    const { idx, steps } = sliced(cur);
    idx.warm();
    steps[0]();
    idx.update('f1/Note 1.md', (cur['f1/Note 1.md'] = '[[Note 2]] [[Gone 3]] [[Brand new]]'));
    idx.update((cur['n/Brand new.md'] = '---\naliases: [Al 7]\n---\n[[Note 5]]', 'n/Brand new.md'), cur['n/Brand new.md']);
    steps[0]();
    idx.remove('f2/Note 2.md');
    delete cur['f2/Note 2.md'];
    idx.rename('f3/Note 3.md', 'f3/Renamed.md');
    cur['f3/Renamed.md'] = cur['f3/Note 3.md'];
    delete cur['f3/Note 3.md'];
    finish(steps);
    same(idx, cur);
  });

  it('completeDerive() finishes on demand', () => {
    const cur = vault(800);
    const { idx } = sliced(cur);
    idx.warm();
    idx.completeDerive();
    expect(idx.deriving).toBe(false);
    same(idx, cur);
  });
});

describe('file changes that touch many notes fall back to a re-derive', () => {
  const hubVault = () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 1000; i++) files[`n/Note ${i}.md`] = `[[Hub]] [[Note ${(i + 1) % 1000}]]`;
    return files;
  };
  it('sync: creating a note 1,000 notes link to (over the re-link cap) == fresh', () => {
    const cur = hubVault();
    const idx = build(cur);
    idx.backlinks('n/Note 0.md');
    idx.update((cur['Hub.md'] = '# hub', 'Hub.md'), cur['Hub.md']);
    expect(idx.backlinks('Hub.md')).toHaveLength(1000);
    expect(idx.backlinks('Hub.md')).toEqual(build(cur).backlinks('Hub.md'));
    idx.remove('Hub.md');
    delete cur['Hub.md'];
    expect(idx.unresolvedLinks()).toEqual(build(cur).unresolvedLinks());
  });
  it('sliced: the fallback re-derives in steps and ends == fresh', () => {
    const cur = hubVault();
    const steps: Array<() => boolean> = [];
    const idx = new KnowledgeIndex({ scheduleDerive: (s) => void steps.push(s) });
    idx.setFiles(Object.keys(cur));
    for (const [p, t] of Object.entries(cur)) idx.update(p, t);
    idx.completeDerive();
    steps.length = 0;
    idx.update((cur['Hub.md'] = '# hub', 'Hub.md'), cur['Hub.md']);
    idx.backlinks('Hub.md'); // the query applies the change: over the cap → a new sliced derive
    expect(idx.deriving).toBe(true);
    while (steps.length) if (steps[0]()) steps.shift();
    expect(idx.deriving).toBe(false);
    expect(idx.backlinks('Hub.md')).toEqual(build(cur).backlinks('Hub.md'));
  });
});

describe('time-sliced derive: the open note', () => {
  it("a note's own outgoing links are exact while the derive is still running", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 2000; i++) files[`n/Note ${i}.md`] = `[[Note ${(i * 13) % 2000}]] [[Missing ${i % 9}]]`;
    const steps: Array<() => boolean> = [];
    const idx = new KnowledgeIndex({ scheduleDerive: (s) => void steps.push(s) });
    idx.setFiles(Object.keys(files));
    for (const [p, t] of Object.entries(files)) idx.update(p, t);
    idx.warm();
    expect(idx.deriving).toBe(true);
    const fresh = build(files);
    for (const p of ['n/Note 1999.md', 'n/Note 1500.md']) {
      expect(idx.outgoing(p).map((o) => o.path)).toEqual(fresh.outgoing(p).map((o) => o.path));
      expect(idx.linksFrom(p)).toEqual(fresh.linksFrom(p));
    }
    expect(idx.deriving).toBe(true); // answered without finishing the derive
    while (steps.length) if (steps[0]()) steps.shift();
    expect(idx.backlinks('n/Note 1999.md')).toEqual(fresh.backlinks('n/Note 1999.md'));
  });
});
