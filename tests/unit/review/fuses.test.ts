// scripts/fuses.mjs flips Electron's fuse wire in a packaged executable (no dependency, nothing executed).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain .mjs build script
import { FUSES, SEC_EDIT_FUSES, applyFuses, readFuses } from '../../../scripts/fuses.mjs';

const dir = path.resolve(__dirname, '../../../.tmp/sec-desktop/unit-fuses');
fs.mkdirSync(dir, { recursive: true });
const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
/** A stand-in executable: bytes, the sentinel, version 1, length, the wire, more bytes. */
function fakeExe(name: string, wire: string, o: { version?: number; twice?: boolean } = {}) {
  const file = path.join(dir, name);
  const one = Buffer.concat([Buffer.from(SENTINEL), Buffer.from([o.version ?? 1, wire.length]), Buffer.from(wire, 'latin1')]);
  fs.writeFileSync(file, Buffer.concat([Buffer.alloc(4096, 0x90), one, Buffer.from('tail-bytes'), ...(o.twice ? [one] : [])]));
  return file;
}

describe('Electron fuses of the packaged app', () => {
  it('what ships: RunAsNode on (web server child), NODE_OPTIONS and --inspect off; nothing else is touched', () => {
    expect(SEC_EDIT_FUSES).toEqual({ RunAsNode: true, EnableNodeOptionsEnvironmentVariable: false, EnableNodeCliInspectArguments: false });
    const exe = fakeExe('default', '101100011'); // Electron 45's defaults
    const before = fs.readFileSync(exe);
    const now = applyFuses(exe);
    expect(now).toEqual({ RunAsNode: true, EnableCookieEncryption: false, EnableNodeOptionsEnvironmentVariable: false, EnableNodeCliInspectArguments: false, EnableEmbeddedAsarIntegrityValidation: false, OnlyLoadAppFromAsar: false, LoadBrowserProcessSpecificV8Snapshot: false, GrantFileProtocolExtraPrivileges: true, WasmTrapHandlers: true });
    expect(readFuses(exe)).toEqual(now);
    const after = fs.readFileSync(exe);
    expect(after.length).toBe(before.length);
    const changed = [...after.keys()].filter((i) => after[i] !== before[i]);
    const wireAt = before.indexOf(SENTINEL) + SENTINEL.length + 2;
    expect(changed).toEqual([wireAt + FUSES.indexOf('EnableNodeOptionsEnvironmentVariable'), wireAt + FUSES.indexOf('EnableNodeCliInspectArguments')]);
    expect(applyFuses(exe)).toEqual(now); // idempotent
  });

  it('refuses what it does not understand instead of patching blindly', () => {
    expect(() => readFuses(fakeExe('none', '').replace(/none$/, 'missing-file'))).toThrow();
    const plain = path.join(dir, 'plain');
    fs.writeFileSync(plain, 'not an electron binary');
    expect(() => applyFuses(plain)).toThrow(/No fuse wire/);
    expect(() => applyFuses(fakeExe('twice', '101100011', { twice: true }))).toThrow(/More than one/);
    expect(() => applyFuses(fakeExe('v2', '101100011', { version: 2 }))).toThrow(/version/);
    expect(() => applyFuses(fakeExe('short', '10'))).toThrow(/does not exist/); // an older Electron without the fuse
    expect(() => applyFuses(fakeExe('removed', '10rr00011'))).toThrow(/cannot be set/);
    expect(() => applyFuses(fakeExe('typo', '101100011'), { RunAsNodes: false })).toThrow(/does not exist/);
  });

  it('package.mjs applies them to the Windows and Linux executables', () => {
    const pkg = fs.readFileSync(path.resolve(__dirname, '../../../scripts/package.mjs'), 'utf8');
    expect(pkg).toMatch(/applyFuses\(exe\)/);
    expect(pkg).toMatch(/platform === 'win32' \? 'One\.exe' : 'one'/);
  });
});
