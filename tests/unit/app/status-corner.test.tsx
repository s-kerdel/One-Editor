// @vitest-environment happy-dom
// Status-bar corner (`│ MCP · :4317 · ⛨ 3`): far right, fixed order, only what is on; its │ (CSS ::before)
// only exists with something in it. The lazy chunks fill the slots and set each one only while it shows.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { StatusBar, StatusCorner } from '../../../src/renderer/app/StatusBar';
import { mcpIndicator } from '../../../src/renderer/mcp/slot';
import { webServerPill } from '../../../src/renderer/webserver/slot';
import { updatesShield } from '../../../src/renderer/updates/slot';

const Mcp = () => <button data-testid="mcp-indicator">MCP</button>;
const Web = () => <button data-testid="webserver-pill">:4317</button>;
const Shield = () => <button data-testid="updates-shield">3</button>;

function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  return { host, done: () => act(() => render(null, host)) };
}
const corner = (host: Element) => host.querySelector('.se-status-corner');
const order = (host: Element) => [...(corner(host)?.children ?? [])].map((c) => c.getAttribute('data-testid'));

afterEach(() => void ((mcpIndicator.value = null), (webServerPill.value = null), (updatesShield.value = null)));

describe('StatusCorner', () => {
  it('is empty — no corner, so no │ — until something is on', async () => {
    const { host, done } = mount();
    await act(() => render(<StatusCorner />, host));
    expect(host.innerHTML).toBe('');
    await act(() => void (webServerPill.value = Web));
    expect(order(host)).toEqual(['webserver-pill']);
    await act(() => void (webServerPill.value = null));
    expect(corner(host)).toBeNull();
    await done();
  });

  it('keeps the order MCP · web server · shield, whatever arrives first', async () => {
    const { host, done } = mount();
    await act(() => render(<StatusCorner />, host));
    await act(() => void (updatesShield.value = Shield));
    await act(() => void (mcpIndicator.value = Mcp));
    await act(() => void (webServerPill.value = Web));
    expect(order(host)).toEqual(['mcp-indicator', 'webserver-pill', 'updates-shield']);
    // An icon going leaves the others in place (same DOM: no remount, no lost focus).
    const pill = host.querySelector('[data-testid="webserver-pill"]');
    await act(() => void (mcpIndicator.value = null));
    expect(order(host)).toEqual(['webserver-pill', 'updates-shield']);
    expect(host.querySelector('[data-testid="webserver-pill"]')).toBe(pill);
    await act(() => void (updatesShield.value = null));
    expect(order(host)).toEqual(['webserver-pill']);
    await done();
  });

  it('sits at the very end of the status bar, after the open file’s items', async () => {
    const { host, done } = mount();
    await act(() => render(<StatusBar />, host));
    const bar = host.querySelector('.se-status')!;
    expect(corner(bar)).toBeNull();
    await act(() => void ((mcpIndicator.value = Mcp), (updatesShield.value = Shield)));
    expect(bar.lastElementChild?.className).toBe('se-status-corner');
    expect(order(bar)).toEqual(['mcp-indicator', 'updates-shield']);
    // Nothing of the corner is left on the left side (before the spacer) any more.
    const kids = [...bar.children];
    const spacer = kids.findIndex((c) => c.classList.contains('se-status-spacer'));
    const sel = '[data-testid="mcp-indicator"], [data-testid="updates-shield"]';
    expect(spacer).toBeGreaterThan(0);
    expect(kids.slice(0, spacer).some((c) => c.matches(sel) || c.querySelector(sel))).toBe(false);
    await done();
  });

  it('draws its │ as the corner’s ::before (so it goes with the corner)', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../../../src/renderer/styles/app.css'), 'utf8');
    expect(css).toMatch(/\.se-status-corner::before \{ content: ''; width: 1px; height: 14px; background: var\(--border\); \}/);
  });
});
