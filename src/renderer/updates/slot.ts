// Status-bar slot for the "Security updates" shield. Startup code: just the signal — the component arrives
// with the lazy updates-ui chunk (desktop only, after the idle Popups chunk) and renders only with findings.
import { signal } from '@preact/signals';
import type { ComponentType } from 'preact';

export const updatesShield = signal<ComponentType | null>(null);
