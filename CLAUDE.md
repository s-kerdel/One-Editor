# sec-edit

Fast folder-based Markdown + code editor (Electron + browser mode). Read `docs/AGENTS.md` before changing anything:
it defines module ownership, extension points, keybinding allocation and testing rules.

Quick commands:
- `npm run build` — renderer (vite) + node entries (esbuild)
- `npm run electron -- <folder>` — run desktop app (after build)
- `npm run serve -- <folder> --open` — browser mode
- `npx tsc --noEmit -p .` · `npx vitest run` · `npx playwright test`
