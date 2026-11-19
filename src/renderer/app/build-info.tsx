// Version + build details at the bottom of the Settings nav (and "Copy" for bug reports).
// Lives in the lazy Settings chunk. Commit / date come from the packaging script (scripts/stage.mjs);
// a local `npm run build` shows "dev".
import { useState } from 'preact/hooks';
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
    platform: app.backend?.os ?? 'unknown',
  };
}

export function buildInfoText(b: BuildInfo = buildInfo()): string {
  return [
    `sec-edit ${b.version} (${b.mode})`,
    `commit ${b.commit}${b.date ? ` · built ${b.date}` : ''}`,
    [b.electron && `Electron ${b.electron}`, b.chromium && `Chromium ${b.chromium}`, `platform ${b.platform}`].filter(Boolean).join(' · '),
  ].join('\n');
}

export function BuildFooter() {
  const b = buildInfo();
  const [copied, setCopied] = useState(false);
  const text = buildInfoText(b);
  return (
    <div class="se-prefs-build" data-testid="settings-build" title={text}>
      <div class="se-prefs-build-row">
        <span class="se-prefs-build-name">sec-edit {b.version}</span>
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
