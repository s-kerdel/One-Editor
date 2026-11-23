// File type associations (setting `files.associations`): the writes. How a path's language follows from the
// setting is shared/languages.ts (languageForPath); the editor installs it and re-highlights (applySettings).
// Part of the lazy Settings chunk: import it only from there (the status bar's language picker reaches it
// through Settings' re-export), else it becomes a chunk of its own on every preload list.
import { app } from './app';
import { flushSettings, updateSettings } from './settings';
import { cleanAssociations, withAssociation, type FileAssociation } from '@shared/languages';

const KEY = 'files.associations';

/** The rows in effect (the stored value, sanitised). */
export const fileAssociations = (): FileAssociation[] => cleanAssociations(app.settings.value[KEY]);

let staleTimer: ReturnType<typeof setTimeout> | null = null;

/** Sets the language of a canonical pattern, or removes the pattern with null. Open files follow at once. */
export function setFileAssociation(pattern: string, language: string | null) {
  updateSettings({ [KEY]: withAssociation(app.settings.value[KEY], pattern, language) });
  // A covered name is text for the indexer and has its language in the symbol index: rebuild both indexes
  // once the backend has the setting (several quick edits = one rebuild).
  if (staleTimer) clearTimeout(staleTimer);
  staleTimer = setTimeout(() => void flushSettings().then(() => app.events.emit('index:stale')), 700);
}
