// A windowless launch (launch-mode.ts): the MCP server or the browser-mode server runs in this process, as it did
// under the executable's Node mode (now off: RunAsNode fuse). Decided before anything else in main.ts: no
// single-instance lock (never handed to a running One), no window, no Dock icon, no GPU process.
//  - stdout: untouched here; the MCP server's own stdout-guard (its first import) keeps it for the protocol.
//  - Chromium's profile files (Local State, caches) go to a folder of their own: several of these run beside One,
//    and One's Local State (the OS keyring key on Windows) must never be rewritten by one of them.
//  - Ends when the server does: stdin closed (MCP), Ctrl+C / SIGTERM, or the server's own exit.
import { app } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultConfigDir } from '../backend/appdata';
import type { HeadlessMode } from './launch-mode';

/** dist/<mcp|server>/cli.mjs of this build (packaged: real files in app.asar.unpacked). */
export function serverProgram(kind: HeadlessMode['kind'], o: { packaged: boolean; resourcesPath: string; mainDir: string }): string {
  const dir = kind === 'mcp-stdio' ? 'mcp' : 'server';
  return o.packaged ? path.join(o.resourcesPath, 'app.asar.unpacked', 'dist', dir, 'cli.mjs') : path.join(o.mainDir, '..', dir, 'cli.mjs');
}

export function runHeadless(m: HeadlessMode, cli: string): void {
  app.dock?.hide(); // macOS: no Dock icon for a server an MCP client started
  // No GPU process at all (nothing here is ever drawn): no acceleration, no software fallback, and Chromium's GPU
  // thread stays in this process (measured: one process and ~5 MB less than with a GPU process).
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  app.commandLine.appendSwitch('in-process-gpu');
  // The same data folder the servers read (mcp.json, settings): a sub-folder of it for Chromium's own files.
  app.setPath('userData', path.join(defaultConfigDir(), 'headless-profile'));
  // The server parses argv as `node cli.mjs …`.
  process.argv = [process.execPath, cli, ...(m.kind === 'mcp-stdio' ? ['--stdio'] : []), ...m.args];
  import(pathToFileURL(cli).href).catch((err) => {
    process.stderr.write(`One: the ${m.kind === 'mcp-stdio' ? 'MCP' : 'web'} server could not start: ${String((err as Error)?.message ?? err)}\n`);
    app.exit(1);
  });
}
