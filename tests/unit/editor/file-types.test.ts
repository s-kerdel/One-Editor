// @vitest-environment happy-dom
// File type associations in the editor: applySettings installs them (before the first document) and a change
// re-resolves the open code files in place — content, selection and undo history stay.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { undo } from '@codemirror/commands';
import { language } from '@codemirror/language';
import type { EditorView } from '@codemirror/view';
import { DEFAULT_SETTINGS, type Settings } from '@shared/api';
import { setFileAssociations } from '@shared/languages';
import { createEditor } from '../../../src/renderer/editor/index';
import type { EditorController } from '../../../src/renderer/app/app';

let ed: EditorController;
let view: EditorView;
const withTypes = (assoc: unknown): Settings => ({ ...DEFAULT_SETTINGS, 'files.associations': assoc });
const comments = () => view.state.languageDataAt<{ line?: string }>('commentTokens', 0).map((c) => c.line);

beforeEach(() => {
  document.body.innerHTML = '<div id="host" style="height:400px"></div>';
  ed = createEditor(document.getElementById('host')!);
  ed.applySettings({ ...DEFAULT_SETTINGS });
  view = ed.getView!() as EditorView;
});
afterEach(() => void setFileAssociations(null));

describe('file type associations (editor)', () => {
  it('a change of the setting re-highlights the open file in place, and only the files it concerns', async () => {
    const events: string[] = [];
    ed.onLanguageChange!((p) => events.push(p));
    ed.open('n.md', '# note');
    ed.open('b.ts', 'let b = 1;');
    ed.open('View/index.ctp', '<?php echo 1;');
    view.dispatch({ changes: { from: 13, insert: ' // typed' }, selection: { anchor: 5 } });
    expect(ed.getLanguage!()).toEqual({ id: 'text', name: 'Plain text', auto: true });
    expect(comments()).toEqual([]);

    ed.applySettings(withTypes({ '*.ctp': 'php' }));
    expect(ed.getLanguage!()).toEqual({ id: 'php', name: 'PHP', auto: true });
    expect(events).toEqual(['View/index.ctp']);
    expect(comments()).toContain('//'); // Ctrl+/ knows the language at once, before the grammar is in
    expect(view.dom.classList.contains('se-codefile')).toBe(true);
    expect(ed.getContent()).toBe('<?php echo 1; // typed');
    expect(view.state.selection.main.head).toBe(5);
    await vi.waitFor(() => expect(view.state.facet(language)?.name).toBe('php'), { timeout: 10_000 });

    // The same value again (updateSettings applies it twice: directly and as an event) does nothing.
    ed.applySettings(withTypes({ '*.CTP': 'PHP' }));
    expect(events).toEqual(['View/index.ctp']);

    ed.applySettings(withTypes({ '*.ctp': 'yaml' }));
    expect(ed.getLanguage!()!.id).toBe('yaml');
    expect(comments()).toContain('#');
    expect(events).toEqual(['View/index.ctp', 'View/index.ctp']);

    ed.applySettings({ ...DEFAULT_SETTINGS });
    expect(ed.getLanguage!()).toEqual({ id: 'text', name: 'Plain text', auto: true });
    expect(comments()).toEqual([]);
    expect(view.state.facet(language)).toBeNull();
    undo(view);
    expect(ed.getContent()).toBe('<?php echo 1;');
    // The other tabs were never touched.
    expect(ed.getLanguage!('b.ts')!.id).toBe('typescript');
    expect(ed.getLanguage!('n.md')!.id).toBe('markdown');
    expect(events.filter((p) => p !== 'View/index.ctp')).toEqual([]);
  });

  it('is in place before the first document opens', () => {
    document.body.innerHTML = '<div id="host2" style="height:400px"></div>';
    const fresh = createEditor(document.getElementById('host2')!);
    fresh.applySettings(withTypes({ '*.ctp': 'php', jenkinsfile: 'ruby' }));
    const seen: string[] = [];
    fresh.onLanguageChange!((p) => seen.push(p));
    fresh.open('a.ctp', '<?php');
    fresh.open('ci/Jenkinsfile', 'node {}');
    expect(fresh.getLanguage!('a.ctp')).toEqual({ id: 'php', name: 'PHP', auto: true });
    expect(fresh.getLanguage!('ci/Jenkinsfile')!.id).toBe('ruby');
    expect(seen).toEqual([]);
  });

  it('background tabs follow; a per-file language mode wins and is left alone', () => {
    const events: string[] = [];
    ed.open('a.ctp', 'aaa');
    ed.open('b.ctp', 'bbb');
    ed.open('c.ctp', 'ccc');
    ed.setLanguage!('a.ctp', 'json');
    ed.onLanguageChange!((p) => events.push(p));
    ed.applySettings(withTypes({ '*.ctp': 'php' }));
    expect(events.sort()).toEqual(['b.ctp', 'c.ctp']);
    expect(ed.getLanguage!('a.ctp')).toEqual({ id: 'json', name: 'JSON', auto: false });
    expect(ed.getLanguage!('b.ctp')).toEqual({ id: 'php', name: 'PHP', auto: true });
    ed.open('b.ctp', 'ignored');
    expect(ed.getContent()).toBe('bbb');
    expect(comments()).toContain('//');
    // Back to automatic = the association; picking the associated language is "automatic" too.
    ed.setLanguage!('a.ctp', null);
    expect(ed.getLanguage!('a.ctp')).toEqual({ id: 'php', name: 'PHP', auto: true });
    ed.setLanguage!('b.ctp', 'php');
    expect(ed.getLanguage!('b.ctp')!.auto).toBe(true);
  });

  it('a rename into or out of a mapped extension follows; Markdown notes are never re-mapped', () => {
    ed.applySettings(withTypes({ '*.ctp': 'php', '*.md': 'php', 'readme.*': 'php' }));
    ed.open('x.txt', 'plain');
    expect(ed.getLanguage!('x.txt')!.id).toBe('text');
    ed.rename('x.txt', 'x.ctp');
    expect(ed.getLanguage!('x.ctp')!.id).toBe('php');
    ed.open('README.md', '# hi');
    expect(ed.getLanguage!('README.md')).toEqual({ id: 'markdown', name: 'Markdown', auto: true });
    expect(view.dom.classList.contains('se-md')).toBe(true);
  });

  it('a hostile stored value changes nothing and does not throw', () => {
    ed.open('a.ctp', 'x');
    for (const raw of [42, 'php', ['*.ctp', 'php'], { '*.ctp': { toString: 'php' } }, { '../*.ctp': 'php' }, { '*.ctp': 'no-such-language' }, JSON.parse('{"__proto__":{"*.ctp":"php"}}')]) {
      ed.applySettings(withTypes(raw));
      expect(ed.getLanguage!('a.ctp')!.id, JSON.stringify(raw)).toBe('text');
    }
  });
});
