import { describe, expect, it } from 'vitest';
import { addSecretName, applyChange, formatYamlScalar, setValue } from '../../../src/renderer/variables/write';
import { parseVariablesFile } from '../../../src/renderer/variables/parse';
import { VARIABLES_MD } from './fixtures';

const set = (text: string, path: string[], v: string, where: 'file' | 'note' = 'file') => applyChange(text, setValue(text, where, path, v));

describe('write-back keeps comments and formatting', () => {
  it('replaces an existing value in place (comment on the same line survives)', () => {
    const out = set(VARIABLES_MD, ['vars', 'domain'], 'lab.local');
    expect(out).toContain('  domain: lab.local   # AD domain');
    expect(out.replace('lab.local', 'corp.local')).toBe(VARIABLES_MD);
  });

  it('keeps the quote style; quotes plain values only when needed', () => {
    expect(set(VARIABLES_MD, ['vars', 'fqdn'], 'x.y')).toContain('fqdn: "x.y"');
    expect(set(VARIABLES_MD, ['vars', 'port'], '9090')).toContain('port: 9090');
    expect(set(VARIABLES_MD, ['vars', 'ns'], 'yes')).toContain('ns: "yes"');
    expect(set(VARIABLES_MD, ['vars', 'ns'], 'a: b')).toContain('ns: "a: b"');
    expect(set(VARIABLES_MD, ['vars', 'ns'], '#x')).toContain('ns: "#x"');
    expect(formatYamlScalar('10.0.0.1')).toBe('10.0.0.1');
    expect(formatYamlScalar('it\'s', 'QUOTE_SINGLE')).toBe("'it''s'");
  });

  it('edits flow-map target fields and env-level values in place', () => {
    const a = set(VARIABLES_MD, ['targets', 'DC01', 'ip'], '10.9.9.9');
    expect(a).toContain('DC01:     { ip: 10.9.9.9, user: administrator, os: windows }');
    const b = set(VARIABLES_MD, ['envs', 'prod', 'vars', 'ns'], 'prod2');
    expect(b).toContain('      ns: prod2');
    expect(parseVariablesFile('v.md', b).envs.get('prod')!.vars.get('ns')!.value).toBe('prod2');
  });

  it('adds a new key as one line in the block map, at its indentation', () => {
    const out = set(VARIABLES_MD, ['vars', 'region'], 'eu-west');
    expect(out).toContain('  host: web01\n  region: eu-west\n');
    expect(out).toContain('# Defaults for every environment');
    expect(out.length - VARIABLES_MD.length).toBe('\n  region: eu-west'.length);
    const nested = set(VARIABLES_MD, ['targets', 'Linux-WS', 'domain'], 'corp.local');
    expect(nested).toContain('    password: vault\n    domain: corp.local\n');
  });

  it('missing parent maps: nested lines under the deepest existing map — nothing else is reformatted', () => {
    const out = set(VARIABLES_MD, ['envs', 'lab', 'targets', 'LABDC', 'ip'], '10.1.1.1');
    expect(out).toBe(VARIABLES_MD.replace('      ns: lab\n', '      ns: lab\n    targets:\n      LABDC:\n        ip: 10.1.1.1\n'));
    const f = parseVariablesFile('v.md', out);
    expect(f.envs.get('lab')!.targets.get('LABDC')!.fields.get('ip')!.value).toBe('10.1.1.1');
    // A field added to a one-line flow map stays on that line.
    expect(set(VARIABLES_MD, ['targets', 'WS01', 'domain'], 'corp.local')).toContain('WS01:     { ip: 10.0.0.21, user: alice, os: windows, domain: corp.local }');
    // New top-level sections go at the end of the root map.
    const fresh = applyChange(applyChange('', setValue('', 'file', ['vars', 'host'], 'web01')), null);
    expect(applyChange(fresh, addSecretName(fresh, 'token'))).toBe('# Variables\n\n```yaml\nvars:\n  host: web01\nsecrets: [token]\n```\n');
  });

  it('falls back to the Document API only for an empty block (comments kept)', () => {
    const t = '```yaml\n# just a comment\n```\n';
    const out = set(t, ['vars', 'a'], '1');
    expect(out).toContain('# just a comment');
    expect(parseVariablesFile('v.md', out).vars.get('a')!.value).toBe('1');
  });

  it('fills a key that has no value yet', () => {
    const t = '```yaml\nvars:\n  a:\n  b: 2\n```\n';
    expect(set(t, ['vars', 'a'], 'one')).toBe('```yaml\nvars:\n  a: one\n  b: 2\n```\n');
  });

  it('creates the yaml block when the note has none, and frontmatter for notes', () => {
    const out = set('# My vars\n', ['vars', 'host'], 'web01');
    expect(out).toBe('# My vars\n\n```yaml\nvars:\n  host: web01\n```\n');
    expect(set('', ['vars', 'x'], '1')).toBe('# Variables\n\n```yaml\nvars:\n  x: "1"\n```\n');
    expect(set('body\n', ['vars', 'share'], 'C$', 'note')).toBe('---\nvars:\n  share: C$\n---\nbody\n');
    expect(set('---\ntitle: t\nvars:\n  share: A\n---\nbody\n', ['vars', 'share'], 'B', 'note')).toBe('---\ntitle: t\nvars:\n  share: B\n---\nbody\n');
  });

  it('refuses to write into broken YAML or over a map', () => {
    expect(() => setValue('```yaml\nvars: [\n```\n', 'file', ['vars', 'a'], 'x')).toThrow(/Fix the YAML/);
    expect(() => setValue(VARIABLES_MD, 'file', ['targets', 'DC01'], 'x')).toThrow(/map or list/);
  });

  it('adds names to the secrets list (flow, block, missing)', () => {
    expect(applyChange(VARIABLES_MD, addSecretName(VARIABLES_MD, 'api_token'))).toContain('secrets: [db_pass, password, api_token]');
    expect(addSecretName(VARIABLES_MD, 'db_pass')).toBeNull();
    const block = '```yaml\nsecrets:\n  - a\nvars: {}\n```\n';
    expect(applyChange(block, addSecretName(block, 'b'))).toBe('```yaml\nsecrets:\n  - a\n  - b\nvars: {}\n```\n');
    const none = '```yaml\nvars:\n  a: 1 # keep\n```\n';
    const out = applyChange(none, addSecretName(none, 'tok'));
    expect(out).toContain('# keep');
    expect(parseVariablesFile('v.md', out).vars.get('tok')).toMatchObject({ secret: true });
    expect(applyChange('', addSecretName('', 'tok'))).toContain('secrets: [tok]');
  });
});
