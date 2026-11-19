// Inline SVG icons (stroke = currentColor so they follow the theme). No emoji, no icon font.
const svg = (body: string, size = 16) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export { ICON_BACKLINKS, ICON_OUTLINE, ICON_TAGS } from './panel-icons';
export const ICON_GRAPH = svg('<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="9" cy="18" r="2.5"/><path d="M8.3 7 15.6 7.7"/><path d="M6.7 8.4 8.4 15.6"/><path d="M16.6 10.1 10.6 16.2"/>');

function Icon({ d, size = 14, cls }: { d: string; size?: number; cls?: string }) {
  return (
    <svg class={cls} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {d.split('|').map((p) => (
        <path d={p} />
      ))}
    </svg>
  );
}

export const Chevron = ({ open }: { open: boolean }) => <Icon d="M9 6l6 6-6 6" size={12} cls={`se-kn-chev${open ? ' open' : ''}`} />;
export const IconLink = () => <Icon d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5|M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" size={12} />;
export const IconFile = () => <Icon d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z|M14 3v5h5" size={13} />;
export const IconFilePlus = () => <Icon d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z|M14 3v5h5|M12 12v6|M9 15h6" size={13} />;
export const IconGraph = () => <span class="se-kn-ico" dangerouslySetInnerHTML={{ __html: ICON_GRAPH.replace('width="16" height="16"', 'width="14" height="14"') }} />;
export const IconCollapse = () => <Icon d="M7 20l5-5 5 5|M7 4l5 5 5-5" size={14} />;
export const IconExpand = () => <Icon d="M7 15l5 5 5-5|M7 9l5-5 5 5" size={14} />;
export const IconSearch = () => <Icon d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z|M20 20l-4-4" size={13} />;
export const IconClose = () => <Icon d="M6 6l12 12|M18 6 6 18" size={14} />;
export const IconHash = () => <Icon d="M9.5 3 7 21|M17 3l-2.5 18|M4 8.5h17|M3 15.5h17" size={12} />;
