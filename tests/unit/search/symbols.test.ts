// Shared symbol extraction (src/search/symbols.ts): the outline / overview / index use ONE scan.
// New languages get their own patterns; existing languages must keep their exact outline; every pattern
// stays linear on pathological lines (lines are capped at 400 characters).
import { describe, expect, it } from 'vitest';
import { codeSymbols, extractDefs, outline, MAX_LINE } from '../../../src/search/symbols';

const names = (path: string, text: string) => outline(path, text).map((o) => `${o.detail}:${o.text}`);
const defs = (path: string, text: string) => extractDefs(path, text);

describe('new languages (outline)', () => {
  const cases: Array<[string, string, string[]]> = [
    [
      'A.java',
      `package x;
@Deprecated public final class Repo<T> extends Base implements Api {
  private final Map<String, List<Integer>> cache = new HashMap<>();
  public Repo(String name) { super(name); }
  @Override public String toString() {
    if (x) { return foo(1); }
    else if (y) return bar();
    return new Foo(2).call(3);
  }
  public static <T> List<T> listOf(T... items) { return null; }
  abstract void run();
  public interface Api { int size(); }
  enum Kind { A, B }
  record Point(int x, int y) {}
}`,
      ['class:Repo', 'constructor:Repo', 'method:toString', 'method:listOf', 'method:run', 'interface:Api', 'enum:Kind', 'record:Point'],
    ],
    [
      'A.cs',
      `namespace App;
[Serializable] public sealed partial class Store : Base, IStore {
  public Store(int n) : base(n) {}
  public async Task<List<Item>> LoadAsync<TKey>(TKey key) { var x = Make(1); await Save(x); return null; }
  public int Count { get; private set; }
  public string Name => _name;
  private record Item(int Id);
  public interface IStore { void Save(); }
}`,
      ['class:Store', 'constructor:Store', 'method:LoadAsync', 'property:Count', 'property:Name', 'record:Item', 'interface:IStore'],
    ],
    [
      'A.kt',
      `data class User(val id: Int) : Base()
sealed interface Shape
object Registry {
  fun register(x: Any) {}
  suspend fun <T> List<T>.second(): T = this[1]
  private inline fun String.trimAll(): String = trim()
}
enum class Color { RED }
typealias Ids = List<Int>
fun interface Action { fun run() }`,
      ['class:User', 'interface:Shape', 'object:Registry', 'function:register', 'function:second', 'function:trimAll', 'class:Color', 'type:Ids', 'interface:Action'],
    ],
    [
      'A.swift',
      `public final class Cache<Key: Hashable>: Base {
  public init?(size: Int) {}
  override public func get(_ key: Key) -> Value? { nil }
  class func shared() -> Cache { Cache() }
  @objc private func tap() {}
}
struct Point { var x = 0 }
protocol Drawable { func draw() }
extension Point: Drawable { func draw() {} }
typealias Handler = () -> Void`,
      ['class:Cache', 'constructor:init', 'function:get', 'function:shared', 'function:tap', 'struct:Point', 'protocol:Drawable', 'extension:Point', 'type:Handler'],
    ],
    [
      'a.dart',
      `abstract class Shape { double area(); }
mixin Logger on Base {}
class Circle extends Shape {
  const Circle({super.key});
  final double r;
  @override
  double area() => 3.14 * r * r;
  Future<List<int>?> load(String id) async { final x = compute(); return null; }
  int get size => 1;
  set size(int v) {}
}
void main() { runApp(const App()); }
extension Fancy on String {}
typedef Cb = void Function();`,
      ['class:Shape', 'mixin:Logger', 'class:Circle', 'constructor:Circle', 'function:area', 'function:load', 'getter:size', 'setter:size', 'function:main', 'extension:Fancy', 'typedef:Cb'],
    ],
    ['a.sh', `#!/bin/bash\nbuild() {\n  make\n}\nfunction deploy-all {\n  echo\n}\nfunction clean() {\n  if [ x ]; then rm -rf; fi\n}\nmy.helper ()\n{\n  :\n}`, ['function:build', 'function:deploy-all', 'function:clean', 'function:my.helper']],
    ['a.lua', `local function helper(x) end\nfunction M.sub.run(a) end\nfunction Obj:method() end\nM.handler = function(e) end\nlocal cb = function() end`, ['function:helper', 'function:run', 'function:method', 'function:handler', 'function:cb']],
    [
      'a.c',
      `#include <stdio.h>
static int count = 0;
struct point { int x; };
struct point *make(void);
typedef struct node node;
static inline int add(int a, int b)
{
  int c = sum(a, b);
  if (c) { return mul(a, b); }
  printf("%d", c);
  return c;
}
int main(int argc, char **argv) {
  else foo(1);
}
enum color { RED };
void multi(int a,
           int b) {}`,
      ['struct:point', 'function:add', 'function:main', 'enum:color', 'function:multi'],
    ],
    [
      'a.cpp',
      `namespace app {
template <typename T> class Box : public Base {
public:
  explicit Box(T v);
  virtual ~Box() = default;
  T get() const { return value; }
};
}
template <typename T>
Box<T>::Box(T v) : value(v) {}
std::vector<int> Box<int>::values() const { std::cout << x(1) << std::endl; return {}; }
void Widget::paint(QPainter *p) {
  delete make(1);
  std::sort(a.begin(), a.end());
}
enum class Mode { On };`,
      ['namespace:app', 'class:Box', 'function:get', 'method:Box', 'method:values', 'method:paint', 'enum:Mode'],
    ],
    // Per line, at its start: a one-line block (`:root { --x: 1 }`) is not scanned inside.
    ['a.scss', `$brand: #333;\n@mixin button($c) { color: $c; }\n@function rem($px) { @return $px / 16; }\n:root {\n  --gap: 4px;\n}\n:root { --skip: 1; }\n.btn { @include button(red); }`, ['variable:$brand', 'mixin:button', 'function:rem', 'property:--gap']],
    ['a.css', `:root {\n  --bg: #fff;\n  --text-muted: #555;\n}\n.dark { --bg: #000; color: var(--bg); }\n@media (min-width: 1px) { a { color: red } }`, ['property:--bg', 'property:--text-muted']],
    ['a.less', `@primary: #333;\n@media screen and (max-width: 10px) {}\n.mixin() { color: @primary; }\n:root {\n  --x: 1;\n}`, ['variable:@primary', 'property:--x']],
  ];
  for (const [path, text, want] of cases) {
    it(path, () => expect(names(path, text)).toEqual(want));
  }
});

describe('existing languages keep their outline', () => {
  it('prose starting with `functionality` is not a function', () => {
    expect(names('a.js', 'functionality matters\nfunction real() {}\nfunction* gen() {}')).toEqual(['function:real', 'function:gen']);
  });

  it('PHP: classes, functions, methods (the overview shows no properties / constants)', () => {
    const php = `<?php
namespace App\\Models;
use Illuminate\\Database\\Eloquent\\Model;
final class User extends Model {
    use HasFactory, Notifiable;
    public const ADMIN = 'admin';
    protected $table = 'users';
    private ?Team $team = null;
    public function __construct(private readonly Repo $repo) {}
    public static function find(int $id) { return static::query()->find($id); }
}
enum Status: string { case Active = 'a'; case Off = 'o'; }
function helper() {}`;
    expect(names('User.php', php)).toEqual(['class:User', 'function:__construct', 'function:find', 'enum:Status', 'function:helper']);
    expect(codeSymbols('User.php', php).map((s) => `${s.level}:${s.text}`)).toEqual(['1:User', '2:__construct', '2:find', '1:Status', '1:helper']);
  });

  it('JS / TS, Python, Go, Rust, SQL', () => {
    expect(names('a.ts', 'export default class A {}\nexport async function* gen() {}\nconst f = async (x) => x\ntype T = 1\ninterface I {}\nenum E {}')).toEqual(['class:A', 'function:gen', 'function:f', 'type:T', 'interface:I', 'enum:E']);
    expect(names('a.py', 'class A(Base):\n    async def run(self):\n        pass\ndef main():\n    pass')).toEqual(['class:A', 'def:run', 'def:main']);
    expect(names('a.go', 'func (s *Server) Start() error {\n}\nfunc main() {}\ntype Server struct {}')).toEqual(['func:Start', 'func:main', 'type:Server']);
    expect(names('a.rs', 'pub(crate) async fn run() {}\nfn main() {}\nstruct A;\nenum B {}\ntrait C {}')).toEqual(['fn:run', 'fn:main', 'struct:A', 'enum:B', 'trait:C']);
    expect(names('a.sql', 'CREATE TABLE IF NOT EXISTS users (id int);\ncreate or replace view v as select 1;')).toEqual(['sql:users', 'sql:v']);
    expect(names('a.ts', '  if (x) {\n  for (;;) {}\n  return 1')).toEqual([]);
  });
});

describe('extractDefs (index / navigation)', () => {
  it('PHP: namespace, containers, class end, extends, traits, index-only kinds', () => {
    const php = `<?php
namespace App\\Models;

class User extends Model
{
    use HasFactory, \\App\\Concerns\\Notifiable;

    public const ADMIN = 'admin';
    protected $table = 'users';

    public function __construct(
        private readonly Repo $repo,
    ) {}

    public function posts() { $f = function () use ($x) { return 1; }; }
}

enum Status: string
{
    case Active = 'a';
}
function helper() {}`;
    const d = defs('app/Models/User.php', php);
    const by = (n: string) => d.find((x) => x.name === n)!;
    expect(by('User')).toMatchObject({ kind: 'class', line: 3, col: 6, ext: 'Model', ns: 'App\\Models', uses: ['HasFactory', '\\App\\Concerns\\Notifiable'], end: 15 });
    expect(by('ADMIN')).toMatchObject({ kind: 'const', container: 'User', extra: true });
    expect(by('table')).toMatchObject({ kind: 'property', container: 'User', extra: true });
    expect(by('repo')).toMatchObject({ kind: 'property', container: 'User', extra: true });
    expect(by('posts')).toMatchObject({ kind: 'function', container: 'User', line: 14 });
    expect(by('Active')).toMatchObject({ kind: 'case', container: 'Status', extra: true });
    expect(by('helper').container).toBeUndefined();
    expect(by('helper').ns).toBe('App\\Models');
  });

  it('TS: members, fields (index only), columns, extends', () => {
    const ts = `export class Store extends Base<Item> {
  private items: Item[] = [];
  #secret = 1;
  constructor(private name: string) {}
  async load(url: string) {}
  handle = (e: Event) => {};
}`;
    const d = defs('a.ts', ts);
    expect(d.map((x) => `${x.name}:${x.kind}:${x.container ?? ''}:${x.col}${x.extra ? ':extra' : ''}`)).toEqual([
      'Store:class::13',
      'items:property:Store:10:extra',
      '#secret:property:Store:2:extra',
      'constructor:constructor:Store:2',
      'load:method:Store:8',
      'handle:method:Store:2',
    ]);
    expect(d[0]).toMatchObject({ ext: 'Base', end: 6 });
    expect(codeSymbols('a.ts', ts).map((s) => s.text)).toEqual(['Store', 'constructor', 'load', 'handle']); // fields stay out of the overview
  });

  it('Python containers by indentation (nested functions are no members), bases', () => {
    const py = `class A(Base):
    x = 1

    def run(self):
        def inner():
            pass
        return inner

    async def stop(self):
        pass
def main():
    pass
class B:
    def go(self): pass`;
    const d = defs('a.py', py);
    expect(d.map((x) => `${x.name}:${x.container ?? ''}`)).toEqual(['A:', 'run:A', 'inner:', 'stop:A', 'main:', 'B:', 'go:B']);
    expect(d[0]).toMatchObject({ ext: 'Base', end: 9 });
  });

  it('Go receivers, C++ qualified methods, Lua tables, Kotlin bases', () => {
    expect(defs('a.go', 'func (s *Server) Start() {}\nfunc main() {}').map((x) => `${x.name}:${x.container ?? ''}`)).toEqual(['Start:Server', 'main:']);
    expect(defs('a.cpp', 'void Widget::paint(int x) {}').map((x) => `${x.name}:${x.container ?? ''}`)).toEqual(['paint:Widget']);
    expect(defs('a.lua', 'function M.sub.run() end').map((x) => `${x.name}:${x.container ?? ''}`)).toEqual(['run:M.sub']);
    expect(defs('a.kt', 'class A(val x: Int) : Base() {\n  fun go() {}\n}')[0]).toMatchObject({ name: 'A', ext: 'Base', end: 2 });
    expect(defs('a.kt', 'class A(val x: Int) : Base() {\n  fun go() {}\n}')[1]).toMatchObject({ name: 'go', container: 'A' });
  });

  it('columns are exact', () => {
    const d = defs('a.js', 'const a = (a) => a\n  async function aa() {}\nclass b extends c {}');
    expect(d.map((x) => [x.name, x.line, x.col])).toEqual([
      ['a', 0, 6],
      ['aa', 1, 17],
      ['b', 2, 6],
    ]);
  });
});

describe('ReDoS guards: every pattern stays linear on pathological lines', () => {
  const time = (fn: () => unknown) => {
    const t = performance.now();
    fn();
    return performance.now() - t;
  };
  const len = MAX_LINE - 1;
  const pathological = [
    ' '.repeat(len),
    `\t${' \t'.repeat(len / 2 - 1)}`,
    'a '.repeat(len / 2),
    'public '.repeat(Math.floor(len / 7)),
    `public ${'static '.repeat(55)}x`,
    `${'Foo<'.repeat(99)}x`,
    `Map<${'a, '.repeat(130)}`,
    `${'a::'.repeat(130)}b`,
    `int ${'* '.repeat(190)}x`,
    `${'x'.repeat(len)}`,
    `function ${'a.'.repeat(195)}`,
    `${'$a-'.repeat(130)}`,
    `--${'-'.repeat(len - 2)}`,
    `@mixin ${'-'.repeat(390)}`,
    `fun ${'<'.repeat(390)}`,
    `${'@a '.repeat(130)}class`,
    `[${'['.repeat(395)}`,
    `class A ${' '.repeat(380)}: B`,
    `function ${'a'.repeat(380)} ${' '.repeat(10)}`,
    `${'a'.repeat(200)}${' '.repeat(190)}(`,
    `const ${'a'.repeat(100)} = (${'x,'.repeat(140)}`,
    `func (${'a '.repeat(190)}`,
    `use ${'A\\'.repeat(130)}`,
  ];
  const exts = ['java', 'cs', 'kt', 'swift', 'dart', 'sh', 'lua', 'c', 'cpp', 'scss', 'css', 'less', 'php', 'ts', 'js', 'py', 'go', 'rs', 'sql', 'rb'];

  it('400-character adversarial lines, every language: well under a millisecond per line', () => {
    const text = Array.from({ length: 50 }, () => pathological.join('\n')).join('\n'); // ~1,150 lines per language
    for (const ext of exts) {
      const ms = time(() => {
        extractDefs(`x.${ext}`, text);
        outline(`x.${ext}`, text);
      });
      expect(ms, ext).toBeLessThan(400);
    }
  });

  it('longer lines are skipped at once (the cap), whatever they hold', () => {
    const huge = [' '.repeat(200_000), 'public '.repeat(30_000), `${'a::'.repeat(50_000)}b(`].join('\n');
    for (const ext of exts) expect(time(() => extractDefs(`x.${ext}`, huge)), ext).toBeLessThan(150);
    expect(extractDefs('x.c', `${'int '.repeat(200)}main() {}`)).toEqual([]);
  });
});
