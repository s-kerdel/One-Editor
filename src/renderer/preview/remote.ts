// Remote media policy: may a note load images from the internet (tracking pixels, IP leaks)? The email
// client model: the default comes from Settings → Preview ("preview.remoteImages": ask / always / never);
// a folder can override it ("Always for this folder", per-folder renderer state in localStorage
// `sec-edit-remote:<root>`, like `sec-edit-vars:<root>`); "Load" allows one note until the app restarts.
// The sanitizer enforces it (./sanitize: blocked media become placeholders): the static CSP cannot say
// "this folder yes, that one no", so its img-src still lists https: / http:.
// Small and dependency-free: the editor chunk reads it for live-mode images too.
import { app } from '../app/app';

export type RemoteDefault = 'ask' | 'always' | 'never';
export type FolderRemote = 'allow' | 'block';

const allowedNotes = new Set<string>();
const root = () => app.workspace.value?.root ?? '';
const storeKey = () => `sec-edit-remote:${root()}`;

export function remoteDefault(): RemoteDefault {
  const v = app.settings.value['preview.remoteImages'];
  return v === 'always' || v === 'never' ? v : 'ask';
}

export function folderRemote(): FolderRemote | null {
  if (!root()) return null;
  try {
    const v = localStorage.getItem(storeKey());
    return v === 'allow' || v === 'block' ? v : null;
  } catch {
    return null;
  }
}

const changed = () => app.events.emit('media:policy');

/** null = back to the default from Settings. */
export function setFolderRemote(v: FolderRemote | null): void {
  if (!root()) return;
  try {
    if (v) localStorage.setItem(storeKey(), v);
    else localStorage.removeItem(storeKey());
  } catch {}
  changed();
}

/** "Load": this note (and what it embeds), until the app restarts. */
export function allowNoteRemote(path: string): void {
  allowedNotes.add(`${root()}\u0000${path}`);
  changed();
}

export function remoteAllowed(path: string | null | undefined): boolean {
  const f = folderRemote();
  if (f) return f === 'allow';
  const d = remoteDefault();
  if (d !== 'ask') return d === 'always';
  return !!path && allowedNotes.has(`${root()}\u0000${path}`);
}

/** Show the "This note loads images from the internet" bar for blocked media? Not when blocking was chosen. */
export function remoteAsks(): boolean {
  return folderRemote() === null && remoteDefault() === 'ask';
}

// The setting changed (here or in another window): live-mode images and previews re-evaluate.
let lastDefault = remoteDefault();
app.events.on('settings:changed', () => {
  const d = remoteDefault();
  if (d === lastDefault) return;
  lastDefault = d;
  changed();
});
