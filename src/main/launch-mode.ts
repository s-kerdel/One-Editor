// How this launch runs (pure, no electron import: unit-tested). The packaged executable has the RunAsNode fuse off,
// so it never runs a script someone names; the two servers it ships run in this process instead, without a window:
//   One --mcp-stdio [--folder <name>] [--read-only]       MCP clients (stdio), dist/mcp/cli.mjs
//   One --serve [folder …] [--port N] [--host H] [--open]  "Start web server.cmd" / start-web.sh, dist/server/cli.mjs
// A setup copied before (`One <…>/dist/mcp/cli.mjs --stdio`, ELECTRON_RUN_AS_NODE=1) still names our own server
// program: it gets the same windowless server, never a window with that file as a tab. Only these two fixed
// programs run: the path in argv only picks which one, its contents never matter.
type PlatformPath = typeof import('node:path').posix;

export type HeadlessKind = 'mcp-stdio' | 'serve';
export interface HeadlessMode {
  kind: HeadlessKind;
  /** The server's own arguments (Chromium switches of the launch command left out). */
  args: string[];
}

/** Chromium switches a launch command adds for the server (ignored here; Chromium reads them itself). */
const LAUNCH_SWITCH = /^--(ozone-platform(-hint)?=|disable-gpu$|no-sandbox$|enable-logging(=|$))/;

export interface HeadlessOptions {
  /** Unpackaged runs: argv is [electron, <appDir>, …]; null when packaged. */
  appPath: string | null;
  /** The two server programs of this build (old setups name them). */
  mcpCli: string;
  serverCli: string;
  cwd: string;
  p: PlatformPath;
  foldCase: boolean;
}

/** A windowless launch (`--mcp-stdio`, `--serve`, or an older setup naming our server program), or null: the app. */
export function headlessMode(argv: string[], o: HeadlessOptions): HeadlessMode | null {
  const end = argv.indexOf('--', 1); // after `--` only paths (the macOS `one` launcher): never a mode
  const head = end === -1 ? argv : argv.slice(0, end);
  const own = (args: string[]) => args.filter((a) => !LAUNCH_SWITCH.test(a));
  const flag = head.findIndex((a, i) => i > 0 && (a === '--mcp-stdio' || a === '--serve'));
  if (flag !== -1) return { kind: head[flag] === '--mcp-stdio' ? 'mcp-stdio' : 'serve', args: own(argv.slice(flag + 1)) };
  // An older setup: `<exe> [<appDir>] <…>/dist/mcp/cli.mjs --stdio …` (Node mode, gone with the fuse).
  const fold = (s: string) => (o.foldCase ? s.toLowerCase() : s);
  const same = (a: string, b: string) => fold(o.p.resolve(o.cwd, a)) === fold(o.p.resolve(b));
  let i = head.findIndex((a, n) => n > 0 && !!a && !a.startsWith('-'));
  if (i !== -1 && o.appPath && same(head[i], o.appPath)) i = head.findIndex((a, n) => n > i && !!a && !a.startsWith('-'));
  if (i === -1) return null;
  const rest = own(argv.slice(i + 1));
  if (same(head[i], o.mcpCli) && rest.includes('--stdio')) return { kind: 'mcp-stdio', args: rest.filter((a) => a !== '--stdio') };
  if (same(head[i], o.serverCli)) return { kind: 'serve', args: rest };
  return null;
}

/**
 * Packaged: no DevTools port or pipe (another program could drive One's windows, and through them its file access
 * and terminals). Only a package built for the tests allows it (scripts/package.mjs --test-package).
 */
export function remoteDebuggingRefused(o: { packaged: boolean; hasSwitch: (name: string) => boolean; testPackage: () => boolean }): boolean {
  if (!o.packaged) return false;
  if (!o.hasSwitch('remote-debugging-port') && !o.hasSwitch('remote-debugging-pipe')) return false;
  return !o.testPackage();
}
