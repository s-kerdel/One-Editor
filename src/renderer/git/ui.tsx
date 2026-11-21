// Git UI pieces for the shell: status-bar branch item (+ its menu) and file-tree row marks.
// Rendered by StatusBar / FileTree (phase 2 wiring); both render nothing while git is unavailable.
import type { GitBranch } from '@shared/git';
import { app } from '../app/app';
import * as ui from '../app/ui';
import { Icon, addIcons } from '../app/icons';
import { copyText } from '../app/fileops';
import type { GitStore } from './store';
import { openFileDiff } from './diff-open';
import { markResolved, stage, unstage } from './actions';
import { compareEnabled } from './compare-menu';
import { git } from './rpc';

// gitBranch comes with the startup stub (the panel pill needs it at first paint).
addIcons({
  gitCompare: 'M18 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6z|M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z|M13 6h3a2 2 0 0 1 2 2v7|M11 18H8a2 2 0 0 1-2-2V9',
  minus: 'M5 12h14',
  undo: 'M9 14 4 9l5-5|M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  gitCommit: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z|M3 12h6|M15 12h6',
  arrowUp: 'M12 19V5|m5 12 7-7 7 7',
  arrowDown: 'M12 5v14|m19 12-7 7-7-7',
  sparkle: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z|M19 17l.6 1.4L21 19l-1.4.6L19 21l-.6-1.4L17 19l1.4-.6z',
});

/** "Stop trusting this folder": git is off here again (nothing in the folder changes). */
export async function stopTrusting(store: GitStore) {
  if (!(await ui.confirmDialog('Stop trusting this folder?', 'Git will be switched off in this folder: no status, marks, change bars or source control until you trust it again. Your files and the repository are not changed.', 'Stop trusting'))) return;
  await git('untrust').catch((err) => app.toast(String(err?.message ?? err), 'error'));
  store.reset();
}

const openPane = () => {
  app.sidebarVisible.value = true;
  app.sidebarPanel.value = 'git';
};

/** Branch name, short commit id when detached, or a hint before the first commit. */
export function branchLabel(b: GitBranch): string {
  return b.head ?? (b.oid ? b.oid.slice(0, 7) : 'no commits');
}

function branchTitle(b: GitBranch, changed: number): string {
  const lines = [b.detached ? `Detached HEAD at ${b.oid?.slice(0, 12)}` : `Branch ${b.head}`];
  if (b.upstream) lines.push(`${b.ahead} ahead, ${b.behind} behind ${b.upstream}`);
  lines.push(changed ? `${changed} changed ${changed === 1 ? 'file' : 'files'}` : 'No uncommitted changes');
  return lines.join('\n');
}

export function branchMenuItems(store: GitStore, active: string | null): ui.MenuItem[] {
  const s = store.status.peek();
  if (!s?.ok) return [];
  const b = s.branch;
  const count = store.marks.peek().count;
  const on = store.changesOnly.peek();
  const items: ui.MenuItem[] = [
    b.head
      ? { label: 'Copy branch name', icon: 'copy', run: () => copyText(b.head!, 'Branch name') }
      : { label: 'Copy commit id', icon: 'copy', disabled: !b.oid, run: () => copyText(b.oid!, 'Commit id') },
    {
      label: on ? 'Show all files' : count ? `Show changes (${count})` : 'Show changes',
      icon: 'filter',
      disabled: !on && !count,
      run: () => {
        store.changesOnly.value = !on;
        if (!on) {
          app.sidebarVisible.value = true;
          app.sidebarPanel.value = 'files';
        }
      },
    },
    { label: 'Diff with last commit', icon: 'gitCompare', disabled: !active || !store.headKey(active), run: () => active && openFileDiff(store, active) },
    { label: 'Open source control', icon: 'gitBranch', keys: 'Ctrl+Shift+G', run: openPane },
    { label: 'Stop trusting this folder', icon: 'lock', run: () => void stopTrusting(store) },
  ];
  if (b.upstream) items.push({ separator: true }, { label: `↑${b.ahead}  ↓${b.behind}  ${b.upstream}`, icon: 'gitBranch', disabled: true });
  return items;
}

export function openBranchMenu(store: GitStore, anchor: HTMLElement) {
  const r = anchor.getBoundingClientRect();
  // Status bar: the menu host flips the menu up so it sits right above the item.
  ui.openContextMenu({ clientX: r.left, clientY: r.top - 4, preventDefault() {}, stopPropagation() {} }, branchMenuItems(store, app.activePath.value));
}

/** Status-bar item: branch, ahead/behind, dirty dot. Hidden when git is unavailable. */
export function GitBranchItem({ store }: { store: GitStore }) {
  const s = store.status.value;
  // A repository the user has not trusted yet: git is off, say so quietly; the panel asks.
  if (s && !s.ok && s.reason === 'untrusted' && s.repoLikely)
    return (
      <button class="se-status-item se-status-btn se-git-branch se-git-untrusted" data-testid="git-untrusted" title="Git is off in this folder until you trust it. Click to open Source control." aria-label="Git: not trusted. Open source control" onClick={openPane}>
        <Icon name="gitBranch" size={12} />
        <span class="se-git-branch-name">Git: not trusted</span>
      </button>
    );
  if (!s?.ok) return null;
  // Several repositories below the folder: the one holding the open file.
  const repo = store.repoOf(app.activePath.value ?? '') ?? s.repos?.find((r) => r.branch) ?? null;
  const b = repo?.branch ?? s.branch;
  const multi = (s.repos?.length ?? 0) > 1;
  const count = store.marks.value.count;
  const label = multi && repo?.rel ? `${repo.rel} · ${branchLabel(b)}` : branchLabel(b);
  const via = repo?.engine === 'wsl' ? '\ngit runs inside WSL' : '';
  return (
    <button
      class={`se-status-item se-status-btn se-git-branch${store.changesOnly.value ? ' se-git-filtering' : ''}${store.busy.value ? ' se-git-busy' : ''}`}
      data-testid="git-branch"
      title={branchTitle(b, count) + via}
      aria-label={`Git: ${b.detached ? 'detached at ' : 'branch '}${label}${count ? `, ${count} changed` : ''}`}
      aria-haspopup="menu"
      onClick={(e) => openBranchMenu(store, e.currentTarget)}
    >
      <Icon name="gitBranch" size={12} />
      <span class="se-git-branch-name">{label}</span>
      <span class="se-git-spin" aria-hidden="true" />
      {count > 0 && <span class="se-git-branch-dirty" aria-hidden="true" />}
      {b.ahead > 0 && <span class="se-git-ab">↑{b.ahead}</span>}
      {b.behind > 0 && <span class="se-git-ab">↓{b.behind}</span>}
    </button>
  );
}

/** Trailing mark for a tree row: letter for files / untracked folders, a dot for folders with changes. */
export function GitTreeMark({ store, path, dir }: { store: GitStore; path: string; dir: boolean }) {
  const marks = store.marks.value;
  if (dir) {
    const d = marks.dir(path);
    if (!d) return null;
    if (d.own) {
      return d.own.letter ? (
        <span class={`se-git-letter se-git-${d.own.state}`} title={d.own.title} aria-label={d.own.title}>
          {d.own.letter}
        </span>
      ) : null;
    }
    return d.count ? <span class={`se-git-dot se-git-${d.worst}`} title={`${d.count} changed ${d.count === 1 ? 'item' : 'items'} inside`} /> : null;
  }
  const m = marks.file(path);
  if (!m?.letter) return null;
  return (
    <span class={`se-git-letter se-git-${m.state}`} title={m.title} aria-label={m.title}>
      {m.letter}
    </span>
  );
}

/** Above the tree while it lists changed files only. */
export function ChangesBanner({ store }: { store: GitStore }) {
  if (!store.changesOnly.value) return null;
  const n = store.marks.value.count;
  return (
    <div class="se-git-banner" role="status">
      <span>
        {n ? `${n} changed ${n === 1 ? 'item' : 'items'}` : 'No changes'} <span class="se-git-banner-dim">· changes only</span>
      </span>
      <button class="se-git-banner-btn" onClick={() => (store.changesOnly.value = false)}>
        Show all files
      </button>
    </div>
  );
}

/** Git items for the file tree / tab context menus. */
export function fileMenuItems(store: GitStore, path: string): ui.MenuItem[] {
  const items: ui.MenuItem[] = [];
  if (compareEnabled()) items.push({ label: 'Compare with Clipboard', icon: 'gitCompare', run: () => import('./compare').then((c) => c.compareFileWithClipboard(path)) });
  if (!store.status.peek()?.ok) return items.length ? [{ separator: true }, ...items] : [];
  const m = store.marks.peek().file(path);
  if (store.headKey(path)) items.push({ label: 'Diff with last commit', icon: 'gitCompare', run: () => openFileDiff(store, path) });
  if (m?.state === 'conflicted') items.push({ label: 'Mark resolved', icon: 'check', run: () => markResolved(store, path) });
  else if (m && m.state !== 'ignored' && (m.unstaged || m.state === 'untracked') && !m.submodule) items.push({ label: 'Stage changes', icon: 'plus', run: () => stage(store, [path]) });
  if (m?.staged && m.state !== 'conflicted') items.push({ label: 'Unstage', icon: 'minus', run: () => unstage(store, [path]) });
  return items.length ? [{ separator: true }, ...items] : [];
}
