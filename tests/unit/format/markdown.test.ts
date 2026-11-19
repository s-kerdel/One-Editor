import { describe, it, expect } from 'vitest';
import { formatText, findCodeBlocks, protectObsidian } from '../../../src/format';

const doc = (text: string, options = {}) => formatText(text, { path: 'notes/n.md', options });
const blocks = (text: string, cursorOffset?: number) => formatText(text, { path: 'notes/n.md', mode: cursorOffset === undefined ? 'codeblocks' : 'block', cursorOffset });

const MESSY = `# Deploy notes

Some *prose*   that stays.

\`\`\`php
<?php
function hello($name){return "Hi ".$name;}
\`\`\`

\`\`\`sql
select id,name from users where active=1
\`\`\`

~~~json title="cfg"
{"a":1,
"b":[1,2]}
~~~

1. Step with code:

   \`\`\`js
   const a={b:1}
   if(a){console.log(a)}
   \`\`\`

- \`\`\`ts
  let x:number=1
  \`\`\`

> Quote:
> \`\`\`mysql
> select \`a\` from t
>
> where b=1
> \`\`\`

\`\`\`python
def  keep( ):   pass
\`\`\`

\`\`\`
no   lang
\`\`\`

\`\`\`console
$ ls   -la
\`\`\`
`;

describe('format code blocks in a note', () => {
  it('formats every block by its fence language and nothing else', async () => {
    const r = await blocks(MESSY);
    expect(r.error).toBeUndefined();
    expect(r.blocksFormatted).toBe(6);
    expect(r.warnings).toBeUndefined();
    expect(r.text).toBe(`# Deploy notes

Some *prose*   that stays.

\`\`\`php
<?php
function hello($name)
{
    return 'Hi ' . $name;
}
\`\`\`

\`\`\`sql
SELECT
  id,
  name
FROM
  users
WHERE
  active = 1
\`\`\`

~~~json title="cfg"
{ "a": 1, "b": [1, 2] }
~~~

1. Step with code:

   \`\`\`js
   const a = { b: 1 };
   if (a) {
     console.log(a);
   }
   \`\`\`

- \`\`\`ts
  let x: number = 1;
  \`\`\`

> Quote:
> \`\`\`mysql
> SELECT
>   \`a\`
> FROM
>   t
> WHERE
>   b = 1
> \`\`\`

\`\`\`python
def  keep( ):   pass
\`\`\`

\`\`\`
no   lang
\`\`\`

\`\`\`console
$ ls   -la
\`\`\`
`);
    const again = await blocks(r.text);
    expect(again.text).toBe(r.text);
    expect(again.changed).toBe(false);
    expect(again.blocksFormatted).toBe(0);
  });

  it('formats PHP snippets without an open tag', async () => {
    const r = await blocks('```php\n$a=array(1,2);\nforeach($a as $v){echo $v;}\n```\n');
    expect(r.text).toBe('```php\n$a = [1, 2];\nforeach ($a as $v) {\n    echo $v;\n}\n```\n');
  });

  it('skips blocks with syntax errors and reports them with document lines', async () => {
    const src = 'Intro\n\n```php\n<?php\nfunction x( { }\n```\n\n```json\n{"ok":true}\n```\n\n> ```json\n> {"a": }\n> ```\n';
    const r = await blocks(src);
    expect(r.text).toBe('Intro\n\n```php\n<?php\nfunction x( { }\n```\n\n```json\n{ "ok": true }\n```\n\n> ```json\n> {"a": }\n> ```\n');
    expect(r.blocksFormatted).toBe(1);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings![0]).toMatchObject({ kind: 'syntax', language: 'php', line: 5 });
    expect(r.warnings![0].message).toMatch(/^PHP syntax error at 5:\d+: /);
    expect(r.warnings![1]).toMatchObject({ language: 'json', line: 13 });
    expect(r.warnings![1].message).toMatch(/^JSON syntax error at 13:\d+: /);
  });

  it('formats only the block at the cursor in block mode', async () => {
    const src = '```json\n{"a":1}\n```\n\ntext\n\n```json\n{"b":2}\n```\n';
    const r = await blocks(src, src.indexOf('"b"'));
    expect(r.text).toBe('```json\n{"a":1}\n```\n\ntext\n\n```json\n{ "b": 2 }\n```\n');
    expect((await blocks(src, src.indexOf('text'))).error?.kind).toBe('no-block');
    expect((await blocks('```python\nx\n```\n', 12)).error?.kind).toBe('unsupported');
    const bad = await blocks('```json\n{"a": }\n```\n', 10);
    expect(bad.error?.message).toMatch(/^JSON syntax error at 2:/);
  });

  it('leaves unclosed fences, nested fences and frontmatter alone', async () => {
    const unclosed = '# T\n\n```json\n{"a":1}\n';
    expect((await blocks(unclosed)).text).toBe(unclosed);
    const nested = '````md\n```json\n{"a":1}\n```\n````\n';
    expect((await blocks(nested)).text).toBe(nested);
    const fm = '---\ncode: "```json"\n---\n\n```json\n{"a":1}\n```\n';
    expect((await blocks(fm)).text).toBe('---\ncode: "```json"\n---\n\n```json\n{ "a": 1 }\n```\n');
    const broken = '> ```json\n> {"a":1}\nnot quoted\n\n```json\n{"b":1}\n```\n';
    expect((await blocks(broken)).text).toBe('> ```json\n> {"a":1}\nnot quoted\n\n```json\n{ "b": 1 }\n```\n');
  });

  it('keeps tab-indented and deeply nested containers', async () => {
    const src = '- a\n\t- b\n\n\t\t```json\n\t\t{"a":1}\n\t\t```\n\n> > ```yaml\n> > a:    1\n> > ```\n';
    const r = await blocks(src);
    expect(r.text).toBe('- a\n\t- b\n\n\t\t```json\n\t\t{ "a": 1 }\n\t\t```\n\n> > ```yaml\n> > a: 1\n> > ```\n');
  });

  it('finds blocks with their container prefix', () => {
    const b = findCodeBlocks('> ```php\n> a\n>\n> b\n> ```\n\n   ~~~~sql x\n   q\n   ~~~~\n');
    expect(b.map((x) => [x.info, x.prefix, x.code])).toEqual([
      ['php', '> ', 'a\n\nb'],
      ['sql x', '   ', 'q'],
    ]);
  });
});

const OBSIDIAN = `---
title:   Test
tags: [a,b]
aliases:
    - x
---
# Title
Link to [[Some Note|alias]] and [[Other#Heading^block]] and ![[image.png|200]] and [[  spaced  ]].
> [!note]- Callout title
> Body with ==highlight== and %%hidden *comment*%% and $a_b * c_d$ math.

> [!warning]
> * item

%%
block comment *not* touched
   + weird   spacing
%%

$$
\\frac{a}{b} * x_i * y_i
$$

Text with #tag and #nested/tag and snake_case_word * star, \`[[code|x]]\` stays.
* [ ] task one
* [x] task done ^block-id
    * nested [[link|a]]

| a | b |
|---|---|
| [[x|y]] | $1|2$ |
| ![[e.png|100]] | %%c|d%% |

A paragraph ^para-id

Price is $5 and $6.
#notheading
Footnote[^1] and <span>html</span>.

[^1]: The note.
`;

describe('format document (markdown)', () => {
  it('normalises markdown without breaking Obsidian syntax', async () => {
    const r = await doc(OBSIDIAN);
    expect(r.error).toBeUndefined();
    const t = r.text;
    // frontmatter untouched
    expect(t.startsWith('---\ntitle:   Test\ntags: [a,b]\naliases:\n    - x\n---\n\n# Title\n\n')).toBe(true);
    for (const keep of [
      '[[Some Note|alias]]',
      '[[Other#Heading^block]]',
      '![[image.png|200]]',
      '[[  spaced  ]]',
      '> [!note]- Callout title\n> Body with ==highlight== and %%hidden *comment*%% and $a_b * c_d$ math.',
      '> [!warning]\n>\n> - item',
      '%%\nblock comment *not* touched\n   + weird   spacing\n%%',
      '$$\n\\frac{a}{b} * x_i * y_i\n$$',
      'Text with #tag and #nested/tag and snake_case_word * star, `[[code|x]]` stays.',
      '- [ ] task one\n- [x] task done ^block-id\n  - nested [[link|a]]',
      '| [[x|y]]',
      '| $1|2$',
      '| ![[e.png|100]] | %%c|d%%',
      'A paragraph ^para-id',
      'Price is $5 and $6.\n#notheading',
      'Footnote[^1] and <span>html</span>.',
      '[^1]: The note.',
    ])
      expect(t).toContain(keep);
    // the table still has exactly two columns per row
    const rows = t.split('\n').filter((l) => l.startsWith('|'));
    expect(rows).toHaveLength(4);
    expect(rows[1]).toMatch(/^\| -+ \| -+ \|$/);
    expect(t).not.toMatch(/[-]/);
  });

  it('is idempotent', async () => {
    const once = (await doc(OBSIDIAN)).text;
    const twice = await doc(once);
    expect(twice.text).toBe(once);
    expect(twice.changed).toBe(false);
  });

  it('does not wrap prose and formats code blocks too', async () => {
    const long = 'word '.repeat(60).trim();
    const src = `${long}\n\n*  a\n*  b\n\n\`\`\`php\n<?php\nif($a){echo 1;}\n\`\`\`\n\n\`\`\`json\n{"bad": }\n\`\`\`\n`;
    const r = await doc(src);
    expect(r.text).toBe(`${long}\n\n- a\n- b\n\n\`\`\`php\n<?php\nif ($a) {\n    echo 1;\n}\n\`\`\`\n\n\`\`\`json\n{"bad": }\n\`\`\`\n`);
    expect(r.warnings).toHaveLength(1);
    expect(r.blocksFormatted).toBe(1);
    expect((await doc(r.text)).text).toBe(r.text);
    const noBlocks = await doc(src, { markdownCodeBlocks: false });
    expect(noBlocks.text).toContain('if($a){echo 1;}');
    expect(noBlocks.text).toContain('- a\n- b');
  });

  it('keeps list markers tight regardless of tab settings', async () => {
    const r = await doc('* a\n    * b\n', { tabWidth: 4, useTabs: true });
    expect(r.text).toBe('- a\n  - b\n');
  });

  it('formats code blocks inside lists and callouts in document mode', async () => {
    const src = '1. Step\n\n    ```sql\n    select 1\n    ```\n\n> [!tip]\n> ```json\n> {"a":1}\n> ```\n';
    const r = await doc(src);
    expect(r.text).toBe('1. Step\n\n   ```sql\n   SELECT\n     1\n   ```\n\n> [!tip]\n>\n> ```json\n> { "a": 1 }\n> ```\n');
    expect((await doc(r.text)).text).toBe(r.text);
  });
});

describe('protectObsidian', () => {
  it('round-trips and keeps single-line token width', () => {
    const src = 'a [[b|c]] `[[code]]` %%x%% $y_1$ ![[z]]\n\n```md\n[[in code]]\n```\n%%multi\nline%%\n';
    const p = protectObsidian(src);
    expect(p.text).not.toContain('[[b|c]]');
    expect(p.text).toContain('`[[code]]`');
    expect(p.text).toContain('[[in code]]');
    expect(p.text.split('\n')[0].length).toBe(src.split('\n')[0].length);
    expect(p.restore(p.text)).toBe(src);
  });
  it('detects lost tokens', () => {
    const p = protectObsidian('a [[b]] c [[d]]');
    expect(p.restore(p.text.slice(0, 6))).toBeNull();
  });
});
