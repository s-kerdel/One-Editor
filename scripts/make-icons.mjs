// Renders the icon SVGs to PNGs with Playwright's Chromium and packs a multi-size Windows .ico
// (PNG-compressed entries, supported since Vista). Run after editing an SVG: npm run icons
// Small sizes get their own artwork (bigger glyph, no detail) — a scaled-down master turns to mush at 16 px.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, 'build', f), 'utf8');
const art = { master: read('icon.svg'), s32: read('icon-32.svg'), small: read('icon-small.svg') };
const svgFor = (s) => (s <= 24 ? art.small : s <= 32 ? art.s32 : art.master);
const sizes = [16, 24, 32, 48, 64, 128, 256];
const browser = await chromium.launch();
const page = await browser.newPage();
const pngs = {};
for (const s of [...sizes, 512]) {
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
fs.writeFileSync(path.join(root, 'src/renderer/public/icon.png'), pngs[256]);
fs.copyFileSync(path.join(root, 'build/icon-small.svg'), path.join(root, 'src/renderer/public/favicon.svg')); // browser tab
console.log('icons → build/icon.ico, build/icon.png, src/renderer/public/icon.png, src/renderer/public/favicon.svg');
