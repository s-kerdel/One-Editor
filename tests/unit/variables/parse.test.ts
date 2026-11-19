import { describe, expect, it } from 'vitest';
import { findYamlRegion, parseNoteMeta, parseVariablesFile } from '../../../src/renderer/variables/parse';
import { VARIABLES_MD, file } from './fixtures';

describe('variables.md parser', () => {
  it('reads vars, targets (flow + block maps), envs and env-level targets from the first yaml fence', () => {
    const f = file();
    expect(f.ok).toBe(true);
    expect(f.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(f.vars.get('domain')?.value).toBe('corp.local');
    expect(f.vars.get('port')?.value).toBe('8080');
    expect(f.vars.has('ignored')).toBe(false); // second yaml block is prose, not data
    expect([...f.targets.keys()]).toEqual(['DC01', 'WS01', 'Linux-WS']);
    expect(f.targets.get('Linux-WS')?.fields.get('os')?.value).toBe('ubuntu');
    expect([...f.envs.keys()]).toEqual(['lab', 'prod']);
    expect(f.envs.get('prod')?.targets.get('DC01')?.fields.get('ip')?.value).toBe('192.168.1.10');
    expect(f.envs.get('prod')?.vars.get('ns')?.path).toEqual(['envs', 'prod', 'vars', 'ns']);
  });

  it('keeps file offsets of each value (for in-place edits)', () => {
    const f = file();
    const d = f.vars.get('domain')!;
    expect(VARIABLES_MD.slice(d.loc!.from, d.loc!.to)).toBe('corp.local');
    const ip = f.targets.get('DC01')!.fields.get('ip')!;
    expect(VARIABLES_MD.slice(ip.loc!.from, ip.loc!.to)).toBe('10.0.0.10');
  });

  it('secrets: list names, TARGET.field, bare field names and vault placeholders', () => {
    const f = file();
    // db_pass is listed but not defined at top level: a value-less secret var.
    expect(f.vars.get('db_pass')).toMatchObject({ value: null, secret: true });
    // `password` is a field name: every target's password field is secret.
    expect(f.targets.get('Linux-WS')!.fields.get('password')).toMatchObject({ value: null, secret: true });
    // vault:<key> keeps an explicit key.
    expect(f.envs.get('prod')!.vars.get('db_pass')).toMatchObject({ value: null, secret: true, vaultKey: 'prod-db' });
    const g = parseVariablesFile('v.md', '```yaml\nvars:\n  token: abc123\nsecrets: [token]\ntargets:\n  A: { pw: x }\n  B: { pw: y }\n```\n');
    expect(g.vars.get('token')).toMatchObject({ value: 'abc123', secret: true });
    expect(g.diagnostics.some((d) => d.severity === 'warning' && /secret/.test(d.message))).toBe(true);
    const h = parseVariablesFile('v.md', '```yaml\ntargets:\n  A: { pw: "🔒" }\nsecrets: [B.pw, A.pw]\n```\n');
    expect(h.targets.get('A')!.fields.get('pw')).toMatchObject({ secret: true, value: null });
  });

  it('duplicates: first wins + warning; wrong types and unknown keys are diagnostics, not crashes', () => {
    const f = parseVariablesFile('v.md', '```yaml\nvars:\n  a: 1\n  a: 2\n  list: [1, 2]\n  "bad name": x\ntargets: nope\nextra: 1\nenvs:\n  lab: 5\n```\n');
    expect(f.ok).toBe(true);
    expect(f.vars.get('a')?.value).toBe('1');
    expect(f.vars.has('list')).toBe(false);
    const msgs = f.diagnostics.map((d) => `${d.severity}: ${d.message}`);
    expect(msgs.some((m) => /warning: Duplicate “a”/.test(m))).toBe(true);
    expect(msgs.some((m) => /error: “list” must be a single value/.test(m))).toBe(true);
    expect(msgs.some((m) => /targets must be a map/.test(m))).toBe(true);
    expect(msgs.some((m) => /Unknown key “extra”/.test(m))).toBe(true);
    expect(msgs.some((m) => /can’t be used as/.test(m))).toBe(true);
    expect(msgs.some((m) => /Environment “lab” must be a map/.test(m))).toBe(true);
    // Diagnostics point into the file (offsets are inside the yaml block).
    const dup = f.diagnostics.find((d) => /Duplicate/.test(d.message))!;
    expect(dup.from).toBeGreaterThan(8);
  });

  it('invalid YAML → ok=false with an error located in the block', () => {
    const text = '# x\n```yaml\nvars:\n  a: [1\n```\n';
    const f = parseVariablesFile('v.md', text);
    expect(f.ok).toBe(false);
    expect(f.diagnostics[0].severity).toBe('error');
    expect(f.diagnostics[0].from).toBeGreaterThanOrEqual(text.indexOf('vars'));
  });

  it('finds the block: skips yaml shown inside other fences, accepts ~~~, falls back to frontmatter', () => {
    const t = '````markdown\n```yaml\nvars: {a: 1}\n```\n````\n\n~~~yml\nvars: {b: 2}\n~~~\n';
    expect(parseVariablesFile('v.md', t).vars.has('b')).toBe(true);
    expect(parseVariablesFile('v.md', t).vars.has('a')).toBe(false);
    const fm = '---\nvars:\n  c: 3\n---\n# Notes\n';
    expect(findYamlRegion(fm)?.kind).toBe('frontmatter');
    expect(parseVariablesFile('v.md', fm).vars.get('c')?.value).toBe('3');
    expect(parseVariablesFile('v.md', '# nothing here\n').region).toBeNull();
    expect(parseVariablesFile('v.md', '```yaml\n\n```\n').ok).toBe(true);
  });

  it('tolerates CRLF-ish spacing and extra blank lines', () => {
    const f = parseVariablesFile('v.md', '```yaml\n\n\nvars:\n    spaced:     value with spaces   \n\n```');
    expect(f.vars.get('spaced')?.value).toBe('value with spaces');
  });
});

describe('note frontmatter', () => {
  it('reads vars, target and env', () => {
    const m = parseNoteMeta('---\ntitle: x\ntarget: WS01\nenv: prod\nvars:\n  share: C$\n---\nbody {{share}}\n')!;
    expect(m.target).toBe('WS01');
    expect(m.env).toBe('prod');
    expect(m.vars.get('share')?.value).toBe('C$');
    expect(m.vars.get('share')?.path).toEqual(['vars', 'share']);
  });
  it('ignores notes without relevant keys or with broken YAML', () => {
    expect(parseNoteMeta('---\ntitle: x\n---\n')).toBeNull();
    expect(parseNoteMeta('no frontmatter')).toBeNull();
    expect(parseNoteMeta('---\nvars: [\n---\n')).toBeNull();
  });
});
