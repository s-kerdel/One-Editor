// Stdio hygiene: stdout carries JSON-RPC and nothing else, or the client drops the connection. This
// module is cli.ts's FIRST import (ES modules evaluate in import order), so it runs before any other
// module body: every console method and any stray process.stdout.write go to stderr from here on.
// The transport writes through `writeProtocol` only.
const realWrite = process.stdout.write.bind(process.stdout) as (chunk: string | Uint8Array, cb?: (err?: Error | null) => void) => boolean;
const toStderr = process.stderr.write.bind(process.stderr);

for (const m of ['log', 'info', 'debug', 'warn', 'trace', 'dir', 'table'] as const) {
  (console as unknown as Record<string, unknown>)[m] = (...a: unknown[]) => console.error(...a);
}
(process.stdout as unknown as { write: unknown }).write = (chunk: unknown, ...rest: unknown[]) => (toStderr as (...x: unknown[]) => boolean)(chunk, ...rest);

/** The one way to stdout: a JSON-RPC message line. */
export function writeProtocol(line: string, cb?: (err?: Error | null) => void): boolean {
  return realWrite(line, cb);
}
