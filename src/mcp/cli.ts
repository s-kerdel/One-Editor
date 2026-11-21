// One's MCP server.  `<One executable in Node mode> dist/mcp/cli.mjs --stdio [--folder <name>] [--read-only]`
// Started by an MCP client (LM Studio, Codex CLI, Claude…) with ELECTRON_RUN_AS_NODE=1; no window, no network.
//  - Refuses to run unless Settings → MCP server is on (mcp.json in the app data folder, main's file).
//  - Serves only the folders listed there, read-only unless a folder says read-write; --folder and
//    --read-only narrow that further, never widen it.
//  - Watches mcp.json: switched off → exits; a folder removed or its mode changed → applied at once.
//  - stdout is the protocol channel: stdout-guard (the first import) sends everything else to stderr.
import { writeProtocol } from './stdout-guard';
import './env-boot'; // second: test hooks are dead in a packaged build
import path from 'node:path';
import { defaultConfigDir } from '../backend/appdata';
import { MCP_CONFIG_FILE } from '../shared/mcp';
import { loadSettings, readConfig, watchFiles } from './config';
import { OneMcpServer, SERVER_VERSION } from './server';
import { StdioTransport } from './stdio';

const USAGE = 'Usage: cli.mjs --stdio [--folder <name>] [--read-only]\n  Run by an MCP client. Switch it on first: One → Settings → MCP server.';
const args = process.argv.slice(2);
const take = (name: string) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i !== -1) args.splice(i, 1);
  return i !== -1;
};

if (flag('--help') || flag('-h')) {
  console.error(USAGE);
  process.exit(0);
}
if (flag('--version')) {
  console.error(SERVER_VERSION);
  process.exit(0);
}
const stdio = flag('--stdio');
const readOnly = flag('--read-only');
const only = take('--folder');
if (!stdio || args.length) {
  console.error(args.length ? `Unknown argument: ${args[0]}\n${USAGE}` : USAGE);
  process.exit(2);
}

const configDir = defaultConfigDir();
const configFile = path.join(configDir, MCP_CONFIG_FILE);
const settingsFile = path.join(configDir, 'settings.json');
const config = readConfig(configFile);
if (!config.enabled) {
  console.error('One MCP server: switched off. Turn it on in One → Settings → MCP server.');
  process.exit(1);
}
if (only !== undefined && !config.folders.some((f) => f.alias === only)) {
  console.error(`One MCP server: no shared folder named "${only}". Shared: ${config.folders.map((f) => f.alias).join(', ') || 'none'}.`);
  process.exit(1);
}

const initial = loadSettings(settingsFile);
if (!initial.ok) {
  // Never start without the user's exclusions: a broken file must not mean "everything visible".
  console.error(`One MCP server: settings.json cannot be used (${initial.reason}). Fix it (or open One once), then try again.`);
  process.exit(1);
}
const server = new OneMcpServer({
  configDir,
  settings: initial.settings,
  narrow: { folder: only, readOnly },
  transport: 'stdio',
  idleMs: Number(process.env.SEC_EDIT_MCP_IDLE_MS) || undefined,
  indexWaitMs: Number(process.env.SEC_EDIT_MCP_INDEX_WAIT_MS) || undefined,
});
server.applyConfig(config);

let stopping = false;
let unwatch: () => void = () => {};
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  unwatch();
  setTimeout(() => process.exit(code), 2000).unref();
  await server.dispose().catch(() => {});
  process.exit(code);
}

const transport = new StdioTransport(server.protocol, { input: process.stdin, write: (line) => void writeProtocol(line), onClose: () => void stop(0) });
process.stdout.on('error', () => void stop(0)); // the client went away (EPIPE)

unwatch = watchFiles([configFile, settingsFile], Number(process.env.SEC_EDIT_MCP_POLL_MS) || 1000, (file) => {
  if (file === settingsFile) {
    const next = loadSettings(settingsFile);
    // Half-written or broken: the last good settings stay (exclusions are never dropped).
    if (next.ok) server.applySettings(next.settings);
    else console.error(`One MCP server: settings.json cannot be used (${next.reason}); keeping the last good settings.`);
    return;
  }
  const next = readConfig(configFile);
  if (!next.enabled) {
    console.error('One MCP server: switched off in One. Stopping.');
    return void stop(0);
  }
  if (only !== undefined && !next.folders.some((f) => f.alias === only)) {
    console.error(`One MCP server: the folder "${only}" is no longer shared. Stopping.`);
    return void stop(0);
  }
  if (server.applyConfig(next)) transport.notify('notifications/tools/list_changed');
});

process.on('SIGINT', () => void stop(0));
process.on('SIGTERM', () => void stop(0));
console.error(`One MCP server ${SERVER_VERSION} (stdio): ${server.pool.list().length} folder(s) shared.`);
