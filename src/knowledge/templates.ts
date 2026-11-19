// Daily-note + template helpers (pure). Settings-driven; nothing is stored in the user's folder.
import { normalize } from '@shared/paths';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Moment-style subset: YYYY YY MMMM MMM MM M DD D dddd ddd HH H mm ss; `[literal]` is copied verbatim. */
export function formatDate(d: Date, fmt: string): string {
  return fmt.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|mm|ss/g, (tok, lit) => {
    if (lit !== undefined) return lit;
    switch (tok) {
      case 'YYYY':
        return String(d.getFullYear());
      case 'YY':
        return pad(d.getFullYear() % 100);
      case 'MMMM':
        return MONTHS[d.getMonth()];
      case 'MMM':
        return MONTHS[d.getMonth()].slice(0, 3);
      case 'MM':
        return pad(d.getMonth() + 1);
      case 'M':
        return String(d.getMonth() + 1);
      case 'DD':
        return pad(d.getDate());
      case 'D':
        return String(d.getDate());
      case 'dddd':
        return DAYS[d.getDay()];
      case 'ddd':
        return DAYS[d.getDay()].slice(0, 3);
      case 'HH':
        return pad(d.getHours());
      case 'H':
        return String(d.getHours());
      case 'mm':
        return pad(d.getMinutes());
      case 'ss':
        return pad(d.getSeconds());
    }
    return tok;
  });
}

/** Substitutes {{date}}, {{time}}, {{title}} (and {{date:FORMAT}} / {{time:FORMAT}}). Unknown variables are kept. */
export function applyTemplate(text: string, ctx: { title: string; now?: Date; dateFormat?: string; timeFormat?: string }): string {
  const now = ctx.now ?? new Date();
  return text.replace(/\{\{\s*(date|time|title)\s*(?::([^}]*))?\}\}/gi, (_all, name: string, fmt?: string) => {
    const n = name.toLowerCase();
    if (n === 'title') return ctx.title;
    if (n === 'date') return formatDate(now, fmt?.trim() || ctx.dateFormat || 'YYYY-MM-DD');
    return formatDate(now, fmt?.trim() || ctx.timeFormat || 'HH:mm');
  });
}

export function dailyNotePath(now: Date, folder = 'daily', format = 'YYYY-MM-DD'): string {
  // Characters Windows forbids in file names would make the note impossible to create there.
  const name = formatDate(now, format).replace(/[<>:"|?*\\]/g, '-');
  return normalize(`${folder}/${name}.md`);
}

/** Makes a link target safe to use as a file name on every OS (Windows is the strictest). */
export function sanitizeNoteName(target: string): string {
  return target
    .split('/')
    .map((seg) => seg.replace(/[<>:"|?*\\\u0000-\u001f]/g, '').replace(/[. ]+$/, '').trim())
    .filter((seg) => seg && seg !== '..' && seg !== '.')
    .join('/');
}
