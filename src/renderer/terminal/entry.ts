// Terminal commands + glue (lazy chunk, loaded on idle or first use by ./install). Registers every
// terminal / Claude command when it loads (replacing install's two stubs), installs the keymap filter
// that lets the shell have Ctrl+W/E/N…, and opens the panel. The manager + panel (./impl, same chunk)
// are created on first use; xterm.js is its own chunk, fetched with the first terminal.
import type { EditorView } from '@codemirror/view';
import { app } from '../app/app';
import { registerCommands, setGlobalKeyFilter } from '../app/commands';
import { lazy, onIdle, withModule } from '../app/lazy';
import { picker, promptDialog } from '../app/ui';
import { updateSettings } from '../app/settings';
import { connectTerminalBackend, DESKTOP_ONLY_REASON } from './backend';
import { claudePrompt, type ClaudeAsk } from './claude';
import { APP_KEYS_TAKING_FOCUS, appKeyWinsInTerminal, cmdTracker, watchModifiers } from './keys';
import { createTerminalImpl } from './impl';
import { launcherOpen } from './Panel';
import { panelMax } from './height';
import { AGENT_NAMES, type AgentKind } from '@shared/terminal';
import { followsAgent, readCmdSendsCtrl, readTerminalSettings, TERMINAL_SETTING_KEYS } from './settings';
import { panelOpen } from './state';
import { TerminalPanelSlot } from './install';

type Impl = ReturnType<typeof createTerminalImpl>;
type Manager = Impl['manager'];

const backend = connectTerminalBackend();
const impl = lazy<Impl>(async () => createTerminalImpl(backend, { onHide: hideTerminal }));


export const panelSlot = () => impl.load().then((m) => m.PanelSlot);

export function hideTerminal() {
  panelOpen.value = false;
  app.editor?.focus();
}

/** Opens the panel; starts a first terminal when there is none (and one can be started). */
export async function showTerminal(o: { focus?: boolean; autoStart?: boolean; t0?: number } = {}): Promise<Manager> {
  const t0 = o.t0 ?? performance.now();
  if (backend.available) void import('./view').catch(() => {}); // in parallel with the panel (no-op once loaded)
  const m = (await impl.load()).manager;
  // Show the panel only once its slot component is resolved: then it renders in the same pass. (A slot
  // instance rendered while lazyComponent's preload is still in flight can stay empty — see report.)
  await TerminalPanelSlot.preload();
  panelOpen.value = true;
  await m.whenHost(); // the panel rendered (no fixed frame wait: that alone was ~16–30 ms)
  if (!m.sessions.value.length && (o.autoStart ?? true) && backend.available && app.workspace.value) await m.create({ focus: o.focus ?? true, t0, panel: performance.now() });
  else if (o.focus ?? true) m.active?.view.focus();
  return m;
}

/** Ctrl+`: closed → open + focus; open but focus elsewhere → focus; focused → hide. */
let opening: Promise<Manager> | null = null;

export async function toggleTerminal(): Promise<void> {
  const t0 = performance.now();
  // A second Ctrl+` while the first is still opening (key repeat, double press) must not hide it again.
  if (opening) return void (await opening);
  const m = impl.peek()?.manager;
  if (!panelOpen.value || !m) {
    opening = showTerminal({ t0 });
    try {
      await opening;
    } finally {
      opening = null;
    }
    return;
  }
  const view = m.active?.view;
  if (view && !view.hasFocus()) view.focus();
  else hideTerminal();
}

export async function newTerminal(o: { shellId?: string; preset?: 'claude' | 'opencode' } = {}) {
  const t0 = performance.now();
  const m = await showTerminal({ focus: false, autoStart: false });
  return m.create({ ...o, t0, panel: performance.now() });
}

export async function runInTerminal(code: string, opts: { lang?: string | null; pressEnter?: boolean } = {}): Promise<boolean> {
  if (!backend.available) {
    app.toast(DESKTOP_ONLY_REASON, 'info');
    return false;
  }
  const m = await showTerminal({ focus: false, autoStart: false });
  return m.run(code, opts);
}

/** The active editor's file + selection (1-based lines; a selection ending at a line start excludes that line). */
export function editorAsk(): ClaudeAsk | null {
  const path = app.activePath.value;
  if (!path) return null;
  const st = (app.editor?.getView?.() as EditorView | undefined)?.state;
  const sel = st?.selection.main;
  if (!st || !sel || sel.empty) return { path };
  const a = st.doc.lineAt(sel.from);
  let b = st.doc.lineAt(sel.to);
  if (sel.to === b.from && b.number > a.number) b = st.doc.line(b.number - 1);
  return { path, startLine: a.number, endLine: b.number, text: st.sliceDoc(sel.from, sel.to) };
}

/** "Ask Claude": pre-fill (never submit) a Claude Code prompt about the file / the selection. */
export async function askClaude(what: 'file' | 'selection'): Promise<boolean> {
  const ask = editorAsk();
  if (!ask) return false;
  const m = await showTerminal({ focus: false, autoStart: false });
  return m.askClaude(claudePrompt(what === 'file' ? { path: ask.path } : ask));
}

const hasSelection = () => !!editorAsk()?.startLine;

let installed = false;
export function installTerminalCommands() {
  if (installed) return;
  installed = true;
  const desktop = () => backend.available;
  const hasActive = () => !!impl.peek()?.manager.active;
  const withManager = (fn: (m: Manager) => unknown) => () => withModule(impl, (m) => fn(m.manager));
  const pickShell = (title: string, run: (id: string) => unknown) =>
    withModule(impl, async (m) => {
      const list = await m.manager.loadShells();
      const def = m.manager.defaultShellId(list);
      picker.value = { title, items: (list?.shells ?? []).map((s) => ({ label: s.name, detail: s.path, checked: s.id === def, run: () => run(s.id) })) };
    });
  const os = app.backend?.os ?? 'linux';
  // macOS: a Ctrl chord that a keyboard remapper turned into a Cmd chord stays the shell's (./keys, createCmdTracker).
  if (os === 'darwin') {
    const mode = () => void (cmdTracker.mode = readCmdSendsCtrl(app.settings.value));
    mode();
    app.events.on('settings:changed', mode);
    watchModifiers(window);
  }
  // A focused terminal keeps readline's Ctrl+W/E/N/T/K/B, F-keys for htop/mc…: only a few app keys win.
  setGlobalKeyFilter((e, key) => {
    const t = e.target as HTMLElement | null;
    if (!t?.closest?.('.se-term-view')) return true;
    if (!appKeyWinsInTerminal(key, os, cmdTracker.isCtrl(e))) return false;
    if (APP_KEYS_TAKING_FOCUS.has(key)) t.blur();
    return true;
  });

  registerCommands([
    { id: 'terminal.toggle', title: 'Toggle panel', category: 'Terminal', keys: ['Mod-`', 'Ctrl-`'], keywords: ['console', 'shell', 'command line', 'panel'], run: () => toggleTerminal() },
    { id: 'terminal.new', title: 'New terminal', category: 'Terminal', keys: ['Mod-Shift-`', 'Mod-Shift-~', 'Ctrl-Shift-`', 'Ctrl-Shift-~'], keywords: ['console', 'shell', 'powershell', 'bash'], when: desktop, run: () => void newTerminal() },
    {
      id: 'terminal.newWithShell',
      title: 'New terminal with…',
      category: 'Terminal',
      keywords: ['profile', 'shell', 'powershell', 'cmd', 'wsl', 'git bash', 'zsh', 'claude'],
      when: desktop,
      run: async () => {
        await showTerminal({ focus: false, autoStart: false });
        launcherOpen.value = true; // the launcher card, anchored to its pill
      },
    },
    { id: 'terminal.maximize', title: 'Maximize / restore panel', category: 'Terminal', keywords: ['full', 'zoom', 'bigger'], run: async () => void ((await showTerminal({ focus: false, autoStart: false })) && (panelMax.value = !panelMax.value)) },
    {
      id: 'terminal.selectDefaultShell',
      title: 'Select default shell…',
      category: 'Terminal',
      keywords: ['powershell', 'cmd', 'wsl', 'git bash', 'zsh', 'profile'],
      when: desktop,
      run: () => pickShell('Default shell for new terminals', (id) => updateSettings({ [TERMINAL_SETTING_KEYS.defaultShell]: id })),
    },
    { id: 'terminal.kill', title: 'Kill active terminal', category: 'Terminal', when: hasActive, run: withManager((m) => m.active && m.close(m.active.id)) },
    { id: 'terminal.clear', title: 'Clear', category: 'Terminal', when: hasActive, run: withManager((m) => m.active?.view.clear()) },
    {
      id: 'terminal.rename',
      title: 'Rename…',
      category: 'Terminal',
      when: hasActive,
      run: withManager(async (m) => {
        const s = m.active;
        const name = s && (await promptDialog('Rename terminal', s.title.value, s.shell.name, 'Rename'));
        if (s && name) m.rename(s.id, name);
      }),
    },
    { id: 'terminal.next', title: 'Next terminal', category: 'Terminal', when: hasActive, run: withManager((m) => m.cycle(1)) },
    { id: 'terminal.prev', title: 'Previous terminal', category: 'Terminal', when: hasActive, run: withManager((m) => m.cycle(-1)) },
    {
      id: 'terminal.runSelection',
      title: 'Run selected text',
      category: 'Terminal',
      keywords: ['execute', 'send', 'paste'],
      when: () => desktop() && hasSelection(),
      run: () => void runInTerminal(editorAsk()?.text ?? ''),
    },
    { id: 'claude.open', title: 'Open Claude Code', category: 'Claude', keywords: ['ai', 'assistant', 'claude code', 'agent'], when: desktop, run: () => void newTerminal({ preset: 'claude' }) },
    { id: 'opencode.open', title: 'Open Opencode', category: 'Opencode', keywords: ['ai', 'assistant', 'agent', 'changes'], when: desktop, run: () => void newTerminal({ preset: 'opencode' }) },
    { id: 'claude.askFile', title: 'Ask about this file', category: 'Claude', keywords: ['ai', 'assistant', 'explain', 'review'], when: () => desktop() && !!app.activePath.value, run: () => void askClaude('file') },
    toggleFollow('claude', 'Claude', TERMINAL_SETTING_KEYS.followClaude),
    toggleFollow('opencode', 'Opencode', TERMINAL_SETTING_KEYS.followOpencode),
    {
      // Marks are the same for every agent: one command clears them all (the id is kept from when only Claude had them).
      id: 'claude.clearMarks',
      title: 'Clear change marks',
      category: 'AI changes',
      keywords: ['ai', 'claude', 'opencode', 'follow', 'edits', 'changed', 'turn', 'marks', 'highlight'],
      when: desktop,
      run: () =>
        void import('./follow')
          .then((m) => app.toast(m.clearChangeMarks() ? 'Change marks cleared' : 'No change marks in this file', 'info'))
          .catch(() => {}),
    },
    { id: 'claude.askSelection', title: 'Ask about selection', category: 'Claude', keywords: ['ai', 'assistant', 'explain', 'lines'], when: () => desktop() && hasSelection(), run: () => void askClaude('selection') },
  ]);
}

/**
 * Desktop: warm what the first terminal needs while the app is idle — the shell list (main detects once,
 * then preloads node-pty) and the xterm.js chunk (parsed now, not on the first Ctrl+`). Nothing here
 * starts a shell or a WSL distro.
 */
export function warmUp() {
  if (!backend.available) return;
  onIdle(() => {
    void impl.load().then((m) => m.manager.loadShells());
    onIdle(() => {
      const font = { fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace', fontSize: readTerminalSettings(app.settings.value).fontSize };
      void import('./view').then((v) => onIdle(() => v.warmXterm(font), 2000)).catch(() => {});
    }, 4000);
  }, 3000);
}

/** "Toggle follow edits" of one agent: its own setting, nothing else (the other agent keeps its own). */
function toggleFollow(agent: AgentKind, category: string, key: string) {
  return {
    id: `${agent}.toggleFollow`,
    title: 'Toggle follow edits',
    category,
    keywords: ['ai', 'follow', 'edits', 'highlight', 'hooks', 'changes'],
    when: () => backend.available,
    run: () => {
      const on = !followsAgent(readTerminalSettings(app.settings.value), agent);
      updateSettings({ [key]: on });
      const who = AGENT_NAMES[agent];
      app.toast(on ? `Following ${who}’s edits (new ${who} terminals)` : `No longer following ${who}’s edits`, 'info');
    },
  };
}

/** Is this agent's "follow edits" setting on right now? (Turned off while its terminal runs: its events stop showing.) */
const follows = (agent: unknown): agent is AgentKind => (agent === 'claude' || agent === 'opencode') && followsAgent(readTerminalSettings(app.settings.value), agent);

// "Follow edits": main reports edits of the Claude Code / Opencode terminals it started (term:follow, each event
// names its agent). The UI part (./follow: CodeMirror highlight, toast) is its own chunk, fetched with the first event.
backend.onFollow?.((e) => {
  if (follows(e?.agent)) void import('./follow').then((m) => m.onFollowEvent(e)).catch(() => {});
});

// Loading this chunk = the commands exist (idle preload or the first Ctrl+`).
installTerminalCommands();
warmUp();

// "AI changes": main reports the change list of the agent terminals it started (term:changes). The panel itself is
// its own chunk (./changes/Panel); the lists live in ./changes/store (small, shared by both).
const listed = new Set<number>(); // terminals that reported a list: only their exit concerns the store
backend.onChanges?.((e) => {
  if (!follows(e?.agent)) return;
  listed.add(e.id);
  void import('./changes/store').then((m) => m.applyChanges(e)).catch(() => {});
});
backend.onExit((e) => {
  if (listed.delete(e.id)) void import('./changes/store').then((m) => m.markEnded(e.id)).catch(() => {});
});
