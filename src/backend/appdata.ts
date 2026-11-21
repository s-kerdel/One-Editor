// Where the app keeps its data, and what the indexers skip. Dependency-light on purpose: the MCP
// server (src/mcp) needs these without pulling in BackendService (git, terminals, PDF export…).
import os from 'node:os';
import path from 'node:path';
import type { Settings } from '../shared/api';
import { MAX_INDEX_BYTES, type IndexOptions } from './indexer';

export function defaultConfigDir(): string {
  if (process.env.SEC_EDIT_CONFIG_DIR) return process.env.SEC_EDIT_CONFIG_DIR;
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'sec-edit');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'sec-edit');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'sec-edit');
}

const samePathCI = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** Windows: %LOCALAPPDATA% (a cache must not travel with a roaming profile); elsewhere next to the settings. */
export function defaultCacheDir(configDir: string): string {
  const local = process.platform === 'win32' ? process.env.LOCALAPPDATA : undefined;
  if (local && samePathCI(configDir, defaultConfigDir())) return path.join(local, 'sec-edit', 'index-cache');
  return path.join(configDir, 'index-cache');
}

/** Settings → what the indexers skip (search.* in the settings registry). */
export function indexOptionsFrom(s: Settings): IndexOptions {
  const kb = Number(s['search.maxFileSizeKB']);
  return {
    respectGitignore: s['search.respectGitignore'] !== false,
    skipLockfiles: s['search.skipLockfiles'] !== false,
    skipMinified: s['search.skipMinified'] !== false,
    maxFileBytes: Number.isFinite(kb) && kb > 0 ? Math.min(16384, Math.max(16, kb)) * 1024 : MAX_INDEX_BYTES,
  };
}
