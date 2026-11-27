// Editor right-click items for Compare text (editor chunk; the compare code itself loads on click).
import type { EditorView } from '@codemirror/view';
import { app } from '../app/app';
import { addIcons } from '../app/icons';
import type { MenuItem } from '../app/ui';
import { comparePick } from './install';

addIcons({ gitCompare: 'M18 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6z|M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z|M13 6h3a2 2 0 0 1 2 2v7|M11 18H8a2 2 0 0 1-2-2V9' });

export const compareEnabled = () => app.settings.value['compare.enabled'] !== false;
/** Something was "Selected for Compare" in this folder. */
export const hasComparePick = () => !!comparePick.value && comparePick.value.root === app.workspace.value?.root;

const load = () => import('./compare');

export interface CompareSource {
  text: string;
  label: string;
  /** For syntax highlighting. */
  path?: string;
}

/** The selection (all ranges, joined) or the whole document, labelled "path · lines a–b". */
export function editorSource(view?: EditorView): CompareSource | null {
  const v = view ?? (app.editor?.getView?.() as EditorView | undefined);
  const path = app.activePath.value ?? undefined;
  if (!v || !path) return null;
  const st = v.state;
  const ranges = st.selection.ranges.filter((r) => !r.empty);
  if (!ranges.length) return { text: st.doc.toString(), label: path, path };
  const first = st.doc.lineAt(ranges[0].from).number;
  const lastRange = ranges[ranges.length - 1];
  let last = st.doc.lineAt(lastRange.to);
  if (lastRange.to === last.from && last.number > first) last = st.doc.line(last.number - 1); // ends at a line start
  const lines = first === last.number ? `line ${first}` : `lines ${first}-${last.number}`;
  return { text: ranges.map((r) => st.sliceDoc(r.from, r.to)).join('\n'), label: `${path} · ${lines}`, path };
}

export function compareMenuItems(view: EditorView): MenuItem[] {
  if (!compareEnabled()) return [];
  // The source is captured now, at the click: the compare chunk may still be loading when the user moves on.
  const now = () => editorSource(view);
  return [
    { label: 'Compare Text with Clipboard', icon: 'gitCompare', run: () => ((src) => load().then((m) => m.compareWithClipboard(src)))(now()) },
    { label: 'Select Text for Compare', run: () => ((src) => load().then((m) => m.selectForCompare(src)))(now()) },
    { label: 'Compare Text with Previous Selection', disabled: !hasComparePick(), run: () => ((src) => load().then((m) => m.compareWithPrevious(src)))(now()) },
  ];
}
