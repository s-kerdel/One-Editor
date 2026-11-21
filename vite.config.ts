import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

/** pdf.js data it fetches at runtime (CMaps, standard fonts, image-decoder wasm, ICC): copied to `pdfjs/…`.
 *  Not the scripting sandbox (quickjs / pdf.sandbox) and not the no-wasm JS fallbacks: never loaded. */
function pdfjsAssets(): Plugin {
  const base = fileURLToPath(new URL('./node_modules/pdfjs-dist/', import.meta.url));
  const dirs: Array<[string, RegExp]> = [
    ['cmaps', /\.bcmap$|^LICENSE/],
    ['standard_fonts', /\.(pfb|ttf)$|^LICENSE/],
    ['wasm', /^(openjpeg|jbig2|qcms_bg)\.wasm$|^LICENSE_(OPENJPEG|JBIG2|QCMS|PDFJS_OPENJPEG|PDFJS_JBIG2|PDFJS_QCMS)$/],
    ['iccs', /\.icc$|^LICENSE/],
  ];
  return {
    name: 'sec-edit-pdfjs-assets',
    apply: 'build',
    generateBundle() {
      for (const [dir, re] of dirs) {
        for (const f of fs.readdirSync(path.join(base, dir))) {
          if (re.test(f)) this.emitFile({ type: 'asset', fileName: `pdfjs/${dir}/${f}`, source: fs.readFileSync(path.join(base, dir, f)) });
        }
      }
    },
  };
}

/** index.html's CSP runs scripts from app://sec-edit/assets/ only (the server rewrites it for its origin);
 *  the dev server serves /src, /@vite, … from its own origin. */
function devCsp(): Plugin {
  return { name: 'sec-edit-dev-csp', apply: 'serve', transformIndexHtml: (html) => html.replace(/app:\/\/sec-edit\/assets\/ app:\/\/sec-edit\/theme-boot\.js/, "'self'") };
}

/** The entry chunk and its static imports run before any `import()` can, so listing them in an import's
 *  preload list (`__vite__mapDeps`) only costs bytes: the helper skips loaded files. Startup chunks paid
 *  ~0.9 kB for those entries. The set is read from the bundle before Vite writes the lists (its import
 *  analysis is a post plugin). */
const startupChunks = new Set<string>();
function trackStartupChunks(): Plugin {
  return {
    name: 'sec-edit-startup-chunks',
    apply: 'build',
    generateBundle(_, bundle) {
      startupChunks.clear();
      const queue = Object.values(bundle).filter((c) => c.type === 'chunk' && c.isEntry).map((c) => c.fileName);
      while (queue.length) {
        const f = queue.pop()!;
        const c = bundle[f];
        if (startupChunks.has(f) || c?.type !== 'chunk') continue;
        startupChunks.add(f);
        queue.push(...c.imports);
      }
    },
  };
}

// Renderer build. base './' so Electron can load it via file://
export default defineConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  base: './',
  resolve: { alias: { '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) } },
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  plugins: [pdfjsAssets(), devCsp(), trackStartupChunks()],
  worker: { format: 'es' },
  build: {
    outDir: process.env.SEC_EDIT_RENDERER_OUT || fileURLToPath(new URL('./dist/renderer', import.meta.url)),
    emptyOutDir: true,
    target: 'chrome120',
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
    // index.html keeps its modulepreload links (hostType 'html'); import() lists drop the startup chunks.
    modulePreload: { polyfill: false, resolveDependencies: (_file, deps, { hostType }) => (hostType === 'js' ? deps.filter((d) => !startupChunks.has(d)) : deps) },
    // .vite/manifest.json: the browser-mode server looks up platform/web.ts's chunk in it (index.html runs it first).
    manifest: true,
    rolldownOptions: {
      output: {
        // app.ts + ui.ts are both startup code: keep them in one chunk. Otherwise a lazy feature that
        // imports only one of them splits them apart (+1 request, ~100 B gzip on the startup budget).
        // Don't grow this group: adding icons / documents / tree-model / platform saved 1.7 kB gzip but
        // made the warm Electron launch ~12 ms slower (perf-startup, 2000 files: 80 → 94 ms), measured.
        codeSplitting: { groups: [{ name: 'core', test: /src[\\/]renderer[\\/]app[\\/](app|ui)\.tsx?$/ }] },
      },
    },
  },
  server: { port: 5173, strictPort: false },
});
