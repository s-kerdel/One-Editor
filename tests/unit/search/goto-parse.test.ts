// Go to definition parsing: PHP namespace / `use` (aliases, group use, function / const), JS / Python
// imports, the identifier under the cursor and its context hints. Linear on pathological input.
import { describe, expect, it } from 'vitest';
import { parseUseBody, phpContext, psr4FromAutoload, resolveClassName, resolveFunctionNames } from '../../../src/search/goto/php';
import { jsDefaultExport, jsImports, jsLocalExport, jsReexports, pyImports } from '../../../src/search/goto/js';
import { hintAt, identAt } from '../../../src/search/goto/context';

describe('PHP use statements', () => {
  const src = `<?php
namespace App\\Http\\Controllers;

use App\\Models\\User;
use App\\Models\\Post as Article, App\\Support\\Str;
use App\\Services\\{Billing, Mail\\Mailer as Postman, function helper, const VERSION};
use function App\\Support\\format_money as money;
use const App\\Config\\LIMIT;
use Illuminate\\Http\\{
    Request,
    Response,
};

class UserController extends Controller
{
    use AuthorizesRequests;

    public function index() { $f = function () use ($x) {}; }
}`;
  const ctx = phpContext(src);

  it('namespace, plain / aliased / group / multi-line imports; traits and closures are not imports', () => {
    expect(ctx.ns).toBe('App\\Http\\Controllers');
    expect(ctx.uses.map((u) => `${u.kind}:${u.alias}=${u.fqn}@${u.line}-${u.endLine}`)).toEqual([
      'class:User=App\\Models\\User@3-3',
      'class:Article=App\\Models\\Post@4-4',
      'class:Str=App\\Support\\Str@4-4',
      'class:Billing=App\\Services\\Billing@5-5',
      'class:Postman=App\\Services\\Mail\\Mailer@5-5',
      'function:helper=App\\Services\\helper@5-5',
      'const:VERSION=App\\Services\\VERSION@5-5',
      'function:money=App\\Support\\format_money@6-6',
      'const:LIMIT=App\\Config\\LIMIT@7-7',
      'class:Request=Illuminate\\Http\\Request@8-11',
      'class:Response=Illuminate\\Http\\Response@8-11',
    ]);
  });

  it('class names: alias, case-insensitive alias, qualified, fully qualified, same namespace, namespace\\', () => {
    expect(resolveClassName('User', ctx)).toBe('App\\Models\\User');
    expect(resolveClassName('article', ctx)).toBe('App\\Models\\Post');
    expect(resolveClassName('Postman', ctx)).toBe('App\\Services\\Mail\\Mailer');
    expect(resolveClassName('Str\\Inner', ctx)).toBe('App\\Support\\Str\\Inner');
    expect(resolveClassName('\\Carbon\\Carbon', ctx)).toBe('Carbon\\Carbon');
    expect(resolveClassName('Controller', ctx)).toBe('App\\Http\\Controllers\\Controller');
    expect(resolveClassName('namespace\\Sub\\X', ctx)).toBe('App\\Http\\Controllers\\Sub\\X');
    expect(resolveClassName('Foo', { ns: '', uses: [] })).toBe('Foo');
  });

  it('functions: `use function` alias, then namespace, then global', () => {
    expect(resolveFunctionNames('money', ctx)).toEqual(['App\\Support\\format_money']);
    expect(resolveFunctionNames('strlen', ctx)).toEqual(['App\\Http\\Controllers\\strlen', 'strlen']);
    expect(resolveFunctionNames('\\strlen', ctx)).toEqual(['strlen']);
  });

  it('several namespaces in one file: the one in effect at the line', () => {
    const two = `<?php\nnamespace A;\nuse X\\One;\nclass P {}\nnamespace B;\nuse Y\\Two;\nclass Q {}`;
    expect(phpContext(two, 3)).toMatchObject({ ns: 'A', uses: [expect.objectContaining({ alias: 'One' })] });
    expect(phpContext(two, 6)).toMatchObject({ ns: 'B', uses: [expect.objectContaining({ alias: 'Two' })] });
  });

  it('malformed bodies give nothing', () => {
    expect(parseUseBody('($x, $y)')).toEqual([]);
    expect(parseUseBody('App\\{A, ../B}')).toEqual([expect.objectContaining({ fqn: 'App\\A' })]);
    expect(parseUseBody('App\\Foo as ../x')).toEqual([]);
  });
});

describe('JS / TS imports', () => {
  const src = `import React, { useState as useS, type FC } from 'react';
import * as util from './util';
import Store from "../store/index.js"
import {
  a,
  b as c,
} from './multi';
import './side-effect.css';
const fs = require('node:fs');
const { join, resolve: res } = require('./paths');
const mod = await import('./lazy');
export { x, y as z } from './re';
export * from './all';
export * as ns from './ns';`;

  it('static, multi-line, namespace, require (plain / destructured), awaited import()', () => {
    expect(jsImports(src).map((i) => `${i.local}<${i.imported}@${i.spec}:${i.line}`)).toEqual([
      'useS<useState@react:0',
      'FC<FC@react:0',
      'React<default@react:0',
      'util<*@./util:1',
      'Store<default@../store/index.js:2',
      'a<a@./multi:3',
      'c<b@./multi:3',
      'fs<*@node:fs:8',
      'join<join@./paths:9',
      'res<resolve@./paths:9',
      'mod<*@./lazy:10',
    ]);
  });

  it('re-exports, local exports, default exports', () => {
    expect(jsReexports(src)).toEqual([
      { names: [{ local: 'x', exported: 'x' }, { local: 'y', exported: 'z' }], spec: './re' },
      { names: null, spec: './all' },
      { names: [{ local: '*', exported: 'ns' }], spec: './ns' },
    ]);
    expect(jsLocalExport('const a = 1;\nexport { a as b, c };', 'b')).toBe('a');
    expect(jsLocalExport('export { a as b } from "./x";', 'b')).toBeNull();
    expect(jsDefaultExport('class A {}\nexport default class Store {}')).toEqual({ name: 'Store', line: 1 });
    expect(jsDefaultExport('const x = 1\nexport default x;\n')).toEqual({ name: 'x', line: 1 });
    expect(jsDefaultExport('export default {\n  name: "c"\n}')).toEqual({ name: null, line: 0 });
    expect(jsDefaultExport('function f() {}\nexport { f as default };')).toEqual({ name: 'f', line: 1 });
    expect(jsDefaultExport('export const a = 1;')).toBeNull();
  });

  it('Python: relative and absolute from-imports, parenthesised lists, aliases', () => {
    const py = 'from .models import User, Post as Article\nfrom ..core.util import (\n    helper,\n    other as o,\n)\nfrom pkg.mod import thing\nimport os';
    expect(pyImports(py).map((i) => `${i.local}<${i.imported}@${'.'.repeat(i.dots)}${i.module}:${i.line}`)).toEqual(['User<User@.models:0', 'Article<Post@.models:0', 'helper<helper@..core.util:1', 'o<other@..core.util:1', 'thing<thing@pkg.mod:5']);
  });

  it('linear on pathological text (runs of blank lines, spaces, dots, unclosed clauses)', () => {
    const t0 = performance.now();
    jsImports('\n'.repeat(200_000) + 'x');
    jsImports(`import ${' '.repeat(100_000)}`);
    jsImports('import {'.repeat(20_000));
    jsReexports(`export {${' '.repeat(100_000)}`);
    jsDefaultExport(`export default foo${' '.repeat(100_000)}x`);
    pyImports(`from ${'.'.repeat(100_000)} x`);
    pyImports(`from ${'.'.repeat(100_000)}`);
    phpContext(`<?php\n${'use '.repeat(30_000)}`);
    phpContext(`<?php\n${'namespace '.repeat(30_000)}`);
    phpContext(`<?php\nuse${' '.repeat(100_000)}x`);
    pyImports(`from${' '.repeat(100_000)}x`);
    jsImports(`import x${' '.repeat(100_000)}y`);
    psr4FromAutoload(`'${'a'.repeat(500)}`.repeat(2000), 'vendor/composer/autoload_psr4.php');
    psr4FromAutoload("'".repeat(1_000_000), 'vendor/composer/autoload_psr4.php');
    const long = `${'a'.repeat(200_000)}->x ${'new a,'.repeat(20_000)}${'b'.repeat(100_000)}`;
    for (const col of [200_002, 250_000, long.length - 5]) {
      const id = identAt(long, col, 'php');
      if (id) hintAt(long, id, 'php');
      const jid = identAt(long, col, 'typescript');
      if (jid) hintAt(long, jid, 'typescript');
    }
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe('multi-start inputs: one linear pass, never a window per line start', () => {
  const time = (fn: () => unknown) => {
    const t = performance.now();
    fn();
    return performance.now() - t;
  };
  const cases: Array<[string, () => unknown]> = [
    ['PHP: 20,000 unfinished `use a`', () => phpContext(`<?php\n${'use a\n'.repeat(20_000)}`)],
    ['PHP: `use` lines and one `;` at the end', () => phpContext(`<?php\n${'use a\n'.repeat(20_000)};`)],
    ['PHP: namespace lines', () => phpContext(`<?php\n${'namespace a\n'.repeat(20_000)}`)],
    ['JS: `import a` lines', () => jsImports('import a\n'.repeat(20_000))],
    ['JS: `import a` lines, a quote at the end', () => jsImports(`${'import a\n'.repeat(20_000)}'x'`)],
    ['JS: `import {` lines', () => jsImports('import {\n'.repeat(20_000))],
    ['JS: `export {` lines', () => jsReexports('export {\n'.repeat(20_000))],
    ['JS: `export {` lines, closed at the end', () => jsLocalExport(`${'export {\n'.repeat(20_000)}}`, 'x')],
    ['JS: `export *` lines', () => jsReexports('export * \n'.repeat(20_000))],
    ['JS: `const {` before a require', () => jsImports(`${'const {\n'.repeat(20_000)}} = require('x')`)],
    ['JS: requires without bindings', () => jsImports("require('a')".repeat(20_000))],
    ['JS: default exports', () => jsDefaultExport('export default \n'.repeat(20_000))],
    ['Python: `from a import (` lines', () => pyImports('from a import (\n'.repeat(20_000))],
    ['Python: `from a import (` lines, closed at the end', () => pyImports(`${'from a import (\n'.repeat(20_000)})`)],
  ];
  for (const [what, fn] of cases) it(what, () => expect(time(fn)).toBeLessThan(150));

  it('a long import clause is read whole (no 2,000-character limit)', () => {
    const names = Array.from({ length: 600 }, (_, i) => `name${i}`);
    const imps = jsImports(`import {\n  ${names.join(',\n  ')}\n} from './many';\nimport after from './after';`);
    expect(imps.find((i) => i.local === 'name599')).toMatchObject({ spec: './many' });
    expect(imps.find((i) => i.local === 'after')).toMatchObject({ imported: 'default', spec: './after' });
  });

  it('parses only the head of a huge text (PARSE_MAX)', () => {
    const huge = `import a from './a';\n${' '.repeat(3_000_000)}\nimport late from './late';`;
    expect(jsImports(huge).map((i) => i.local)).toEqual(['a']);
  });
});

describe('identifier and context hints', () => {
  const at = (line: string, marker = '|', lang = 'php') => {
    const col = line.indexOf(marker);
    const text = line.replace(marker, '');
    const id = identAt(text, col, lang)!;
    return { id, hint: hintAt(text, id, lang) };
  };

  it('identifiers: word under / right before the cursor, sigils, PHP qualified names', () => {
    expect(identAt('foo(bar)', 5, 'javascript')?.name).toBe('bar');
    expect(identAt('foo(bar)', 3, 'javascript')?.name).toBe('foo'); // right after the word
    expect(identAt('a + 12', 4, 'javascript')).toBeNull();
    expect(identAt('  ', 1, 'javascript')).toBeNull();
    expect(identAt('color: var(--text-muted);', 14, 'css')?.name).toBe('--text-muted');
    expect(identAt('color: $brand-dark;', 10, 'scss')?.name).toBe('$brand-dark');
    expect(identAt('this.#secret = 1', 7, 'typescript')?.name).toBe('#secret');
    expect(identAt('$user->name', 2, 'php')?.name).toBe('user');
    expect(identAt('new \\App\\Models\\User()', 17, 'php')).toMatchObject({ name: 'User', qualified: '\\App\\Models\\User' });
    expect(identAt('deploy-all() {', 3, 'shell')?.name).toBe('deploy-all');
  });

  it('PHP hints', () => {
    expect(at('$this->|save();').hint).toMatchObject({ mode: 'member', receiver: 'this', want: 'method', call: true });
    expect(at('$this->|repo->find();').hint).toMatchObject({ mode: 'member', receiver: 'this', want: 'property' });
    expect(at('$user->|save();').hint).toMatchObject({ mode: 'member', receiver: '', want: 'method' });
    expect(at('$this->repo->|find();').hint).toMatchObject({ mode: 'member', receiver: '' });
    expect(at('self::|create();').hint).toMatchObject({ mode: 'member', receiver: 'this', want: 'method' });
    expect(at('static::|$cache').hint).toMatchObject({ mode: 'member', receiver: 'this', want: 'member' });
    expect(at('parent::|__construct();').hint).toMatchObject({ mode: 'member', receiver: 'super' });
    expect(at('Status::|Active').hint).toMatchObject({ mode: 'member', receiver: 'Status', want: 'member' });
    expect(at('\\App\\Models\\User::|find(1)').hint).toMatchObject({ receiver: '\\App\\Models\\User', want: 'method' });
    expect(at('return new |User($x);').hint).toMatchObject({ mode: 'plain', want: 'class', call: true });
    expect(at('class A extends |Base implements X').hint.want).toBe('class');
    expect(at('class A extends Base implements X, |Y').hint.want).toBe('class');
    expect(at('function x(|Request $r): Response').hint.want).toBe('class');
    expect(at('function x(Request $r): |Response').hint.want).toBe('class');
    expect(at('} catch (|Exception $e) {').hint.want).toBe('class');
    expect(at('|User::class').hint.want).toBe('class');
    expect(at('#[|Route("/x")]').hint.want).toBe('class');
    expect(at('$x = |helper(1);').hint).toMatchObject({ mode: 'plain', want: 'callable', call: true });
    expect(at('use App\\Models\\|User;').hint).toMatchObject({ want: 'class', importLine: true });
  });

  it('JS / Python / CSS hints', () => {
    expect(at('this.|load()', '|', 'typescript').hint).toMatchObject({ mode: 'member', receiver: 'this', want: 'method' });
    expect(at('super.|load()', '|', 'typescript').hint).toMatchObject({ mode: 'member', receiver: 'super' });
    expect(at('Store.|create()', '|', 'typescript').hint).toMatchObject({ mode: 'member', receiver: 'Store' });
    expect(at('a.b().|c()', '|', 'typescript').hint).toMatchObject({ mode: 'member', receiver: '' });
    expect(at('x?.|y', '|', 'typescript').hint).toMatchObject({ mode: 'member', receiver: 'x', want: 'member' });
    expect(at('const s = new |Store()', '|', 'typescript').hint.want).toBe('class');
    expect(at('let s: |Store', '|', 'typescript').hint.want).toBe('class');
    expect(at('|makeUser(1)', '|', 'typescript').hint).toMatchObject({ want: 'callable', call: true });
    expect(at("import { |a } from './x'", '|', 'typescript').hint.importLine).toBe(true);
    expect(at('self.|run()', '|', 'python').hint).toMatchObject({ mode: 'member', receiver: 'this' });
    expect(at('super().|run()', '|', 'python').hint).toMatchObject({ mode: 'member', receiver: 'super' });
    expect(at('color: var(|--bg)', '|', 'css').hint.want).toBe('property');
    expect(at('@include |button(red);', '|', 'scss').hint.want).toBe('mixin');
  });
});
