// Process explorer rows only Electron knows: Chromium's per-process accounting (app.getAppMetrics —
// CPU since the previous call, memory; Windows: private bytes) and which children are terminal shells.
// Registered at launch, but only read while the explorer is open (see backend/processes.ts).
import { app } from 'electron';
import type { ProcessSource } from '../backend/processes';
import type { ProcRow } from '../shared/processes';

/** `uiPids`: every app window's renderer, the focused (else last focused) window first: it is "the" UI row the explorer
 *  hangs its own workers under (the explorer is open in the window the user looks at); the others are UI rows too. */
export function electronProcessSource(o: { shellPids: () => number[]; uiPids: () => number[] }): ProcessSource {
  let primed = false; // percentCPUUsage is "since the previous call": the first one means nothing
  let pids: number[] = [];
  return {
    id: 'electron',
    shellPids: o.shellPids,
    ownPids: () => pids,
    rows(): ProcRow[] {
      const metrics = app.getAppMetrics();
      pids = metrics.map((m) => m.pid);
      const uiPids = o.uiPids();
      const rows = metrics.map((m): ProcRow => {
        const priv = process.platform === 'win32' ? m.memory.privateBytes : undefined;
        const mem = (priv || m.memory.workingSetSize) / 1024; // KB → MB
        const base = { pid: m.pid, cpu: primed ? m.cpu.percentCPUUsage : null, mem: Math.round(mem * 10) / 10, memKind: priv ? ('private' as const) : ('working set' as const) };
        if (m.type === 'Browser') return { ...base, id: 'main', name: 'Main process', kind: 'app' };
        if (m.type === 'Tab' && m.pid === uiPids[0]) return { ...base, id: 'renderer', parent: 'main', name: 'UI (renderer)', kind: 'app', activity: ['tree'] };
        if (m.type === 'Tab' && uiPids.includes(m.pid)) return { ...base, id: `pid:${m.pid}`, parent: 'main', name: 'UI (renderer, another window)', kind: 'app' };
        if (m.type === 'Tab') return { ...base, id: `pid:${m.pid}`, parent: 'main', name: 'Renderer (other window)', kind: 'app' };
        if (m.type === 'GPU') return { ...base, id: 'gpu', parent: 'main', name: 'GPU process', kind: 'app' };
        const what = m.serviceName ? m.serviceName.replace(/^.*\./, '') : m.name || m.type;
        return { ...base, id: `pid:${m.pid}`, parent: 'main', name: `${m.type === 'Utility' ? 'Utility' : m.type}: ${what}`, kind: 'helper' };
      });
      primed = true;
      return rows;
    },
  };
}
