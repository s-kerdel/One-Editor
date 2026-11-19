// Tests only: latency injection on every file-system operation the indexer and the workspace do
// (open / stat / readdir), to reproduce slow file systems on a fast dev box — a `\\wsl.localhost\…`
// root (9P bridge, 1–5 ms per call) or Windows Defender scanning every open.
//   SEC_EDIT_TEST_FS_LATENCY_MS=3   (SEC_EDIT_TEST_OPEN_DELAY_MS is an older alias)
const ms = () => Number(process.env.SEC_EDIT_TEST_FS_LATENCY_MS || process.env.SEC_EDIT_TEST_OPEN_DELAY_MS) || 0;
let nap: Int32Array | null = null;

/** Blocks this thread (sync file-system calls: worker threads only). */
export function fsDelay(): void {
  const d = ms();
  if (!d) return;
  nap ??= new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(nap, 0, 0, d);
}

/** Async file-system calls: waits without blocking the event loop. */
export function fsDelayAsync(): Promise<void> | null {
  const d = ms();
  return d ? new Promise((r) => setTimeout(r, d)) : null;
}
