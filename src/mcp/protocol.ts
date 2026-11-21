// MCP over JSON-RPC 2.0, transport-agnostic (stdio.ts today, http.ts later). Dual-era:
//  - legacy (2024-11-05 … 2025-11-25): an `initialize` handshake negotiates the version for this process;
//  - modern (2026-07-28): no handshake; every request carries its version, client identity and
//    capabilities in `_meta` (io.modelcontextprotocol/*). `server/discover` answers either era.
// No session state beyond "a legacy client initialized this stdio process". Every tool is short, so
// results are plain responses (no progress, no streaming). Tool failures come back as `isError`
// results the model can read and correct; protocol failures as JSON-RPC errors.

export const MODERN_VERSIONS = ['2026-07-28'] as const;
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const SUPPORTED_VERSIONS: readonly string[] = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];

export const META = {
  version: 'io.modelcontextprotocol/protocolVersion',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
} as const;

export const ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** 2026-07-28 UnsupportedProtocolVersionError. */
  unsupportedVersion: -32022,
} as const;

/** Flat object schemas only (local models and OpenAI tooling handle these best). */
export interface PropSchema {
  type: 'string' | 'integer' | 'boolean';
  description: string;
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
}
export interface InputSchema {
  type: 'object';
  properties: Record<string, PropSchema>;
  required?: string[];
  additionalProperties: false;
}

export interface TextContent {
  type: 'text';
  text: string;
}
export interface ToolResult {
  content: TextContent[];
  isError?: boolean;
  /** Undo history group of a write (activity log → Revert). Never sent to the client. */
  journal?: string;
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface CallContext {
  client: string;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: InputSchema;
  annotations: ToolAnnotations;
  /** Changes files: listed and callable only while the caller may write somewhere (see ServerHooks.tools). */
  write?: boolean;
  run(args: Record<string, unknown>, ctx: CallContext): Promise<ToolResult>;
}

/** A failure the model should see (bad argument, file not found…): becomes an `isError` result. */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** A JSON-RPC error (protocol level). */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface ResourceProvider {
  list(cursor: string | undefined): Promise<{ resources: unknown[]; nextCursor?: string }>;
  templates(): unknown[];
  read(uri: string, ctx: CallContext): Promise<{ contents: unknown[] }>;
}

export interface CallRecord {
  tool: string;
  client: string;
  ok: boolean;
  code: string | null;
  ms: number;
  bytes: number;
  args: Record<string, unknown>;
  journal?: string;
}

export interface ServerHooks {
  info: { name: string; title?: string; version: string };
  instructions: string;
  /** The tools this caller may use right now (write tools only where it may write), in a stable order. */
  tools(): ToolDef[];
  resources?: ResourceProvider;
  onCall?(r: CallRecord): void;
}

type Id = string | number;
type Era = { kind: 'modern'; version: string; client: string } | { kind: 'legacy'; version: string; client: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const clientName = (info: unknown): string => {
  const n = isObj(info) ? info.name : undefined;
  return typeof n === 'string' && n.trim() ? n.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) : 'unknown';
};

/** How long a client may cache list results (2026-07-28 CacheableResult). Config changes are rare. */
const LIST_TTL_MS = 60_000;
/** Tool calls / resource reads running at once; more wait in line, up to MAX_QUEUED, then are refused. */
export const MAX_CONCURRENT = 4;
export const MAX_QUEUED = 32;

export class McpProtocol {
  /** Set by a legacy `initialize` (scoped to this process, as the spec says for stdio). */
  private legacy: { version: string; client: string } | null = null;
  private initialized = false;
  private running = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly hooks: ServerHooks) {}

  /** Legacy sessions only: modern clients would need subscriptions/listen, which is not offered. */
  get canNotify(): boolean {
    return !!this.legacy && this.initialized;
  }

  get client(): string {
    return this.legacy?.client ?? 'unknown';
  }

  /** One parsed message (or a batch). Returns the response(s), or null when nothing is owed. */
  async handle(msg: unknown): Promise<unknown | null> {
    // JSON-RPC batches (removed from MCP in 2025-06-18) would bypass the concurrency cap: refused.
    if (Array.isArray(msg)) return errorResponse(null, ERR.invalidRequest, 'Batches are not supported: send one request per message');
    return this.handleOne(msg);
  }

  /** At most MAX_CONCURRENT tool calls / reads at once (a client cannot pile up work on this thread). */
  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= MAX_CONCURRENT) {
      if (this.waiting.length >= MAX_QUEUED) throw new RpcError(ERR.internal, 'Too many requests at once: wait for answers before sending more');
      await new Promise<void>((r) => this.waiting.push(r));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  private async handleOne(msg: unknown): Promise<unknown | null> {
    if (!isObj(msg) || msg.jsonrpc !== '2.0') return errorResponse(validId(isObj(msg) ? msg.id : undefined), ERR.invalidRequest, 'Invalid request: expected a JSON-RPC 2.0 object');
    const hasId = 'id' in msg;
    if (typeof msg.method !== 'string') {
      // A response to a request we never sent: nothing to do.
      if (hasId && ('result' in msg || 'error' in msg)) return null;
      return errorResponse(validId(msg.id), ERR.invalidRequest, 'Invalid request: no method');
    }
    if (!hasId) {
      if (msg.method === 'notifications/initialized') this.initialized = true;
      return null; // notifications (cancelled, roots changed…) need no answer
    }
    const id = validId(msg.id);
    if (id === null) return errorResponse(null, ERR.invalidRequest, 'Invalid request: id must be a string or a number');
    try {
      const params = msg.params === undefined ? {} : msg.params;
      if (!isObj(params)) throw new RpcError(ERR.invalidParams, 'params must be an object');
      const result = await this.dispatch(msg.method, params);
      return { jsonrpc: '2.0', id, result };
    } catch (err) {
      if (err instanceof RpcError) return errorResponse(id, err.code, err.message, err.data);
      return errorResponse(id, ERR.internal, 'Internal error');
    }
  }

  private eraOf(method: string, params: Record<string, unknown>): Era {
    const meta = isObj(params._meta) ? params._meta : null;
    const v = meta?.[META.version];
    if (v !== undefined) {
      if (typeof v !== 'string' || !(MODERN_VERSIONS as readonly string[]).includes(v)) throw new RpcError(ERR.unsupportedVersion, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested: typeof v === 'string' ? v.slice(0, 40) : null });
      return { kind: 'modern', version: v, client: clientName(meta?.[META.clientInfo]) };
    }
    if (this.legacy) return { kind: 'legacy', ...this.legacy };
    // Neither: a legacy client that skipped initialize, or a modern one without _meta. ping and
    // discovery are answered anyway (probes); everything else says how to speak to us.
    if (method === 'ping' || method === 'server/discover') return { kind: 'legacy', version: LEGACY_VERSIONS[0], client: 'unknown' };
    throw new RpcError(ERR.unsupportedVersion, `No protocol version: send "initialize" first, or set _meta["${META.version}"]`, { supported: SUPPORTED_VERSIONS, requested: null });
  }

  private capabilities(era: 'modern' | 'legacy') {
    return { tools: era === 'legacy' ? { listChanged: true } : {}, ...(this.hooks.resources ? { resources: {} } : {}) };
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'initialize') return this.initialize(params);
    const era = this.eraOf(method, params);
    const done = (r: Record<string, unknown>, list = false) =>
      era.kind === 'modern' ? { ...r, resultType: 'complete', ...(list ? { ttlMs: LIST_TTL_MS, cacheScope: 'private' } : {}), _meta: { [META.serverInfo]: this.hooks.info } } : r;
    switch (method) {
      case 'ping':
        return done({});
      case 'server/discover':
        return { resultType: 'complete', supportedVersions: SUPPORTED_VERSIONS, capabilities: this.capabilities('modern'), instructions: this.hooks.instructions, ttlMs: LIST_TTL_MS, cacheScope: 'private', _meta: { [META.serverInfo]: this.hooks.info } };
      case 'tools/list':
        return done({ tools: this.hooks.tools().map(describeTool) }, true);
      case 'tools/call':
        return done({ ...(await this.slot(() => this.call(params, era.client))) });
      case 'resources/list':
      case 'resources/templates/list':
      case 'resources/read': {
        const r = this.hooks.resources;
        if (!r) break;
        if (method === 'resources/templates/list') return done({ resourceTemplates: r.templates() }, true);
        if (method === 'resources/list') {
          const cursor = typeof params.cursor === 'string' ? params.cursor : undefined;
          return done({ ...(await r.list(cursor)) }, true);
        }
        if (typeof params.uri !== 'string') throw new RpcError(ERR.invalidParams, 'uri must be a string');
        const t0 = Date.now();
        try {
          const uri = params.uri;
          const res = await this.slot(() => r.read(uri, { client: era.client }));
          this.hooks.onCall?.({ tool: 'resources/read', client: era.client, ok: true, code: null, ms: Date.now() - t0, bytes: JSON.stringify(res).length, args: { uri: params.uri } });
          return done({ ...res }, true);
        } catch (err) {
          const code = err instanceof ToolError ? err.code : 'EIO';
          this.hooks.onCall?.({ tool: 'resources/read', client: era.client, ok: false, code, ms: Date.now() - t0, bytes: 0, args: { uri: params.uri } });
          // 2026-07-28 uses Invalid Params for "resource not found" (was -32002).
          if (err instanceof ToolError) throw new RpcError(ERR.invalidParams, err.message, { uri: params.uri.slice(0, 300) });
          throw err;
        }
      }
    }
    throw new RpcError(ERR.methodNotFound, `Method not found: ${method.slice(0, 80)}`);
  }

  private initialize(params: Record<string, unknown>) {
    const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    // Version negotiation: echo a version we speak, else offer our newest legacy one (the client decides).
    const version = (LEGACY_VERSIONS as readonly string[]).includes(asked) ? asked : LEGACY_VERSIONS[0];
    this.legacy = { version, client: clientName(params.clientInfo) };
    this.initialized = false;
    return { protocolVersion: version, capabilities: this.capabilities('legacy'), serverInfo: this.hooks.info, instructions: this.hooks.instructions };
  }

  private async call(params: Record<string, unknown>, client: string): Promise<ToolResult> {
    const name = params.name;
    if (typeof name !== 'string') throw new RpcError(ERR.invalidParams, 'name must be a string');
    const tool = this.hooks.tools().find((t) => t.name === name);
    if (!tool) throw new RpcError(ERR.invalidParams, `Unknown tool: ${name.slice(0, 64)}`);
    const t0 = Date.now();
    const raw = params.arguments === undefined || params.arguments === null ? {} : params.arguments;
    let result: ToolResult;
    let code: string | null = null;
    let args: Record<string, unknown> = {};
    try {
      if (!isObj(raw)) throw new ToolError('EINVAL', 'arguments must be an object');
      args = checkArgs(tool.inputSchema, raw);
      result = await tool.run(args, { client });
    } catch (err) {
      code = err instanceof ToolError ? err.code : 'EIO';
      // Never a raw exception message: Node's fs errors carry absolute host paths.
      result = { content: [{ type: 'text', text: err instanceof ToolError ? `${err.code}: ${err.message}` : 'EIO: The tool failed unexpectedly.' }], isError: true };
      if (!(err instanceof ToolError)) console.error('[mcp] tool failed', name, err);
    }
    const { journal, ...clean } = result;
    const bytes = clean.content.reduce((n, c) => n + c.text.length, 0);
    this.hooks.onCall?.({ tool: name, client, ok: !clean.isError, code, ms: Date.now() - t0, bytes, args, ...(journal ? { journal } : {}) });
    return clean;
  }
}

function describeTool(t: ToolDef) {
  return { name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, ...t.annotations } };
}

const validId = (id: unknown): Id | null => (typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id)) ? id : null);

function errorResponse(id: Id | null, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

/**
 * Validates arguments against a flat schema. Lenient where small models slip ("10" for 10, "true"
 * for true), strict where it matters: unknown names, wrong types, out-of-range values are refused
 * with a message that lists what the tool takes.
 */
export function checkArgs(schema: InputSchema, raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const names = Object.keys(schema.properties);
  for (const k of Object.keys(raw)) {
    // Own keys only: "constructor" / "__proto__" are not parameters.
    if (!Object.hasOwn(schema.properties, k)) throw new ToolError('EINVAL', `Unknown parameter "${k.slice(0, 40)}". This tool takes: ${names.join(', ') || 'no parameters'}.`);
  }
  for (const [k, p] of Object.entries(schema.properties)) {
    let v = raw[k];
    if (v === undefined || v === null || (v === '' && p.type !== 'string')) {
      if (schema.required?.includes(k)) throw new ToolError('EINVAL', `Missing parameter "${k}": ${p.description}`);
      continue;
    }
    if (p.type === 'integer') {
      if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) v = Number(v.trim());
      if (typeof v !== 'number' || !Number.isInteger(v)) throw new ToolError('EINVAL', `"${k}" must be a whole number`);
      if (p.minimum !== undefined && v < p.minimum) throw new ToolError('EINVAL', `"${k}" must be at least ${p.minimum}`);
      if (p.maximum !== undefined && v > p.maximum) throw new ToolError('EINVAL', `"${k}" must be at most ${p.maximum}`);
    } else if (p.type === 'boolean') {
      if (v === 'true' || v === 'false') v = v === 'true';
      if (typeof v !== 'boolean') throw new ToolError('EINVAL', `"${k}" must be true or false`);
    } else {
      if (typeof v !== 'string') throw new ToolError('EINVAL', `"${k}" must be a string`);
      if (p.maxLength !== undefined && v.length > p.maxLength) throw new ToolError('EINVAL', `"${k}" is too long (at most ${p.maxLength} characters)`);
      if (p.enum && !p.enum.includes(v)) throw new ToolError('EINVAL', `"${k}" must be one of: ${p.enum.join(', ')}`);
    }
    out[k] = v;
  }
  return out;
}
