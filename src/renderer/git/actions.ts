// Source-control actions shared by the pane, menus and commands: unsaved edits are saved first (git
// works on the files on disk), the status refreshes afterwards, and failures say what to do next —
// including a hand-off to the integrated terminal for anything that needs a prompt (never auto-Enter).
import { signal } from '@preact/signals';
import type { GitActionResult } from '@shared/git';
import { basename } from '@shared/paths';
import { app } from '../app/app';
import * as ui from '../app/ui';
import { saveAll } from '../app/documents';
import { copyText } from '../app/fileops';
import type { GitStore } from './store';
import { git } from './rpc';

/** The running action ("Pushing…"), for busy states. */
export const busy = signal<string | null>(null);
/** The last failure, shown inline in the pane until the next action. */
export const lastError = signal<GitActionResult | null>(null);

/** Opens the integrated terminal with `command` typed in (not run); copies it where there is none. */
export function handOff(command: string) {
  if (app.runInTerminal) void app.runInTerminal(command, { pressEnter: false });
  else void copyText(command, 'Command');
}
export const handOffLabel = () => (app.runInTerminal ? 'Open in terminal' : 'Copy command');

export async function runGit(store: GitStore, label: string, fn: () => Promise<GitActionResult>, opts: { save?: boolean; quiet?: boolean } = {}): Promise<GitActionResult> {
  busy.value = label;
  lastError.value = null;
  let r: GitActionResult;
  try {
    if (opts.save !== false) await saveAll();
    r = await fn();
  } catch (err: any) {
    r = { ok: false, message: String(err?.message ?? err) };
  } finally {
    busy.value = null;
  }
  await store.refreshNow();
  if (!r.ok) {
    lastError.value = r;
    app.toast(r.message || `${label} failed`, 'error', 8000, r.terminal ? [{ label: handOffLabel(), run: () => handOff(r.terminal!) }] : undefined);
  } else if (!opts.quiet && r.message) app.toast(r.message, 'success', 2500);
  return r;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

export const stage = (s: GitStore, paths: string[] | null) => runGit(s, 'Staging', () => git('stage', paths), { quiet: true });
export const unstage = (s: GitStore, paths: string[] | null) => runGit(s, 'Unstaging', () => git('unstage', paths), { quiet: true });

/** Conflicts: staging = "resolved". Asks first when the file still has conflict markers. */
export async function markResolved(s: GitStore, path: string): Promise<void> {
  const text = app.docs.get(path)?.content ?? (await app.backend.readFile(path).then((f) => f.content, () => ''));
  if (/^(<{7}|>{7})( |$)/m.test(text) && !(await ui.confirmDialog('Still has conflict markers', `“${basename(path)}” still contains <<<<<<< / >>>>>>> lines. Mark it resolved anyway?`, 'Mark resolved'))) return;
  await runGit(s, 'Marking resolved', () => git('stage', [path]), { quiet: true });
}

/** Never silent: always asks. Untracked files go to the trash, tracked ones back to their staged/committed state. */
export async function discard(s: GitStore, paths: string[], untracked: number): Promise<void> {
  if (!paths.length) return;
  const tracked = paths.length - untracked;
  const what = paths.length === 1 ? `“${basename(paths[0])}”` : plural(paths.length, 'file');
  const parts = [tracked ? `Changes to ${tracked === paths.length ? what : plural(tracked, 'file')} are lost.` : '', untracked ? `${untracked === paths.length ? what : plural(untracked, 'new file')} ${untracked === 1 ? 'goes' : 'go'} to the ${app.backend.os === 'win32' ? 'Recycle Bin' : 'trash'}.` : ''];
  if (!(await ui.confirmDialog(`Discard changes in ${what}?`, parts.filter(Boolean).join(' ') + ' This cannot be undone with Ctrl+Z.', 'Discard', true))) return;
  await runGit(s, 'Discarding', () => git('discard', paths));
}
