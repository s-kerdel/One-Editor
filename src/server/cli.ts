// `node dist/server/cli.mjs [folder] [--port N] [--host H] [--open]` — browser mode.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { startServer, type RunningServer } from './server';

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
const root = path.resolve(args[0] ?? process.cwd());
const here = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = process.env.SEC_EDIT_RENDERER_DIR || path.resolve(here, '../renderer');

// Default port is "sticky but polite": try 4317.., or exactly --port if given.
let srv: RunningServer | null = null;
const first = Number(portArg ?? 4317);
for (let port = first; port < first + (portArg ? 1 : 20); port++) {
  try {
    srv = await startServer({ root, port, host, rendererDir });
    break;
  } catch (err: any) {
    if (err?.code !== 'EADDRINUSE') throw err;
  }
}
if (!srv) {
  console.error(`Port ${first} is in use. Pass --port <n>.`);
  process.exit(1);
}
console.log(`sec-edit serving ${root}\n  → ${srv.url}`);
if (shouldOpen) {
  const [cmd, cmdArgs] =
    process.platform === 'win32' ? ['cmd.exe', ['/c', 'start', '""', srv.url.replace(/&/g, '^&')]] : process.platform === 'darwin' ? ['open', [srv.url]] : ['xdg-open', [srv.url]];
  execFile(cmd, cmdArgs as string[], { windowsHide: true }, () => {});
}
const stop = () => void srv!.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
