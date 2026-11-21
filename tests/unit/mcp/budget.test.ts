// Token budget of what the model carries on EVERY turn: the tool definitions (tools/list) and the server
// instructions. Local models in LM Studio have small context windows, so these must not grow back
// silently. Raise a budget only with a reason (and re-measure: docs/AGENTS.md, mcp notes).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_SETTINGS } from '../../../src/shared/api';
import { INSTRUCTIONS, OneMcpServer } from '../../../src/mcp/server';

/** Characters (≈ 3.6 per token). raw = the tools/list JSON; visible = name + description + schema, what clients put in the prompt. */
const BUDGET = {
  instructions: 600,
  readOnly: { raw: 5_000, visible: 4_300 },
  // +700 / +700 (v0.5.2): replace_in_files and the batch params (paths, to_folder, all, confirm), each saving
  // many calls (100 moves or deletes in one; a replace across files instead of one replace_text per file).
  withWrites: { raw: 10_700, visible: 9_200 },
};

const BASE = path.resolve(__dirname, '../../../.tmp/mcp/unit');
let tmp: string;
const servers: OneMcpServer[] = [];

async function list(mode: 'read' | 'write') {
  const s = new OneMcpServer({ configDir: path.join(tmp, `cfg-${mode}`), settings: { ...DEFAULT_SETTINGS }, transport: 'stdio', win: false, writes: true });
  servers.push(s);
  s.applyConfig({ version: 1, enabled: true, folders: [{ id: 'aaaaaaaa', alias: 'notes', path: path.join(tmp, 'notes'), mode }] });
  await s.protocol.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'budget' } } });
  const tools = ((await s.protocol.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as any).result.tools as any[];
  const visible = JSON.stringify(tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })));
  return { tools, raw: JSON.stringify(tools).length, visible: visible.length };
}

beforeAll(() => {
  tmp = path.join(BASE, `budget-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(path.join(tmp, 'notes'), { recursive: true });
});

afterAll(async () => {
  for (const s of servers) await s.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('per-turn token budget', () => {
  it('server instructions stay lean', () => {
    expect(INSTRUCTIONS.length).toBeLessThanOrEqual(BUDGET.instructions);
  });

  it('read-only tool list', async () => {
    const r = await list('read');
    expect(r.tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
    expect(r.raw, `tools/list is ${r.raw} characters`).toBeLessThanOrEqual(BUDGET.readOnly.raw);
    expect(r.visible, `model-visible tools are ${r.visible} characters`).toBeLessThanOrEqual(BUDGET.readOnly.visible);
  });

  it('tool list with the write tools', async () => {
    const r = await list('write');
    expect(r.tools.some((t) => !t.annotations.readOnlyHint)).toBe(true);
    expect(r.raw, `tools/list is ${r.raw} characters`).toBeLessThanOrEqual(BUDGET.withWrites.raw);
    expect(r.visible, `model-visible tools are ${r.visible} characters`).toBeLessThanOrEqual(BUDGET.withWrites.visible);
  });
});
