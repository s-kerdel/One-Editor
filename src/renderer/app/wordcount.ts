// Word / character count shared by the status bar and the file overview. Its own tiny module so
// a lazy chunk can use it without pulling the status bar (and its imports) out of the startup chunk.
export function countWords(text: string): { words: number; chars: number } {
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}'’_-]*/gu)?.length ?? 0;
  return { words, chars: text.replace(/\n/g, '').length };
}
