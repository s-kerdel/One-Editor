// The OS version of the machine running One — what the Settings build footer (app/build-info.tsx) shows and
// what a bug report needs. Pure parsing/formatting only; the reads live in the backend (backend/service.ts),
// because navigator in the browser would describe the viewing machine, not the one serving the folder.
export interface OsVersionInfo {
  /** process.platform of the backend: 'win32' | 'darwin' | 'linux'. */
  platform: string;
  /** os.release(): Windows "10.0.19045" (build number last), Linux kernel "6.8.0-45-generic", macOS Darwin kernel "24.5.0". */
  release: string;
  /** macOS only: ProductVersion, the number people call the version ("15.5"). os.release() gives the Darwin kernel instead. */
  product?: string;
  /** macOS only: ProductBuildVersion ("24F74"). */
  build?: string;
  /** Linux only: the distro + its version ("Ubuntu 24.04.2 LTS"). */
  distro?: string;
}

/** ProductVersion + ProductBuildVersion out of the XML text of /System/Library/CoreServices/SystemVersion.plist
 *  (a small regex, no plist dependency). Missing keys → undefined, so the caller falls back to os.release(). */
export function macSystemVersion(text: string): { product?: string; build?: string } {
  const at = (key: string) => new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(text)?.[1]?.trim();
  const product = at('ProductVersion');
  const build = at('ProductBuildVersion');
  return { product: product || undefined, build: build || undefined };
}

/** The distro line from /etc/os-release: PRETTY_NAME, else NAME + VERSION_ID. '' when neither is there. */
export function linuxDistro(text: string): string {
  const value = (key: string) => (new RegExp(`^${key}=("?)([^"\\n]*)\\1`, 'm').exec(text)?.[2] ?? '').trim();
  return value('PRETTY_NAME') || [value('NAME'), value('VERSION_ID')].filter(Boolean).join(' ');
}

/** One compact line: "10.0.19045" · "15.5 (24F74)" · "Ubuntu 24.04.2 LTS". '' when nothing is known;
 *  "Darwin …" is labelled so nobody reads the kernel number as the macOS version.
 *  full=true also names the Linux kernel: the distro line already carries its version, and the footer row is narrow. */
export function osVersionText(v: OsVersionInfo | null | undefined, full = false): string {
  if (!v) return '';
  if (v.platform === 'darwin') return v.product ? `${v.product}${v.build ? ` (${v.build})` : ''}` : v.release ? `Darwin ${v.release}` : '';
  if (v.platform === 'linux') {
    if (!v.distro) return v.release ? `kernel ${v.release}` : '';
    return full && v.release ? `${v.distro} · kernel ${v.release}` : v.distro;
  }
  return v.release ?? '';
}
