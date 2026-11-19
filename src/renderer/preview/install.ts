// Preview commands. This file is part of the startup bundle: it only points at ./commands (no keys,
// so palette-only: loaded with the palette or once idle after boot). The preview itself (markdown-it,
// DOMPurify, …) is loaded on demand by the shell.
import { addCommandSource } from '../app/commands';

export function installPreview(): void {
  addCommandSource(() => import('./commands').then((m) => m.registerPreviewCommands()));
}
