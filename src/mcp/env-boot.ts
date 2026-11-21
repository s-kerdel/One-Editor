// cli.ts's second import: in a packaged build the SEC_EDIT_* test hooks (another data folder, a fake
// trash, tuning knobs…) are dead, as they are in the app (main/env-guard.ts, pure). The Node-mode server
// has no main process in front of it, so it applies the same scrub itself. Packaged = run from
// app.asar.unpacked (the only place a packaged build ships this file).
import { fileURLToPath } from 'node:url';
import { scrubPackagedEnv } from '../main/env-guard';

export const isPackagedCli = (file: string) => /[\\/]app\.asar\.unpacked[\\/]/.test(file);

let here = '';
try {
  here = fileURLToPath(import.meta.url);
} catch {}
export const PACKAGED = isPackagedCli(here);
if (PACKAGED) scrubPackagedEnv(process.env);
