// Write-back into variables.md / a note's frontmatter (pure, unit-tested). Edits are minimal text
// changes so comments, order and formatting survive: an existing value is replaced in place; a new key
// is inserted as one line into its block map; only when a parent map is missing does the yaml Document
// API rebuild that YAML block (it keeps comments too).
import { parse as parseYaml, parseDocument, isMap, isScalar, isSeq, stringify, Scalar, type YAMLMap, type YAMLSeq } from 'yaml';
import { findYamlRegion, frontmatterRegion, type YamlRegion } from './parse';

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

/** A YAML scalar for `value` in the style of `like` (plain when that still reads back as the same text). */
export function formatYamlScalar(value: string, like?: Scalar.Type | string | null): string {
  if (like === 'QUOTE_DOUBLE') return JSON.stringify(value);
  if (like === 'QUOTE_SINGLE') return `'${value.replace(/'/g, "''")}'`;
  // yes/no/on/off: booleans for YAML 1.1 tools (Ansible…) even though our parser reads them as text.
  let plainOk = !/^(?:y|n|yes|no|on|off|true|false|null|~)$/i.test(value) && value !== '' && !/[\n\r]/.test(value) && !/^\s|\s$/.test(value) && !/:\s|\s#|^[-?:,[\]{}#&*!|>'"%@`]/.test(value) && !/:$/.test(value);
  if (plainOk) {
    try {
      const back = parseYaml(value);
      plainOk = (typeof back === 'string' || typeof back === 'number' || typeof back === 'boolean') && String(back) === value && !(typeof back === 'boolean');
    } catch {
      plainOk = false;
    }
  }
  return plainOk ? value : JSON.stringify(value);
}

const lineEnd = (text: string, pos: number) => {
  const nl = text.indexOf('\n', pos);
  return nl < 0 ? text.length : nl;
};
const lineStart = (text: string, pos: number) => text.lastIndexOf('\n', pos - 1) + 1;

function regionFor(text: string, where: 'file' | 'note'): YamlRegion | null {
  return where === 'note' ? frontmatterRegion(text) : findYamlRegion(text);
}

/**
 * Sets the scalar at `path` (e.g. ['envs','lab','vars','ns']) to `value`.
 * `where`: 'file' = variables.md (first ```yaml fence), 'note' = the note's frontmatter.
 * Returns the edit, or null when nothing changes.
 */
export function setValue(text: string, where: 'file' | 'note', path: string[], value: string): TextChange | null {
  const region = regionFor(text, where);
  if (!region) return where === 'file' ? newBlock(text, path, value) : newFrontmatter(text, path, value);
  const yamlText = text.slice(region.from, region.to);
  const doc = parseDocument(yamlText, { uniqueKeys: false });
  if (doc.errors.length) throw new Error(`Fix the YAML first: ${doc.errors[0].message.split('\n')[0]}`);
  const node = doc.getIn(path, true);
  if (isScalar(node) && node.range) {
    const from = region.from + node.range[0];
    const to = region.from + node.range[1];
    // `key:` with no value yet parses as an empty scalar right after the colon.
    const insert = (from === to && text[from - 1] === ':' ? ' ' : '') + formatYamlScalar(value, node.type);
    return text.slice(from, to) === insert ? null : { from, to, insert };
  }
  if (node !== undefined && node !== null && !isScalar(node)) throw new Error(`${path.join('.')} is a map or list, not a value`);
  return insertDeep(text, region, doc, path, formatYamlScalar(value)) ?? rebuild(text, region, doc, (d) => d.setIn(path, value));
}

/** Adds `name` to the `secrets:` list at `listPath` (default top-level) unless it is already there. */
export function addSecretName(text: string, name: string, listPath: string[] = ['secrets']): TextChange | null {
  const region = findYamlRegion(text);
  if (!region) return newBlock(text, listPath, null, name);
  const doc = parseDocument(text.slice(region.from, region.to), { uniqueKeys: false });
  if (doc.errors.length) throw new Error(`Fix the YAML first: ${doc.errors[0].message.split('\n')[0]}`);
  const seq = doc.getIn(listPath, true);
  if (isSeq(seq)) {
    const items = (seq as YAMLSeq).items;
    if (items.some((it) => isScalar(it) && String(it.value) === name)) return null;
    const last = items[items.length - 1];
    if (isScalar(last) && last.range && seq.range) {
      if ((seq as YAMLSeq).flow) return { from: region.from + last.range[1], to: region.from + last.range[1], insert: `, ${formatYamlScalar(name)}` };
      const ls = lineStart(text, region.from + last.range[0]);
      const indent = text.slice(ls, region.from + last.range[0]).replace(/[^\s-]/g, ' ');
      const at = lineEnd(text, region.from + last.range[1]);
      return { from: at, to: at, insert: `\n${indent}${formatYamlScalar(name)}` };
    }
  }
  if (seq == null) {
    const ins = insertDeep(text, region, doc, listPath, `[${formatYamlScalar(name)}]`);
    if (ins) return ins;
  }
  return rebuild(text, region, doc, (d) => {
    const cur = d.getIn(listPath);
    if (cur == null) d.setIn(listPath, d.createNode([name], { flow: true }));
    else d.addIn(listPath, name);
  });
}

/**
 * Minimal insertion of `path: leaf` under the deepest map of `path` that exists: new lines after its
 * last item (block map, at its indentation, nested keys indented by two), or `, key: leaf` before the
 * `}` of a one-level flow map. null when that isn't possible (empty / flow parent of a deep path).
 */
function insertDeep(text: string, region: YamlRegion, doc: ReturnType<typeof parseDocument>, path: string[], leaf: string): TextChange | null {
  let k = path.length - 1;
  let node: unknown = null;
  for (; k >= 0; k--) {
    node = k === 0 ? doc.contents : doc.getIn(path.slice(0, k), true);
    if (isMap(node)) break;
    if (node != null && !(isScalar(node) && node.value == null)) return null; // a value is in the way
  }
  if (k < 0 || !isMap(node)) return null;
  const map = node as YAMLMap;
  const rest = path.slice(k);
  // `key:` that exists with no value: fill it in right after the colon.
  const existing = map.items.find((p) => isScalar(p.key) && String(p.key.value) === rest[0]);
  if (existing) {
    if (rest.length !== 1 || !isScalar(existing.key) || !existing.key.range) return null;
    const colon = text.indexOf(':', region.from + existing.key.range[1]);
    return colon < 0 ? null : { from: colon + 1, to: colon + 1, insert: ` ${leaf}` };
  }
  if (map.flow) {
    if (rest.length !== 1 || !map.range) return null;
    const close = text.lastIndexOf('}', region.from + map.range[1]);
    if (close < region.from) return null;
    const pad = text[close - 1] === ' ' ? '' : ' ';
    return { from: close - (pad ? 0 : 1), to: close - (pad ? 0 : 1), insert: `${map.items.length ? ',' : ''} ${formatYamlScalar(rest[0])}: ${leaf}${pad}` };
  }
  if (!map.items.length) return null;
  const first = map.items[0].key as Scalar;
  const last = map.items[map.items.length - 1];
  const keyStart = region.from + (first.range?.[0] ?? 0);
  const indent = keyStart - lineStart(text, keyStart);
  const lastEnd = region.from + ((last.value as Scalar | null)?.range?.[1] ?? (last.key as Scalar).range?.[1] ?? 0);
  const at = lineEnd(text, Math.max(lastEnd - 1, keyStart));
  const lines = rest.map((seg, i) => `${' '.repeat(indent + 2 * i)}${formatYamlScalar(seg)}:${i === rest.length - 1 ? ` ${leaf}` : ''}`);
  return { from: at, to: at, insert: `\n${lines.join('\n')}` };
}

/** Regenerates the YAML block with the Document API (comments survive), as one change. */
function rebuild(text: string, region: YamlRegion, doc: ReturnType<typeof parseDocument>, edit: (d: ReturnType<typeof parseDocument>) => void): TextChange {
  if (doc.contents == null) doc.contents = doc.createNode({}) as never;
  edit(doc);
  let out = stringify(doc, { lineWidth: 0, flowCollectionPadding: false });
  if (region.to > region.from && !text.slice(region.from, region.to).endsWith('\n')) out = out.replace(/\n$/, '');
  return { from: region.from, to: region.to, insert: out };
}

function nested(path: string[], leaf: unknown): Record<string, unknown> {
  let obj: unknown = leaf;
  for (let i = path.length - 1; i >= 0; i--) obj = { [path[i]]: obj };
  return obj as Record<string, unknown>;
}

/** variables.md without a ```yaml block yet: append one. */
function newBlock(text: string, path: string[], value: string | null, secret?: string): TextChange {
  const data = secret ? nested(path, [secret]) : nested(path, value);
  const yaml = stringify(data, { lineWidth: 0, flowCollectionPadding: false, collectionStyle: secret ? 'flow' : 'block' }).replace(/^secrets:\n {2}- (.+)$/m, 'secrets: [$1]');
  const head = text.trim() ? (text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n') : '# Variables\n\n';
  return { from: text.length, to: text.length, insert: `${head}\`\`\`yaml\n${yaml}\`\`\`\n` };
}

/** A note without frontmatter: add one holding just this value. */
function newFrontmatter(_text: string, path: string[], value: string): TextChange {
  return { from: 0, to: 0, insert: `---\n${stringify(nested(path, value), { lineWidth: 0 })}---\n` };
}

export function applyChange(text: string, c: TextChange | null): string {
  return c ? text.slice(0, c.from) + c.insert + text.slice(c.to) : text;
}
