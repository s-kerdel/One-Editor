// Minimal stroke icons (16px, currentColor) so the UI looks crisp in both themes.
import { FileIcon } from '../app/icons';

const P = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' } as const;

export const IconSearch = () => (
  <svg {...P}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5 14 14" />
  </svg>
);
export const IconCommand = () => (
  <svg {...P}>
    <path d="M3 4.5 6.5 8 3 11.5M8 12h5" />
  </svg>
);
export const IconHeading = () => (
  <svg {...P}>
    <path d="M4 3v10M12 3v10M4 8h8" />
  </svg>
);
export const IconLine = () => (
  <svg {...P}>
    <path d="M3 4h10M3 8h10M3 12h6" />
  </svg>
);
export const IconChevron = ({ open }: { open: boolean }) => (
  <svg {...P} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }}>
    <path d="M6 4l4 4-4 4" />
  </svg>
);
export const IconReplace = () => (
  <svg {...P}>
    <path d="M2.5 5.5h8l-2-2M13.5 10.5h-8l2 2" />
  </svg>
);
export const IconClose = () => (
  <svg {...P}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);
export const IconCollapse = () => (
  <svg {...P}>
    <path d="M3 3.5h10v9H3zM5.5 8h5" />
  </svg>
);
export const IconRefresh = () => (
  <svg {...P}>
    <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3" />
  </svg>
);
export const IconSymbol = () => (
  <svg {...P}>
    <path d="M8 1.75 13.5 5v6L8 14.25 2.5 11V5z" />
  </svg>
);

/** Same file-type glyphs as the file tree (shell's icon set). */
export function fileIcon(path: string) {
  return <FileIcon path={path} size={14} />;
}
