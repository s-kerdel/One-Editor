// Shell icons no first-screen control draws (menus, dialogs, panels, the open file's status-bar and
// tab-strip parts). Lazy: imported by the chunks that draw them (Popups, Settings, doc-chrome, …) and
// requested by <Icon> itself the first time it meets a name it doesn't know (app/icons.tsx).
import { addIcons } from './icons';

const BOX = 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z';
addIcons(
  {
    outline: 'M4 6h16|M8 12h12|M12 18h8',
    link: 'M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5|M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5',
    refresh: 'M3 12a9 9 0 0 1 15.5-6.36L21 8|M21 3v5h-5|M21 12a9 9 0 0 1-15.5 6.36L3 16|M3 21v-5h5',
    eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z|M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
    pencil: 'M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z|m15 5 4 4',
    columns: `${BOX}|M12 3v18`,
    copy: 'M8 8h12v12H8z|M4 16V4h12',
    alert: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3|M12 9v4|M12 17h.01',
    check: 'M20 6 9 17l-5-5',
    info: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z|M12 16v-4|M12 8h.01',
    more: 'M12 12h.01|M19 12h.01|M5 12h.01',
    split: 'M12 3v18|M3 12h6|M15 12h6',
    // content width (tab strip): a page whose text lines are narrow / wider / edge to edge
    wreadable: `${BOX}|M10 8h4|M10 12h4|M10 16h4`,
    wwide: `${BOX}|M7 8h10|M7 12h10|M7 16h10`,
    wfull: `${BOX}|M3 8h18|M3 12h18|M3 16h18`,
  },
  true,
);
