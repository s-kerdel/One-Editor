// Settings → Security updates: what the last check looked at, line by line (lazy updates-ui chunk only).
// Everything shown came from a reply or from update-check.json: rendered as text, never as markup. The only
// links are the two fixed source pages and Finding.url (rebuilt by main from the advisory id / version).
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { EOL_PAGE, EOL_WARN_DAYS, OSV_PAGE, compareVersions, daysUntil, majorOf, type CheckSummary, type Finding, type PackageCheck } from '@shared/update-check';

export const when = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export const SEVERITY_LABEL: Record<string, string> = { CRITICAL: 'Critical', HIGH: 'High', MODERATE: 'Moderate', LOW: 'Low', UNKNOWN: 'Severity unknown' };

type Mark = 'ok' | 'warn' | 'high' | 'unknown' | 'info' | 'none';
const GLYPH: Record<Mark, string> = { ok: '✓', warn: '!', high: '!', unknown: '?', info: 'i', none: '' };
const SAY: Record<Mark, string> = { ok: 'OK', warn: 'Warning', high: 'Problem', unknown: 'Unknown', info: 'Note', none: '' };

const secs = (ms: number) => (ms < 100 ? 'under 0.1 s' : `${(ms / 1000).toFixed(1)} s`);
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const vulns = (n: number) => (n === 1 ? '1 known vulnerability' : `${n} known vulnerabilities`);
/** "GHSA-…" from a vuln finding's id (`vuln:<id>:<pkg>@<version>`). */
const advisory = (f: Finding) => f.id.split(':')[1] ?? '';

function Line(p: { mark: Mark; label: string; testid: string; children: ComponentChildren }) {
  return (
    <li class="se-upd-line" data-mark={p.mark} data-testid={p.testid}>
      <span class="se-upd-mark" role={p.mark === 'none' ? undefined : 'img'} aria-label={SAY[p.mark] || undefined}>
        {GLYPH[p.mark]}
      </span>
      <span class="se-upd-key">{p.label}</span>
      <span class="se-upd-val">{p.children}</span>
    </li>
  );
}

function Electron({ s, now }: { s: CheckSummary; now: number }) {
  const e = s.electron;
  if (!e) {
    return (
      <Line mark="warn" label="Electron" testid="updates-sum-electron">
        Not checked: endoflife.date failed ({s.electronError ?? 'no answer'}).
      </Line>
    );
  }
  const major = majorOf(e.version);
  const behind = !!e.latest && compareVersions(e.latest, e.version) > 0;
  const days = e.eol ? daysUntil(e.eol, now) : NaN;
  const support: [Mark, string] =
    e.supported === null
      ? ['unknown', `Electron ${major} is not listed on endoflife.date`]
      : e.supported === false || days <= 0
        ? ['warn', `Ended${e.eol ? ` ${e.eol}` : ''}: no more security fixes`]
        : e.eol
          ? [days <= EOL_WARN_DAYS ? 'warn' : 'ok', `Supported until ${e.eol} (${plural(days, 'day')} left)`]
          : ['ok', 'Supported, no end date announced'];
  return (
    <>
      <Line mark={behind ? 'warn' : 'ok'} label="Electron" testid="updates-sum-electron">
        {e.version} (shipped)
      </Line>
      <Line mark={e.latest ? (behind ? 'warn' : 'ok') : 'unknown'} label="Newest patch" testid="updates-sum-patch">
        {e.latest ? `${e.latest}: ${behind ? 'a newer patch is out' : 'up to date'}` : `not listed for Electron ${major}`}
      </Line>
      <Line mark={support[0]} label="Support" testid="updates-sum-support">
        {support[1]}
      </Line>
      {e.newestMajor && (
        <Line mark="info" label="Newer major" testid="updates-sum-major">
          Electron {e.newestMajor} (no hurry while {major} is supported)
        </Line>
      )}
    </>
  );
}

function PackageRow({ p, found, open }: { p: PackageCheck; found: Finding[]; open: (url: string) => void }) {
  const mark: Mark = p.vulns === 0 ? 'ok' : found.some((f) => f.level === 'high') ? 'high' : 'warn';
  return (
    <li class="se-upd-pkg" data-mark={mark} data-testid="updates-package">
      <span class="se-upd-mark" role="img" aria-label={SAY[mark]}>
        {GLYPH[mark]}
      </span>
      <span class="se-upd-pkgname">{p.name}</span>
      <span class="se-upd-ver">{p.version}</span>
      <span class="se-upd-pkgok">{p.vulns === 0 ? 'OK' : vulns(p.vulns)}</span>
      {p.vulns > 0 && (
        <span class="se-upd-pkgstate">
          {found.map((f) => (
            <button key={f.id} class="se-link-btn" title={f.summary} onClick={() => open(f.url)}>
              {advisory(f)} · {SEVERITY_LABEL[f.severity ?? 'UNKNOWN']} · {f.fixed ? `fixed in ${f.fixed}` : 'no fix listed'}
            </button>
          ))}
          {/* More advisories than rows kept (MAX_FINDINGS): the count above still says how many. */}
          {p.vulns > found.length && <span>{found.length ? `+${p.vulns - found.length} more` : 'details not kept'}</span>}
        </span>
      )}
    </li>
  );
}

function Packages({ s, findings, open }: { s: CheckSummary; findings: Finding[]; open: (url: string) => void }) {
  const [shown, setShown] = useState(false);
  const [q, setQ] = useState('');
  const list = s.packages;
  if (!list) {
    return (
      <Line mark="warn" label="Packages" testid="updates-sum-packages">
        Not checked: OSV.dev failed ({s.packagesError ?? 'no answer'}).
      </Line>
    );
  }
  const byPkg = new Map<string, Finding[]>();
  for (const f of findings) if (f.kind === 'vuln') byPkg.set(`${f.pkg}@${f.version}`, [...(byPkg.get(`${f.pkg}@${f.version}`) ?? []), f]);
  const found = (p: PackageCheck) => byPkg.get(`${p.name}@${p.version}`) ?? [];
  const bad = list.filter((p) => p.vulns > 0);
  const needle = q.trim().toLowerCase();
  // Problems first, then the build's own order (Electron, then alphabetical).
  const rows = shown ? [...bad, ...list.filter((p) => p.vulns === 0)].filter((p) => !needle || `${p.name}@${p.version}`.toLowerCase().includes(needle)) : [];
  return (
    <>
      <Line mark={bad.length ? (bad.some((p) => found(p).some((f) => f.level === 'high')) ? 'high' : 'warn') : 'ok'} label="Packages" testid="updates-sum-packages">
        {plural(list.length, 'package')} checked against OSV.dev, {bad.length ? `${bad.length} with known vulnerabilities` : 'none with known vulnerabilities'}
      </Line>
      <li class="se-upd-line se-upd-pkgs">
        <span />
        <span />
        <span class="se-upd-val">
          <button class="se-link-btn" aria-expanded={shown} data-testid="updates-packages-toggle" onClick={() => setShown(!shown)}>
            {shown ? 'Hide the list' : `Show all ${list.length} packages`}
          </button>
          {shown && (
            <>
              <input class="se-input se-upd-filter" type="search" placeholder={`Filter ${list.length} packages`} aria-label="Filter packages" data-testid="updates-packages-filter" value={q} onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} />
              <ul class="se-upd-pkglist" data-testid="updates-packages">
                {rows.map((p) => (
                  <PackageRow key={`${p.name}@${p.version}`} p={p} found={found(p)} open={open} />
                ))}
              </ul>
              {!rows.length && <p class="se-upd-note">No package matches “{q}”.</p>}
            </>
          )}
        </span>
      </li>
    </>
  );
}

/** The summary block; `findings` = the status's rows (details of each vulnerable package). */
export function Summary({ s, findings, open, now = Date.now() }: { s: CheckSummary; findings: Finding[]; open: (url: string) => void; now?: number }) {
  return (
    <div class="se-upd-summary" data-testid="updates-summary">
      <ul class="se-upd-lines">
        <Electron s={s} now={now} />
        <Packages s={s} findings={findings} open={open} />
        <Line mark="none" label="Sources" testid="updates-sum-sources">
          <button class="se-link-btn" title={EOL_PAGE} onClick={() => open(EOL_PAGE)}>
            endoflife.date
          </button>{' '}
          (Electron releases) ·{' '}
          <button class="se-link-btn" title={OSV_PAGE} onClick={() => open(OSV_PAGE)}>
            OSV.dev
          </button>{' '}
          (known vulnerabilities)
        </Line>
        <Line mark="none" label="Checked" testid="updates-sum-time">
          {when(s.at)}, took {secs(s.ms)}
        </Line>
      </ul>
      {(s.electronError || s.packagesError) && <p class="se-upd-note">Findings from the last complete check are kept until a check works again.</p>}
    </div>
  );
}
