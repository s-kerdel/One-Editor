// Shell detection + spawn planning for the integrated terminal. Pure: every OS access goes through
// `DetectEnv`, so the Windows rules (PowerShell 7, Git Bash, WSL distros, UNC folders) are unit-tested
// on Linux with path.win32 and fixtures.
import path from 'node:path';
import { BackendFailure } from '../backend/errors';
import { prettyDistro, prettyExe, uniqueNames, wslUncInfo, type ClaudeInfo, type OpencodeInfo, type ShellInfo, type ShellKind } from '../shared/terminal';
export { wslUncInfo };

type PlatformPath = typeof path.posix;

export interface DetectEnv {
  platform: NodeJS.Platform | string;
  env: Record<string, string | undefined>;
  exists(p: string): Promise<boolean>;
  readdir(p: string): Promise<string[]>;
  /** Run a program, capture stdout as bytes (only used for `wsl.exe -l -q`). */
  run(file: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: Uint8Array }>;
}

export const pathFor = (platform: string): PlatformPath => (platform === 'win32' ? path.win32 : path.posix);

/** Case-insensitive env lookup on Windows (process.env copies keep 'Path', 'ProgramFiles(x86)', …). */
export function envGet(env: Record<string, string | undefined>, key: string, win: boolean): string | undefined {
  if (!win) return env[key];
  if (env[key] !== undefined) return env[key];
  const k = Object.keys(env).find((x) => x.toLowerCase() === key.toLowerCase());
  return k === undefined ? undefined : env[k];
}

/** PATH lookup (honours PATHEXT on Windows). All candidates are probed at once, the first in PATH order
 *  wins: one-by-one awaits cost ~1 ms each — 40 PATH entries × 3 shells was 120 ms on the open path. */
export async function which(name: string, d: DetectEnv): Promise<string | null> {
  const win = d.platform === 'win32';
  const P = pathFor(String(d.platform));
  const dirs = (envGet(d.env, 'PATH', win) ?? '').split(P.delimiter).filter((x) => x && P.isAbsolute(x));
  const exts = win && !P.extname(name) ? (envGet(d.env, 'PATHEXT', win) ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase()) : [''];
  return firstExisting(dirs.flatMap((dir) => exts.map((ext) => P.join(dir.replace(/^"(.*)"$/, '$1'), name + ext))), d);
}

// ---------------------------------------------------------------- WSL

/**
 * `wsl.exe -l -q` prints UTF-16LE (no BOM) by default and UTF-8 with WSL_UTF8=1. Decode either,
 * drop NULs/BOMs/blank lines.
 */
export function decodeWslOutput(buf: Uint8Array): string {
  let utf16 = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe;
  if (!utf16 && buf.length >= 2) {
    let zeros = 0;
    const n = Math.min(buf.length, 512);
    for (let i = 1; i < n; i += 2) if (buf[i] === 0) zeros++;
    utf16 = zeros / Math.ceil(n / 2) > 0.4;
  }
  const text = new TextDecoder(utf16 ? 'utf-16le' : 'utf-8').decode(buf);
  return text.replace(/^\uFEFF/, '').replace(/\u0000/g, '');
}

/** Distro names WSL itself allows (no spaces); docker's internal distros are not shells. */
const DISTRO_RE = /^[A-Za-z0-9][\w.-]{0,63}$/;
const HIDDEN_DISTROS = /^(docker-desktop(-data)?|rancher-desktop(-data)?)$/i;

export function parseWslList(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const name = raw.trim().replace(/\s*\(default\)$/i, '');
    if (!DISTRO_RE.test(name) || HIDDEN_DISTROS.test(name) || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

export const isUncPath = (abs: string) => /^[\\/]{2}[^\\/]/.test(abs);

// ---------------------------------------------------------------- detection

const mk = (id: string, name: string, kind: ShellKind, p: string, args: string[], detail?: string): ShellInfo => ({ id, name, kind, path: p, args, detail: detail ?? p });

/** "C:\Program Files\PowerShell\7\pwsh.exe" → "PowerShell 7"; "…\7-preview\…" → "PowerShell 7 Preview".
 *  Store / PATH installs don't show a version: pwsh is 7.x today. */
export function pwshName(exe: string): string {
  const m = /[\\/]PowerShell[\\/](\d+)(-preview)?[\\/]pwsh\.exe$/i.exec(exe);
  return m ? `PowerShell ${m[1]}${m[2] ? ' Preview' : ''}` : 'PowerShell 7';
}

/** First candidate (in order) that exists — probed in parallel. */
async function firstExisting(cands: Array<string | null | undefined>, d: DetectEnv): Promise<string | null> {
  const list = [...new Set(cands.filter((c): c is string => !!c))];
  const hits = await Promise.all(list.map((c) => d.exists(c).catch(() => false)));
  const i = hits.indexOf(true);
  return i < 0 ? null : list[i];
}

/** `C:\Program Files\PowerShell\<n>\pwsh.exe`: highest stable version first, previews last. */
async function programFilesPwsh(d: DetectEnv, P: PlatformPath, win: boolean): Promise<string[]> {
  const out: string[] = [];
  for (const base of [envGet(d.env, 'ProgramFiles', win), envGet(d.env, 'ProgramW6432', win)]) {
    if (!base) continue;
    const dir = P.join(base, 'PowerShell');
    const names = await d.readdir(dir).catch(() => [] as string[]);
    const rank = (n: string) => (/preview/i.test(n) ? -1000 : 0) + (parseFloat(n) || 0);
    for (const n of names.sort((a, b) => rank(b) - rank(a))) out.push(P.join(dir, n, 'pwsh.exe'));
  }
  return out;
}

async function detectWindows(d: DetectEnv): Promise<ShellInfo[]> {
  const P = path.win32;
  const e = (k: string) => envGet(d.env, k, true);
  const sysRoot = e('SystemRoot') ?? e('windir') ?? 'C:\\Windows';
  const sys32 = P.join(sysRoot, 'System32');
  const shells: ShellInfo[] = [];
  const pf = [e('ProgramFiles'), e('ProgramW6432'), e('ProgramFiles(x86)')].filter(Boolean) as string[];
  // Independent probes run concurrently; `wsl -l -q` (a process start) overlaps with the file checks.
  const wslListed = firstExisting([P.join(sys32, 'wsl.exe')], d).then(async (exe) => {
    const wsl = exe ?? (await which('wsl.exe', d));
    if (!wsl) return null;
    const r = await d.run(wsl, ['-l', '-q'], 4000).catch(() => null);
    return { wsl, distros: r && r.code === 0 ? parseWslList(decodeWslOutput(r.stdout)) : [] };
  });
  const [pwsh, winps, cmd, gitBash, wsl] = await Promise.all([
    (async () => firstExisting([await which('pwsh.exe', d), ...(await programFilesPwsh(d, P, true)), e('LOCALAPPDATA') && P.join(e('LOCALAPPDATA')!, 'Microsoft', 'WindowsApps', 'pwsh.exe')], d))(),
    (async () => (await firstExisting([P.join(sys32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')], d)) ?? which('powershell.exe', d))(),
    firstExisting([e('ComSpec'), P.join(sys32, 'cmd.exe')], d),
    (async () => {
      // Git Bash: bin\bash.exe is Git's launcher (sets MSYSTEM/PATH); System32\bash.exe is WSL, not Git.
      const git = await which('git.exe', d);
      const gitRoot = git ? P.dirname(P.dirname(git)) : null; // <root>\cmd\git.exe → <root>
      return firstExisting(
        [
          gitRoot && P.join(gitRoot, 'bin', 'bash.exe'),
          ...pf.map((b) => P.join(b, 'Git', 'bin', 'bash.exe')),
          e('LOCALAPPDATA') && P.join(e('LOCALAPPDATA')!, 'Programs', 'Git', 'bin', 'bash.exe'),
          e('USERPROFILE') && P.join(e('USERPROFILE')!, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'),
        ].filter((p) => !p || !p.toLowerCase().startsWith(sys32.toLowerCase())),
        d,
      );
    })(),
    wslListed,
  ]);
  if (pwsh) shells.push(mk('pwsh', pwshName(pwsh), 'pwsh', pwsh, ['-NoLogo']));
  if (winps) shells.push(mk('powershell', 'Windows PowerShell', 'powershell', winps, ['-NoLogo'], 'PowerShell 5.1 · built into Windows'));
  if (cmd) shells.push(mk('cmd', 'Command Prompt', 'cmd', cmd, [], 'cmd.exe'));
  if (gitBash) shells.push(mk('gitbash', 'Git Bash', 'gitbash', gitBash, ['--login', '-i']));
  for (const distro of wsl?.distros ?? []) shells.push(mk(`wsl:${distro}`, prettyDistro(distro), 'wsl', wsl!.wsl, ['-d', distro], `WSL · ${distro}`));
  return uniqueNames(shells);
}

const UNIX_KINDS: Record<string, ShellKind> = { bash: 'bash', zsh: 'zsh', fish: 'fish', sh: 'sh' };

async function detectUnix(d: DetectEnv): Promise<ShellInfo[]> {
  const P = path.posix;
  const mac = d.platform === 'darwin';
  const shells: ShellInfo[] = [];
  const add = (p: string) => {
    const base = P.basename(p);
    const id = base.replace(/[^\w.-]/g, '').slice(0, 32) || 'shell';
    if (shells.some((s) => s.id === id)) return;
    const kind = UNIX_KINDS[base] ?? 'other';
    // macOS terminals start login shells (Terminal.app does); Linux ones read ~/.bashrc as interactive shells.
    shells.push(mk(id, prettyExe(base), kind, p, mac && kind !== 'other' ? ['-l'] : []));
  };
  const login = d.env.SHELL;
  const [loginOk, ...found] = await Promise.all([login && P.isAbsolute(login) ? d.exists(login) : false, ...['bash', 'zsh', 'fish'].map((n) => which(n, d))]);
  if (loginOk) add(login!);
  for (const p of found) if (p) add(p);
  if (!shells.length) {
    const sh = await firstExisting(['/bin/sh', await which('sh', d)], d);
    if (sh) add(sh);
  }
  return uniqueNames(shells);
}

export async function detectShells(d: DetectEnv): Promise<ShellInfo[]> {
  return d.platform === 'win32' ? detectWindows(d) : detectUnix(d);
}

/**
 * Automatic default: a folder inside a WSL distro (\\wsl.localhost\Ubuntu\…) opens that distro;
 * else PowerShell 7 → Windows PowerShell → cmd on Windows, the login shell ($SHELL, listed first) elsewhere.
 */
export function pickDefaultShell(shells: ShellInfo[], o: { platform: string; root?: string | null }): string | null {
  if (!shells.length) return null;
  if (o.platform === 'win32') {
    const unc = o.root ? wslUncInfo(o.root) : null;
    const wsl = unc && shells.find((s) => s.kind === 'wsl' && s.id.toLowerCase() === `wsl:${unc.distro}`.toLowerCase());
    if (wsl) return wsl.id;
    for (const id of ['pwsh', 'powershell', 'cmd']) if (shells.some((s) => s.id === id)) return id;
  }
  return shells[0].id;
}

// ---------------------------------------------------------------- spawn plan

export interface SpawnPlan {
  file: string;
  /** Arguments; on Windows a string is the raw command-line tail (node-pty passes it through unquoted). */
  args: string[] | string;
  /** Native folder handed to CreateProcess / chdir. */
  cwd: string;
  /** Extra environment for this shell. */
  env: Record<string, string>;
}

/**
 * How to start `shell` in the (validated, absolute) folder `cwd`:
 *  - WSL starts in the folder via `--cd` (a folder inside the same distro is passed as its Linux path);
 *  - cmd.exe cannot have a UNC current directory → start in the profile folder and `pushd` there
 *    (pushd maps a temporary drive letter);
 *  - Git Bash's /etc/profile would `cd ~` unless CHERE_INVOKING is set.
 */
/**
 * A path inside a cmd.exe command string: always quoted. node-pty quotes an argument only for spaces, so
 * `\\nas\share\a&calc` would reach cmd bare and `&` (also `|`, `<`, `>`, `^`, `(`, `)`) would start a
 * second command. Inside quotes cmd takes all of them literally; `"` cannot occur in a Windows path, and
 * `%` (variable expansion, also inside quotes — it cannot be escaped on a command line) is refused.
 */
export function cmdQuote(p: string): string {
  if (/["%\r\n\0]/.test(p)) throw new BackendFailure('EINVAL', 'cmd.exe cannot be started here: the folder name contains % or a quote');
  return `"${p}"`;
}

/** `/S /C "<command>"` tail: with /S cmd strips exactly the outer quotes, whatever the command contains. */
const cmdTail = (sw: '/K' | '/C', command: string) => `/S ${sw} "${command}"`;

/**
 * Environment for an npm shim (claude.cmd, opencode.cmd) run by cmd.exe in the open folder: the shim starts a bare
 * `node`, and cmd.exe looks for that in its current folder (the untrusted one) before PATH — a planted node.exe /
 * node.cmd there would run. With this variable set cmd.exe skips the current folder.
 */
export const SHIM_ENV = { NoDefaultCurrentDirectoryInExePath: '1' } as const;

/**
 * The folder reaches the scripts inside WSL as the environment variable ONE_CWD (passed through WSLENV unchanged),
 * never as script text or a positional argument: a folder name with a quote or `$(…)` stays one value however
 * wsl.exe hands its arguments over. `$0` is a fixed placeholder.
 */
const WSL_CWD = 'ONE_CWD';
function wslCwdEnv(linux: string | null, env: Record<string, string | undefined>, more: string[] = []): Record<string, string> {
  const names = [...(linux ? [WSL_CWD] : []), ...more];
  const out: Record<string, string> = linux ? { [WSL_CWD]: linux } : {};
  if (names.length) out.WSLENV = [envGet(env, 'WSLENV', true), ...names].filter(Boolean).join(':');
  return out;
}

export function planSpawn(shell: ShellInfo, cwd: string, o: { platform: string; env: Record<string, string | undefined> }): SpawnPlan {
  const args = [...shell.args];
  const plan: SpawnPlan = { file: shell.path, args, cwd, env: {} };
  if (o.platform !== 'win32') return plan;
  if (shell.kind === 'wsl') {
    const unc = wslUncInfo(cwd);
    const distro = shell.id.slice(4);
    args.push('--cd', unc && unc.distro.toLowerCase() === distro.toLowerCase() ? unc.linuxPath : cwd);
  } else if (shell.kind === 'cmd' && isUncPath(cwd)) {
    plan.cwd = envGet(o.env, 'USERPROFILE', true) || envGet(o.env, 'SystemRoot', true) || 'C:\\';
    plan.args = [...shell.args, cmdTail('/K', `pushd ${cmdQuote(cwd)}`)].join(' ');
  } else if (shell.kind === 'gitbash') {
    plan.env.CHERE_INVOKING = '1';
  }
  return plan;
}

/** Windows build number from os.release() ("10.0.22631" → 22631). */
export function windowsBuildOf(release: string): number | undefined {
  const m = /^\d+\.\d+\.(\d+)/.exec(release);
  return m ? Number(m[1]) : undefined;
}

// ---------------------------------------------------------------- Claude Code

/** The official native installer command for this platform (inside WSL: the Linux one). */
export const claudeInstall = (platform: string, wsl = false) => (platform === 'win32' && !wsl ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash');

/** One-line install hint. */
export function claudeHint(platform: string, wsl = false): string {
  return `Claude Code is not installed. In ${platform === 'win32' && !wsl ? 'PowerShell' : 'a terminal'}: ${claudeInstall(platform, wsl)}. Then refresh.`;
}

/**
 * Finds the `claude` CLI. When the default shell is a WSL distro it is looked up INSIDE that distro
 * (interactive login shell, so nvm / ~/.local/bin from the user's rc files count), else natively:
 * PATH (claude.exe / claude.cmd via PATHEXT on Windows) plus the installers' usual folders.
 */
export async function detectClaude(d: DetectEnv, o: { wsl?: { exe: string; distro: string } | null } = {}): Promise<ClaudeInfo> {
  const win = d.platform === 'win32';
  if (o.wsl) {
    const r = await d.run(o.wsl.exe, ['-d', o.wsl.distro, '-e', 'bash', '-lic', 'command -v claude'], 8000).catch(() => null);
    const out = r && r.code === 0 ? new TextDecoder().decode(r.stdout) : '';
    const hit = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .reverse()
      .find((l) => /^\/\S*\/claude$/.test(l));
    if (hit) return { available: true, via: 'wsl', distro: o.wsl.distro, path: hit };
  }
  const P = pathFor(String(d.platform));
  const e = (k: string) => envGet(d.env, k, win);
  const home = win ? e('USERPROFILE') : e('HOME');
  const cands = win
    ? [await which('claude', d), home && P.join(home, '.local', 'bin', 'claude.exe'), e('APPDATA') && P.join(e('APPDATA')!, 'npm', 'claude.cmd')]
    : [await which('claude', d), ...(home ? [P.join(home, '.local/bin/claude'), P.join(home, '.claude/local/claude'), P.join(home, '.npm-global/bin/claude')] : []), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  const found = await firstExisting(cands, d);
  if (found) return { available: true, via: 'native', path: found };
  return { available: false, hint: claudeHint(String(d.platform), !!o.wsl), install: claudeInstall(String(d.platform), !!o.wsl) };
}

/** Windows folder → its path inside WSL (same distro: the Linux path; a drive: /mnt/<d>/…; else null). */
export function wslPathFor(cwd: string, distro: string): string | null {
  const unc = wslUncInfo(cwd);
  if (unc) return unc.distro.toLowerCase() === distro.toLowerCase() ? unc.linuxPath : null;
  const m = /^([a-z]):[\\/]?(.*)$/i.exec(cwd);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].split(/[\\/]+/).filter(Boolean).join('/')}`.replace(/\/$/, '') || '/' : null;
}

/** "Follow Claude's edits": the session folder One made + the settings file in it (main/terminal-follow.ts). */
export interface ClaudeFollowPlan {
  dir: string;
  settings: string;
}

/**
 * How to start Claude Code in `cwd`:
 *  - inside WSL: an interactive login bash (the user's PATH), cd'ing back to the folder AFTER the rc
 *    files ran (some ~/.bashrc end with `cd ~`), then exec claude;
 *  - Windows npm shim (claude.cmd): through cmd.exe, pushd-ing to UNC folders cmd cannot start in;
 *  - otherwise the binary itself, with its folder first on PATH (an npm install's node sits next to it).
 */
export function planClaude(info: ClaudeInfo, cwd: string, o: { platform: string; env: Record<string, string | undefined>; wslExe?: string; follow?: ClaudeFollowPlan }): SpawnPlan {
  const win = o.platform === 'win32';
  const follow = o.follow;
  if (info.via === 'wsl' && info.distro && o.wslExe) {
    const inside = wslPathFor(cwd, info.distro);
    // Follow: the session folder reaches the distro as an env var only (WSLENV's /p turns the Windows path
    // into /mnt/…); the script stays a fixed string and adds --settings only when the variable arrived.
    // The folder, too, is an env var (ONE_CWD, wslCwdEnv), never an argument the script reads.
    const cd = 'cd -- "${ONE_CWD:-.}" 2>/dev/null; exec claude';
    const script = follow ? `${cd} \${ONE_FOLLOW_DIR:+--settings "$ONE_FOLLOW_DIR/settings.json"}` : cd;
    const args = ['-d', info.distro, '--cd', inside ?? cwd, '-e', 'bash', '-lic', script, 'claude'];
    const env: Record<string, string> = follow ? { ONE_FOLLOW_DIR: follow.dir, ...wslCwdEnv(inside, o.env, ['ONE_FOLLOW_DIR/p']) } : wslCwdEnv(inside, o.env);
    return { file: o.wslExe, args, cwd, env };
  }
  const exe = info.path!;
  const P = pathFor(o.platform);
  const pathKey = win ? (Object.keys(o.env).find((k) => k.toLowerCase() === 'path') ?? 'Path') : 'PATH';
  const env: Record<string, string> = { [pathKey]: [P.dirname(exe), envGet(o.env, 'PATH', win)].filter(Boolean).join(P.delimiter) };
  // Git Bash (which runs the hook on Windows) takes C:/… paths; backslashes would need care in sh.
  if (follow) env.ONE_FOLLOW_DIR = win ? follow.dir.replace(/\\/g, '/') : follow.dir;
  if (win && /\.(cmd|bat)$/i.test(exe)) {
    Object.assign(env, SHIM_ENV);
    const comspec = envGet(o.env, 'ComSpec', true) || P.join(envGet(o.env, 'SystemRoot', true) || 'C:\\Windows', 'System32', 'cmd.exe');
    const run = cmdQuote(exe) + (follow ? ` --settings ${cmdQuote(follow.settings)}` : '');
    if (isUncPath(cwd)) return { file: comspec, args: `/D ${cmdTail('/C', `pushd ${cmdQuote(cwd)} && ${run}`)}`, cwd: envGet(o.env, 'USERPROFILE', true) || 'C:\\', env };
    return { file: comspec, args: `/D ${cmdTail('/C', run)}`, cwd, env };
  }
  return { file: exe, args: follow ? ['--settings', follow.settings] : [], cwd, env };
}


// ---------------------------------------------------------------- opencode

/** The install command for this platform (inside WSL: the Linux one). */
export const opencodeInstall = (platform: string, wsl = false) => (platform === 'win32' && !wsl ? 'npm i -g opencode-ai' : 'curl -fsSL https://opencode.ai/install | bash');
/** One-line install hint; `distro` = the WSL distro it was looked up in (the command must be run there, not in PowerShell). */
export function opencodeHint(platform: string, distro?: string): string {
  const where = platform !== 'win32' ? 'a terminal' : distro ? `a terminal (WSL · ${distro})` : 'PowerShell';
  return `Opencode is not installed. In ${where}: ${opencodeInstall(platform, !!distro)}. Then refresh.`;
}

/**
 * Which part of the WSL follow start failed: no Linux name for the folder (`folder`), no child started (`spawn`),
 * it never reported itself there (`answer`), or it answers there but main cannot reach it from Windows (`reach`).
 * A wrong one sends the user to fix something that is not broken.
 */
export type WslFollowFail = 'folder' | 'spawn' | 'answer' | 'reach';

/** Started there, never said "listening" there. */
export const OPENCODE_WSL_NO_FOLLOW =
  'Opencode runs inside WSL here, but its private server there did not report itself: its edits are not followed and not listed under AI changes. The first start of a distro takes a while. Try again.';
/** Answers there; WSL does not forward that port to Windows. */
export const OPENCODE_WSL_NO_REACH =
  'Opencode runs inside WSL here and its private server answers there, but One cannot reach it from Windows: WSL does not forward its localhost here. Its edits are not followed and not listed under AI changes.';
/** The open folder has no path in that distro. */
export const OPENCODE_WSL_NO_FOLDER =
  'Opencode runs inside WSL here, but this folder has no path inside that distro, so One cannot run its private server there: its edits are not followed and not listed under AI changes. Open the folder as \\wsl.localhost\\<distro>\\… instead.';

/** The toast for one failed WSL follow start. */
export function wslFollowNotice(why: WslFollowFail | undefined): string {
  if (why === 'reach') return OPENCODE_WSL_NO_REACH;
  if (why === 'folder') return OPENCODE_WSL_NO_FOLDER;
  return OPENCODE_WSL_NO_FOLLOW;
}

/** Fixed script (nothing is built into it): PATH of the user's login shell, then the installers' usual folders. */
export const OPENCODE_WSL_LOOKUP = 'command -v opencode || for p in "$HOME/.opencode/bin/opencode" "$HOME/.local/bin/opencode" "$HOME/.npm-global/bin/opencode"; do [ -x "$p" ] && { echo "$p"; break; }; done';

/**
 * Finds the `opencode` CLI. When the default shell is a WSL distro it is looked up INSIDE that distro first
 * (interactive login shell like detectClaude, plus the installers' folders: ~/.opencode/bin is often not on
 * PATH), else — and as the fallback — natively: PATH plus the installers' usual folders.
 */
export async function detectOpencode(d: DetectEnv, o: { wsl?: { exe: string; distro: string } | null } = {}): Promise<OpencodeInfo> {
  const win = d.platform === 'win32';
  if (o.wsl) {
    const r = await d.run(o.wsl.exe, ['-d', o.wsl.distro, '-e', 'bash', '-lic', OPENCODE_WSL_LOOKUP], 8000).catch(() => null);
    const out = r && r.code === 0 ? new TextDecoder().decode(r.stdout) : '';
    // rc files may print anything: only a plain absolute path counts (it is later handed to bash as an argument).
    const hit = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .reverse()
      .find((l) => /^\/[\w@%+./-]*\/opencode$/.test(l));
    if (hit) return { available: true, via: 'wsl', distro: o.wsl.distro, path: hit };
  }
  const P = pathFor(String(d.platform));
  const e = (k: string) => envGet(d.env, k, win);
  const home = win ? e('USERPROFILE') : e('HOME');
  const cands = win
    ? [await which('opencode', d), e('APPDATA') && P.join(e('APPDATA')!, 'npm', 'opencode.cmd'), home && P.join(home, '.opencode', 'bin', 'opencode.exe')]
    : [await which('opencode', d), ...(home ? [P.join(home, '.opencode/bin/opencode'), P.join(home, '.local/bin/opencode'), P.join(home, '.npm-global/bin/opencode')] : []), '/opt/homebrew/bin/opencode', '/usr/local/bin/opencode'];
  const found = await firstExisting(cands, d);
  if (found) return { available: true, via: 'native', path: found };
  return { available: false, hint: opencodeHint(String(d.platform), o.wsl?.distro), install: opencodeInstall(String(d.platform), !!o.wsl) };
}

/**
 * How main starts its private server for an Opencode terminal: `opencode serve` on loopback, a port of the OS's
 * choice. An npm shim (opencode.cmd) cannot be started directly on Windows (Node refuses .cmd / .bat without a
 * shell): it goes through cmd.exe like the TUI below, as one verbatim command line.
 */
export function planOpencodeServe(bin: string, o: { platform: string; env: Record<string, string | undefined> }): { file: string; args: string[]; verbatim: boolean; env: Record<string, string> } {
  const args = ['serve', '--hostname', '127.0.0.1', '--port', '0'];
  if (o.platform !== 'win32' || !/\.(cmd|bat)$/i.test(bin)) return { file: bin, args, verbatim: false, env: {} };
  const comspec = envGet(o.env, 'ComSpec', true) || path.win32.join(envGet(o.env, 'SystemRoot', true) || 'C:\\Windows', 'System32', 'cmd.exe');
  return { file: comspec, args: ['/D', cmdTail('/C', `${cmdQuote(bin)} ${args.join(' ')}`)], verbatim: true, env: { ...SHIM_ENV } };
}

/** The line the WSL serve script prints first: the folder without links, as opencode will name it. */
export const OPENCODE_WSL_CWD = /^one-cwd (\/[^\r\n]{0,4095})\r?$/m;

/**
 * Fixed script (nothing is built into it; $ONE_CWD = the folder, "$1" = the path the lookup found) that runs One's
 * private server INSIDE a WSL distro:
 *  - no server in another folder (`cd` must work) and no password of the user's in its environment;
 *  - the server gets a session of its own (`setsid`, job control off so `$!` is the server), so its whole
 *    process group — the agent's shell commands too — is ended at once;
 *  - `cat` holds the script on stdin: main closing that pipe, wsl.exe being killed or One crashing all read as
 *    end-of-file inside the distro, and the EXIT trap then ends the server. Nothing has to reach in to stop it;
 *  - **no single quotes anywhere**: `wsl.exe` re-quotes every argument for the distro with `'`, so a `'` in the
 *    script ends that quote there — bash waits for the rest of it and the server is never started.
 */
export const OPENCODE_WSL_SERVE =
  'cd -- "${ONE_CWD:-.}" 2>/dev/null || exit 1; set +m; unset OPENCODE_PASSWORD OPENCODE_SERVER_PASSWORD; printf "one-cwd %s\\n" "$(pwd -P)"; ' +
  'if command -v setsid >/dev/null 2>&1; then setsid "$1" serve --hostname 127.0.0.1 --port 0 </dev/null & g=-$!; ' +
  'else "$1" serve --hostname 127.0.0.1 --port 0 </dev/null & g=$!; fi; ' +
  'trap "kill -- \\$g 2>/dev/null" EXIT; trap "exit 0" HUP INT TERM; cat >/dev/null';

/**
 * How main starts its private server inside the WSL distro opencode was found in (an interactive login bash like
 * the TUI: the user's PATH). null: the folder has no path inside that distro (another distro's, a network share).
 */
export function planOpencodeServeWsl(info: OpencodeInfo, root: string, wslExe: string, env: Record<string, string | undefined> = {}): { file: string; args: string[]; linuxRoot: string; env: Record<string, string> } | null {
  if (info.via !== 'wsl' || !info.distro || !info.path) return null;
  const linuxRoot = wslPathFor(root, info.distro);
  if (!linuxRoot) return null;
  return { file: wslExe, args: ['-d', info.distro, '--cd', linuxRoot, '-e', 'bash', '-lic', OPENCODE_WSL_SERVE, 'opencode', info.path], linuxRoot, env: wslCwdEnv(linuxRoot, env) };
}

/**
 * How to start the Opencode TUI: plain `opencode` in the folder, or — with One's private server (the
 * "Follow Opencode's edits" setting) — `opencode --server <url>`, the generated password in the terminal's
 * environment only (never in argv: the process list shows argv).
 * Inside WSL (like planClaude): an interactive login bash, cd'ing back to the folder after the rc files, then exec
 * of the path the lookup found (an argument, not script text). With a server (it runs in the same distro, so its
 * 127.0.0.1 address is the TUI's own loopback): the address is one more argument and the password crosses as an
 * environment variable through WSLENV, like Claude's ONE_FOLLOW_DIR.
 */
export function planOpencode(info: OpencodeInfo, cwd: string, o: { platform: string; env: Record<string, string | undefined>; wslExe?: string; server?: { url: string; password: string } }): SpawnPlan {
  const win = o.platform === 'win32';
  if (info.via === 'wsl' && info.distro && o.wslExe) {
    const inside = wslPathFor(cwd, info.distro);
    const head = ['-d', info.distro, '--cd', inside ?? cwd, '-e', 'bash', '-lic'];
    const tail = ['opencode', info.path ?? 'opencode'];
    if (!o.server) return { file: o.wslExe, args: [...head, 'cd -- "${ONE_CWD:-.}" 2>/dev/null; exec "$1"', ...tail], cwd, env: wslCwdEnv(inside, o.env) };
    return { file: o.wslExe, args: [...head, 'cd -- "${ONE_CWD:-.}" 2>/dev/null; exec "$1" --server "$2"', ...tail, o.server.url], cwd, env: { OPENCODE_PASSWORD: o.server.password, ...wslCwdEnv(inside, o.env, ['OPENCODE_PASSWORD']) } };
  }
  const exe = info.path!;
  const P = pathFor(o.platform);
  const pathKey = win ? (Object.keys(o.env).find((k) => k.toLowerCase() === 'path') ?? 'Path') : 'PATH';
  const env: Record<string, string> = { [pathKey]: [P.dirname(exe), envGet(o.env, 'PATH', win)].filter(Boolean).join(P.delimiter) };
  if (o.server) env.OPENCODE_PASSWORD = o.server.password;
  const args = o.server ? ['--server', o.server.url] : [];
  if (win && /\.(cmd|bat)$/i.test(exe)) {
    Object.assign(env, SHIM_ENV);
    const comspec = envGet(o.env, 'ComSpec', true) || P.join(envGet(o.env, 'SystemRoot', true) || 'C:\\Windows', 'System32', 'cmd.exe');
    const run = [cmdQuote(exe), ...args.map(cmdQuote)].join(' ');
    if (isUncPath(cwd)) return { file: comspec, args: `/D ${cmdTail('/C', `pushd ${cmdQuote(cwd)} && ${run}`)}`, cwd: envGet(o.env, 'USERPROFILE', true) || 'C:\\', env };
    return { file: comspec, args: `/D ${cmdTail('/C', run)}`, cwd, env };
  }
  return { file: exe, args, cwd, env };
}
