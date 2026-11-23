// "AI changes" (sidebar, lazy chunk): the files an agent terminal started from One (Claude Code, Opencode) changed,
// with +/− lines, grouped by the turn that last changed them. The newest turn is open, older ones are folded; a row
// opens the file. The numbers are a diff's once a turn is done (estimates until then, drawn dimmer).
import { basename, dirname } from '@shared/paths';
import { AGENT_NAMES, type AgentChangeFile } from '@shared/terminal';
import { app } from '../../app/app';
import * as ui from '../../app/ui';
import { FileIcon, Icon } from '../../app/icons';
import { absolutePath, copyText, revealInTree } from '../../app/fileops';
import { changes, clearChanges, foldAll, foldTurn, groupByTurn, isReviewed, lists, pickList, setReviewed, totals, type AgentChanges, type TurnGroup } from './store';
import './changes.css';

export * from './store';

const LETTER = { added: 'A', deleted: 'D', modified: 'M' } as const;
const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;
const turnName = (turn: number) => (turn > 0 ? `Turn ${turn}` : 'Before the first turn');

/** "Claude Code", or "Claude Code 2" for a second terminal of the same agent. */
export function listName(c: AgentChanges, all: readonly AgentChanges[] = lists.value): string {
  const same = all.filter((l) => l.agent === c.agent);
  return same.length > 1 ? `${AGENT_NAMES[c.agent]} ${same.indexOf(c) + 1}` : AGENT_NAMES[c.agent];
}

const open = (path: string) => void app.openFile(path);

/** The usual diff view of the file against the last commit (says why itself when git cannot tell). */
async function showDiff(path: string) {
  try {
    const store = (await import('../../git/index')).getGitStore();
    if (store) return void (await (await import('../../git/diff-open')).openFileDiff(store, path));
  } catch {}
  app.toast('No git here: nothing to compare with', 'info');
}

export function rowMenu(c: AgentChanges, f: AgentChangeFile): ui.MenuItem[] {
  const gone = f.status === 'deleted';
  return [
    { label: 'Open', icon: 'file', disabled: gone, run: () => open(f.path) },
    { label: 'Show diff vs last commit', run: () => showDiff(f.path) },
    { label: 'Reveal in Files', icon: 'files', disabled: gone, run: () => revealInTree(f.path) },
    { separator: true },
    { label: 'Copy path', icon: 'copy', run: () => copyText(absolutePath(f.path)) },
    { label: 'Copy relative path', run: () => copyText(f.path, 'Relative path') },
    { separator: true },
    { label: isReviewed(c, f) ? 'Mark as not reviewed' : 'Mark as reviewed', icon: 'check', run: () => setReviewed(c.id, [f.path]) },
  ];
}

export function turnMenu(c: AgentChanges, g: TurnGroup): ui.MenuItem[] {
  const paths = g.files.map((f) => f.path);
  const done = g.files.length > 0 && g.files.every((f) => isReviewed(c, f));
  return [
    { label: g.open ? 'Collapse' : 'Expand', run: () => foldTurn(c.id, g.turn) },
    { label: 'Collapse others', run: () => foldAll(c.id, g.turn) },
    { label: 'Expand all', run: () => foldAll(c.id) },
    { separator: true },
    { label: done ? 'Mark all as not reviewed' : 'Mark all as reviewed', icon: 'check', disabled: !paths.length, run: () => setReviewed(c.id, paths, !done) },
    { label: 'Copy file list', icon: 'copy', disabled: !paths.length, run: () => copyText(paths.join('\n'), 'File list') },
  ];
}

/** ↑ / ↓ walk the headers and rows; ← folds the turn (from a row: goes to its header first), → unfolds it. Enter / Space are the buttons' own. */
function onKey(e: KeyboardEvent, c: AgentChanges) {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  const at = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-nav]');
  const list = e.currentTarget as HTMLElement;
  if (!at) return;
  const turn = Number(at.dataset.turn);
  const head = at.classList.contains('se-ai-turn');
  const step = (d: 1 | -1) => {
    const all = [...list.querySelectorAll<HTMLElement>('[data-nav]')];
    all[all.indexOf(at) + d]?.focus();
  };
  if (e.key === 'ArrowDown') step(1);
  else if (e.key === 'ArrowUp') step(-1);
  else if (e.key === 'ArrowLeft') {
    if (!head) list.querySelector<HTMLElement>(`.se-ai-turn[data-turn="${turn}"]`)?.focus();
    else if (at.getAttribute('aria-expanded') === 'true') foldTurn(c.id, turn, false);
  } else if (e.key === 'ArrowRight' && head) {
    if (at.getAttribute('aria-expanded') === 'true') step(1);
    else foldTurn(c.id, turn, true);
  } else return;
  e.preventDefault();
}

function Turn({ c, g }: { c: AgentChanges; g: TurnGroup }) {
  return (
    <div class="se-ai-group" role="group">
      <button
        type="button"
        class="se-ai-turn"
        data-nav
        data-turn={g.turn}
        aria-expanded={g.open}
        title={g.open ? 'Collapse this turn' : 'Expand this turn'}
        onClick={() => foldTurn(c.id, g.turn)}
        onContextMenu={(e) => ui.openContextMenu(e, turnMenu(c, g))}
      >
        <Icon name={g.open ? 'chevronDown' : 'chevronRight'} size={13} />
        <span class="se-ai-turn-name">{turnName(g.turn)}</span>
        <span class="se-ai-turn-count">
          {' · '}
          {g.files.length || !g.live ? plural(g.files.length, 'file') : 'working…'}
        </span>
        <span class="se-ai-nums">
          <span class="se-ai-add">+{g.additions}</span> <span class="se-ai-del">−{g.deletions}</span>
        </span>
      </button>
      {g.open &&
        g.files.map((f) => {
          const dir = dirname(f.path);
          const gone = f.status === 'deleted';
          return (
            <button
              type="button"
              key={f.path}
              class={`se-ai-row ${f.status}${f.exact ? '' : ' est'}${isReviewed(c, f) ? ' reviewed' : ''}`}
              data-nav
              data-turn={g.turn}
              data-path={f.path}
              title={gone ? `${f.path}\nDeleted` : f.path}
              aria-disabled={gone || undefined}
              onClick={() => !gone && open(f.path)}
              onContextMenu={(e) => ui.openContextMenu(e, rowMenu(c, f))}
            >
              <FileIcon path={f.path} />
              <span class="se-ai-name">{basename(f.path)}</span>
              {dir && dir !== '.' && <span class="se-ai-dir">{dir}</span>}
              <span class="se-ai-nums">
                <span class="se-ai-add">+{f.additions}</span> <span class="se-ai-del">−{f.deletions}</span>
              </span>
              <span class="se-ai-st" title={f.status}>
                {LETTER[f.status]}
              </span>
            </button>
          );
        })}
      {g.open && !g.files.length && <div class="se-ai-wait">Waiting for the first change…</div>}
    </div>
  );
}

export function AiChanges() {
  const all = lists.value;
  const c = changes.value;
  const groups = c ? groupByTurn(c) : [];
  const sum = c ? totals(c.files) : null;
  const name = c ? listName(c, all) : '';
  return (
    <div class="se-ai" data-busy={c?.busy ? '1' : undefined}>
      <div class="se-ai-head">
        <span class="se-ai-title">AI changes</span>
        {c?.busy && (
          <span class="se-ai-live" title={`${name} is working`}>
            <span class="se-ai-dot" />
            working
          </span>
        )}
        {c && (
          <button type="button" class="se-ai-clear" title="Clear the list" aria-label="Clear the list" onClick={() => clearChanges(c.id)}>
            <Icon name="close" size={12} />
          </button>
        )}
      </div>
      {all.length > 1 && (
        <div class="se-ai-tabs" role="tablist" aria-label="Agent terminals">
          {all.map((l) => (
            <button type="button" key={l.id} role="tab" class="se-ai-tab" aria-selected={l === c} title={l.ended ? 'Session ended' : l.busy ? 'Working' : undefined} onClick={() => pickList(l.id)}>
              {l.busy && <span class="se-ai-dot" />}
              {listName(l, all)}
            </button>
          ))}
        </div>
      )}
      {!c ? (
        <div class="se-ai-empty">
          Start Claude Code or Opencode from the terminal panel with “Follow Claude’s edits” or “Follow Opencode’s edits” on (Settings → Terminal). The files it changes are listed here, turn by turn, as it works.
        </div>
      ) : !groups.length ? (
        <div class="se-ai-empty">
          {name}: no changes yet.{c.ended && ' Session ended.'}
        </div>
      ) : (
        <>
          <div class="se-ai-sum">
            {name} · {plural(c.files.length, 'file')} · {plural(c.turns, 'turn')} <span class="se-ai-add">+{sum!.additions}</span> <span class="se-ai-del">−{sum!.deletions}</span>
            {c.ended && <span class="se-ai-ended"> · session ended</span>}
          </div>
          <div class="se-ai-list" onKeyDown={(e) => onKey(e, c)}>
            {groups.map((g) => (
              <Turn key={g.turn} c={c} g={g} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
