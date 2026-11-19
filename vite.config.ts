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
  },
  server: { port: 5173, strictPort: false },
});
