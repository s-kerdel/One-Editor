import { describe, expect, it } from 'vitest';
import { SearchHost } from '../../../src/search/host';
import type { FromWorker } from '../../../src/search/protocol';
import { synthDocs } from './synth';

function setup() {
  const out: FromWorker[] = [];
  const host = new SearchHost((m) => out.push(m), () => new Promise((r) => setTimeout(r, 0)));
  return { host, out };
}
const wait = (pred: () => boolean) =>
  new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => (pred() ? resolve() : Date.now() - t0 > 5000 ? reject(new Error('timeout')) : setTimeout(tick, 2));
    tick();
  });

describe('worker host protocol', () => {
  it('indexes, searches, updates and answers headings', async () => {
    const { host, out } = setup();
    host.handle({ type: 'reset', gen: 1, docs: [{ path: 'a.md', content: '# Hello\nkubectl get pods' }] });
    expect(out[0]).toMatchObject({ type: 'indexed', gen: 1, count: 1 });
    host.handle({ type: 'search', id: 1, channel: 'p', query: 'get pods', options: {} });
    await wait(() => out.some((m) => m.type === 'result'));
    const r = out.find((m) => m.type === 'result') as Extract<FromWorker, { type: 'result' }>;
    expect(r.response.results[0].path).toBe('a.md');
    host.handle({ type: 'upsert', docs: [{ path: 'b.md', content: 'unsaved text typed now' }] });
    host.handle({ type: 'search', id: 2, channel: 'p', query: 'typed now', options: {} });
    await wait(() => out.some((m) => m.type === 'result' && m.id === 2));
    expect((out.find((m) => m.type === 'result' && m.id === 2) as any).response.results[0].path).toBe('b.md');
    host.handle({ type: 'rename', from: 'b.md', to: 'c.md' });
    host.handle({ type: 'remove', paths: ['a.md'] });
    host.handle({ type: 'headings', id: 3, q: { query: '' } });
    expect((out.find((m) => m.type === 'headings') as any).hits).toEqual([]);
    expect(host.engine.paths()).toEqual(['c.md']);
  });

  it('a newer search on the same channel cancels the stale one', async () => {
    const { host, out } = setup();
    host.handle({ type: 'reset', gen: 1, docs: synthDocs(4000) });
    host.handle({ type: 'search', id: 10, channel: 'panel', query: 'deploy server the', options: {} });
    host.handle({ type: 'search', id: 11, channel: 'panel', query: 'kubectl', options: {} });
    host.handle({ type: 'search', id: 12, channel: 'palette', query: 'release', options: {} });
    await wait(() => out.filter((m) => m.type === 'result' || m.type === 'cancelled').length >= 3);
    const byId = (id: number) => out.find((m) => (m.type === 'result' || m.type === 'cancelled') && m.id === id)!.type;
    expect(byId(10)).toBe('cancelled');
    expect(byId(11)).toBe('result');
    expect(byId(12)).toBe('result'); // other channel unaffected
  });

  it('explicit cancel works and errors are reported, not thrown', async () => {
    const { host, out } = setup();
    host.handle({ type: 'reset', gen: 1, docs: synthDocs(4000) });
    host.handle({ type: 'search', id: 20, channel: 'x', query: 'the', options: {} });
    host.handle({ type: 'cancel', id: 20 });
    await wait(() => out.some((m) => (m.type === 'cancelled' || m.type === 'result') && m.id === 20));
    expect(out.find((m) => m.type === 'cancelled' && m.id === 20)).toBeTruthy();
    host.handle({ type: 'search', id: 21, channel: 'x', query: '/(/', options: {} });
    await wait(() => out.some((m) => m.type === 'result' && m.id === 21));
    expect((out.find((m) => m.type === 'result' && m.id === 21) as any).response.error).toMatch(/Invalid regular expression/);
  });
});
