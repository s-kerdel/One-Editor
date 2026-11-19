// "Developer: Show GPU status" (lazy chunk): is this window drawn with the GPU or in software? Main reports
// Chromium's own verdict (app.getGPUFeatureStatus, desktop only); the page adds what it can see itself
// (the WebGL renderer, display refresh rate). Software compositing makes every repaint — hover feedback
// included — cost CPU, so this is the first thing to check when the app feels heavy on a machine.
import { app } from './app';
import * as ui from './ui';
import { copyText } from './fileops';

const SOFTWARE_GL = /swiftshader|llvmpipe|softpipe|software|basic render|mesa offscreen/i;

function webglRenderer(): string {
  try {
    const gl = document.createElement('canvas').getContext('webgl2') ?? document.createElement('canvas').getContext('webgl');
    if (!gl) return 'unavailable';
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const r = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext(); // give the probe context back right away
    return r;
  } catch {
    return 'unavailable';
  }
}

/** Frames per second the display actually delivers (requestAnimationFrame over ~0.5 s). */
function refreshRate(): Promise<number> {
  return new Promise((resolve) => {
    let n = 0;
    const t0 = performance.now();
    const tick = (t: number) => (t - t0 < 500 ? (n++, requestAnimationFrame(tick)) : resolve(Math.round((n * 1000) / (t - t0))));
    requestAnimationFrame(tick);
  });
}

export async function showGpuStatus() {
  const [status, hz] = await Promise.all([app.backend.gpuStatus?.() ?? Promise.resolve(null), refreshRate()]);
  const gl = webglRenderer();
  const compositing = status?.features.gpu_compositing;
  const summary = compositing
    ? compositing.startsWith('enabled')
      ? 'Hardware accelerated: the GPU composites this window.'
      : `Software compositing (${compositing}): every repaint costs CPU.`
    : SOFTWARE_GL.test(gl)
      ? 'WebGL runs in software here: the GPU is probably not used.'
      : 'Chromium’s own report is only available in the desktop app.';
  const f = status?.features ?? {};
  const pick = (...keys: string[]) => keys.filter((k) => f[k]).map((k) => `${k.replace(/_/g, ' ')}: ${f[k]}`).join(' · ');
  // The dialog shows 8 lines: the facts that matter first; Copy takes everything.
  const details = [
    status ? pick('gpu_compositing', 'rasterization') || 'compositing: unknown' : 'compositing: n/a (browser mode)',
    ...(status?.devices.slice(0, 2).map((d) => `GPU ${d}`) ?? []),
    `WebGL renderer: ${gl}`,
    `display: ${hz} Hz, device pixel ratio ${devicePixelRatio}`,
    ...(status ? [`switches: ${status.switches.join(' ') || 'none'}`, pick('webgl', 'webgpu', 'video_decode')] : []),
  ].filter(Boolean);
  const all = [summary, ...details, ...Object.entries(f).map(([k, v]) => `${k}: ${v}`), ...(status?.devices.slice(2).map((d) => `GPU ${d}`) ?? [])];
  const r = await ui.ask({ title: 'GPU status', message: summary, details, buttons: [{ label: 'Copy', value: 'copy' }, { label: 'Close', value: 'close', kind: 'primary' }], cancelValue: 'close' });
  if (r.value === 'copy') await copyText(all.join('\n'), 'GPU status');
}
