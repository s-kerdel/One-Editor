// Right-click menu in the editor (rendered by the shell's context menu: ui.openContextMenu).
// Clipboard actions go through the real paste pipeline (HTML → Markdown, images → attachments) by
// replaying the clipboard as a synthetic paste event; when the browser denies clipboard reads we say so.
import { EditorSelection, type StateCommand } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { toggleComment } from '@codemirror/commands';
import { app } from '../app/app';
import { openContextMenu, type MenuItem } from '../app/ui';
import { getCommand, prettyKey, runCommand } from '../app/commands';
import { docPath, getEditorHost, type LinkTarget } from './host';
import { linkFromElement } from './links';
import { toggleBold, toggleItalic, toggleStrike, toggleHighlight, toggleInlineCode, insertCodeBlock, insertCallout, insertHorizontalRule } from './format';
import { toggleTask } from './lists';
import { insertTable } from './tables';
import { linkCommand, inCodeContext } from './mdkeys';
import { pastePlainText } from './paste';
import { parseWikiLink } from '@shared/wikilinks';
import { addIcons } from '../app/icons';
import { codeAt } from './widgets';
import { isRunnableFence } from '../terminal/run';
import { codeAction, fenceInfoAt } from '../variables/cm';
import { compareMenuItems } from '../git/compare-menu';

// Menu-only icons, registered from this lazy chunk so they cost nothing at startup.
// Lucide-style 24×24 stroke paths ('|' separates sub-paths), matching the app's icon set.
addIcons({
  globe: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z|M2 12h20|M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z',
  menuCut: 'M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z|M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6z|M20 4 8.12 15.88|M14.47 14.48 20 20|M8.12 8.12 12 12',
  menuPaste: 'M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z|M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2',
  menuPastePlain: 'M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z|M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2|M9 12h6|M9 16h4',
  menuSelectAll: 'M5 3a2 2 0 0 0-2 2|M19 3a2 2 0 0 1 2 2|M21 19a2 2 0 0 1-2 2|M5 21a2 2 0 0 1-2-2|M9 3h1|M9 21h1|M14 3h1|M14 21h1|M3 9v1|M21 9v1|M3 14v1|M21 14v1',
  menuBold: 'M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8',
  menuItalic: 'M19 4h-9|M14 20H5|M15 4 9 20',
  menuStrike: 'M16 4H9a3 3 0 0 0-2.83 4|M14 12a4 4 0 0 1 0 8H6|M4 12h16',
  menuHighlight: 'm9 11-6 6v3h9l3-3|m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4',
  menuTable: 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z|M3 9h18|M3 15h18|M9 3v18|M15 3v18',
  menuDivider: 'M5 12h14',
  menuComment: 'm18 16 4-4-4-4|m6 8-4 4 4 4|m14.5 4-5 16',
  exportPdf: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z|M14 3v5h5|M12 11v6|m9 14 3 3 3-3',
  menuClaude: 'M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9z|M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z',
});

/** Language word of the fenced code block at `pos` (null outside one). */
function fenceLangAt(view: EditorView, pos: number): string | null {
  for (let n: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null = syntaxTree(view.state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name !== 'FencedCode') continue;
    const info = n.getChild('CodeInfo');
    return info ? view.state.sliceDoc(info.from, info.to).split(/[\s{]/)[0] : '';
  }
  return null;
}

const keys = (k: string) => prettyKey(k);

function selectedText(view: EditorView): string {
  const { state } = view;
  return state.selection.ranges
    .filter((r) => !r.empty)
    .map((r) => state.sliceDoc(r.from, r.to))
    .join(state.lineBreak);
}

/** Link under `pos` from the syntax tree (source mode has no rendered link elements). */
function linkAt(view: EditorView, pos: number): LinkTarget | null {
  const { state } = view;
  for (let n: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === 'URL' && n.parent?.name !== 'Link' && n.parent?.name !== 'Image') return { kind: 'url', target: state.sliceDoc(n.from, n.to) };
    if (n.name === 'Link' || n.name === 'Autolink') {
      const url = n.getChild('URL');
      if (!url) return null;
      const el = document.createElement('span');
      el.dataset.href = state.sliceDoc(url.from, url.to);
      return linkFromElement(el);
    }
    if (n.name === 'WikiLink' || n.name === 'WikiEmbed') {
      const t = n.getChild('WikiTarget');
      if (!t) return null;
      const w = parseWikiLink(state.sliceDoc(t.from, t.to));
      return { kind: 'wiki', target: w.target, heading: w.heading };
    }
  }
  return null;
}

function linkText(link: LinkTarget): string {
  if (link.kind === 'wiki') return `[[${link.target}${link.heading ? `#${link.heading}` : ''}]]`;
  if (link.kind === 'anchor') return `#${link.heading ?? ''}`;
  return link.target + (link.kind === 'file' && link.heading ? `#${link.heading}` : '');
}

async function copyOrCut(view: EditorView, cut: boolean) {
  view.focus();
  // execCommand runs CodeMirror's own copy/cut handlers (correct line breaks, multi-range, cut = delete).
  let ok = false;
  try {
    ok = document.execCommand(cut ? 'cut' : 'copy');
  } catch {}
  if (ok) return;
  const text = selectedText(view);
  try {
    await navigator.clipboard.writeText(text);
    if (cut) view.dispatch(view.state.replaceSelection(''), { userEvent: 'delete.cut', scrollIntoView: true });
  } catch {
    app.toast(`Clipboard is not accessible — press ${keys(cut ? 'Mod-x' : 'Mod-c')}`, 'info');
  }
}

/** Reads the clipboard (rich when possible) and replays it as a paste event, so paste.ts handles it. */
export async function pasteFromClipboard(view: EditorView): Promise<boolean> {
  view.focus();
  const dt = new DataTransfer();
  try {
    if (navigator.clipboard?.read) {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        for (const type of item.types) {
          const blob = await item.getType(type);
          if (type.startsWith('image/')) dt.items.add(new File([blob], `image.${type.slice(6).replace('jpeg', 'jpg')}`, { type }));
          else if (type === 'text/plain' || type === 'text/html') dt.setData(type, await blob.text());
        }
      }
    } else dt.setData('text/plain', await navigator.clipboard.readText());
  } catch {
    try {
      dt.setData('text/plain', await navigator.clipboard.readText());
    } catch {
      app.toast(`The browser blocked clipboard access — press ${keys('Mod-v')} to paste`, 'info', 5000);
      return false;
    }
  }
  if (!dt.types.length) return false;
  view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  return true;
}

export function buildEditorMenu(view: EditorView, opts: { markdown: boolean; target?: HTMLElement | null }): MenuItem[] {
  const { state } = view;
  const hasSel = state.selection.ranges.some((r) => !r.empty);
  const head = state.selection.main.head;
  const run = (fn: (v: EditorView) => unknown) => () => {
    view.focus();
    fn(view);
  };
  const cmd = (c: StateCommand) => run((v) => c({ state: v.state, dispatch: v.dispatch }));
  const items: MenuItem[] = [];
  const sep = () => items.length && !items[items.length - 1].separator && items.push({ separator: true });

  // Link under the pointer (rendered element) or the cursor (syntax tree).
  const el = opts.target?.closest<HTMLElement>('[data-wiki],[data-href]');
  const link = (el && view.contentDOM.contains(el) ? linkFromElement(el) : null) ?? (opts.markdown ? linkAt(view, head) : null);
  if (link) {
    const path = state.facet(docPath);
    items.push(
      { label: link.kind === 'url' ? 'Open link in browser' : 'Open link', icon: link.kind === 'url' ? 'globe' : 'file', run: () => getEditorHost()?.openLink(link, path, {}) },
      {
        label: 'Copy link',
        icon: 'link',
        run: async () => {
          try {
            await navigator.clipboard.writeText(linkText(link));
            app.toast('Link copied', 'success', 1800);
          } catch {
            app.toast('Clipboard is not accessible', 'error');
          }
        },
      },
    );
    sep();
  }

  items.push(
    { label: 'Cut', icon: 'menuCut', keys: keys('Mod-x'), disabled: !hasSel, run: () => void copyOrCut(view, true) },
    { label: 'Copy', icon: 'copy', keys: keys('Mod-c'), disabled: !hasSel, run: () => void copyOrCut(view, false) },
    { label: 'Paste', icon: 'menuPaste', keys: keys('Mod-v'), run: () => void pasteFromClipboard(view) },
    { label: 'Paste as plain text', icon: 'menuPastePlain', keys: keys('Mod-Shift-v'), run: run((v) => void pastePlainText(v)) },
    { label: 'Select all', icon: 'menuSelectAll', keys: keys('Mod-a'), run: run((v) => v.dispatch({ selection: EditorSelection.single(0, v.state.doc.length), userEvent: 'select' })) },
  );

  if (hasSel && app.openSearch) {
    const text = selectedText(view).trim();
    const first = text.split('\n')[0].slice(0, 200);
    if (first) {
      sep();
      const short = first.length > 28 ? `${first.slice(0, 27)}…` : first;
      items.push({ label: `Search “${short}” in files`, icon: 'search', run: () => app.openSearch?.(first) });
    }
  }

  // Markdown: formatting applies to a selection; with just a caret, offer blocks to insert instead.
  if (opts.markdown && !inCodeContext(state, head)) {
    sep();
    if (hasSel) {
      items.push(
        { label: 'Bold', icon: 'menuBold', keys: keys('Mod-b'), run: cmd(toggleBold) },
        { label: 'Italic', icon: 'menuItalic', keys: keys('Mod-i'), run: cmd(toggleItalic) },
        { label: 'Strikethrough', icon: 'menuStrike', keys: keys('Mod-Shift-x'), run: cmd(toggleStrike) },
        { label: 'Highlight', icon: 'menuHighlight', run: cmd(toggleHighlight) },
        { label: 'Inline code', icon: 'code', run: cmd(toggleInlineCode) },
        { label: 'Link', icon: 'link', keys: keys('Mod-k'), run: run((v) => linkCommand(v)) },
      );
      sep();
      items.push({ label: 'Toggle task', icon: 'check', keys: keys('Mod-Enter'), run: cmd(toggleTask) });
    } else {
      items.push({ label: 'Toggle task', icon: 'check', keys: keys('Mod-Enter'), run: cmd(toggleTask) });
      sep();
      items.push(
        { label: 'Insert table', icon: 'menuTable', run: cmd(insertTable) },
        { label: 'Insert code block', icon: 'braces', run: cmd(insertCodeBlock()) },
        { label: 'Insert callout', icon: 'info', run: cmd(insertCallout('note')) },
        { label: 'Insert divider', icon: 'menuDivider', run: cmd(insertHorizontalRule) },
      );
    }
  } else if (!opts.markdown) {
    sep();
    items.push({ label: 'Toggle comment', icon: 'menuComment', keys: keys('Mod-/'), run: run((v) => toggleComment(v)) });
  }

  // Shell code block (desktop): paste it into the terminal — never presses Enter by itself.
  // {{variables}} in the block are resolved first (missing ones are asked for).
  const lang = opts.markdown && app.runInTerminal ? fenceLangAt(view, head) : null;
  if (lang && isRunnableFence(lang)) {
    sep();
    const code = () => codeAt(view, head) ?? '';
    items.push({ label: 'Run in terminal', icon: 'terminal', run: () => void codeAction('run', view, head, code()).then((r) => r === null && app.runInTerminal?.(code(), { lang })) });
  }
  const block = opts.markdown && fenceLangAt(view, head) !== null ? codeAt(view, head) : null;
  if (block && /\{\{\s*[A-Za-z_]/.test(block)) {
    if (!(lang && isRunnableFence(lang))) sep();
    items.push({ label: 'Copy code with values', icon: 'copy', run: () => void codeAction('copy', view, head, block) });
    if (app.variables?.hasTargets(view.state.facet(docPath))) items.push({ label: 'Copy / Run for targets…', icon: 'terminal', run: () => void app.variables?.forTargets(block, { path: view.state.facet(docPath), info: fenceInfoAt(view.state, head) }) });
  }
  // Claude Code (terminal module, desktop): pre-fills a prompt about the file / the selected lines.
  const ask = [getCommand(hasSel ? 'claude.askSelection' : 'claude.askFile')].filter((c) => c && (!c.when || c.when()));
  if (ask.length) {
    sep();
    items.push({ label: hasSel ? 'Ask Claude about selection' : 'Ask Claude about this file', icon: 'menuClaude', run: () => void runCommand(ask[0]!.id) });
  }

  // Compare text (../git/compare): selection or document vs the clipboard / a remembered selection.
  const compare = compareMenuItems(view);
  if (compare.length) {
    sep();
    items.push(...compare);
  }

  const fmt = getCommand('format.document');
  if (fmt) {
    sep();
    items.push({ label: 'Format document', icon: 'braces', keys: keys('Shift-Alt-f'), disabled: !!fmt.when && !fmt.when(), run: run(() => void runCommand('format.document')) });
  }
  if (opts.markdown && getCommand('preview.exportPdf')) {
    sep();
    items.push({ label: 'Export to PDF…', icon: 'exportPdf', run: () => void runCommand('preview.exportPdf') });
  }
  if (items[items.length - 1]?.separator) items.pop();
  return items;
}

/** contextmenu handler: moves the cursor to the click (unless inside the selection), then opens the menu. */
export function editorContextMenu(isMarkdown: (view: EditorView) => boolean) {
  return EditorView.domEventHandlers({
    contextmenu(e, view) {
      const target = e.target as HTMLElement | null;
      // Widgets with their own UI (properties inputs, embeds) keep the native menu.
      if (target?.closest('input, textarea, .se-props, .se-note-embed-body')) return false;
      if (e.button !== 2) {
        // Keyboard (menu key / Shift+F10): open at the caret, don't move it.
        const c = view.coordsAtPos(view.state.selection.main.head);
        const at = { clientX: c ? c.left : e.clientX, clientY: c ? c.bottom + 2 : e.clientY, preventDefault: () => e.preventDefault(), stopPropagation: () => e.stopPropagation() };
        openContextMenu(at, buildEditorMenu(view, { markdown: isMarkdown(view), target: null }));
        return true;
      }
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos != null && !view.state.selection.ranges.some((r) => r.from <= pos && pos <= r.to && !r.empty)) {
        view.dispatch({ selection: EditorSelection.cursor(pos), userEvent: 'select.pointer' });
      }
      openContextMenu(e, buildEditorMenu(view, { markdown: isMarkdown(view), target }));
      return true;
    },
  });
}
