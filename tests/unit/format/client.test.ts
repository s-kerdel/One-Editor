import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('format worker client', () => {
  it('falls back to the main thread when workers are unavailable', async () => {
    vi.stubGlobal('Worker', undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { formatInWorker } = await import('../../../src/format/client');
    const r = await formatInWorker('{"a":1}', { path: 'a.json' });
    expect(r.text).toBe('{ "a": 1 }\n');
    const bad = await formatInWorker('<?php\nfunction (', { path: 'a.php' });
    expect(bad.error?.message).toMatch(/^PHP syntax error at 2:/);
  });

  it('round-trips through a worker and maps crashes', async () => {
    const posted: any[] = [];
    class FakeWorker {
      onmessage: ((e: any) => void) | null = null;
      onerror: ((e: any) => void) | null = null;
      static last: FakeWorker;
      terminated = false;
      constructor() {
        FakeWorker.last = this;
      }
      postMessage(m: any) {
        posted.push(m);
      }
      terminate() {
        this.terminated = true;
      }
    }
    vi.stubGlobal('Worker', FakeWorker);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { formatInWorker } = await import('../../../src/format/client');
    const p1 = formatInWorker('x', { path: 'a.ts', cursorOffset: 1 });
    expect(posted[0]).toMatchObject({ text: 'x', req: { path: 'a.ts', cursorOffset: 1 } });
    FakeWorker.last.onmessage!({ data: { id: posted[0].id, result: { text: 'x;\n', changed: true, language: 'typescript' } } });
    expect((await p1).text).toBe('x;\n');

    // crash after it has worked once → error result, fresh worker next time
    const first = FakeWorker.last;
    const p2 = formatInWorker('y', { path: 'a.ts' });
    first.onerror!({ message: 'boom' });
    expect(await p2).toMatchObject({ text: 'y', changed: false, error: { kind: 'internal', message: 'Formatter crashed: boom' } });
    expect(first.terminated).toBe(true);
    void formatInWorker('z', { path: 'a.ts' });
    expect(FakeWorker.last).not.toBe(first);
  });

  it('times out, returns the input untouched and restarts the worker', async () => {
    vi.useFakeTimers();
    let created = 0;
    let terminated = 0;
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          created++;
        }
        postMessage() {}
        terminate() {
          terminated++;
        }
      },
    );
    const { formatInWorker } = await import('../../../src/format/client');
    const p = formatInWorker('slow', { path: 'a.ts' }, { timeoutMs: 1000 });
    const queued = formatInWorker('behind', { path: 'b.ts' }, { timeoutMs: 60000 });
    await vi.advanceTimersByTimeAsync(11_500); // first call gets +10s to load Prettier
    expect(await p).toMatchObject({ text: 'slow', changed: false, error: { kind: 'timeout' } });
    expect((await queued).error?.kind).toBe('timeout');
    expect(terminated).toBe(1);
    void formatInWorker('again', { path: 'a.ts' });
    expect(created).toBe(2);
  });

  it('reruns queued jobs on the main thread when the worker script cannot start', async () => {
    class DeadWorker {
      onerror: ((e: any) => void) | null = null;
      static last: DeadWorker;
      constructor() {
        DeadWorker.last = this;
      }
      postMessage() {}
      terminate() {}
    }
    vi.stubGlobal('Worker', DeadWorker);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { formatInWorker } = await import('../../../src/format/client');
    const p = formatInWorker('a:    1', { path: 'a.yaml' });
    DeadWorker.last.onerror!({ message: 'failed to load' });
    expect((await p).text).toBe('a: 1\n');
    expect((await formatInWorker('b:   2', { path: 'a.yaml' })).text).toBe('b: 2\n');
  });
});
