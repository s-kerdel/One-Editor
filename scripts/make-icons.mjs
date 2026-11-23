// Renders the icon SVGs to PNGs with Playwright's Chromium and packs a multi-size Windows .ico
// (PNG-compressed entries, supported since Vista) and the macOS .icns (16–1024 px, packed by icns.mjs).
// Run after editing an SVG: npm run icons
// Small sizes get their own pixel-snapped artwork — a scaled-down master turns to mush at 16 px.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIcns } from './icns.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, 'build', f), 'utf8');
const master = read('icon.svg');
// Pixel-snapped art per small size (build/icon-<size>.svg: whole-pixel stem and cuts, the master's proportions).
// Windows picks the exact size when the .ico has it: 100/125/150/200 % taskbars and lists stay sharp.
const svgFor = (s) => (fs.existsSync(path.join(root, 'build', `icon-${s}.svg`)) ? read(`icon-${s}.svg`) : master);
const sizes = [16, 20, 24, 30, 32, 36, 40, 48, 64, 128, 256];
const browser = await chromium.launch();
const page = await browser.newPage();
const pngs = {};
for (const s of [...new Set([...sizes, 512, 1024])]) {
  await page.setViewportSize({ width: s, height: s });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:${s}px;height:${s}px;display:block}</style>${svgFor(s)}`);
  pngs[s] = await page.screenshot({ omitBackground: true });
}
await browser.close();

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(sizes.length, 4);
const dir = Buffer.alloc(16 * sizes.length);
let offset = 6 + dir.length;
sizes.forEach((s, i) => {
  const e = i * 16;
  dir.writeUInt8(s >= 256 ? 0 : s, e); // 0 means 256
  dir.writeUInt8(s >= 256 ? 0 : s, e + 1);
  dir.writeUInt16LE(1, e + 4); // planes
  dir.writeUInt16LE(32, e + 6); // bpp
  dir.writeUInt32LE(pngs[s].length, e + 8);
  dir.writeUInt32LE(offset, e + 12);
  offset += pngs[s].length;
});
fs.writeFileSync(path.join(root, 'build/icon.ico'), Buffer.concat([header, dir, ...sizes.map((s) => pngs[s])]));
fs.writeFileSync(path.join(root, 'build/icon.png'), pngs[512]);
// macOS .icns: 16 / 32 px as raw ARGB, the rest as PNG (icns.mjs says why; tests/unit/review/icns.test.ts checks the file).
fs.writeFileSync(path.join(root, 'build/icon.icns'), buildIcns(pngs));
fs.writeFileSync(path.join(root, 'src/renderer/public/icon.png'), pngs[256]);
fs.copyFileSync(path.join(root, 'build/icon-16.svg'), path.join(root, 'src/renderer/public/favicon.svg')); // browser tab (16 px grid: crisp at 1x and 2x)
console.log('icons → build/icon.ico, build/icon.icns, build/icon.png, src/renderer/public/icon.png, src/renderer/public/favicon.svg');
