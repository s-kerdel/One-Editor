// Temp dirs for platform tests live inside the project (.tmp/platform), never in the system temp dir.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.tmp/platform/unit');

export async function tmpRoot(prefix: string): Promise<string> {
  await fsp.mkdir(BASE, { recursive: true });
  return fsp.mkdtemp(path.join(BASE, `${prefix}-`));
}
