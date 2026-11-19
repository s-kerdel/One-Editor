// Playwright side of tests/perf/cpu-meter.ts: skip wall-clock asserts (annotated) on a busy machine.
import { test } from '@playwright/test';
import type { CpuLoad } from '../perf/cpu-meter';

export { cpuLoadMeter, describeLoad, type CpuLoad } from '../perf/cpu-meter';

/** Wall-clock asserts follow only without a heavy outside job; otherwise skip with the reason. */
export function skipIfBusy(load: CpuLoad, what: string): void {
  if (!load.busy) return;
  const why = `${what}: another job kept ${load.externalCpus} of ${load.cpus} CPUs busy during the measurement — wall-clock budget not measurable`;
  test.info().annotations.push({ type: 'machine-busy', description: why });
  test.skip(true, why);
}
