// Canvas renderer for link graphs: force layout (../../knowledge/graph), pan / zoom / drag, hover
// highlight, click to open. Shared by the graph view overlay and the overview's small local graph.
import { ForceSim, type GraphData, type GraphNode } from '../../knowledge/graph';

interface Palette {
  bg: string;
  text: string;
  muted: string;
  faint: string;
  accent: string;
  border: string;
  tag: string;
  file: string;
  font: string;
}

function readPalette(el: HTMLElement): Palette {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    bg: v('--bg', '#1b1d22'),
    text: v('--text', '#d7dae0'),
    muted: v('--text-muted', '#8b919c'),
    faint: v('--text-faint', '#5f6570'),
    accent: v('--accent', '#7aa2f7'),
    border: v('--border', '#2f333b'),
    tag: v('--success', '#9ece6a'),
    file: v('--warning', '#e0af68'),
    font: v('--font-ui', 'system-ui, sans-serif'),
  };
}

const radiusOf = (n: GraphNode) => Math.min(16, 3.6 + Math.sqrt(n.degree) * 1.5);

export interface GraphRendererOptions {
  /** 'mod': only Ctrl/Cmd+wheel zooms (a sidebar must keep plain wheel for scrolling). */
  wheelZoom?: 'always' | 'mod';
  /** Lay out synchronously for up to this many ms on new data, so small graphs paint settled
   *  (no animation frames after a note switch). */
  settleMs?: number;
  /** Space around the fitted graph (px). */
  fitPad?: number;
  /** Largest fitted zoom. */
  maxFit?: number;
}

export class GraphRenderer {
  private ctx: CanvasRenderingContext2D | null;
  private sim = new ForceSim(0, []);
  private data: GraphData = { nodes: [], edges: [] };
  private adj: number[][] = [];
  private radius = new Float32Array(0);
  private palette: Palette;
  private w = 1;
  private h = 1;
  private dpr = 1;
  private k = 1;
  private tx = 0;
  private ty = 0;
  private raf = 0;
  private hover = -1;
  private drag: { node: number; startX: number; startY: number; moved: boolean; lastX: number; lastY: number } | null = null;
  private userMoved = false;
  private activeId: string | null = null;
  private disposed = false;
  private wasMoving = false;
  private cleanups: Array<() => void> = [];
  frames = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private onOpen: (n: GraphNode, e: MouseEvent) => void,
    private onHover: (n: GraphNode | null) => void,
    private opts: GraphRendererOptions = {},
  ) {
    this.ctx = canvas.getContext('2d'); // null without a canvas backend (DOM tests): nothing is drawn
    this.palette = readPalette(canvas);
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas);
    this.cleanups.push(() => ro.disconnect());
    // Theme switches change CSS variables, not the canvas — re-read them.
    const mo = new MutationObserver(() => {
      this.palette = readPalette(canvas);
      this.invalidate();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    this.cleanups.push(() => mo.disconnect());
    const on = <K extends keyof HTMLElementEventMap>(ev: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      canvas.addEventListener(ev, fn as EventListener, opts);
      this.cleanups.push(() => canvas.removeEventListener(ev, fn as EventListener, opts));
    };
    on('pointerdown', (e) => this.pointerDown(e));
    on('pointermove', (e) => this.pointerMove(e));
    on('pointerup', (e) => this.pointerUp(e));
    on('pointercancel', () => this.endDrag());
    on('pointerleave', () => {
      if (!this.drag) this.setHover(-1);
    });
    on('wheel', (e) => this.wheel(e), { passive: false });
    on('dblclick', () => this.fit(true));
    this.resize();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.cleanups.forEach((c) => c());
  }

  setData(data: GraphData, activeId: string | null) {
    // Carry positions over so toggling a filter doesn't reshuffle the whole picture.
    const old = new Map<string, { x: number; y: number }>();
    this.data.nodes.forEach((n, i) => old.set(n.id, { x: this.sim.x[i], y: this.sim.y[i] }));
    const prev = new Map<number, { x: number; y: number }>();
    data.nodes.forEach((n, i) => {
      const p = old.get(n.id);
      if (p) prev.set(i, p);
    });
    const carried = prev.size;
    this.data = data;
    this.activeId = activeId;
    this.sim = new ForceSim(data.nodes.length, data.edges, prev);
    // Small graphs need a firmer pull to the centre or their components drift far apart.
    this.sim.gravity = 0.04 + 0.5 / Math.sqrt(data.nodes.length + 4);
    this.adj = data.nodes.map(() => []);
    for (let e = 0; e < data.edges.length; e += 2) {
      this.adj[data.edges[e]].push(data.edges[e + 1]);
      this.adj[data.edges[e + 1]].push(data.edges[e]);
    }
    this.radius = Float32Array.from(data.nodes.map(radiusOf));
    this.hover = -1;
    this.onHover(null);
    if (this.opts.settleMs) {
      // Small graph: settle now (bounded), then draw once — no animation loop after a switch.
      this.sim.alphaDecay = 0.05; // ~120 ticks to rest instead of ~250
      const t0 = performance.now();
      while (!this.sim.settled && performance.now() - t0 < this.opts.settleMs) for (let i = 0; i < 10; i++) this.sim.tick();
      this.userMoved = false;
    } else if (carried > data.nodes.length * 0.6) this.sim.alpha = 0.3;
    else {
      this.userMoved = false;
      // Warm up off-screen (bounded) so the first frame is already a recognisable layout.
      const t0 = performance.now();
      for (let i = 0; i < 80 && performance.now() - t0 < 30; i++) this.sim.tick();
    }
    if (!this.userMoved) this.fit(false);
    this.canvas.dataset.nodes = String(data.nodes.length);
    this.canvas.dataset.edges = String(data.edges.length / 2);
    this.invalidate();
  }

  setActive(id: string | null) {
    this.activeId = id;
    this.invalidate();
  }

  /** Test/debug hook: screen position of a node. */
  nodeScreenPos(id: string): { x: number; y: number } | null {
    const i = this.data.nodes.findIndex((n) => n.id === id);
    if (i === -1) return null;
    return { x: this.sim.x[i] * this.k + this.tx, y: this.sim.y[i] * this.k + this.ty };
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const first = this.w === 1 && this.h === 1;
    // Keep the view centred on the same world point.
    const cx = (this.w / 2 - this.tx) / this.k;
    const cy = (this.h / 2 - this.ty) / this.k;
    this.w = r.width;
    this.h = r.height;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    if (first || !this.userMoved) this.fit(false);
    else {
      this.tx = this.w / 2 - cx * this.k;
      this.ty = this.h / 2 - cy * this.k;
    }
    this.invalidate();
  }

  private fitTarget() {
    // Trim outliers on big graphs: a few far-flung orphans shouldn't shrink everything else.
    const b = this.sim.bounds(this.sim.n > 60 ? 0.015 : 0);
    const pad = this.opts.fitPad ?? 60;
    const bw = Math.max(b.maxX - b.minX, 40);
    const bh = Math.max(b.maxY - b.minY, 40);
    const k = Math.min(Math.max(Math.min((this.w - pad * 2) / bw, (this.h - pad * 2) / bh), 0.02), this.opts.maxFit ?? 2.2);
    return { k, tx: this.w / 2 - ((b.minX + b.maxX) / 2) * k, ty: this.h / 2 - ((b.minY + b.maxY) / 2) * k };
  }

  fit(resetUser: boolean) {
    if (resetUser) this.userMoved = false;
    const t = this.fitTarget();
    this.k = t.k;
    this.tx = t.tx;
    this.ty = t.ty;
    this.invalidate();
  }

  invalidate() {
    if (this.raf || this.disposed) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.frame();
    });
  }

  private frame() {
    const sim = this.sim;
    if (!sim.settled) {
      // A second tick when it's cheap makes small/medium graphs settle snappier.
      const t0 = performance.now();
      sim.tick();
      if (performance.now() - t0 < 5) sim.tick();
      if (!this.userMoved && !this.drag) {
        // Ease the camera toward the fitted view while the layout expands.
        const t = this.fitTarget();
        this.k += (t.k - this.k) * 0.18;
        this.tx += (t.tx - this.tx) * 0.18;
        this.ty += (t.ty - this.ty) * 0.18;
      }
    }
    this.draw();
    this.frames++;
    // One more frame after settling so the full-detail (all edges + labels) picture is drawn.
    if (!sim.settled || this.wasMoving) this.invalidate();
    this.wasMoving = !sim.settled;
  }

  private draw() {
    const { ctx, sim, data, palette: c, k } = this;
    if (!ctx) return;
    const { x, y } = sim;
    const n = data.nodes.length;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    if (!n) return;
    const hover = this.hover;
    const near = hover === -1 ? null : new Set<number>([hover, ...this.adj[hover]]);
    const sx = (i: number) => x[i] * k + this.tx;
    const sy = (i: number) => y[i] * k + this.ty;
    const edges = data.edges;

    // Edges: one batched path; dimmed when something is hovered.
    ctx.lineWidth = Math.max(0.5, Math.min(1.2, k));
    ctx.strokeStyle = c.muted;
    ctx.globalAlpha = near ? 0.08 : edges.length > 20000 ? 0.12 : edges.length > 4000 ? 0.22 : 0.38;
    ctx.beginPath();
    // While a huge graph is still moving, draw a sample of the edges: stroking tens of thousands of
    // translucent lines per frame is what makes big graphs stutter. The settled frame draws them all.
    const moving = !sim.settled || !!this.drag;
    const edgeStep = moving && edges.length > 16000 ? Math.ceil(edges.length / 16000) * 2 : 2;
    for (let e = 0; e < edges.length; e += edgeStep) {
      const a = edges[e];
      const b = edges[e + 1];
      const ax = sx(a);
      const ay = sy(a);
      const bx = sx(b);
      const by = sy(b);
      // Skip segments entirely off-screen (cheap reject).
      if ((ax < 0 && bx < 0) || (ay < 0 && by < 0) || (ax > this.w && bx > this.w) || (ay > this.h && by > this.h)) continue;
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
    }
    ctx.stroke();
    if (near) {
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = c.accent;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (const j of this.adj[hover]) {
        ctx.moveTo(sx(hover), sy(hover));
        ctx.lineTo(sx(j), sy(j));
      }
      ctx.stroke();
    }

    // Nodes, batched by colour.
    const scaleR = Math.max(0.28, Math.min(1.6, Math.pow(k, 0.75)));
    const colorOf = (node: GraphNode) => (node.kind === 'tag' ? c.tag : node.kind === 'file' ? c.file : node.kind === 'unresolved' ? c.faint : c.muted);
    const drawBatch = (pred: (i: number) => boolean, color: string, alpha: number, hollow = false) => {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        if (!pred(i)) continue;
        const px = sx(i);
        const py = sy(i);
        const r = Math.max(1.1, this.radius[i] * scaleR);
        if (px < -r || py < -r || px > this.w + r || py > this.h + r) continue;
        ctx.moveTo(px + r, py);
        ctx.arc(px, py, r, 0, Math.PI * 2);
      }
      if (hollow) ctx.stroke();
      else ctx.fill();
    };
    const dim = (i: number) => (near && !near.has(i) ? 0.18 : 1);
    for (const kind of ['note', 'tag', 'file', 'unresolved'] as const) {
      const color = colorOf({ kind } as GraphNode);
      for (const a of near ? [0.18, 1] : [1]) drawBatch((i) => data.nodes[i].kind === kind && dim(i) === a && data.nodes[i].id !== this.activeId, color, a, kind === 'unresolved');
    }
    // Active note + hovered node on top.
    const activeIdx = this.activeId ? data.nodes.findIndex((nd) => nd.id === this.activeId) : -1;
    for (const i of [activeIdx, hover]) {
      if (i < 0) continue;
      const r = Math.max(1.1, this.radius[i] * scaleR);
      ctx.globalAlpha = 1;
      ctx.fillStyle = c.accent;
      ctx.beginPath();
      ctx.arc(sx(i), sy(i), r + (i === hover ? 1 : 0), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.28;
      ctx.lineWidth = 4;
      ctx.strokeStyle = c.accent;
      ctx.beginPath();
      ctx.arc(sx(i), sy(i), r + 4, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Labels: everything when zoomed in / small graph, hubs first otherwise; hovered neighbourhood always.
    ctx.font = `11px ${c.font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const small = n <= 80;
    let budget = 400;
    const label = (i: number, strong: boolean) => {
      const px = sx(i);
      const py = sy(i);
      if (px < -60 || py < -20 || px > this.w + 60 || py > this.h + 20) return;
      const node = data.nodes[i];
      const text = node.label.length > 34 ? `${node.label.slice(0, 32)}…` : node.label;
      const r = Math.max(1.1, this.radius[i] * scaleR);
      if (strong) {
        // Halo keeps the label readable on top of edges.
        ctx.globalAlpha = 0.85;
        ctx.lineWidth = 3;
        ctx.strokeStyle = c.bg;
        ctx.strokeText(text, px, py + r + 4);
      }
      ctx.globalAlpha = strong ? 1 : near ? 0.15 : small ? 0.85 : Math.min(0.85, (k * (1 + node.degree / 6) - 0.9) * 1.6);
      ctx.fillStyle = strong ? c.text : c.muted;
      ctx.fillText(text, px, py + r + 4);
    };
    if (moving && n > 2000) budget = 0;
    for (let i = 0; i < n && budget > 0; i++) {
      if (near?.has(i) || i === activeIdx) continue;
      if (small || k * (1 + data.nodes[i].degree / 6) > 1.0) {
        label(i, false);
        budget--;
      }
    }
    if (near) for (const i of near) label(i, true);
    if (activeIdx >= 0 && !near?.has(activeIdx)) label(activeIdx, true);
    ctx.globalAlpha = 1;
  }

  private pick(px: number, py: number): number {
    const { x, y } = this.sim;
    const scaleR = Math.max(0.28, Math.min(1.6, Math.pow(this.k, 0.75)));
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.data.nodes.length; i++) {
      const dx = x[i] * this.k + this.tx - px;
      const dy = y[i] * this.k + this.ty - py;
      const r = Math.max(1.3, this.radius[i] * scaleR) + 5;
      const d = dx * dx + dy * dy;
      if (d < r * r && d < bestD) {
        best = i;
        bestD = d;
      }
    }
    return best;
  }

  private setHover(i: number) {
    if (i === this.hover) return;
    this.hover = i;
    this.canvas.style.cursor = i === -1 ? 'grab' : 'pointer';
    this.onHover(i === -1 ? null : this.data.nodes[i]);
    this.invalidate();
  }

  private local(e: MouseEvent) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private pointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const p = this.local(e);
    const node = this.pick(p.x, p.y);
    this.drag = { node, startX: p.x, startY: p.y, moved: false, lastX: p.x, lastY: p.y };
    this.canvas.setPointerCapture(e.pointerId);
    if (node === -1) this.canvas.style.cursor = 'grabbing';
  }

  private pointerMove(e: PointerEvent) {
    const p = this.local(e);
    const d = this.drag;
    if (!d) {
      this.setHover(this.pick(p.x, p.y));
      return;
    }
    if (!d.moved && Math.hypot(p.x - d.startX, p.y - d.startY) > 4) {
      d.moved = true;
      if (d.node !== -1) {
        this.sim.fixed[d.node] = 1;
        this.sim.alphaTarget = 0.25;
      }
    }
    if (!d.moved) return;
    if (d.node === -1) {
      this.tx += p.x - d.lastX;
      this.ty += p.y - d.lastY;
      this.userMoved = true;
    } else {
      this.sim.x[d.node] = (p.x - this.tx) / this.k;
      this.sim.y[d.node] = (p.y - this.ty) / this.k;
      this.sim.reheat(0.2);
      this.userMoved = true;
    }
    d.lastX = p.x;
    d.lastY = p.y;
    this.invalidate();
  }

  private pointerUp(e: PointerEvent) {
    const d = this.drag;
    this.endDrag();
    if (d && !d.moved && d.node !== -1) this.onOpen(this.data.nodes[d.node], e);
  }

  private endDrag() {
    const d = this.drag;
    if (!d) return;
    if (d.node !== -1) this.sim.fixed[d.node] = 0;
    this.sim.alphaTarget = 0;
    this.drag = null;
    this.canvas.style.cursor = this.hover === -1 ? 'grab' : 'pointer';
    this.invalidate();
  }

  private wheel(e: WheelEvent) {
    if (this.opts.wheelZoom === 'mod' && !(e.ctrlKey || e.metaKey)) return; // let the panel scroll
    e.preventDefault();
    const p = this.local(e);
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    const k = Math.min(8, Math.max(0.02, this.k * factor));
    // Zoom around the cursor.
    this.tx = p.x - ((p.x - this.tx) / this.k) * k;
    this.ty = p.y - ((p.y - this.ty) / this.k) * k;
    this.k = k;
    this.userMoved = true;
    this.invalidate();
  }
}

