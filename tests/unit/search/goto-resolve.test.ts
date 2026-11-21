// Go to definition, end to end on a fake workspace: in-memory files, a real symbol index (SearchEngine,
// vendor/ not indexed — like the app, where it is git-ignored / excluded), and the resolver's env.
import { describe, expect, it } from 'vitest';
import { SearchEngine } from '../../../src/search/engine';
import { resolveDefinition, type GotoEnv } from '../../../src/search/goto/resolve';

const FILES: Record<string, string> = {
  'composer.json': JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'app/' } } }),
  'vendor/composer/autoload_psr4.php': `<?php
$vendorDir = dirname(__DIR__);
$baseDir = dirname($vendorDir);
return array(
    'Acme\\\\Lib\\\\' => array($vendorDir . '/acme/lib/src'),
    'App\\\\' => array($baseDir . '/app'),
);`,
  'vendor/acme/lib/src/Collection.php': `<?php
namespace Acme\\Lib;

class Collection
{
    public function map() {}
}`,
  'vendor/acme/lib/src/Base/Model.php': `<?php
namespace Acme\\Lib\\Base;

abstract class Model
{
    public function save() {}
}`,
  'app/Models/User.php': `<?php
namespace App\\Models;

use Acme\\Lib\\Base\\Model;

class User extends Model
{
    use \\App\\Concerns\\HasName;

    public const ADMIN = 'admin';
    protected $table = 'users';

    public function posts() {}

    public static function make()
    {
        return new static();
    }
}`,
  'app/Models/Admin.php': `<?php
namespace App\\Models;

class Admin extends User
{
    public function posts()
    {
        return parent::posts();
    }

    public function x()
    {
        $this->save();
        self::make();
        static::ADMIN;
        $this->table;
        $this->name();
    }
}`,
  'app/Concerns/HasName.php': `<?php
namespace App\\Concerns;

trait HasName
{
    public function name() {}
}`,
  'app/Http/Controller.php': `<?php
namespace App\\Http;

use App\\Models\\User;
use App\\Models\\{Admin as Boss};
use function App\\Support\\money;
use Acme\\Lib\\Collection;

class Controller
{
    public function show()
    {
        $u = User::make();
        new Boss();
        $c = new Collection();
        money(1);
        helper();
        $x->save();
        jsOnly();
    }
}`,
  'app/Support/helpers.php': '<?php\nnamespace App\\Support;\n\nfunction money() {}\n',
  'app/helpers.php': '<?php\n\nfunction helper() {}\n',
  'app/Other/User.php': '<?php\nnamespace App\\Other;\n\nclass User {}\n',
  'app/Repo.php': '<?php\nnamespace App;\n\nclass Repo\n{\n    public function save() {}\n}\n',
  'app/Post.php': '<?php\nnamespace App;\n\nclass Post\n{\n    public function save() {}\n}\n',
  'web/app.js': 'function helper() {}\nfunction jsOnly() {}\n',
  'src/util.ts': `export function helper() {}

export class Store {
  load() {}
}

export default class Main {}`,
  'src/index.ts': "export { helper as help } from './util';\nexport * from './more';\n",
  'src/more.ts': 'export const deep = () => 1;\n',
  'src/main.ts': `import Main, { Store, helper } from './util';
import * as U from './util';
import { help, deep } from './index';
import { gone } from './missing';

class App extends Store {
  run() {
    this.load();
    this.stop();
    helper();
    U.helper();
    help();
    deep();
    new Main();
    gone();
  }

  stop() {}
}`,
  'src/esm.ts': "import { helper } from './util.js';\nhelper();\n",
  'py/pkg/models.py': 'class User:\n    def save(self):\n        pass\n',
  'py/pkg/views.py': 'from .models import User\n\nclass V(User):\n    def go(self):\n        self.save()\n        User()\n',
  'styles/vars.css': ':root {\n  --brand: red;\n}\n',
  'styles/app.scss': '$gap: 4px;\n@mixin btn {\n}\n.x {\n  color: var(--brand);\n  margin: $gap;\n  @include btn;\n}\n',
};

function makeEnv(files = FILES, opts: { complete?: boolean } = {}) {
  const index = new SearchEngine({ defs: true });
  index.reset(
    Object.entries(files)
      .filter(([p]) => !p.startsWith('vendor/'))
      .map(([path, content]) => ({ path, content })),
  );
  const reads: string[] = [];
  const env: GotoEnv = {
    read: async (p) => (reads.push(p), files[p] ?? null),
    known: (p) => (p in files && !p.startsWith('vendor/') ? p : p.startsWith('vendor/') ? undefined : null),
    lookup: async (q) => index.definitions(q),
    complete: () => opts.complete ?? true,
    memo: new Map(),
  };
  return { env, reads };
}

/** Resolve at the `n`-th occurrence of `needle` in `path` (cursor on its first character, + `shift`). */
async function go(path: string, needle: string, opts: { n?: number; shift?: number; env?: GotoEnv } = {}) {
  const content = FILES[path];
  let at = -1;
  for (let i = 0; i <= (opts.n ?? 0); i++) at = content.indexOf(needle, at + 1);
  if (at < 0) throw new Error(`${needle} not in ${path}`);
  at += opts.shift ?? 0;
  const line = content.slice(0, at).split('\n').length - 1;
  const col = at - (content.lastIndexOf('\n', at - 1) + 1);
  const r = await resolveDefinition({ path, content, line, col }, opts.env ?? makeEnv().env);
  return { r, where: r.hits.map((h) => `${h.path}:${h.line}`), names: r.hits.map((h) => `${h.container ? h.container + '.' : ''}${h.name}`) };
}

describe('PHP', () => {
  it('a `use` import → the class (index by namespace, not the other User)', async () => {
    expect((await go('app/Http/Controller.php', 'User::make')).where).toEqual(['app/Models/User.php:5']);
  });

  it('a static call on an imported class → the method', async () => {
    expect((await go('app/Http/Controller.php', 'make();', {})).where).toEqual(['app/Models/User.php:14']);
  });

  it('group use with alias', async () => {
    expect((await go('app/Http/Controller.php', 'Boss()')).where).toEqual(['app/Models/Admin.php:3']);
  });

  it('a vendor class through PSR-4 (vendor/ is never indexed)', async () => {
    const { env, reads } = makeEnv();
    expect((await go('app/Http/Controller.php', 'Collection()', { env })).where).toEqual(['vendor/acme/lib/src/Collection.php:3']);
    expect(reads).toContain('vendor/composer/autoload_psr4.php');
  });

  it('`use function`, a global function; a PHP call never lands in JavaScript', async () => {
    expect((await go('app/Http/Controller.php', 'money(1)')).where).toEqual(['app/Support/helpers.php:3']);
    expect((await go('app/Http/Controller.php', 'helper()')).where).toEqual(['app/helpers.php:2']);
    expect((await go('app/Http/Controller.php', 'jsOnly()')).where).toEqual([]);
  });

  it('`$obj->x()` on an unknown type: every method of that name (a list to pick from)', async () => {
    expect((await go('app/Http/Controller.php', 'save();')).where).toEqual(['app/Post.php:5', 'app/Repo.php:5']);
  });

  it('members: up the extends chain into vendor/, traits, parent::, self::, static::, properties', async () => {
    expect((await go('app/Models/Admin.php', 'save()')).where).toEqual(['vendor/acme/lib/src/Base/Model.php:5']);
    expect((await go('app/Models/Admin.php', 'name()')).where).toEqual(['app/Concerns/HasName.php:5']);
    expect((await go('app/Models/Admin.php', 'posts();')).where).toEqual(['app/Models/User.php:12']);
    expect((await go('app/Models/Admin.php', 'make()')).where).toEqual(['app/Models/User.php:14']);
    expect((await go('app/Models/Admin.php', 'ADMIN')).names).toEqual(['User.ADMIN']);
    expect((await go('app/Models/Admin.php', 'table;')).names).toEqual(['User.table']);
  });

  it('`extends Model` → vendor; `new static` → the enclosing class; the import line itself', async () => {
    expect((await go('app/Models/User.php', 'Model\n')).where).toEqual(['vendor/acme/lib/src/Base/Model.php:3']);
    expect((await go('app/Models/User.php', 'static()')).where).toEqual(['app/Models/User.php:5']);
    expect((await go('app/Http/Controller.php', 'User;')).where).toEqual(['app/Models/User.php:5']);
    expect((await go('app/Http/Controller.php', 'Models\\User;')).where).toEqual(['app/Models/User.php:5']); // a middle segment
  });

  it('on its own declaration: reported as "defined here"', async () => {
    const { r } = await go('app/Models/User.php', 'User extends');
    expect(r.self).toBe(true);
    expect(r.hits.map((h) => h.path)).toEqual(['app/Models/User.php']);
  });
});

describe('JS / TS', () => {
  it('named / default / namespace imports, re-exports (aliased and *), ESM .js → .ts', async () => {
    expect((await go('src/main.ts', 'Store {')).where).toEqual(['src/util.ts:2']);
    expect((await go('src/main.ts', 'helper();')).where).toEqual(['src/util.ts:0']);
    expect((await go('src/main.ts', 'helper();', { n: 1 })).where).toEqual(['src/util.ts:0']); // U.helper()
    expect((await go('src/main.ts', 'help();')).where).toEqual(['src/util.ts:0']);
    expect((await go('src/main.ts', 'deep();')).where).toEqual(['src/more.ts:0']);
    expect((await go('src/main.ts', 'Main()')).where).toEqual(['src/util.ts:6']);
    expect((await go('src/esm.ts', 'helper();')).where).toEqual(['src/util.ts:0']);
  });

  it('this.x → the class, then its imported parent', async () => {
    expect((await go('src/main.ts', 'stop();')).where).toEqual(['src/main.ts:17']);
    expect((await go('src/main.ts', 'load();')).where).toEqual(['src/util.ts:3']);
  });

  it('the module string opens the file; an import of a missing file finds nothing', async () => {
    const m = await go('src/main.ts', "util'", { shift: 1 });
    expect(m.r.hits[0]).toMatchObject({ path: 'src/util.ts', line: 0, kind: 'file' });
    expect((await go('src/main.ts', 'gone();')).where).toEqual([]);
  });
});

describe('Python, CSS, SCSS', () => {
  it('relative from-import; self.x through the base class', async () => {
    expect((await go('py/pkg/views.py', 'User()')).where).toEqual(['py/pkg/models.py:0']);
    expect((await go('py/pkg/views.py', 'save()')).where).toEqual(['py/pkg/models.py:1']);
  });

  it('custom properties across files, SCSS variables and mixins', async () => {
    expect((await go('styles/app.scss', 'brand)')).where).toEqual(['styles/vars.css:1']);
    expect((await go('styles/app.scss', 'gap;')).where).toEqual(['styles/app.scss:0']);
    expect((await go('styles/app.scss', 'btn;')).where).toEqual(['styles/app.scss:1']);
  });
});

describe('index state', () => {
  it('nothing found while the index is incomplete → pending (not "none"); found → not pending', async () => {
    const env = makeEnv(FILES, { complete: false }).env;
    expect((await go('app/Http/Controller.php', 'jsOnly()', { env })).r.pending).toBe(true);
    expect((await go('app/Http/Controller.php', 'Collection()', { env })).r.pending).toBe(false);
  });

  it('no identifier under the cursor', async () => {
    const r = await resolveDefinition({ path: 'src/more.ts', content: FILES['src/more.ts'], line: 0, col: 23 }, makeEnv().env);
    expect(r.ident).toBeNull();
  });

  it('untrusted paths from file contents are never read', async () => {
    const files = {
      'composer.json': JSON.stringify({ autoload: { 'psr-4': { 'App\\': '../outside/', 'Evil\\': '/etc/' } }, config: { 'vendor-dir': '../../x' } }),
      'a/b.php': '<?php\nuse App\\Thing;\nuse Evil\\Passwd;\nnew Thing();\nnew Passwd();\n',
      'c.ts': "import { x } from '../../../etc/passwd';\nx();\n",
    };
    const { env, reads } = makeEnv(files as Record<string, string>);
    for (const [path, needle] of [
      ['a/b.php', 'Thing()'],
      ['a/b.php', 'Passwd()'],
      ['c.ts', 'x();'],
    ] as const) {
      const content = (files as Record<string, string>)[path];
      const at = content.indexOf(needle);
      const line = content.slice(0, at).split('\n').length - 1;
      await resolveDefinition({ path, content, line, col: at - (content.lastIndexOf('\n', at - 1) + 1) }, env);
    }
    expect(reads.filter((p) => p.includes('..') || p.startsWith('/') || p.includes(':'))).toEqual([]);
    expect(reads).not.toContain('etc/passwd');
  });
});
