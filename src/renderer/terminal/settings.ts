// Terminal settings: keys, defaults, a validating reader and the Settings-registry entries
// (spread into settings-registry.ts under a new 'terminal' section in phase 2).
import type { SettingDef } from '../app/settings-registry';
import type { CmdSendsCtrl } from './keys';

export const TERMINAL_SETTING_KEYS = {
  defaultShell: 'terminal.defaultShell',
  fontSize: 'terminal.fontSize',
  scrollback: 'terminal.scrollback',
  runPressesEnter: 'terminal.runPressesEnter',
  gpu: 'terminal.gpuAcceleration',
  cmdSendsCtrl: 'terminal.cmdSendsCtrl',
  prewarm: 'terminal.prewarm',
  followClaude: 'claude.follow',
} as const;

export interface TerminalSettings {
  /** Shell id ('pwsh', 'wsl:Ubuntu', 'bash'…); '' = automatic. */
  defaultShell: string;
  fontSize: number;
  scrollback: number;
  runPressesEnter: boolean;
  /** WebGL renderer: 'auto' (hardware GPU only) | 'on' | 'off'. */
  gpu: 'auto' | 'on' | 'off';
  /** Keep one shell of the default profile started in the background, ready for the next "new terminal". */
  prewarm: boolean;
  /** Show the files Claude Code edits (started from One) as it edits them. */
  followClaude: boolean;
}

// Scrollback is per terminal: 2000 lines × ~120 columns ≈ 3 MB at most each (5000 was ≈ 7 MB).
export const TERMINAL_DEFAULTS: TerminalSettings = { defaultShell: '', fontSize: 13, scrollback: 2000, runPressesEnter: false, gpu: 'auto', prewarm: false, followClaude: true };
export const FONT_RANGE = { min: 8, max: 32 };
export const SCROLLBACK_RANGE = { min: 100, max: 100000 };

const num = (v: unknown, def: number, r: { min: number; max: number }) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(r.max, Math.max(r.min, Math.round(v))) : def);

export function readTerminalSettings(s: Record<string, unknown>): TerminalSettings {
  const K = TERMINAL_SETTING_KEYS;
  const shell = s[K.defaultShell];
  return {
    defaultShell: typeof shell === 'string' && /^[\w.:-]{0,80}$/.test(shell.trim()) ? shell.trim() : '',
    fontSize: num(s[K.fontSize], TERMINAL_DEFAULTS.fontSize, FONT_RANGE),
    scrollback: num(s[K.scrollback], TERMINAL_DEFAULTS.scrollback, SCROLLBACK_RANGE),
    runPressesEnter: typeof s[K.runPressesEnter] === 'boolean' ? (s[K.runPressesEnter] as boolean) : TERMINAL_DEFAULTS.runPressesEnter,
    gpu: s[K.gpu] === 'on' ? 'on' : s[K.gpu] === 'off' ? 'off' : 'auto',
    prewarm: s[K.prewarm] === true,
    followClaude: s[K.followClaude] !== false,
  };
}

/** Registry entries (phase 2: add 'terminal' to SectionId + SECTIONS, then `...TERMINAL_SETTING_DEFS` into defs). */
export type TerminalSettingDef = Omit<SettingDef, 'id' | 'section'> & { section: 'terminal' };

export const TERMINAL_SECTION = { id: 'terminal', title: 'Terminal', icon: 'terminal', blurb: 'The integrated terminal (desktop app).' } as const;

export const TERMINAL_SETTING_DEFS: TerminalSettingDef[] = [
  {
    key: TERMINAL_SETTING_KEYS.defaultShell,
/**
 * macOS key policy (./keys): is a Cmd chord in the terminal read as the Ctrl chord? 'auto' = only when a
 * keyboard remapper made it out of one. Read on its own: only the key handling uses it, not the manager.
 */
export function readCmdSendsCtrl(s: Record<string, unknown>): CmdSendsCtrl {
  const v = s[TERMINAL_SETTING_KEYS.cmdSendsCtrl];
  return v === 'on' ? 'on' : v === 'off' ? 'off' : 'auto';
}

    section: 'terminal',
    label: 'Default shell',
    description: 'Shell id for new terminals (pwsh, cmd, wsl:Ubuntu, bash…). Empty = automatic.',
    keywords: ['powershell', 'cmd', 'bash', 'zsh', 'wsl', 'git bash', 'console'],
    default: TERMINAL_DEFAULTS.defaultShell,
    control: { type: 'text', mono: true, placeholder: 'automatic' },
    desktopOnly: true,
  },
  {
    key: TERMINAL_SETTING_KEYS.fontSize,
    section: 'terminal',
    label: 'Terminal font size',
    description: 'Text size in the terminal panel.',
    keywords: ['zoom', 'text size'],
    default: TERMINAL_DEFAULTS.fontSize,
    control: { type: 'number', ...FONT_RANGE, stepper: true, unit: 'px' },
    desktopOnly: true,
  },
  {
    key: TERMINAL_SETTING_KEYS.scrollback,
    section: 'terminal',
    label: 'Scrollback',
    description: 'Lines of output each terminal keeps.',
    keywords: ['history', 'buffer', 'lines'],
    default: TERMINAL_DEFAULTS.scrollback,
    control: { type: 'number', ...SCROLLBACK_RANGE, step: 1000, unit: 'lines' },
    desktopOnly: true,
  },
  {
    key: TERMINAL_SETTING_KEYS.runPressesEnter,
    section: 'terminal',
    label: '“Run in terminal” presses Enter',
    description: 'Run the pasted command at once instead of leaving it at the prompt.',
    keywords: ['code block', 'execute', 'shell', 'paste'],
    default: TERMINAL_DEFAULTS.runPressesEnter,
    control: { type: 'toggle' },
    desktopOnly: true,
  },
  {
    key: TERMINAL_SETTING_KEYS.prewarm,
    section: 'terminal',
    label: 'Keep a terminal ready',
    description: 'After the first terminal, start the next one in the background so it opens instantly.',
    keywords: ['prewarm', 'fast', 'startup', 'powershell', 'speed'],
    default: TERMINAL_DEFAULTS.prewarm,
    control: { type: 'toggle' },
    desktopOnly: true,
  },
  {
    key: TERMINAL_SETTING_KEYS.gpu,
    section: 'terminal',
    label: 'GPU acceleration',
    description: 'Draw terminal text with WebGL. Automatic: only on a hardware GPU.',
    keywords: ['webgl', 'renderer', 'performance', 'graphics'],
    default: TERMINAL_DEFAULTS.gpu,
    control: { type: 'segmented', options: [{ v: 'auto', label: 'Automatic' }, { v: 'on', label: 'On' }, { v: 'off', label: 'Off' }] },
    desktopOnly: true,
  },
  {
    key: TERMINAL_SETTING_KEYS.followClaude,
    section: 'terminal',
    label: 'Follow Claude’s edits (preview)',
    description: 'Show each file Claude Code changes, at the changed lines. For Claude started from One.',
    keywords: ['claude', 'ai', 'hooks', 'highlight', 'diff', 'agent'],
    default: TERMINAL_DEFAULTS.followClaude,
    control: { type: 'toggle' },
  {
    key: TERMINAL_SETTING_KEYS.cmdSendsCtrl,
    section: 'terminal',
    label: '⌘ chords act as Ctrl (macOS)',
    description: 'For Windows-style key remaps: ⌘C / ⌘R send ^C / ^R. Automatic: only when a remapper made them.',
    keywords: ['karabiner', 'remap', 'windows keyboard', 'control', 'command', 'cmd', 'ctrl+c', 'ctrl+r', 'modifier', 'mac'],
    default: 'auto',
    control: { type: 'segmented', options: [{ v: 'auto', label: 'Automatic' }, { v: 'on', label: 'Always' }, { v: 'off', label: 'Never' }] },
    desktopOnly: true,
  },
    desktopOnly: true,
  },
];
