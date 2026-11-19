// Status-bar slot for the web server pill. Startup code: just the signal — the component arrives with
// the lazy web-server-ui chunk (desktop only, loaded after the idle Popups chunk) and renders only while running.
import { signal } from '@preact/signals';
import type { ComponentType } from 'preact';

export const webServerPill = signal<ComponentType | null>(null);
