// Overview building blocks shared with sections that live in other chunks (Connections).
import type { ComponentChildren } from 'preact';
import { Icon } from '../app/icons';
import { collapsedSections, setSectionCollapsed } from './hooks';

export function Section(props: { id: string; title: string; count?: number | string | null; countTitle?: string; actions?: ComponentChildren; children: ComponentChildren }) {
  const open = !collapsedSections.value[props.id];
  const bodyId = `se-ov-sec-${props.id}`;
  return (
    <section class={`se-ov-sec${open ? ' open' : ''}`} data-section={props.id}>
      <div class="se-ov-sec-head">
        <button class="se-ov-sec-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setSectionCollapsed(props.id, open)}>
          <span class="se-ov-sec-title">{props.title}</span>
          {props.count != null && (
            <span class="se-ov-count" title={props.countTitle}>
              {props.count}
            </span>
          )}
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
