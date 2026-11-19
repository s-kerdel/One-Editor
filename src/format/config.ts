// Formatter configuration: workspace `.prettierrc` / `.prettierrc.json` / `.editorconfig`
// (nearest ancestor wins) layered over the `format.*` app settings. Pure apart from the
// injected file reader, so it is unit-testable without a backend.
import type { FormatOptions } from './types';

/** Reads a workspace-relative file; resolves null when it does not exist. */
export type ConfigReader = (path: string) => Promise<string | null>;

export const PRETTIER_FILES = ['.prettierrc', '.prettierrc.json', '.prettierrc.yaml', '.prettierrc.yml'];
export const CONFIG_FILES = [...PRETTIER_FILES, '.editorconfig'];

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const dirName = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

export function isConfigFile(path: string): boolean {
  return CONFIG_FILES.includes(baseName(path));
}

function scalar(raw: string): unknown {
  const v = raw.trim().replace(/\s+#.*$/, '');
  if (/^(['"]).*\1$/.test(v)) return v.slice(1, -1);
  if (v === 'true' || v === 'false') return v === 'true';
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

interface PrettierRc {
  options: Record<string, unknown>;
  overrides: Array<{ files: string[]; excludeFiles: string[]; options: Record<string, unknown> }>;
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]);

/** Parses a .prettierrc (JSON, or flat `key: value` YAML). Returns null when unreadable. */
export function parsePrettierRc(text: string): PrettierRc | null {
  let obj: any;
  try {
    obj = JSON.parse(text);
  } catch {
    // YAML flavour: only top-level scalars are understood (overrides need JSON).
    obj = {};
    for (const line of text.split('\n')) {
      const m = /^([A-Za-z][\w]*)\s*:\s*(\S.*)$/.exec(line);
      if (m) obj[m[1]] = scalar(m[2]);
    }
    if (!Object.keys(obj).length) return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const { overrides, ...options } = obj;
  return {
    options,
    overrides: Array.isArray(overrides)
      ? overrides
          .filter((o) => o && typeof o === 'object' && o.options)
          .map((o) => ({ files: list(o.files), excludeFiles: list(o.excludeFiles), options: o.options }))
      : [],
  };
}

interface EditorConfig {
  root: boolean;
  sections: Array<{ glob: string; props: Record<string, string> }>;
}

export function parseEditorConfig(text: string): EditorConfig {
  const cfg: EditorConfig = { root: false, sections: [] };
  let current: Record<string, string> | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#' || line[0] === ';') continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      current = {};
      cfg.sections.push({ glob: sec[1], props: current });
      continue;
    }
    const kv = /^([^=:]+?)\s*[=:]\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].trim().toLowerCase();
    const value = kv[2].trim().toLowerCase();
    if (current) current[key] = value;
    else if (key === 'root') cfg.root = value === 'true';
  }
  return cfg;
}

/** editorconfig / prettier-style glob → RegExp (`*`, `**`, `?`, `[a-z]`, `{a,b}`, `{1..3}` unsupported). */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      depth++;
      re += '(?:';
    } else if (c === '}' && depth) {
      depth--;
      re += ')';
    } else if (c === ',' && depth) re += '|';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end === -1) re += '\\[';
      else {
        const body = glob.slice(i + 1, end);
        re += '[' + (body[0] === '!' ? '^' + body.slice(1) : body) + ']';
        i = end;
      }
    } else re += c.replace(/[.+^$()|\\\]]/g, '\\$&');
  }
  return new RegExp('^' + re + ')'.repeat(depth) + '$');
}

/** Does `glob`, written in a config living in `configDir`, match the workspace path `file`? */
export function globMatches(glob: string, file: string, configDir: string): boolean {
  const rel = configDir && file.startsWith(configDir + '/') ? file.slice(configDir.length + 1) : file;
  const g = glob.replace(/^\.?\//, '');
  try {
    // A pattern without a slash matches the file name at any depth.
    return globToRegExp(g).test(g.includes('/') ? rel : baseName(rel));
  } catch {
    return false;
  }
}

function fromEditorConfigProps(p: Record<string, string>): FormatOptions {
  const o: FormatOptions = {};
  if (p.indent_style === 'tab') o.useTabs = true;
  else if (p.indent_style === 'space') o.useTabs = false;
  const size = p.indent_size === 'tab' ? p.tab_width : p.indent_size ?? p.tab_width;
  if (size && /^\d+$/.test(size)) o.tabWidth = Number(size);
  if (p.max_line_length && /^\d+$/.test(p.max_line_length)) o.printWidth = Number(p.max_line_length);
  return o;
}

/** `format.*` settings keys → options (unset keys stay undefined so language defaults apply). */
export function optionsFromSettings(s: Record<string, unknown>): FormatOptions {
  const o: FormatOptions = {};
  const num = (k: string) => (typeof s[k] === 'number' && (s[k] as number) > 0 ? (s[k] as number) : undefined);
  const bool = (k: string) => (typeof s[k] === 'boolean' ? (s[k] as boolean) : undefined);
  o.printWidth = num('format.printWidth');
  o.tabWidth = num('format.tabWidth');
  o.useTabs = bool('format.useTabs');
  o.singleQuote = bool('format.singleQuote');
  if (typeof s['format.phpVersion'] === 'string' && s['format.phpVersion']) o.phpVersion = s['format.phpVersion'] as string;
  const kc = s['format.sqlKeywordCase'];
  if (kc === 'upper' || kc === 'lower' || kc === 'preserve') o.sqlKeywordCase = kc;
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

export class ConfigResolver {
  private cache = new Map<string, Promise<string | null>>();
  constructor(private reader: ConfigReader) {}

  private read(path: string): Promise<string | null> {
    let p = this.cache.get(path);
    if (!p) {
      p = this.reader(path).catch(() => null);
      this.cache.set(path, p);
    }
    return p;
  }

  /** Drop cached config (all, or one file after it changed on disk). */
  invalidate(path?: string) {
    if (path === undefined) this.cache.clear();
    else this.cache.delete(path);
  }

  /** Options from config files that apply to `file`: .editorconfig first, .prettierrc on top. */
  async fileOptions(file: string): Promise<FormatOptions> {
    const dirs: string[] = [];
    for (let d = dirName(file); ; d = dirName(d)) {
      dirs.push(d);
      if (d === '') break;
    }
    const at = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

    // .editorconfig: every ancestor contributes until `root = true`; nearer files win.
    const editor: FormatOptions[] = [];
    for (const dir of dirs) {
      const text = await this.read(at(dir, '.editorconfig'));
      if (text === null) continue;
      const cfg = parseEditorConfig(text);
      const props: Record<string, string> = {};
      for (const s of cfg.sections) if (globMatches(s.glob, file, dir)) Object.assign(props, s.props);
      editor.unshift(fromEditorConfigProps(props));
      if (cfg.root) break;
    }

    // .prettierrc: the nearest one wins outright (Prettier does not merge config files).
    let prettier: FormatOptions = {};
    outer: for (const dir of dirs) {
      for (const name of PRETTIER_FILES) {
        const text = await this.read(at(dir, name));
        if (text === null) continue;
        const rc = parsePrettierRc(text);
        if (!rc) continue;
        prettier = { ...rc.options };
        for (const o of rc.overrides) {
          if (o.files.some((g) => globMatches(g, file, dir)) && !o.excludeFiles.some((g) => globMatches(g, file, dir))) Object.assign(prettier, o.options);
        }
        break outer;
      }
    }
    return Object.assign({}, ...editor, prettier);
  }

  /** Final options for `file`: settings < .editorconfig < .prettierrc. */
  async resolve(file: string, settings: Record<string, unknown>): Promise<FormatOptions> {
    return { ...optionsFromSettings(settings), ...(await this.fileOptions(file)) };
  }
}
