// Status-bar slot for the environment / target pills. Startup code: just the signal — the component
// arrives with the lazy variables chunk, and renders nothing for folders without variables.
import { signal } from '@preact/signals';
import type { ComponentType } from 'preact';

export const varsStatus = signal<ComponentType | null>(null);
