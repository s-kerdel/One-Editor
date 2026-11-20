// Inline SVG icons (stroke = currentColor, so they follow the theme). No emoji, no icon font, no requests.
import type { JSX } from 'preact';
import { signal } from '@preact/signals';
import { extname, basename } from '@shared/paths';

type P = { size?: number; class?: string; title?: string };

const BOX = 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z';
const PATHS: Record<string, string> = {
  files: 'M15 2H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V6z|M15 2v4h4|M3 7v12a2 2 0 0 0 2 2h9',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z|M20 20l-4-4',
  settings:
    'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z|M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  folder: 'M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2z',
  folderOpen: 'm6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z|M14 3v5h5',
  fileText: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z|M14 3v5h5|M9 13h6|M9 17h4',
  filePlus: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z|M14 3v5h5|M12 11v6|M9 14h6',
  folderPlus: 'M12 10v6|M9 13h6|M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
  chevronRight: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  collapse: 'M7 20l5-5 5 5|M7 4l5 5 5-5',
  close: 'M6 6l12 12|M18 6 6 18',
  plus: 'M12 5v14|M5 12h14',
  code: 'm16 18 6-6-6-6|m8 6-6 6 6 6',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z|M12 2v2|M12 20v2|m4.93 4.93 1.41 1.41|m17.66 17.66 1.41 1.41|M2 12h2|M20 12h2|m6.34 17.66-1.41 1.41|m19.07 4.93-1.41 1.41',
  moon: 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z',
  sidebar: `${BOX}|M9 3v18`,
  filter: 'M22 3H2l8 9.46V19l4 2v-8.54z',
  image: 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z|M9 9a1.5 1.5 0 1 0 0-.01|m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21',
  braces: 'M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1|M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1',
  database: 'M12 3c4.97 0 9 1.34 9 3s-4.03 3-9 3-9-1.34-9-3 4.03-3 9-3z|M3 6v12c0 1.66 4 3 9 3s9-1.34 9-3V6|M3 12c0 1.66 4 3 9 3s9-1.34 9-3',
  terminal: 'm4 17 6-6-6-6|M12 19h8',
  hash: 'M9.5 3 7 21|M17 3l-2.5 18|M4 8.5h17|M3 15.5h17',
  lock: 'M5 11h14v10H5z|M8 11V7a4 4 0 0 1 8 0v4',
};

export type IconName = keyof typeof PATHS;

// Bumped by addIcons(): an <Icon> drawn before its path arrived reads it, so it redraws then.
const registered = signal(0);
let packLoaded = false;
let packRequested = false;

/** Icons only used by lazily loaded UI (menus, settings, welcome) are registered by those chunks,
 *  so their path data stays out of the startup bundle (e.g. `globe`: editor menu; `history`: Popups, Settings, Welcome).
 *  `pack`: the shell's lazy icon pack (./icon-pack) — from then on unknown names draw the generic file icon. */
export function addIcons(paths: Record<string, string>, pack = false): void {
  Object.assign(PATHS, paths);
  if (pack) packLoaded = packRequested = true;
  registered.value++;
}

export function Icon({ name, size = 16, class: cls, title }: P & { name: IconName | string }): JSX.Element {
  let d = PATHS[name];
  if (d === undefined) {
    // Not registered yet: same-size empty box until the icon pack (or the chunk that owns the name) adds it.
    registered.value;
    if (!packRequested) (packRequested = true), import('./icon-pack').catch(() => (packRequested = false));
    d = packLoaded ? PATHS.file : '';
  }
  return (
    <svg class={`se-icon${cls ? ` ${cls}` : ''}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden={title ? undefined : 'true'}>
      {title && <title>{title}</title>}
      {d &&
        d.split('|').map((p) => (
          <path d={p} />
        ))}
    </svg>
  );
}

export const hasIcon = (name: string) => name in PATHS;

/**
 * Renders a SidebarPanel.icon: a shell icon name ("search", "outline", "link"), raw SVG markup from
 * another module, or as a last resort a short text glyph.
 */
export function PanelIcon({ icon, size = 20 }: { icon: string; size?: number }) {
  if (hasIcon(icon)) return <Icon name={icon} size={size} />;
  if (icon.trim().startsWith('<svg')) {
    const sized = icon.replace(/\swidth="\d+"/, ` width="${size}"`).replace(/\sheight="\d+"/, ` height="${size}"`);
    return <span class="se-icon-raw" dangerouslySetInnerHTML={{ __html: sized }} />;
  }
  const legacy: Record<string, IconName> = { '🗀': 'files', '📁': 'files', '🔍': 'search', '🔎': 'search', '🔗': 'link', '☰': 'outline', '#': 'hash' };
  if (legacy[icon]) return <Icon name={legacy[icon]} size={size} />;
  registered.value; // a name a lazy chunk registers later: redraw as an icon then
  return <span class="se-icon-text">{icon.slice(0, 2)}</span>;
}

// ---- file-type icons ------------------------------------------------------------------------

interface FileKind {
  icon: IconName;
  color: string; // CSS color (var) for the glyph
  badge?: string; // tiny label drawn instead of the generic glyph
}

const C = {
  blue: 'var(--ft-blue)',
  yellow: 'var(--ft-yellow)',
  purple: 'var(--ft-purple)',
  green: 'var(--ft-green)',
  orange: 'var(--ft-orange)',
  red: 'var(--ft-red)',
  teal: 'var(--ft-teal)',
  gray: 'var(--ft-gray)',
};

const BY_EXT: Record<string, FileKind> = {
  '.md': { icon: 'fileText', color: C.blue },
  '.markdown': { icon: 'fileText', color: C.blue },
  '.mdx': { icon: 'fileText', color: C.blue },
  '.txt': { icon: 'fileText', color: C.gray },
  '.ts': { icon: 'file', color: C.blue, badge: 'TS' },
  '.tsx': { icon: 'file', color: C.blue, badge: 'TS' },
  '.mts': { icon: 'file', color: C.blue, badge: 'TS' },
  '.js': { icon: 'file', color: C.yellow, badge: 'JS' },
  '.mjs': { icon: 'file', color: C.yellow, badge: 'JS' },
  '.cjs': { icon: 'file', color: C.yellow, badge: 'JS' },
  '.jsx': { icon: 'file', color: C.yellow, badge: 'JS' },
  '.php': { icon: 'file', color: C.purple, badge: 'PHP' },
  '.py': { icon: 'file', color: C.blue, badge: 'PY' },
  '.go': { icon: 'file', color: C.teal, badge: 'GO' },
  '.rs': { icon: 'file', color: C.orange, badge: 'RS' },
  '.java': { icon: 'file', color: C.red, badge: 'J' },
  '.cs': { icon: 'file', color: C.purple, badge: 'C#' },
  '.c': { icon: 'file', color: C.blue, badge: 'C' },
  '.h': { icon: 'file', color: C.purple, badge: 'H' },
  '.cpp': { icon: 'file', color: C.blue, badge: 'C+' },
  '.rb': { icon: 'file', color: C.red, badge: 'RB' },
  '.json': { icon: 'braces', color: C.yellow },
  '.jsonc': { icon: 'braces', color: C.yellow },
  '.yaml': { icon: 'file', color: C.red, badge: 'YML' },
  '.yml': { icon: 'file', color: C.red, badge: 'YML' },
  '.toml': { icon: 'file', color: C.gray, badge: 'TOML' },
  '.ini': { icon: 'file', color: C.gray, badge: 'INI' },
  '.env': { icon: 'lock', color: C.yellow },
  '.css': { icon: 'hash', color: C.blue },
  '.scss': { icon: 'hash', color: C.purple },
  '.less': { icon: 'hash', color: C.blue },
  '.html': { icon: 'code', color: C.orange },
  '.htm': { icon: 'code', color: C.orange },
  '.xml': { icon: 'code', color: C.orange },
  '.vue': { icon: 'code', color: C.green },
  '.svelte': { icon: 'code', color: C.orange },
  '.sql': { icon: 'database', color: C.teal },
  '.sh': { icon: 'terminal', color: C.green },
  '.bash': { icon: 'terminal', color: C.green },
  '.zsh': { icon: 'terminal', color: C.green },
  '.ps1': { icon: 'terminal', color: C.blue },
  '.bat': { icon: 'terminal', color: C.gray },
  '.cmd': { icon: 'terminal', color: C.gray },
  '.png': { icon: 'image', color: C.green },
  '.jpg': { icon: 'image', color: C.green },
  '.jpeg': { icon: 'image', color: C.green },
  '.gif': { icon: 'image', color: C.green },
  '.svg': { icon: 'image', color: C.orange },
  '.webp': { icon: 'image', color: C.green },
  '.avif': { icon: 'image', color: C.green },
  '.ico': { icon: 'image', color: C.green },
  '.bmp': { icon: 'image', color: C.green },
  '.pdf': { icon: 'fileText', color: C.red },
  '.log': { icon: 'fileText', color: C.gray },
  '.csv': { icon: 'database', color: C.green },
  '.lock': { icon: 'lock', color: C.gray },
};

const BY_NAME: Record<string, FileKind> = {
  dockerfile: { icon: 'file', color: C.blue, badge: 'DK' },
  makefile: { icon: 'terminal', color: C.orange },
  '.gitignore': { icon: 'file', color: C.orange, badge: 'GIT' },
  'package.json': { icon: 'braces', color: C.green },
  license: { icon: 'fileText', color: C.yellow },
};

export function fileKind(path: string): FileKind {
  const name = basename(path).toLowerCase();
  return BY_NAME[name] ?? BY_EXT[extname(path)] ?? { icon: 'file', color: C.gray };
}

export function FileIcon({ path, size = 16 }: { path: string; size?: number }) {
  const k = fileKind(path);
  if (k.badge) {
    return (
      <span class="se-ficon se-ficon-badge" style={{ color: k.color, width: `${size}px`, height: `${size}px` }} aria-hidden="true">
        <span style={{ fontSize: k.badge.length > 2 ? '6.5px' : '8px' }}>{k.badge}</span>
      </span>
    );
  }
  return (
    <span class="se-ficon" style={{ color: k.color }} aria-hidden="true">
      <Icon name={k.icon} size={size} />
    </span>
  );
}

export function FolderIcon({ open, size = 16 }: { open: boolean; size?: number }) {
  return (
    <span class="se-ficon se-ficon-folder" aria-hidden="true">
      <Icon name={open ? 'folderOpen' : 'folder'} size={size} />
    </span>
  );
}

export const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif', '.ico', '.bmp']);
export const isImagePath = (p: string) => IMAGE_EXTS.has(extname(p));
