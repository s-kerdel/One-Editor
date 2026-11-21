// Go back / Go forward buttons at the start of the tab strip (Layout; setting `nav.buttons`).
// Right-click, a long press or Shift+F10 lists the recent places that way (built in the lazy ./impl).
import type { NavDir } from '@shared/nav';
import { Icon } from '../app/icons';
import { NAV_KEYS, navCan, navGo, navPlaces } from './install';

const HOLD_MS = 450;
let timer: ReturnType<typeof setTimeout> | undefined;
/** The press opened the list: its click must not also step. */
let held = false;
const cancel = () => clearTimeout(timer);

function NavButton({ dir }: { dir: NavDir }) {
  const can = navCan[dir].value;
  const name = dir === 'back' ? 'Go back' : 'Go forward';
  return (
    <button
      class="se-width-btn se-navbtn"
      aria-label={name}
      // aria-disabled, not disabled: stays focusable and keeps its right-click list (empty at the end)
      aria-disabled={!can}
      title={`${name} (${NAV_KEYS[dir][1]}) · mouse ${dir} button\nRight-click or hold: recent places`}
      onMouseDown={(e) => e.preventDefault()} // a click / right-click leaves the focus in the editor
      onPointerDown={(e) => {
        held = false;
        cancel();
        const el = e.currentTarget;
        if (e.button === 0) timer = setTimeout(() => ((held = true), navPlaces(dir, el)), HOLD_MS);
      }}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onClick={() => (held ? (held = false) : can && navGo(dir))}
      onContextMenu={(e) => (e.preventDefault(), navPlaces(dir, e.currentTarget))} // also Shift+F10 / the menu key
    >
      <Icon name="arrowLeft" size={16} />
    </button>
  );
}

export function NavButtons() {
  return (
    // no-drag as a whole: with the integrated frame its padding must not cover the sidebar sash's edge
    <div class="se-navbtns se-no-drag" role="group" aria-label="Navigation history">
      <NavButton dir="back" />
      <NavButton dir="forward" />
    </div>
  );
}
