// Zen mode, the part that runs on a toggle (lazy chunk; the startup stub is ./zen.tsx). Entering saves
// the layout parts zen closes (sidebar, file overview, process dock, terminal) and leaving puts back
// exactly that. The tab strip stays; the sidebar and the file overview (if it was open) fold into thin
// strips at the window's edges. Showing a panel in zen (strip click, its shortcut) is a peek over the
// text that closes when you go back to the editor — the panel's own signal, so every shortcut works.
import { batch } from '@preact/signals';
import { app } from './app';
import * as ui from './ui';
import { prettyKey } from './commands';
import { persistSession } from './documents';
import { panelOpen } from '../terminal/state';
import './zen.css';

export { ZenStrip } from './zen-strip';

/** Settings → Appearance → Zen mode, read leniently (missing / odd value = default). `zen.keepFileTree`
 *  (zen before the strips) is not read any more: the strip shows the tree in one click. */
export const zenOptions = (s: Record<string, unknown>) => ({ fullScreen: s['zen.fullScreen'] !== false, keepStatusBar: s['zen.keepStatusBar'] === true });
const opts = () => zenOptions(app.settings.peek() as Record<string, unknown>);

/** Folds the sidebar and the overview into their strips (entering zen; going back to the text). */
const closePeeks = () =>
  batch(() => {
    app.sidebarVisible.value = false;
    ui.overviewVisible.value = false;
  });

export function setZen(on: boolean) {
  const cur = ui.zen.peek();
  if (on === !!cur) return;
  batch(() => {
    if (on) {
      ui.zen.value = { sidebarVisible: app.sidebarVisible.peek(), sidebarPanel: app.sidebarPanel.peek(), overviewVisible: ui.overviewVisible.peek(), processesOpen: ui.processesOpen.peek(), terminal: panelOpen.peek() };
      closePeeks();
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
  app.toast(`Zen mode: ${prettyKey('Mod-Alt-z')} or the zen button (bottom left) to leave. The edge icons show a panel.`, 'info', 5000);
}

// ---- full screen ---------------------------------------------------------------------------------
/** Browser mode: zen put the page into full screen (so leaving zen hands it back). */
let pageFull = false;

/** Desktop: main keeps the window state from before (main/zen-fullscreen.ts). Browser: the Fullscreen API,
 *  only inside the toggle's user gesture; refused (restore after a reload, policy) = zen without it. */
export function zenFullScreen(on: boolean) {
  const b = app.backend;
  if (b?.zenFullScreen) return b.zenFullScreen(on);
  const d = document;
  const kb = (navigator as any).keyboard;
  if (!on) {
    if (!pageFull) return;
    pageFull = false;
    kb?.unlock?.();
    if (d.fullscreenElement) void d.exitFullscreen().catch(() => {});
    return;
  }
  const gesture = (navigator as any).userActivation?.isActive ?? true;
  // Already full screen (the user's own, F11 included): leave it alone, and leave it on when zen ends.
  if (!gesture || d.fullscreenElement || matchMedia('(display-mode: fullscreen)').matches || !d.documentElement.requestFullscreen) return;
  d.documentElement.requestFullscreen({ navigationUI: 'hide' }).then(
    () => {
      pageFull = true;
      // Esc stays the editor's key (find, palette, menus); Chromium leaves full screen on a long Esc then.
      kb?.lock?.(['Escape']).catch(() => {});
    },
    () => {},
  );
}

// ---- peeks ---------------------------------------------------------------------------------------
const PEEK = '.se-zen-peek, .se-zen-strip';
const peeking = () => !!ui.zen.peek() && (app.sidebarVisible.peek() || ui.overviewVisible.peek());

/** Back in the text = a press in the editor card (tabs, text, status bar) or focus moving there (Enter /
 *  Esc in the tree, a search hit). Overlays (menus, dialogs, palette) render outside .se-main: they keep it. */
function installPeeks() {
  addEventListener(
    'pointerdown',
    (e) => {
      const t = e.target as Element;
      if (peeking() && t.closest?.('.se-main') && !t.closest(PEEK)) closePeeks();
    },
    true,
  );
  addEventListener('focusin', (e) => {
    if (peeking() && (e.target as Element).closest?.('.se-content')) closePeeks();
  });
  // Esc in a panel without its own Esc (outline, backlinks…); inputs handle theirs (rename, filter).
  addEventListener('keydown', (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (e.key !== 'Escape' || e.defaultPrevented || !peeking() || !t.closest?.('.se-zen-peek') || /^(INPUT|TEXTAREA)$/.test(t.tagName)) return;
    closePeeks();
    app.editor?.focus();
  });
}

const syncAttr = () => {
  const v = ui.zenAttr(opts().keepStatusBar);
  if (v) document.documentElement.dataset.zen = v;
  else delete document.documentElement.dataset.zen;
};

let installed = false;
/** Loaded on idle (./zen.tsx), at once when the session restores zen, or with the first toggle. */
export function installZenImpl() {
  if (installed) return;
  installed = true;
  installPeeks();
  // The user left full screen (long Esc, F11): zen stays (it works windowed); leaving zen must not touch it.
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement || !pageFull) return;
    pageFull = false;
    (navigator as any).keyboard?.unlock?.();
  });
  // Every way zen changes (key, buttons, another folder's session) updates <html data-zen>, the skeleton's
  // cache and full screen (on a flip only: subscribe also runs now, for a zen the session restored).
  let was = false;
  ui.zen.subscribe((z) => {
    syncAttr();
    persistSession();
    if (!!z === was) return;
    was = !!z;
    if (!was || opts().fullScreen) zenFullScreen(was);
  });
  // Options changed (Settings, another window): apply at once while in zen.
  let { fullScreen, keepStatusBar } = opts();
  app.settings.subscribe(() => {
    const n = opts();
    if (n.keepStatusBar !== keepStatusBar) {
      keepStatusBar = n.keepStatusBar;
      syncAttr();
      persistSession();
    }
    if (n.fullScreen === fullScreen) return;
    fullScreen = n.fullScreen;
    if (ui.zen.peek()) zenFullScreen(fullScreen);
  });
}
