// What clicking / Enter in the overview does: jump in the editor (or preview), toggle a task,
// copy a code block. Feature-detects the optional controller capabilities.
import { app } from '../app/app';
import { copyText } from '../app/fileops';
import { taskMarkOffset, type CodeBlockEntry, type DocModel, type TaskEntry } from './model';

/** Cursor to `line` in the active editor, editor focused (Reading mode: scroll the preview). */
export function jumpTo(path: string, line: number, col = 0) {
  if (app.activePath.value !== path) return void app.openFile(path, { line, col });
  if (app.settings.value.viewMode === 'preview' && app.preview) return app.preview.scrollToLine(line);
  app.editor?.reveal({ line, col });
}

/** Flips `- [ ]` ↔ `- [x]` in place (one undoable edit, cursor untouched). Falls back to jumping. */
export function toggleTask(path: string, task: Pick<TaskEntry, 'line' | 'col' | 'done'>): boolean {
  const ed = app.editor;
  const content = ed?.getContent(path) ?? app.docs.get(path)?.content;
  const at = content == null ? -1 : taskMarkOffset(content, task);
  if (!ed?.applyChanges || app.activePath.value !== path || at < 0) {
    jumpTo(path, task.line, task.col);
    return false;
  }
  ed.applyChanges(path, [{ from: at, to: at + 1, insert: content![at] === ' ' ? 'x' : ' ' }]);
  return true;
}

/** Copies a block's code (from the same text version the row was built from, so it always matches). */
export function copyBlock(model: DocModel, block: CodeBlockEntry) {
  void copyText(model.blockText(block), 'Code');
}
