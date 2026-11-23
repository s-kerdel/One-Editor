// Source control pane (left sidebar, lazy chunk): merge conflicts, one "Changes" list with a box per
// file (ticked = staged = in the commit), the commit box, sync (fetch / pull / push), branches and
// history. Every action goes through ./actions (saves first, refreshes after, explains failures, hands
// prompts to a terminal).
import './scm.css';
import './check.css';
import { signal } from '@preact/signals';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { GIT_TIMEOUT_TEXT, type GitBranchInfo, type GitCommit, type GitCommitFile, type GitCommitFiles, type GitCommitInfo, type GitEntry, type GitJobError, type GitStatus, type GitUnavailable } from '@shared/git';
import { basename, dirname } from '@shared/paths';
import { app } from '../app/app';
import * as ui from '../app/ui';
import { FileIcon, FolderIcon, Icon } from '../app/icons';
import { prettyKey } from '../app/commands';
import { revealInTree } from '../app/fileops';
import { installGit } from './index';
import type { GitStore } from './store';
import { markOf } from './marks';
import { openCommitDiff, openFileDiff } from './diff-open';
import { busy, discard, handOff, handOffLabel, lastError, markResolved, retryRead, runGit, stage } from './actions';
import { allOf, ariaChecked, selectedCount, type Check } from './selection';
import { shownCheck, stager, toggleAll, toggleEntry } from './stage';
import { branchLabel, canRetry, stopTrusting, unavailableText } from './ui';
import { git, gitCall } from './rpc';

/** Stop a background list (fire and forget: the backend kills the running git). */
const cancelJob = (tag: 'branches' | 'remotes' | 'history' | 'files') => void gitCall()?.('cancel', tag).catch(() => {});

/** Survive panel switches (the pane unmounts when another panel is shown). */
const draft = signal('');
const amend = signal(false);
const open = signal<Record<string, boolean>>({ conflicts: true, changes: true, branches: false, history: false });
const ROW_CAP = 400;

/** Parent folder with several repositories: the one the pane works on ('' = the only one). */
export const paneRepo = signal<string>('');
/** Repository argument for repository-level calls (undefined with a single repository). */
const R = () => paneRepo.peek() || undefined;

const toggle = (k: string) => (open.value = { ...open.value, [k]: !open.value[k] });

function ago(sec: number): string {
  const d = Date.now() / 1000 - sec;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)} d ago`;
  return new Date(sec * 1000).toLocaleDateString();
}

// ---- rows / groups ---------------------------------------------------------------------------
// One "Changes" list: every changed file with a box. Ticked = staged = goes into the commit (the index
// is the selection, see ./selection). Conflicts stay apart with "Mark resolved" until they are resolved.

type Group = 'conflicts' | 'changes';
type Groups = Record<Group, GitEntry[]>;

function groups(st: GitStatus): Groups {
  const g: Groups = { conflicts: [], changes: [] };
  for (const e of st.entries) {
    if (e.state === 'ignored') continue;
    (e.state === 'conflicted' ? g.conflicts : g.changes).push(e);
  }
  return g;
}

const CHECK_TEXT: Record<Check, string> = { on: 'in the commit', off: 'not in the commit', mixed: 'partly in the commit' };

/** Up / Down between the rows of one list. */
function moveFocus(ev: KeyboardEvent): boolean {
  const el = ev.currentTarget as HTMLElement;
  const next = (ev.key === 'ArrowDown' ? el.nextElementSibling : el.previousElementSibling) as HTMLElement | null;
  if (!next?.classList.contains('se-scm-row')) return false;
  next.focus();
  return true;
}

function Row({ s, e, group, check, onCheck }: { s: GitStore; e: GitEntry; group: Group; check?: Check | null; onCheck?: () => void }) {
  const m = markOf(e);
  const name = e.path ? basename(e.path) : '(this folder)';
  const dir = dirname(e.path);
  const btn = (icon: string, title: string, run: () => unknown, cls = '') => (
    <button
      class={`se-icon-btn tiny se-scm-act ${cls}`}
      title={title}
      aria-label={`${title}: ${e.path || 'this folder'}`}
      onClick={(ev) => {
        ev.stopPropagation();
        void run();
      }}
    >
      <Icon name={icon} size={13} />
    </button>
  );
  const openFile = () => (e.state !== 'deleted' && !e.dir ? void app.openFile(e.path) : e.dir ? revealInTree(e.path) : undefined);
  /** Something in the working copy to throw away (a fully staged file has nothing: untick it first). */
  const discardable = group === 'changes' && (e.unstaged || e.state === 'untracked');
  return (
    <div
      class={`se-scm-row se-git-${e.state}`}
      role="listitem"
      tabIndex={0}
      title={`${e.path || 'this folder'}\n${m.title}${group === 'conflicts' ? '' : '\nClick: show the changes · Box or Space: include in the commit'}`}
      aria-label={`${name}, ${m.title}${check ? `, ${CHECK_TEXT[check]}` : ''}`}
      data-path={e.path}
      data-group={group}
      data-check={check ?? undefined}
      onClick={() => (group === 'conflicts' || e.dir || e.submodule ? openFile() : void openFileDiff(s, e.path, e))}
      onDblClick={openFile}
      onKeyDown={(ev) => {
        if (ev.target !== ev.currentTarget) return; // keys on the hover buttons are theirs
        if (ev.key === 'Enter') (ev.currentTarget as HTMLElement).click();
        else if (ev.key === ' ' && onCheck) {
          ev.preventDefault();
          onCheck();
        } else if ((ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && moveFocus(ev)) ev.preventDefault();
      }}
    >
      {check && (
        <span
          class="se-check se-scm-check"
          role="checkbox"
          aria-checked={ariaChecked(check)}
          aria-label={`Include ${e.path || 'this folder'} in the commit`}
          onClick={(ev) => {
            ev.stopPropagation();
            onCheck?.();
          }}
          onDblClick={(ev) => ev.stopPropagation()}
        />
      )}
      <span class="se-scm-ficon">{e.dir || e.submodule ? <FolderIcon open={false} /> : <FileIcon path={e.path} />}</span>
      <span class="se-scm-name">
        {name}
        {e.dir ? '/' : ''}
      </span>
      {dir ? <span class="se-scm-dir">{dir}</span> : <span class="se-scm-dir" />}
      <span class={`se-git-letter se-git-${e.state}`}>{m.letter}</span>
      <span class="se-scm-acts">
        {!e.dir && e.state !== 'deleted' && btn('file', 'Open file', openFile)}
        {group === 'conflicts' && btn('check', 'Mark resolved', () => markResolved(s, e.path), 'resolve')}
        {discardable && btn('undo', e.state === 'untracked' ? 'Discard (move to trash)' : 'Discard changes', () => discard(s, [e.path], e.state === 'untracked' ? 1 : 0), 'discard')}
      </span>
    </div>
  );
}

const headBtn = (icon: string, title: string, run: () => unknown, cls: string) => (
  <button
    class={`se-icon-btn tiny se-scm-act ${cls}`}
    title={title}
    aria-label={title}
    onClick={(ev) => {
      ev.stopPropagation();
      void run();
    }}
  >
    <Icon name={icon} size={13} />
  </button>
);

function Conflicts({ s, list }: { s: GitStore; list: GitEntry[] }) {
  if (!list.length) return null;
  const isOpen = open.value.conflicts;
  return (
    <section class="se-scm-group" data-group="conflicts">
      <div class="se-section-head se-scm-ghead">
        <button class="se-scm-toggle se-section-toggle" aria-expanded={isOpen} onClick={() => toggle('conflicts')}>
          <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={12} class="se-section-chev" />
          <span class="se-section-title">Merge conflicts</span>
          <span class="se-scm-count">{list.length}</span>
        </button>
      </div>
      {isOpen && (
        <div role="list" class="se-scm-list">
          {list.slice(0, ROW_CAP).map((e) => (
            <Row key={`conflicts:${e.path}`} s={s} e={e} group="conflicts" />
          ))}
          {list.length > ROW_CAP && <div class="se-scm-more">… and {list.length - ROW_CAP} more</div>}
        </div>
      )}
    </section>
  );
}

function Changes({ s, list }: { s: GitStore; list: GitEntry[] }) {
  if (!list.length) return null;
  const b = stager(s);
  const checks = list.map((e) => shownCheck(b, e) ?? 'off');
  const all = allOf(checks);
  const n = selectedCount(checks);
  const isOpen = open.value.changes;
  const work = list.filter((e) => e.unstaged || e.state === 'untracked');
  return (
    <section class="se-scm-group" data-group="changes">
      <div class="se-section-head se-scm-ghead">
        <button
          type="button"
          class="se-check se-scm-all"
          role="checkbox"
          aria-checked={ariaChecked(all)}
          aria-label="Include all changes in the commit"
          title={all === 'on' ? 'Leave everything out of the commit' : 'Include everything in the commit'}
          onClick={(ev) => {
            ev.stopPropagation();
            toggleAll(b, list, all !== 'on');
          }}
        />
        <button class="se-scm-toggle se-section-toggle" aria-expanded={isOpen} onClick={() => toggle('changes')}>
          <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={12} class="se-section-chev" />
          <span class="se-section-title">Changes</span>
          <span class="se-scm-sel" data-testid="scm-selected">
            {n} of {list.length} selected
          </span>
        </button>
        <span class="se-scm-acts">{!!work.length && headBtn('undo', 'Discard all changes', () => discard(s, work.map((e) => e.path), work.filter((e) => e.state === 'untracked').length), 'discard-all')}</span>
      </div>
      {isOpen && (
        <div role="list" class="se-scm-list" aria-label="Changes: ticked files go into the commit">
          {list.slice(0, ROW_CAP).map((e, i) => (
            <Row key={`changes:${e.path}`} s={s} e={e} group="changes" check={checks[i]} onCheck={() => toggleEntry(b, e)} />
          ))}
          {list.length > ROW_CAP && <div class="se-scm-more">… and {list.length - ROW_CAP} more</div>}
        </div>
      )}
    </section>
  );
}

// ---- commit box ------------------------------------------------------------------------------

/** The status as the pane shows it: one repository's entries when the folder holds several. */
function paneView(s: GitStore, st: GitStatus): GitStatus {
  const repos = st.repos ?? [];
  if (repos.length <= 1) return st;
  // Same choice as the pane's picker (it reads the signals, so the pane re-renders on a switch).
  const sel = repos.find((r) => r.rel === paneRepo.value) ?? repos.find((r) => r.rel === s.repoOf(app.activePath.value ?? '')?.rel) ?? repos[0];
  return { ...st, branch: sel.branch ?? st.branch, state: sel.state, entries: st.entries.filter((e) => e.path === sel.rel || e.path.startsWith(sel.rel + '/')) };
}

async function doCommit(s: GitStore, push: boolean) {
  // Boxes clicked a moment ago go into git first (Ctrl+Enter right after a click).
  await stager(s).drain();
  if (busy.value) return;
  const cur = s.status.peek();
  if (!cur?.ok) return;
  const st = paneView(s, cur);
  const g = groups(st);
  const merging = st.state === 'merge';
  if (g.conflicts.length) return void app.toast('Resolve the merge conflicts first (mark them resolved)', 'info');
  if (!g.changes.some((e) => e.staged) && !amend.value && !merging) {
    const n = g.changes.length;
    if (!n) return void app.toast('Nothing to commit', 'info');
    if (!(await ui.confirmDialog('Nothing is selected', `Include all ${n} ${n === 1 ? 'change' : 'changes'} and commit them?`, 'Stage all & commit'))) return;
    if (!(await stage(s, null, R())).ok) return;
  }
  const r = await runGit(s, 'Committing', () => git('commit', { message: draft.value, amend: amend.value, repo: R() }));
  if (!r.ok) return;
  draft.value = '';
  amend.value = false;
  if (push) await runGit(s, 'Pushing', () => git('push', R()));
}

/** Pre-fill (never send) a Claude Code prompt that writes the message for the staged changes. */
async function claudeMessage() {
  const t = await import('../terminal/entry');
  const m = await t.showTerminal({ focus: false, autoStart: false });
  await m.askClaude(
    'Write a git commit message for the currently staged changes (run `git diff --cached` to see them). Use an imperative subject line of at most 72 characters, then a blank line and a short body only if it helps. Reply with the message only. ',
  );
}

function CommitBox({ s, st, selected }: { s: GitStore; st: GitStatus; selected: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const merging = st.state === 'merge';
  const where = st.branch.head ? `“${st.branch.head}”` : 'detached HEAD';
  const working = !!busy.value;
  const placeholder = amend.value ? 'Leave empty to keep the last message' : merging ? 'Leave empty for the merge message' : `Message (${prettyKey('Mod-Enter')} to commit on ${where})`;
  useEffect(() => {
    const el = ref.current;
    if (el) el.style.height = `${Math.min(160, Math.max(56, el.scrollHeight))}px`;
  }, [draft.value]);
  const files = `${selected} ${selected === 1 ? 'file' : 'files'}`;
  // The button says what goes in: the ticked files (amend / merge keep their own wording).
  const label = amend.value ? 'Amend' : merging ? 'Commit merge' : selected ? `Commit ${files}` : 'Commit';
  const hint = !amend.value && !merging && !selected ? ' (nothing ticked: offers to include everything)' : '';
  return (
    <div class="se-scm-commit">
      <textarea
        ref={ref}
        class="se-scm-msg"
        aria-label="Commit message"
        placeholder={placeholder}
        value={draft.value}
        spellcheck={!!app.settings.value.spellcheck}
        onInput={(e) => (draft.value = (e.currentTarget as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void doCommit(s, false);
          }
        }}
      />
      <div class="se-scm-commit-row">
        <button class="se-btn primary small se-scm-commit-btn" disabled={working} onClick={() => doCommit(s, false)} title={`${label} (${prettyKey('Mod-Enter')})${hint}`}>
          <Icon name="check" size={13} /> {label}
        </button>
        {/* Reads on from the primary ("Commit 2 files" "& push"): one short row, so ticking files never re-wraps it. */}
        <button class="se-btn small se-scm-commit-push" disabled={working || !st.branch.head} onClick={() => doCommit(s, true)} title={`${label}, then push${hint}`} aria-label={`${label} and push`}>
          & push
        </button>
        <span class="se-scm-spacer" />
        {app.runInTerminal && (
          <button class="se-icon-btn small" title="Ask Claude to write the message (types a prompt into the Claude terminal; you press Enter)" aria-label="Write the message with Claude" onClick={() => void claudeMessage()}>
            <Icon name="sparkle" size={14} />
          </button>
        )}
      </div>
      <label class="se-scm-amend">
        <input
          type="checkbox"
          checked={amend.value}
          disabled={!st.branch.oid}
          onChange={async (e) => {
            const on = (e.currentTarget as HTMLInputElement).checked;
            amend.value = on;
            if (on && !draft.value.trim()) draft.value = await git('lastMessage', R()).catch(() => '');
          }}
        />
        Amend the last commit
      </label>
    </div>
  );
}

// ---- header: branch + sync -------------------------------------------------------------------

function SyncBar({ s, st }: { s: GitStore; st: GitStatus }) {
  const b = st.branch;
  const working = busy.value;
  return (
    <div class="se-scm-sync">
      <button
        class="se-scm-branch"
        title="Branches"
        onClick={() => {
          open.value = { ...open.value, branches: true };
          requestAnimationFrame(() => document.querySelector('.se-scm [data-section="branches"]')?.scrollIntoView({ block: 'nearest' }));
        }}
      >
        <Icon name="gitBranch" size={13} />
        <span class="se-scm-branch-name">{branchLabel(b)}</span>
      </button>
      <span class="se-scm-spacer" />
      {working && <span class="se-scm-busy" role="status">{working}</span>}
      <button
        class="se-icon-btn small"
        title="More"
        aria-label="More source control actions"
        aria-haspopup="menu"
        data-testid="scm-more"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          ui.openContextMenu({ clientX: r.left, clientY: r.bottom + 2, preventDefault() {}, stopPropagation() {} }, [{ label: 'Stop trusting this folder', icon: 'lock', run: () => void stopTrusting(s) }]);
        }}
      >
        <Icon name="more" size={14} />
      </button>
      <button class="se-icon-btn small" title="Fetch" aria-label="Fetch" disabled={!!working} onClick={() => runGit(s, 'Fetching', () => git('fetch', R()), { save: false })}>
        <Icon name="refresh" size={14} />
      </button>
      {b.upstream ? (
        <>
          <button class="se-btn small se-scm-pull" disabled={!!working} title={`Pull from ${b.upstream}`} onClick={() => runGit(s, 'Pulling', () => git('pull', R()))}>
            <Icon name="arrowDown" size={12} /> {b.behind}
          </button>
          <button class="se-btn small se-scm-push" disabled={!!working} title={`Push to ${b.upstream}`} onClick={() => runGit(s, 'Pushing', () => git('push', R()), { save: false })}>
            <Icon name="arrowUp" size={12} /> {b.ahead}
          </button>
        </>
      ) : (
        b.head && (
          <button class="se-btn small se-scm-push" disabled={!!working} title="Push this branch and track it" onClick={() => runGit(s, 'Publishing', () => git('push', R()), { save: false })}>
            <Icon name="arrowUp" size={12} /> Publish
          </button>
        )
      )}
    </div>
  );
}

/** The last failed action. After "no answer in time": Retry reads git's state again (./actions retryRead) —
 *  it never runs the action again; the user does that by hand once git answers. */
export function ErrorBox({ s }: { s: GitStore }) {
  const e = lastError.value;
  if (!e) return null;
  return (
    <div class="se-scm-error" role="alert">
      <pre class="se-scm-error-msg">{e.message}</pre>
      <div class="se-scm-error-row">
        {e.auth && <span class="se-scm-error-hint">Sign in or unlock your key in a terminal — git there can ask you.</span>}
        {e.timeout && (
          <button class="se-btn small" data-testid="git-retry" disabled={s.retrying.value} aria-busy={s.retrying.value} title="Read the repository again (the action itself is not run again)" onClick={() => void retryRead(s, e)}>
            {s.retrying.value ? 'Trying again…' : 'Retry'}
          </button>
        )}
        {e.terminal && (
          <button class="se-btn small" onClick={() => handOff(e.terminal!)} title={e.terminal}>
            <Icon name="terminal" size={13} /> {handOffLabel()}
          </button>
        )}
        <button class="se-icon-btn tiny" aria-label="Dismiss" onClick={() => (lastError.value = null)}>
          <Icon name="close" size={12} />
        </button>
      </div>
    </div>
  );
}

const STATE_TEXT: Record<string, string> = {
  merge: 'Merge in progress: resolve the conflicts, mark them resolved, then commit.',
  rebase: 'Rebase in progress: continue or abort it in the terminal.',
  'cherry-pick': 'Cherry-pick in progress: resolve, then commit.',
  revert: 'Revert in progress: resolve, then commit.',
};

// ---- background lists: shared bits ----------------------------------------------------------

const SKELETON = (
  <div class="se-scm-skel" aria-busy="true" aria-label="Loading">
    {[62, 48, 70].map((w) => (
      <div class="se-skel-row" style={{ width: `${w}%` }} />
    ))}
  </div>
);

function JobError({ error, message, retry }: { error: GitJobError; message?: string; retry: () => void }) {
  return (
    <div class="se-scm-joberr" role="status">
      <span>{error === 'timeout' ? GIT_TIMEOUT_TEXT : `Could not load${message ? `: ${message}` : '.'}`}</span>
      <button class="se-btn small" onClick={retry}>
        Retry
      </button>
    </div>
  );
}

function rowHeight(): number {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h')) || 28;
}

// ---- branches --------------------------------------------------------------------------------

/** Local branch rows rendered at most (the filter box narrows the rest). */
const BRANCH_ROWS = 200;
/** Remote rows visible before the remote list scrolls on its own. */
const REMOTE_ROWS = 12;

type Details = Map<string, GitCommitInfo>;

/** Most recent first, the current branch on top. */
const byDate = (list: GitBranchInfo[], d: Details) => [...list].sort((a, b) => Number(b.current) - Number(a.current) || (d.get(b.oid)?.date ?? 0) - (d.get(a.oid)?.date ?? 0)).map((b) => b.name);

function Branches({ s, st }: { s: GitStore; st: GitStatus }) {
  const [res, setRes] = useState<{ local: GitBranchInfo[]; remoteCount: number; error?: GitJobError; message?: string } | null>(null);
  const [details, setDetails] = useState<Details>(new Map());
  /** Display order of local branches: re-sorted by date once, then stable (rows never jump later). */
  const [order, setOrder] = useState<string[] | null>(null);
  const [pending, setPending] = useState(false);
  const [filter, setFilter] = useState('');
  const [remotesOpen, setRemotesOpen] = useState(false);
  const [nonce, setNonce] = useState(0);
  const isOpen = open.value.branches;
  const head = st.branch.head;
  // Only while expanded. Phase 1 (refs only) is instant; dates follow in the background.
  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    void git('branches', R()).then(
      (r) => {
        if (!alive || r.error === 'cancelled') return;
        setRes({ local: r.branches, remoteCount: r.remoteCount, error: r.error, message: r.message });
        if (r.error || !r.branches.length) return;
        setPending(true);
        void git('branchDetails', r.branches.map((b) => b.oid), 'branches', R()).then((d) => {
          if (!alive || d.error === 'cancelled') return;
          setPending(false);
          setDetails((old) => {
            const m = new Map(old);
            for (const x of d.details) m.set(x.oid, x);
            setOrder((prev) => prev ?? byDate(r.branches, m));
            return m;
          });
        });
      },
      (err) => alive && setRes({ local: [], remoteCount: 0, error: 'failed', message: String(err?.message ?? err) }),
    );
    return () => {
      alive = false;
      cancelJob('branches');
    };
  }, [isOpen, head, st.branch.oid, nonce, paneRepo.value]);
  const dirty = s.marks.value.count;
  // "Current" comes from the live status: the list refreshes a moment after a switch.
  const isCurrent = (b: { name: string; remote?: boolean }) => !b.remote && b.name === head;
  const switchTo = async (b: { name: string; remote?: boolean }) => {
    if (isCurrent(b)) return;
    if (dirty && !(await ui.confirmDialog(`Switch to ${b.name}?`, `You have ${dirty} uncommitted ${dirty === 1 ? 'change' : 'changes'}. Git carries them over to the other branch, or refuses when they would be overwritten.`, 'Switch'))) return;
    await runGit(s, 'Switching', () => git('switchBranch', b.name, R()));
  };
  const create = async () => {
    const name = await ui.promptDialog('New branch', '', 'feature/my-change', 'Create & switch');
    if (name) await runGit(s, 'Creating branch', () => git('createBranch', name, R()));
  };
  const q = filter.trim().toLowerCase();
  const local = useMemo(() => {
    if (!res) return [];
    if (!order) return res.local;
    const by = new Map(res.local.map((b) => [b.name, b]));
    const known = order.filter((n) => by.has(n)).map((n) => by.get(n)!);
    return [...known, ...res.local.filter((b) => !order.includes(b.name))]; // new branches at the end
  }, [res, order]);
  const matches = useMemo(() => (q ? local.filter((b) => b.name.toLowerCase().includes(q)) : local), [local, q]);
  return (
    <section class="se-scm-group" data-section="branches">
      <div class="se-section-head se-scm-ghead">
        <button class="se-scm-toggle se-section-toggle" aria-expanded={isOpen} onClick={() => toggle('branches')}>
          <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={12} class="se-section-chev" />
          <span class="se-section-title">Branches</span>
          {isOpen && res && !res.error && <span class="se-scm-count">{res.local.length}</span>}
        </button>
        <span class="se-scm-acts">
          <button
            class="se-icon-btn tiny se-scm-act"
            title="New branch"
            aria-label="New branch"
            onClick={(e) => {
              e.stopPropagation();
              void create();
            }}
          >
            <Icon name="plus" size={13} />
          </button>
        </span>
      </div>
      {isOpen && (
        <div role="list" class="se-scm-list se-scm-branches">
          {!res && SKELETON}
          {res?.error && <JobError error={res.error} message={res.message} retry={() => (setRes(null), setNonce((n) => n + 1))} />}
          {res && !res.error && res.local.length > 15 && (
            <input class="se-scm-filter" type="search" placeholder={`Filter ${res.local.length} branches`} aria-label="Filter branches" value={filter} onInput={(e) => setFilter((e.currentTarget as HTMLInputElement).value)} />
          )}
          <div class="se-scm-blist">
            {matches.slice(0, BRANCH_ROWS).map((b) => {
              const d = details.get(b.oid);
              return (
                <div class={`se-scm-row se-scm-brow${isCurrent(b) ? ' current' : ''}`} role="listitem" tabIndex={0} data-branch={b.name} title={`${b.name}${d ? `\n${d.subject}\n${ago(d.date)}` : ''}${isCurrent(b) ? '' : '\nClick to switch'}`} onClick={() => switchTo(b)} onKeyDown={(e) => e.key === 'Enter' && switchTo(b)}>
                  <span class="se-scm-bicon">{isCurrent(b) ? <Icon name="check" size={12} /> : <Icon name="gitBranch" size={12} />}</span>
                  <span class="se-scm-name">{b.name}</span>
                  {isCurrent(b) && (st.branch.ahead > 0 || st.branch.behind > 0) ? (
                    <span class="se-scm-dir">
                      ↑{st.branch.ahead} ↓{st.branch.behind}
                    </span>
                  ) : (
                    <span class="se-scm-dir" />
                  )}
                  <span class="se-scm-when">{d ? ago(d.date) : pending ? '…' : ''}</span>
                </div>
              );
            })}
            {res && !res.error && matches.length > BRANCH_ROWS && <div class="se-scm-more">{matches.length - BRANCH_ROWS} more — type to filter</div>}
            {res && !res.error && !matches.length && <div class="se-scm-more">{q ? 'No branch matches' : 'No branches yet'}</div>}
          </div>
          {pending && <div class="se-scm-more se-scm-pending">Still loading dates…</div>}
          {res && !res.error && res.remoteCount > 0 && (
            <>
              <button class="se-scm-row se-scm-subhead se-section-toggle" aria-expanded={remotesOpen} onClick={() => setRemotesOpen(!remotesOpen)}>
                <Icon name={remotesOpen ? 'chevronDown' : 'chevronRight'} size={12} class="se-section-chev" />
                <span class="se-scm-name">Remote branches</span>
                <span class="se-scm-count">{res.remoteCount.toLocaleString()}</span>
              </button>
              {remotesOpen && <RemoteBranches total={res.remoteCount} onPick={(name) => switchTo({ name, remote: true })} />}
            </>
          )}
        </div>
      )}
    </section>
  );
}

/** Virtualised, name-sorted remote branches; names come a window at a time, dates for what is visible. */
function RemoteBranches({ total, onPick }: { total: number; onPick: (name: string) => void }) {
  const [filter, setFilter] = useState('');
  const [view, setView] = useState<{ q: string; total: number; rows: Map<number, { name: string; oid: string }> }>({ q: '', total, rows: new Map() });
  const [details, setDetails] = useState<Details>(new Map());
  const [top, setTop] = useState(0);
  const ROW_H = rowHeight();
  const q = filter.trim();
  const count = view.q === q ? view.total : total;
  const height = Math.max(1, Math.min(count || 1, REMOTE_ROWS)) * ROW_H;
  const first = Math.max(0, Math.floor(top / ROW_H) - 10);
  const last = Math.min(count, Math.ceil((top + height) / ROW_H) + 10);
  // Names for the window (debounced while scrolling / typing; the backend keeps the listing cached).
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      void git('remoteBranches', { offset: first, limit: Math.max(1, last - first), filter: q, repo: R() }).then((p) => {
        if (!alive) return;
        setView((v) => {
          const rows = v.q === q ? new Map(v.rows) : new Map<number, { name: string; oid: string }>();
          p.items.forEach((it, i) => rows.set(first + i, it));
          return { q, total: p.total, rows };
        });
      });
    }, 60);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [first, last, q]);
  // Dates for the visible rows only; scrolling on cancels the batch still running.
  const visible: Array<{ name: string; oid: string }> = [];
  for (let i = first; i < last; i++) {
    const r = view.q === q ? view.rows.get(i) : undefined;
    if (r) visible.push(r);
  }
  const missing = visible.filter((r) => !details.has(r.oid)).map((r) => r.oid);
  const key = missing.join(',');
  useEffect(() => {
    if (!missing.length) return;
    let alive = true;
    const t = setTimeout(() => {
      void git('branchDetails', missing, 'remotes', R()).then((d) => {
        if (!alive || d.error) return;
        setDetails((old) => {
          const m = new Map(old);
          for (const x of d.details) m.set(x.oid, x);
          return m;
        });
      });
    }, 150);
    return () => {
      alive = false;
      clearTimeout(t);
      cancelJob('remotes');
    };
  }, [key]);
  useEffect(() => () => cancelJob('remotes'), []);
  return (
    <div class="se-scm-remotes">
      {total > 15 && <input class="se-scm-filter" type="search" placeholder={`Filter ${total.toLocaleString()} remote branches`} aria-label="Filter remote branches" value={filter} onInput={(e) => (setFilter((e.currentTarget as HTMLInputElement).value), setTop(0))} />}
      {view.q === q && !count && <div class="se-scm-more">No remote branch matches</div>}
      <div class="se-scm-hist" role="list" aria-label="Remote branches" style={{ height: `${height}px` }} onScroll={(e) => setTop((e.currentTarget as HTMLElement).scrollTop)}>
        <div style={{ height: `${count * ROW_H}px`, position: 'relative' }}>
          {Array.from({ length: Math.max(0, last - first) }, (_, k) => {
            const i = first + k;
            const r = view.q === q ? view.rows.get(i) : undefined;
            const d = r && details.get(r.oid);
            return (
              <div
                class="se-scm-row se-scm-brow remote"
                role="listitem"
                tabIndex={r ? 0 : -1}
                data-branch={r?.name}
                style={{ position: 'absolute', top: `${i * ROW_H}px`, left: 0, right: 0 }}
                title={r ? `${r.name}${d ? `\n${d.subject}\n${ago(d.date)}` : ''}\nClick to switch (creates a local tracking branch)` : undefined}
                onClick={() => r && onPick(r.name)}
                onKeyDown={(e) => e.key === 'Enter' && r && onPick(r.name)}
              >
                <span class="se-scm-bicon">
                  <Icon name="gitBranch" size={12} />
                </span>
                <span class="se-scm-name">{r ? r.name : <span class="se-skel-row se-scm-skel-inline" />}</span>
                <span class="se-scm-dir" />
                <span class="se-scm-when">{d ? ago(d.date) : r ? '…' : ''}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---- history ---------------------------------------------------------------------------------

const PAGE = 50;
/** Visible history rows before the list scrolls on its own. */
const HISTORY_ROWS = 14;
const FILE_LETTER: Record<string, string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C', typechange: 'T' };
const FILE_CLS: Record<string, string> = { added: 'added', modified: 'modified', deleted: 'deleted', renamed: 'renamed', copied: 'added', typechange: 'modified' };

interface HistState {
  commits: GitCommit[];
  more: boolean;
  loading: boolean;
  error?: GitJobError;
  message?: string;
}

function History({ st }: { st: GitStatus }) {
  const [h, setH] = useState<HistState>({ commits: [], more: true, loading: false });
  const [sel, setSel] = useState<GitCommit | null>(null);
  const [files, setFiles] = useState<GitCommitFiles | 'loading' | null>(null);
  const [top, setTop] = useState(0);
  const isOpen = open.value.history;
  const gen = useRef(0);
  const state = useRef(h);
  state.current = h;
  /** A page request is in flight (synchronous: effects of one render must not double-load). */
  const inFlight = useRef(false);
  const ROW_H = rowHeight();

  const loadPage = (reset: boolean) => {
    const cur = state.current;
    if (!reset && (inFlight.current || !cur.more || cur.error)) return;
    inFlight.current = true;
    const g = gen.current;
    const skip = reset ? 0 : cur.commits.length;
    setH((x) => ({ ...(reset ? { commits: [], more: true } : x), loading: true, error: undefined }));
    void git('log', { skip, limit: PAGE, repo: R() }).then(
      (p) => {
        if (g !== gen.current || p.error === 'cancelled') return;
        inFlight.current = false;
        setH((x) => ({ commits: reset ? p.commits : [...x.commits, ...p.commits], more: p.more, loading: false, error: p.error, message: p.message }));
      },
      (err) => {
        if (g !== gen.current) return;
        inFlight.current = false;
        setH((x) => ({ ...x, loading: false, error: 'failed', message: String(err?.message ?? err) }));
      },
    );
  };

  // Only while expanded; a new HEAD restarts from the top. Collapsing / closing the pane stops git log.
  useEffect(() => {
    if (!isOpen) return;
    gen.current++;
    setTop(0);
    loadPage(true);
    return () => {
      gen.current++;
      inFlight.current = false;
      cancelJob('history');
      cancelJob('files');
    };
  }, [isOpen, st.branch.oid, paneRepo.value]);

  const pick = (c: GitCommit) => {
    if (sel?.oid === c.oid) {
      setSel(null);
      setFiles(null);
      return cancelJob('files');
    }
    cancelJob('files');
    setSel(c);
    setFiles('loading');
    void git('commitFiles', c.oid, c.parents[0] ?? null, R()).then(
      (r) => r.error !== 'cancelled' && setFiles((f) => (f === 'loading' ? r : f)),
      () => setFiles(null),
    );
  };

  // Virtualised rows: the list scrolls on its own; the next page loads before you reach the end.
  const list = h.commits;
  const height = Math.max(1, Math.min(list.length || 3, HISTORY_ROWS)) * ROW_H;
  const first = Math.max(0, Math.floor(top / ROW_H) - 6);
  const last = Math.min(list.length, Math.ceil((top + height) / ROW_H) + 6);
  useEffect(() => {
    if (isOpen && last >= list.length - 10) loadPage(false);
  }, [isOpen, last, list.length]);

  return (
    <section class="se-scm-group" data-section="history">
      <div class="se-section-head se-scm-ghead">
        <button class="se-scm-toggle se-section-toggle" aria-expanded={isOpen} onClick={() => toggle('history')}>
          <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={12} class="se-section-chev" />
          <span class="se-section-title">History</span>
        </button>
      </div>
      {isOpen && (
        <>
          {!list.length && h.loading && SKELETON}
          {!list.length && !h.loading && !h.error && <div class="se-scm-more">No commits yet</div>}
          {!!list.length && (
            <div class="se-scm-hist" role="list" aria-label="Commits" style={{ height: `${height}px` }} onScroll={(e) => setTop((e.currentTarget as HTMLElement).scrollTop)}>
              <div style={{ height: `${list.length * ROW_H}px`, position: 'relative' }}>
                {list.slice(first, last).map((c, k) => (
                  <div
                    class={`se-scm-row se-scm-crow${sel?.oid === c.oid ? ' selected' : ''}`}
                    role="listitem"
                    tabIndex={0}
                    data-oid={c.oid}
                    aria-selected={sel?.oid === c.oid}
                    style={{ position: 'absolute', top: `${(first + k) * ROW_H}px`, left: 0, right: 0 }}
                    title={`${c.subject}\n${c.author} <${c.email}>\n${new Date(c.date * 1000).toLocaleString()}\n${c.oid}`}
                    onClick={() => pick(c)}
                    onKeyDown={(e) => e.key === 'Enter' && pick(c)}
                  >
                    <Icon name="gitCommit" size={12} class="se-scm-cicon" />
                    <span class="se-scm-name">{c.subject || '(no message)'}</span>
                    <span class="se-scm-dir se-scm-when">{ago(c.date)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {h.loading && !!list.length && <div class="se-scm-more">Loading more…</div>}
          {h.error && <JobError error={h.error} message={h.message} retry={() => (list.length ? (setH((x) => ({ ...x, error: undefined })), setTimeout(() => loadPage(false))) : loadPage(true))} />}
          {sel && (
            <div class="se-scm-cfiles" data-oid={sel.oid}>
              <div class="se-scm-cmeta">
                {sel.short} · {sel.author} · {new Date(sel.date * 1000).toLocaleDateString()}
              </div>
              {files === 'loading' && SKELETON}
              {files && files !== 'loading' && files.error && <JobError error={files.error} message={files.message} retry={() => (setSel(null), pick(sel))} />}
              {files && files !== 'loading' && !files.error && !files.files.length && <div class="se-scm-more">No changes in this folder</div>}
              {files &&
                files !== 'loading' &&
                files.files.slice(0, 500).map((x: GitCommitFile) => (
                  <div class={`se-scm-row se-git-${FILE_CLS[x.status]}`} tabIndex={0} title={`${x.from ? `${x.from} → ` : ''}${x.path}\nClick to see the change`} onClick={() => openCommitDiff(x, files)} onKeyDown={(e) => e.key === 'Enter' && openCommitDiff(x, files)}>
                    <span class="se-scm-ficon">
                      <FileIcon path={x.path} />
                    </span>
                    <span class="se-scm-name">{basename(x.path)}</span>
                    {dirname(x.path) ? <span class="se-scm-dir">{dirname(x.path)}</span> : <span class="se-scm-dir" />}
                    <span class={`se-git-letter se-git-${FILE_CLS[x.status]}`}>{FILE_LETTER[x.status]}</span>
                  </div>
                ))}
              {files && files !== 'loading' && files.files.length > 500 && <div class="se-scm-more">… and {files.files.length - 500} more</div>}
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ---- pane ------------------------------------------------------------------------------------

function Empty({ text, terminal }: { text: string; terminal?: string }) {
  return (
    <div class="se-scm se-scm-empty">
      <Icon name="gitBranch" size={22} />
      <p>{text}</p>
      {terminal && app.runInTerminal && (
        <button class="se-btn small" onClick={() => handOff(terminal)}>
          <Icon name="terminal" size={13} /> Open in terminal
        </button>
      )}
    </div>
  );
}

/** Asked for but not answered with "Trust" in this session: the short form. */
const trustLater = signal(false);

/**
 * An untrusted repository: nothing of git runs (the backend refuses) until the user says so here.
 * A repository's own files decide what git executes, so this is the user's call, once per folder.
 */
function TrustPrompt({ s }: { s: GitStore }) {
  const [working, setWorking] = useState(false);
  const trust = async () => {
    setWorking(true);
    try {
      await git('trust');
      trustLater.value = false;
      s.reset();
    } catch (err) {
      app.toast(String((err as Error)?.message ?? err), 'error');
    } finally {
      setWorking(false);
    }
  };
  if (trustLater.value)
    return (
      <div class="se-scm se-scm-empty" data-testid="git-trust">
        <Icon name="gitBranch" size={22} />
        <p>Git is off in this folder.</p>
        <button class="se-btn small" data-testid="git-trust-yes" disabled={working} onClick={trust}>
          Trust this folder
        </button>
      </div>
    );
  return (
    <div class="se-scm se-scm-empty se-scm-trust" data-testid="git-trust" role="group" aria-label="Trust this folder for git?">
      <Icon name="gitBranch" size={22} />
      <p>
        <strong>This folder is a git repository.</strong>
      </p>
      <p>Its settings can make git run programs (hooks, filters). Trust this folder?</p>
      <div class="se-scm-trust-actions">
        <button class="se-btn small primary" data-testid="git-trust-yes" disabled={working} onClick={trust}>
          Trust
        </button>
        <button class="se-btn small" data-testid="git-trust-no" disabled={working} onClick={() => (trustLater.value = true)}>
          Not now
        </button>
      </div>
      <p class="se-scm-trust-note">Until then git is off here: no status, marks or change bars.</p>
    </div>
  );
}

/**
 * No status for the folder: the reason as one sentence (./ui unavailableText) and, for everything that
 * can pass, Retry — a fresh status through the store (one at a time; the backend repeats a failed first
 * look at the folder). A status that comes back ok replaces this view with the pane.
 */
export function Unavailable({ s, st }: { s: GitStore; st: GitUnavailable }) {
  const trying = s.retrying.value;
  return (
    <div class="se-scm se-scm-empty" data-testid="scm-unavailable" role="status">
      <Icon name="gitBranch" size={22} />
      <p>{unavailableText(st)}</p>
      {canRetry(st) && (
        <button class="se-btn small" data-testid="git-retry" disabled={trying} aria-busy={trying} onClick={() => void s.retry()}>
          <Icon name="refresh" size={13} /> {trying ? 'Trying again…' : 'Retry'}
        </button>
      )}
    </div>
  );
}

const NO_REPO = unavailableText({ ok: false, reason: 'no-repo' });

export function SourceControl() {
  const s = installGit(); // idempotent: the pane may open before the idle load

  useEffect(() => {
    s?.refresh(true);
  }, []);
  if (!s) return <Empty text={app.workspace.value ? 'Source control is not available here.' : 'Open a folder to use source control.'} />;
  const st = s.status.value;
  if (!st) return <div class="se-scm se-scm-loading" aria-busy="true" />;
  if (!st.ok && st.reason === 'untrusted') return st.repoLikely ? <TrustPrompt s={s} /> : <Empty text={NO_REPO} terminal="git init" />;
  if (!st.ok) return st.reason === 'no-repo' ? <Empty text={NO_REPO} terminal="git init" /> : <Unavailable s={s} st={st} />;
  // Several repositories below this folder: the pane works on one at a time.
  const repos = st.repos ?? [];
  const multi = repos.length > 1;
  const sel = multi ? (repos.find((r) => r.rel === paneRepo.value) ?? repos.find((r) => r.rel === s.repoOf(app.activePath.value ?? '')?.rel) ?? repos[0]) : null;
  if (sel && paneRepo.peek() !== sel.rel) queueMicrotask(() => (paneRepo.value = sel.rel));
  if (!multi && paneRepo.peek()) queueMicrotask(() => (paneRepo.value = ''));
  const view = paneView(s, st);
  const g = groups(view);
  const clean = !g.conflicts.length && !g.changes.length;
  const b = stager(s);
  const selected = g.changes.reduce((n, e) => n + (shownCheck(b, e) === 'off' ? 0 : 1), 0);
  return (
    <div class="se-scm" data-testid="scm">
      {multi && (
        <label class="se-scm-repo">
          <Icon name="folder" size={13} />
          <select aria-label="Repository" value={sel?.rel} onChange={(e) => (paneRepo.value = (e.currentTarget as HTMLSelectElement).value)}>
            {repos.map((r) => (
              <option value={r.rel}>
                {r.rel}
                {r.branch ? ` · ${branchLabel(r.branch)}` : ' · unavailable'}
              </option>
            ))}
          </select>
        </label>
      )}
      <SyncBar s={s} st={view} />
      {view.state && <div class="se-scm-state">{STATE_TEXT[view.state]}</div>}
      <CommitBox s={s} st={view} selected={selected} />
      <ErrorBox s={s} />
      <div class="se-scm-scroll">
        <Conflicts s={s} list={g.conflicts} />
        <Changes s={s} list={g.changes} />
        {clean && <div class="se-scm-clean">No changes since the last commit.</div>}
        <Branches s={s} st={view} />
        <History st={view} />
      </div>
    </div>
  );
}
