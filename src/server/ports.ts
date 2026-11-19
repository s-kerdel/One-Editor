// Browser-mode state in the browser (localStorage: variables environment / target, search recents,
// layout) is per origin, i.e. per port. So the last port per folder is remembered in the app data
// folder (web-ports.json, never the folder itself) and tried first when no --port is given.
import path from 'node:path';
import { readJson, rootId, writeJson } from '../backend/service';
import { withFileLock } from '../backend/filelock';

export const AUTO_PORT = 4317;
const AUTO_RANGE = 20;
const MAX_FOLDERS = 200;
const fileOf = (configDir: string) => path.join(configDir, 'web-ports.json');
const isPort = (p: unknown): p is number => typeof p === 'number' && Number.isInteger(p) && p >= 1024 && p <= 65535;

export async function rememberedPort(configDir: string, root: string): Promise<number | null> {
  const m = await readJson<Record<string, unknown> | null>(fileOf(configDir), null);
  const p = m && typeof m === 'object' ? m[rootId(root)] : null;
  return isPort(p) ? p : null;
}

/** Most recent last; the oldest folders drop off beyond MAX_FOLDERS. Locked: several servers may start at once. */
export async function rememberPort(configDir: string, root: string, port: number): Promise<void> {
  const file = fileOf(configDir);
  await withFileLock(file, async () => {
    const raw = await readJson<Record<string, unknown> | null>(file, null);
    const m: Record<string, unknown> = raw && typeof raw === 'object' ? raw : {};
    const id = rootId(root);
    delete m[id];
    m[id] = port;
    const keys = Object.keys(m);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_FOLDERS))) delete m[k];
    await writeJson(file, m);
  });
}

/** Ports to try in order: exactly the one asked for, else the remembered one, then 4317, 4318, … */
export function portCandidates(explicit: number | null, remembered: number | null): number[] {
  if (explicit !== null) return [explicit];
  const list = remembered !== null ? [remembered] : [];
  for (let p = AUTO_PORT; p < AUTO_PORT + AUTO_RANGE; p++) if (p !== remembered) list.push(p);
  return list;
}
