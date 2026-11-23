// The macOS app icon: build/icon.icns as scripts/icns.mjs packs it (npm run icons). Finder list rows, "Open With" and
// Dock menus draw the 16 / 32 px slots; stored as PNG under 'icp4' / 'icp5' they came out as coloured noise.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain .mjs build script
import { ICNS_SLOTS, buildIcns, decodePng, packRle, readIcns, unpackRle } from '../../../scripts/icns.mjs';

type Entry = { type: string; format: 'png' | 'argb' | 'other'; width: number; height: number; rgba: Buffer; data: Buffer };
const root = path.resolve(__dirname, '../../..');
const file = fs.readFileSync(path.join(root, 'build/icon.icns'));
const entries: Entry[] = readIcns(file);
const slot = (type: string) => entries.find((e) => e.type === type)!;
const pixels = (png: Buffer): Buffer => decodePng(png).rgba;

/** The renders make-icons.mjs made in the same run, by pixel size: the PNGs inside build/icon.ico, and build/icon.png (512). */
function renders(): Record<number, Buffer> {
  const ico = fs.readFileSync(path.join(root, 'build/icon.ico'));
  const out: Record<number, Buffer> = { 512: fs.readFileSync(path.join(root, 'build/icon.png')) };
  for (let i = 0; i < ico.readUInt16LE(4); i++) {
    const e = 6 + i * 16;
    const at = ico.readUInt32LE(e + 12);
    out[ico[e] || 256] = ico.subarray(at, at + ico.readUInt32LE(e + 8));
  }
  return out;
}

describe('macOS app icon (build/icon.icns)', () => {
  it('has the ten sizes macOS asks for, each slot with an image of exactly its pixel size; 16 and 32 px are ARGB, never PNG', () => {
    const expected = [
      ['ic04', 16, 'argb'], // 16 pt
      ['ic05', 32, 'argb'], // 32 pt
      ['ic11', 32, 'png'], // 16 pt @2x
      ['ic12', 64, 'png'], // 32 pt @2x
      ['ic07', 128, 'png'],
      ['ic13', 256, 'png'], // 128 pt @2x
      ['ic08', 256, 'png'],
      ['ic14', 512, 'png'], // 256 pt @2x
      ['ic09', 512, 'png'],
      ['ic10', 1024, 'png'], // 512 pt @2x
    ];
    expect(ICNS_SLOTS).toEqual(expected);
    expect(entries.map((e) => [e.type, e.width, e.format])).toEqual(expected);
    expect(entries.every((e) => e.width === e.height)).toBe(true);
    expect(file.toString('latin1', 0, 4)).toBe('icns');
    expect(file.readUInt32BE(4)).toBe(file.length);
  });

  it('every slot holds the render of its size, pixel for pixel: the small ones are the pixel-snapped art, not a scaled master', () => {
    const png = renders();
    for (const [type, px] of ICNS_SLOTS as [string, number][]) {
      if (px === 1024) continue; // only the .icns has it
      expect(slot(type).rgba.equals(pixels(png[px])), `${type} = the ${px} px render`).toBe(true);
    }
    // Not a blank or flat image: the mark is white on teal, on a transparent corner.
    const small = slot('ic04').rgba;
    const at = (x: number, y: number) => [...small.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)];
    expect(at(0, 0)).toEqual([0, 0, 0, 0]);
    expect(at(3, 8)).toEqual([0, 163, 186, 255]);
    expect(at(8, 5)).toEqual([255, 255, 255, 255]);
  });

  it('is what the packer makes of those renders, byte for byte; an image of the wrong size for a slot is refused', () => {
    const png: Record<number, Buffer> = { ...renders(), 1024: slot('ic10').data };
    expect(buildIcns(png).equals(file)).toBe(true);
    expect(() => buildIcns({ ...png, 16: png[32] })).toThrow(/ic04: the image is 32×32/);
    expect(() => buildIcns({ ...png, 64: undefined })).toThrow(/ic12: no 64 px image/);
    expect(() => readIcns(file.subarray(0, file.length - 1))).toThrow(/Not an \.icns/);
  });

  it('packs runs the way the format wants them: 3–130 repeats, up to 128 literal bytes', () => {
    // The first bytes iconutil writes for this icon's alpha plane: 17 clear pixels, three edge pixels, 8 opaque ones.
    const start = Buffer.from([...new Array(17).fill(0), 0x18, 0xa2, 0xe8, ...new Array(8).fill(0xff)]);
    expect(packRle(start).toString('hex')).toBe('8e000218a2e885ff');
    expect(packRle(Buffer.alloc(400, 7)).toString('hex')).toBe('ff07ff07ff078707'); // 130 + 130 + 130 + 10
    const distinct = Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 7) & 255));
    expect(packRle(distinct).length).toBe(300 + 3); // 128 + 128 + 44 literal bytes
    expect(packRle(Buffer.from([1, 1, 2, 2, 3])).toString('hex')).toBe('040101020203'); // pairs are not worth a run
    const mixed = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i % 11 < 4 || i > 4700 ? 9 : (i * 31) & 255)));
    for (const bytes of [start, distinct, mixed, Buffer.alloc(400, 7), Buffer.alloc(0), Buffer.from([5])]) {
      expect(unpackRle(packRle(bytes)).equals(bytes)).toBe(true);
    }
    expect(() => unpackRle(Buffer.from([0x02, 1, 2]))).toThrow(/ends inside a run/);
  });

  // The reader in macOS that Finder's icons go through, not ours: with PNG data in 'icp4' / 'icp5' it returned noise here.
  it.runIf(process.platform === 'darwin' && fs.existsSync('/usr/bin/iconutil'))('macOS reads all ten images back, the 16 and 32 px ones included (iconutil)', () => {
    const out = path.join(root, '.tmp/icon/unit-icns/icon.iconset');
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    execFileSync('/usr/bin/iconutil', ['-c', 'iconset', path.join(root, 'build/icon.icns'), '-o', out]);
    const names: [string, string][] = [
      ['ic04', 'icon_16x16.png'],
      ['ic11', 'icon_16x16@2x.png'],
      ['ic05', 'icon_32x32.png'],
      ['ic12', 'icon_32x32@2x.png'],
      ['ic07', 'icon_128x128.png'],
      ['ic13', 'icon_128x128@2x.png'],
      ['ic08', 'icon_256x256.png'],
      ['ic14', 'icon_256x256@2x.png'],
      ['ic09', 'icon_512x512.png'],
      ['ic10', 'icon_512x512@2x.png'],
    ];
    expect(fs.readdirSync(out).sort()).toEqual(names.map((n) => n[1]).sort());
    for (const [type, name] of names) {
      const ours = slot(type);
      const theirs = decodePng(fs.readFileSync(path.join(out, name)));
      expect([name, theirs.width, theirs.height]).toEqual([name, ours.width, ours.height]);
      // Same shape, and the same colour wherever the icon is opaque. (iconutil brightens the few half-transparent
      // edge pixels of an ARGB slot when it writes them out as PNG, also for an .icns it made itself.)
      let wrong = 0;
      for (let i = 0; i < ours.rgba.length; i += 4) {
        const opaque = ours.rgba[i + 3] === 255;
        if (theirs.rgba[i + 3] !== ours.rgba[i + 3] || (opaque && !theirs.rgba.subarray(i, i + 3).equals(ours.rgba.subarray(i, i + 3)))) wrong++;
      }
      expect([name, wrong]).toEqual([name, 0]);
    }
  });
});
