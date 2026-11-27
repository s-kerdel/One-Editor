// @vitest-environment happy-dom
// Per-folder renderer state (security audit 2026-11-27, M12): {{variables}} env / target / remembered values,
// the folder's remote-images choice and its recent files live in the folder's own session (saveSession /
// getSession), never in localStorage, which the pages of every folder share. A value an older version left
// in localStorage moves into the session once and is deleted there; another folder's keys are not read.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DEFAULT_SETTINGS, type SessionState } from '../../../src/shared/api';
import { app } from '../../../src/renderer/app/app';
import { flushSession, markSessionUnrestored, restoreSession, sessionSnapshot } from '../../../src/renderer/app/documents';
import { activeEnv, remember, remembered, setWsState } from '../../../src/renderer/variables/store';
import { folderRemote, remoteAllowed, setFolderRemote } from '../../../src/renderer/preview/remote';
import { getRecentFiles, touchRecentFile } from '../../../src/renderer/search/recent';

const saveSession = vi.fn(async (_s: SessionState) => {});
(app as any).backend = { kind: 'electron', saveSession };

async function open(root: string, s: Partial<SessionState> = {}) {
  markSessionUnrestored();
  app.workspace.value = { root, name: root.split('/').pop() } as any;
  await restoreSession({ openTabs: [], activeTab: null, ...s });
}

beforeEach(() => {
  localStorage.clear();
  saveSession.mockClear();
  app.settings.value = { ...DEFAULT_SETTINGS };
});

describe('per-folder state lives in the folder session', () => {
  it('comes back from the session and goes out with every session save; nothing is written to localStorage', async () => {
    await open('/w/a', { variables: { env: 'prod', values: { host: 'db1' } }, remoteImages: 'allow', recentFiles: ['x.md'] });
    expect(activeEnv()).toBe('prod');
    expect(remembered().get('host')).toBe('db1');
    expect(folderRemote()).toBe('allow');
    expect(remoteAllowed('n.md')).toBe(true);
    expect(getRecentFiles()).toEqual(['x.md']);

    remember(new Map([['user', 'me']]));
    setWsState({ target: 'eu' });
    setFolderRemote('block');
    touchRecentFile('y.md');
    const snap = sessionSnapshot();
    expect(snap.variables).toEqual({ env: 'prod', target: 'eu', values: { host: 'db1', user: 'me' } });
    expect(snap.remoteImages).toBe('block');
    expect(snap.recentFiles).toEqual(['y.md', 'x.md']);
    flushSession();
    expect(saveSession).toHaveBeenLastCalledWith(expect.objectContaining({ remoteImages: 'block', recentFiles: ['y.md', 'x.md'] }));
    expect(Object.keys(localStorage).filter((k) => /vars|remote|se-search:recent/.test(k))).toEqual([]);

    setFolderRemote(null); // back to the default: the field goes
    expect('remoteImages' in sessionSnapshot()).toBe(false);
  });

  it('another folder starts from its own session, not the previous folder’s values', async () => {
    await open('/w/a', { variables: { values: { host: 'db1' } }, remoteImages: 'allow' });
    await open('/w/b', {});
    expect(remembered().size).toBe(0);
    expect(folderRemote()).toBeNull();
    expect(sessionSnapshot().variables).toBeUndefined();
  });

  it('one-time move from localStorage: this folder’s old keys go into the session and are deleted; other folders’ stay unread', async () => {
    localStorage.setItem('sec-edit-vars:/w/a', JSON.stringify({ env: 'dev', values: { host: 'old', bad: 3 } }));
    localStorage.setItem('sec-edit-remote:/w/a', 'allow');
    localStorage.setItem('se-search:recent:/w/a', JSON.stringify(['r.md', 7]));
    localStorage.setItem('sec-edit-vars:/w/other', JSON.stringify({ values: { host: 'theirs' } }));
    await open('/w/a', {});
    expect(remembered().get('host')).toBe('old');
    expect(remembered().has('bad')).toBe(false); // only strings
    expect(activeEnv()).toBe('dev');
    expect(folderRemote()).toBe('allow');
    expect(getRecentFiles()).toEqual(['r.md']);
    expect(localStorage.getItem('sec-edit-vars:/w/a')).toBeNull();
    expect(localStorage.getItem('sec-edit-remote:/w/a')).toBeNull();
    expect(localStorage.getItem('se-search:recent:/w/a')).toBeNull();
    expect(sessionSnapshot()).toMatchObject({ variables: { env: 'dev', values: { host: 'old' } }, remoteImages: 'allow', recentFiles: ['r.md'] });
    expect(localStorage.getItem('sec-edit-vars:/w/other')).not.toBeNull();
  });

  it('the session wins over an old localStorage copy, and junk in the session is ignored', async () => {
    localStorage.setItem('sec-edit-remote:/w/c', 'allow');
    await open('/w/c', { remoteImages: 'block', variables: { values: { host: 5 } } as any, recentFiles: 'nope' as any });
    expect(folderRemote()).toBe('block');
    expect(localStorage.getItem('sec-edit-remote:/w/c')).toBeNull(); // deleted all the same
    expect(remembered().size).toBe(0);
    expect(getRecentFiles()).toEqual([]);
  });
});
