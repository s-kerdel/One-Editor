import { describe, expect, it } from 'vitest';
import { commentFor, expandForTargets, fenceAtLine, isDangerEnv, lookup, MASK, osMismatch, parseFenceInfo, placeholderNames, resolveText, targetNames, vaultKeyFor } from '../../../src/renderer/variables/resolve';
import { scope } from './fixtures';

const display = { mode: 'display' as const };

describe('precedence: fence > note > variables.md (target → env → top) > built-ins > default', () => {
  it('variables.md: top-level, then the active env overrides', () => {
    expect(lookup(scope(), 'ns').value).toBe('default');
    expect(lookup(scope({ env: 'lab' }), 'ns')).toMatchObject({ value: 'lab', kind: 'env' });
    expect(lookup(scope({ env: 'prod' }), 'ns').value).toBe('prod');
    expect(lookup(scope({ env: 'nope' }), 'ns').value).toBe('default');
  });

  it('active target fields beat plain vars; env rows override target fields', () => {
    expect(lookup(scope({ target: 'DC01' }), 'ip')).toMatchObject({ value: '10.0.0.10', kind: 'target' });
    expect(lookup(scope({ target: 'dc01' }), 'user').value).toBe('administrator'); // case-insensitive target name
    expect(lookup(scope({ target: 'DC01', env: 'prod' }), 'ip').value).toBe('192.168.1.10');
    expect(lookup(scope({ target: 'DC01', env: 'prod' }), 'user').value).toBe('administrator'); // field-level merge
    expect(lookup(scope({ target: 'PRODWEB' }), 'ip').value).toBeNull(); // only exists in prod
    expect(lookup(scope({ target: 'PRODWEB', env: 'prod' }), 'ip').value).toBe('192.168.1.50');
  });

  it('{{TARGET.field}} ignores the active target', () => {
    expect(lookup(scope({ target: 'DC01' }), 'WS01.ip').value).toBe('10.0.0.21');
    expect(lookup(scope(), 'Linux-WS.user').value).toBe('root');
    expect(lookup(scope({ env: 'prod' }), 'DC01.ip').value).toBe('192.168.1.10');
    expect(lookup(scope(), 'WS01.nope').value).toBeNull();
    expect(lookup(scope(), 'WS01.nope', 'x')).toMatchObject({ value: 'x', kind: 'default' });
  });

  it('the note always wins over variables.md, and says what it overrides', () => {
    const s = scope({ noteText: '---\nvars:\n  share: C$\n---\n' });
    const l = lookup(s, 'share');
    expect(l).toMatchObject({ value: 'C$', kind: 'note' });
    expect(l.shadowed).toMatchObject({ value: 'ADMIN$', where: 'variables.md' });
    // …also over the active target's field and the active env.
    const t = scope({ target: 'DC01', env: 'prod', noteText: '---\nvars:\n  ip: 1.1.1.1\n  ns: mine\n---\n' });
    expect(lookup(t, 'ip').value).toBe('1.1.1.1');
    expect(lookup(t, 'ip').shadowed?.where).toBe('variables.md · target DC01 (env prod)');
    expect(lookup(t, 'ns').shadowed?.where).toBe('variables.md · env prod');
  });

  it('fence attributes beat the note', () => {
    const s = scope({ noteText: '---\nvars:\n  share: C$\n---\n', fence: new Map([['share', 'D$']]) });
    expect(lookup(s, 'share')).toMatchObject({ value: 'D$', kind: 'fence' });
  });

  it('built-ins only fill names nobody defined; then the placeholder default', () => {
    const s = scope({ target: 'WS01', env: 'lab' });
    expect(lookup(s, 'date').value).toBe('2026-11-19');
    expect(lookup(s, 'date', 'DD.MM.YYYY').value).toBe('19.11.2026');
    expect(lookup(s, 'time').value).toBe('09:05');
    expect(lookup(s, 'title').value).toBe('Runbook');
    expect(lookup(s, 'target').value).toBe('WS01');
    expect(lookup(s, 'env').value).toBe('lab');
    const own = scope({ noteText: '---\nvars:\n  title: Mine\n---\n' });
    expect(lookup(own, 'title').value).toBe('Mine');
    expect(lookup(scope(), 'target').value).toBeNull();
    expect(lookup(scope(), 'missing', 'fallback')).toMatchObject({ value: 'fallback', kind: 'default' });
    expect(lookup(scope(), 'missing')).toMatchObject({ value: null, kind: null });
  });

  it('works without any variables.md', () => {
    const s = scope({ file: null } as never);
    expect(lookup({ ...s, file: null }, 'ns').value).toBeNull();
    expect(lookup({ ...s, file: null }, 'title').value).toBe('Runbook');
  });
});

describe('fence info', () => {
  it('parses lang and {target= env= other=} attributes', () => {
    expect(parseFenceInfo('bash {target=Linux-WS}')).toMatchObject({ lang: 'bash', target: 'Linux-WS', env: null });
    const f = parseFenceInfo('powershell title="x y" {env=lab, target="DC01" ns=kube}');
    expect(f).toMatchObject({ lang: 'powershell', target: 'DC01', env: 'lab' });
    expect([...f.vars]).toEqual([['ns', 'kube']]);
    expect(parseFenceInfo('')).toMatchObject({ lang: '', target: null });
    expect(parseFenceInfo(null).vars.size).toBe(0);
  });
});

describe('resolveText', () => {
  it('display mode: values in, secrets masked, unresolved kept raw, nested values resolved', () => {
    const s = scope({ target: 'Linux-WS', env: 'prod' });
    const r = resolveText('ssh {{user}}@{{ip}} -p {{port}} # {{fqdn}} {{nope}} pw={{password}} db={{db_pass}}', s, display);
    expect(r.text).toBe(`ssh root@10.0.0.30 -p 8080 # web01.corp.local {{nope}} pw=${MASK} db=${MASK}`);
    expect(r.missing.map((m) => m.name)).toEqual(['nope']);
    expect(r.secretKeys).toEqual(['C:/work/lab::Linux-WS.password', 'prod-db']);
  });

  it('action mode: secrets come from the vault callback; missing ones are reported', () => {
    const s = scope({ target: 'Linux-WS' });
    const vault = new Map([['C:/work/lab::Linux-WS.password', 's3cr3t']]);
    const r = resolveText('pw={{password}} db={{db_pass}}', s, { mode: 'action', secret: (k) => vault.get(k) });
    expect(r.text).toBe('pw=s3cr3t db={{db_pass}}');
    expect(r.missing).toMatchObject([{ name: 'db_pass', secret: true, vaultKey: 'C:/work/lab::db_pass' }]);
  });

  it('typed / remembered input fills undefined names; defaults are reported separately', () => {
    const s = scope();
    const r = resolveText('{{a}} {{b:22}} {{c:9}}', s, { mode: 'action', input: new Map([['a', 'A'], ['c', 'C']]) });
    expect(r.text).toBe('A 22 C');
    expect(r.missing).toEqual([]);
    expect(r.defaulted.map((m) => m.name)).toEqual(['b']);
  });

  it('cycles and deep nesting stop safely', () => {
    const s = scope({ noteText: '---\nvars:\n  a: "{{b}}"\n  b: "{{a}}"\n---\n' });
    expect(resolveText('{{a}}', s, display).text).toBe('{{a}}');
  });

  it('placeholderNames dedupes', () => {
    expect(placeholderNames('{{a}} {{ b : x }} {{a}} {{WS01.ip}}')).toEqual(['a', 'b', 'WS01.ip']);
  });
});

describe('multi-target expansion', () => {
  it('one resolved copy per target with a comment line naming it', () => {
    const r = expandForTargets('ping {{ip}}', scope(), ['DC01', 'WS01'], 'bash', display);
    expect(r.text).toBe('# --- DC01 ---\nping 10.0.0.10\n\n# --- WS01 ---\nping 10.0.0.21');
    expect(r.parts.map((p) => p.text)).toEqual(['ping 10.0.0.10', 'ping 10.0.0.21']);
    expect(expandForTargets('x', scope(), ['A'], 'cmd', display).text.startsWith('REM --- A ---')).toBe(true);
    expect(commentFor('sql')).toBe('--');
  });
  it('collects what is missing across targets once', () => {
    const r = expandForTargets('{{ip}} {{x}}', scope(), ['DC01', 'PRODWEB'], 'bash', { mode: 'action' });
    expect(r.missing.map((m) => m.name)).toEqual(['x', 'ip']);
  });
});

describe('OS hint, danger env, vault keys, targets list', () => {
  it('flags shell / OS mismatches only', () => {
    expect(osMismatch('powershell', 'ubuntu')).toBe('powershell on a ubuntu target');
    expect(osMismatch('cmd', 'linux')).toBeTruthy();
    expect(osMismatch('bash', 'windows')).toBe('bash on a windows target');
    expect(osMismatch('bash', 'Debian 12')).toBeNull();
    expect(osMismatch('powershell', 'Windows Server 2022')).toBeNull();
    expect(osMismatch('python', 'windows')).toBeNull();
    expect(osMismatch('bash', null)).toBeNull();
  });
  it('danger env names (configurable, whole words)', () => {
    expect(isDangerEnv('prod')).toBe(true);
    expect(isDangerEnv('PRODUCTION')).toBe(true);
    expect(isDangerEnv('prod-eu')).toBe(true);
    expect(isDangerEnv('live')).toBe(true);
    expect(isDangerEnv('preprod')).toBe(false);
    expect(isDangerEnv('lab')).toBe(false);
    expect(isDangerEnv('stage', 'stage|prod')).toBe(true);
    expect(isDangerEnv('prod', '(')).toBe(true); // broken pattern → default
  });
  it('default vault keys are scoped to the variables.md folder; vault:key wins', () => {
    const s = scope();
    const pw = s.file!.targets.get('Linux-WS')!.fields.get('password')!;
    expect(vaultKeyFor(pw, s.vaultScope)).toBe('C:/work/lab::Linux-WS.password');
    expect(vaultKeyFor(s.file!.envs.get('prod')!.vars.get('db_pass')!, s.vaultScope)).toBe('prod-db');
  });
  it('lists targets per env', () => {
    expect(targetNames(scope().file, null)).toEqual(['DC01', 'WS01', 'Linux-WS']);
    expect(targetNames(scope().file, 'prod')).toEqual(['DC01', 'WS01', 'Linux-WS', 'PRODWEB']);
  });
});

describe('fenceAtLine', () => {
  it('returns raw code + info of a block, also inside a quote', () => {
    const t = 'x\n```bash {target=DC01}\necho {{ip}}\nls\n```\n> ```sh\n> id\n> ```\n';
    expect(fenceAtLine(t, 1)).toEqual({ info: 'bash {target=DC01}', code: 'echo {{ip}}\nls' });
    expect(fenceAtLine(t, 5)).toEqual({ info: 'sh', code: 'id' });
    expect(fenceAtLine(t, 0)).toBeNull();
  });
});
