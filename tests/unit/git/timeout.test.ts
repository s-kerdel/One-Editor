// "Git didn't answer in time": what the backend answers when git is stopped after its time limit (a
// code, plus the ONE sentence where a text travels), and that a first look at a folder that got no
// answer is not final: Retry (a fresh status) looks again, one look at a time.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { GitService } from '../../../src/backend/git';
import { BackendService } from '../../../src/backend/service';
import { GIT_TIMEOUT_TEXT } from '../../../src/shared/git';
import { BASE, makeRepo, testEnv, write } from './helpers';

const services: Array<{ dispose(): void }> = [];
afterEach(() => services.splice(0).forEach((s) => s.dispose()));

/**
 * A git that gives no answer to `sub` until `answer()` is called (a stand-in for a permission prompt
 * the user has not answered, a cold disk), and counts how often `sub` was asked for.
 * `exec sleep`: the kill at the time limit hits the sleep itself, nothing is left running.
 */
function hangingGit(name: string, sub: string) {
  fs.mkdirSync(BASE, { recursive: true });
  const flag = path.join(BASE, `${name}.hang`);
  const log = path.join(BASE, `${name}.log`);
  const exe = path.join(BASE, `${name}.sh`);
  fs.writeFileSync(flag, '');
  fs.rmSync(log, { force: true });
  fs.writeFileSync(exe, `#!/bin/sh\nfor a in "$@"; do if [ "$a" = "${sub}" ]; then echo x >> '${log}'; [ -e '${flag}' ] && exec sleep 5; break; fi; done\nexec git "$@"\n`, { mode: 0o755 });
  return {
    exe,
    answer: () => fs.rmSync(flag, { force: true }),
    asked: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0),
  };
}

describe('git gives no answer in time', () => {
  it('`git --version` gives no answer in time: "timeout", not "no git"; never remembered, the next look asks again', async () => {
    const dir = await makeRepo('t-version', { 'a.md': 'a\n' });
    const fake = hangingGit('hang-version', '--version');
    const look = () => {
      const g = new GitService(dir, { env: testEnv(), gitPath: fake.exe, timeouts: { discover: 300 } });
      services.push(g);
      return g;
    };
    const g = look();
    expect(await g.status()).toEqual({ ok: false, reason: 'timeout' });
    expect(fake.asked()).toBe(1);
    // A second look right away (another window; this one's next status) asks git again: no cached miss.
    expect(await look().status()).toEqual({ ok: false, reason: 'timeout' });
    expect(fake.asked()).toBe(2);
    fake.answer();
    expect(await g.reprobe()).toEqual({ ok: true }); // Retry / window focus (GitMonitor)
    expect(fake.asked()).toBe(3);
    expect((await g.status()).ok).toBe(true);
  });

  it('the first look at the folder: reason "timeout" and no wording of its own; actions say the one sentence', async () => {
    const dir = await makeRepo('t-look', { 'a.md': 'a\n' });
    const fake = hangingGit('hang-look', 'rev-parse');
    const g = new GitService(dir, { env: testEnv(), gitPath: fake.exe, timeouts: { discover: 300 } });
    services.push(g);
    // Exactly this: a `message` here is what the pane used to print after its own sentence.
    expect(await g.status()).toEqual({ ok: false, reason: 'timeout' });
    expect(await g.stage(['a.md'])).toEqual({ ok: false, timeout: true, message: GIT_TIMEOUT_TEXT });
    expect(fake.asked()).toBe(1);
    // Retry: two asking at once share ONE new look.
    fake.answer();
    expect(await Promise.all([g.reprobe(), g.reprobe()])).toEqual([{ ok: true }, { ok: true }]);
    expect(fake.asked()).toBe(2);
    expect((await g.status()).ok).toBe(true);
  });

  it('an action is stopped, says the one sentence and carries the `timeout` flag; started again by hand once git answers, it works', async () => {
    const dir = await makeRepo('t-action', { 'a.md': 'a\n' });
    write(dir, 'a.md', 'b\n');
    const fake = hangingGit('hang-add', 'add');
    const g = new GitService(dir, { env: testEnv(), gitPath: fake.exe, timeouts: { action: 300 } });
    services.push(g);
    expect(await g.stage(['a.md'])).toEqual({ ok: false, timeout: true, message: GIT_TIMEOUT_TEXT });
    fake.answer();
    expect(await g.stage(['a.md'])).toMatchObject({ ok: true });
    const st = await g.status();
    expect(st.ok && st.entries.map((e) => [e.path, e.staged])).toEqual([['a.md', true]]);
  });

  it('Retry through the RPC: a fresh status looks at the folder again (the failure used to stay until the folder was reopened)', async () => {
    const dir = await makeRepo('t-retry', { 'a.md': 'a\n' });
    const fake = hangingGit('hang-retry', 'rev-parse');
    const s = new BackendService(path.join(BASE, 't-retry-cfg'), { confirmTrust: async () => true }, {}, { env: testEnv(), gitPath: fake.exe, timeouts: { discover: 300 } });
    services.push(s);
    await s.openWorkspace(dir);
    await s.git('trust');
    const timeout = { ok: false, reason: 'timeout' };
    expect(await s.git('status')).toEqual(timeout);
    expect(await s.git('status')).toEqual(timeout); // not a retry: no git for it
    expect(fake.asked()).toBe(1);
    // git still hangs: three Retry clicks at once → one more look, the same answer.
    expect(await Promise.all([s.git('status', { fresh: true }), s.git('status', { fresh: true }), s.git('status', { fresh: true })])).toEqual([timeout, timeout, timeout]);
    expect(fake.asked()).toBe(2);
    // git answers: the status is there, the message has nothing left to stand on.
    fake.answer();
    expect(await s.git('status', { fresh: true })).toMatchObject({ ok: true, branch: { head: 'main' }, entries: [] });
    expect(fake.asked()).toBe(3);
  });
});
