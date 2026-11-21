// Access tokens (src/mcp/tokens.ts, parsing in shared/mcp.ts): 256-bit, `one_` + base64url; only a SHA-256
// is stored; a presented token matches in constant time against every stored hash; revoked = no match.
import { describe, expect, it } from 'vitest';
import { MAX_TOKENS, TOKEN_RE, generateToken, hashToken, matchToken, parseTokens, tokenHint } from '../../../src/mcp/tokens';

const rec = (raw: string, id = 'aaaaaaaa', name = 'LM Studio') => ({ id, name, sha256: hashToken(raw), hint: tokenHint(raw), created: 1 });

describe('tokens', () => {
  it('one_ + 43 base64url characters (32 random bytes), never the same twice', () => {
    const a = generateToken();
    expect(a).toMatch(TOKEN_RE);
    expect(Buffer.from(a.slice(4), 'base64url')).toHaveLength(32);
    expect(new Set(Array.from({ length: 50 }, generateToken)).size).toBe(50);
    expect(hashToken(a)).toMatch(/^[a-f0-9]{64}$/);
    expect(tokenHint(a)).toBe(a.slice(4, 8));
  });

  it('matches the right record; missing, malformed, unknown and revoked tokens match nothing', () => {
    const a = generateToken();
    const b = generateToken();
    const records = [rec(a, 'aaaaaaaa', 'LM Studio'), rec(b, 'bbbbbbbb', 'Codex CLI')];
    expect(matchToken(a, records)?.name).toBe('LM Studio');
    expect(matchToken(b, records)?.name).toBe('Codex CLI');
    for (const bad of [undefined, '', 'one_', a.slice(0, -1), `${a}x`, a.toUpperCase(), hashToken(a), 42, generateToken()]) expect(matchToken(bad, records)).toBeNull();
    expect(matchToken(a, records.filter((r) => r.id !== 'aaaaaaaa'))).toBeNull(); // revoked
    expect(matchToken(a, [])).toBeNull();
  });

  it('parseTokens keeps valid records only (a broken entry matches nothing), at most MAX_TOKENS', () => {
    const a = generateToken();
    const good = rec(a);
    const out = parseTokens([good, { ...good }, { ...good, id: 'bbbbbbbb', sha256: 'zz' }, { ...good, id: 'cccccccc', name: '  ' }, { ...good, id: '../x' }, null, 'x']);
    expect(out).toEqual([good]);
    expect(parseTokens({})).toEqual([]);
    const many = Array.from({ length: MAX_TOKENS + 5 }, (_, i) => rec(generateToken(), (0x10000000 + i).toString(16)));
    expect(parseTokens(many)).toHaveLength(MAX_TOKENS);
    expect(parseTokens([{ ...good, name: 'App\u0000\nName' }])[0].name).toBe('AppName');
  });
});
