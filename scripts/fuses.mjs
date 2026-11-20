// Electron fuses for the packaged app: build-time switches inside the executable that no command line
// or environment variable can turn back on (https://www.electronjs.org/docs/latest/tutorial/fuses).
// The "fuse wire" is plain bytes after a sentinel string — '1' on, '0' off, 'r' removed — so it is
// flipped here directly (same on-disk format @electron/fuses writes; works for a Windows .exe built on
// Linux, nothing is executed).
//   node scripts/fuses.mjs <executable>          → print the wire
//   import { applyFuses, readFuses } from './fuses.mjs'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
/** Fuse wire v1, by position. */
export const FUSES = [
  'RunAsNode',
  'EnableCookieEncryption',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot',
  'GrantFileProtocolExtraPrivileges',
  'WasmTrapHandlers',
];

/**
 * What sec-edit ships with. Only what differs from Electron's defaults is listed; the rest stays as built.
 *  - RunAsNode stays ON: "Start web server" (and the .cmd / start-web.sh launchers) run the bundled
 *    server with the app's own executable in Node mode (ELECTRON_RUN_AS_NODE).
 *  - NODE_OPTIONS / NODE_EXTRA_CA_CERTS and --inspect* are OFF: neither the environment nor a command
 *    line can load code into, or attach a debugger to, the main process (which has full file access).
 */
export const SEC_EDIT_FUSES = {
  RunAsNode: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
};

function wireOf(buf, file) {
  const at = buf.indexOf(SENTINEL);
  if (at === -1) throw new Error(`No fuse wire in ${file} (not an Electron executable?)`);
  if (buf.indexOf(SENTINEL, at + 1) !== -1) throw new Error(`More than one fuse wire in ${file}`);
  const head = at + SENTINEL.length;
  const version = buf[head];
  const length = buf[head + 1];
  if (version !== 1) throw new Error(`Unknown fuse wire version ${version} in ${file}`);
  return { start: head + 2, length };
}

/** { RunAsNode: true, … } as the executable has it now ('removed' for a fuse the build dropped). */
export function readFuses(file) {
  const buf = fs.readFileSync(file);
  const { start, length } = wireOf(buf, file);
  const out = {};
  for (let i = 0; i < length; i++) {
    const c = buf[start + i];
    out[FUSES[i] ?? `fuse${i}`] = c === 0x31 ? true : c === 0x30 ? false : c === 0x72 ? 'removed' : `0x${c.toString(16)}`;
  }
  return out;
}

/** Sets the given fuses in place (others untouched) and returns the resulting state. Throws on a fuse this Electron does not have. */
export function applyFuses(file, want = SEC_EDIT_FUSES) {
  const buf = fs.readFileSync(file);
  const { start, length } = wireOf(buf, file);
  for (const [name, on] of Object.entries(want)) {
    const i = FUSES.indexOf(name);
    if (i === -1 || i >= length) throw new Error(`Fuse ${name} does not exist in ${file}`);
    const c = buf[start + i];
    if (c !== 0x30 && c !== 0x31) throw new Error(`Fuse ${name} cannot be set in ${file} (state 0x${c.toString(16)})`);
    buf[start + i] = on ? 0x31 : 0x30;
  }
  fs.writeFileSync(file, buf);
  const now = readFuses(file);
  for (const [name, on] of Object.entries(want)) if (now[name] !== on) throw new Error(`Fuse ${name} did not take in ${file}`);
  return now;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) throw new Error('usage: node scripts/fuses.mjs <executable>');
  console.log(readFuses(file));
}
