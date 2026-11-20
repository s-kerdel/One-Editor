// Shown when no tab is open: open-folder / recent folders without a workspace, quick actions with one.
import { app } from './app';
import * as ui from './ui';
import { addIcons, Icon } from './icons';
import './welcome.css';
import { prettyKey, runCommand, getCommand } from './commands';
import { openWorkspace } from './documents';
import { BRAND } from '@shared/brand';

// Icons only this lazily loaded chunk draws (see addIcons).
addIcons({ history: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8|M3 3v5h5|M12 7v5l4 2', keyboard: 'M2 6h20v12H2z|M6 10h.01|M10 10h.01|M14 10h.01|M18 10h.01|M7 14h10' });
import { newNote } from './fileops';

const SHORTCUTS: Array<[string, string]> = [
  ['Mod-p', 'Quick open'],
  ['Mod-Shift-p', 'Command palette'],
  ['Mod-n', 'New note'],
  ['Mod-Shift-f', 'Search in files'],
  ['Mod-e', 'Toggle reading view'],
  ['Mod-\\', 'Split editor / preview'],
  ['Mod-Shift-b', 'Toggle sidebar'],
  ['Mod-,', 'Settings'],
];

function folderName(p: string) {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

/** Keeps the informative end of long paths: "…/projects/notes". */
function shortPath(p: string, max = 34) {
  return p.length <= max ? p : `…${p.slice(p.length - max + 1)}`;
}

function Keys({ k }: { k: string }) {
  return (
    <span class="se-keys">
      {prettyKey(k)
        .split(/\+(?=.)/)
        .map((part) => (
          <kbd>{part}</kbd>
        ))}
    </span>
  );
}

export function Welcome() {
  const ws = app.workspace.value;
  const recent = ui.recentFolders.value.filter((r) => r !== ws?.root).slice(0, 7);
  return (
    <div class="se-welcome" data-testid="welcome">
      <div class="se-welcome-inner">
        <div class="se-welcome-brand">
          {/* Same artwork as the app / taskbar icon (build/icon.svg → npm run icons). */}
          <img class="se-logo" src="./icon.png" alt="" width={56} height={56} draggable={false} />
          <div class="se-welcome-head">
            <h1 class="se-brand-lockup" aria-label={ws ? `${BRAND} — ${ws.name}` : BRAND}>
              <span class="se-brand-name">{BRAND}</span>
              {ws && (
                <>
                  <span class="se-brand-sep" aria-hidden="true">
                    ::
                  </span>
                  <span class="se-brand-slug" title={ws.name}>
                    {ws.name}
                  </span>
                </>
              )}
            </h1>
            <p class="se-welcome-sub">{ws ? ws.root : 'Code, Markdown and PDFs: one editor, straight from your folders.'}</p>
          </div>
        </div>

        <div class="se-welcome-actions">
          {ws ? (
            <>
              <button class="se-btn primary" onClick={() => newNote()}>
                <Icon name="filePlus" size={16} /> New note
              </button>
              {getCommand('palette.files') && (
                <button class="se-btn" onClick={() => void runCommand('palette.files')}>
                  <Icon name="search" size={16} /> Quick open
                </button>
              )}
              <button class="se-btn" onClick={() => void runCommand('workspace.open')}>
                <Icon name="folderOpen" size={16} /> Open another folder
              </button>
            </>
          ) : (
            <button class="se-btn primary large" onClick={() => void runCommand('workspace.open')} data-testid="open-folder">
              <Icon name="folderOpen" size={18} /> Open folder
            </button>
          )}
        </div>

        <div class="se-welcome-cols">
          {recent.length > 0 && (
            <section class="se-welcome-section">
              <h2>
                <Icon name="history" size={14} /> Recent folders
              </h2>
              <ul class="se-recent">
                {recent.map((r) => (
                  <li>
                    <button class="se-recent-item" title={r} onClick={() => void openWorkspace(r).catch((err) => app.toast(String(err.message || err), 'error'))}>
                      <Icon name="folder" size={15} />
                      <span class="se-recent-name">{folderName(r)}</span>
                      <span class="se-recent-path">{shortPath(r)}</span>
                    </button>
                    <button
                      class="se-icon-btn tiny se-recent-forget"
                      title="Remove from list"
                      aria-label={`Remove ${folderName(r)} from recent folders`}
                      onClick={async () => (ui.recentFolders.value = await app.backend.forgetRecent(r))}
                    >
                      <Icon name="close" size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section class="se-welcome-section">
            <h2>
              <Icon name="keyboard" size={14} /> Shortcuts
            </h2>
            <ul class="se-shortcuts">
              {SHORTCUTS.map(([k, label]) => (
                <li>
                  <span>{label}</span>
                  <Keys k={k} />
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

export { Keys };
