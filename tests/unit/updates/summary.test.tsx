// @vitest-environment happy-dom
// Settings → Security updates summary: marks, the collapsed package list (250+ rows, filter) and that
// everything from a reply / update-check.json is shown as text, with links only to fixed or rebuilt URLs.
import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { Summary } from '../../../src/renderer/updates/summary';
import { EOL_PAGE, OSV_PAGE, vulnFinding, type CheckSummary, type Finding } from '../../../src/shared/update-check';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-20T12:00:00Z');
const PKGS = Array.from({ length: 260 }, (_, i) => ({ name: `pkg-${String(i).padStart(3, '0')}`, version: `1.${i}.0`, vulns: 0 }));

const base = (o: Partial<CheckSummary> = {}): CheckSummary => ({
  at: NOW - 60_000,
  ms: 1234,
  electron: { version: '45.4.1', latest: '45.4.1', eol: '2027-04-27', supported: true, newestMajor: '46' },
  electronError: null,
  packages: [{ name: 'electron', version: '45.4.1', vulns: 0 }, ...PKGS, { name: 'dompurify', version: '3.4.18', vulns: 1 }],
  packagesError: null,
  ...o,
});
const HOSTILE = '<img src=x onerror="globalThis.__pwned=1">';
const finding: Finding = {
  ...vulnFinding({ id: 'GHSA-aaaa-bbbb-cccc', pkg: 'dompurify', version: '3.4.18' }, { summary: HOSTILE, database_specific: { severity: 'HIGH' }, affected: [{ package: { name: 'dompurify', ecosystem: 'npm' }, ranges: [{ events: [{ fixed: '3.4.19' }] }] }] }),
};

let el: HTMLElement;
const opened: string[] = [];
function mount(s: CheckSummary, findings: Finding[] = [finding]) {
  el = document.createElement('div');
  document.body.append(el);
  opened.length = 0;
  act(() => render(<Summary s={s} findings={findings} open={(u) => opened.push(u)} now={NOW} />, el));
}
const line = (id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement;
const rows = () => [...el.querySelectorAll('[data-testid="updates-package"]')] as HTMLElement[];

afterEach(() => {
  act(() => render(null, el));
  el.remove();
});

describe('Security updates summary', () => {
  it('Electron: shipped, newest patch, support — each with a mark', () => {
    mount(base());
    expect(line('updates-sum-electron').textContent).toContain('45.4.1 (shipped)');
    expect(line('updates-sum-electron').dataset.mark).toBe('ok');
    expect(line('updates-sum-patch').textContent).toContain('45.4.1: up to date');
    expect(line('updates-sum-support').textContent).toContain('Supported until 2027-04-27 (158 days left)');
    expect(line('updates-sum-support').dataset.mark).toBe('ok');
    expect(line('updates-sum-major').dataset.mark).toBe('info');
    act(() => render(null, el));

    mount(base({ electron: { version: '45.4.1', latest: '45.4.3', eol: new Date(NOW + 10 * DAY).toISOString().slice(0, 10), supported: true, newestMajor: null } }));
    expect(line('updates-sum-electron').dataset.mark).toBe('warn');
    expect(line('updates-sum-patch').textContent).toContain('45.4.3: a newer patch is out');
    expect(line('updates-sum-support').dataset.mark).toBe('warn');
    expect(line('updates-sum-support').textContent).toContain('10 days left');
    expect(line('updates-sum-major')).toBeNull();
    act(() => render(null, el));

    mount(base({ electron: { version: '45.4.1', latest: null, eol: null, supported: null, newestMajor: null } }));
    expect(line('updates-sum-patch').dataset.mark).toBe('unknown');
    expect(line('updates-sum-support').textContent).toContain('not listed on endoflife.date');
    act(() => render(null, el));

    mount(base({ electron: { version: '45.4.1', latest: '45.4.1', eol: '2026-11-01', supported: false, newestMajor: '46' } }));
    expect(line('updates-sum-support').dataset.mark).toBe('warn');
    expect(line('updates-sum-support').textContent).toContain('Ended 2026-11-01');
  });

  it('packages: one line with the counts; the list is collapsed by default', () => {
    mount(base());
    expect(line('updates-sum-packages').textContent).toContain('262 packages checked against OSV.dev, 1 with known vulnerabilities');
    expect(line('updates-sum-packages').dataset.mark).toBe('high');
    expect(rows()).toHaveLength(0);
    act(() => (line('updates-packages-toggle') as HTMLButtonElement).click());
    expect(line('updates-packages-toggle').getAttribute('aria-expanded')).toBe('true');
    const all = rows();
    expect(all).toHaveLength(262);
    // The problem first, with severity and fix; then every other package as OK.
    expect(all[0].dataset.mark).toBe('high');
    expect(all[0].textContent).toContain('dompurify3.4.181 known vulnerability');
    expect(all[0].textContent).toContain('GHSA-aaaa-bbbb-cccc · High · fixed in 3.4.19');
    expect(all[1].textContent).toBe('✓electron45.4.1OK');
    expect(all.slice(1).every((r) => r.dataset.mark === 'ok')).toBe(true);
    act(() => (all[0].querySelector('button') as HTMLButtonElement).click());
    expect(opened).toEqual(['https://osv.dev/vulnerability/GHSA-aaaa-bbbb-cccc']);
  });

  it('the filter narrows the list by name or version', () => {
    mount(base());
    act(() => (line('updates-packages-toggle') as HTMLButtonElement).click());
    const filter = line('updates-packages-filter') as HTMLInputElement;
    const type = (v: string) =>
      act(() => {
        filter.value = v;
        filter.dispatchEvent(new Event('input', { bubbles: true }));
      });
    type('PKG-25');
    expect(rows().map((r) => r.querySelector('.se-upd-pkgname')!.textContent)).toEqual(Array.from({ length: 10 }, (_, i) => `pkg-25${i}`));
    type('1.7.0');
    expect(rows()).toHaveLength(1);
    type('nothing-like-this');
    expect(rows()).toHaveLength(0);
    expect(el.textContent).toContain('No package matches “nothing-like-this”');
    act(() => (line('updates-packages-toggle') as HTMLButtonElement).click());
    expect(line('updates-packages-filter')).toBeNull();
  });

  it('nothing found: an OK mark and "none"', () => {
    mount(base({ packages: PKGS }), []);
    expect(line('updates-sum-packages').dataset.mark).toBe('ok');
    expect(line('updates-sum-packages').textContent).toContain('260 packages checked against OSV.dev, none with known vulnerabilities');
  });

  it('a failed half says what failed, in plain words', () => {
    mount(base({ electron: null, electronError: 'No answer in time', packages: null, packagesError: 'Could not reach the update services (offline?)' }), []);
    expect(line('updates-sum-electron').textContent).toContain('Not checked: endoflife.date failed (No answer in time).');
    expect(line('updates-sum-electron').dataset.mark).toBe('warn');
    expect(line('updates-sum-packages').textContent).toContain('Not checked: OSV.dev failed (Could not reach the update services (offline?)).');
    expect(el.textContent).toContain('Findings from the last complete check are kept');
  });

  it('sources and timing; the source links are fixed pages', () => {
    mount(base());
    expect(line('updates-sum-sources').textContent).toBe('Sourcesendoflife.date (Electron releases) · OSV.dev (known vulnerabilities)');
    expect(line('updates-sum-time').textContent).toMatch(/2026.*, took 1\.2 s$/);
    for (const b of line('updates-sum-sources').querySelectorAll('button')) act(() => (b as HTMLButtonElement).click());
    expect(opened).toEqual([EOL_PAGE, OSV_PAGE]);
    act(() => render(null, el));
    mount(base({ ms: 40 }));
    expect(line('updates-sum-time').textContent).toMatch(/took under 0\.1 s$/);
  });

  it('untrusted text stays text: no markup from an advisory, an error or a finding id', () => {
    const odd: Finding = { ...finding, id: `vuln:${HOSTILE}:dompurify@3.4.18`, summary: HOSTILE };
    mount(base({ electronError: HOSTILE, electron: null }), [odd]);
    act(() => (line('updates-packages-toggle') as HTMLButtonElement).click());
    expect(el.querySelector('img')).toBeNull();
    expect((globalThis as { __pwned?: number }).__pwned).toBeUndefined();
    expect(line('updates-sum-electron').textContent).toContain(HOSTILE);
    expect(rows()[0].textContent).toContain(HOSTILE);
    expect(rows()[0].querySelector('button')!.getAttribute('title')).toBe(HOSTILE);
  });
});
