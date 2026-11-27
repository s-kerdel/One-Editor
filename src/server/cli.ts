// `node dist/server/cli.mjs [folder ...] [--port N] [--host H] [--open]` — browser mode.
// `--ipc` (the desktop app's "Start web server", src/main/web-server.ts): the result goes to the parent
// over the Node IPC channel as data ({ type: 'ready', port, token, busy? } or { type: 'error', … }) instead of
// the printed URL, a 'stop' message or the parent going away ends the server.
// Without --port the folder's last port is tried first (browser state is per port), then 4317, 4318, …
// Every server is pinned (pinRoot): the page opens only the folders given here and folders inside them (the
// switcher lists the given ones), never a path it names itself. --ipc (the desktop's "Start web server") and
// any bind beyond loopback are also `shared`: no process list, no OS version.
// `--open` and the desktop's "Open" ({ type: 'launch', file: true }) hand the browser a 0600 redirect file
// (launch-file.ts): no command line ever holds the launch code.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { LAUNCH_TTL_MS, startServer, type RunningServer } from './server';
import { removeLaunchFile, writeLaunchFile } from './launch-file';
import { isBridgeRoot } from '../backend/readpool';
import { defaultConfigDir } from '../backend/service';
import { portCandidates, rememberPort, rememberedPort } from './ports';
import { winSystemExe } from '../backend/winsys';

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
  console.log('Usage: sec-edit serve [folder ...] [--port 4317] [--host 127.0.0.1] [--open]');
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
// The rest are folders (an unknown flag is ignored, as before). The first one opens; the page may switch
// between them and into folders inside them, nothing else.
const named = args.filter((a) => !a.startsWith('-'));
const folders = [...new Set((named.length ? named : [process.cwd()]).map((a) => path.resolve(a)))];
const root = folders[0];
// More libuv threads (default 4) only for a slow root (WSL, network), before the pool starts: there
// each readdir / open blocks one, and a tree walk must not starve file opens. Locally they only contend.
if (!process.env.UV_THREADPOOL_SIZE && folders.some(isBridgeRoot)) process.env.UV_THREADPOOL_SIZE = '16';
const here = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = process.env.SEC_EDIT_RENDERER_DIR || path.resolve(here, '../renderer');

// Default port is "sticky but polite": this folder's last port, then 4317.., or exactly --port if given.
let srv: RunningServer | null = null;
let stopping = false;
const configDir = defaultConfigDir(); // the same folder startServer's backend uses (SEC_EDIT_CONFIG_DIR wins)
const remembered = portArg ? null : await rememberedPort(configDir, root).catch(() => null);
const candidates = portCandidates(portArg ? Number(portArg) : null, remembered);
const first = candidates[0];
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const shared = ipc || !LOOPBACK.has(host);
for (const port of candidates) {
  try {
    srv = await startServer({ root, roots: folders, port, host, rendererDir, pinRoot: true, shared });
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
  console.log(`sec-edit serving ${folders.join(', ')}\n  → ${srv.url}`);
  if (busy) console.log(`  Port ${busy} (this folder's last one) was busy: browser state for this folder starts empty.`);
}
/** Redirect files not yet spent: removed when their code is redeemed, expires, or this process exits. */
const launchFiles = new Set<string>();
const dropLaunchFile = (file: string) => void (launchFiles.delete(file) && removeLaunchFile(file));
process.on('exit', () => launchFiles.forEach(removeLaunchFile));
/** A one-time launch code in a 0600 file of the app data: the browser gets the file's path only. */
async function launchFile(): Promise<string> {
  let file = '';
  const url = srv!.launchUrl(() => file && dropLaunchFile(file));
  file = await writeLaunchFile(configDir, url, LAUNCH_TTL_MS);
  launchFiles.add(file);
  setTimeout(() => dropLaunchFile(file), LAUNCH_TTL_MS).unref();
  return file;
}
if (shouldOpen) {
  launchFile().then(
    (file) => {
      // explorer.exe opens a file with its default program (the browser for .html) and needs no cmd.exe
      // quoting; `"` cannot occur in a Windows path.
      const [cmd, cmdArgs] = process.platform === 'win32' ? [winSystemExe('explorer.exe'), [`"${file}"`]] : process.platform === 'darwin' ? ['open', [file]] : ['xdg-open', [file]];
      execFile(cmd, cmdArgs as string[], { windowsHide: true, windowsVerbatimArguments: process.platform === 'win32' }, () => {});
    },
    (err) => console.error(`Could not open the browser (${err?.code || 'EIO'}): open the link above.`),
  );
}
function stop() {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(0), 3000).unref(); // a close that hangs must not keep the port
  void srv!.close().then(() => process.exit(0));
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
// { type: 'launch', file: true } → { type: 'launch', file } (or { type: 'launch', error }): the redirect file for
// the parent to open (no command line holds the code). { type: 'launch' } → { type: 'launch', url }: the
// one-time link itself (the older handshake).
const reply = (m: object) => void (process.connected && process.send!(m));
if (ipc)
  process.on('message', (m: any) => {
    if (m?.type === 'stop') stop();
    else if (m?.type === 'launch' && srv) {
      if (m.file === true) launchFile().then((file) => reply({ type: 'launch', file }), (err) => reply({ type: 'launch', error: String(err?.code || 'EIO') }));
      else reply({ type: 'launch', url: srv.launchUrl() });
    }
  });
