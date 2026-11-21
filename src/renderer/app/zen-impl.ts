// Zen mode, the part that runs on a toggle (lazy chunk; the startup stub is ./zen.tsx). Entering saves
// the layout parts zen closes (sidebar, file overview, process dock, terminal) and leaving puts back
// exactly that; the tab strip, status bar and classic activity bar have no state of their own, Layout
// leaves them out while ui.zen is set. A user action may still open a panel in zen (it shows on top).
import { batch } from '@preact/signals';
import { app } from './app';
import * as ui from './ui';
import { prettyKey } from './commands';
import { persistSession } from './documents';
import { panelOpen } from '../terminal/state';

/** Settings → Appearance → Zen mode (default: both hidden). */
export const zenKeepsTree = () => app.settings.value['zen.keepFileTree'] === true;
const zenKeepsStatus = () => app.settings.value['zen.keepStatusBar'] === true;

/** "Keep the file tree": the sidebar stays (on Files) if it was showing; else zen hides it. */
function placeSidebar(saved: ui.ZenSaved, keep: boolean) {
  const show = keep && saved.sidebarVisible;
  app.sidebarVisible.value = show;
  app.sidebarPanel.value = show ? 'files' : saved.sidebarPanel;
}

export function setZen(on: boolean) {
  const cur = ui.zen.peek();
  if (on === !!cur) return;
  batch(() => {
    if (on) {
      const saved: ui.ZenSaved = { sidebarVisible: app.sidebarVisible.peek(), sidebarPanel: app.sidebarPanel.peek(), overviewVisible: ui.overviewVisible.peek(), processesOpen: ui.processesOpen.peek(), terminal: panelOpen.peek() };
      ui.zen.value = saved;
      placeSidebar(saved, zenKeepsTree());
      ui.overviewVisible.value = false;
      ui.processesOpen.value = false;
      panelOpen.value = false;
    } else if (cur) {
      ui.zen.value = null;
      app.sidebarVisible.value = cur.sidebarVisible;
      if (app.panels.peek().some((p) => p.id === cur.sidebarPanel)) app.sidebarPanel.value = cur.sidebarPanel;
      ui.overviewVisible.value = cur.overviewVisible;
      ui.processesOpen.value = cur.processesOpen;
      if (cur.terminal) panelOpen.value = true; // its slot is resolved: it was open in this window
    }
  });
  // A panel that just closed may have had the focus (terminal, tree): continue in the text.
  requestAnimationFrame(() => {
    const el = document.activeElement;
    if (!el || el === document.body) app.editor?.focus();
  });
  if (on) hintOnce();
}

export function toggleZen() {
  installZenImpl(); // a toggle before the idle install
  setZen(!ui.zen.peek());
}

function hintOnce() {
  try {
    if (localStorage.getItem('sec-edit-zen-hint')) return;
    localStorage.setItem('sec-edit-zen-hint', '1');
  } catch {}
  app.toast(`Zen mode: ${prettyKey('Mod-Alt-z')} or “Exit zen” at the top right to leave`, 'info', 4000);
}

const syncAttr = () => {
  const v = ui.zenAttr(zenKeepsStatus());
  if (v) document.documentElement.dataset.zen = v;
  else delete document.documentElement.dataset.zen;
};

let installed = false;
/** Loaded on idle (./zen.tsx) or with the first toggle. */
export function installZenImpl() {
  if (installed) return;
  installed = true;
  // Every way zen changes (key, Exit zen, another folder's session) updates <html data-zen> and the skeleton's cache.
  ui.zen.subscribe(() => {
    syncAttr();
    persistSession();
  });
  // Keep options changed (Settings, another window): apply at once while in zen.
  let tree = zenKeepsTree();
  let status = zenKeepsStatus();
  app.settings.subscribe(() => {
    const t = zenKeepsTree();
    const s = zenKeepsStatus();
    if (t === tree && s === status) return;
    const z = ui.zen.peek();
    if (z && t !== tree) placeSidebar(z, t);
    tree = t;
    status = s;
    syncAttr();
    persistSession();
  });
}
