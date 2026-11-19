// Link hover preview rendering: the excerpt through the preview's own pipeline (markdown-it +
// DOMPurify, resolved {{variables}}). Its own lazy chunk — loaded on the first preview, with the
// preview module (which the reading view and note embeds load anyway).
import { stem } from '@shared/paths';
import { renderMarkdown, renderOptionsFor } from '../preview/index';
import { excerpt } from './excerpt';

export function renderPreview(path: string, text: string, fragment: string | undefined): { html: string; missing: boolean; truncated: boolean } {
  const ex = excerpt(text, fragment, stem(path));
  const html = ex.markdown ? renderMarkdown(ex.markdown, { ...renderOptionsFor(path), sourceLines: false, frontmatter: false }) : '';
  return { html, missing: ex.missing, truncated: ex.truncated };
}
