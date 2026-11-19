// Single source of truth for languages: file extension / fence name → ids used by
// CodeMirror (@codemirror/language-data name), Shiki, and Prettier.
// Owned by the format agent; editor + preview consume it. Add entries, don't fork it.
import { basename, extname } from './paths';

export interface LanguageInfo {
  id: string; // canonical id, e.g. 'php'
  name: string; // display name
  aliases: string[]; // fence names: ```sh, ```shell ...
  extensions: string[]; // with dot
  filenames?: string[]; // exact basenames, lowercase (Dockerfile)
  cm?: string; // @codemirror/language-data LanguageDescription name
  shiki?: string; // shiki language id
  prettier?: { parser: string; plugin: string }; // plugin = module key the format worker knows
  /** Fence aliases that must never be auto-formatted (```console is a transcript, not a script). */
  noFormatAliases?: string[];
  comment?: { line?: string; block?: [string, string] };
}

export const LANGUAGES: LanguageInfo[] = [
  { id: 'markdown', name: 'Markdown', aliases: ['md', 'markdown'], extensions: ['.md', '.markdown', '.mdx'], cm: 'Markdown', shiki: 'markdown', prettier: { parser: 'markdown', plugin: 'markdown' } },
  { id: 'php', name: 'PHP', aliases: ['php', 'php8', 'phtml'], extensions: ['.php', '.phtml', '.inc'], cm: 'PHP', shiki: 'php', prettier: { parser: 'php', plugin: 'php' }, comment: { line: '//', block: ['/*', '*/'] } },
  { id: 'blade', name: 'Blade', aliases: ['blade'], extensions: ['.blade.php'], cm: 'PHP', shiki: 'blade' },
  { id: 'javascript', name: 'JavaScript', aliases: ['js', 'javascript', 'node', 'mjs', 'cjs'], extensions: ['.js', '.mjs', '.cjs'], cm: 'JavaScript', shiki: 'javascript', prettier: { parser: 'babel', plugin: 'babel' }, comment: { line: '//', block: ['/*', '*/'] } },
  { id: 'jsx', name: 'JSX', aliases: ['jsx'], extensions: ['.jsx'], cm: 'JSX', shiki: 'jsx', prettier: { parser: 'babel', plugin: 'babel' } },
  { id: 'typescript', name: 'TypeScript', aliases: ['ts', 'typescript', 'mts', 'cts'], extensions: ['.ts', '.mts', '.cts'], cm: 'TypeScript', shiki: 'typescript', prettier: { parser: 'typescript', plugin: 'typescript' }, comment: { line: '//', block: ['/*', '*/'] } },
  { id: 'tsx', name: 'TSX', aliases: ['tsx'], extensions: ['.tsx'], cm: 'TSX', shiki: 'tsx', prettier: { parser: 'typescript', plugin: 'typescript' } },
  { id: 'json', name: 'JSON', aliases: ['json', 'jsonc', 'json5'], extensions: ['.json', '.jsonc', '.json5'], cm: 'JSON', shiki: 'json', prettier: { parser: 'json', plugin: 'babel' } },
  { id: 'css', name: 'CSS', aliases: ['css'], extensions: ['.css'], cm: 'CSS', shiki: 'css', prettier: { parser: 'css', plugin: 'postcss' }, comment: { block: ['/*', '*/'] } },
  { id: 'scss', name: 'SCSS', aliases: ['scss'], extensions: ['.scss'], cm: 'SCSS', shiki: 'scss', prettier: { parser: 'scss', plugin: 'postcss' } },
  { id: 'less', name: 'Less', aliases: ['less'], extensions: ['.less'], cm: 'LESS', shiki: 'less', prettier: { parser: 'less', plugin: 'postcss' } },
  { id: 'html', name: 'HTML', aliases: ['html', 'htm', 'xhtml'], extensions: ['.html', '.htm'], cm: 'HTML', shiki: 'html', prettier: { parser: 'html', plugin: 'html' }, comment: { block: ['<!--', '-->'] } },
  { id: 'vue', name: 'Vue', aliases: ['vue'], extensions: ['.vue'], cm: 'Vue', shiki: 'vue', prettier: { parser: 'vue', plugin: 'html' } },
  { id: 'xml', name: 'XML', aliases: ['xml', 'svg', 'xsl'], extensions: ['.xml', '.svg', '.xsl'], cm: 'XML', shiki: 'xml', prettier: { parser: 'xml', plugin: 'xml' }, comment: { block: ['<!--', '-->'] } },
  { id: 'yaml', name: 'YAML', aliases: ['yaml', 'yml'], extensions: ['.yaml', '.yml'], cm: 'YAML', shiki: 'yaml', prettier: { parser: 'yaml', plugin: 'yaml' }, comment: { line: '#' } },
  { id: 'toml', name: 'TOML', aliases: ['toml'], extensions: ['.toml'], cm: 'TOML', shiki: 'toml', comment: { line: '#' } },
  { id: 'ini', name: 'INI', aliases: ['ini', 'cfg', 'conf', 'properties', 'env', 'dotenv'], extensions: ['.ini', '.cfg', '.conf', '.properties', '.env'], filenames: ['.env'], cm: 'Properties files', shiki: 'ini', comment: { line: '#' } },
  { id: 'sql', name: 'SQL', aliases: ['sql', 'mysql', 'pgsql', 'postgres', 'postgresql', 'sqlite', 'tsql', 'mariadb'], extensions: ['.sql'], cm: 'SQL', shiki: 'sql', prettier: { parser: 'sql', plugin: 'sql-formatter' }, comment: { line: '--', block: ['/*', '*/'] } },
  { id: 'shell', name: 'Shell', aliases: ['sh', 'bash', 'shell', 'zsh', 'console', 'shellscript', 'terminal'], extensions: ['.sh', '.bash', '.zsh'], cm: 'Shell', shiki: 'shellscript', prettier: { parser: 'sh', plugin: 'sh' }, noFormatAliases: ['console', 'terminal'], comment: { line: '#' } },
  { id: 'powershell', name: 'PowerShell', aliases: ['powershell', 'ps1', 'ps', 'pwsh'], extensions: ['.ps1', '.psm1'], cm: 'PowerShell', shiki: 'powershell', comment: { line: '#' } },
  { id: 'bat', name: 'Batch', aliases: ['bat', 'cmd', 'batch'], extensions: ['.bat', '.cmd'], shiki: 'bat' },
  { id: 'dockerfile', name: 'Dockerfile', aliases: ['dockerfile', 'docker'], extensions: ['.dockerfile'], filenames: ['dockerfile'], cm: 'Dockerfile', shiki: 'docker', comment: { line: '#' } },
  { id: 'makefile', name: 'Makefile', aliases: ['make', 'makefile'], extensions: ['.mk'], filenames: ['makefile'], shiki: 'makefile', comment: { line: '#' } },
  { id: 'python', name: 'Python', aliases: ['py', 'python', 'python3'], extensions: ['.py'], cm: 'Python', shiki: 'python', comment: { line: '#' } },
  { id: 'ruby', name: 'Ruby', aliases: ['rb', 'ruby'], extensions: ['.rb'], cm: 'Ruby', shiki: 'ruby', comment: { line: '#' } },
  { id: 'go', name: 'Go', aliases: ['go', 'golang'], extensions: ['.go'], cm: 'Go', shiki: 'go', comment: { line: '//' } },
  { id: 'rust', name: 'Rust', aliases: ['rs', 'rust'], extensions: ['.rs'], cm: 'Rust', shiki: 'rust', comment: { line: '//' } },
  { id: 'java', name: 'Java', aliases: ['java'], extensions: ['.java'], cm: 'Java', shiki: 'java', comment: { line: '//' } },
  { id: 'kotlin', name: 'Kotlin', aliases: ['kt', 'kotlin'], extensions: ['.kt', '.kts'], cm: 'Kotlin', shiki: 'kotlin', comment: { line: '//' } },
  { id: 'csharp', name: 'C#', aliases: ['cs', 'csharp', 'c#'], extensions: ['.cs'], cm: 'C#', shiki: 'csharp', comment: { line: '//' } },
  { id: 'c', name: 'C', aliases: ['c', 'h'], extensions: ['.c', '.h'], cm: 'C', shiki: 'c', comment: { line: '//' } },
  { id: 'cpp', name: 'C++', aliases: ['cpp', 'c++', 'cc', 'cxx', 'hpp'], extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh'], cm: 'C++', shiki: 'cpp', comment: { line: '//' } },
  { id: 'swift', name: 'Swift', aliases: ['swift'], extensions: ['.swift'], cm: 'Swift', shiki: 'swift', comment: { line: '//' } },
  { id: 'lua', name: 'Lua', aliases: ['lua'], extensions: ['.lua'], cm: 'Lua', shiki: 'lua', comment: { line: '--' } },
  { id: 'perl', name: 'Perl', aliases: ['pl', 'perl'], extensions: ['.pl', '.pm'], cm: 'Perl', shiki: 'perl', comment: { line: '#' } },
  { id: 'r', name: 'R', aliases: ['r'], extensions: ['.r'], cm: 'R', shiki: 'r', comment: { line: '#' } },
  { id: 'dart', name: 'Dart', aliases: ['dart'], extensions: ['.dart'], cm: 'Dart', shiki: 'dart', comment: { line: '//' } },
  { id: 'graphql', name: 'GraphQL', aliases: ['graphql', 'gql'], extensions: ['.graphql', '.gql'], shiki: 'graphql', prettier: { parser: 'graphql', plugin: 'graphql' }, comment: { line: '#' } },
  { id: 'nginx', name: 'Nginx', aliases: ['nginx'], extensions: [], cm: 'Nginx', shiki: 'nginx', comment: { line: '#' } },
  { id: 'diff', name: 'Diff', aliases: ['diff', 'patch'], extensions: ['.diff', '.patch'], cm: 'Diff', shiki: 'diff' },
  { id: 'twig', name: 'Twig', aliases: ['twig'], extensions: ['.twig'], shiki: 'twig' },
  { id: 'apache', name: 'Apache conf', aliases: ['apache', 'htaccess'], extensions: ['.htaccess'], filenames: ['.htaccess'], shiki: 'apache', comment: { line: '#' } },
  { id: 'mermaid', name: 'Mermaid', aliases: ['mermaid'], extensions: ['.mmd'], shiki: 'mermaid' },
  { id: 'text', name: 'Plain text', aliases: ['text', 'txt', 'plain', 'plaintext'], extensions: ['.txt', '.log'] },
];

const byAlias = new Map<string, LanguageInfo>();
const byExt = new Map<string, LanguageInfo>();
const byFilename = new Map<string, LanguageInfo>();
for (const l of LANGUAGES) {
  byAlias.set(l.id, l);
  l.aliases.forEach((a) => byAlias.set(a.toLowerCase(), l));
  l.extensions.forEach((e) => byExt.set(e, l));
  l.filenames?.forEach((f) => byFilename.set(f, l));
}

/** Language for a fenced code block info string ("php", "bash title=x" → first word). */
export function languageForFence(info: string): LanguageInfo | null {
  const word = info.trim().split(/[\s{]/)[0]?.toLowerCase().replace(/^\./, '') ?? '';
  return word ? byAlias.get(word) ?? null : null;
}

/** Language for a workspace path (handles compound extensions like .blade.php). */
export function languageForPath(path: string): LanguageInfo | null {
  const name = basename(path).toLowerCase();
  if (name.endsWith('.blade.php')) return byAlias.get('blade')!;
  return byFilename.get(name) ?? byExt.get(extname(name)) ?? null;
}

export function languageById(id: string): LanguageInfo | null {
  return byAlias.get(id.toLowerCase()) ?? null;
}

// ---------- formatting lookups (consumed by src/format) ----------

export type SqlDialect = 'sql' | 'mysql' | 'mariadb' | 'postgresql' | 'sqlite' | 'transactsql';

const SQL_DIALECTS: Record<string, SqlDialect> = {
  mysql: 'mysql',
  mariadb: 'mariadb',
  pgsql: 'postgresql',
  postgres: 'postgresql',
  postgresql: 'postgresql',
  sqlite: 'sqlite',
  tsql: 'transactsql',
  mssql: 'transactsql',
  transactsql: 'transactsql',
};

/** sql-formatter dialect for a fence alias / dialect name ("pgsql" → "postgresql"); unknown → "sql". */
export function sqlDialectFor(alias: string | undefined | null): SqlDialect {
  return (alias && SQL_DIALECTS[alias.toLowerCase()]) || 'sql';
}

// Aliases/extensions whose Prettier parser differs from the language default.
const PARSER_VARIANTS: Record<string, string> = { json5: 'json5', jsonc: 'jsonc', mdx: 'mdx' };

export interface FormatterInfo {
  language: LanguageInfo;
  parser: string;
  plugin: string;
  /** Only for SQL. */
  dialect?: SqlDialect;
}

function formatterFor(l: LanguageInfo | null, hint: string): FormatterInfo | null {
  if (!l?.prettier) return null;
  if (l.noFormatAliases?.includes(hint)) return null;
  const info: FormatterInfo = { language: l, parser: PARSER_VARIANTS[hint] ?? l.prettier.parser, plugin: l.prettier.plugin };
  if (l.id === 'sql') info.dialect = sqlDialectFor(hint);
  return info;
}

/** First word of a fence info string, lowercased ("PHP title=x" → "php"). */
export function fenceAlias(info: string): string {
  return info.trim().split(/[\s{,:]/)[0]?.toLowerCase().replace(/^\./, '') ?? '';
}

/** Formatter for a fence info string or language id/alias; null when the language can't be formatted. */
export function formatterForFence(info: string): FormatterInfo | null {
  const alias = fenceAlias(info);
  return formatterFor(alias ? byAlias.get(alias) ?? null : null, alias);
}

/** Formatter for a workspace path; null when the file type can't be formatted. */
export function formatterForPath(path: string): FormatterInfo | null {
  return formatterFor(languageForPath(path), extname(basename(path).toLowerCase()).slice(1));
}
