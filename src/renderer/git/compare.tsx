// Compare text (lazy chunk): the selection or document vs the clipboard / a remembered selection, in the
// diff view. The diff is git's own (`git diff --no-index --histogram`, via the backend); without git a
// built-in line diff is used and the header says so. Sources are read-only; closing leaves nothing behind.
import { useEffect, useState } from 'preact/hooks';
import type { Change } from '@codemirror/merge';
import type { GitTextHunk } from '@shared/git';
import { app } from '../app/app';
import { copyText } from '../app/fileops';
import { comparePick } from './install';
import { editorSource, type CompareSource } from './compare-menu';

export type { CompareSource };
import { DiffView, type DiffLayout } from './DiffView';
import { builtinHunks, formatPatch, hunkStats, hunksToChanges, relabelPatch } from './compare-diff';
import { gitCall } from './rpc';


const MAX = 5 * 1024 * 1024;
const LAYOUT_KEY = 'sec-edit.git.diffLayout';
const WS_KEY = 'sec-edit.compare.ignoreWhitespace';
const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {}
};
const lf = (t: string) => t.replace(/\r\n?/g, '\n');
/** LF line ends and a final newline: a selection never "owns" the end of file, so a missing last
 *  newline would only show up as a noisy changed line. */
const normal = (t: string) => {
  const s = lf(t);
  return s && !s.endsWith('\n') ? s + '\n' : s;
};

async function clipboardSource(): Promise<CompareSource | null> {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) {
      app.toast('The clipboard has no text', 'info');
      return null;
    }
    return { text: lf(text), label: 'Clipboard' };
  } catch {
    app.toast(
      app.backend.kind === 'web'
        ? 'The browser did not allow reading the clipboard. Allow clipboard access for this page (address bar → site settings), then try again.'
        : 'Could not read the clipboard',
      'info',
      8000,
    );
    return null;
  }
}

const needFile = () => void app.toast('Open a file first', 'info');

/** `src`: captured when the menu item was clicked (the user may switch files while this chunk loads). */
export async function compareWithClipboard(src: CompareSource | null = editorSource()) {
  if (!src) return needFile();
  const clip = await clipboardSource();
  if (clip) openCompare(src, clip);
}

export function selectForCompare(src: CompareSource | null = editorSource()) {
  if (!src) return needFile();
  comparePick.value = { text: src.text, label: src.label, root: app.workspace.value?.root };
  app.toast(`Selected for compare: ${src.label}`, 'success', 2500);
}

/** The remembered selection, if it belongs to the open folder. */
export function previousPick(): CompareSource | null {
  const p = comparePick.value;
  return p && p.root === app.workspace.value?.root ? { text: p.text, label: p.label, path: p.label.split(' · ')[0] } : null;
}

export function compareWithPrevious(src: CompareSource | null = editorSource()) {
  const prev = previousPick();
  if (!prev) return void app.toast('First use “Select Text for Compare”', 'info');
  if (!src) return needFile();
  openCompare(prev, src);
}

/** Tree / tab menu: a whole file (unsaved edits included) vs the clipboard. */
export async function compareFileWithClipboard(path: string) {
  let text = app.docs.get(path)?.content ?? app.editor?.getContent(path);
  if (text === undefined) {
    const f = await app.backend.readFile(path).catch(() => null);
    if (!f || f.binary) return void app.toast('This file cannot be compared as text', 'info');
    text = f.content;
  }
  const clip = await clipboardSource();
  if (clip) openCompare({ text, label: path, path }, clip);
}

interface Result {
  engine: string;
  hunks: GitTextHunk[];
  changes: Change[];
  stats: { added: number; removed: number };
  patch: string;
}

/** git's histogram diff via the backend; the built-in line diff when git is not available. */
export async function computeCompare(a: string, b: string, ignoreWhitespace: boolean, labelA: string, labelB: string): Promise<Result> {
  let hunks: GitTextHunk[] | null = null;
  let patch = '';
  let engine = 'built-in diff';
  const call = gitCall();
  if (call) {
    const r = await call('diffTexts', a, b, { ignoreWhitespace }).catch(() => null);
    if (r?.engine === 'git') {
      hunks = r.hunks;
      patch = relabelPatch(r.patch, labelA, labelB);
      engine = 'git diff --histogram';
    }
  }
  if (!hunks) {
    hunks = builtinHunks(a, b, ignoreWhitespace);
    patch = formatPatch(a, b, hunks, labelA, labelB);
  }
  return { engine, hunks, changes: hunksToChanges(a, b, hunks), stats: hunkStats(hunks), patch };
}

export function openCompare(left: CompareSource, right: CompareSource) {
  const big = Math.max(left.text.length, right.text.length);
  if (big > MAX) return void app.toast(`Too large to compare (more than ${MAX / 1048576} MB)`, 'info');
  app.overlay.value = () => <CompareOverlay left={{ ...left, text: normal(left.text) }} right={{ ...right, text: normal(right.text) }} />;
}

function close() {
  app.overlay.value = null;
  app.editor?.focus();
}

function CompareOverlay({ left, right }: { left: CompareSource; right: CompareSource }) {
  const [swapped, setSwapped] = useState(false);
  const [ws, setWs] = useState(read(WS_KEY) === '1');
  const [layout, setLayout] = useState<DiffLayout>(read(LAYOUT_KEY) === 'split' ? 'split' : 'unified');
  const [res, setRes] = useState<Result | null>(null);
  const a = swapped ? right : left;
  const b = swapped ? left : right;
  useEffect(() => {
    let alive = true;
    void computeCompare(a.text, b.text, ws, a.label, b.label).then((r) => alive && setRes(r));
    return () => {
      alive = false;
    };
  }, [swapped, ws]);
  const tools = (
    <>
      <button type="button" class="se-git-diff-tool" title="Swap left and right" onClick={() => (setRes(null), setSwapped(!swapped))}>
        ⇄ Swap sides
      </button>
      <label class="se-git-diff-tool se-git-diff-check" title="Treat lines that differ only in spaces / tabs as equal">
        <input
          type="checkbox"
          checked={ws}
          onChange={(e) => {
            const on = (e.currentTarget as HTMLInputElement).checked;
            write(WS_KEY, on ? '1' : '0');
            setRes(null);
            setWs(on);
          }}
        />
        Ignore whitespace
      </label>
      <button type="button" class="se-git-diff-tool" title="Copy the differences as a unified diff" disabled={!res?.patch} onClick={() => res && copyText(res.patch, 'Patch')}>
        Copy as patch
      </button>
    </>
  );
  return (
    <div class="se-overlay se-git-diff-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      {res ? (
        <DiffView
          title="Compare text"
          path={a.path ?? b.path ?? ''}
          base={a.text}
          current={b.text}
          baseLabel={a.label}
          currentLabel={b.label}
          layout={layout}
          onLayout={(l) => (write(LAYOUT_KEY, l), setLayout(l))}
          onClose={close}
          changes={res.changes}
          stats={res.stats}
          engine={res.engine}
          tools={tools}
          sameNote={ws ? 'Whitespace is ignored.' : undefined}
        />
      ) : (
        <div class="se-git-diff" aria-busy="true" />
      )}
    </div>
  );
}
