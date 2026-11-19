import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { formatText, canFormat } from '../../../src/format';

const fixture = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../../fixtures/workspace', rel), 'utf8').replace(/\r\n/g, '\n');

async function fmt(text: string, lang: string, options = {}) {
  const r = await formatText(text, { lang, options });
  expect(r.error, r.error?.message).toBeUndefined();
  return r.text;
}

describe('PHP', () => {
  it('formats the messy controller PSR-12 style', async () => {
    const r = await formatText(fixture('code/UserController.php'), { path: 'code/UserController.php' });
    expect(r.error).toBeUndefined();
    expect(r.language).toBe('php');
    expect(r.changed).toBe(true);
    const lines = r.text.split('\n');
    expect(lines[0]).toBe('<?php');
    expect(lines).toContain('class UserController extends Controller');
    expect(lines[lines.indexOf('class UserController extends Controller') + 1]).toBe('{');
    expect(lines).toContain('    public function index()');
    expect(lines[lines.indexOf('    public function index()') + 1]).toBe('    {');
    expect(lines).toContain("        $users = User::query()->where('active', true)->orderBy('name')->get();");
    expect(lines).toContain("        return view('users.index', ['users' => $users]);");
    expect(lines).toContain('    public function show(int $id)');
    expect(lines).toContain('        return User::findOrFail($id);');
    expect(r.text.endsWith('}\n')).toBe(true);
  });

  it('handles PHP 8 features', async () => {
    const src = `<?php
#[Attribute(Attribute::TARGET_CLASS)]
final class Foo { public function __construct(private readonly int $a,protected ?string $b=null){}
public function m(Status $s):string{ return match($s){ Status::A=>'a', Status::B,Status::C=>'bc', default=>throw new \\Exception('x') }; } }
enum Status:string { case A='a'; case B='b'; case C='c'; public function label():string{return ucfirst($this->value);} }
$f = new Foo(a:1,b:'x'); $g = fn($x)=>$x*2; $h = $f?->m(...);
readonly class P { public function __construct(public string $n){} }
`;
    const out = await fmt(src, 'php');
    expect(out).toContain('#[Attribute(Attribute::TARGET_CLASS)]\nfinal class Foo\n{');
    expect(out).toContain('        private readonly int $a,\n        protected ?string $b = null,\n    ) {}');
    expect(out).toContain('        return match ($s) {\n            Status::A => \'a\',\n            Status::B, Status::C => \'bc\',');
    expect(out).toContain('enum Status: string\n{\n    case A = \'a\';');
    expect(out).toContain("$f = new Foo(a: 1, b: 'x');");
    expect(out).toContain('$g = fn($x) => $x * 2;');
    expect(out).toContain('$h = $f?->m(...);');
    expect(out).toContain('readonly class P\n{');
    expect(await fmt(out, 'php')).toBe(out);
  });

  it('reports broken PHP with line and column instead of throwing', async () => {
    const src = '<?php\nclass A {\n  function x( { }\n}\n';
    const r = await formatText(src, { path: 'a.php' });
    expect(r.changed).toBe(false);
    expect(r.text).toBe(src);
    expect(r.error?.kind).toBe('syntax');
    expect(r.error?.line).toBe(3);
    expect(r.error?.col).toBe(15);
    expect(r.error?.message).toMatch(/^PHP syntax error at 3:15: unexpected '\{'/);
    expect(r.error?.message).not.toContain('\n');
  });

  it('keeps mixed HTML + PHP templates intact', async () => {
    const tpl = `<html>
<body>
<?php foreach($users as $u): ?>
  <li class="<?= $u->cls ?>"><?php echo $u->name; ?></li>
<?php endforeach; ?>
<?php if($x){ ?>
<p>hi</p>
<?php } ?>
</body>
</html>
`;
    const r = await formatText(tpl, { path: 'views/list.phtml' });
    expect(r.error).toBeUndefined();
    for (const html of ['<html>', '<body>', '<p>hi</p>', '</body>', '</html>', '<li class="<?= $u->cls ?>">']) expect(r.text).toContain(html);
    expect(r.text).toContain('<?php foreach ($users as $u): ?>');
    expect(r.text).toContain('<?php endforeach; ?>');
    expect((await formatText(r.text, { path: 'views/list.phtml' })).text).toBe(r.text);
    // pure HTML in a .php file is left alone
    const html = '<div>\n<p>x</p>\n</div>\n';
    expect((await formatText(html, { path: 'a.php' })).text).toBe(html);
  });

  it('formats tag-less snippets and respects options', async () => {
    const r = await formatText('$a=[1,2];\nif($a){echo "x";}', { lang: 'php', snippet: true });
    expect(r.text).toBe("$a = [1, 2];\nif ($a) {\n    echo 'x';\n}\n");
    const tabs = await fmt('<?php\nfunction a(){return "x";}', 'php', { useTabs: true, singleQuote: false });
    expect(tabs).toBe('<?php\nfunction a()\n{\n\treturn "x";\n}\n');
    expect(await fmt('<?php\nfunction a(){return 1;}', 'php', { tabWidth: 2, braceStyle: '1tbs' })).toBe('<?php\nfunction a() {\n  return 1;\n}\n');
  });

  it('has no formatter for Blade', async () => {
    const r = await formatText('@if($a) x @endif', { path: 'x.blade.php' });
    expect(r).toMatchObject({ changed: false, supported: false, language: 'blade' });
    expect(canFormat({ path: 'x.blade.php' })).toBe(false);
    expect(canFormat({ path: 'x.php' })).toBe(true);
  });
});

describe('SQL', () => {
  const messy = fixture('code/query.sql');
  it('formats with uppercase keywords by default', async () => {
    const out = await fmt(messy, 'sql');
    expect(out).toBe(
      `SELECT
  u.id,
  u.name,
  count(o.id) AS orders
FROM
  users u
  LEFT JOIN orders o ON o.user_id = u.id
WHERE
  u.active = 1
GROUP BY
  u.id,
  u.name
ORDER BY
  orders DESC;
`,
    );
    expect(await fmt(out, 'sql')).toBe(out);
  });
  it('supports dialects from the fence alias', async () => {
    expect(await fmt('select `a` from `t` limit 5', 'mysql')).toBe('SELECT\n  `a`\nFROM\n  `t`\nLIMIT\n  5\n');
    expect(await fmt("select a::text, b->>'x' from t where c = $1", 'postgresql')).toBe("SELECT\n  a::text,\n  b ->> 'x'\nFROM\n  t\nWHERE\n  c = $1\n");
    expect(await fmt('select top 5 [a] from [t]', 'tsql')).toContain('[a]');
    expect(await fmt('select `a` from t', 'mariadb')).toContain('`a`');
    expect(await fmt('select "a" from t', 'sqlite')).toContain('"a"');
  });
  it('honours keyword case and indentation options', async () => {
    expect(await fmt('SELECT a FROM t', 'sql', { sqlKeywordCase: 'lower', tabWidth: 4 })).toBe('select\n    a\nfrom\n    t\n');
    expect(await fmt('select a From t', 'sql', { sqlKeywordCase: 'preserve' })).toBe('select\n  a\nFrom\n  t\n');
  });
  it('reports syntax errors', async () => {
    const r = await formatText('select a from b where (', { lang: 'mysql' });
    expect(r.error?.kind).toBe('syntax');
    expect(r.error?.message).toMatch(/^SQL syntax error at 1:\d+: /);
    expect(r.error!.message.length).toBeLessThan(220);
  });
});

describe('Prettier languages', () => {
  const cases: Array<[string, string, string]> = [
    ['typescript', fixture('code/app.ts'), 'export function greet(name: string) {\n  return `Hello, ${name}!`;\n}\nconst items = [1, 2, 3].map((x) => x * 2);\n'],
    ['tsx', 'const A=({a}:{a:string})=><div className="x">{a}</div>', 'const A = ({ a }: { a: string }) => <div className="x">{a}</div>;\n'],
    ['javascript', 'const a={b:1,c:[1,2]};function f(){return a}', 'const a = { b: 1, c: [1, 2] };\nfunction f() {\n  return a;\n}\n'],
    ['jsx', 'const A=()=><p>hi</p>', 'const A = () => <p>hi</p>;\n'],
    ['json', '{"a":1,"b":[1,2,{"c":null}]}', '{ "a": 1, "b": [1, 2, { "c": null }] }\n'],
    ['jsonc', '{\n// note\n"a":1}', '{\n  // note\n  "a": 1\n}\n'],
    ['css', 'a{color:red;background:blue}\n.b>.c{margin:0}', 'a {\n  color: red;\n  background: blue;\n}\n.b > .c {\n  margin: 0;\n}\n'],
    ['scss', '$c:red;.a{.b{color:$c}}', '$c: red;\n.a {\n  .b {\n    color: $c;\n  }\n}\n'],
    ['less', '@c:red;.a{.b{color:@c}}', '@c: red;\n.a {\n  .b {\n    color: @c;\n  }\n}\n'],
    ['yaml', 'a:   1\nb:\n    - x\n    -   y\n', 'a: 1\nb:\n  - x\n  - y\n'],
    ['html', '<div><p>hi</p><script>const a=1</script><style>a{color:red}</style></div>', '<div>\n  <p>hi</p>\n  <script>\n    const a = 1;\n  </script>\n  <style>\n    a {\n      color: red;\n    }\n  </style>\n</div>\n'],
    ['vue', '<template><div>{{a}}</div></template>\n<script setup lang="ts">\nconst a:number=1\n</script>', '<template>\n  <div>{{ a }}</div>\n</template>\n<script setup lang="ts">\nconst a: number = 1;\n</script>\n'],
    ['graphql', 'query{user(id:1){name,email}}', 'query {\n  user(id: 1) {\n    name\n    email\n  }\n}\n'],
    ['xml', '<?xml version="1.0"?><a><b x="1"   y="2">t</b><c/></a>', '<?xml version="1.0" ?>\n<a>\n  <b x="1" y="2">t</b>\n  <c />\n</a>\n'],
    ['sh', 'if [ -f x ];then\necho "hi"   ;fi', 'if [ -f x ]; then\n  echo "hi"\nfi\n'],
  ];
  for (const [lang, src, expected] of cases) {
    it(`formats ${lang} and is idempotent`, async () => {
      const out = await fmt(src, lang);
      expect(out).toBe(expected);
      expect(await fmt(out, lang)).toBe(out);
    });
  }

  it('respects prettier options', async () => {
    expect(await fmt('const a = "x"', 'ts', { singleQuote: true, semi: false })).toBe("const a = 'x'\n");
    expect(await fmt('function f(){return 1}', 'js', { useTabs: true })).toBe('function f() {\n\treturn 1;\n}\n');
    expect(await fmt('{"a":{"b":1}}', 'json', { tabWidth: 4, printWidth: 5 })).toBe('{\n    "a": {\n        "b": 1\n    }\n}\n');
  });

  it('maps syntax errors for each language', async () => {
    const ts = await formatText('const a = {\n  b: ,\n}', { path: 'a.ts' });
    expect(ts.error).toMatchObject({ kind: 'syntax', line: 2, language: 'typescript' });
    expect(ts.error?.message).toMatch(/^TypeScript syntax error at 2:\d+: /);
    expect((await formatText('{"a": }', { path: 'a.json' })).error?.message).toMatch(/^JSON syntax error at 1:\d+: /);
    expect((await formatText('a {\n  color: red;\n', { path: 'a.css' })).error?.kind).toBe('syntax');
    expect((await formatText('a: [1, 2\nb: 3', { path: 'a.yaml' })).error?.kind).toBe('syntax');
    expect((await formatText('<a><b></a>', { path: 'a.xml' })).error?.message).toMatch(/^XML syntax error/);
    expect((await formatText('if [ -f x ;then\n fi fi', { path: 'a.sh' })).error?.message).toMatch(/^Shell syntax error/);
  });

  it('leaves unsupported and unknown languages untouched', async () => {
    expect(await formatText('def a( ):  pass', { path: 'a.py' })).toMatchObject({ changed: false, supported: false, language: 'python' });
    expect(await formatText('x', { path: 'a.unknownext' })).toMatchObject({ changed: false, supported: false, language: null });
    expect(await formatText('x', {})).toMatchObject({ changed: false, language: null });
    // a console transcript is not a script
    expect(await formatText('$ ls   -la\nfoo  bar', { lang: 'console' })).toMatchObject({ changed: false, supported: false, language: 'shell' });
  });

  it('never emits CR, even for CRLF input', async () => {
    for (const [p, src] of [
      ['a.php', '<?php\r\nfunction a(){\r\nreturn 1;}\r\n'],
      ['a.ts', 'const a=1\r\nconst b=`x\r\ny`\r\n'],
      ['a.sql', 'select a\r\nfrom b\r\n'],
      ['a.md', '# T\r\n\r\n* a\r\n* b\r\n\r\n```json\r\n{"a":1}\r\n```\r\n'],
      ['a.yaml', 'a:   1\r\n'],
    ] as const) {
      const r = await formatText(src, { path: p });
      expect(r.error).toBeUndefined();
      expect(r.text).not.toContain('\r');
      expect(r.changed).toBe(true);
    }
  });

  it('keeps empty input empty', async () => {
    expect(await formatText('', { path: 'a.php' })).toMatchObject({ text: '', changed: false });
    expect(await formatText('', { path: 'a.md' })).toMatchObject({ text: '', changed: false });
  });
});

describe('cursor mapping', () => {
  it('keeps the cursor on the same token (prettier languages)', async () => {
    const src = fixture('code/UserController.php');
    const at = src.indexOf('orderBy');
    const r = await formatText(src, { path: 'a.php', cursorOffset: at });
    expect(r.text.slice(r.cursorOffset!, r.cursorOffset! + 7)).toBe('orderBy');
    const ts = 'const a={b:1,\n\n\n   target:2}';
    const r2 = await formatText(ts, { path: 'a.ts', cursorOffset: ts.indexOf('target') });
    expect(r2.text.slice(r2.cursorOffset!, r2.cursorOffset! + 6)).toBe('target');
  });
  it('keeps the cursor on the same token (sql, markdown)', async () => {
    const sql = fixture('code/query.sql');
    const r = await formatText(sql, { path: 'q.sql', cursorOffset: sql.indexOf('group by') });
    expect(r.text.slice(r.cursorOffset!).trimStart().startsWith('GROUP BY')).toBe(true);
    const md = '# T\n\n\n\n*  one\n*  two\n\n```json\n{"a":1,"needle":2}\n```\n';
    const r2 = await formatText(md, { path: 'n.md', cursorOffset: md.indexOf('needle') });
    expect(r2.text.slice(r2.cursorOffset!, r2.cursorOffset! + 6)).toBe('needle');
    const end = await formatText(sql, { path: 'q.sql', cursorOffset: sql.length });
    expect(end.cursorOffset).toBeLessThanOrEqual(end.text.length);
  });
});
