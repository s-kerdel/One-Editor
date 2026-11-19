// "Developer: Show GPU status" (renderer: app/gpu-status.ts): what Chromium really runs this window on —
// hardware or software compositing / rasterization — so a user can check it on their own machine.
import { app } from 'electron';
import type { GpuStatus } from '../shared/api';

// Switches that change how the GPU is used (set by us, a user's shortcut, or ELECTRON_EXTRA_LAUNCH_ARGS).
const SWITCHES = ['disable-gpu', 'disable-gpu-compositing', 'disable-gpu-rasterization', 'disable-software-rasterizer', 'in-process-gpu', 'use-angle', 'use-gl', 'ignore-gpu-blocklist'];

interface GpuDevice {
  active?: boolean;
  vendorId?: number;
  deviceId?: number;
  vendorString?: string;
  deviceString?: string;
  driverVendor?: string;
  driverVersion?: string;
}

export async function gpuStatus(): Promise<GpuStatus> {
  const info = (await app.getGPUInfo('basic').catch(() => null)) as { gpuDevice?: GpuDevice[] } | null;
  const hex = (n?: number) => (n ? '0x' + n.toString(16).padStart(4, '0') : '?');
  return {
    features: { ...(app.getGPUFeatureStatus() as unknown as Record<string, string>) },
    devices: (info?.gpuDevice ?? []).map(
      (d) => `${d.active ? 'active' : 'inactive'}: ${d.deviceString || d.vendorString || `vendor ${hex(d.vendorId)} device ${hex(d.deviceId)}`}${d.driverVersion ? ` (driver ${d.driverVersion})` : ''}`,
    ),
    switches: SWITCHES.filter((s) => app.commandLine.hasSwitch(s)).map((s) => {
      const v = app.commandLine.getSwitchValue(s);
      return v ? `--${s}=${v}` : `--${s}`;
    }),
  };
}

interface IpcLike {
  handle(channel: string, fn: (e: unknown) => unknown): void;
}

export function registerGpuIpc(ipc: IpcLike, o: { isTrusted: (e: unknown) => boolean }): void {
  ipc.handle('app:gpuStatus', (e) => (o.isTrusted(e) ? gpuStatus() : null));
}
