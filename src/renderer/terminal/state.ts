// Startup-cheap terminal state: the layout mounts the panel while this is true.
import { signal } from '@preact/signals';

export const panelOpen = signal(false);
