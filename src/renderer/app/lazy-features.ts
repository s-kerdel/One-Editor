// Startup stubs for feature modules whose install code is too heavy for the launch path.
// A stub registers the commands (same ids/keys as the real module) so key bindings and the palette
// work from the first frame; the real install() replaces them when its chunk loads.
import { app } from './app';
import { getCommand, registerCommands, type Command } from './commands';
import { afterBootIdle, lazy, withModule } from './lazy';

type FormatModule = typeof import('../../format/install');

/** Format: commands, key bindings and format-on-save, with `src/format/install` loaded on idle / first use. */
export function installFormatLazy(): void {
  const baseSave = app.saveFile;
  const format = lazy<FormatModule>(() =>
    import('../../format/install').then((m) => {
      // installFormat() wraps app.saveFile itself: hand it the original, not our stub.
      if (app.saveFile === stubSave) app.saveFile = baseSave;
      m.installFormat(); // re-registers the commands below with the real handlers
      return m;
    }),
  );
  // A save before the chunk arrived must still honour format-on-save.
  const stubSave: typeof app.saveFile = async (path) => {
    if (!app.settings.value.formatOnSave) return baseSave(path);
    await format.load().catch((err) => console.warn('[format] failed to load', err));
    return (app.saveFile === stubSave ? baseSave : app.saveFile)(path);
  };
  app.saveFile = stubSave;

  const hasDoc = () => !!app.activePath.value;
  // After the load the registry holds the real command under the same id: run that one.
  const stubs = new Set<Command>();
  const call = (id: string) => () =>
    withModule(format, () => {
      const real = getCommand(id);
      if (real && !stubs.has(real)) return real.run();
    });
  // Keep ids, titles and keys identical to src/format/install.ts (guarded by tests/unit/perf/lazy-stubs.test.ts).
  const cmds: Command[] = [
    { id: 'format.document', title: 'Format document', category: 'Format', keys: ['Shift-Alt-f', 'Alt-Shift-f'], keywords: ['prettier', 'beautify', 'php', 'indent', 'pretty'], when: hasDoc, run: call('format.document') },
    { id: 'format.selection', title: 'Format selection / code block at cursor', category: 'Format', keys: ['Mod-Alt-f'], keywords: ['prettier', 'beautify', 'fence'], when: hasDoc, run: call('format.selection') },
    { id: 'format.codeBlocks', title: 'Format all code blocks in note', category: 'Format', keywords: ['prettier', 'beautify', 'fence', 'markdown', 'sql', 'php'], when: hasDoc, run: call('format.codeBlocks') },
    { id: 'format.toggleOnSave', title: 'Toggle format on save', category: 'Format', keywords: ['prettier', 'autoformat'], run: call('format.toggleOnSave') },
  ];
  cmds.forEach((c) => stubs.add(c));
  registerCommands(cmds);

  // E2E / debugging handle: same shape as the real one (which replaces it), usable before the chunk is in.
  const g = globalThis as { __secEditFormat?: Record<string, () => Promise<unknown>> };
  const early: Record<string, () => Promise<unknown>> = {};
  for (const fn of ['formatDocument', 'formatSelection', 'formatCodeBlocksInNote', 'toggleFormatOnSave']) {
    early[fn] = async () => {
      await format.load();
      return g.__secEditFormat !== early ? g.__secEditFormat?.[fn]?.() : undefined;
    };
  }
  g.__secEditFormat = early;

  afterBootIdle(() => void format.load().catch((err) => console.warn('[format] failed to load', err)));
}
