// Format core: pure, environment-agnostic (runs in the worker, in Node tests, or as a
// main-thread fallback). Every formatter and plugin is loaded lazily on first use.
import { formatterForFence, formatterForPath, languageById, languageForPath, sqlDialectFor, type FormatterInfo, type LanguageInfo } from '../shared/languages';
import { mapCursor } from './diff';
import { formatCodeBlocks, protectObsidian } from './markdown';
import type { FormatIssue, FormatOptions, FormatRequest, FormatResult } from './types';

type Plugin = any;
const unwrap = (m: any): Plugin => (m && (m.parsers || m.printers || m.languages) ? m : m?.default ?? m);

const loadBabel = async () => [unwrap(await import('prettier/plugins/babel')), unwrap(await import('prettier/plugins/estree'))];
const loadTs = async () => [unwrap(await import('prettier/plugins/typescript')), unwrap(await import('prettier/plugins/estree'))];
const loadCss = async () => [unwrap(await import('prettier/plugins/postcss'))];
// HTML embeds <script>/<style>, so it needs the JS + CSS printers too.
const loadHtml = async () => [unwrap(await import('prettier/plugins/html')), ...(await loadBabel()), ...(await loadCss())];

const PLUGIN_LOADERS: Record<string, () => Promise<Plugin[]>> = {
  babel: loadBabel,
  typescript: loadTs,
  postcss: loadCss,
  html: loadHtml,
  vue: async () => [...(await loadHtml()), unwrap(await import('prettier/plugins/typescript'))],
  markdown: async () => [unwrap(await import('prettier/plugins/markdown'))],
  yaml: async () => [unwrap(await import('prettier/plugins/yaml'))],
  graphql: async () => [unwrap(await import('prettier/plugins/graphql'))],
  php: async () => [unwrap(await import('@prettier/plugin-php'))],
  xml: async () => [unwrap(await import('@prettier/plugin-xml'))],
};

const pluginCache = new Map<string, Promise<Plugin[]>>();
function loadPlugins(key: string): Promise<Plugin[]> {
  let p = pluginCache.get(key);
  if (!p) {
    const loader = PLUGIN_LOADERS[key];
    if (!loader) return Promise.reject(new Error(`Unknown formatter plugin "${key}"`));
    p = loader();
    pluginCache.set(key, p);
    p.catch(() => pluginCache.delete(key)); // allow a retry after a failed chunk load
  }
  return p;
}

// Prettier options a user config may set; anything else in .prettierrc is ignored.
const PRETTIER_KEYS = [
  'printWidth', 'tabWidth', 'useTabs', 'semi', 'singleQuote', 'jsxSingleQuote', 'quoteProps', 'trailingComma',
  'bracketSpacing', 'bracketSameLine', 'arrowParens', 'proseWrap', 'htmlWhitespaceSensitivity',
  'vueIndentScriptAndStyle', 'embeddedLanguageFormatting', 'singleAttributePerLine', 'objectWrap',
  'experimentalTernaries', 'experimentalOperatorPosition', 'phpVersion', 'trailingCommaPHP', 'braceStyle',
  'xmlWhitespaceSensitivity', 'xmlSelfClosingSpace', 'xmlQuoteAttributes', 'xmlSortAttributesByKey', 'bracketSameLine',
]; // prettier-ignore

/** Defaults applied under the user's explicit options. */
function languageDefaults(lang: LanguageInfo): FormatOptions {
  switch (lang.id) {
    case 'php':
      // PSR-12 / PER-CS: 4 spaces, braces on their own line for classes and methods.
      // ('psr-2' is a deprecated alias of 'per-cs' in @prettier/plugin-php.)
      return { tabWidth: 4, singleQuote: true, phpVersion: '8.3', braceStyle: 'per-cs' };
    case 'markdown':
      return { proseWrap: 'preserve', embeddedLanguageFormatting: 'off' };
    case 'xml':
      // 'strict' would refuse to re-indent anything containing text nodes.
      return { xmlWhitespaceSensitivity: 'preserve' };
    default:
      return {};
  }
}

function prettierOptions(lang: LanguageInfo, user: FormatOptions | undefined, parser?: string): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...languageDefaults(lang) };
  // Most JSONC consumers (VS Code settings aside) reject trailing commas.
  if (parser === 'jsonc') merged.trailingComma = 'none';
  for (const k of PRETTIER_KEYS) if (user?.[k] !== undefined && user[k] !== null) merged[k] = user[k];
  if (merged.braceStyle === 'psr-2') merged.braceStyle = 'per-cs';
  if (lang.id === 'markdown') {
    // Prettier pads list markers to the tab width ("-   item"); that is never what a note wants.
    merged.tabWidth = 2;
    merged.useTabs = false;
    merged.embeddedLanguageFormatting = 'off'; // code blocks are handled by formatCodeBlocks
  }
  merged.endOfLine = 'lf';
  return merged;
}

// ---------- error mapping ----------

function issueFrom(err: unknown, lang: LanguageInfo): FormatIssue {
  const e = (err ?? {}) as any;
  const raw = String(e.message ?? e.text ?? err);
  const first = raw.split('\n')[0];
  let line: number | undefined;
  let col: number | undefined;
  let m: RegExpExecArray | null;
  if ((m = /\((\d+):(\d+)\)\s*$/.exec(first))) {
    line = +m[1];
    col = +m[2];
  } else if ((m = /at line (\d+) column (\d+)/.exec(first))) {
    line = +m[1];
    col = +m[2];
  } else if (e.loc?.start && Number.isFinite(e.loc.start.line)) {
    line = e.loc.start.line;
    // php-parser reports 0-based columns
    col = Number.isFinite(e.loc.start.column) ? e.loc.start.column + (lang.id === 'php' ? 1 : 0) : undefined;
  } else if ((m = /on line (\d+)/.exec(first))) {
    line = +m[1];
  } else {
    const pos = e.pos ?? e.Pos;
    const l = pos?.line ?? pos?.Line;
    const c = pos?.col ?? pos?.Col ?? pos?.column;
    if (Number.isFinite(l)) {
      line = l;
      col = Number.isFinite(c) ? c : undefined;
    }
  }
  const syntax = line !== undefined || e.name === 'SyntaxError' || /parse error|syntax error|unexpected|expecting/i.test(first) || 'incomplete' in e;
  let msg = first
    .replace(/\s*\((?:\d+|NaN):(?:\d+|NaN)\)\s*$/, '')
    .replace(/^Parse Error\s*:\s*/i, '')
    .replace(/^syntax error,\s*/i, '')
    .replace(/\s+on line \d+$/, '')
    .replace(/^Parse error at token: «EOF».*$/, 'unexpected end of input')
    .replace(/^Parse error:\s*/, '')
    .replace(/\s+at line \d+ column \d+\.?$/, '')
    .trim();
  if (msg.length > 160) msg = msg.slice(0, 157) + '…';
  if (!syntax) return { kind: 'internal', language: lang.id, message: `${lang.name} formatter failed: ${msg}` };
  const where = line !== undefined ? ` at ${line}${col !== undefined ? `:${col}` : ''}` : '';
  return { kind: 'syntax', language: lang.id, line, col, message: `${lang.name} syntax error${where}: ${msg}` };
}

// ---------- individual formatters ----------

interface Formatted {
  text: string;
  cursorOffset?: number;
}

async function runPrettier(text: string, fmt: FormatterInfo, opts: Record<string, unknown>, cursor: number | undefined): Promise<Formatted> {
  const [prettier, plugins] = await Promise.all([import('prettier/standalone'), loadPlugins(fmt.parser === 'vue' ? 'vue' : fmt.plugin)]);
  const options = { ...opts, parser: fmt.parser, plugins };
  if (cursor !== undefined) {
    try {
      const r = await prettier.formatWithCursor(text, { ...options, cursorOffset: Math.min(cursor, text.length) });
      return { text: r.formatted, cursorOffset: r.cursorOffset >= 0 ? r.cursorOffset : undefined };
    } catch (err) {
      // Some plugins can't track a cursor; a real syntax error will throw again below.
      if ((err as any)?.loc || (err as any)?.name === 'SyntaxError') throw err;
    }
  }
  return { text: await prettier.format(text, options) };
}

async function formatPhp(text: string, fmt: FormatterInfo, opts: Record<string, unknown>, cursor: number | undefined, snippet: boolean): Promise<Formatted> {
  // A snippet without an open tag would be treated as inline HTML and returned untouched.
  const TAG = '<?php\n';
  const wrap = snippet && !/<\?(?:php|=)/i.test(text);
  const r = await runPrettier(wrap ? TAG + text : text, fmt, opts, cursor === undefined ? undefined : cursor + (wrap ? TAG.length : 0));
  if (!wrap) return r;
  const lead = /^<\?php\n+/.exec(r.text)?.[0].length ?? 0;
  return { text: r.text.slice(lead), cursorOffset: r.cursorOffset === undefined ? undefined : Math.max(0, r.cursorOffset - lead) };
}

async function formatSql(text: string, fmt: FormatterInfo, user: FormatOptions | undefined): Promise<Formatted> {
  const { format } = await import('sql-formatter');
  const language = user?.sqlDialect ? sqlDialectFor(String(user.sqlDialect)) : fmt.dialect ?? 'sql';
  const out = format(text, {
    language,
    keywordCase: user?.sqlKeywordCase ?? 'upper',
    tabWidth: typeof user?.tabWidth === 'number' ? user.tabWidth : 2,
    useTabs: user?.useTabs === true,
    linesBetweenQueries: 1,
  });
  return { text: out.replace(/\s*$/, '\n') };
}

async function formatShell(text: string, user: FormatOptions | undefined, path: string | undefined): Promise<Formatted> {
  const sh = await import('sh-syntax');
  const tabWidth = typeof user?.tabWidth === 'number' ? user.tabWidth : 2;
  const print = sh.print as unknown as (t: string, o: Record<string, unknown>) => Promise<string>;
  const out = await print(text, { originalText: text, filepath: path, useTabs: user?.useTabs === true, tabWidth, indent: user?.useTabs === true ? 0 : tabWidth });
  return { text: out.replace(/\s*$/, '\n') };
}

// ---------- entry point ----------

function resolveFormatter(req: FormatRequest): { lang: LanguageInfo | null; fmt: FormatterInfo | null } {
  if (req.lang) {
    const fmt = formatterForFence(req.lang);
    return { fmt, lang: fmt?.language ?? languageById(req.lang.trim().split(/\s/)[0] ?? '') };
  }
  if (req.path) return { fmt: formatterForPath(req.path), lang: languageForPath(req.path) };
  return { fmt: null, lang: null };
}

/** True when `formatText` can do something for this path / language. */
export function canFormat(req: { path?: string; lang?: string }): boolean {
  return resolveFormatter(req).fmt !== null;
}

/**
 * Formats `text` as the language implied by `lang` (id or fence alias) or `path`.
 * Never throws: unsupported languages come back untouched (`supported: false`), syntax errors
 * as `error` with a 1-based line/col. Output always uses LF line endings.
 */
export async function formatText(input: string, req: FormatRequest = {}): Promise<FormatResult> {
  const text = input.includes('\r') ? input.replace(/\r\n?/g, '\n') : input;
  const { lang, fmt } = resolveFormatter(req);
  if (!lang || !fmt) return { text: input, changed: false, language: lang?.id ?? null, supported: false };

  const done = (out: Formatted, extra?: Partial<FormatResult>): FormatResult => {
    const res: FormatResult = { text: out.text, changed: out.text !== input, language: lang.id, supported: true, ...extra };
    if (req.cursorOffset !== undefined) res.cursorOffset = Math.min(out.cursorOffset ?? mapCursor(text, out.text, req.cursorOffset), out.text.length);
    return res;
  };
  const fail = (error: FormatIssue): FormatResult => ({ text: input, changed: false, language: lang.id, supported: true, error, cursorOffset: req.cursorOffset });

  try {
    if (lang.id === 'markdown') return await formatMarkdown(text, req, lang, fmt, done, fail);
    if (text.trim() === '') return done({ text });
    let out: Formatted;
    if (lang.id === 'sql') out = await formatSql(text, fmt, req.options);
    else if (lang.id === 'shell') out = await formatShell(text, req.options, req.path);
    else if (lang.id === 'php') out = await formatPhp(text, fmt, prettierOptions(lang, req.options), req.cursorOffset, !!req.snippet);
    else out = await runPrettier(text, fmt, prettierOptions(lang, req.options, fmt.parser), req.cursorOffset);
    if (out.text.includes('\r')) out = { text: out.text.replace(/\r\n?/g, '\n') };
    // A formatter must never eat the document.
    if (out.text.trim() === '') return fail({ kind: 'internal', language: lang.id, message: `${lang.name} formatter produced no output (left unchanged)` });
    return done(out);
  } catch (err) {
    return fail(issueFrom(err, lang));
  }
}

async function formatMarkdown(
  text: string,
  req: FormatRequest,
  lang: LanguageInfo,
  fmt: FormatterInfo,
  done: (out: Formatted, extra?: Partial<FormatResult>) => FormatResult,
  fail: (e: FormatIssue) => FormatResult,
): Promise<FormatResult> {
  const mode = req.mode ?? 'document';
  let current = text;
  if (mode === 'document' && text.trim() !== '') {
    const shield = protectObsidian(text);
    const pretty = await runPrettier(shield.text, fmt, prettierOptions(lang, req.options), undefined);
    const restored = shield.restore(pretty.text);
    if (restored === null) return fail({ kind: 'internal', language: lang.id, message: 'Markdown formatter could not preserve Obsidian syntax (left unchanged)' });
    current = restored;
  }
  if (mode === 'document' && req.options?.markdownCodeBlocks === false) return done({ text: current });

  // Nested notes are left alone: re-flowing markdown inside a code sample is never wanted.
  const blockFormat = (code: string, info: string) => {
    const f = formatterForFence(info);
    if (!f || f.language.id === 'markdown') return Promise.resolve<FormatResult>({ text: code, changed: false, language: null, supported: false });
    return formatText(code, { lang: info, options: req.options, snippet: true });
  };
  const r = await formatCodeBlocks(current, blockFormat, mode === 'block' ? req.cursorOffset ?? 0 : undefined);
  if (r.noBlock) return fail({ kind: 'no-block', language: lang.id, message: 'No code block at the cursor' });
  if (mode === 'block' && !r.candidates) return fail({ kind: 'unsupported', language: lang.id, message: 'No formatter for the language of this code block' });
  if (mode === 'block' && r.warnings.length && !r.formatted) return fail(r.warnings[0]);
  return done({ text: r.text }, { warnings: r.warnings.length ? r.warnings : undefined, blocksFormatted: r.formatted });
}
