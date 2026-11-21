// Open / closed state of the overview's sections and Connections' sub-sections. A section the user
// never toggled follows its default live (entries → open, none → collapsed; Connections → collapsed);
// a toggle is an explicit choice that wins from then on and is remembered across sessions.
import { signal } from '@preact/signals';

const SECTIONS_KEY = 'sec-edit-overview-sections';

export type SectionChoices = Readonly<Record<string, boolean>>;

function readChoices(): Record<string, boolean> {
  try {
    const v = JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? '{}');
    if (!v || typeof v !== 'object') return {};
    // Older builds stored only `true` (collapsed); those stay explicit choices.
    return Object.fromEntries(Object.entries(v).filter(([, c]) => typeof c === 'boolean')) as Record<string, boolean>;
  } catch {
    return {};
  }
}

/** Explicit choices: id → true (collapsed) / false (open). No entry = never touched: the default applies. */
export const collapsedSections = signal<SectionChoices>(readChoices());

/** The rule: the user's choice, else the default — re-evaluated on every render, so it follows the content. */
export function sectionOpen(choices: SectionChoices, id: string, defaultOpen: boolean): boolean {
  const c = Object.hasOwn(choices, id) ? choices[id] : undefined;
  return typeof c === 'boolean' ? !c : defaultOpen;
}

/** Reads (and subscribes to) the current state of one section. */
export const isSectionOpen = (id: string, defaultOpen: boolean) => sectionOpen(collapsedSections.value, id, defaultOpen);

/** A user toggle: remembered, and it overrides the default from now on. */
export function setSectionCollapsed(id: string, collapsed: boolean) {
  const next = { ...collapsedSections.value, [id]: collapsed };
  collapsedSections.value = next;
  try {
    localStorage.setItem(SECTIONS_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: keep it for this session */
  }
}
