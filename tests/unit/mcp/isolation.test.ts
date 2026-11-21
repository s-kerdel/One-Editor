// The MCP server program must never reach the secrets vault, {{variables}} resolution, git, terminals,
// Electron main or the renderer. Checked on what esbuild really bundles from src/mcp/cli.ts (its metafile:
// every input file) and on the output text, so a re-export or a dynamic import cannot sneak past.
import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { build, type Metafile } from 'esbuild';

const root = path.resolve(__dirname, '../../..');
let inputs: string[] = [];
let output = '';
let meta: Metafile;

beforeAll(async () => {
  const r = await build({
    entryPoints: [path.join(root, 'src/mcp/cli.ts')],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    write: false,
    metafile: true,
    logLevel: 'silent',
    absWorkingDir: root,
  });
  meta = r.metafile as Metafile;
  inputs = Object.keys(meta.inputs).map((p) => p.replace(/\\/g, '/'));
  output = r.outputFiles[0].text;
}, 60_000);

describe('MCP server isolation', () => {
  it('bundles none of: the vault, variables, main, renderer, git, terminals, the web server', () => {
    expect(inputs.length).toBeGreaterThan(20);
    // main/env-guard.ts is pure (no electron): the packaged-build env scrub the server shares with the app.
    const own = inputs.filter((p) => p.startsWith('src/') && p !== 'src/main/env-guard.ts');
    const forbidden = [/vault/i, /^src\/main\//, /^src\/renderer\//, /^src\/server\//, /^src\/backend\/git(?!ignore\.ts$)/, /^src\/backend\/service\.ts$/, /terminal/i, /variables/i, /^src\/backend\/pdf-export\.ts$/];
    for (const p of own) for (const re of forbidden) expect(p, `${p} must not be part of the MCP server`).not.toMatch(re);
  });

  it('never names the vault file, safeStorage or the renderer bridge in its output', () => {
    for (const s of ['vault.json', 'safeStorage', 'secEditBridge', 'vault:']) expect(output.includes(s), s).toBe(false);
  });

  it('starts no processes of its own: child_process only in the shared watcher (fixed WSL inotifywait) and the trash helper (fixed Recycle Bin call)', () => {
    const importers = Object.entries(meta.inputs)
      .filter(([, i]) => i.imports.some((im) => /(^|:)child_process$/.test(im.path)))
      .map(([f]) => f.replace(/\\/g, '/'))
      .sort();
    expect(importers).toEqual(['src/backend/trash.ts', 'src/backend/watcher.ts']);
  });

  it('ships only production packages (the MCP SDK is a dev dependency: tests only)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const prod = new Set(Object.keys(pkg.dependencies));
    const pkgOf = (p: string) => {
      const m = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(p);
      return m?.[1];
    };
    const used = new Set(inputs.map(pkgOf).filter(Boolean) as string[]);
    for (const name of used) expect(prod.has(name) || !!pkg.dependencies[name] || isTransitiveOfProd(name), `${name} is not a production dependency`).toBe(true);
    expect([...used].some((n) => n.startsWith('@modelcontextprotocol/'))).toBe(false);
    // Bare imports left in the output are Node built-ins only.
    const external = [...output.matchAll(/^import\b[^\n]*?["']([^"'./][^"']*)["'];?$/gm)].map((m) => m[1]);
    expect(external.length).toBeGreaterThan(3);
    for (const e of external) expect(e.startsWith('node:') || builtinModules.includes(e), e).toBe(true);
  });

  it('no MCP source resolves {{variables}} or reads the vault (source text check)', () => {
    const dir = path.join(root, 'src/mcp');
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of walk(dir)) {
      const text = fs.readFileSync(f, 'utf8');
      expect(/from\s+['"][^'"]*(vault|variables)[^'"]*['"]/.test(text), f).toBe(false);
      expect(/import\(\s*['"][^'"]*(vault|variables)/.test(text), f).toBe(false);
    }
  });
});

/** A package the bundle pulls in through a production dependency (lockfile: not dev-only). */
function isTransitiveOfProd(name: string): boolean {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const e = lock.packages?.[`node_modules/${name}`];
  return !!e && !e.dev;
}
