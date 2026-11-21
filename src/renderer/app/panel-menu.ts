// Sidebar menu customisation: setting `sidebar.panels` = { order, hidden } (Settings → Appearance → Sidebar menu,
// the pills' / icon bar's right-click menu). How the bar is built from it is ui.menuPanels (startup code, pure);
// this module holds the writes. Part of the lazy Settings chunk: import it only from there (the pills' "Hide …"
// reaches it through Settings' re-export), else it becomes a chunk of its own on every preload list.
import { app } from './app';
import * as ui from './ui';
import { updateSettings } from './settings';
import { persistSession } from './documents';

export interface MenuPref {
  order: string[];
  hidden: string[];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
/** The stored value, sanitised (settings.json may be hand-edited). */
export const readPref = (v: unknown): MenuPref => ({ order: strings((v as MenuPref | null)?.order), hidden: strings((v as MenuPref | null)?.hidden) });

/** Every registered panel in menu order, hidden ones included. */
export const fullOrder = <T extends { id: string }>(panels: T[], pref: MenuPref): T[] => ui.menuPanels(panels, { order: pref.order });

/**
 * What to store for `order` (the registered panels' ids, newly arranged) and `hidden`. Ids the stored value knew but
 * nobody registers now (a panel of another build sharing settings.json) keep their place and their hidden flag.
 * null = the default again: nothing stored, so the bar follows the defaults (and panels added later) exactly.
 */
export function toPref(order: string[], hidden: Iterable<string>, prev: MenuPref, defaults: readonly string[]): MenuPref | null {
  const known = new Set(defaults);
  const out = order.filter((id) => known.has(id));
  prev.order.forEach((id, i) => {
    if (known.has(id) || out.includes(id)) return;
    const after = prev.order
      .slice(0, i)
      .reverse()
      .find((x) => out.includes(x));
    out.splice(after === undefined ? 0 : out.indexOf(after) + 1, 0, id);
  });
  const hid = [...new Set([...hidden].filter((id) => known.has(id)).concat(prev.hidden.filter((id) => !known.has(id) && out.includes(id))))];
  const foreign = out.some((id) => !known.has(id));
  if (!foreign && !hid.length && out.join('\n') === defaults.join('\n')) return null;
  return { order: out, hidden: hid };
}

export function savePanels(order: string[], hidden: Iterable<string>) {
  const prev = readPref(app.settings.value['sidebar.panels']);
  updateSettings({ 'sidebar.panels': toPref(order, hidden, prev, app.panels.value.map((p) => p.id)) });
}

export function setPanelHidden(id: string, hide: boolean) {
  const pref = readPref(app.settings.value['sidebar.panels']);
  const order = fullOrder(app.panels.value, pref).map((p) => p.id);
  const hidden = new Set(pref.hidden);
  if (hide) hidden.add(id);
  else hidden.delete(id);
  const left = order.filter((x) => !hidden.has(x));
  if (!left.length) return; // at least one entry stays
  savePanels(order, hidden);
  // Hidden from its own pill while shown: show the first one left (else it would stay, being open).
  if (hide && app.sidebarPanel.value === id && app.sidebarVisible.value) {
    app.sidebarPanel.value = left[0];
    persistSession();
  }
}
