// JSON-RPC / MCP protocol: both eras (legacy initialize, 2026-07-28 per-request _meta), errors,
// unknown methods, notifications, batches, argument checks, write tools listed only when writable.
import { describe, expect, it } from 'vitest';
import { ERR, LEGACY_VERSIONS, META, McpProtocol, SUPPORTED_VERSIONS, ToolError, checkArgs, describeTool, type ToolDef } from '../../../src/mcp/protocol';

const echo: ToolDef = {
  name: 'echo',
  title: 'Echo',
  description: 'Echoes',
  inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'x', maxLength: 10 }, n: { type: 'integer', description: 'n', minimum: 1, maximum: 5 }, flag: { type: 'boolean', description: 'f' } }, required: ['text'], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  run: async (a) => ({ content: [{ type: 'text', text: JSON.stringify(a) }] }),
};
const failing: ToolDef = { ...echo, name: 'fail', run: async () => Promise.reject(new ToolError('ENOENT', 'Not found: a.md')) };
const crashing: ToolDef = { ...echo, name: 'crash', run: async () => Promise.reject(new Error("ENOENT: no such file or directory, open '/home/someone/secret/a.md'")) };
const writer: ToolDef = { ...echo, name: 'write_file', write: true, annotations: { ...echo.annotations, readOnlyHint: false } };

function make(o: { canWrite?: boolean } = {}) {
  const calls: unknown[] = [];
  const p = new McpProtocol({
    info: { name: 'one', version: '1.2.3' },
    instructions: 'hi',
    tools: () => [echo, failing, crashing, writer].filter((t) => !t.write || o.canWrite),
    onCall: (r) => calls.push(r),
  });
  return { p, calls };
}
const req = (id: number, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const modern = (extra: Record<string, unknown> = {}) => ({ _meta: { [META.version]: '2026-07-28', [META.clientInfo]: { name: 'LM Studio', version: '0.4' } }, ...extra });
const init = (p: McpProtocol, v = '2025-06-18') => p.handle(req(1, 'initialize', { protocolVersion: v, capabilities: {}, clientInfo: { name: 'codex', version: '1' } }));

describe('legacy era (initialize)', () => {
  it('echoes a supported version and advertises tools', async () => {
    const { p } = make();
    const r = (await init(p)) as any;
    expect(r.result.protocolVersion).toBe('2025-06-18');
    expect(r.result.capabilities.tools).toEqual({ listChanged: true });
    expect(r.result.serverInfo).toEqual({ name: 'one', version: '1.2.3' });
    expect(r.result.instructions).toBe('hi');
    expect(p.client).toBe('codex');
  });

  it('answers an unknown version with its newest legacy one (the client decides)', async () => {
    const { p } = make();
    expect(((await init(p, '2099-01-01')) as any).result.protocolVersion).toBe(LEGACY_VERSIONS[0]);
    expect(((await init(p, '2024-11-05')) as any).result.protocolVersion).toBe('2024-11-05');
  });

  it('notifications get no answer; canNotify only after notifications/initialized', async () => {
    const { p } = make();
    await init(p);
    expect(p.canNotify).toBe(false);
    expect(await p.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect(p.canNotify).toBe(true);
    expect(await p.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } })).toBeNull();
  });

  it('refuses requests before initialize (except ping / discovery) and names the versions', async () => {
    const { p } = make();
    const r = (await p.handle(req(2, 'tools/list'))) as any;
    expect(r.error.code).toBe(ERR.unsupportedVersion);
    expect(r.error.data.supported).toEqual(SUPPORTED_VERSIONS);
    expect(((await p.handle(req(3, 'ping'))) as any).result).toEqual({});
  });

  it('lists tools with schemas and annotations, without era-only fields', async () => {
    const { p } = make();
    await init(p);
    const r = (await p.handle(req(2, 'tools/list'))) as any;
    expect(r.result.tools.map((t: any) => t.name)).toEqual(['echo', 'fail', 'crash']);
    expect(r.result.tools[0].inputSchema.additionalProperties).toBe(false);
    expect(r.result.tools[0].annotations.readOnlyHint).toBe(true);
    expect(r.result.resultType).toBeUndefined();
    for (const t of r.result.tools) expect(t.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });
});

describe('modern era (2026-07-28, per-request _meta)', () => {
  it('serves a request without any handshake, tagging the result', async () => {
    const { p, calls } = make();
    const r = (await p.handle(req(1, 'tools/call', modern({ name: 'echo', arguments: { text: 'hi' } })))) as any;
    expect(r.result.resultType).toBe('complete');
    expect(r.result._meta[META.serverInfo]).toEqual({ name: 'one', version: '1.2.3' });
    expect(JSON.parse(r.result.content[0].text)).toEqual({ text: 'hi' });
    expect((calls[0] as any).client).toBe('LM Studio');
  });

  it('list results carry cache hints', async () => {
    const { p } = make();
    const r = (await p.handle(req(1, 'tools/list', modern()))) as any;
    expect(r.result.ttlMs).toBeGreaterThan(0);
    expect(r.result.cacheScope).toBe('private');
  });

  it('an unsupported version → UnsupportedProtocolVersionError (-32022) with the supported list', async () => {
    const { p } = make();
    const r = (await p.handle(req(1, 'tools/list', { _meta: { [META.version]: '1900-01-01' } }))) as any;
    expect(r.error.code).toBe(-32022);
    expect(r.error.data).toEqual({ supported: SUPPORTED_VERSIONS, requested: '1900-01-01' });
  });

  it('server/discover lists versions, capabilities and identity', async () => {
    const { p } = make();
    const r = (await p.handle(req(1, 'server/discover', modern()))) as any;
    expect(r.result.supportedVersions).toContain('2026-07-28');
    expect(r.result.supportedVersions).toContain('2025-11-25');
    expect(r.result.capabilities.tools).toBeDefined();
    expect(r.result._meta[META.serverInfo].name).toBe('one');
  });
});

describe('errors', () => {
  it('unknown methods → -32601; parse-level problems → -32600', async () => {
    const { p } = make();
    await init(p);
    expect(((await p.handle(req(5, 'prompts/list'))) as any).error.code).toBe(ERR.methodNotFound);
    expect(((await p.handle(req(5, 'logging/setLevel', { level: 'debug' }))) as any).error.code).toBe(ERR.methodNotFound);
    expect(((await p.handle({ jsonrpc: '1.0', id: 1, method: 'ping' })) as any).error.code).toBe(ERR.invalidRequest);
    expect(((await p.handle({ jsonrpc: '2.0', id: { x: 1 }, method: 'ping' })) as any).error.code).toBe(ERR.invalidRequest);
    expect(((await p.handle('nope')) as any).error.code).toBe(ERR.invalidRequest);
    expect(((await p.handle([])) as any).error.code).toBe(ERR.invalidRequest);
    expect(((await p.handle(req(6, 'tools/list', 'x'))) as any).error.code).toBe(ERR.invalidParams);
  });

  it('a response object (no method) is ignored', async () => {
    const { p } = make();
    expect(await p.handle({ jsonrpc: '2.0', id: 9, result: {} })).toBeNull();
  });

  it('an unknown tool is a protocol error (-32602)', async () => {
    const { p } = make();
    await init(p);
    expect(((await p.handle(req(2, 'tools/call', { name: 'nope' }))) as any).error.code).toBe(ERR.invalidParams);
  });

  it('a tool failure is an isError result the model can read; an unexpected one never shows its message', async () => {
    const { p, calls } = make();
    await init(p);
    const a = (await p.handle(req(2, 'tools/call', { name: 'fail', arguments: { text: 'x' } }))) as any;
    expect(a.result.isError).toBe(true);
    expect(a.result.content[0].text).toBe('ENOENT: Not found: a.md');
    const b = (await p.handle(req(3, 'tools/call', { name: 'crash', arguments: { text: 'x' } }))) as any;
    expect(b.result.isError).toBe(true);
    expect(b.result.content[0].text).not.toContain('/home/');
    expect(calls.map((c: any) => c.code)).toEqual(['ENOENT', 'EIO']);
  });

  it('batches are refused (they would bypass the concurrency cap; MCP dropped them in 2025-06-18)', async () => {
    const { p } = make();
    await init(p);
    const r = (await p.handle([req(1, 'ping'), req(2, 'ping')])) as any;
    expect(r.error.code).toBe(ERR.invalidRequest);
    expect(r.error.message).toMatch(/Batches are not supported/);
  });
});

describe('scope: write tools', () => {
  it('are not listed (and cannot be called) while no folder may be written', async () => {
    const ro = make({ canWrite: false });
    await init(ro.p);
    const list = (await ro.p.handle(req(2, 'tools/list'))) as any;
    expect(list.result.tools.some((t: any) => t.name === 'write_file')).toBe(false);
    expect(((await ro.p.handle(req(3, 'tools/call', { name: 'write_file', arguments: { text: 'x' } }))) as any).error.code).toBe(ERR.invalidParams);
    const rw = make({ canWrite: true });
    await init(rw.p);
    expect(((await rw.p.handle(req(2, 'tools/list'))) as any).result.tools.some((t: any) => t.name === 'write_file')).toBe(true);
  });
});

describe('tools/list: the advertised view (what the model pays for on every turn)', () => {
  const scoped: ToolDef = { ...echo, name: 'scoped', argHint: 'Filters go inside query.', inputSchema: { ...echo.inputSchema, properties: { folder: { type: 'string', description: 'Folder', maxLength: 64 }, ...echo.inputSchema.properties } } };

  it('leaves out maxLength (checkArgs still enforces it) and hidden parameters (still accepted)', async () => {
    const d = describeTool(scoped, '2025-11-25', new Set(['folder']));
    expect(Object.keys(d.inputSchema.properties)).toEqual(['text', 'n', 'flag']);
    expect(JSON.stringify(d)).not.toContain('maxLength');
    expect(d.inputSchema).toMatchObject({ type: 'object', required: ['text'], additionalProperties: false });
    expect((d.inputSchema.properties as any).n).toEqual({ type: 'integer', description: 'n', minimum: 1, maximum: 5 });
    const p = new McpProtocol({ info: { name: 'one', version: '1' }, instructions: '', tools: () => [scoped], hiddenParams: () => ['folder'] });
    await init(p);
    expect(((await p.handle(req(2, 'tools/list'))) as any).result.tools[0].inputSchema.properties.folder).toBeUndefined();
    const ok = (await p.handle(req(3, 'tools/call', { name: 'scoped', arguments: { text: 'a', folder: 'notes' } }))) as any;
    expect(JSON.parse(ok.result.content[0].text)).toEqual({ folder: 'notes', text: 'a' });
    const long = (await p.handle(req(4, 'tools/call', { name: 'scoped', arguments: { text: 'x'.repeat(11) } }))) as any;
    expect(long.result.content[0].text).toMatch(/^EINVAL: "text" is too long/);
  });

  it('the title sits in annotations only for clients older than 2025-06-18', () => {
    expect((describeTool(echo, '2025-03-26').annotations as any).title).toBe('Echo');
    expect((describeTool(echo, '2025-06-18').annotations as any).title).toBeUndefined();
    expect((describeTool(echo, '2026-07-28').annotations as any).title).toBeUndefined();
    expect(describeTool(echo, '2026-07-28').title).toBe('Echo');
  });

  it('an unknown parameter gets the tool\'s hint; errors are one line', async () => {
    const multi: ToolDef = { ...echo, name: 'multi', run: async () => Promise.reject(new ToolError('ENOENT', 'Not found: a.md\nHeadings:\n a | b')) };
    const p = new McpProtocol({ info: { name: 'one', version: '1' }, instructions: '', tools: () => [scoped, multi] });
    await init(p);
    const r = (await p.handle(req(2, 'tools/call', { name: 'scoped', arguments: { text: 'a', path: 'notes/' } }))) as any;
    expect(r.result.content[0].text).toBe('EINVAL: Unknown parameter "path". This tool takes: folder, text, n, flag. Filters go inside query.');
    const m = (await p.handle(req(3, 'tools/call', { name: 'multi', arguments: { text: 'a' } }))) as any;
    expect(m.result.content[0].text).toBe('ENOENT: Not found: a.md Headings: a | b');
  });
});

describe('checkArgs', () => {
  const s = echo.inputSchema;
  it('coerces what small models send as strings, refuses the rest with a helpful message', () => {
    expect(checkArgs(s, { text: 'a', n: '3', flag: 'true' })).toEqual({ text: 'a', n: 3, flag: true });
    expect(() => checkArgs(s, { text: 'a', extra: 1 })).toThrow(/Unknown parameter "extra". This tool takes: text, n, flag/);
    expect(() => checkArgs(s, {})).toThrow(/Missing parameter "text"/);
    expect(() => checkArgs(s, { text: 'a', n: 9 })).toThrow(/at most 5/);
    expect(() => checkArgs(s, { text: 'a', n: 1.5 })).toThrow(/whole number/);
    expect(() => checkArgs(s, { text: 'x'.repeat(11) })).toThrow(/too long/);
    expect(() => checkArgs(s, { text: 5 })).toThrow(/must be a string/);
    expect(checkArgs(s, { text: 'a', n: null })).toEqual({ text: 'a' });
  });
});
