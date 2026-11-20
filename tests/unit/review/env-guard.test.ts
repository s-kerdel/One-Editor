// Test / developer hooks must be dead in a packaged build.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PACKAGED_ENV_ALLOWED, scrubPackagedEnv } from '../../../src/main/env-guard';

describe('packaged builds ignore SEC_EDIT_* hooks', () => {
  it('drops every hook, in any case; keeps the harmless ones and everything else', () => {
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      HOME: '/home/me',
      SEC_EDIT_TEST: '1',
      SEC_EDIT_RENDERER_DIR: '/tmp/evil',
      SEC_EDIT_TEST_SAVE_PATH: '/home/me/.bashrc',
      SEC_EDIT_TEST_SHELLS: '[{"path":"/tmp/evil"}]',
      SEC_EDIT_USER_DATA: '/tmp/profile',
      SEC_EDIT_OPEN: '/',
      SEC_EDIT_TRASH_DIR: '/tmp/t',
      SEC_EDIT_INDEXER_SRC_FILE: '/tmp/evil.js',
      SEC_EDIT_CONFIG_DIR: '/tmp/cfg',
      SEC_EDIT_SINGLE_INSTANCE: '1',
      sec_edit_test: '1',
      Sec_Edit_Renderer_Dir: 'C:\\evil',
      SEC_EDIT_TIMINGS: '1',
      SEC_EDIT_GIT_LOG: '1',
      SEC_EDIT_WATCH: 'poll',
      SEC_EDIT_READ_THREADS: '2',
      NOT_SEC_EDIT_TEST: 'kept',
    };
    const removed = scrubPackagedEnv(env);
    expect(Object.keys(env).sort()).toEqual(['HOME', 'NOT_SEC_EDIT_TEST', 'PATH', 'SEC_EDIT_GIT_LOG', 'SEC_EDIT_READ_THREADS', 'SEC_EDIT_TIMINGS', 'SEC_EDIT_WATCH']);
    expect(removed).toHaveLength(12);
  });

  it('every hook the main process and backend read is either scrubbed or listed as harmless', () => {
    const root = path.resolve(__dirname, '../../../src');
    const names = new Set<string>();
    for (const d of ['main', 'backend']) for (const f of fs.readdirSync(path.join(root, d))) for (const m of fs.readFileSync(path.join(root, d, f), 'utf8').matchAll(/process\.env\.(SEC_EDIT_[A-Z_]+)/g)) names.add(m[1]);
    expect(names.has('SEC_EDIT_RENDERER_DIR')).toBe(true);
    // The allowlist must not grow by accident: these change no file, path, program or profile.
    expect([...PACKAGED_ENV_ALLOWED].sort()).toEqual(['SEC_EDIT_GIT_LOG', 'SEC_EDIT_READ_THREADS', 'SEC_EDIT_TIMINGS', 'SEC_EDIT_WATCH']);
    for (const n of names) if (!PACKAGED_ENV_ALLOWED.has(n)) expect(scrubPackagedEnv({ [n]: 'x' }), n).toEqual([n]);
  });

  it('main.ts applies it before any other module is loaded', () => {
    const main = fs.readFileSync(path.resolve(__dirname, '../../../src/main/main.ts'), 'utf8');
    const firstImport = main.split('\n').find((l) => l.startsWith('import '));
    expect(firstImport).toBe("import './env-boot'; // first: drops SEC_EDIT_* hooks in a packaged build before any module reads them");
  });
});
