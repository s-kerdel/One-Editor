// Status-bar corner slot for the MCP icon. Startup code: just the signal — the component and its status
// subscription arrive with the lazy web-server-ui chunk (desktop only, after the idle Popups chunk).
// Set only while MCP is switched on: the corner draws its │ only when something is in it.
import { signal } from '@preact/signals';
import type { ComponentType } from 'preact';

export const mcpIndicator = signal<ComponentType | null>(null);
