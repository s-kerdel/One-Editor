import { describe, expect, it } from 'vitest';
import { excerpt, EXCERPT_LINES } from '../../../src/renderer/knowledge/excerpt';

const NOTE = `---
title: Runbook
tags: [ops]
---

# Runbook

Intro line.

## Access

ssh deploy@api ^access

## Services

### Nginx

Restart with care.

### Database

- migrate
`;

describe('link preview excerpt', () => {
  it('starts after the frontmatter and drops an H1 that repeats the title', () => {
    const ex = excerpt(NOTE, undefined, 'Runbook');
    expect(ex.markdown.startsWith('Intro line.')).toBe(true);
    expect(ex.missing).toBe(false);
    // Kept when it says something else.
    expect(excerpt(NOTE, undefined, 'Other').markdown.startsWith('# Runbook')).toBe(true);
  });

  it('caps the start of a note at ~12 lines', () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const ex = excerpt(long);
    expect(ex.markdown.split('\n')).toHaveLength(EXCERPT_LINES);
    expect(ex.truncated).toBe(true);
    expect(excerpt('short\n\n').truncated).toBe(false);
  });

  it('#heading shows that section, nested headings included, up to the next sibling', () => {
    const ex = excerpt(NOTE, 'Services', 'Runbook');
    expect(ex.markdown).toBe('## Services\n\n### Nginx\n\nRestart with care.\n\n### Database\n\n- migrate');
    expect(excerpt(NOTE, 'nginx').markdown).toBe('### Nginx\n\nRestart with care.');
  });

  it('#^block shows the block without its id', () => {
    expect(excerpt(NOTE, '^access').markdown).toBe('ssh deploy@api');
  });

  it('a missing section falls back to the start of the note', () => {
    const ex = excerpt(NOTE, 'Nope', 'Runbook');
    expect(ex.missing).toBe(true);
    expect(ex.markdown.startsWith('Intro line.')).toBe(true);
  });

  it('closes a code fence the cut went through', () => {
    const text = ['# T', '', '```bash', ...Array.from({ length: 20 }, (_, i) => `echo ${i}`), '```', 'after'].join('\n');
    const ex = excerpt(text, undefined, 'x', 6);
    const lines = ex.markdown.split('\n');
    expect(lines[lines.length - 1]).toBe('```');
    expect(lines.filter((l) => l === '```' || l === '```bash')).toHaveLength(2);
  });

  it('CRLF text works the same', () => {
    expect(excerpt(NOTE.replace(/\n/g, '\r\n'), 'nginx').markdown).toBe('### Nginx\n\nRestart with care.');
  });
});
