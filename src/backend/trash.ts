// Move-to-trash without Electron (browser/server mode, or when shell.trashItem fails, e.g. no D-Bus on Linux).
// Paths are always passed as process arguments / env vars, never interpolated into a shell string.
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { winSystemExe } from './winsys';

const run = (cmd: string, args: string[], env?: NodeJS.ProcessEnv, timeout = 20000) =>
  new Promise<void>((resolve, reject) =>
    execFile(cmd, args, { env: { ...process.env, ...env }, windowsHide: true, timeout }, (err) => (err ? reject(err) : resolve())),
  );

/** How long a trash call may take. A whole folder (noPermanent) can be big, and Windows may be waiting on its own
 *  "delete permanently?" dialog: 20 s would kill it mid-way and leave it partly deleted. Bounded, never forever. */
export const trashTimeout = (o: TrashOptions = {}) => (o.noPermanent ? 15 * 60_000 : 20_000);

export interface TrashOptions {
  /** A whole folder with no undo copy (MCP folder delete): it must never end up deleted for good. */
  noPermanent?: boolean;
}

// Constant: the path (and the dialog mode) come in through the environment, never into the text.
// Only fixed local drives have a Recycle Bin. Elsewhere (UNC, \\wsl$, USB) SendToRecycleBin with
// OnlyErrorDialogs (= "yes to all") deletes permanently without asking, so refuse → ETRASH → the UI asks.
// noPermanent: AllDialogs, so Windows itself asks before deleting for good (bin off or too small for it).
const WIN_TRASH_SCRIPT =
  'Add-Type -AssemblyName Microsoft.VisualBasic; $p = $env:SEC_EDIT_TRASH_PATH; ' +
  "$ui = 'OnlyErrorDialogs'; if ($env:SEC_EDIT_TRASH_UI -eq 'AllDialogs') { $ui = 'AllDialogs' }; " +
  "$r = [System.IO.Path]::GetPathRoot($p); if ($r.StartsWith('\\') -or ([System.IO.DriveInfo]::new($r)).DriveType -ne 'Fixed') { exit 3 }; " +
  // A junction / symlink swapped in after the caller's checks (process start takes a moment): never follow it.
  "if ((Get-Item -LiteralPath $p -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) { exit 4 }; " +
  "if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p,$ui,'SendToRecycleBin') } " +
  "else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,$ui,'SendToRecycleBin') }";

/** The Windows call (pure, for tests): a constant script; values only in the environment. */
export function windowsTrashCall(abs: string, o: TrashOptions = {}): { file: string; args: string[]; env: Record<string, string> } {
  return { file: winSystemExe('powershell.exe'), args: ['-NoProfile', '-NonInteractive', '-Command', WIN_TRASH_SCRIPT], env: { SEC_EDIT_TRASH_PATH: abs, ...(o.noPermanent ? { SEC_EDIT_TRASH_UI: 'AllDialogs' } : {}) } };
}

export async function platformTrash(abs: string, o: TrashOptions = {}): Promise<void> {
  // Test hook: deterministic "trash" folder.
  if (process.env.SEC_EDIT_TRASH_DIR) return moveInto(process.env.SEC_EDIT_TRASH_DIR, abs);
  if (process.platform === 'win32') {
    const c = windowsTrashCall(abs, o);
    return run(c.file, c.args, c.env, trashTimeout(o));
  }
  if (process.platform === 'darwin') {
    // Finder deletes items on volumes without a Trash at once: a folder with no undo copy must be on the
    // home volume (its ~/.Trash), else nothing happens.
    if (o.noPermanent) {
      const [a, t] = await Promise.all([fsp.stat(abs), fsp.stat(path.join(os.homedir(), '.Trash')).catch(() => null)]);
      if (!t || a.dev !== t.dev) throw Object.assign(new Error('No Trash on that volume'), { code: 'ETRASH' });
    }
    return run('osascript', ['-e', 'on run argv', '-e', 'tell application "Finder" to delete (POSIX file (item 1 of argv))', '-e', 'end run', abs], undefined, trashTimeout(o));
  }
  return xdgTrash(abs);
}

/** freedesktop.org Trash spec (home trash). Works on any Linux without gio / D-Bus. */
export async function xdgTrash(abs: string, dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')): Promise<void> {
  const trash = path.join(dataHome, 'Trash');
  const files = path.join(trash, 'files');
  const info = path.join(trash, 'info');
  await fsp.mkdir(files, { recursive: true, mode: 0o700 });
  await fsp.mkdir(info, { recursive: true, mode: 0o700 });
  const [src, dst] = await Promise.all([fsp.stat(abs), fsp.stat(files)]);
  // Home trash must be on the same device (rename only); cross-device would mean a copy of possibly huge data.
  if (src.dev !== dst.dev) throw Object.assign(new Error('Trash is on a different drive'), { code: 'ETRASH' });
  const base = path.basename(abs);
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? base : `${base}.${n}`;
    try {
      const fh = await fsp.open(path.join(info, `${name}.trashinfo`), 'wx', 0o600);
      const date = new Date().toISOString().slice(0, 19);
      await fh.writeFile(`[Trash Info]\nPath=${encodeURI(abs).replace(/[?#]/g, encodeURIComponent)}\nDeletionDate=${date}\n`);
      await fh.close();
      try {
        await fsp.rename(abs, path.join(files, name));
      } catch (err) {
        await fsp.rm(path.join(info, `${name}.trashinfo`), { force: true });
        throw err;
      }
      return;
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
    }
  }
  throw Object.assign(new Error('Trash is full of name clashes'), { code: 'ETRASH' });
}

async function moveInto(dir: string, abs: string) {
  await fsp.mkdir(dir, { recursive: true });
  let dst = path.join(dir, path.basename(abs));
  for (let n = 2; await fsp.stat(dst).then(() => true, () => false); n++) dst = path.join(dir, `${path.basename(abs)}.${n}`);
  try {
    await fsp.rename(abs, dst);
  } catch (err: any) {
    if (err?.code !== 'EXDEV') throw err;
    await fsp.cp(abs, dst, { recursive: true });
    await fsp.rm(abs, { recursive: true, force: true });
  }
}
