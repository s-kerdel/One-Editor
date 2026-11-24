// @vitest-environment happy-dom
// The paste-time trailing-whitespace trim (editor.trimPaste.*) and the smart-paste chip, through a real
// paste event on the view. Both hang off CodeMirror's own paste; the rich-HTML branch of paste.ts takes
// that event over, so both are checked for the plain paste AND for a rich clipboard (a web page / IDE
// copy whose HTML carries <a>/<b> and keeps its padded columns).
import { beforeEach, describe, expect, it } from 'vitest';
import { signal } from '@preact/signals';
import type { EditorView } from '@codemirror/view';
import { DEFAULT_SETTINGS } from '@shared/api';
import { app, type DocState } from '../../../src/renderer/app/app';
import { createEditor } from '../../../src/renderer/editor/index';

let view: EditorView;

function setup(path: string, content: string, settings: Record<string, unknown> = {}) {
  document.body.innerHTML = '<div id="host" style="height:400px"></div>';
  const ed = createEditor(document.getElementById('host')!);
  app.settings.value = { ...DEFAULT_SETTINGS, ...settings };
  ed.applySettings(app.settings.value);
  app.editor = ed;
  app.backend = { readFile: async (p: string) => ({ path: p, content, mtime: 1, eol: 'lf' }) } as never;
  const doc: DocState = { path, saved: content, content, mtime: 1, eol: 'lf', dirty: signal(false) };
  app.docs.clear();
  app.docs.set(path, doc);
  ed.open(path, content);
  app.activePath.value = path;
  view = ed.getView!() as EditorView;
  view.dispatch({ selection: { anchor: view.state.doc.length } });
}

const text = () => view.state.doc.toString();

/** Fires a paste event the way the clipboard would: `html` = the rich flavour of the same copy. */
async function paste(plain: string, html?: string) {
  const store: Record<string, string> = { 'text/plain': plain };
  if (html) store['text/html'] = html;
  const dt = {
    types: Object.keys(store),
    getData: (t: string) => store[t] ?? '',
    setData: () => undefined,
    files: [],
    items: [],
  } as unknown as DataTransfer;
  view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
  for (let i = 0; i < 8 && !document.querySelector('[data-testid=paste-chip]'); i++) await new Promise((r) => setTimeout(r, 10));
}

/** Ctrl+Shift+V: the keydown that marks the next paste "exactly as copied". */
function rawKeys() {
  for (const key of ['Control', 'v']) {
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    Object.defineProperty(e, 'keyCode', { get: () => (key === 'Control' ? 17 : 86) });
    Object.defineProperty(e, 'ctrlKey', { get: () => true });
    Object.defineProperty(e, 'shiftKey', { get: () => key === 'v' });
    view.contentDOM.dispatchEvent(e);
  }
}

// A web page's code block: HTML is rich (the link), and inside <pre> the padding of the copy survives.
const PADDED = 'host      ip        \nDC01      10.0.0.10  \n';
const PRE_HTML = `<pre>${PADDED}</pre><p><a href="https://corp.local">docs</a></p>`;

beforeEach(() => setup('n.md', 'note\n'));

describe('paste trailing whitespace', () => {
  it('padded lines lose their trailing spaces in notes and code files', async () => {
    await paste('one  \ntwo\t\n');
    expect(text()).toBe('note\none\ntwo\n');
    setup('a.ts', 'code\n');
    await paste('one  \ntwo\t\n');
    expect(text()).toBe('code\none\ntwo\n');
  });

  it('a rich HTML copy (its own Markdown) is trimmed the same way', async () => {
    await paste(PADDED, PRE_HTML);
    expect(text()).toBe('note\n```\nhost      ip\nDC01      10.0.0.10\n```\n\n[docs](https://corp.local)');
  });

  it('Ctrl+Shift+V pastes exactly as copied, and the setting switches the trim off', async () => {
    rawKeys();
    await paste(PADDED, PRE_HTML);
    expect(text()).toBe(`note\n${PADDED}`);
    setup('n.md', 'note\n', { 'editor.trimPaste.markdown': false });
    await paste('one  \n');
    expect(text()).toBe('note\none  \n');
  });
});

describe('smart paste after a paste', () => {
  const CURL = 'curl https://corp.local/api   -H "X: 1"   \n';
  // The link text differs from its href: a real web-page copy, so paste.ts converts the HTML itself.
  const CURL_HTML = '<p>curl <a href="https://corp.local/api/v1">https://corp.local/api</a>   -H "X: 1"   </p>';
  const chipButton = (label: string) => [...document.querySelectorAll('[data-testid=paste-chip] button')].some((b) => b.textContent === label);

  it('offers the "Paste as…" chip after a plain paste', async () => {
    setup('n.md', 'note\n', { 'editor.smartPaste': true });
    await paste(CURL);
    expect(chipButton('Formatted curl')).toBe(true);
  });

  it('offers it after a rich HTML copy too (paste.ts takes that paste over)', async () => {
    setup('n.md', 'note\n', { 'editor.smartPaste': true });
    await paste(CURL, CURL_HTML);
    expect(chipButton('Formatted curl')).toBe(true);
  });

  it('no chip while the setting is off', async () => {
    await paste(CURL);
    expect(document.querySelector('[data-testid=paste-chip]')).toBeNull();
  });
});
