import { describe, expect, it } from 'vitest';
import { braceDepths, codeSymbols } from '../../../src/renderer/overview/symbols';
import { docModel } from '../../../src/renderer/overview/model';

const sym = (path: string, text: string) => codeSymbols(path, text).map((s) => `${s.level}:${s.detail}:${s.text}`);

describe('code symbols (TypeScript)', () => {
  const ts = `import { x } from 'y';

export const MAX = 5;
const cache = new Map();

export interface Item {
  id: string;
}

export class Store {
  private items: Item[] = [];
  constructor(private name: string) {}
  get size() {
    return this.items.length;
  }
  async load(url: string): Promise<void> {
    const res = await fetch(url);
    if (res.ok) {
      this.items = await res.json();
    }
  }
  static create<T>(n: T) {
    return new Store(String(n));
  }
  handle = (e: Event) => {
    console.log(e);
  };
}

export function createStore(name: string) {
  const inner = () => 1;
  return new Store(name);
}

class Empty {}
const after = 1;
`;

  it('classes, members (methods, getters, constructor, arrow fields), functions, top-level consts', () => {
    expect(sym('a.ts', ts)).toEqual([
      '1:const:MAX',
      '1:const:cache',
      '1:interface:Item',
      '1:class:Store',
      '2:constructor:constructor',
      '2:method:size',
      '2:method:load',
      '2:method:create',
      '2:method:handle',
      '1:function:createStore',
      '2:function:inner',
      '1:class:Empty',
      '1:const:after',
    ]);
  });

  it('no members from method bodies (if / calls / inner statements)', () => {
    const names = codeSymbols('a.ts', ts).map((s) => s.text);
    expect(names).not.toContain('if');
    expect(names).not.toContain('fetch');
    expect(names).not.toContain('log');
  });

  it('builds a tree: members nest under their class', () => {
    const o = docModel('tree.ts', ts, false).outline;
    const store = o.findIndex((e) => e.text === 'Store');
    expect(o[store].hasChildren).toBe(true);
    expect(o.filter((e) => e.parent === store).map((e) => e.text)).toEqual(['constructor', 'size', 'load', 'create', 'handle']);
  });
});

describe('code symbols (PHP)', () => {
  it('nests methods by braces, not indentation (an unindented method is still in its class)', () => {
    const php = `<?php
namespace App\\Http\\Controllers;
class UserController extends Controller {
public function index(){ return view('users.index', ['q' => "}"]); }
  public function show(int $id) { return User::findOrFail($id); }
  # a comment with a brace }
  #[Route('/x')]
  private static function helper() {}
}
function top() {}
`;
    expect(sym('UserController.php', php)).toEqual(['1:class:UserController', '2:function:index', '2:function:show', '2:function:helper', '1:function:top']);
  });
});

describe('brace depths', () => {
  it('ignores braces in strings, template literals and comments', () => {
    const src = ['a {', '  "}" + \'{\' + `}`', '  // }', '  /* {', '  } */', '  b {', '  }', '}', 'c'].join('\n');
    expect(Array.from(braceDepths(src))).toEqual([0, 1, 1, 1, 1, 1, 2, 1, 0]);
  });

  it('`#` comments only when asked (PHP), never for `#[attributes]`', () => {
    expect(Array.from(braceDepths('# {\nx', true))).toEqual([0, 0]);
    expect(Array.from(braceDepths('# {\nx', false))).toEqual([0, 1]);
    expect(Array.from(braceDepths('#[A] {\nx', true))).toEqual([0, 1]);
  });

  it('a backslash before a newline inside a string still counts that line', () => {
    expect(Array.from(braceDepths("a {\n  x = 'one \\\n  two';\n  b {\n  }\n}"))).toEqual([0, 1, 1, 1, 2, 1]);
  });
});

describe('other languages keep the indentation levels from the shared scan', () => {
  it('Python', () => {
    expect(sym('a.py', 'class A:\n    def run(self):\n        pass\ndef main():\n    pass\n')).toEqual(['1:class:A', '2:def:run', '1:def:main']);
  });
});
