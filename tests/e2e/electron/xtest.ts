// Minimal X11 XTEST client: REAL pointer input through the X server, so the window's hit-testing runs
// (drag regions of a frameless window swallow presses before the page sees them). Playwright's clicks
// go through CDP and skip that entirely. Linux/Xvfb only; no auth (our Xvfb runs without it).
import net from 'node:net';

export interface XPointer {
  move(x: number, y: number): Promise<void>;
  /** Pointer motion only: no settle pause (for continuous sweeps at mouse-report rates). */
  motion(x: number, y: number): Promise<void>;
  down(button?: number): Promise<void>;
  up(button?: number): Promise<void>;
  click(x: number, y: number, opts?: { count?: number }): Promise<void>;
  close(): void;
}

const pad4 = (n: number) => (4 - (n % 4)) % 4;

export async function connectXTest(display = process.env.DISPLAY || ':99'): Promise<XPointer> {
  const num = /:(\d+)/.exec(display)?.[1] ?? '0';
  const sock = net.createConnection(`/tmp/.X11-unix/X${num}`);
  let buf = Buffer.alloc(0);
  let waiter: { n: number; resolve: (b: Buffer) => void } | null = null;
  const pump = () => {
    if (waiter && buf.length >= waiter.n) {
      const w = waiter;
      waiter = null;
      const out = buf.subarray(0, w.n);
      buf = buf.subarray(w.n);
      w.resolve(out);
    }
  };
  sock.on('data', (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    pump();
  });
  const read = (n: number) => new Promise<Buffer>((resolve) => ((waiter = { n, resolve }), pump()));
  await new Promise<void>((res, rej) => sock.once('connect', res).once('error', rej));

  // Connection setup: little-endian, protocol 11.0, no auth.
  const setup = Buffer.alloc(12);
  setup.write('l', 0, 'latin1');
  setup.writeUInt16LE(11, 2);
  sock.write(setup);
  const head = await read(8);
  if (head[0] !== 1) throw new Error(`X11 connection refused (${head[0]})`);
  await read(head.readUInt16LE(6) * 4); // rest of the setup reply; nothing in it is needed

  // QueryExtension("XTEST") → its major opcode.
  const name = Buffer.from('XTEST', 'latin1');
  const q = Buffer.alloc(8 + name.length + pad4(name.length));
  q[0] = 98;
  q.writeUInt16LE(q.length / 4, 2);
  q.writeUInt16LE(name.length, 4);
  name.copy(q, 8);
  sock.write(q);
  const rep = await read(32);
  if (rep[0] !== 1 || !rep[8]) throw new Error('XTEST extension missing');
  const opcode = rep[9];

  const fake = (type: number, detail: number, x = 0, y = 0) => {
    const r = Buffer.alloc(36);
    r[0] = opcode;
    r[1] = 2; // X_XTestFakeInput
    r.writeUInt16LE(9, 2);
    r[4] = type;
    r[5] = detail;
    r.writeInt16LE(x, 24);
    r.writeInt16LE(y, 26);
    sock.write(r);
  };
  // GetInputFocus round-trip: everything sent before it has been processed by the server.
  const sync = async () => {
    const r = Buffer.alloc(4);
    r[0] = 43;
    r.writeUInt16LE(1, 2);
    sock.write(r);
    for (;;) {
      const p = await read(32);
      if (p[0] === 1) return; // our reply (errors / events are 32 bytes too and simply skipped)
    }
  };
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const api: XPointer = {
    async move(x, y) {
      fake(6, 0, Math.round(x), Math.round(y)); // MotionNotify, absolute
      await sync();
      await pause(30);
    },
    async motion(x, y) {
      fake(6, 0, Math.round(x), Math.round(y));
      await sync();
    },
    async down(button = 1) {
      fake(4, button);
      await sync();
      await pause(30);
    },
    async up(button = 1) {
      fake(5, button);
      await sync();
      await pause(30);
    },
    async click(x, y, { count = 1 } = {}) {
      await api.move(x, y);
      for (let i = 0; i < count; i++) {
        await api.down();
        await api.up();
      }
      await pause(60);
    },
    close: () => sock.destroy(),
  };
  return api;
}
