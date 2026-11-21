// Overview building blocks shared with sections that live in other chunks (Connections).
import type { ComponentChildren } from 'preact';
import { Icon } from '../app/icons';
import { isSectionOpen, setSectionCollapsed } from './sections';

/** What a header counts: a number / label, `null` = not known yet (a quiet "…"). */
export type HeaderCount = number | string | null;

/** The entry count in a section or sub-section header: one look and place for all of them. */
export function Count({ n, title, class: cls = '' }: { n: HeaderCount; title?: string; class?: string }) {
  return (
    <span class={`se-ov-count${cls ? ` ${cls}` : ''}${n === null ? ' is-pending' : ''}`} title={n === null ? 'Counting…' : title}>
      {n ?? '…'}
    </span>
  );
}

/**
 * A collapsible section. `count` (omit for fact sheets like Info) is shown open or closed;
 * `defaultOpen` applies until the user toggles it (lists: open when they have entries).
 */
export function Section(props: { id: string; title: string; count?: HeaderCount; countTitle?: string; defaultOpen?: boolean; actions?: ComponentChildren; children: ComponentChildren }) {
  const open = isSectionOpen(props.id, props.defaultOpen ?? true);
  const bodyId = `se-ov-sec-${props.id}`;
  return (
    <section class={`se-ov-sec${open ? ' open' : ''}`} data-section={props.id}>
      <div class="se-ov-sec-head">
        <button class="se-ov-sec-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setSectionCollapsed(props.id, open)}>
          <span class="se-ov-sec-title">{props.title}</span>
          {props.count !== undefined && <Count n={props.count} title={props.countTitle} />}
          <Icon name="chevronRight" size={12} class="se-ov-chev" />
        </button>
        {open && props.actions && <div class="se-ov-sec-actions">{props.actions}</div>}
      </div>
      {open && (
        <div class="se-ov-sec-body" id={bodyId}>
          {props.children}
        </div>
      )}
    </section>
  );
}

export function Hint({ children }: { children: ComponentChildren }) {
  return <div class="se-ov-hint">{children}</div>;
}
