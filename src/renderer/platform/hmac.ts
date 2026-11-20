// HMAC-SHA256, synchronous and tiny. Browser mode signs each workspace media URL with the server's media
// key, so an image URL (which ends up in copied HTML, history, "Copy image address") grants that one file
// — never the session token. WebCrypto is async; media URLs are built synchronously while sanitizing.
// Round constants come from the primes (FIPS 180-4 §4.2.2 / §5.3.3) instead of two 64-entry tables.
const K: number[] = [];
const H0: number[] = [];
for (let p = 2, n = 0; n < 64; p++) {
  let prime = true;
  for (let d = 2; d * d <= p; d++) if (p % d === 0) prime = false;
  if (!prime) continue;
  if (n < 8) H0[n] = ((Math.sqrt(p) % 1) * 2 ** 32) | 0;
  K[n++] = ((Math.cbrt(p) % 1) * 2 ** 32) | 0;
}

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

export function sha256(data: Uint8Array): Uint8Array {
  const len = data.length;
  const total = ((len + 72) >> 6) << 6; // message + 0x80 + 64-bit length, rounded up to 64-byte blocks
  const buf = new Uint8Array(total);
  buf.set(data);
  buf[len] = 0x80;
  const v = new DataView(buf.buffer);
  v.setUint32(total - 8, Math.floor(len / 2 ** 29));
  v.setUint32(total - 4, len * 8);
  const h = H0.slice();
  const w = new Int32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = v.getInt32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15];
      const b = w[i - 2];
      w[i] = (w[i - 16] + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + w[i - 7] + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) | 0;
    }
    let [a, b, c, d, e, f, g, k] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      k = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    [a, b, c, d, e, f, g, k].forEach((x, i) => (h[i] = (h[i] + x) | 0));
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  h.forEach((x, i) => ov.setInt32(i * 4, x));
  return out;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** HMAC-SHA256(key given as hex, UTF-8 message) as lowercase hex. */
export function hmacSha256Hex(keyHex: string, message: string): string {
  let key: Uint8Array = new Uint8Array((keyHex.match(/../g) ?? []).map((x) => parseInt(x, 16)));
  if (key.length > 64) key = sha256(key);
  const msg = new TextEncoder().encode(message);
  const inner = new Uint8Array(64 + msg.length);
  const outer = new Uint8Array(96);
  for (let i = 0; i < 64; i++) {
    inner[i] = (key[i] ?? 0) ^ 0x36;
    outer[i] = (key[i] ?? 0) ^ 0x5c;
  }
  inner.set(msg, 64);
  outer.set(sha256(inner), 64);
  return hex(sha256(outer));
}
