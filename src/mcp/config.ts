// What the server reads from the app data folder: mcp.json (main's file: on/off, folders, modes) and a
// fixed handful of settings.json keys (exclusions, index rules, result limits). It never writes either,
// and never opens anything else there (vault.json in particular: tests/unit/mcp/isolation.test.ts).
import fs from 'node:fs';
import { DEFAULT_SETTINGS, type Settings } from '../shared/api';
import { parseMcpConfig, type McpConfig } from '../shared/mcp';

/** The settings this server uses (anything else in settings.json is ignored). `files.associations` is read
 *  for one thing: refusing more writes (folders.ts writeTypeProblem); it changes nothing visible or indexed. */
export const SETTINGS_USED = ['excludeGlobs', 'search.respectGitignore', 'search.skipLockfiles', 'search.skipMinified', 'search.maxFileSizeKB', 'links.updateOnRename', 'variables.fileName', 'mcp.maxReadKB', 'mcp.maxResults', 'files.associations'] as const;
/** Changing one of these changes what is visible or indexed: folders start over. */
export const VISIBILITY_KEYS = ['excludeGlobs', 'search.respectGitignore', 'search.skipLockfiles', 'search.skipMinified', 'search.maxFileSizeKB'] as const;

const readJsonSync = (file: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

export function readConfig(file: string): McpConfig {
  return parseMcpConfig(readJsonSync(file));
}

export type SettingsRead = { ok: true; settings: Settings } | { ok: false; reason: string };

/**
 * settings.json → the settings this server uses. Fails closed: a file that exists but cannot be read or
 * parsed, or whose excludeGlobs is not a list of strings, is an error (never "no exclusions"). The CLI
 * refuses to start on it and, at run time, keeps the last good settings. No file = the defaults.
 */
export function loadSettings(file: string): SettingsRead {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, settings: { ...DEFAULT_SETTINGS } };
    return { ok: false, reason: 'it cannot be read' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'it is not valid JSON' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'it is not a JSON object' };
  const s: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const k of SETTINGS_USED) if (k in raw) s[k] = (raw as Record<string, unknown>)[k];
  const globs = s.excludeGlobs;
  if (!Array.isArray(globs) || !globs.every((g) => typeof g === 'string')) return { ok: false, reason: '"excludeGlobs" is not a list of names' };
  return { ok: true, settings: s as Settings };
}

/** loadSettings for tests and tools that want an answer anyway: the defaults when unreadable. */
export function readSettings(file: string): Settings {
  const r = loadSettings(file);
  return r.ok ? r.settings : { ...DEFAULT_SETTINGS };
}

export const visibilityKey = (s: Settings) => JSON.stringify(VISIBILITY_KEYS.map((k) => s[k] ?? null));

/** Polls the files' mtimes (rename-safe: main writes through a temp file + rename). */
export function watchFiles(files: string[], intervalMs: number, onChange: (file: string) => void): () => void {
  const fns = files.map((f) => {
    const fn = (cur: fs.Stats, prev: fs.Stats) => {
      if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size || cur.ino !== prev.ino) onChange(f);
    };
    fs.watchFile(f, { interval: intervalMs, persistent: false }, fn);
    return () => fs.unwatchFile(f, fn);
  });
  return () => fns.forEach((u) => u());
}
