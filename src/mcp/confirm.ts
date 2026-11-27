// Sweeping or unrevertable changes (folder deletes, big batch deletes, replace_in_files over
// MCP_CONFIRM_OVER files) need the user's OK, asked through MCP itself (no OS dialog): the client shows the
// question to the user (protocol.ts CallContext.confirm: elicitation / input_required). A client that cannot
// ask is refused (tools/write.ts askUser): the answer never carries anything the model could use to say yes
// for the user (the one-time code it once did let a prompt-injected model confirm its own deletes).
// What the user is shown is built here: the folder-relative path and a few hidden names, sanitized
// (no control / bidi / zero-width characters, quotes that cannot close the quoted path, long names cut).
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ToolError, binWord } from './protocol';
import { INVISIBLE } from '../shared/mcp';

/** A walk this big is refused (the answer would take too long): delete it in One. */
export const MAX_SURVEY_ENTRIES = 1_000_000;

/** One name as the user sees it: visible characters only, no quote that could end the quoted path. */
export function shownName(s: string, max: number): string {
  const t = s.normalize('NFC').replace(/[\t\n\r\v\f]/g, ' ').replace(INVISIBLE, '\uFFFD').replace(/["“”„‟«»]/g, "'").replace(/\s+/g, ' ').trim();
  const cps = Array.from(t);
  return cps.length > max ? `${cps.slice(0, max - 1).join('')}…` : t;
}

/** A folder-relative path as shown: each part at most 40 characters, the whole at most 120 (its end kept). */
export function shownPath(p: string): string {
  const parts = p.split('/').map((x) => shownName(x, 40));
  let out = parts.join('/');
  while (Array.from(out).length > 120 && parts.length > 1) {
    parts.shift();
    out = `…/${parts.join('/')}`;
  }
  return Array.from(out).length > 120 ? `…${Array.from(out).slice(-119).join('')}` : out;
}

export interface Survey {
  files: number;
  folders: number;
  /** Hidden items directly found (dot names, key files, excluded), first few, as found. */
  hidden: string[];
  hiddenCount: number;
  /** Sizes of everything in it (from the walk's lstat: never a file's contents). */
  bytes: number;
  /** Changes with any entry added, removed, renamed, resized or touched. */
  fingerprint: string;
}

/** Counts a folder's contents without reading any file (hidden ones included; links are not followed). */
export async function surveyFolder(realDir: string, key: string, isHidden: (rel: string) => boolean): Promise<Survey> {
  const s: Survey = { files: 0, folders: 0, hidden: [], hiddenCount: 0, bytes: 0, fingerprint: '' };
  const h = crypto.createHash('sha256');
  let n = 0;
  const walk = async (dir: string, rel: string, inHidden: boolean) => {
    const entries = (await fsp.readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (++n > MAX_SURVEY_ENTRIES) throw new ToolError('ETOOBIG', `${key} holds more than ${MAX_SURVEY_ENTRIES.toLocaleString('en')} entries: delete it in One instead`);
      const r = `${rel}/${e.name}`;
      const abs = path.join(dir, e.name);
      const st = await fsp.lstat(abs).catch(() => null);
      h.update(`${r}\0${e.isDirectory() ? 'd' : e.isSymbolicLink() ? 'l' : 'f'}\0${st?.size ?? -1}\0${st?.mtimeMs ?? -1}\0${st?.ino ?? -1}\n`);
      const hid = !inHidden && isHidden(r);
      if (hid) {
        s.hiddenCount++;
        if (s.hidden.length < 3) s.hidden.push(e.name);
      }
      if (e.isDirectory()) {
        s.folders++;
        await walk(abs, r, inHidden || hid);
      } else {
        s.files++;
        s.bytes += st?.size ?? 0;
      }
    }
  };
  await walk(realDir, key, false);
  s.fingerprint = h.digest('base64url');
  return s;
}

export const count = (n: number, one: string) => `${n.toLocaleString('en')} ${one}${n === 1 ? '' : 's'}`;
export { binWord };

/** The one-line question, for the elicitation and for the two-step summary. */
/** "12 MB", "340 kB", "2.4 GB". */
export function sizeText(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.ceil(b / 1024)} kB`;
  const [n, u] = b < 1024 ** 3 ? [b / 1024 ** 2, 'MB'] : [b / 1024 ** 3, 'GB'];
  return `${n < 10 ? n.toFixed(1).replace(/\.0$/, '') : Math.round(n)} ${u}`;
}

/** Where it goes, as it really is on this platform (Windows: by the user's choice, no prompt for a bin that is
 *  off or too small: Windows then deletes for good, and the question says so). */
export function whereItGoes(platform: string = process.platform): string {
  if (platform === 'win32') return 'It goes to the Recycle Bin; if the bin is off or too small for it, it is deleted permanently.';
  return `It goes to the ${binWord(platform)}.`;
}

const hiddenPart = (names: string[], total: number) => (total ? ` (including hidden items such as ${names.map((x) => shownName(x, 24)).join(', ')}${total > names.length ? ', …' : ''})` : '');

export function folderSummary(key: string, s: Survey, platform: string = process.platform): string {
  return `Delete folder "${shownPath(key)}" and everything in it? ${count(s.files, 'file')}, ${count(s.folders, 'folder')}, ${sizeText(s.bytes)}${hiddenPart(s.hidden, s.hiddenCount)}. ${whereItGoes(platform)}`;
}

/** One question for a batch with folders: the totals and the first few names (sanitized). */
export function batchSummary(items: Array<{ key: string; survey: Survey | null; bytes: number }>, platform: string = process.platform): string {
  const folders = items.filter((i) => i.survey);
  const files = items.length - folders.length;
  const inAll = folders.reduce((a, i) => ({ files: a.files + i.survey!.files, folders: a.folders + i.survey!.folders }), { files, folders: 0 });
  const bytes = items.reduce((n, i) => n + (i.survey ? i.survey.bytes : i.bytes), 0);
  const hidden = folders.flatMap((i) => i.survey!.hidden).slice(0, 3);
  const hiddenCount = folders.reduce((n, i) => n + i.survey!.hiddenCount, 0);
  const first = items.slice(0, 3).map((i) => `"${shownPath(i.key)}"`).join(', ') + (items.length > 3 ? ` and ${items.length - 3} more` : '');
  const what = [folders.length && `${count(folders.length, 'folder')} with everything in them`, files && count(files, 'file')].filter(Boolean).join(' and ');
  return `Delete ${what}: ${first}? ${count(inAll.files, 'file')}, ${count(inAll.folders, 'folder')}, ${sizeText(bytes)} in all${hiddenPart(hidden, hiddenCount)}. ${whereItGoes(platform)}`;
}
