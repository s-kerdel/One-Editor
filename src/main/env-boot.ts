// Imported first by main.ts: modules read SEC_EDIT_* at import time (see env-guard.ts).
import { app } from 'electron';
import { scrubPackagedEnv } from './env-guard';

if (app.isPackaged) scrubPackagedEnv(process.env);
