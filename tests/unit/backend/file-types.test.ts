// File type associations in the backend: a name the user maps to a language is text for the indexer (so it is
// searched and symbol-indexed), and the app's index options follow the setting — from the app's own
// settings.json only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BackendService, indexOptionsFrom } from '../../../src/backend/service';
import { DEFAULT_INDEX, Indexer } from '../../../src/backend/indexer';
import { DEFAULT_SETTINGS } from '../../../src/shared/api';

let tmp: string;
let root: string;
let cfg: string;
beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sec-filetypes-'));
  root = path.join(tmp, 'app');
  cfg = path.join(tmp, 'config');
  await fsp.mkdir(path.join(root, 'View'), { recursive: true });
  await fsp.writeFile(path.join(root, 'View', 'index.ctp'), '<?php echo $needleInTemplate; ?>\n');
  await fsp.writeFile(path.join(root, 'a.php'), '<?php\n');
  await fsp.writeFile(path.join(root, 'blob.bin'), 'binary-ish\n');
});
afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
});

describe('indexer: extra text names', () => {
  const files = ['View/index.ctp', 'View/Other.CTP', 'a.php', 'blob.bin', 'Jenkinsfile', 'Dockerfile.dev', 'logo.png', 'logo.txt', 'notes.md'];
  const paths = (textPatterns: string[]) => {
    const ix = new Indexer({ root, cacheFile: null, readThreads: 0, index: { ...DEFAULT_INDEX, textPatterns }, foldCase: false });
    ix.setPaths({ version: '1', files, ignoreDirs: [], repoDirs: [] });
    const out = ix.textPaths();
    ix.dispose();
    return out;
  };

  it('built-in names only without patterns', () => {
    expect(paths([])).toEqual(['a.php', 'logo.txt', 'notes.md']);
  });

  it('a covered name is text: extension (any case), whole name, prefix — never a viewer file', () => {
    expect(paths(['*.ctp'])).toEqual(['View/Other.CTP', 'View/index.ctp', 'a.php', 'logo.txt', 'notes.md']);
    expect(paths(['jenkinsfile', 'dockerfile.*', 'logo.*'])).toEqual(['Dockerfile.dev', 'Jenkinsfile', 'a.php', 'logo.txt', 'notes.md']);
  });

  it('follows a change of the options; odd entries are ignored', () => {
    const ix = new Indexer({ root, cacheFile: null, readThreads: 0, index: DEFAULT_INDEX, foldCase: false });
    ix.setPaths({ version: '1', files, ignoreDirs: [], repoDirs: [] });
    expect(ix.textPaths()).not.toContain('View/index.ctp');
    expect(ix.isSkipped('View/index.ctp')).toBe(true);
    ix.setOptions({ ...DEFAULT_INDEX, textPatterns: ['*.ctp', 42 as unknown as string] });
    expect(ix.textPaths()).toContain('View/index.ctp');
    expect(ix.isSkipped('View/index.ctp')).toBe(false);
    ix.setOptions({ ...DEFAULT_INDEX });
    expect(ix.textPaths()).not.toContain('View/index.ctp');
    ix.dispose();
  });
});

describe('BackendService: the setting reaches the index', () => {
  // The index holds content-indexed text and name-only entries (a non-text name: path only, `binary`, no content).
  async function indexed(s: BackendService) {
    const text: string[] = [];
    const nameOnly: string[] = [];
    let cursor: string | null = null;
    do {
      const pg = await s.workspace!.readAllTextPage({ cursor, maxBytes: 1 << 20 });
      for (const f of pg.files) (f.binary ? nameOnly : text).push(f.path);
      cursor = pg.nextCursor;
    } while (cursor);
    return { text: text.sort(), nameOnly: nameOnly.sort() };
  }

  it('a mapped extension is indexed after the setting is saved, and no longer once it is removed', async () => {
    const s = new BackendService(cfg);
    await s.openWorkspace(root);
    // Unmapped: .ctp and .bin are found by name only, their content is not indexed.
    expect(await indexed(s)).toEqual({ text: ['a.php'], nameOnly: ['View/index.ctp', 'blob.bin'] });
    await s.saveSettings({ 'files.associations': { '*.ctp': 'php' } });
    expect(s.workspace!.indexOptions.textPatterns).toEqual(['*.ctp']);
    expect(await indexed(s)).toEqual({ text: ['View/index.ctp', 'a.php'], nameOnly: ['blob.bin'] });
    await s.saveSettings({ 'files.associations': null });
    expect(s.workspace!.indexOptions.textPatterns).toEqual([]);
    expect(await indexed(s)).toEqual({ text: ['a.php'], nameOnly: ['View/index.ctp', 'blob.bin'] });
    s.dispose();
  });

  it('is read from the app settings at open; a hostile value adds nothing', async () => {
    fs.mkdirSync(cfg, { recursive: true });
    fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ 'files.associations': { '*.CTP': 'PHP', '../*.bin': 'php', '*.bin': 'no-such-language', '*.png': 'php' } }));
    const s = new BackendService(cfg);
    await s.openWorkspace(root);
    expect(s.workspace!.indexOptions.textPatterns).toEqual(['*.ctp']);
    // The hostile *.bin / *.png entries make nothing text: blob.bin stays name-only.
    expect(await indexed(s)).toEqual({ text: ['View/index.ctp', 'a.php'], nameOnly: ['blob.bin'] });
    s.dispose();
  });

  it('a settings file inside the opened folder is never read', async () => {
    // A hostile folder cannot bring its own associations: only <config>/settings.json counts.
    await fsp.writeFile(path.join(root, 'settings.json'), JSON.stringify({ 'files.associations': { '*.bin': 'php' } }));
    await fsp.mkdir(path.join(root, '.sec-edit'), { recursive: true });
    await fsp.writeFile(path.join(root, '.sec-edit', 'settings.json'), JSON.stringify({ 'files.associations': { '*.bin': 'php' } }));
    const s = new BackendService(cfg);
    await s.openWorkspace(root);
    expect(s.workspace!.indexOptions.textPatterns).toEqual([]);
    expect((await s.getSettings())['files.associations']).toBeUndefined();
    s.dispose();
  });

  it('the MCP server keeps the built-in text names (indexOptionsFrom has no patterns)', () => {
    expect(indexOptionsFrom({ ...DEFAULT_SETTINGS, 'files.associations': { '*.ctp': 'php' } })).not.toHaveProperty('textPatterns');
  });
});
