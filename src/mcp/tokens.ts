// Access tokens for MCP clients, transport-neutral (stdio reads ONE_MCP_TOKEN from its environment; a
// future HTTPS transport takes the same tokens as bearer tokens). mcp.json keeps only a SHA-256 per
// token; the raw token exists in main (encrypted with the OS keyring, mcp-tokens.json) and in the client's
// config. Compared in constant time against every stored hash.
import crypto from 'node:crypto';

import { TOKEN_RE, type TokenRecord } from '../shared/mcp';
export { TOKEN_ENV, TOKEN_RE, MAX_TOKENS, parseTokens, cleanTokenName, type TokenRecord } from '../shared/mcp';

export const generateToken = () => `one_${crypto.randomBytes(32).toString('base64url')}`;
export const hashToken = (raw: string) => crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
export const tokenHint = (raw: string) => raw.slice(4, 8);

/** The record a raw token belongs to, or null (missing, malformed, unknown, revoked). Constant time per record. */
export function matchToken(raw: unknown, records: readonly TokenRecord[]): TokenRecord | null {
  if (typeof raw !== 'string' || !TOKEN_RE.test(raw)) return null;
  const h = Buffer.from(hashToken(raw), 'hex');
  let hit: TokenRecord | null = null;
  for (const r of records) {
    const b = Buffer.from(r.sha256, 'hex');
    if (b.length === h.length && crypto.timingSafeEqual(b, h) && !hit) hit = r; // no early exit
  }
  return hit;
}
