// CPU used OUTSIDE this test's own process tree (worker + browser / Electron + in-process server) over a
// measurement window. Wall-clock budgets measure the machine as much as the app: when another job keeps
// the CPUs busy the app's thread shares its core (SMT) and every number grows with it. Timing tests meter
// their window and skip the wall-clock asserts (annotated, never silently passed) when the machine was
// busy; without a heavy outside job every budget applies unchanged. Linux /proc only; elsewhere the meter
// reads 0 (budgets apply).
import fs from 'node:fs';
import os from 'node:os';

export interface CpuLoad {
  /** Average number of logical CPUs kept busy by processes outside this test during the window. */
  externalCpus: number;
  cpus: number;
  /** An outside job used at least a quarter of the CPUs: wall-clock budgets are not measurable. */
  busy: boolean;
}

const read = (p: string) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

/** Busy and total clock ticks, all CPUs (steal counts as busy: a hypervisor neighbour is outside load too). */
function machineTicks(): { busy: number; total: number } | null {
  const line = read('/proc/stat')?.split('\n')[0];
  if (!line) return null;
  const f = line.trim().split(/\s+/).slice(1).map(Number);
  const total = f.slice(0, 8).reduce((a, b) => a + b, 0); // guest time is already inside user / nice
  return { busy: total - f[3] - (f[4] ?? 0), total };
}

/** CPU ticks of this process and all descendants (incl. reaped children: cutime / cstime). */
function treeTicks(pid = process.pid, seen = new Set<number>()): number {
  if (seen.has(pid)) return 0;
  seen.add(pid);
  const stat = read(`/proc/${pid}/stat`);
  if (!stat) return 0;
  const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ').map(Number); // f[0] = field 3 (state)
  let ticks = f[11] + f[12] + f[13] + f[14]; // utime stime cutime cstime
  let tids: string[] = [];
  try {
    tids = fs.readdirSync(`/proc/${pid}/task`);
  } catch {
    /* exited meanwhile */
  }
  for (const tid of tids) {
    for (const c of (read(`/proc/${pid}/task/${tid}/children`) ?? '').split(' ').filter(Boolean)) ticks += treeTicks(Number(c), seen);
  }
  return ticks;
}

/** Start metering; `stop()` returns how much CPU outside processes used meanwhile. */
export function cpuLoadMeter(): { stop(): CpuLoad } {
  const cpus = os.availableParallelism?.() ?? os.cpus().length;
  const m0 = machineTicks();
  const own0 = m0 ? treeTicks() : 0;
  return {
    stop() {
      const m1 = machineTicks();
      if (!m0 || !m1 || m1.total <= m0.total) return { externalCpus: 0, cpus, busy: false };
      const own = treeTicks() - own0;
      const perCpu = (m1.total - m0.total) / cpus;
      const externalCpus = Math.max(0, Math.round(((m1.busy - m0.busy - own) / perCpu) * 10) / 10);
      return { externalCpus, cpus, busy: externalCpus >= Math.max(1, cpus / 4) };
    },
  };
}

export const describeLoad = (l: CpuLoad) => `outside load ${l.externalCpus}/${l.cpus} CPUs${l.busy ? ' (busy machine)' : ''}`;
