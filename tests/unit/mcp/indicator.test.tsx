// @vitest-environment happy-dom
// Status-bar MCP icon (src/renderer/mcp/indicator.tsx): shown while MCP is on, muted without an app,
// green with one (a count from two), one tooltip line per app, a ~1 s pulse on each new call.
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import type { McpSession, McpStatus } from '../../../src/shared/mcp';
import { NO_MCP_STATUS } from '../../../src/shared/mcp';
import { PULSE_MS, TITLE_SESSIONS, install, mcpTitle, newCall, take } from '../../../src/renderer/mcp/indicator';
import { mcpIndicator } from '../../../src/renderer/mcp/slot';

const T0 = Date.UTC(2026, 10, 21, 12, 0);
const sess = (client: string, lastCall: number | null, idle = false, started = T0 - 60_000): McpSession => ({ client, started, lastCall, idle });
const on = (sessions: McpSession[] = []): McpStatus => ({ ...NO_MCP_STATUS, enabled: true, sessions });
const time = (t: number) => `@${(t - T0) / 1000}s`;

describe('mcpTitle', () => {
  it('on, no app connected', () => {
    expect(mcpTitle([])).toBe('MCP server on · no app connected');
  });
  it('one line per app: last call, idle, or no call yet', () => {
    expect(mcpTitle([sess('LM Studio', T0 + 4000)], time)).toBe('LM Studio connected · last call @4s');
    expect(mcpTitle([sess('LM Studio', T0, true), sess('Codex CLI', null)], time)).toBe('LM Studio connected · idle\nCodex CLI connected · no calls yet');
  });
  it(`up to ${TITLE_SESSIONS} lines, then "+N more"`, () => {
    const five = ['A', 'B', 'C', 'D', 'E'].map((c, i) => sess(c, T0 + i * 1000));
    expect(mcpTitle(five, time).split('\n')).toEqual(['A connected · last call @0s', 'B connected · last call @1s', 'C connected · last call @2s', '+2 more']);
    expect(mcpTitle(five.slice(0, 3), time).split('\n')).toHaveLength(3);
  });
  it('the default clock prints hours and minutes', () => {
    expect(mcpTitle([sess('X', new Date(2026, 10, 21, 12, 4).getTime())])).toMatch(/^X connected · last call .*12.04/);
  });
});

describe('newCall (pulse trigger)', () => {
  it('pulses when any app made a newer call', () => {
    expect(newCall([sess('A', T0)], [sess('A', T0 + 5000)])).toBe(true);
    expect(newCall([sess('A', T0)], [sess('A', T0), sess('B', T0 + 1)])).toBe(true);
    expect(newCall([sess('A', null)], [sess('A', T0)])).toBe(true);
  });
  it('not for the first status, the same status, a new app without calls, an app leaving or going idle', () => {
    expect(newCall(null, [sess('A', T0)])).toBe(false);
    expect(newCall([sess('A', T0)], [sess('A', T0)])).toBe(false);
    expect(newCall([sess('A', T0)], [sess('A', T0), sess('B', null)])).toBe(false);
    expect(newCall([sess('A', T0), sess('B', T0 + 9)], [sess('A', T0)])).toBe(false);
    expect(newCall([sess('A', T0)], [sess('A', T0, true)])).toBe(false);
    expect(newCall([], [])).toBe(false);
  });
});

describe('Indicator', () => {
  afterEach(() => vi.useRealTimers());

  async function mounted(slot = mcpIndicator) {
    const host = document.createElement('div');
    document.body.append(host);
    const Slot = () => {
      const C = slot.value;
      return C ? <C /> : null;
    };
    await act(() => render(<Slot />, host));
    const btn = () => host.querySelector<HTMLButtonElement>('[data-testid="mcp-indicator"]');
    return { host, btn, done: () => act(() => render(null, host)) };
  }

  it('off: no slot; on: muted "MCP"; connected: green + count from two; off again: gone', async () => {
    const { btn, done } = await mounted();
    await act(() => take({ ...NO_MCP_STATUS }));
    expect(mcpIndicator.value).toBeNull();
    expect(btn()).toBeNull();

    await act(() => take(on()));
    expect(btn()!.dataset.state).toBe('on');
    expect(btn()!.textContent).toBe('MCP');
    expect(btn()!.title).toBe('MCP server on · no app connected');
    expect(btn()!.querySelectorAll('path').length).toBeGreaterThan(0); // the plug glyph is registered

    await act(() => take(on([sess('LM Studio', null)])));
    expect(btn()!.dataset.state).toBe('live');
    expect(btn()!.querySelector('[data-testid="mcp-indicator-count"]')).toBeNull();
    expect(btn()!.title).toBe('LM Studio connected · no calls yet');
    expect(btn()!.getAttribute('aria-label')).toBe('MCP server: 1 app connected. Recent activity');

    await act(() => take(on([sess('LM Studio', null), sess('Codex CLI', null)])));
    expect(btn()!.querySelector('[data-testid="mcp-indicator-count"]')!.textContent).toBe('2');

    await act(() => take({ ...NO_MCP_STATUS, sessions: [sess('LM Studio', null)] }));
    expect(mcpIndicator.value).toBeNull();
    expect(btn()).toBeNull();
    await done();
  });

  it(`pulses for ${PULSE_MS} ms on a new call, not on the first status`, async () => {
    vi.useFakeTimers();
    // A fresh module: this window's first status (earlier tests left one behind).
    vi.resetModules();
    const fresh = await import('../../../src/renderer/mcp/indicator');
    const { mcpIndicator: freshSlot } = await import('../../../src/renderer/mcp/slot');
    const take = fresh.take;
    const { btn, done } = await mounted(freshSlot);
    await act(() => take(on([sess('LM Studio', T0)])));
    expect(btn()!.hasAttribute('data-pulse')).toBe(false);
    await act(() => take(on([sess('LM Studio', T0)]))); // same call again: no news
    expect(btn()!.hasAttribute('data-pulse')).toBe(false);
    await act(() => take(on([sess('LM Studio', T0 + 5000)])));
    expect(btn()!.hasAttribute('data-pulse')).toBe(true);
    await act(() => void vi.advanceTimersByTime(PULSE_MS - 50));
    expect(btn()!.hasAttribute('data-pulse')).toBe(true);
    await act(() => void vi.advanceTimersByTime(100));
    expect(btn()!.hasAttribute('data-pulse')).toBe(false);
    await done();
  });

  it('the pulse is an animation that reduced motion switches off', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../../../src/renderer/mcp/indicator.css'), 'utf8');
    expect(css).toContain(".se-mcp-ind[data-pulse] { animation: se-mcp-pulse 1s ease-out; }");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.se-mcp-ind\[data-pulse\] \{ animation: none; \} \}/);
  });

  it('install(): first answer + pushes from main over secEditBridge.mcp; nothing without the bridge', async () => {
    await act(() => take({ ...NO_MCP_STATUS }));
    install(); // browser build: no bridge, no subscription
    let push: ((s: unknown) => void) | null = null;
    const bridge = { status: vi.fn(async () => ({ ok: true, result: on() })), onChange: vi.fn((cb: (s: unknown) => void) => ((push = cb), () => {})) };
    (globalThis as any).secEditBridge = { mcp: bridge };
    try {
      install();
      install(); // idempotent
      expect(bridge.onChange).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(mcpIndicator.value).not.toBeNull());
      await act(() => push!({ ...NO_MCP_STATUS }));
      expect(mcpIndicator.value).toBeNull();
    } finally {
      delete (globalThis as any).secEditBridge;
    }
  });
});
