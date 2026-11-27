// M10: the packaged executable never runs a script someone names (RunAsNode fuse off). Its two servers run
// windowless in One's own process (`--mcp-stdio`, `--serve`); a setup copied before still reaches them; the
// DevTools port is refused in packaged builds unless built for the tests. The web server child is a utilityProcess.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { headlessMode, remoteDebuggingRefused, type HeadlessOptions } from '../../../src/main/launch-mode';
import { childOfUtility, childEnv } from '../../../src/main/web-server';

const posix: HeadlessOptions = { appPath: null, mcpCli: '/opt/One/resources/app.asar.unpacked/dist/mcp/cli.mjs', serverCli: '/opt/One/resources/app.asar.unpacked/dist/server/cli.mjs', cwd: '/home/me', p: path.posix, foldCase: false };
const win: HeadlessOptions = { appPath: null, mcpCli: 'C:\\Apps\\One\\resources\\app.asar.unpacked\\dist\\mcp\\cli.mjs', serverCli: 'C:\\Apps\\One\\resources\\app.asar.unpacked\\dist\\server\\cli.mjs', cwd: 'C:\\Users\\me', p: path.win32 as never, foldCase: true };

describe('headlessMode', () => {
  it('--mcp-stdio / --serve: the server gets its own arguments, not the launch command’s Chromium switches', () => {
    expect(headlessMode(['/opt/One/one', '--ozone-platform=headless', '--mcp-stdio'], posix)).toEqual({ kind: 'mcp-stdio', args: [] });
    expect(headlessMode(['/opt/One/one', '--mcp-stdio', '--folder', 'notes', '--read-only', '--ozone-platform=headless'], posix)).toEqual({ kind: 'mcp-stdio', args: ['--folder', 'notes', '--read-only'] });
    expect(headlessMode(['C:\\Apps\\One\\One.exe', '--serve', 'C:\\notes', '--open'], win)).toEqual({ kind: 'serve', args: ['C:\\notes', '--open'] });
    // Unpackaged: electron <app dir> --mcp-stdio.
    expect(headlessMode(['/n/electron', '/src/one', '--mcp-stdio'], { ...posix, appPath: '/src/one' })).toEqual({ kind: 'mcp-stdio', args: [] });
  });

  it('the app itself: no flag, a file, a folder; after `--` a name that looks like the flag is a path', () => {
    for (const argv of [['/opt/One/one'], ['/opt/One/one', '/home/me/notes'], ['/opt/One/one', '--', '--mcp-stdio'], ['/opt/One/one', '--', '/opt/One/resources/app.asar.unpacked/dist/mcp/cli.mjs', '--stdio'], ['/opt/One/one', 'notes/--serve']]) expect(headlessMode(argv, posix), argv.join(' ')).toBeNull();
  });

  it('a setup copied before (Node mode, gone with the fuse) still names our server program: the same windowless server', () => {
    expect(headlessMode(['/opt/One/one', '/opt/One/resources/app.asar.unpacked/dist/mcp/cli.mjs', '--stdio', '--folder', 'x'], posix)).toEqual({ kind: 'mcp-stdio', args: ['--folder', 'x'] });
    expect(headlessMode(['C:\\Apps\\One\\One.exe', 'c:\\apps\\one\\RESOURCES\\app.asar.unpacked\\dist\\mcp\\cli.mjs', '--stdio'], win)).toEqual({ kind: 'mcp-stdio', args: [] });
    expect(headlessMode(['C:\\Apps\\One\\One.exe', 'C:\\Apps\\One\\resources\\app.asar.unpacked\\dist\\server\\cli.mjs', 'C:\\notes', '--open'], win)).toEqual({ kind: 'serve', args: ['C:\\notes', '--open'] });
    // Without --stdio the MCP program is just a file the user opens; any other script is never run.
    expect(headlessMode(['/opt/One/one', '/opt/One/resources/app.asar.unpacked/dist/mcp/cli.mjs'], posix)).toBeNull();
    expect(headlessMode(['/opt/One/one', '/home/me/evil.mjs', '--stdio'], posix)).toBeNull();
    expect(headlessMode(['/n/electron', '/src/one', '/src/one/dist/mcp/cli.mjs', '--stdio'], { ...posix, appPath: '/src/one', mcpCli: '/src/one/dist/mcp/cli.mjs' })).toEqual({ kind: 'mcp-stdio', args: [] });
  });
});

describe('remoteDebuggingRefused', () => {
  const has = (...names: string[]) => (n: string) => names.includes(n);
  it('packaged: refused unless this is a test package; unpackaged: allowed', () => {
    expect(remoteDebuggingRefused({ packaged: true, hasSwitch: has('remote-debugging-port'), testPackage: () => false })).toBe(true);
    expect(remoteDebuggingRefused({ packaged: true, hasSwitch: has('remote-debugging-pipe'), testPackage: () => false })).toBe(true);
    expect(remoteDebuggingRefused({ packaged: true, hasSwitch: has('remote-debugging-port'), testPackage: () => true })).toBe(false);
    expect(remoteDebuggingRefused({ packaged: true, hasSwitch: has(), testPackage: () => false })).toBe(false);
    expect(remoteDebuggingRefused({ packaged: false, hasSwitch: has('remote-debugging-port'), testPackage: () => false })).toBe(false);
  });
});

describe('the web server child as a utilityProcess', () => {
  class FakeUtility extends EventEmitter {
    pid = 77;
    posted: unknown[] = [];
    killed = 0;
    stderr = new EventEmitter();
    postMessage(m: unknown) {
      this.posted.push(m);
    }
    kill() {
      this.killed++;
      return true;
    }
  }
  it('looks like Node’s child: send while alive, exit codes, a POSIX signal by its name', () => {
    const u = new FakeUtility();
    const c = childOfUtility(u as never, false);
    const exits: unknown[] = [];
    c.on('exit', (code, signal) => exits.push([code, signal]));
    expect(c.connected).toBe(true);
    expect(c.send!({ type: 'stop' })).toBe(true);
    expect(u.posted).toEqual([{ type: 'stop' }]);
    c.kill();
    expect(u.killed).toBe(1);
    u.emit('exit', 9);
    expect(exits).toEqual([[null, 'SIGKILL']]);
    expect(c.connected).toBe(false);
    expect(c.send!({ type: 'launch' })).toBe(false);
    const w = new FakeUtility();
    const cw = childOfUtility(w as never, true);
    cw.on('exit', (code, signal) => exits.push([code, signal]));
    w.emit('exit', 9);
    expect(exits.at(-1)).toEqual([9, null]); // Windows: a code is a code
  });

  it('no Node mode in the child’s environment any more', () => {
    expect(childEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' }, '/cfg')).toEqual({ PATH: '/bin', SEC_EDIT_CONFIG_DIR: '/cfg' });
  });
});
