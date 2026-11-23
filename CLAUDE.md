# sec-edit

Fast folder-based Markdown + code editor (Electron + browser mode). Read `LLM-INSTRUCTIONS.md` before changing
anything: hard rules, workflow, task routing and the index of `docs/llm/`.

Quick commands:
- `npm run build` — renderer (vite) + node entries (esbuild)
- `npm run electron -- <folder>` — run desktop app (after build)
- `npm run serve -- <folder> --open` — browser mode
- `npx tsc --noEmit -p .` · `npx vitest run` · `npx playwright test`
