import { describe, expect, it } from 'vitest';
import { linuxDistro, macSystemVersion, osVersionText } from '../../../src/shared/os-version';

describe('os-version: reading the system files', () => {
  it('takes the macOS version out of SystemVersion.plist (no plist dependency)', () => {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>ProductBuildVersion</key><string>24F74</string>
<key>ProductVersion</key>
<string>15.5</string>
</dict></plist>`;
    expect(macSystemVersion(plist)).toEqual({ product: '15.5', build: '24F74' });
  });

  it('leaves the keys it cannot find undefined, so the caller falls back to os.release()', () => {
    expect(macSystemVersion('<dict><key>ProductName</key><string>macOS</string></dict>')).toEqual({ product: undefined, build: undefined });
    expect(macSystemVersion('')).toEqual({ product: undefined, build: undefined });
  });

  it('reads the distro from /etc/os-release: PRETTY_NAME first', () => {
    expect(linuxDistro(`NAME="Ubuntu"\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.2 LTS"\n`)).toBe('Ubuntu 24.04.2 LTS');
  });

  it('falls back to NAME + VERSION_ID, and handles unquoted values', () => {
    expect(linuxDistro(`NAME="Debian GNU/Linux"\nVERSION_ID="13"\n`)).toBe('Debian GNU/Linux 13');
    expect(linuxDistro('PRETTY_NAME=Arch Linux\n')).toBe('Arch Linux');
    expect(linuxDistro('')).toBe('');
  });
});

describe('os-version: one compact line for the footer', () => {
  it('shows the Windows build number, the last part of os.release()', () => {
    expect(osVersionText({ platform: 'win32', release: '10.0.19045' })).toBe('10.0.19045');
  });

  it('shows the macOS product version + build, not the Darwin kernel number', () => {
    expect(osVersionText({ platform: 'darwin', release: '24.5.0', product: '15.5', build: '24F74' })).toBe('15.5 (24F74)');
    expect(osVersionText({ platform: 'darwin', release: '24.5.0', product: '15.5' })).toBe('15.5');
  });

  it('labels the Darwin kernel when the plist could not be read', () => {
    expect(osVersionText({ platform: 'darwin', release: '24.5.0' })).toBe('Darwin 24.5.0');
  });

  it('shows the Linux distro, and the kernel only in the bug-report line', () => {
    expect(osVersionText({ platform: 'linux', release: '6.8.0-45-generic', distro: 'Ubuntu 24.04.2 LTS' })).toBe('Ubuntu 24.04.2 LTS');
    expect(osVersionText({ platform: 'linux', release: '6.8.0-45-generic', distro: 'Ubuntu 24.04.2 LTS' }, true)).toBe('Ubuntu 24.04.2 LTS · kernel 6.8.0-45-generic');
    expect(osVersionText({ platform: 'linux', release: '6.8.0-45-generic' })).toBe('kernel 6.8.0-45-generic');
  });

  it('says nothing when the backend refused or could not read anything', () => {
    expect(osVersionText(undefined)).toBe('');
    expect(osVersionText(null)).toBe('');
    expect(osVersionText({ platform: 'freebsd', release: '' })).toBe('');
  });
});
