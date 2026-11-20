// Editor commands for the command palette. Keys are CodeMirror-local (displayKeys only) so they
// never steal shortcuts from inputs outside the editor.
import type { EditorView } from '@codemirror/view';
import type { StateCommand } from '@codemirror/state';
import { foldAll, unfoldAll, foldCode, unfoldCode } from '@codemirror/language';
import { gotoLine, openSearchPanel, selectNextOccurrence } from '@codemirror/search';
import { toggleComment, moveLineUp, moveLineDown, copyLineDown, selectLine, cursorSyntaxLeft, cursorSyntaxRight } from '@codemirror/commands';
import { registerCommands, type Command } from '../app/commands';
import { app } from '../app/app';
import { updateSettings } from '../app/settings';
import { toggleBold, toggleItalic, toggleStrike, toggleHighlight, toggleInlineCode, insertLink, setHeading, insertCodeBlock, insertCallout, insertHorizontalRule, insertMathBlock } from './format';
import { toggleTask, renumberList, indentListItem, outdentListItem } from './lists';
import { insertTable, formatTable } from './tables';
import { openReplacePanel } from './mdkeys';
import { openSlashMenu } from './slash';
import { pastePlainText } from './paste';
import { openPropertiesEditor } from './properties';
import { focusToolbar } from './toolbar';

export interface PaletteContext {
  view: () => EditorView | null;
  isMarkdown: () => boolean;
  /** Markdown in live (pencil) mode. */
  isLive: () => boolean;
}

let off: (() => void) | null = null;

// Goes through the shell's single settings path (live apply + coalesced, race-free persistence).
// Keys defaulting to true read `!== false`; the others read truthy.
const DEFAULT_ON = new Set(['markdownLineNumbers', 'formatToolbar', 'wordWrap']);
function toggleSetting(key: 'markdownLineNumbers' | 'formatToolbar' | 'wordWrap' | 'editor.focusMode' | 'editor.typewriter') {
  const v = app.settings.value[key];
  updateSettings({ [key]: DEFAULT_ON.has(key) ? v === false : !v });
}

export function registerEditorCommands(ctx: PaletteContext) {
  off?.();
  // Palette closes after run(); refocus the editor on the next frame.
  const runOn = (fn: (v: EditorView) => unknown) => () => {
    const v = ctx.view();
    if (!v) return;
    v.focus();
    fn(v);
    requestAnimationFrame(() => v.focus());
  };
  const state = (cmd: StateCommand) => runOn((v) => cmd({ state: v.state, dispatch: v.dispatch }));
  const md = () => ctx.isMarkdown();
  const any = () => !!ctx.view();
  const cmd = (id: string, title: string, run: () => void, opts: Partial<Command> = {}): Command => ({ id: `editor.${id}`, title, when: md, run, ...opts });

  const cmds: Command[] = [
    cmd('toggleBold', 'Format: Toggle bold', state(toggleBold), { displayKeys: ['Mod-b'], keywords: ['strong'] }),
    cmd('toggleItalic', 'Format: Toggle italic', state(toggleItalic), { displayKeys: ['Mod-i'], keywords: ['emphasis'] }),
    cmd('toggleStrike', 'Format: Toggle strikethrough', state(toggleStrike), { displayKeys: ['Mod-Shift-x'] }),
    cmd('toggleHighlight', 'Format: Toggle highlight', state(toggleHighlight), { keywords: ['mark', '=='] }),
    cmd('toggleCode', 'Format: Toggle inline code', state(toggleInlineCode), { keywords: ['backtick'] }),
    cmd('insertLink', 'Insert: Link', state(insertLink(null)), { displayKeys: ['Mod-k'], keywords: ['url', 'href'] }),
    cmd('toggleTask', 'Format: Toggle checkbox', state(toggleTask), { displayKeys: ['Mod-Enter'], keywords: ['task', 'todo'] }),
    ...[1, 2, 3, 4, 5, 6].map((n) => cmd(`heading${n}`, `Format: Heading ${n}`, state(setHeading(n)), { displayKeys: [`Mod-${n}`] })),
    cmd('removeHeading', 'Format: Remove heading', state(setHeading(0))),
    cmd('insertTable', 'Insert: Table', state(insertTable)),
    cmd('formatTable', 'Format: Format table', state(formatTable), { keywords: ['align', 'pipes'] }),
    cmd('insertCodeBlock', 'Insert: Code block', state(insertCodeBlock()), { keywords: ['fence', '```'] }),
    cmd('insertCallout', 'Insert: Callout', state(insertCallout('note')), { keywords: ['admonition', 'note', 'warning'] }),
    cmd('insertMath', 'Insert: Math block', state(insertMathBlock), { keywords: ['latex', 'katex', '$$'] }),
    cmd('insertHr', 'Insert: Horizontal rule', state(insertHorizontalRule), { keywords: ['divider', '---'] }),
    cmd('slashMenu', 'Insert: Open insert menu (/)', runOn(openSlashMenu), { displayKeys: ['/'], keywords: ['slash', 'block', 'insert', 'menu'] }),
    cmd('addProperty', 'Insert: Add property', runOn(openPropertiesEditor), { keywords: ['frontmatter', 'yaml', 'metadata', 'properties'] }),
    cmd('pastePlain', 'Edit: Paste as plain text', runOn((v) => void pastePlainText(v)), { displayKeys: ['Mod-Shift-v'], keywords: ['clipboard', 'unformatted'] }),
    cmd('indentList', 'List: Indent item', state(indentListItem), { displayKeys: ['Tab'] }),
    cmd('outdentList', 'List: Outdent item', state(outdentListItem), { displayKeys: ['Shift-Tab'] }),
    cmd('renumberList', 'List: Renumber ordered list', state(renumberList)),
    // Markdown line numbers (source / split mode); code files always show them.
    cmd('toggleLineNumbers', 'Editor: Toggle line numbers', () => void toggleSetting('markdownLineNumbers'), { when: () => true, keywords: ['gutter', 'source mode'] }),
    cmd('toggleFormatToolbar', 'Editor: Toggle formatting toolbar', () => void toggleSetting('formatToolbar'), { when: () => true, keywords: ['toolbar', 'bold', 'buttons', 'format bar'] }),
    cmd('focusFormatToolbar', 'Editor: Focus formatting toolbar', () => {
      const v = ctx.view();
      // After the palette has closed and handed focus back.
      if (v) requestAnimationFrame(() => requestAnimationFrame(() => focusToolbar(v)));
    }, { when: () => ctx.isLive() && app.settings.value.formatToolbar !== false, displayKeys: ['Alt-F10'], keywords: ['toolbar', 'keyboard'] }),
    cmd('toggleFocusMode', 'Editor: Toggle focus mode', () => void toggleSetting('editor.focusMode'), { when: () => true, keywords: ['dim', 'distraction', 'zen', 'paragraph'] }),
    cmd('toggleTypewriter', 'Editor: Toggle typewriter scrolling', () => void toggleSetting('editor.typewriter'), { when: () => true, keywords: ['center', 'centre', 'scroll', 'writing'] }),
    cmd('toggleWordWrap', 'Editor: Toggle word wrap', () => void toggleSetting('wordWrap'), { when: () => true }),
    cmd('foldAll', 'Editor: Fold all', runOn(foldAll), { when: any, displayKeys: ['Ctrl-Alt-['] }),
    cmd('unfoldAll', 'Editor: Unfold all', runOn(unfoldAll), { when: any, displayKeys: ['Ctrl-Alt-]'] }),
    cmd('fold', 'Editor: Fold at cursor', runOn(foldCode), { when: any, displayKeys: ['Ctrl-Shift-['] }),
    cmd('unfold', 'Editor: Unfold at cursor', runOn(unfoldCode), { when: any, displayKeys: ['Ctrl-Shift-]'] }),
    cmd('gotoLine', 'Editor: Go to line…', runOn(gotoLine), { when: any, displayKeys: ['Mod-g'] }),
    cmd('find', 'Editor: Find in file', runOn(openSearchPanel), { when: any, displayKeys: ['Mod-f'] }),
    cmd('replace', 'Editor: Replace in file', runOn(openReplacePanel), { when: any, displayKeys: ['Mod-h'] }),
    cmd('selectNext', 'Editor: Add selection to next match', state(selectNextOccurrence), { when: any, displayKeys: ['Mod-d'], keywords: ['multi cursor'] }),
    cmd('toggleComment', 'Editor: Toggle line comment', runOn(toggleComment), { when: any, displayKeys: ['Mod-/'] }),
    cmd('moveLineUp', 'Editor: Move line up', runOn(moveLineUp), { when: any, displayKeys: ['Alt-ArrowUp'] }),
    cmd('moveLineDown', 'Editor: Move line down', runOn(moveLineDown), { when: any, displayKeys: ['Alt-ArrowDown'] }),
    cmd('copyLineDown', 'Editor: Duplicate line', runOn(copyLineDown), { when: any, displayKeys: ['Shift-Alt-ArrowDown'] }),
    cmd('selectLine', 'Editor: Select line', runOn(selectLine), { when: any }),
    // Alt-Left / Alt-Right are Go back / Go forward (global, like VS Code): CodeMirror's syntax moves stay reachable here.
    cmd('cursorSyntaxLeft', 'Editor: Move cursor to syntax node start', runOn(cursorSyntaxLeft), { when: any, keywords: ['bracket', 'block', 'previous'] }),
    cmd('cursorSyntaxRight', 'Editor: Move cursor to syntax node end', runOn(cursorSyntaxRight), { when: any, keywords: ['bracket', 'block', 'next'] }),
  ];
  off = registerCommands(cmds);
}
