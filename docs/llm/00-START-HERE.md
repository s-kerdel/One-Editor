# 00 - Start here: one change, start to finish

> **WHEN TO READ THIS:** at the start of every task, right after `LLM-INSTRUCTIONS.md`.
> **WHAT YOU GET:** a checklist with the exact commands, from "understand" to "hand over".
> **NEXT FILE:** `02-find-existing-logic.md` (find the code), then `03-playbooks.md` (the recipe).

**Golden rule: copy the nearest existing example and change the minimum.**

## Before you start

- **Rules, routing table and the index of all files:** `LLM-INSTRUCTIONS.md` (repo root). It is always loaded.
- **This file:** the same 10 steps as a checklist, with the exact commands.
- Open **one file at a time**. Close it when you have what you need.

## Checklist

### 1. Understand
- [ ] Write the task as **one sentence**.
- [ ] Decide the **task type**: setting / command / backend call / panel / MCP tool / language / test / bug fix.
- [ ] Decide the **area** (table "Area -> folder" in `LLM-INSTRUCTIONS.md`).

### 2. Locate (never skip)
- [ ] Look up the task in `02-find-existing-logic.md`.
- [ ] Grep for the user-visible text or a keyword:

```bash
grep -rn "Confirm before deleting" src/ | head        # a label the user sees
grep -rn "registerCommand" src/renderer/<area>/ | head # how this area does it
grep -n "keyword" docs/llm/09-reference*.md | head     # the rule for it
```

- [ ] Open the **nearest example** and read it. This is your template.

### 3. Verify every name (anti-hallucination)
- [ ] For each function, type, file or command you plan to use:

```bash
grep -rn "export .* nameYouWant" src/ | head   # must print a line
ls src/path/you/plan/to/edit.ts                # must exist
```

- [ ] **No output = it does not exist.** Do not use it. Pick a name that grep found.

### 4. Plan
- [ ] List the files to change, in order, one line each.
- [ ] More than ~6 files, or a new dependency, or a new IPC channel: **STOP AND ASK**.
- [ ] No precedent found after step 2: **STOP AND ASK**. Say: "No existing pattern found for X. I searched: ...".

### 5. Edit
- [ ] **Read the file immediately before each edit.**
- [ ] Make **small additive edits**. Never reformat, reorder or delete other code.
- [ ] Shared files (`src/renderer/main.tsx`, `src/renderer/app/app.ts`, `src/renderer/app/commands.ts`, `src/shared/api.ts`, `src/shared/paths.ts`): add one line or one optional field, nothing more.
- [ ] Comments: short, say **why**, not what.

### 6. Typecheck

```bash
npx tsc --noEmit -p .
```

- [ ] Output must be empty. Fix **your** errors only.

### 7. Test (your own test only)
- [ ] Add a case to an existing test file of the area, or copy one (`05-testing-and-verify.md`).

```bash
npx vitest run tests/unit/<area>/<file>.test.ts
```

- [ ] UI behaviour in the browser build, one spec file:

```bash
npm run test:e2e:file -- tests/e2e/<file>.spec.ts
```

- [ ] **Do not** run the full suite. The lead runs it once per iteration.

### 8. Docs
- [ ] User-visible change: add a short line to `docs/USER-GUIDE.md`.
- [ ] New extension point, key binding or contract: add it to the matching `09-reference-*.md` (a key: the table in `09-reference-keys.md`).

### 9. Self-check
- [ ] `git status --short` shows **only** the files in your plan.
- [ ] `git diff --stat` is small. A huge diff means you reformatted something: undo that.
- [ ] No new file outside `src/`, `tests/`, `docs/`, `.tmp/`.

### 10. Hand over (do not commit)
Report in this shape:

```
DONE: <one sentence>
FILES: <path> (+N -M), ...
TESTS RUN: <command> -> <pass/fail counts>
TYPECHECK: clean / <errors>
NOT VERIFIED: <what you could not check, e.g. desktop-only behaviour>
QUESTIONS: <open points>
```

## When unsure

| Situation | Do |
|---|---|
| Two ways to do it exist in the code | Use the one in the **same area folder**. |
| A name "should" exist but grep finds nothing | It does not exist. Search for the behaviour instead. |
| The change needs desktop **and** browser mode | Read playbook C in `03-playbooks.md`. |
| The change touches paths, files outside the folder, tokens, shells | Read `04-rules-and-pitfalls.md` first, then ask. |
| A test you did not write fails | Report it. Do not edit it to make it pass. |
