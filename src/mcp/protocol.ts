// MCP over JSON-RPC 2.0, transport-agnostic (stdio.ts today, http.ts later). Dual-era:
//  - legacy (2024-11-05 … 2025-11-25): an `initialize` handshake negotiates the version for this process;
//  - modern (2026-07-28): no handshake; every request carries its version, client identity and
//    capabilities in `_meta` (io.modelcontextprotocol/*). `server/discover` answers either era.
// No session state beyond "a legacy client initialized this stdio process". Every tool is short, so
// results are plain responses (no progress, no streaming). Tool failures come back as `isError`
// results the model can read and correct; protocol failures as JSON-RPC errors.
// Asking the user (CallContext.confirm, MCP elicitation, form mode), only where the client declared it:
//  - legacy (2025-06-18+): an `elicitation/create` request to the client, matched by id, 120 s;
//  - modern: Multi Round-Trip Requests: an `input_required` result with the elicitation and an HMAC-sealed,
//    single-use, expiring `requestState`; the client's retry carries `inputResponses`.
import crypto from 'node:crypto';

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
  /** How the activity row shows this call (e.g. `delete (folder)`, "restore from the Recycle Bin"). Never sent. */
  audit?: { tool?: string; note?: string; ok?: boolean; code?: string };
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** The user's answer to a yes / no question (`unsupported`: this client cannot ask). */
export type Confirmation = 'yes' | 'no' | 'cancel' | 'timeout' | 'unsupported';

export interface CallContext {
  client: string;
  /** Asks the user through the client (MCP elicitation). `bind` ties a 2026-07-28 answer to what was asked:
   *  a retry for anything else (another folder, or the folder changed) is asked again. */
  confirm?(q: { message: string; bind: string }): Promise<Confirmation>;
}

/** Thrown by confirm() in the 2026-07-28 era: the call answers `input_required` and is retried. */
class InputRequired {
  constructor(readonly result: { inputRequests: Record<string, unknown>; requestState: string }) {}
}
const ASK_KEY = 'confirm';
/** Elicitation's own field: one required yes / no. */
const CONFIRM_SCHEMA = { type: 'object', properties: { confirm: { type: 'boolean', title: 'Yes, delete it', description: 'Move it to the Recycle Bin', default: false } }, required: ['confirm'] } as const;
export const ELICIT_TIMEOUT_MS = 120_000;

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: InputSchema;
  annotations: ToolAnnotations;
  /** Changes files: listed and callable only while the caller may write somewhere (see ServerHooks.tools). */
  write?: boolean;
  /** Added to an "Unknown parameter" error (e.g. search: filters go inside the query). Never listed. */
  argHint?: string;
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
  note?: string;
}

export interface ServerHooks {
  info: { name: string; title?: string; version: string };
  instructions: string;
  /** The tools this caller may use right now (write tools only where it may write), in a stable order. */
  tools(): ToolDef[];
  /** Parameters still accepted but left out of tools/list right now (`folder` while one folder is shared). */
  hiddenParams?(): readonly string[];
  resources?: ResourceProvider;
  onCall?(r: CallRecord): void;
  /** How long a question to the user may stay open (default ELICIT_TIMEOUT_MS). */
  elicitTimeoutMs?: number;
}

type Id = string | number;
/** `elicit`: the client declared form elicitation (and the era has it). */
type Era = { kind: 'modern' | 'legacy'; version: string; client: string; elicit: boolean };

/** Form elicitation declared: `elicitation: {}` (form, 2025-06-18) or `{ form: {} }` (2025-11-25+). */
const formElicitation = (caps: unknown): boolean => {
  const e = isObj(caps) ? caps.elicitation : undefined;
  return isObj(e) && (!('url' in e || 'form' in e) || isObj(e.form));
};

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
  private legacy: { version: string; client: string; elicit: boolean } | null = null;
  private initialized = false;
  private running = 0;
  private waiting: Array<() => void> = [];
  /** Requests we sent to the client (legacy elicitation), by our id. */
  private pending = new Map<string, { done(r: { result?: unknown; error?: unknown } | 'timeout' | 'closed'): void }>();
  private nextId = 0;
  private sendOut: ((m: unknown) => void) | null = null;
  /** Seals 2026-07-28 requestState (HMAC); a key per process. */
  private readonly stateKey = crypto.randomBytes(32);
  private readonly usedStates = new Set<string>();

  constructor(private readonly hooks: ServerHooks) {}

  /** The transport's way to send a message of ours (a request to the client). */
  attach(send: (m: unknown) => void) {
    this.sendOut = send;
  }

  private inputEnded = false;
  /** End of input: questions still open, or asked from now on, will not be answered. */
  endOfInput() {
    this.inputEnded = true;
    for (const p of [...this.pending.values()]) p.done('closed');
  }

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
      // A response: to a request of ours (an elicitation), else to one we never sent (nothing to do).
      if (hasId && ('result' in msg || 'error' in msg)) {
        const p = typeof msg.id === 'string' ? this.pending.get(msg.id) : undefined;
        p?.done('error' in msg ? { error: msg.error } : { result: msg.result });
        return null;
      }
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
      return { kind: 'modern', version: v, client: clientName(meta?.[META.clientInfo]), elicit: formElicitation(meta?.[META.clientCapabilities]) };
    }
    if (this.legacy) return { kind: 'legacy', ...this.legacy };
    // Neither: a legacy client that skipped initialize, or a modern one without _meta. ping and
    // discovery are answered anyway (probes); everything else says how to speak to us.
    if (method === 'ping' || method === 'server/discover') return { kind: 'legacy', version: LEGACY_VERSIONS[0], client: 'unknown', elicit: false };
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
      case 'tools/list': {
        const hidden = new Set(this.hooks.hiddenParams?.() ?? []);
        return done({ tools: this.hooks.tools().map((t) => describeTool(t, era.version, hidden)) }, true);
      }
      case 'tools/call':
        try {
          return done({ ...(await this.slot(() => this.call(params, era))) });
        } catch (err) {
          if (!(err instanceof InputRequired)) throw err;
          return { resultType: 'input_required', ...err.result, _meta: { [META.serverInfo]: this.hooks.info } };
        }
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
    // Elicitation exists from 2025-06-18 on.
    this.legacy = { version, client: clientName(params.clientInfo), elicit: version >= '2025-06-18' && formElicitation(params.capabilities) };
    this.initialized = false;
    return { protocolVersion: version, capabilities: this.capabilities('legacy'), serverInfo: this.hooks.info, instructions: this.hooks.instructions };
  }

  /** CallContext.confirm for this request (see the top of the file). */
  private confirmer(era: Era, params: Record<string, unknown>): NonNullable<CallContext['confirm']> {
    const timeout = this.hooks.elicitTimeoutMs ?? ELICIT_TIMEOUT_MS;
    const ask = (message: string) => ({ ...(era.version >= '2025-11-25' ? { mode: 'form' } : {}), message, requestedSchema: CONFIRM_SCHEMA });
    const answer = (r: unknown): Confirmation => {
      if (!isObj(r)) return 'cancel';
      if (r.action === 'accept') return isObj(r.content) && r.content.confirm === true ? 'yes' : 'no';
      return r.action === 'decline' ? 'no' : 'cancel';
    };
    return async ({ message, bind }) => {
      if (!era.elicit) return 'unsupported';
      if (era.kind === 'legacy') {
        if (!this.sendOut) return 'unsupported';
        if (this.inputEnded) return 'cancel';
        const id = `one-ask-${++this.nextId}`;
        const r = await new Promise<{ result?: unknown; error?: unknown } | 'timeout' | 'closed'>((resolve) => {
          const timer = setTimeout(() => entry.done('timeout'), timeout);
          timer.unref?.();
          const entry = {
            done: (v: { result?: unknown; error?: unknown } | 'timeout' | 'closed') => {
              if (!this.pending.delete(id)) return;
              clearTimeout(timer);
              if (v === 'timeout') this.sendOut?.({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'No answer in time' } });
              resolve(v);
            },
          };
          this.pending.set(id, entry);
          this.sendOut!({ jsonrpc: '2.0', id, method: 'elicitation/create', params: ask(message) });
        });
        if (r === 'timeout') return 'timeout';
        if (r === 'closed' || 'error' in r) return 'cancel';
        return answer(r.result);
      }
      // 2026-07-28: the answer, if any, comes with this retry.
      const state = params.requestState;
      if (typeof state === 'string') {
        const s = this.openState(state);
        if (s.bind === bind) {
          if (this.usedStates.has(s.nonce)) throw new RpcError(ERR.invalidParams, 'Invalid or expired requestState: already used');
          this.usedStates.add(s.nonce);
          if (this.usedStates.size > 1000) this.usedStates.delete(this.usedStates.values().next().value!);
          if (Date.now() > s.exp) return 'timeout';
          const resp = isObj(params.inputResponses) ? params.inputResponses[ASK_KEY] : undefined;
          if (resp !== undefined) return answer(resp);
        }
        // Another request, or the thing asked about changed since: ask again.
      }
      throw new InputRequired({ inputRequests: { [ASK_KEY]: { method: 'elicitation/create', params: ask(message) } }, requestState: this.sealState({ bind, exp: Date.now() + timeout, nonce: crypto.randomBytes(12).toString('base64url') }) });
    };
  }

  private sealState(p: { bind: string; exp: number; nonce: string }): string {
    const body = Buffer.from(JSON.stringify(p)).toString('base64url');
    return `${body}.${crypto.createHmac('sha256', this.stateKey).update(body).digest('base64url')}`;
  }

  /** The state we sealed, or an Invalid Params error (attacker-controlled input: verified, never trusted). */
  private openState(s: string): { bind: string; exp: number; nonce: string } {
    const bad = () => new RpcError(ERR.invalidParams, 'Invalid or expired requestState');
    const [body, mac, extra] = s.split('.');
    if (!body || !mac || extra !== undefined || s.length > 8192) throw bad();
    const want = crypto.createHmac('sha256', this.stateKey).update(body).digest();
    const got = Buffer.from(mac, 'base64url');
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw bad();
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (typeof p.bind === 'string' && typeof p.exp === 'number' && typeof p.nonce === 'string') return p;
    } catch {}
    throw bad();
  }

  private async call(params: Record<string, unknown>, era: Era): Promise<ToolResult> {
    const client = era.client;
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
      try {
        args = checkArgs(tool.inputSchema, raw);
      } catch (err) {
        if (tool.argHint && err instanceof ToolError && err.message.startsWith('Unknown parameter')) throw new ToolError(err.code, `${err.message} ${tool.argHint}`);
        throw err;
      }
      result = await tool.run(args, { client, confirm: this.confirmer(era, params) });
    } catch (err) {
      if (err instanceof InputRequired || err instanceof RpcError) throw err; // an interim result / a protocol error
      code = err instanceof ToolError ? err.code : 'EIO';
      // Never a raw exception message: Node's fs errors carry absolute host paths. One line: `CODE: message`.
      result = { content: [{ type: 'text', text: err instanceof ToolError ? `${err.code}: ${err.message.replace(/\s*[\r\n]+\s*/g, ' ')}` : 'EIO: The tool failed unexpectedly.' }], isError: true };
      if (!(err instanceof ToolError)) console.error('[mcp] tool failed', name, err);
    }
    const { journal, audit, ...clean } = result;
    const bytes = clean.content.reduce((n, c) => n + c.text.length, 0);
    this.hooks.onCall?.({ tool: audit?.tool ?? name, client, ok: audit?.ok ?? !clean.isError, code: audit?.code ?? code, ms: Date.now() - t0, bytes, args, ...(journal ? { journal } : {}), ...(audit?.note ? { note: audit.note } : {}) });
    return clean;
  }
}

/**
 * What tools/list sends: the definition minus what costs the model tokens on every turn and tells it
 * nothing — `maxLength` (still enforced by checkArgs) and parameters hidden right now (still accepted).
 * The title goes in annotations only for clients older than 2025-06-18 (no top-level `title` there).
 */
export function describeTool(t: ToolDef, version: string = LEGACY_VERSIONS[0], hidden: ReadonlySet<string> = new Set()) {
  const properties: Record<string, Omit<PropSchema, 'maxLength'>> = {};
  for (const [k, p] of Object.entries(t.inputSchema.properties)) {
    if (hidden.has(k)) continue;
    const { maxLength: _enforcedOnly, ...shown } = p;
    properties[k] = shown;
  }
  const required = t.inputSchema.required?.filter((k) => !hidden.has(k));
  const inputSchema = { type: 'object', properties, ...(required?.length ? { required } : {}), additionalProperties: false };
  const annotations = version < '2025-06-18' ? { title: t.title, ...t.annotations } : t.annotations;
  return { name: t.name, title: t.title, description: t.description, inputSchema, annotations };
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
