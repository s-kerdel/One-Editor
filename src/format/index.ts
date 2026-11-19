// Format module entry (pure API). The renderer integration lives in ./install (kept separate
// so importing it never pulls the formatter core into the startup bundle).
export { formatText, canFormat } from './core';
export { minimalChanges, mapCursor, applyChanges, type TextChange } from './diff';
export { findCodeBlocks, formatCodeBlocks, protectObsidian } from './markdown';
export type { FormatOptions, FormatRequest, FormatResult, FormatIssue } from './types';
