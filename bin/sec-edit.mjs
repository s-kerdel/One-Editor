#!/usr/bin/env node
// sec-edit CLI
//   sec-edit [folder|file ...]                     open in the desktop app (returns immediately)
//   sec-edit serve [folder ...] [--port N] [--open]  browser mode (prints a URL with an access token); the page
//                                                    opens only these folders and folders inside them
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const need = (file, what) => {
  if (!fs.existsSync(path.join(root, file))) {
    console.error(`sec-edit: ${what} is not built yet — run \`npm run build\` in ${root}`);
    process.exit(1);
  }
};

if (args[0] === '-h' || args[0] === '--help') {
  console.log('Usage:\n  sec-edit [folder|file ...]                   open in the desktop app\n  sec-edit serve [folder ...] [--port N] [--open]  browser mode');
  process.exit(0);
}

if (args[0] === 'serve') {
  need('dist/server/cli.mjs', 'the server');
  process.argv = [process.argv[0], path.join(root, 'dist/server/cli.mjs'), ...args.slice(1)];
  await import(pathToFileURL(path.join(root, 'dist/server/cli.mjs')).href);
} else {
  need('dist/main/main.cjs', 'the desktop app');
  let electron;
  try {
    electron = createRequire(import.meta.url)('electron'); // the binary path when required from Node
  } catch {
    console.error('sec-edit: electron is not installed (npm install), or use `sec-edit serve`.');
    process.exit(1);
  }
  const targets = args.map((a) => path.resolve(a));
  // Detached: the terminal is free immediately; a running instance receives the paths (single instance).
  const child = spawn(electron, [root, ...targets], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
}
