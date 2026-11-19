// Bridge from editor extensions to the app (link opening, image URLs, file lookups).
// Extensions read it lazily so they stay usable (inert) in unit tests without an app.
import { Facet } from '@codemirror/state';

export interface LinkTarget {
  kind: 'wiki' | 'url' | 'file' | 'anchor';
  target: string;
  heading?: string;
}

export interface EditorHost {
  /** Browser-loadable URL for an image reference in `fromPath` (markdown path or wiki embed). */
  imageUrl(src: string, fromPath: string, wiki: boolean): string | null;
  /** Whether a [[target]] resolves to an existing file (unresolved links render faded). */
  wikiExists(target: string, fromPath: string): boolean;
  openLink(link: LinkTarget, fromPath: string, opts: { newTab?: boolean }): void;
  /** Workspace path a [[target]] resolves to. */
  resolveWiki?(target: string, fromPath: string): string | null;
  /** Text of a note for hover previews. */
  readNote?(path: string): Promise<string | null>;
  /** Changes whenever `path` changes (embeds re-render when it does). */
  noteRevision?(path: string): number;
}

let host: EditorHost | null = null;
export function setEditorHost(h: EditorHost | null) {
  host = h;
}
export function getEditorHost(): EditorHost | null {
  return host;
}

/** Workspace-relative path of the document a state belongs to. */
export const docPath = Facet.define<string, string>({ combine: (v) => v[0] ?? '' });
