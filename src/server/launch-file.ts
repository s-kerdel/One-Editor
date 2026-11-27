// The browser is handed a file, not a link (Jupyter's pattern): `--open` and the desktop's "Open" write a
// redirect page with the one-time launch code into a private folder of One's data and open that file. A
// command line is readable by every local user (/proc/<pid>/cmdline); this 0600 file in a 0700 folder is
// not. cli.ts removes it once the code is spent, when it expires, or when the server exits.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/** `<app data>/launch`: one `open-<random>.html` per launch. */
export const launchDir = (configDir: string) => path.join(configDir, 'launch');
const FILE = /^open-[0-9a-f]{16}\.html$/;

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A page that goes straight on to `url` (no script: a meta refresh, and a link if the browser holds it back). */
export function launchPage(url: string): string {
  const u = attr(url);
  return `<!doctype html>\n<html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${u}"><title>One</title></head>\n<body><p>Opening One. If nothing happens, <a href="${u}">continue here</a>.</p></body></html>\n`;
}

/** Writes the redirect page for `url`; returns its absolute path. Leftovers older than `staleMs` (a killed server's) go first. */
export async function writeLaunchFile(configDir: string, url: string, staleMs: number): Promise<string> {
  const dir = launchDir(configDir);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  if (!(await fsp.lstat(dir)).isDirectory()) throw Object.assign(new Error('The launch folder is not a folder'), { code: 'ENOTDIR' });
  if (process.platform !== 'win32') await fsp.chmod(dir, 0o700); // made earlier or by hand with a looser mode
  const now = Date.now();
  for (const name of await fsp.readdir(dir).catch(() => [] as string[])) {
    if (!FILE.test(name)) continue;
    const f = path.join(dir, name);
    const st = await fsp.lstat(f).catch(() => null);
    if (st && now - st.mtimeMs > staleMs) await fsp.rm(f, { force: true }).catch(() => {});
  }
  const file = path.join(dir, `open-${crypto.randomBytes(8).toString('hex')}.html`);
  await fsp.writeFile(file, launchPage(url), { mode: 0o600, flag: 'wx' });
  return file;
}

/** Sync, so it also runs in an 'exit' handler. */
export function removeLaunchFile(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {}
}
