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

// Renderer build. base './' so Electron can load it via file://
export default defineConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  base: './',
  resolve: { alias: { '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) } },
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  plugins: [pdfjsAssets()],
  worker: { format: 'es' },
  build: {
    outDir: process.env.SEC_EDIT_RENDERER_OUT || fileURLToPath(new URL('./dist/renderer', import.meta.url)),
    emptyOutDir: true,
    target: 'chrome120',
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
    modulePreload: { polyfill: false },
    rolldownOptions: {
      output: {
        // app.ts + ui.ts are both startup code: keep them in one chunk. Otherwise a lazy feature that
        // imports only one of them splits them apart (+1 request, ~100 B gzip on the startup budget).
        codeSplitting: { groups: [{ name: 'core', test: /src[\\/]renderer[\\/]app[\\/](app|ui)\.tsx?$/ }] },
      },
    },
  },
  server: { port: 5173, strictPort: false },
});
