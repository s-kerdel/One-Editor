import { describe, expect, it } from 'vitest';
import { asJson, curlTemplate, delimitedRows, detectPaste, formatCurl, isSql, isTrace, secretKind, secretValue, shellWords, toMarkdownTable, transformSql, vscodeLanguage } from '../../../src/renderer/variables/smartpaste';

const ids = (t: string, o?: { vscodeData?: string }) => detectPaste(t, o).map((x) => x.id);

describe('smart paste detectors', () => {
  it('JSON → pretty ```json block; not for scalars, prose or broken JSON', () => {
    expect(asJson('{"a":1,"b":[1,2]}')).toBe('```json\n{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}\n```');
    expect(asJson('[1, 2]')).toContain('```json');
    expect(asJson('"x"')).toBeNull();
    expect(asJson('{not json}')).toBeNull();
    expect(ids('{"ok":true}')).toEqual(['json']);
  });

  it('curl: one flag per line with \\ continuations, quotes kept', () => {
    const c = `curl -X POST 'https://api.example.com/v1/items' -H 'Content-Type: application/json' -d '{"name": "a b"}' --compressed`;
    expect(formatCurl(c)).toBe(`curl \\\n  -X POST \\\n  'https://api.example.com/v1/items' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"name": "a b"}' \\\n  --compressed`);
    expect(shellWords('curl "a \\" b" \\\n -k')).toEqual(['curl', '"a \\" b"', '-k']);
  });

  it('curl as template: host, bearer token, basic auth, cookies, api keys and ids become placeholders', () => {
    const c = `curl -u admin:Pa55w0rd! -H 'Authorization: Bearer abc.def.ghi' -H 'X-Api-Key: k123' -b 'sid=xyz' 'https://api.corp.local:8443/v1/users/123456/orders/9f1c2e4a-1b2c-4d5e-8f90-123456789abc?api_key=zzz&x=1'`;
    const t = curlTemplate(c);
    expect(t.text).toContain('{{user}}:{{password}}');
    expect(t.text).toContain("'Authorization: Bearer {{token}}'");
    expect(t.text).toContain("'X-Api-Key: {{api_key}}'");
    expect(t.text).toContain("'{{cookie}}'");
    expect(t.text).toContain("'https://{{host}}:8443/v1/users/{{id}}/orders/{{id2}}?api_key={{api_key2}}&x=1'");
    expect(t.values).toEqual([
      { name: 'user', value: 'admin', secret: false },
      { name: 'password', value: 'Pa55w0rd!', secret: true },
      { name: 'token', value: 'abc.def.ghi', secret: true },
      { name: 'api_key', value: 'k123', secret: true },
      { name: 'cookie', value: 'sid=xyz', secret: true },
      { name: 'host', value: 'api.corp.local', secret: false },
      { name: 'id', value: '123456', secret: false },
      { name: 'id2', value: '9f1c2e4a-1b2c-4d5e-8f90-123456789abc', secret: false },
      { name: 'api_key2', value: 'zzz', secret: true },
    ]);
    expect(ids(c)).toEqual(['curl', 'curl-template']);
    expect(ids('curl https://example.com')).toEqual(['curl', 'curl-template']);
  });

  it('stack traces / compiler output → log block', () => {
    const js = 'TypeError: x is undefined\n    at run (src/app.ts:12:5)\n    at main (src/main.ts:3:1)';
    const py = 'Traceback (most recent call last):\n  File "tools/a.py", line 3, in <module>\n    main()\nValueError: bad';
    const tsc = "src/a.ts(4,7): error TS2322: Type 'x'\nsrc/b.ts(9,1): error TS2304: Cannot find name";
    const php = 'PHP Fatal error:  Uncaught Error in /var/www/app.php on line 14\n#0 /var/www/index.php(3): run()';
    for (const t of [js, py, tsc, php]) expect(isTrace(t), t).toBe(true);
    expect(isTrace('just\nsome text')).toBe(false);
    expect(ids(js)).toEqual(['log']);
  });

  it('CSV / TSV / Excel cells → markdown table (consistent columns only)', () => {
    expect(delimitedRows('name\tip\nDC01\t10.0.0.10\nWS01\t10.0.0.21\n')).toEqual([['name', 'ip'], ['DC01', '10.0.0.10'], ['WS01', '10.0.0.21']]);
    expect(delimitedRows('a,b\n"x, y",2')).toEqual([['a', 'b'], ['x, y', '2']]);
    expect(delimitedRows('a;b;c\n1;2;3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
    expect(delimitedRows('a,b\nc')).toBeNull();
    expect(delimitedRows('Hello, world. This is prose, really.\nAnd more, of it. Yes, indeed.')).toBeNull();
    expect(toMarkdownTable([['h|1', 'h2'], ['a', 'b']])).toBe('| h\\|1 | h2 |\n| --- | --- |\n| a | b |');
    expect(ids('x\ty\n1\t2')).toEqual(['table']);
  });

  it('SQL → formatted ```sql (sql-formatter)', async () => {
    expect(isSql('select id, name from users where id = 1')).toBe(true);
    expect(isSql('selected items from the list')).toBe(false);
    expect(await transformSql('select id,name from users where id=1')).toBe('```sql\nSELECT\n  id,\n  name\nFROM\n  users\nWHERE\n  id = 1\n```');
    expect(ids('SELECT a FROM t')).toEqual(['sql']);
  });

  it('VS Code clipboard language → fenced block with it', () => {
    expect(vscodeLanguage('{"version":1,"mode":"typescript"}')).toBe('typescript');
    expect(vscodeLanguage('{"mode":"shellscript"}')).toBe('bash');
    expect(vscodeLanguage('{"mode":"plaintext"}')).toBe('');
    expect(vscodeLanguage('nope')).toBeNull();
    const opts = detectPaste('const a = 1;\nconst b = 2;', { vscodeData: '{"mode":"typescript"}' });
    expect(opts[0]).toMatchObject({ id: 'code', label: 'Code block (typescript)', text: '```typescript\nconst a = 1;\nconst b = 2;\n```' });
  });

  it('secret-looking text → warning + replace with {{variable}}', () => {
    expect(secretKind('ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789')).toBe('github_token');
    expect(secretKind('AKIAIOSFODNN7EXAMPLE')).toBe('aws_key');
    expect(secretKind('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')).toBe('jwt');
    expect(secretKind('password=Sup3r$ecret')).toBe('password');
    expect(secretValue('password=Sup3r$ecret')).toBe('Sup3r$ecret');
    expect(secretKind('Xk9#mQ2$vL8!pR4@wT6^zY1&nB3*cF5h')).toBe('secret');
    expect(secretKind('hello world')).toBeNull();
    expect(secretKind('https://example.com/a/very/long/path/that/is/not/secret')).toBeNull();
    expect(secretKind('src/renderer/variables/smartpaste.ts')).toBeNull();
    const o = detectPaste('ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789');
    expect(o).toMatchObject([{ id: 'secret', text: '{{github_token}}', warn: true, values: [{ name: 'github_token', secret: true }] }]);
  });

  it('plain prose / fenced text: nothing offered', () => {
    expect(detectPaste('Just a sentence.')).toEqual([]);
    expect(detectPaste('```js\nx\n```')).toEqual([]);
    expect(detectPaste('   ')).toEqual([]);
  });
});
