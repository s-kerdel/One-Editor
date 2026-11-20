// Version + build details at the bottom of the Settings nav (and "Copy" for bug reports).
// Lives in the lazy Settings chunk. Commit / date come from the packaging script (scripts/stage.mjs);
// a local `npm run build` shows "dev".
import { useEffect, useState } from 'preact/hooks';
import { BRAND } from '@shared/brand';
import { version } from '../../../package.json';
import { app } from './app';
import { Icon } from './icons';

export interface BuildInfo {
  version: string;
  commit: string;
  date: string;
  mode: 'desktop' | 'browser';
  electron?: string;
  chromium?: string;
  platform: string;
}

export function buildInfo(ua = typeof navigator === 'undefined' ? '' : navigator.userAgent): BuildInfo {
  const env = import.meta.env as Record<string, string | undefined>;
  return {
    version,
    commit: env.VITE_SEC_EDIT_COMMIT || 'dev',
    date: env.VITE_SEC_EDIT_BUILD_DATE || '',
    // The preload bridge exists only in the desktop app.
    mode: typeof window !== 'undefined' && (window as any).secEditBridge ? 'desktop' : 'browser',
    electron: /Electron\/([\d.]+)/.exec(ua)?.[1],
    chromium: /Chrome\/([\d.]+)/.exec(ua)?.[1],
    platform: osName(app.backend?.os ?? 'unknown'),
  };
}

const OS_NAMES: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
/** "win32" is Node's name for Windows of any bitness: show what people call it. */
export const osName = (os: string) => OS_NAMES[os] ?? os;

/** CPU architecture ("x64", "arm64") from Chromium's client hints; undefined where unsupported. Desktop only:
 *  in browser mode it would describe the viewing machine, not the one serving the folder. */
export async function cpuArch(): Promise<string | undefined> {
  const uad = (navigator as any).userAgentData;
  try {
    const v = await uad?.getHighEntropyValues?.(['architecture', 'bitness']);
    if (v?.architecture === 'x86') return v.bitness === '64' ? 'x64' : 'x86';
    if (v?.architecture === 'arm') return v.bitness === '64' ? 'arm64' : 'arm';
  } catch {
    /* no client hints: show the OS only */
  }
  return undefined;
}

export function buildInfoText(b: BuildInfo = buildInfo()): string {
  return [
    `${BRAND} ${b.version} (${b.mode})`,
    `commit ${b.commit}${b.date ? ` · built ${b.date}` : ''}`,
    [b.electron && `Electron ${b.electron}`, b.chromium && `Chromium ${b.chromium}`, `platform ${b.platform}`].filter(Boolean).join(' · '),
  ].join('\n');
}

export function BuildFooter() {
  const [arch, setArch] = useState<string | undefined>();
  const base = buildInfo();
  const b = arch ? { ...base, platform: `${base.platform} · ${arch}` } : base;
  useEffect(() => void (b.mode === 'desktop' && cpuArch().then(setArch)), []);
  const [copied, setCopied] = useState(false);
  const text = buildInfoText(b);
  return (
    <div class="se-prefs-build" data-testid="settings-build" title={text}>
      <div class="se-prefs-build-row">
        <span class="se-prefs-build-name">
          {BRAND} {b.version}
        </span>
        <button
          class="se-icon-btn tiny"
          aria-label="Copy build info"
          title={copied ? 'Copied' : 'Copy build info'}
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          <Icon name={copied ? 'check' : 'copy'} size={12} />
        </button>
      </div>
      <div class="se-prefs-build-meta">
        {b.commit}
        {b.date && ` · ${b.date.slice(0, 10)}`}
      </div>
      <div class="se-prefs-build-meta">{[b.electron && `Electron ${b.electron}`, b.mode === 'browser' && 'browser mode', b.platform].filter(Boolean).join(' · ')}</div>
    </div>
  );
}
