// Live Preview: hides Markdown syntax except where the selection is, renders widgets.
//  - inlinePlugin (ViewPlugin): marks/line styles/inline widgets for the *visible ranges only*.
//  - blockField (StateField): block widgets (tables, $$math$$, folded callouts) — these change
//    vertical layout so CodeMirror requires them to come from state. For huge docs it only covers a
//    window around the viewport (kept up to date by windowTracker).
import { StateField, StateEffect, type EditorState, type Range, type Extension, type SelectionRange, type Transaction } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { syntaxTree, foldedRanges, foldEffect, unfoldEffect } from '@codemirror/language';
import type { SyntaxNode, SyntaxNodeRef } from '@lezer/common';
import { docPath, getEditorHost } from './host';
import { BulletWidget, CheckboxWidget, HrWidget, ImageWidget, MathWidget, CodeHeaderWidget, CalloutIconWidget, CalloutFoldWidget, TableWidget, HeadingFoldWidget, MermaidWidget, calloutInfo, mermaidRetheme } from './widgets';
import { PropertiesWidget } from './properties';
import { codeHeaderVars, varsRefresh } from '../variables/cm';
import { NoteEmbedWidget } from './note-embed';
import { parseProps } from './frontmatter';

const hide = Decoration.replace({});
const lineDecos = new Map<string, Decoration>();
const lineDeco = (cls: string) => {
  let d = lineDecos.get(cls);
  if (!d) lineDecos.set(cls, (d = Decoration.line({ class: cls })));
  return d;
};
const markDecos = new Map<string, Decoration>();
const markDeco = (cls: string) => {
  let d = markDecos.get(cls);
  if (!d) markDecos.set(cls, (d = Decoration.mark({ class: cls })));
  return d;
};

export const CALLOUT_RE = /^((?:[ \t]*>[ \t]?)+)[ \t]*\[!([\w-]+)\]([+-]?)[ \t]*(.*)$/;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;
/** A line that is exactly one `![[embed]]` (optionally `|alias`). */
const EMBED_LINE_RE = /^!\[\[([^[\]|]+)(?:\|[^[\]]*)?\]\]\s*$/;

function touches(ranges: readonly SelectionRange[], from: number, to: number) {
  for (const r of ranges) if (r.from <= to && r.to >= from) return true;
  return false;
}
/** Selection strictly overlaps (not just touching the edges) — used for always-rendered widgets. */
function overlaps(ranges: readonly SelectionRange[], from: number, to: number) {
  for (const r of ranges) {
    if (r.empty ? r.from > from && r.from < to : r.from < to && r.to > from) return true;
  }
  return false;
}

function parseWidth(alias: string | null | undefined): number | null {
  const m = alias && /^(\d{1,4})(?:x\d{1,4})?$/.exec(alias.trim());
  return m ? +m[1] : null;
}

function columnsOf(ws: string, tab = 4): number {
  let col = 0;
  for (const ch of ws) col = ch === '\t' ? col + tab - (col % tab) : col + 1;
  return col;
}

function depthOf(node: SyntaxNode, name: string): number {
  let d = 0;
  for (let p = node.parent; p; p = p.parent) if (p.name === name) d++;
  return d;
}

// ---------------------------------------------------------------- inline plugin

const DESCEND = new Set(['ListItem', 'Blockquote', 'Emphasis', 'StrongEmphasis', 'Strikethrough', 'Highlight', 'Link', 'ATXHeading1', 'ATXHeading2', 'ATXHeading3', 'ATXHeading4', 'ATXHeading5', 'ATXHeading6', 'SetextHeading1', 'SetextHeading2']);

function buildInline(view: EditorView): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  // Syntax is only revealed while editing: an unfocused note (just opened, or focus in the sidebar) renders fully.
  const sel = view.hasFocus ? state.selection.ranges : [];
  const path = state.facet(docPath);
  const host = getEditorHost();
  const out: Range<Decoration>[] = [];
  const seenNodes = new Set<string>();
  const visible = view.visibleRanges;
  const tree = syntaxTree(state);

  const lineTouched = (from: number, to = from) => touches(sel, doc.lineAt(from).from, doc.lineAt(to).to);
  const lineClasses = new Map<number, string[]>();
  const lineStyles = new Map<number, string>();
  const addLineClass = (lineFrom: number, cls: string) => {
    const list = lineClasses.get(lineFrom);
    if (list) list.push(cls);
    else lineClasses.set(lineFrom, [cls]);
  };
  const indentMarked = new Set<number>();
  /** Leading whitespace of list lines renders monospace so nesting depth is visible and predictable. */
  const markIndent = (lineFrom: number, to: number) => {
    if (to <= lineFrom || indentMarked.has(lineFrom)) return;
    indentMarked.add(lineFrom);
    out.push(markDeco('se-list-indent').range(lineFrom, to));
  };
  /** Hanging indent: wrapped lines of a list item align with its text (cols = monospace columns, extra = em). */
  const hang = (lineFrom: number, cols: number, extra: string) => {
    addLineClass(lineFrom, 'se-li');
    lineStyles.set(lineFrom, `--se-hang-cols:${cols};--se-hang-extra:${extra}`);
  };
  const forLines = (from: number, to: number, fn: (line: ReturnType<typeof doc.lineAt>) => void) => {
    // several constructs may style one line → classes are merged per line below
    for (const vr of visible) {
      const a = Math.max(from, vr.from);
      const b = Math.min(to, vr.to);
      for (let pos = a; pos <= b; ) {
        const line = doc.lineAt(pos);
        fn(line);
        pos = line.to + 1;
      }
    }
  };

  const enter = (ref: SyntaxNodeRef): boolean | void => {
    const name = ref.name;
    const from = ref.from;
    const to = ref.to;
    switch (name) {
      case 'Document':
      case 'Paragraph':
      case 'BulletList':
      case 'OrderedList':
      case 'Task':
      case 'TableCell':
        return;
    }
    const key = `${name}:${from}`;
    // A node spanning several visible ranges (folds) is handled once, but containers must still be
    // descended so children in the later range get decorated.
    if (seenNodes.has(key)) return DESCEND.has(name) ? undefined : false;
    seenNodes.add(key);
    const node = ref.node;
    switch (name) {
      case 'ATXHeading1':
      case 'ATXHeading2':
      case 'ATXHeading3':
      case 'ATXHeading4':
      case 'ATXHeading5':
      case 'ATXHeading6': {
        const level = +name.slice(-1);
        const line = doc.lineAt(from);
        addLineClass(line.from, `se-h se-h${level}`);
        let folded = false;
        foldedRanges(state).between(line.to, line.to + 1, (a) => {
          if (a === line.to) folded = true;
        });
        if (line.from === from) out.push(Decoration.widget({ widget: new HeadingFoldWidget(folded), side: -1 }).range(line.from));
        if (!lineTouched(from, to)) {
          for (const m of node.getChildren('HeaderMark')) {
            if (m.from === from) out.push(hide.range(m.from, Math.min(line.to, m.to + 1)));
            else out.push(hide.range(Math.max(line.from, doc.sliceString(m.from - 1, m.from) === ' ' ? m.from - 1 : m.from), m.to));
          }
        }
        return;
      }
      case 'SetextHeading1':
      case 'SetextHeading2': {
        const level = +name.slice(-1);
        const mark = node.getChild('HeaderMark');
        const textEnd = mark ? doc.lineAt(mark.from).from - 1 : to;
        forLines(from, Math.max(from, textEnd), (l) => addLineClass(l.from, `se-h se-h${level}`));
        if (mark) addLineClass(doc.lineAt(mark.from).from, 'se-setext-mark');
        return;
      }
      case 'Blockquote': {
        if (depthOf(node, 'Blockquote') > 0) return; // outer quote styles all lines
        const first = doc.lineAt(from);
        const last = doc.lineAt(to);
        const cm = CALLOUT_RE.exec(first.text);
        const kind = cm ? calloutInfo(cm[2]).kind : null;
        forLines(from, to, (l) => {
          const depth = (/^(?:[ \t]*>[ \t]?)+/.exec(l.text)?.[0].match(/>/g) ?? []).length || 1;
          if (kind) {
            let cls = `se-callout se-callout-${kind}`;
            if (l.number === first.number) cls += ' se-callout-title';
            if (l.number === last.number) cls += ' se-callout-last';
            addLineClass(l.from, cls);
          } else addLineClass(l.from, `se-quote se-quote-d${Math.min(depth, 4)}${l.number === first.number ? ' se-quote-first' : ''}${l.number === last.number ? ' se-quote-last' : ''}`);
        });
        if (cm) {
          const prefixEnd = first.from + first.text.length - cm[4].length;
          const foldable = cm[3] === '+' || cm[3] === '-';
          if (!lineTouched(first.from)) {
            const title = cm[4].trim();
            const defaultTitle = title ? null : cm[2].charAt(0).toUpperCase() + cm[2].slice(1).toLowerCase();
            out.push(Decoration.replace({ widget: new CalloutIconWidget(cm[2], defaultTitle) }).range(first.from, prefixEnd));
            if (title) out.push(markDeco('se-callout-title-text').range(prefixEnd, first.to));
          }
          if (foldable) {
            const folded = isCalloutFolded(state, from, cm[3]);
            out.push(Decoration.widget({ widget: new CalloutFoldWidget(folded, toggleCalloutAt), side: 1 }).range(first.to));
          }
        }
        return;
      }
      case 'QuoteMark': {
        const line = doc.lineAt(from);
        if (lineTouched(from)) return false;
        const first = CALLOUT_RE.exec(line.text);
        if (first) {
          // Callout title line: the icon widget already replaces the prefix.
          let bq: SyntaxNode | null = node.parent;
          while (bq && bq.name !== 'Blockquote') bq = bq.parent;
          if (bq && doc.lineAt(bq.from).number === line.number) return false;
        }
        const end = doc.sliceString(to, to + 1) === ' ' ? to + 1 : to;
        out.push(hide.range(from, end));
        return false;
      }
      case 'ListItem': {
        // Indented continuation lines inside an item (paragraphs, code) get the same monospace indent.
        const first = doc.lineAt(from).number;
        forLines(from, to, (l) => {
          if (l.number === first) return;
          const ws = /^[ \t]+/.exec(l.text)?.[0];
          if (ws && ws.length < l.text.length) markIndent(l.from, l.from + ws.length);
        });
        return;
      }
      case 'ListMark': {
        const item = node.parent;
        const list = item?.parent;
        if (!item || !list) return false;
        const line = doc.lineAt(from);
        const indent = doc.sliceString(line.from, from);
        const plain = /^[ \t]*$/.test(indent); // not inside a blockquote
        if (indent && plain) markIndent(line.from, from);
        const cols = plain ? columnsOf(indent) : -1;
        const spaceAfter = doc.sliceString(to, to + 1) === ' ' ? 1 : 0;
        if (item.getChild('Task')) return false; // TaskMarker renders the checkbox
        if (list.name === 'BulletList') {
          const selected = sel.some((r) => !r.empty && r.from <= from && r.to >= to);
          if (!selected) {
            out.push(Decoration.replace({ widget: new BulletWidget(depthOf(node, 'ListItem') - 1) }).range(from, to + spaceAfter));
            if (cols >= 0) hang(line.from, cols, 'var(--se-bullet-w)');
          }
        } else {
          out.push(markDeco('se-list-num').range(from, to + spaceAfter));
          if (cols >= 0) hang(line.from, cols + (to - from) + spaceAfter, '0px');
        }
        return false;
      }
      case 'TaskMarker': {
        const task = node.parent!;
        const item = task.parent;
        const lm = item?.getChild('ListMark');
        const ordered = item?.parent?.name === 'OrderedList';
        const start = lm && !ordered ? lm.from : from;
        const checked = /x/i.test(doc.sliceString(from + 1, from + 2));
        const line = doc.lineAt(from);
        const indent = lm ? doc.sliceString(line.from, lm.from) : '';
        const plain = /^[ \t]*$/.test(indent);
        const spaceAfter = doc.sliceString(to, to + 1) === ' ' ? 1 : 0;
        if (ordered && lm) out.push(markDeco('se-list-num').range(lm.from, from));
        if (!overlaps(sel, start, to)) {
          out.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(start, to + spaceAfter));
          if (plain && lm) hang(line.from, columnsOf(indent) + (ordered ? from - lm.from : 0), 'var(--se-task-w)');
        }
        addLineClass(line.from, checked ? 'se-task-line se-task-line-done' : 'se-task-line');
        if (checked && task.to > to + 1) out.push(markDeco('se-task-done').range(to + 1, task.to));
        return false;
      }
      case 'Emphasis':
      case 'StrongEmphasis':
      case 'Strikethrough':
      case 'Highlight': {
        if (!touches(sel, from, to)) {
          const markName = name === 'Strikethrough' ? 'StrikethroughMark' : name === 'Highlight' ? 'HighlightMark' : 'EmphasisMark';
          for (const m of node.getChildren(markName)) out.push(hide.range(m.from, m.to));
        }
        return;
      }
      case 'InlineCode': {
        const marks = node.getChildren('CodeMark');
        if (!touches(sel, from, to) && marks.length === 2 && marks[0].to < marks[1].from) {
          out.push(hide.range(marks[0].from, marks[0].to), hide.range(marks[1].from, marks[1].to));
          out.push(markDeco('se-code-chip').range(marks[0].to, marks[1].from));
        } else out.push(markDeco('se-code-chip se-code-chip-raw').range(from, to));
        return false;
      }
      case 'Escape': {
        if (!touches(sel, from, to)) out.push(hide.range(from, from + 1));
        return false;
      }
      case 'Link': {
        const marks = node.getChildren('LinkMark');
        const url = node.getChild('URL');
        const text = doc.sliceString(from, Math.min(to, from + 40));
        if (/^\[![\w-]+\]/.test(text)) return false; // callout marker parsed as a link
        if (!url && /^\[\^[^\]\s]+\]/.test(text)) {
          out.push(markDeco('se-footnote-ref').range(from, Math.min(to, from + text.indexOf(']') + 1)));
          return false;
        }
        if (!url || marks.length < 2) return;
        const textFrom = marks[0].to;
        const textTo = marks[1].from;
        const href = doc.sliceString(url.from, url.to);
        if (textFrom >= textTo) return false;
        if (!touches(sel, from, to)) {
          out.push(hide.range(from, textFrom), hide.range(textTo, to));
          out.push(Decoration.mark({ class: 'se-mdlink', attributes: { 'data-href': href, 'data-live': '1', title: href } }).range(textFrom, textTo));
        } else {
          out.push(Decoration.mark({ class: 'se-mdlink', attributes: { 'data-href': href } }).range(textFrom, textTo));
          out.push(markDeco('se-mdlink-url').range(url.from, url.to));
        }
        return;
      }
      case 'Image': {
        const url = node.getChild('URL');
        const marks = node.getChildren('LinkMark');
        if (!url) return false;
        const alt = marks.length >= 2 ? doc.sliceString(marks[0].to, marks[1].from) : '';
        const altParts = alt.split('|');
        const src = host?.imageUrl(doc.sliceString(url.from, url.to), path, false) ?? null;
        const w = new ImageWidget(src, altParts[0], parseWidth(altParts[1]));
        if (!touches(sel, from, to)) out.push(Decoration.replace({ widget: w }).range(from, to));
        else out.push(Decoration.widget({ widget: w, side: 1 }).range(to));
        return false;
      }
      case 'Autolink': {
        const url = node.getChild('URL');
        if (!url) return false;
        if (!touches(sel, from, to)) out.push(hide.range(from, url.from), hide.range(url.to, to));
        out.push(Decoration.mark({ class: 'se-mdlink', attributes: { 'data-href': doc.sliceString(url.from, url.to), 'data-live': touches(sel, from, to) ? '0' : '1' } }).range(url.from, url.to));
        return false;
      }
      case 'URL': {
        const p = node.parent?.name;
        if (p === 'Link' || p === 'Image' || p === 'Autolink' || p === 'LinkReference') return false;
        out.push(Decoration.mark({ class: 'se-mdlink se-bare-url', attributes: { 'data-href': doc.sliceString(from, to) } }).range(from, to));
        return false;
      }
      case 'WikiLink':
      case 'WikiEmbed': {
        const targetNode = node.getChild('WikiTarget');
        const aliasNode = node.getChild('WikiAlias');
        if (!targetNode) return false;
        const target = doc.sliceString(targetNode.from, targetNode.to);
        const alias = aliasNode ? doc.sliceString(aliasNode.from, aliasNode.to) : null;
        const touched = touches(sel, from, to);
        if (name === 'WikiEmbed' && IMAGE_EXT.test(target.split('#')[0])) {
          const src = host?.imageUrl(target, path, true) ?? null;
          const w = new ImageWidget(src, target, parseWidth(alias));
          if (!touched) out.push(Decoration.replace({ widget: w }).range(from, to));
          else out.push(Decoration.widget({ widget: w, side: 1 }).range(to));
          return false;
        }
        const exists = host ? host.wikiExists(target.split('#')[0], path) : true;
        const cls = `se-mdlink se-wikilink${name === 'WikiEmbed' ? ' se-embed' : ''}${exists ? '' : ' se-mdlink-unresolved'}`;
        const shown = aliasNode && !/^\d+(x\d+)?$/.test(alias ?? '') ? aliasNode : targetNode;
        if (!touched) {
          if (shown.from > from) out.push(hide.range(from, shown.from));
          if (shown.to < to) out.push(hide.range(shown.to, to));
          out.push(Decoration.mark({ class: cls, attributes: { 'data-wiki': target, 'data-live': '1', title: target } }).range(shown.from, shown.to));
        } else out.push(Decoration.mark({ class: cls, attributes: { 'data-wiki': target } }).range(targetNode.from, targetNode.to));
        return false;
      }
      case 'InlineMath': {
        const marks = node.getChildren('MathMark');
        if (marks.length < 2) return false;
        if (!touches(sel, from, to)) {
          const tex = doc.sliceString(marks[0].to, marks[1].from);
          out.push(Decoration.replace({ widget: new MathWidget(tex, marks[0].to - marks[0].from === 2) }).range(from, to));
        } else out.push(markDeco('se-math-src').range(from, to));
        return false;
      }
      case 'BlockMath': {
        // Rendered by blockField when the cursor is outside; style the raw source otherwise.
        forLines(from, to, (l) => addLineClass(l.from, 'se-math-src-line'));
        return false;
      }
      case 'HorizontalRule': {
        if (!lineTouched(from)) out.push(Decoration.replace({ widget: new HrWidget() }).range(from, to));
        else addLineClass(doc.lineAt(from).from, 'se-hr-src');
        return false;
      }
      case 'FencedCode': {
        if (tableRendered(state, from)) return false; // rendered as a diagram by blockField
        const first = doc.lineAt(from);
        const last = doc.lineAt(to);
        const marks = node.getChildren('CodeMark');
        const closed = marks.length >= 2 && last.number > first.number;
        const info = node.getChild('CodeInfo');
        const lang = info ? doc.sliceString(info.from, info.to).split(/[\s{]/)[0] : '';
        const revealed = touches(sel, from, to);
        forLines(from, to, (l) => {
          let cls = 'se-cb';
          if (l.number === first.number) cls += ' se-cb-first';
          if (l.number === last.number && (closed || l.number === first.number)) cls += ' se-cb-last';
          // Fence rows keep the same geometry whether the ``` text is hidden or revealed (no jump on cursor entry).
          if (l.number === first.number || (closed && l.number === last.number)) cls += ' se-cb-fence';
          addLineClass(l.from, cls);
        });
        if (visible.some((v) => v.from <= first.to && v.to >= first.from)) {
          if (!revealed && marks[0]) out.push(hide.range(marks[0].from, first.to));
          const infoText = info ? doc.sliceString(info.from, info.to) : '';
          out.push(Decoration.widget({ widget: new CodeHeaderWidget(lang, infoText, codeHeaderVars(state, infoText, from, to)), side: 1 }).range(first.to));
        }
        if (!revealed && closed) {
          const cm = marks[marks.length - 1];
          if (visible.some((v) => v.from <= last.to && v.to >= last.from)) out.push(hide.range(cm.from, last.to));
        }
        return false;
      }
      case 'CodeBlock': {
        const first = doc.lineAt(from).number;
        const last = doc.lineAt(to).number;
        forLines(from, to, (l) => addLineClass(l.from, `se-cb se-cb-indented${l.number === first ? ' se-cb-first' : ''}${l.number === last ? ' se-cb-last' : ''}`));
        return false;
      }
      case 'Table': {
        if (touches(sel, from, to) || !tableRendered(state, from)) {
          forLines(from, to, (l) => addLineClass(l.from, 'se-table-src'));
          for (const d of node.getChildren('TableDelimiter')) if (doc.lineAt(d.from).text.includes('-')) out.push(markDeco('se-table-delim').range(d.from, d.to));
        }
        return false;
      }
      case 'ObsidianComment':
        out.push(markDeco('se-comment').range(from, to));
        return false;
      case 'ObsidianCommentBlock':
        forLines(from, to, (l) => addLineClass(l.from, 'se-comment-line'));
        return false;
      case 'BlockId':
        out.push(markDeco('se-block-id').range(from, to));
        return false;
      case 'Frontmatter':
      case 'HTMLBlock':
      case 'CommentBlock':
      case 'LinkReference': {
        const label = node.getChild('LinkLabel');
        if (label && doc.sliceString(label.from, label.from + 2) === '[^') out.push(markDeco('se-footnote-def').range(label.from, label.to));
        return false;
      }
      case 'Hashtag':
        return false;
    }
    return;
  };

  for (const { from, to } of visible) tree.iterate({ from, to, enter });
  for (const [pos, classes] of lineClasses) {
    const style = lineStyles.get(pos);
    out.push((style ? Decoration.line({ class: classes.join(' '), attributes: { style } }) : lineDeco(classes.join(' '))).range(pos));
  }
  return Decoration.set(out, true);
}

const inlinePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = safeBuild(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || syntaxTree(u.startState) !== syntaxTree(u.state) || u.transactions.some((t) => t.effects.some((e) => e.is(refreshLive) || e.is(varsRefresh) || e.is(toggleCallout) || e.is(foldEffect) || e.is(unfoldEffect))))
        this.decorations = safeBuild(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

function safeBuild(view: EditorView): DecorationSet {
  try {
    return buildInline(view);
  } catch (err) {
    console.error('[editor] live preview decorations failed', err);
    return Decoration.none;
  }
}

/** Force a decoration rebuild (e.g. after the file list changed so wikilink resolution differs). */
export const refreshLive = StateEffect.define<null>();

// ---------------------------------------------------------------- block field

export const toggleCallout = StateEffect.define<number>({ map: (v, m) => m.mapPos(v) });
const setFocused = StateEffect.define<boolean>();
const setWindow = StateEffect.define<{ from: number; to: number }>();
const BIG_DOC = 300_000;
const WINDOW_MARGIN = 40_000;

interface BlockState {
  decos: DecorationSet;
  focused: boolean;
  window: { from: number; to: number } | null; // null = whole doc
  toggled: number[]; // callout starts whose default fold state was flipped
  tables: number[]; // starts of tables / diagrams rendered as block widgets
}

function isCalloutFolded(state: EditorState, from: number, marker: string): boolean {
  const field = state.field(blockField, false);
  const flipped = field?.toggled.includes(from) ?? false;
  return (marker === '-') !== flipped;
}

function tableRendered(state: EditorState, from: number): boolean {
  const field = state.field(blockField, false);
  return !!field?.tables.includes(from);
}

function toggleCalloutAt(view: EditorView, pos: number) {
  const line = view.state.doc.lineAt(pos);
  view.dispatch({ effects: toggleCallout.of(line.from) });
}

function computeBlocks(state: EditorState, window: BlockState['window'], toggled: number[], focused: boolean): BlockState {
  const out: Range<Decoration>[] = [];
  const tables: number[] = [];
  collectBlocks(state, window?.from ?? 0, window ? Math.min(window.to, state.doc.length) : state.doc.length, toggled, focused, out, tables);
  return { decos: Decoration.set(out, true), focused, window, toggled, tables };
}

/** Block widgets for the top-level nodes overlapping from..to (tables / diagrams starts go to `tables`). */
function collectBlocks(state: EditorState, from: number, to: number, toggled: number[], focused: boolean, out: Range<Decoration>[], tables: number[]) {
  const doc = state.doc;
  const sel = focused ? state.selection.ranges : [];
  const mermaid = tables;
  syntaxTree(state).iterate({
    from,
    to,
    enter(n) {
      switch (n.name) {
        case 'Document':
        case 'BulletList':
        case 'OrderedList':
        case 'ListItem':
          return;
        case 'Table': {
          if (touches(sel, n.from, n.to)) return false;
          const a = doc.lineAt(n.from);
          const b = doc.lineAt(n.to);
          if (/^\s*>/.test(a.text)) return false; // tables inside quotes stay raw
          out.push(Decoration.replace({ widget: new TableWidget(doc.sliceString(a.from, b.to)), block: true }).range(a.from, b.to));
          tables.push(n.from);
          return false;
        }
        case 'FencedCode': {
          const info = n.node.getChild('CodeInfo');
          if (!info || doc.sliceString(info.from, info.to).split(/\s/)[0].toLowerCase() !== 'mermaid') return false;
          if (touches(sel, n.from, n.to)) return false;
          const marks = n.node.getChildren('CodeMark');
          const a = doc.lineAt(n.from);
          const b = doc.lineAt(n.to);
          if (marks.length < 2 || b.number <= a.number + 1 || a.from !== n.from) return false;
          out.push(Decoration.replace({ widget: new MermaidWidget(doc.sliceString(doc.line(a.number + 1).from, doc.line(b.number - 1).to)), block: true }).range(a.from, b.to));
          mermaid.push(n.from);
          return false;
        }
        case 'BlockMath': {
          if (touches(sel, n.from, n.to)) return false;
          const marks = n.node.getChildren('MathMark');
          if (marks.length < 2) return false;
          const a = doc.lineAt(n.from);
          const b = doc.lineAt(n.to);
          if (a.from !== n.from) return false; // indented/quoted: keep inline styling
          const tex = doc.sliceString(marks[0].to, marks[marks.length - 1].from).trim();
          out.push(Decoration.replace({ widget: new MathWidget(tex, true), block: true }).range(a.from, b.to));
          return false;
        }
        case 'Frontmatter': {
          // Properties editor; raw YAML while the cursor is inside (or when the YAML is beyond the editor's subset).
          if (n.from !== 0 || touches(sel, n.from, n.to)) return false;
          const a = doc.lineAt(n.from);
          const b = doc.lineAt(n.to);
          if (b.number <= a.number || !/^(---|\.\.\.)[ \t]*$/.test(b.text)) return false;
          const body = b.number > a.number + 1 ? doc.sliceString(doc.line(a.number + 1).from, doc.line(b.number - 1).to) : '';
          if (body.length > 64 * 1024 || !parseProps(body).ok) return false;
          out.push(Decoration.replace({ widget: new PropertiesWidget(body), block: true }).range(a.from, b.to));
          return false;
        }
        case 'Paragraph': {
          // Note embeds on their own line(s) at the top level become embedded blocks.
          if (doc.sliceString(n.from, n.from + 3) !== '![[' || n.node.parent?.name !== 'Document') return false;
          const host = getEditorHost();
          const path = state.facet(docPath);
          const last = doc.lineAt(n.to).number;
          for (let ln = doc.lineAt(n.from).number; ln <= last; ln++) {
            const line = doc.line(ln);
            const m = EMBED_LINE_RE.exec(line.text);
            if (!m) break;
            const target = m[1].trim();
            const hash = target.indexOf('#');
            const file = hash < 0 ? target : target.slice(0, hash);
            if (IMAGE_EXT.test(file) || touches(sel, line.from, line.to)) continue;
            const resolved = file ? (host?.resolveWiki?.(file, path) ?? null) : path;
            const rev = resolved && resolved !== path ? (host?.noteRevision?.(resolved) ?? 0) : 0;
            out.push(Decoration.replace({ widget: new NoteEmbedWidget(target, resolved, hash < 0 ? null : target.slice(hash + 1) || null, path, rev), block: true }).range(line.from, line.to));
          }
          return false;
        }
        case 'Blockquote': {
          const first = doc.lineAt(n.from);
          const cm = CALLOUT_RE.exec(first.text);
          if (!cm || (cm[3] !== '-' && cm[3] !== '+')) return false;
          const folded = (cm[3] === '-') !== toggled.includes(n.from);
          const last = doc.lineAt(n.to);
          if (!folded || last.number === first.number) return false;
          if (overlaps(sel, first.to, last.to) || sel.some((r) => r.from > first.to && r.from <= last.to)) return false;
          out.push(Decoration.replace({}).range(first.to, last.to));
          return false;
        }
      }
      return false;
    },
  });
}

/** Whole lines of the top-level blocks around from..to in `tree`, plus one line of context on each side
 *  (editing a blank line can merge or split the neighbouring blocks). */
function blockSpan(state: EditorState, from: number, to: number): { from: number; to: number } {
  const tree = syntaxTree(state);
  const doc = state.doc;
  let a = from;
  let b = to;
  for (const [pos, side] of [[from, -1], [from, 1], [to, -1], [to, 1]] as const) {
    let n: SyntaxNode | null = tree.resolve(pos, side);
    while (n?.parent && n.parent.name !== 'Document') n = n.parent;
    if (n && n.name !== 'Document') {
      a = Math.min(a, n.from);
      b = Math.max(b, n.to);
    }
  }
  const la = doc.lineAt(Math.max(0, Math.min(a, doc.length)));
  const lb = doc.lineAt(Math.max(0, Math.min(b, doc.length)));
  return { from: la.number > 1 ? doc.line(la.number - 1).from : la.from, to: lb.number < doc.lines ? doc.line(lb.number + 1).to : lb.to };
}

/**
 * Typing / moving the cursor only re-derives the blocks around the edit and the old + new selection;
 * everything else is mapped through the change. Null when a full rebuild is as cheap (or needed).
 */
function updateBlocks(v: BlockState, tr: Transaction, window: BlockState['window'], toggled: number[], focused: boolean): BlockState | null {
  const state = tr.state;
  const start = tr.startState;
  const regions: Array<[number, number]> = [];
  const mapped = (r: { from: number; to: number }): [number, number] => [tr.changes.mapPos(r.from, -1), tr.changes.mapPos(r.to, 1)];
  tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    regions.push(mapped(blockSpan(start, fromA, toA)));
    const n = blockSpan(state, fromB, toB);
    regions.push([n.from, n.to]);
  });
  if (focused) {
    for (const r of start.selection.ranges) regions.push(mapped(blockSpan(start, r.from, r.to)));
    for (const r of state.selection.ranges) {
      const n = blockSpan(state, r.from, r.to);
      regions.push([n.from, n.to]);
    }
  }
  if (!regions.length) return { ...v, window, toggled, focused };
  regions.sort((x, y) => x[0] - y[0]);
  const merged: Array<[number, number]> = [];
  for (const r of regions) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  const lo = window?.from ?? 0;
  const hi = window ? Math.min(window.to, state.doc.length) : state.doc.length;
  let covered = 0;
  for (const r of merged) covered += r[1] - r[0];
  if (covered > (hi - lo) / 2) return null;
  const inside = (from: number, to: number) => merged.some(([a, b]) => from <= b && to >= a);
  const out: Range<Decoration>[] = [];
  const tables = v.tables.map((p) => tr.changes.mapPos(p, 1)).filter((p) => !inside(p, p));
  for (const [a, b] of merged) {
    const from = Math.max(a, lo);
    const to = Math.min(b, hi);
    if (from > to) continue;
    const local: Range<Decoration>[] = [];
    const localTables: number[] = [];
    collectBlocks(state, from, to, toggled, focused, local, localTables);
    for (const d of local) if (d.from <= b && d.to >= a) out.push(d);
    for (const p of localTables) if (p >= a && p <= b && !tables.includes(p)) tables.push(p);
  }
  const decos = v.decos.map(tr.changes).update({ filter: (from, to) => !inside(from, to), add: out, sort: true });
  return { decos, focused, window, toggled, tables };
}

/** Test hook: the full (non-incremental) computation. */
export const computeBlocksForTest = computeBlocks;
export const setBlocksFocusedForTest = setFocused;

export const blockField = StateField.define<BlockState>({
  create(state) {
    return computeBlocks(state, state.doc.length > BIG_DOC ? { from: 0, to: WINDOW_MARGIN * 2 } : null, [], false);
  },
  update(v, tr) {
    let { window, toggled, focused } = v;
    let dirty = tr.docChanged || !!tr.selection || syntaxTree(tr.startState) !== syntaxTree(tr.state);
    // Edits and cursor moves are local; tree-only updates (background parsing) and effects rebuild all.
    let local = dirty && (tr.docChanged || !!tr.selection);
    if (tr.docChanged) {
      toggled = toggled.map((p) => tr.changes.mapPos(p));
      if (window) window = { from: tr.changes.mapPos(window.from, -1), to: tr.changes.mapPos(window.to, 1) };
      if (!window && tr.state.doc.length > BIG_DOC) window = { from: 0, to: WINDOW_MARGIN * 2 };
      if (window && tr.state.doc.length <= BIG_DOC / 2) window = null;
      if ((window === null) !== (v.window === null)) local = false;
    }
    for (const e of tr.effects) {
      if (e.is(toggleCallout)) {
        toggled = toggled.includes(e.value) ? toggled.filter((p) => p !== e.value) : [...toggled, e.value];
        dirty = true;
        local = false;
      } else if (e.is(setWindow)) {
        window = e.value;
        dirty = true;
        local = false;
      } else if (e.is(setFocused)) {
        if (focused !== e.value) dirty = !(local = false);
        focused = e.value;
      } else if (e.is(refreshLive)) {
        dirty = true;
        local = false;
      }
    }
    if (!dirty) return { ...v, window, toggled, focused };
    return (local && updateBlocks(v, tr, window, toggled, focused)) || computeBlocks(tr.state, window, toggled, focused);
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
});

/** Moves the block field's window along with the viewport on huge documents. */
const windowTracker = ViewPlugin.fromClass(
  class {
    pending = false;
    constructor(readonly view: EditorView) {
      this.check();
      this.syncFocus();
    }
    update(u: ViewUpdate) {
      if (u.viewportChanged || u.docChanged) this.check();
      if (u.focusChanged || u.view.hasFocus !== u.state.field(blockField).focused) this.syncFocus();
    }
    focusQueued = false;
    syncFocus() {
      if (this.focusQueued) return;
      this.focusQueued = true;
      queueMicrotask(() => {
        this.focusQueued = false;
        const has = this.view.hasFocus;
        if (this.view.state.field(blockField, false) && this.view.state.field(blockField).focused !== has) this.view.dispatch({ effects: setFocused.of(has) });
      });
    }
    check() {
      const { view } = this;
      const w = view.state.field(blockField).window;
      if (!w || this.pending) return;
      const vp = view.viewport;
      if (vp.from >= w.from + (w.from > 0 ? WINDOW_MARGIN / 4 : 0) && vp.to <= w.to - WINDOW_MARGIN / 4) return;
      this.pending = true;
      requestAnimationFrame(() => {
        this.pending = false;
        const len = view.state.doc.length;
        const v2 = view.viewport;
        view.dispatch({ effects: setWindow.of({ from: Math.max(0, v2.from - WINDOW_MARGIN), to: Math.min(len, v2.to + WINDOW_MARGIN) }) });
      });
    }
  },
);

// ---------------------------------------------------------------- frontmatter (both modes)

function buildFrontmatter(view: EditorView): DecorationSet {
  const fm = syntaxTree(view.state).topNode.firstChild;
  if (!fm || fm.name !== 'Frontmatter') return Decoration.none;
  const doc = view.state.doc;
  const out: Range<Decoration>[] = [];
  const first = doc.lineAt(fm.from).number;
  const last = doc.lineAt(fm.to).number;
  for (const vr of view.visibleRanges) {
    for (let pos = Math.max(fm.from, vr.from); pos <= Math.min(fm.to, vr.to); ) {
      const line = doc.lineAt(pos);
      const fence = line.number === first || line.number === last;
      out.push(lineDeco(`se-fm${line.number === first ? ' se-fm-first' : ''}${line.number === last ? ' se-fm-last' : ''}${fence ? ' se-fm-fence' : ''}`).range(line.from));
      const m = !fence && /^(\s*(?:-\s+)?)([^:#\s][^:]*?):(?=\s|$)/.exec(line.text);
      if (m) out.push(markDeco('se-fm-key').range(line.from + m[1].length, line.from + m[1].length + m[2].length));
      pos = line.to + 1;
    }
  }
  return Decoration.set(out, true);
}

export const frontmatterStyling = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildFrontmatter(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = buildFrontmatter(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

export function livePreview(): Extension {
  return [blockField, windowTracker, inlinePlugin, mermaidRetheme, EditorView.editorAttributes.of({ class: 'se-live' })];
}

export function sourceMode(): Extension {
  return [EditorView.editorAttributes.of({ class: 'se-source' })];
}
