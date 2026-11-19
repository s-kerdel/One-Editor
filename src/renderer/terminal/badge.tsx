// Shell badges: a small tinted tile with a generic glyph per profile kind (no product logos).
// Colours come from the app's file-type tokens, so they follow dark / light themes.
import type { ShellKind } from '@shared/terminal';

type Tone = 'blue' | 'gray' | 'orange' | 'teal' | 'green' | 'neutral';

// 24×24 stroke paths ('|' separates sub-paths), like the app's icon set.
const GLYPH = {
  prompt: 'm6 8 4 4-4 4|M12.5 16H18', // >_  (PowerShell)
  cmd: 'M4 6h16v12H4z|m7.5 10 2 2-2 2|M12 14h4', // a console window
  branch: 'M6 3v12|M18 3a3 3 0 1 0 0 6 3 3 0 1 0 0-6z|M6 15a3 3 0 1 0 0 6 3 3 0 1 0 0-6z|M18 9a9 9 0 0 1-9 9', // Git Bash
  penguin: 'M12 3c-2.4 0-3.8 1.9-3.8 4.3 0 1.2.3 2.1-.6 3.5C6 12.9 5 14.9 5 16.8 5 19.1 8 21 12 21s7-1.9 7-4.2c0-1.9-1-3.9-2.6-6-.9-1.4-.6-2.3-.6-3.5C15.8 4.9 14.4 3 12 3z|M10.2 7.2h.01|M13.8 7.2h.01|M10.8 9.6 12 10.4l1.2-.8', // WSL
  dollar: 'M12 3v18|M16.5 6.5H10a3 3 0 0 0 0 6h4a3 3 0 0 1 0 6H7', // Unix shells
  spark: 'M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9z|M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z', // Claude Code (neutral spark)
} as const;

const LOOK: Record<ShellKind, { tone: Tone; glyph: keyof typeof GLYPH }> = {
  pwsh: { tone: 'blue', glyph: 'prompt' },
  powershell: { tone: 'blue', glyph: 'prompt' },
  cmd: { tone: 'gray', glyph: 'cmd' },
  gitbash: { tone: 'orange', glyph: 'branch' },
  wsl: { tone: 'teal', glyph: 'penguin' },
  bash: { tone: 'green', glyph: 'dollar' },
  zsh: { tone: 'green', glyph: 'dollar' },
  fish: { tone: 'green', glyph: 'dollar' },
  sh: { tone: 'green', glyph: 'dollar' },
  other: { tone: 'green', glyph: 'dollar' },
  claude: { tone: 'neutral', glyph: 'spark' },
};

export const badgeLook = (kind: ShellKind | string) => LOOK[kind as ShellKind] ?? LOOK.other;

/** `size` = tile edge in px. */
export function ShellBadge({ kind, size = 18 }: { kind: ShellKind | string; size?: number }) {
  const look = badgeLook(kind);
  return (
    <span class="se-term-badge" data-tone={look.tone} data-kind={kind} style={{ '--se-badge': `${size}px` }} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        {GLYPH[look.glyph].split('|').map((d) => (
          <path d={d} />
        ))}
      </svg>
    </span>
  );
}
