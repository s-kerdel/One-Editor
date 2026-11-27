// The desktop "Start web server" child: a utilityProcess (main/web-server.ts) that runs dist/server/cli.mjs as
// `node cli.mjs <args> --ipc` would, with Electron's parent port standing in for Node's IPC channel. So the server
// needs no Node mode of the executable (the RunAsNode fuse is off) and cli.ts stays as it is.
//   argv (utilityProcess.fork): [<exe>, <this file>, <cli.mjs>, …server args]
// The handshake is unchanged: process.send / 'message' carry the same JSON messages. The child also ends with the
// app: Chromium ends a utility process whose parent is gone (a crash included).
import { pathToFileURL } from 'node:url';

interface ParentPort {
  postMessage(m: unknown): void;
  on(ev: 'message', fn: (e: { data: unknown }) => void): unknown;
}

const port = (process as unknown as { parentPort?: ParentPort }).parentPort;
const [cli, ...args] = process.argv.slice(2);
if (!port || !cli) {
  process.stderr.write('web-server-child: start it with utilityProcess.fork(<this>, [<cli.mjs>, …])\n');
  process.exit(2);
}
const p = process as unknown as { send?: unknown; connected?: boolean };
p.connected = true;
// cli.ts waits for a send's callback before it exits (a start error): give the message time to leave.
p.send = (m: unknown, cb?: (err: Error | null) => void) => {
  port!.postMessage(m);
  if (cb) setTimeout(() => cb(null), 100);
  return true;
};
port!.on('message', (e) => void process.emit('message' as never, e.data as never));
process.argv = [process.execPath, cli!, ...args];
import(pathToFileURL(cli!).href).catch((err) => {
  process.stderr.write(`Error: ${String((err as Error)?.message ?? err)}\n`);
  process.exit(1);
});
