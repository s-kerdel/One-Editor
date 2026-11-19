// Activity-bar icons for the knowledge panels. Separate from icons.tsx so the startup chunk only
// carries these three strings (the panel UI icons load with the panels).
export const svg = (body: string, size = 16) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICON_OUTLINE = svg('<path d="M4 6h16"/><path d="M8 12h12"/><path d="M12 18h8"/><circle cx="4.5" cy="12" r=".6" fill="currentColor"/><circle cx="8.5" cy="18" r=".6" fill="currentColor"/>');
export const ICON_BACKLINKS = svg('<path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5"/>');
export const ICON_TAGS = svg('<path d="M9.5 3 7 21"/><path d="M17 3l-2.5 18"/><path d="M4 8.5h17"/><path d="M3 15.5h17"/>');
