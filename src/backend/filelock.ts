// Cross-process lock for small read-modify-write files in the app data folder (settings.json,
// web-ports.json): the desktop app and any browser-mode server write the same files. A lock is a file
// created with O_EXCL next to the target; one left behind by a crashed writer goes stale after a few seconds.
import fsp from 'node:fs/promises';
import path from 'node:path';

const STALE_MS = 5000;
const WAIT_MS = 3000;

export async function withFileLock<T>(target: string, fn: () => Promise<T>, o: { staleMs?: number; waitMs?: number } = {}): Promise<T> {
  const lock = `${target}.lock`;
  const t0 = Date.now();
  let owned = false;
  while (!owned) {
    try {
      await (await fsp.open(lock, 'wx')).close();
      owned = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        await fsp.mkdir(path.dirname(lock), { recursive: true });
        continue;
      }
      if (code !== 'EEXIST' && code !== 'EPERM') throw err;
      const st = await fsp.stat(lock).catch(() => null);
      if (st && Date.now() - st.mtimeMs > (o.staleMs ?? STALE_MS)) {
        await fsp.rm(lock, { force: true }).catch(() => {});
        continue;
      }
      // A writer that never lets go must not lose this change: go ahead unlocked (writes stay atomic).
      if (Date.now() - t0 > (o.waitMs ?? WAIT_MS)) break;
      await new Promise((r) => setTimeout(r, 10 + Math.random() * 15));
    }
  }
  try {
    return await fn();
  } finally {
    if (owned) await fsp.rm(lock, { force: true }).catch(() => {});
  }
}
