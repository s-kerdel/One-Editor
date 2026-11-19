// Smart paste (pure detectors + transforms; unit-tested). Given pasted text (and VS Code's clipboard
// language, if any), offers "Paste as…" options: JSON → ```json, curl → formatted / as a {{template}},
// stack traces → ```log (file:line links), CSV/TSV/Excel cells → table, SQL → formatted ```sql,
// VS Code code → fenced with its language, secret-looking text → replace with {{variable}}.

export interface TemplateValue {
  name: string;
  value: string;
  secret: boolean;
}

export interface PasteOption {
  id: 'json' | 'curl' | 'curl-template' | 'log' | 'table' | 'sql' | 'code' | 'secret';
  label: string;
  /** Replacement text (sql: computed on pick, see transformSql). */
  text?: string;
  /** curl-template / secret: values to put into variables.md (secrets → vault). */
  values?: TemplateValue[];
  warn?: boolean;
}

const fence = (lang: string, body: string) => `\`\`\`${lang}\n${body.replace(/\s+$/, '')}\n\`\`\``;

// ---- JSON -----------------------------------------------------------------------------------------

export function asJson(text: string): string | null {
  const t = text.trim();
  if (t.length < 2 || !/^[[{]/.test(t) || !/[\]}]$/.test(t)) return null;
  try {
    const v = JSON.parse(t);
    if (typeof v !== 'object' || v === null) return null;
    return fence('json', JSON.stringify(v, null, 2));
  } catch {
    return null;
  }
}

// ---- curl -----------------------------------------------------------------------------------------

/** Shell-like words (quotes kept, so the output stays a valid command). Line continuations are joined. */
export function shellWords(cmd: string): string[] {
  const s = cmd.replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ').replace(/`\r?\n/g, ' ');
  const out: string[] = [];
  let cur = '';
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      cur += c;
      if (c === '\\' && q === '"' && i + 1 < s.length) cur += s[++i];
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (/\s/.test(c)) {
      if (cur) out.push(cur), (cur = '');
    } else if (c === '\\' && i + 1 < s.length) cur += c + s[++i];
    else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

const unq = (w: string) => (/^(['"]).*\1$/s.test(w) ? w.slice(1, -1) : w);
/** Flags whose next word is their value (kept on one line with it). */
const CURL_ARG = new Set(['-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--json', '-u', '--user', '-b', '--cookie', '-F', '--form', '-o', '--output', '-A', '--user-agent', '-e', '--referer', '--url', '-x', '--proxy', '--connect-timeout', '-m', '--max-time', '--cacert', '--cert', '--key', '-w', '--write-out']);

export function isCurl(text: string): boolean {
  return /^\s*curl(?:\.exe)?\s+\S/.test(text) && text.length < 20_000;
}

/** curl one-liner → one flag per line with ` \` continuations. */
export function formatCurl(text: string): string {
  const words = shellWords(text.trim());
  const lines: string[] = [words[0]];
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (CURL_ARG.has(w) && i + 1 < words.length) lines.push(`${w} ${words[++i]}`);
    else lines.push(w);
  }
  return lines.map((l, i) => (i === 0 ? l : `  ${l}`)).join(' \\\n');
}

const quoteLike = (orig: string, inner: string) => (orig.startsWith("'") ? `'${inner}'` : orig.startsWith('"') ? `"${inner}"` : inner);
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/** curl → template: host, tokens, credentials, cookies, API keys and obvious ids become {{placeholders}}. */
export function curlTemplate(text: string): { text: string; values: TemplateValue[] } {
  const words = shellWords(text.trim());
  const values: TemplateValue[] = [];
  const add = (name: string, value: string, secret: boolean): string => {
    const hit = values.find((v) => v.value === value);
    if (hit) return `{{${hit.name}}}`;
    let n = name;
    for (let k = 2; values.some((v) => v.name === n); k++) n = `${name}${k}`;
    values.push({ name: n, value, secret });
    return `{{${n}}}`;
  };
  const url = (w: string): string => {
    const raw = unq(w);
    const m = /^(https?:\/\/)([^/?#:]+)(:\d+)?([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(raw);
    if (!m) return w;
    const host = add('host', m[2], false);
    let pathPart = m[4] ?? '';
    // Ids in path order: UUIDs and long numbers are per-request values, not part of the endpoint.
    pathPart = pathPart
      .split('/')
      .map((seg) => (new RegExp(`^${UUID.source}$`, 'i').test(seg) || /^\d{4,}$/.test(seg) ? add('id', seg, false) : seg))
      .join('/');
    const query = (m[5] ?? '').replace(/([?&](?:api[_-]?key|apikey|key|token|access_token|secret|sig|signature)=)([^&#]+)/gi, (_a, k: string, v: string) => `${k}${add(/token/i.test(k) ? 'token' : 'api_key', decodeURIComponent(v), true)}`);
    return quoteLike(w, `${m[1]}${host}${m[3] ?? ''}${pathPart}${query}${m[6] ?? ''}`);
  };
  const header = (w: string): string => {
    const raw = unq(w);
    const m = /^([\w-]+):\s*(.*)$/s.exec(raw);
    if (!m) return w;
    const [, name, val] = m;
    const lower = name.toLowerCase();
    if (lower === 'authorization') {
      const b = /^(Bearer|Token|Basic)\s+(.+)$/i.exec(val);
      return quoteLike(w, `${name}: ${b ? `${b[1]} ${add(b[1].toLowerCase() === 'basic' ? 'basic_auth' : 'token', b[2], true)}` : add('auth', val, true)}`);
    }
    if (lower === 'cookie') return quoteLike(w, `${name}: ${add('cookie', val, true)}`);
    if (/api[-_]?key|token|secret|auth/.test(lower)) return quoteLike(w, `${name}: ${add(lower.includes('token') ? 'token' : 'api_key', val, true)}`);
    if (lower === 'host') return quoteLike(w, `${name}: ${add('host', val, false)}`);
    return w;
  };
  const out: string[] = [words[0]];
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    if ((w === '-H' || w === '--header') && next !== undefined) out.push(w, header(next)), i++;
    else if ((w === '-u' || w === '--user') && next !== undefined) {
      const [u, ...p] = unq(next).split(':');
      out.push(w, quoteLike(next, p.length ? `${add('user', u, false)}:${add('password', p.join(':'), true)}` : add('user', u, false)));
      i++;
    } else if ((w === '-b' || w === '--cookie') && next !== undefined) out.push(w, quoteLike(next, add('cookie', unq(next), true))), i++;
    else if (w === '--url' && next !== undefined) out.push(w, url(next)), i++;
    else if (CURL_ARG.has(w) && next !== undefined) out.push(w, next), i++;
    else if (/^['"]?https?:\/\//i.test(w)) out.push(url(w));
    else out.push(w);
  }
  return { text: formatCurl(out.join(' ')), values };
}

// ---- stack traces / compiler output ----------------------------------------------------------------

const TRACE_LINE = [
  /^\s+at .+[(\s][^()\s]+:\d+(?::\d+)?\)?\s*$/, // JS / Java-ish
  /^\s*File ".+", line \d+/, // Python
  /^[^\s:][^:]*\.\w{1,6}[:(]\d+(?:[:,]\s*\d+)?\)?:?\s*(?:error|warning|note|fatal)\b/i, // gcc / tsc / msbuild
  /^\s*(?:PHP )?(?:Fatal error|Warning|Notice|Parse error):.+ on line \d+/i,
  /^\s*#\d+ .+\.\w{1,6}\(\d+\)/, // PHP stack frames
  /^[^\s:]+\.\w{1,6}:\d+:\d+:/, // eslint / rustc short
  /^\s*--> [^\s:]+:\d+:\d+/, // rustc
];

export function isTrace(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2 || lines.length > 2000) return false;
  const hits = lines.filter((l) => TRACE_LINE.some((re) => re.test(l))).length;
  return hits >= 2 || (hits >= 1 && /\b(?:Error|Exception|Traceback)\b/.test(lines[0]));
}

// ---- CSV / TSV / spreadsheet cells -------------------------------------------------------------------

export function splitDelimited(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"' && !cur.trim()) q = true;
    else if (c === delim) out.push(cur), (cur = '');
    else cur += c;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/** Rows of a delimited block when every row has the same (≥ 2) number of cells; tab beats ; beats ,. */
export function delimitedRows(text: string): string[][] | null {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  if (lines.length < 2 || lines.length > 5000 || lines.some((l) => !l.trim())) return null;
  for (const d of ['\t', ';', ',']) {
    if (!lines.every((l) => l.includes(d))) continue;
    const rows = lines.map((l) => splitDelimited(l, d));
    const n = rows[0].length;
    if (n >= 2 && rows.every((r) => r.length === n)) {
      // Prose with commas is not a table: cells should be short-ish.
      if (d === ',' && rows.some((r) => r.some((c) => c.length > 80 || /\.\s/.test(c)))) continue;
      return rows;
    }
  }
  return null;
}

export function toMarkdownTable(rows: string[][]): string {
  const esc = (c: string) => c.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const [head, ...body] = rows;
  return [`| ${head.map(esc).join(' | ')} |`, `|${head.map(() => ' --- ').join('|')}|`, ...body.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n');
}

// ---- SQL ---------------------------------------------------------------------------------------------

export function isSql(text: string): boolean {
  const t = text.trim();
  if (t.length < 12 || t.length > 100_000) return false;
  return /^(?:select\s[\s\S]+\sfrom\s|insert\s+into\s|update\s+\S+\s+set\s|delete\s+from\s|with\s+\w+\s+as\s*\(|create\s+(?:or\s+replace\s+)?(?:table|view|index|function|procedure)\s|alter\s+table\s|drop\s+(?:table|view|index)\s)/i.test(t);
}

export async function transformSql(text: string, keywordCase: 'upper' | 'lower' | 'preserve' = 'upper'): Promise<string> {
  try {
    const { format } = await import('sql-formatter');
    return fence('sql', format(text.trim(), { language: 'sql', keywordCase, tabWidth: 2 }));
  } catch {
    return fence('sql', text.trim());
  }
}

// ---- VS Code -----------------------------------------------------------------------------------------

const VSCODE_LANG: Record<string, string> = { shellscript: 'bash', plaintext: '', typescriptreact: 'tsx', javascriptreact: 'jsx', csharp: 'csharp', dockerfile: 'dockerfile', powershell: 'powershell', bat: 'bat' };

/** VS Code puts `{"mode":"typescript",…}` in the `vscode-editor-data` clipboard type. */
export function vscodeLanguage(data: string | null | undefined): string | null {
  if (!data) return null;
  try {
    const mode = (JSON.parse(data) as { mode?: unknown }).mode;
    if (typeof mode !== 'string' || !/^[\w#+.-]{1,40}$/.test(mode)) return null;
    return mode in VSCODE_LANG ? VSCODE_LANG[mode] : mode.toLowerCase();
  } catch {
    return null;
  }
}

// ---- secrets -----------------------------------------------------------------------------------------

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, 'private_key'],
  [/\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}\b/, 'jwt'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/, 'aws_key'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, 'github_token'],
  [/\bglpat-[\w-]{20,}\b/, 'gitlab_token'],
  [/\bxox[abposr]-[\w-]{10,}\b/, 'slack_token'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/, 'api_key'],
  [/\bAIza[\w-]{35}\b/, 'api_key'],
];

/** Shannon entropy per char. */
function entropy(s: string): number {
  const f = new Map<string, number>();
  for (const c of s) f.set(c, (f.get(c) ?? 0) + 1);
  let e = 0;
  for (const n of f.values()) e -= (n / s.length) * Math.log2(n / s.length);
  return e;
}

/** A suggested variable name when `text` looks like a secret (token, key, password assignment), else null. */
export function secretKind(text: string): string | null {
  const t = text.trim();
  if (!t || t.length > 10_000) return null;
  for (const [re, name] of SECRET_PATTERNS) if (re.test(t)) return name;
  if (/^(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*\S{6,}$/i.test(t)) return /pass|pwd/i.test(t) ? 'password' : 'token';
  // A single long random-looking word: mixed classes + high entropy.
  if (/^\S{24,200}$/.test(t) && !/^https?:\/\//i.test(t) && !/[\\/]/.test(t.slice(0, 3)) && /[a-z]/.test(t) && /[A-Z0-9]/.test(t) && entropy(t) > 4) return 'secret';
  return null;
}

/** The value part of a `password=…` style paste (else the whole text). */
export function secretValue(text: string): string {
  const m = /^(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*(\S.*)$/i.exec(text.trim());
  return m ? m[1].trim() : text.trim();
}

// ---- all detectors -----------------------------------------------------------------------------------

export function detectPaste(text: string, o: { vscodeData?: string | null } = {}): PasteOption[] {
  const out: PasteOption[] = [];
  if (!text.trim() || /^\s*(```|~~~)/.test(text)) return out;
  const lang = vscodeLanguage(o.vscodeData);
  if (lang !== null && text.includes('\n')) out.push({ id: 'code', label: lang ? `Code block (${lang})` : 'Code block', text: fence(lang, text) });
  const json = asJson(text);
  if (json) out.push({ id: 'json', label: 'JSON block', text: json });
  if (isCurl(text)) {
    out.push({ id: 'curl', label: 'Formatted curl', text: fence('bash', formatCurl(text)) });
    const t = curlTemplate(text);
    if (t.values.length) out.push({ id: 'curl-template', label: 'curl as template', text: fence('bash', t.text), values: t.values });
  }
  if (!json && isSql(text)) out.push({ id: 'sql', label: 'Formatted SQL' });
  if (!json && !lang && isTrace(text)) out.push({ id: 'log', label: 'Log block (file:line links)', text: fence('log', text) });
  const rows = !json && !isCurl(text) ? delimitedRows(text) : null;
  if (rows) out.push({ id: 'table', label: 'Markdown table', text: toMarkdownTable(rows) });
  const secret = !isCurl(text) && !text.includes('\n') ? secretKind(text) : null;
  if (secret) out.push({ id: 'secret', label: `Looks like a secret — replace with {{${secret}}}`, text: `{{${secret}}}`, values: [{ name: secret, value: secretValue(text), secret: true }], warn: true });
  return out;
}
