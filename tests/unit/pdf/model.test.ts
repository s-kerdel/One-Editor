import { describe, expect, it } from 'vitest';
import { classifyLink, clampPage, formatZoom, isPdfPath, MAX_ZOOM, MIN_ZOOM, pageFromFragment, stepZoom } from '../../../src/renderer/pdf/model';

describe('pdf model', () => {
  it('recognises PDF paths case-insensitively', () => {
    expect(isPdfPath('docs/A.PDF')).toBe(true);
    expect(isPdfPath('a.pdf.md')).toBe(false);
    expect(isPdfPath(null)).toBe(false);
  });

  it('steps zoom through the presets and snaps in-between scales', () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(1.37, 1)).toBe(1.5); // fit-width scale → next preset up
    expect(stepZoom(1.37, -1)).toBe(1.25);
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
    expect(stepZoom(NaN, 1)).toBe(1);
  });

  it('formats zoom', () => {
    expect(formatZoom(1.254)).toBe('125%');
  });

  it('clamps go-to-page input', () => {
    expect(clampPage('3', 10)).toBe(3);
    expect(clampPage('0', 10)).toBe(1);
    expect(clampPage(99, 10)).toBe(10);
    expect(clampPage('2.6', 10)).toBe(3);
    expect(clampPage('x', 10)).toBeNull();
    expect(clampPage(1, 0)).toBeNull();
  });

  it('reads #page=N fragments', () => {
    expect(pageFromFragment('page=3')).toBe(3);
    expect(pageFromFragment('#page=12')).toBe(12);
    expect(pageFromFragment('page=0')).toBeNull();
    expect(pageFromFragment('Heading')).toBeNull();
    expect(pageFromFragment(undefined)).toBeNull();
  });

  it('classifies links: internal stays in pdf.js, only http(s)/mailto leave the app', () => {
    expect(classifyLink('#page=2')).toBe('internal');
    expect(classifyLink(null)).toBe('internal');
    expect(classifyLink('https://example.com/x')).toBe('external');
    expect(classifyLink('mailto:a@b.c')).toBe('external');
    expect(classifyLink('javascript:alert(1)')).toBe('blocked');
    expect(classifyLink('file:///etc/passwd')).toBe('blocked');
    expect(classifyLink('ms-msdt:/id')).toBe('blocked');
    expect(classifyLink('app://sec-edit/index.html')).toBe('blocked');
  });
});
