// SEC_EDIT_* environment variables are developer / test hooks: another renderer folder
// (SEC_EDIT_RENDERER_DIR — code that would run with the privileged preload bridge), a fixed "save as"
// path, a shell list, the indexer's source file, a private profile… In a packaged build they are
// dropped before anything reads them (as VITE_DEV_SERVER_URL already is): whoever can set the
// environment of the installed app must not be able to turn those on. Pure (unit-tested);
// env-boot.ts applies it first thing in the main process.

/** Harmless diagnostics / tuning that stay available in a packaged build. */
export const PACKAGED_ENV_ALLOWED: ReadonlySet<string> = new Set(['SEC_EDIT_TIMINGS', 'SEC_EDIT_GIT_LOG', 'SEC_EDIT_WATCH', 'SEC_EDIT_READ_THREADS']);

/** Removes every other SEC_EDIT_* variable (any case: Windows names are case-insensitive). Returns the removed names. */
export function scrubPackagedEnv(env: NodeJS.ProcessEnv): string[] {
  const removed: string[] = [];
  for (const k of Object.keys(env)) {
    const name = k.toUpperCase();
    if (!name.startsWith('SEC_EDIT_') || PACKAGED_ENV_ALLOWED.has(name)) continue;
    delete env[k];
    removed.push(k);
  }
  return removed;
}
