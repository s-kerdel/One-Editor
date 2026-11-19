// "Developer: Process explorer" — what runs in the editor and what it costs (Chrome-task-manager
// style), refreshed every 2 s while open. Closed: no timer, no observer, no backend helper.
// Backend rows: shared/processes.ts + backend/processes.ts; UI rows: here + ./sources.ts.
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { app } from '../app';
import { activityNow, confirmDialog } from '../ui';
import { activityLog } from '../activity';
import { copyText } from '../fileops';
import { searchClient } from '../../search/client';
import { indexOnDemand } from '../../search/demand';
import { extractor } from '../../knowledge/extractor';
import { procText, toMB, treeOrder, type ProcAction, type ProcRow, type ProcSnapshot } from '@shared/processes';
import { uiSourceRows } from './sources';
import './process-explorer.css';

export const REFRESH_MS = 2000;

/** Test hook: what the explorer keeps alive (all 0 once it is closed). */
export const explorerLive = { timers: 0, observers: 0, polls: 0 };

const ACTION_LABEL: Record<ProcAction, string> = { stopGit: 'Stop', stopForeground: 'Stop', kill: 'End', restartIndexer: 'Restart' };

function ago(at: number) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

/** Current run (+ why), else the last run and how long ago — from the shared activity log. */
function doingNow(r: ProcRow): string {
  if (r.doing) return r.doing;
  if (!r.activity?.length) return '';
  if (r.activity.includes('index') && searchClient.status.value === 'indexing' && activityNow.value) return activityNow.value;
  const log = activityLog.value;
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (r.activity.includes(e.kind)) return `last: ${e.kind} (${e.trigger}${e.detail ? `, ${e.detail}` : ''}) · ${ago(e.at)}`;
  }
  return '';
}

/** Rows only this window knows: itself, its search shards and knowledge workers, registered sources. */
function uiRows(snap: ProcSnapshot, longTaskMs: number, intervalMs: number, renderMs: number): ProcRow[] {
  const web = app.backend.kind === 'web';
  const heap = (performance as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
  const busy = intervalMs > 0 ? Math.min(100, (longTaskMs / intervalMs) * 100) : null;
  const rows: ProcRow[] = [];
  const own = snap.rows.find((r) => r.id === 'renderer');
  const uiDetail = [heap ? `JS heap ${toMB(heap)} MB` : '', 'busy = tasks over 50 ms'].filter(Boolean).join(' · ');
  if (own) Object.assign(own, { busy, detail: uiDetail });
  else rows.push({ id: 'renderer', parent: web ? undefined : 'main', kind: 'app', name: web ? 'This tab (browser)' : 'UI (renderer)', mem: heap ? toMB(heap) : null, memKind: 'JS heap', busy, detail: web ? 'CPU of a browser tab is not visible to the page' : uiDetail, activity: ['tree'] });

  const ports = (searchClient as unknown as { ports?: unknown[] }).ports?.length ?? 0;
  const status = searchClient.status.value;
  const idleWhy = indexOnDemand() ? 'index built on demand — not asked for yet' : 'starts once the app is idle after launch';
  rows.push({
    id: 'search',
    parent: 'renderer',
    kind: 'worker',
    name: ports ? `Search (${ports} shard worker${ports === 1 ? '' : 's'})` : 'Search',
    state: status === 'idle' ? 'not started' : status,
    detail: status === 'idle' ? idleWhy : `${searchClient.indexed.value.toLocaleString()} files indexed${searchClient.mode.value === 'inline' ? ' · in this thread' : ''}`,
    activity: ['index', 'index-update'],
  });
  for (let i = 0; i < ports; i++) rows.push({ id: `shard:${i}`, parent: 'search', kind: 'worker', name: `Shard ${i + 1}${i === 0 && ports > 1 ? ' (reads the text pages)' : ''}`, state: status === 'indexing' ? 'indexing' : 'ready' });

  const ex = extractor as unknown as { workers?: unknown[]; busy?: number[]; mode?: string };
  const nWorkers = ex.workers?.length ?? 0;
  const nBusy = (ex.busy ?? []).filter((n) => n > 0).length;
  rows.push({
    id: 'knowledge',
    parent: 'renderer',
    kind: 'worker',
    name: nWorkers ? `Knowledge extraction (${nWorkers} worker${nWorkers === 1 ? '' : 's'})` : 'Knowledge extraction',
    state: nWorkers ? (nBusy ? `${nBusy} busy` : 'idle') : ex.mode === 'inline' ? 'in this thread' : 'stopped',
    detail: nWorkers ? undefined : 'workers start for big edits, stop after 30 s idle',
  });
  rows.push(...uiSourceRows());

  const self = snap.rows.find((r) => r.id === 'explorer');
  if (self && intervalMs > 0) {
    self.cpu = (self.cpu ?? 0) + (renderMs / intervalMs) * 100;
    self.detail = `${self.detail ?? ''} + this table ${renderMs.toFixed(1)} ms`;
  }
  if (web) rows.push({ id: 'desktop-only', kind: 'helper', name: 'GPU, terminals, Chromium processes', state: 'desktop only' });
  return rows;
}

function cell(v: number | null | undefined, digits = 1) {
  return v == null || !Number.isFinite(v) ? '—' : v.toFixed(digits);
}

function ProcessExplorer() {
  const [snap, setSnap] = useState<ProcSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const longTasks = useRef(0);
  const prev = useRef<{ at: number; longTasks: number } | null>(null);
  const renderMs = useRef(0);
  const t0 = performance.now();
  const close = () => (app.overlay.value = null);

  useEffect(() => {
    let alive = true;
    let obs: PerformanceObserver | null = null;
    try {
      obs = new PerformanceObserver((l) => l.getEntries().forEach((e) => (longTasks.current += e.duration)));
      obs.observe({ type: 'longtask' });
      explorerLive.observers++;
    } catch {
      obs = null;
    }
    const poll = async () => {
      if (document.visibilityState === 'hidden') return; // minimised: nobody is looking
      explorerLive.polls++;
      try {
        const s = await app.backend.processes?.({ op: 'snapshot' });
        if (!alive) return;
        if (s && typeof s === 'object') setSnap(s);
        else setError('This backend has no process information.');
      } catch (err) {
        if (alive) setError((err as Error).message);
      }
    };
    void poll();
    const timer = setInterval(poll, REFRESH_MS);
    explorerLive.timers++;
    return () => {
      alive = false;
      clearInterval(timer);
      explorerLive.timers--;
      if (obs) {
        obs.disconnect();
        explorerLive.observers--;
      }
      void app.backend.processes?.({ op: 'close' }).catch(() => {});
    };
  }, []);
  useLayoutEffect(() => void (renderMs.current = performance.now() - t0));

  let ordered: Array<{ row: ProcRow; depth: number; doing: string }> = [];
  if (snap) {
    const p = prev.current;
    const intervalMs = p ? snap.at - p.at : 0;
    const lt = longTasks.current - (p?.longTasks ?? 0);
    if (!p || p.at !== snap.at) prev.current = { at: snap.at, longTasks: longTasks.current };
    const rows = [...snap.rows.map((r) => ({ ...r })), ...uiRows(snap, lt, intervalMs, renderMs.current)];
    ordered = treeOrder(rows).map((x) => ({ ...x, doing: doingNow(x.row) }));
  }

  const act = async (r: ProcRow, a: ProcAction) => {
    const backend = app.backend;
    if (a === 'restartIndexer') {
      await backend.processes?.({ op: 'restartIndexer' });
      if (searchClient.status.value !== 'idle') void searchClient.reindex();
      app.toast('Indexer restarted — the index rebuilds from the cache', 'info');
      return;
    }
    const title = a === 'stopGit' ? `Stop “${r.name}”?` : a === 'stopForeground' ? `Stop “${r.name}” in the terminal?` : `End “${r.name}” (PID ${r.pid})?`;
    const msg =
      a === 'stopGit'
        ? 'git stops mid-way. A write (commit, checkout, rebase) can leave .git/index.lock behind — delete it if git then refuses to run.'
        : a === 'stopForeground'
          ? 'It and what it started get a terminate signal (firmer than Ctrl+C). The shell keeps running.'
          : 'It gets a terminate signal. Unsaved work in it is lost.';
    if (!(await confirmDialog(title, msg, ACTION_LABEL[a], true))) return;
    const ok = await backend.processes?.({ op: 'kill', pid: r.pid!, group: a === 'stopForeground' });
    app.toast(ok ? `${r.name} stopped` : `Could not stop ${r.name} (it may have finished)`, ok ? 'success' : 'error');
  };

  const copy = () => {
    const head = `sec-edit process list · ${snap?.platform ?? ''} · ${new Date().toISOString()}${snap?.notes?.length ? `\n${snap.notes.join('\n')}` : ''}`;
    void copyText(procText(ordered, head), 'Process list');
  };

  return (
    <div class="se-overlay se-dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div class="se-dialog se-procx" role="dialog" aria-modal="true" aria-label="Process explorer" tabIndex={-1} ref={(el) => el?.focus()} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), close())}>
        <div class="se-procx-head">
          <h2 class="se-dialog-title">Process explorer</h2>
          <button class="se-btn" onClick={copy} disabled={!snap}>
            Copy as text
          </button>
        </div>
        <p class="se-dialog-msg">What runs in the editor and what it costs. Refreshes every 2 s while open; nothing is measured when closed.</p>
        {error && <p class="se-dialog-msg se-procx-error">{error}</p>}
        <div class="se-procx-list">
          {!snap ? (
            <p class="se-dialog-msg">Measuring…</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th class="n">PID</th>
                  <th class="n" title="% of one CPU core over the last refresh">CPU %</th>
                  <th class="n" title="Event-loop utilisation: how busy a thread is (where per-thread CPU is not available)">Busy %</th>
                  <th class="n">Memory</th>
                  <th>State</th>
                  <th>Doing now</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {ordered.map(({ row: r, depth, doing }) => (
                  <tr key={r.id} data-row={r.id} data-kind={r.kind}>
                    <td class="se-procx-name" style={{ paddingLeft: `${8 + depth * 14}px` }} title={r.detail}>
                      {r.name}
                    </td>
                    <td class="n">{r.pid ?? ''}</td>
                    <td class="n">{cell(r.cpu)}</td>
                    <td class="n">{cell(r.busy, 0)}</td>
                    <td class="n" title={r.memKind}>
                      {r.mem == null ? '—' : `${cell(r.mem)} MB`}
                    </td>
                    <td class="se-procx-state" title={r.detail}>
                      {[r.state, r.detail].filter(Boolean).join(' · ')}
                    </td>
                    <td class="se-procx-doing" title={doing}>
                      {doing}
                    </td>
                    <td class="se-procx-act">
                      {r.actions?.map((a) => (
                        <button class="se-btn" data-action={a} onClick={() => void act(r, a)}>
                          {ACTION_LABEL[a]}
                        </button>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {snap?.notes?.length ? <p class="se-dialog-msg se-procx-notes">{snap.notes.join(' · ')}</p> : null}
      </div>
    </div>
  );
}

export function openProcessExplorer() {
  app.overlay.value = ProcessExplorer;
}
