// Graph model + force simulation (pure, no DOM) for the graph view.
// Barnes–Hut repulsion keeps a tick ~O(n log n), so a few thousand notes stay interactive.
import { isMarkdown, stem } from '@shared/paths';
import type { KnowledgeIndex } from './index';

export type GraphNodeKind = 'note' | 'tag' | 'unresolved' | 'file';

export interface GraphNode {
  id: string; // path, "#tag" or "?target"
  label: string;
  kind: GraphNodeKind;
  degree: number;
}

export interface GraphData {
  nodes: GraphNode[];
  /** Flat pairs of node indices: [s0, t0, s1, t1, …]. */
  edges: number[];
}

export interface GraphOptions {
  showTags?: boolean;
  showUnresolved?: boolean;
  showOrphans?: boolean;
  showAttachments?: boolean;
  /** Free text (path substring) or `tag:x` / `#x`. */
  filter?: string;
  /** Local graph: only nodes within `depth` hops of `path`. */
  local?: { path: string; depth: number } | null;
}

export function buildGraph(index: KnowledgeIndex, opts: GraphOptions = {}): GraphData {
  const ids = new Map<string, number>();
  const nodes: GraphNode[] = [];
  const edgeSet = new Set<number>();
  const edges: number[] = [];
  const node = (id: string, label: string, kind: GraphNodeKind) => {
    let i = ids.get(id);
    if (i === undefined) {
      i = nodes.length;
      ids.set(id, i);
      nodes.push({ id, label, kind, degree: 0 });
    }
    return i;
  };
  const edge = (a: number, b: number) => {
    if (a === b) return;
    const key = a < b ? a * 0x200000 + b : b * 0x200000 + a;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    edges.push(a, b);
    nodes[a].degree++;
    nodes[b].degree++;
  };

  const notes = index.notes();
  for (const n of notes) node(n.path, n.title, 'note');
  for (const n of notes) {
    const a = ids.get(n.path)!;
    for (const o of index.outgoing(n.path)) {
      if (o.path) {
        if (isMarkdown(o.path)) edge(a, node(o.path, stem(o.path), 'note'));
        else if (opts.showAttachments) edge(a, node(o.path, o.path.slice(o.path.lastIndexOf('/') + 1), 'file'));
      } else if (opts.showUnresolved && o.link.kind === 'wiki' && o.link.target) {
        edge(a, node(`?${o.link.target.toLowerCase()}`, o.link.target, 'unresolved'));
      }
    }
    if (opts.showTags) for (const t of n.tags) edge(a, node(`#${t.toLowerCase()}`, `#${t}`, 'tag'));
  }

  let keep: Uint8Array | null = null;
  const restrict = (pred: (i: number) => boolean) => {
    const next = new Uint8Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) if ((!keep || keep[i]) && pred(i)) next[i] = 1;
    keep = next;
  };

  const q = opts.filter?.trim().toLowerCase();
  if (q) {
    const tagQ = q.startsWith('tag:') ? q.slice(4).replace(/^#/, '') : q.startsWith('#') ? q.slice(1) : null;
    if (tagQ !== null) {
      const match = new Set(tagQ ? index.notesWithTag(tagQ) : notes.filter((n) => n.tags.length).map((n) => n.path));
      restrict((i) => match.has(nodes[i].id) || (nodes[i].kind === 'tag' && nodes[i].id.slice(1).startsWith(tagQ)));
    } else restrict((i) => nodes[i].id.toLowerCase().includes(q));
  }

  if (opts.local) {
    const start = ids.get(opts.local.path);
    const dist = new Int32Array(nodes.length).fill(-1);
    if (start !== undefined) {
      const adj: number[][] = nodes.map(() => []);
      for (let e = 0; e < edges.length; e += 2) {
        adj[edges[e]].push(edges[e + 1]);
        adj[edges[e + 1]].push(edges[e]);
      }
      dist[start] = 0;
      let frontier = [start];
      for (let d = 1; d <= opts.local.depth && frontier.length; d++) {
        const next: number[] = [];
        for (const i of frontier)
          for (const j of adj[i])
            if (dist[j] === -1) {
              dist[j] = d;
              next.push(j);
            }
        frontier = next;
      }
    }
    restrict((i) => dist[i] !== -1);
  }

  // Compact to kept nodes, recomputing degree over surviving edges.
  const remap = new Int32Array(nodes.length).fill(-1);
  let outNodes: GraphNode[] = [];
  for (let i = 0; i < nodes.length; i++)
    if (!keep || (keep as Uint8Array)[i]) {
      remap[i] = outNodes.length;
      outNodes.push({ ...nodes[i], degree: 0 });
    }
  let outEdges: number[] = [];
  for (let e = 0; e < edges.length; e += 2) {
    const a = remap[edges[e]];
    const b = remap[edges[e + 1]];
    if (a === -1 || b === -1) continue;
    outEdges.push(a, b);
    outNodes[a].degree++;
    outNodes[b].degree++;
  }
  if (opts.showOrphans === false) {
    const remap2 = new Int32Array(outNodes.length).fill(-1);
    const kept: GraphNode[] = [];
    outNodes.forEach((n, i) => {
      if (n.degree > 0 || (opts.local && n.id === opts.local.path)) {
        remap2[i] = kept.length;
        kept.push(n);
      }
    });
    outEdges = outEdges.map((i) => remap2[i]);
    outNodes = kept;
  }
  return { nodes: outNodes, edges: outEdges };
}

// ---------- simulation ----------

export class ForceSim {
  n: number;
  x: Float32Array;
  y: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  /** 1 = pinned (being dragged). */
  fixed: Uint8Array;
  alpha = 1;
  alphaTarget = 0;
  alphaMin = 0.002;
  alphaDecay = 0.025;
  velocityDecay = 0.55;
  repulsion = 420;
  linkDistance = 62;
  gravity = 0.045;
  theta2 = 0.81;

  private edges: Int32Array;
  private degree: Float32Array;
  // Quadtree storage, reused between ticks.
  private qChild = new Int32Array(0);
  private qMass = new Float32Array(0);
  private qX = new Float32Array(0);
  private qY = new Float32Array(0);
  private qBody = new Int32Array(0);
  private qCount = 0;
  private stack = new Int32Array(256);
  private stackSize = new Float32Array(256);

  constructor(nodeCount: number, edges: ArrayLike<number>, prev?: Map<number, { x: number; y: number }>) {
    this.n = nodeCount;
    this.x = new Float32Array(nodeCount);
    this.y = new Float32Array(nodeCount);
    this.vx = new Float32Array(nodeCount);
    this.vy = new Float32Array(nodeCount);
    this.fixed = new Uint8Array(nodeCount);
    this.edges = Int32Array.from(edges as ArrayLike<number>);
    this.degree = new Float32Array(nodeCount);
    for (let e = 0; e < this.edges.length; e++) this.degree[this.edges[e]]++;
    // Phyllotaxis spiral: deterministic, evenly spread start → fast, stable convergence.
    // Dense spirals take many ticks to unfold; start big graphs closer to their final size.
    const spread = nodeCount > 800 ? 18 : 9;
    for (let i = 0; i < nodeCount; i++) {
      const p = prev?.get(i);
      if (p) {
        this.x[i] = p.x;
        this.y[i] = p.y;
        continue;
      }
      const r = spread * Math.sqrt(0.5 + i);
      const a = i * 2.399963229728653;
      this.x[i] = r * Math.cos(a);
      this.y[i] = r * Math.sin(a);
    }
  }

  get settled(): boolean {
    return this.alpha < this.alphaMin && this.alphaTarget === 0;
  }

  reheat(a = 0.5) {
    this.alpha = Math.max(this.alpha, a);
  }

  private ensureTree(cap: number) {
    if (this.qMass.length >= cap) return;
    const grow = <T extends Int32Array | Float32Array>(old: T, size: number): T => {
      const next = new (old.constructor as any)(size) as T;
      next.set(old as any);
      return next;
    };
    this.qChild = grow(this.qChild, cap * 4);
    this.qMass = grow(this.qMass, cap);
    this.qX = grow(this.qX, cap);
    this.qY = grow(this.qY, cap);
    this.qBody = grow(this.qBody, cap);
  }

  private newCell(): number {
    if (this.qCount >= this.qMass.length) this.ensureTree(this.qMass.length * 2 + 64);
    const c = this.qCount++;
    this.qChild[c * 4] = this.qChild[c * 4 + 1] = this.qChild[c * 4 + 2] = this.qChild[c * 4 + 3] = -1;
    this.qMass[c] = 0;
    this.qX[c] = 0;
    this.qY[c] = 0;
    this.qBody[c] = -1;
    return c;
  }

  private buildTree(): { cx: number; cy: number; half: number } {
    const { x, y, n } = this;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      if (x[i] < minX) minX = x[i];
      if (x[i] > maxX) maxX = x[i];
      if (y[i] < minY) minY = y[i];
      if (y[i] > maxY) maxY = y[i];
    }
    const half = Math.max(maxX - minX, maxY - minY, 1) / 2 + 1;
    const rcx = (minX + maxX) / 2;
    const rcy = (minY + maxY) / 2;
    this.ensureTree(n * 3 + 64);
    this.qCount = 0;
    this.newCell();
    for (let i = 0; i < n; i++) {
      let cell = 0;
      let cx = rcx;
      let cy = rcy;
      let h = half;
      for (let depth = 0; ; depth++) {
        const isLeaf = this.qChild[cell * 4] === -1 && this.qChild[cell * 4 + 1] === -1 && this.qChild[cell * 4 + 2] === -1 && this.qChild[cell * 4 + 3] === -1;
        if (isLeaf && this.qMass[cell] === 0) {
          this.qBody[cell] = i;
          this.qMass[cell] = 1;
          this.qX[cell] = x[i];
          this.qY[cell] = y[i];
          break;
        }
        if (isLeaf && depth > 24) {
          // Coincident points: fold into one heavy leaf rather than subdividing forever.
          const m = this.qMass[cell];
          this.qX[cell] = (this.qX[cell] * m + x[i]) / (m + 1);
          this.qY[cell] = (this.qY[cell] * m + y[i]) / (m + 1);
          this.qMass[cell] = m + 1;
          break;
        }
        if (isLeaf) {
          // Push the resident body down one level, then keep descending with i.
          const b = this.qBody[cell];
          const quad = (this.qX[cell] >= cx ? 1 : 0) + (this.qY[cell] >= cy ? 2 : 0);
          const c = this.newCell();
          this.qChild[cell * 4 + quad] = c;
          this.qBody[c] = b;
          this.qMass[c] = this.qMass[cell];
          this.qX[c] = this.qX[cell];
          this.qY[c] = this.qY[cell];
          this.qBody[cell] = -1;
        }
        const m = this.qMass[cell];
        this.qX[cell] = (this.qX[cell] * m + x[i]) / (m + 1);
        this.qY[cell] = (this.qY[cell] * m + y[i]) / (m + 1);
        this.qMass[cell] = m + 1;
        const quad = (x[i] >= cx ? 1 : 0) + (y[i] >= cy ? 2 : 0);
        h /= 2;
        cx += quad & 1 ? h : -h;
        cy += quad & 2 ? h : -h;
        let next = this.qChild[cell * 4 + quad];
        if (next === -1) {
          next = this.newCell();
          this.qChild[cell * 4 + quad] = next;
        }
        cell = next;
      }
    }
    return { cx: rcx, cy: rcy, half };
  }

  tick(): void {
    const { x, y, vx, vy, n, edges, degree } = this;
    if (!n) return;
    this.alpha += (this.alphaTarget - this.alpha) * this.alphaDecay;
    const alpha = this.alpha;

    // Springs. The lighter endpoint moves more, so hubs stay put.
    for (let e = 0; e < edges.length; e += 2) {
      const s = edges[e];
      const t = edges[e + 1];
      let dx = x[t] + vx[t] - x[s] - vx[s];
      let dy = y[t] + vy[t] - y[s] - vy[s];
      if (dx === 0 && dy === 0) {
        dx = 0.01 * ((e % 7) - 3 || 1);
        dy = 0.01;
      }
      const l = Math.sqrt(dx * dx + dy * dy);
      const strength = 1 / Math.min(degree[s], degree[t]);
      const f = ((l - this.linkDistance) / l) * alpha * Math.min(1, strength + 0.15);
      const bias = degree[s] / (degree[s] + degree[t]);
      vx[t] -= dx * f * bias;
      vy[t] -= dy * f * bias;
      vx[s] += dx * f * (1 - bias);
      vy[s] += dy * f * (1 - bias);
    }

    // Repulsion (Barnes–Hut).
    const root = this.buildTree();
    const rep = this.repulsion * alpha;
    let stack = this.stack;
    let sizes = this.stackSize;
    for (let i = 0; i < n; i++) {
      let sp = 0;
      stack[sp] = 0;
      sizes[sp++] = root.half * 2;
      const xi = x[i];
      const yi = y[i];
      let fx = 0;
      let fy = 0;
      while (sp > 0) {
        const cell = stack[--sp];
        const size = sizes[sp];
        const m = this.qMass[cell];
        if (m === 0) continue;
        let dx = this.qX[cell] - xi;
        let dy = this.qY[cell] - yi;
        let d2 = dx * dx + dy * dy;
        const body = this.qBody[cell];
        const leaf = this.qChild[cell * 4] === -1 && this.qChild[cell * 4 + 1] === -1 && this.qChild[cell * 4 + 2] === -1 && this.qChild[cell * 4 + 3] === -1;
        if (leaf || size * size < this.theta2 * d2) {
          if (leaf && body === i && m === 1) continue;
          if (d2 < 1) {
            // Overlapping: nudge apart deterministically.
            dx = ((i * 7919) % 13) / 13 - 0.5 || 0.1;
            dy = ((i * 104729) % 11) / 11 - 0.5 || 0.1;
            d2 = 1;
          }
          const f = (rep * m) / d2;
          fx -= dx * f;
          fy -= dy * f;
          continue;
        }
        if (sp + 4 >= stack.length) {
          const ns = new Int32Array(stack.length * 2);
          ns.set(stack);
          this.stack = stack = ns;
          const nz = new Float32Array(sizes.length * 2);
          nz.set(sizes);
          this.stackSize = sizes = nz;
        }
        for (let q = 0; q < 4; q++) {
          const c = this.qChild[cell * 4 + q];
          if (c !== -1) {
            stack[sp] = c;
            sizes[sp++] = size / 2;
          }
        }
      }
      // Cap the per-tick kick so dense clusters don't explode on the first frames.
      const mag = Math.sqrt(fx * fx + fy * fy);
      const cap = 60;
      if (mag > cap) {
        fx = (fx / mag) * cap;
        fy = (fy / mag) * cap;
      }
      vx[i] += fx;
      vy[i] += fy;
    }

    // Gravity keeps disconnected components (orphans) from drifting off.
    const g = this.gravity * alpha;
    const decay = 1 - this.velocityDecay;
    for (let i = 0; i < n; i++) {
      if (this.fixed[i]) {
        vx[i] = vy[i] = 0;
        continue;
      }
      vx[i] = (vx[i] - x[i] * g) * decay;
      vy[i] = (vy[i] - y[i] * g) * decay;
      x[i] += vx[i];
      y[i] += vy[i];
    }
  }

  /** Bounding box; `trim` (0–0.5) drops that fraction of points from each side (ignores outliers). */
  bounds(trim = 0): { minX: number; minY: number; maxX: number; maxY: number } {
    if (!this.n) return { minX: -1, minY: -1, maxX: 1, maxY: 1 };
    if (trim > 0) {
      const xs = Float32Array.from(this.x).sort();
      const ys = Float32Array.from(this.y).sort();
      const lo = Math.min(this.n - 1, Math.floor(this.n * trim));
      const hi = Math.max(0, this.n - 1 - lo);
      return { minX: xs[lo], minY: ys[lo], maxX: xs[hi], maxY: ys[hi] };
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < this.n; i++) {
      if (this.x[i] < minX) minX = this.x[i];
      if (this.x[i] > maxX) maxX = this.x[i];
      if (this.y[i] < minY) minY = this.y[i];
      if (this.y[i] > maxY) maxY = this.y[i];
    }
    return { minX, minY, maxX, maxY };
  }
}
