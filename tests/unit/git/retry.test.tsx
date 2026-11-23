// @vitest-environment happy-dom
// "Git didn't answer in time": ONE sentence (never the reason's sentence plus a second wording of it)
// and a Retry on every surface — the pane, the status-bar item, a failed action (the pane's box and its
// toast), the diff opener. Retry only reads the repository again (never runs a failed action again),
// one at a time, and the message goes when git answers.
import { describe, it, expect, afterEach } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { GIT_TIMEOUT_TEXT, type GitActionResult, type GitStatus, type GitStatusReply, type GitUnavailable } from '@shared/git';
import { app } from '../../../src/renderer/app/app';
import { GitStore } from '../../../src/renderer/git/store';
import { GitBranchItem, canRetry, unavailableText } from '../../../src/renderer/git/ui';
import { ErrorBox, Unavailable } from '../../../src/renderer/git/SourceControl';
import { lastError, runGit } from '../../../src/renderer/git/actions';
import { openFileDiff } from '../../../src/renderer/git/diff-open';

const OK: GitStatus = { ok: true, branch: { head: 'main', oid: 'd'.repeat(40), detached: false, upstream: null, ahead: 0, behind: 0 }, entries: [], prefix: '', ms: 1 };
/** As an older backend worded it: the text the pane used to print after its own sentence. */
const TIMEOUT: GitUnavailable = { ok: false, reason: 'timeout', message: 'git took too long' };

/** A store on a scripted backend: one reply per status call (the last one repeats); `hold()` keeps calls waiting. */
function scripted(replies: GitStatusReply[]) {
  const calls: Array<{ since?: number; fresh?: boolean } | undefined> = [];
  let i = 0;
  let gate: Promise<void> | null = null;
  const store = new GitStore({
    async gitStatus(o) {
      calls.push(o);
      if (gate) await gate;
      return replies[Math.min(i++, replies.length - 1)];
    },
    gitHeadFile: async () => ({ content: null, oid: null }),
  });
  return {
    store,
    calls,
    fresh: () => calls.filter((c) => c?.fresh).length,
    hold() {
      let release!: () => void;
      gate = new Promise((r) => (release = r));
      return () => {
        gate = null;
        release();
      };
    },
  };
}
const host = () => {
  document.body.innerHTML = '<div id="h"></div>';
  return document.getElementById('h')!;
};
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 5))));
const count = (text: string, part: string) => text.split(part).length - 1;

afterEach(() => {
  render(null, document.getElementById('h') ?? document.body);
  app.toasts.value = [];
  lastError.value = null;
});

describe('the text', () => {
  it('no answer in time: the one sentence, whatever else came along', () => {
    expect(GIT_TIMEOUT_TEXT).toBe("Git didn't answer in time.");
    expect(unavailableText({ ok: false, reason: 'timeout' })).toBe(GIT_TIMEOUT_TEXT);
    expect(unavailableText(TIMEOUT)).toBe(GIT_TIMEOUT_TEXT); // was: "git took too long to answer. git took too long"
  });

  it("git's own line follows only where it adds something, and never repeats the sentence", () => {
    expect(unavailableText({ ok: false, reason: 'error', message: 'fatal: bad config line 3' })).toBe('git reported an error. fatal: bad config line 3');
    expect(unavailableText({ ok: false, reason: 'error', message: 'Git reported an error' })).toBe('git reported an error.');
    expect(unavailableText({ ok: false, reason: 'error' })).toBe('git reported an error.');
    expect(unavailableText({ ok: false, reason: 'unsafe', message: 'fatal: detected dubious ownership' })).toMatch(/safe\.directory\)\. fatal: detected dubious ownership$/);
    expect(unavailableText({ ok: false, reason: 'no-git', message: 'spawn git ENOENT' })).toBe('git was not found. Install git to use source control.');
    expect(unavailableText({ ok: false, reason: 'no-repo' })).toBe('This folder is not a git repository.');
  });

  it('Retry is offered for what can pass, not for "no repository" / "not trusted"', () => {
    const can = (reason: GitUnavailable['reason']) => canRetry({ ok: false, reason });
    expect((['timeout', 'error', 'no-git', 'unsafe'] as const).map(can)).toEqual([true, true, true, true]);
    expect((['no-repo', 'untrusted'] as const).map(can)).toEqual([false, false]);
  });
});

describe('Source control pane without a status', () => {
  /** What SourceControl() does with the status: the failure view, or the pane. */
  function Pane({ store }: { store: GitStore }) {
    const st = store.status.value;
    return st && !st.ok ? <Unavailable s={store} st={st} /> : <div data-testid="scm" />;
  }

  it('says it once, with a Retry that asks for a fresh status — one at a time — and gives way to the pane when git answers', async () => {
    const b = scripted([TIMEOUT, TIMEOUT, OK]);
    await b.store.refreshNow();
    const el = host();
    act(() => render(<Pane store={b.store} />, el));
    const box = () => el.querySelector('[data-testid="scm-unavailable"]');
    const btn = () => el.querySelector<HTMLButtonElement>('[data-testid="git-retry"]')!;
    expect(box()!.querySelector('p')!.textContent).toBe(GIT_TIMEOUT_TEXT);
    expect(count(box()!.textContent!, 'answer')).toBe(1);
    expect(box()!.textContent).not.toMatch(/too long/i);
    expect(btn().textContent!.trim()).toBe('Retry');

    // Still no answer: the sentence stays (once), the button comes back.
    const before = b.fresh();
    const release = b.hold();
    await act(async () => btn().click());
    expect(btn().disabled).toBe(true);
    expect(btn().textContent!.trim()).toBe('Trying again…');
    await act(async () => void b.store.retry()); // a second click somewhere else (status bar, toast): the same retry
    expect(b.fresh() - before).toBe(1);
    release();
    await settle();
    expect(btn().disabled).toBe(false);
    expect(box()!.querySelector('p')!.textContent).toBe(GIT_TIMEOUT_TEXT);

    // git answers: the message is gone, the pane is there.
    await act(async () => btn().click());
    await settle();
    expect(b.fresh() - before).toBe(2);
    expect(box()).toBeNull();
    expect(el.querySelector('[data-testid="scm"]')).not.toBeNull();
  });

  it('other failures: the reason and git\'s line once, Retry too', async () => {
    const b = scripted([{ ok: false, reason: 'error', message: 'fatal: bad config line 3' }]);
    await b.store.refreshNow();
    const el = host();
    act(() => render(<Pane store={b.store} />, el));
    expect(el.querySelector('[data-testid="scm-unavailable"] p')!.textContent).toBe('git reported an error. fatal: bad config line 3');
    expect(el.querySelector('[data-testid="git-retry"]')).not.toBeNull();
  });
});

describe('status-bar item', () => {
  it('no answer in time: says so with Retry; a click looks again and the branch comes back', async () => {
    const b = scripted([TIMEOUT, OK]);
    await b.store.refreshNow();
    const el = host();
    act(() => render(<GitBranchItem store={b.store} />, el));
    const btn = el.querySelector<HTMLButtonElement>('[data-testid="git-retry"]')!;
    expect(btn.textContent).toBe('Git: no answer · Retry');
    expect(btn.getAttribute('title')).toBe(`${GIT_TIMEOUT_TEXT} Click to try again.`);
    await act(async () => btn.click());
    await settle();
    expect(b.fresh()).toBe(2); // the first status of this test, and the retry
    expect(el.querySelector('[data-testid="git-retry"]')).toBeNull();
    expect(el.querySelector('[data-testid="git-branch"] .se-git-branch-name')!.textContent).toBe('main');
  });

  it('stays quiet for other failures (the pane explains them)', async () => {
    const b = scripted([{ ok: false, reason: 'error', message: 'boom' }]);
    await b.store.refreshNow();
    const el = host();
    act(() => render(<GitBranchItem store={b.store} />, el));
    expect(el.innerHTML).toBe('');
  });
});

describe('an action that got no answer in time', () => {
  const stopped: GitActionResult = { ok: false, timeout: true, message: GIT_TIMEOUT_TEXT };

  it('Retry (pane box and toast) only reads the repository again — the action is NEVER run again; git answering clears the message', async () => {
    for (const [label, failed] of [
      ['Fetching', { ...stopped, terminal: 'git fetch', auth: true }],
      ['Committing', stopped],
    ] as Array<[string, GitActionResult]>) {
      app.toasts.value = [];
      const b = scripted([OK]);
      await b.store.refreshNow();
      let runs = 0;
      const action = async () => (runs++, failed);
      await runGit(b.store, label, action, { save: false });
      expect(lastError.value).toEqual(failed);
      const toast = app.toasts.value.at(-1)!;
      expect(toast.message).toBe(GIT_TIMEOUT_TEXT);
      expect(toast.actions!.map((a) => a.label)).toEqual(failed.terminal ? ['Retry', 'Copy command'] : ['Retry']);

      const el = host();
      act(() => render(<ErrorBox s={b.store} />, el));
      expect(el.querySelector('.se-scm-error-msg')!.textContent).toBe(GIT_TIMEOUT_TEXT);
      const btn = el.querySelector<HTMLButtonElement>('[data-testid="git-retry"]')!;
      expect(btn.textContent).toBe('Retry');
      const before = b.fresh();
      await act(async () => {
        btn.click();
        toast.actions![0].run(); // the toast's Retry at the same moment: the same one read
      });
      await settle();
      expect(runs).toBe(1); // not repeated: the user starts it again by hand
      expect(b.fresh() - before).toBe(1);
      expect(lastError.value).toBeNull();
      expect(el.innerHTML).toBe('');
      render(null, el);
    }
  });

  it('git still gives no answer: the message stays, Retry is there again, the action was still not repeated', async () => {
    const b = scripted([OK, OK, TIMEOUT]); // this test's first status, the one after the action, the retry's
    await b.store.refreshNow();
    let runs = 0;
    await runGit(b.store, 'Pushing', async () => (runs++, stopped), { save: false });
    const el = host();
    act(() => render(<ErrorBox s={b.store} />, el));
    await act(async () => el.querySelector<HTMLButtonElement>('[data-testid="git-retry"]')!.click());
    await settle();
    expect(runs).toBe(1);
    expect(lastError.value).toEqual(stopped);
    const btn = el.querySelector<HTMLButtonElement>('[data-testid="git-retry"]')!;
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('Retry');
  });

  it('any other failure: no Retry (git said why)', async () => {
    const b = scripted([OK]);
    await b.store.refreshNow();
    await runGit(b.store, 'Pushing', async () => ({ ok: false, message: 'rejected (non-fast-forward)' }), { save: false });
    expect(app.toasts.value.at(-1)!.actions).toBeUndefined();
    const el = host();
    act(() => render(<ErrorBox s={b.store} />, el));
    expect(el.querySelector('.se-scm-error-msg')!.textContent).toBe('rejected (non-fast-forward)');
    expect(el.querySelector('[data-testid="git-retry"]')).toBeNull();
  });
});

describe('diff opener', () => {
  it('no answer in time: the one sentence with Retry, which reads the repository again and does not open the diff; otherwise the plain note', async () => {
    const b = scripted([TIMEOUT, OK]);
    await b.store.refreshNow();
    expect(await openFileDiff(b.store, 'a.md')).toBe(false);
    const toast = app.toasts.value.at(-1)!;
    expect(toast.message).toBe(GIT_TIMEOUT_TEXT);
    expect(toast.actions!.map((a) => a.label)).toEqual(['Retry']);
    const before = b.fresh();
    const toasts = app.toasts.value.length;
    toast.actions![0].run();
    await settle();
    expect(b.fresh() - before).toBe(1);
    expect(b.store.status.value?.ok).toBe(true);
    // Nothing else happened: the diff the user asked for is not opened by the Retry.
    expect(app.overlay.value).toBeNull();
    expect(app.toasts.value.length).toBe(toasts);

    const none = scripted([{ ok: false, reason: 'no-repo' }]);
    await none.store.refreshNow();
    expect(await openFileDiff(none.store, 'a.md')).toBe(false);
    expect(app.toasts.value.at(-1)).toMatchObject({ message: 'Git is not available for this folder', actions: undefined });
  });
});
