// createLinkResolver(...).addFile / removeFile must resolve exactly like a fresh resolver built over
// the resulting file list in the same order (case twins: the first spelling owns the path).
import { describe, expect, it } from 'vitest';
import { createLinkResolver } from '../../../src/shared/wikilinks';

const pool = ['Note.md', 'note.md', 'NOTE.md', 'a/Note.md', 'a/note.md', 'b/c/Note.md', 'Plan.md', 'a/Plan.md', 'img.png', 'a/img.png', 'x.md.md', 'q/x.md', 'Ghost.md', 'z/Ghost.markdown', 'docs/guide.md', 'docs/Guide.md'];
const targets = ['Note', 'note', 'NOTE', 'nOtE', 'a/Note', 'a/note', 'c/Note', 'Note.md', 'note.md', 'Plan', 'plan', 'img.png', 'IMG.PNG', 'x.md', 'x', 'Ghost', 'ghost', 'guide', 'Guide', 'docs/guide', '../Note', './Plan', 'Missing'];
const froms = [undefined, 'README.md', 'a/sub/deep.md', 'a/x.md', 'b/c/y.md', 'docs/z.md'];

describe('mutable link resolver', () => {
  it('random add / remove sequences resolve like a fresh resolver over the resulting list', () => {
    let seed = 7;
    const rnd = (m: number) => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) % m;
    const aliases = new Map([['ghost', ['Ghost.md', 'a/Note.md']]]);
    for (let round = 0; round < 40; round++) {
      const files: string[] = pool.filter(() => rnd(2) === 0);
      const r = createLinkResolver([...files], aliases);
      for (let k = 0; k < 25; k++) {
        const f = pool[rnd(pool.length)];
        const at = files.indexOf(f);
        if (at === -1) {
          files.push(f);
          r.addFile(f);
        } else {
          files.splice(at, 1);
          r.removeFile(f);
        }
        const fresh = createLinkResolver([...files], aliases);
        for (const t of targets) for (const from of froms) expect(r(t, from), `"${t}" from ${from} after ${k} ops, files ${files.join(',')}`).toBe(fresh(t, from));
      }
    }
  });
});
