// `node dist/server/cli.mjs [folder] [--port N] [--host H] [--open]` — browser mode.
// `--ipc` (the desktop app's "Start web server", src/main/web-server.ts): the result goes to the parent
// over the Node IPC channel as data ({ type: 'ready', port, token, busy? } or { type: 'error', … }) instead of
// the printed URL, a 'stop' message or the parent going away ends the server.
// Without --port the folder's last port is tried first (browser state is per port), then 4317, 4318, …
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { startServer, type RunningServer } from './server';
import { isBridgeRoot } from '../backend/readpool';
import { defaultConfigDir } from '../backend/service';
import { portCandidates, rememberPort, rememberedPort } from './ports';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args.splice(i, 2)[1];
};
const bool = (name: string) => {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
};
if (bool('--help') || bool('-h')) {
  console.log('Usage: sec-edit serve [folder] [--port 4317] [--host 127.0.0.1] [--open]');
  process.exit(0);
}
const portArg = flag('--port');
const host = flag('--host') ?? '127.0.0.1';
const shouldOpen = bool('--open');
const ipc = bool('--ipc') && typeof process.send === 'function';
/** --ipc: report a failure as data and exit once it is delivered. */
const fail = (code: string, message: string) => new Promise<never>(() => process.send!({ type: 'error', code, message }, () => process.exit(1)));
// The desktop app quit or crashed (its end of the channel closed): never outlive it, not even mid-start.
if (ipc) process.on('disconnect', () => (srv ? stop() : process.exit(0)));
const root = path.resolve(args[0] ?? process.cwd());
// More libuv threads (default 4) only for a slow root (WSL, network), before the pool starts: there
// each readdir / open blocks one, and a tree walk must not starve file opens. Locally they only contend.
if (!process.env.UV_THREADPOOL_SIZE && isBridgeRoot(root)) process.env.UV_THREADPOOL_SIZE = '16';
const here = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = process.env.SEC_EDIT_RENDERER_DIR || path.resolve(here, '../renderer');

// Default port is "sticky but polite": this folder's last port, then 4317.., or exactly --port if given.
let srv: RunningServer | null = null;
let stopping = false;
const configDir = defaultConfigDir(); // the same folder startServer's backend uses (SEC_EDIT_CONFIG_DIR wins)
const remembered = portArg ? null : await rememberedPort(configDir, root).catch(() => null);
const candidates = portCandidates(portArg ? Number(portArg) : null, remembered);
const first = candidates[0];
for (const port of candidates) {
  try {
    srv = await startServer({ root, port, host, rendererDir });
    break;
  } catch (err: any) {
    if (err?.code === 'EADDRINUSE') continue;
    if (!ipc) throw err;
    await fail(err?.code || 'EIO', String(err?.message || err));
  }
}
if (!srv) {
  if (ipc) await fail('EADDRINUSE', portArg ? `Port ${first} is in use` : `Ports ${candidates.join(', ')} are in use`);
  console.error(`Port ${first} is in use. Pass --port <n>.`);
  process.exit(1);
}
// The folder's usual port was taken: the browser sees a new origin, so its state for this folder starts empty.
const busy = remembered !== null && srv.port !== remembered ? remembered : null;
void rememberPort(configDir, root, srv.port).catch(() => {});
// --ipc: the URL holds the token, so it goes to the parent only (never printed, never in a log).
if (ipc) process.send!({ type: 'ready', port: srv.port, token: srv.token, ...(busy ? { busy } : {}) });
else {
  console.log(`sec-edit serving ${root}\n  → ${srv.url}`);
  if (busy) console.log(`  Port ${busy} (this folder's last one) was busy — browser state for this folder starts empty.`);
}
if (shouldOpen) {
  const [cmd, cmdArgs] =
    process.platform === 'win32' ? ['cmd.exe', ['/c', 'start', '""', srv.url.replace(/&/g, '^&')]] : process.platform === 'darwin' ? ['open', [srv.url]] : ['xdg-open', [srv.url]];
  execFile(cmd, cmdArgs as string[], { windowsHide: true }, () => {});
}
function stop() {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(0), 3000).unref(); // a close that hangs must not keep the port
  void srv!.close().then(() => process.exit(0));
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
if (ipc) process.on('message', (m: any) => m?.type === 'stop' && stop());
