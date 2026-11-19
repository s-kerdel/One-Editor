import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Renderer build. base './' so Electron can load it via file://
export default defineConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  base: './',
  resolve: { alias: { '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) } },
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
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
