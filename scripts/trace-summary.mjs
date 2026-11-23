// Reads a Playwright trace without a display: the failed step, its call log, the page's console
// messages, uncaught page errors and failed requests - as plain text.
//   npm run trace:summary -- .tmp/e2e-file/<area>/results            (every trace.zip below that folder)
//   npm run trace:summary -- path/to/trace.zip
// Needs the `unzip` program (present on the dev machine). Reads only; writes nothing.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const target = process.argv[2];
if (!target || !fs.existsSync(target)) {
  console.error('usage: npm run trace:summary -- <results folder | trace.zip>');
  process.exit(2);
}
const find = (p, name) => (fs.statSync(p).isDirectory() ? fs.readdirSync(p).flatMap((f) => find(path.join(p, f), name)) : path.basename(p) === name ? [p] : []);
const zips = target.endsWith('.zip') ? [target] : find(target, 'trace.zip');
const contexts = target.endsWith('.zip') ? [] : find(target, 'error-context.md');
if (!zips.length) console.log(`no trace.zip under ${target} (browser E2E keeps a trace only for a failed test; add "--trace on" to force one)`);

const unzip = (zip, args) => execFileSync('unzip', [...args, zip], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
const short = (s, n = 400) => { const t = String(s ?? '').replace(/\u001b\[[0-9;]*m/g, '').replace(/([?&]token=)[\w-]+/g, '$1...'); return t.length > n ? t.slice(0, n) + ' ...' : t; };
const events = (zip, entry) => execFileSync('unzip', ['-p', zip, entry], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }).split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });

for (const zip of zips) {
  const names = unzip(zip, ['-Z1']).split('\n');
  const all = names.filter((n) => /(^|-)trace\.trace$|^test\.trace$/.test(n)).flatMap((n) => events(zip, n));
  const net = names.filter((n) => /trace\.network$/.test(n)).flatMap((n) => events(zip, n));
  const title = all.find((e) => e.type === 'context-options' && e.title)?.title ?? '';
  console.log(`\n=== ${path.relative(process.cwd(), zip)}\n    ${title}`);

  const calls = new Map();
  for (const e of all) {
    if (e.type === 'before') calls.set(e.callId, { ...e, log: [] });
    else if (e.type === 'log') calls.get(e.callId)?.log.push(e.message);
    else if (e.type === 'after') Object.assign(calls.get(e.callId) ?? {}, { endTime: e.endTime, error: e.error });
  }
  const failed = [...calls.values()].filter((c) => c.error);
  console.log(`\n-- failed steps (${failed.length})`);
  for (const c of failed) {
    const at = c.stack?.[0] ? `  at ${path.relative(process.cwd(), c.stack[0].file)}:${c.stack[0].line}` : '';
    console.log(`* ${c.title ?? `${c.class}.${c.method}`}${at}\n    ${short(c.error.message ?? c.error.error?.message, 1200).replace(/\n/g, '\n    ')}`);
    for (const l of c.log.slice(-8)) console.log(`      log: ${short(l, 200)}`);
  }
  const errors = all.filter((e) => e.type === 'error');
  for (const e of errors) console.log(`* test error: ${short(e.message, 1200).replace(/\n/g, '\n    ')}`);

  const pageErrors = all.filter((e) => e.type === 'event' && e.method === 'pageError');
  console.log(`\n-- uncaught page errors (${pageErrors.length})`);
  for (const e of pageErrors) { const er = e.params?.error?.error ?? e.params?.error ?? {}; console.log(`* ${short(er.stack || er.message || JSON.stringify(e.params), 800).replace(/\n/g, '\n    ')}`); }

  const cons = all.filter((e) => e.type === 'console');
  const loud = cons.filter((e) => e.messageType === 'error' || e.messageType === 'warning');
  console.log(`\n-- console: ${cons.length} messages, ${loud.length} errors/warnings (last 30 of ${process.env.TRACE_ALL ? 'all' : 'errors/warnings; TRACE_ALL=1 shows all'})`);
  for (const e of (process.env.TRACE_ALL ? cons : loud).slice(-30)) console.log(`* [${e.messageType}] ${short(e.text)}${e.location?.url ? `  (${short(e.location.url, 80)}:${e.location.lineNumber})` : ''}`);

  const bad = net.filter((e) => e.type === 'resource-snapshot' && (e.snapshot?.response?.status >= 400 || e.snapshot?.response?.status === -1 || e.snapshot?.response?._failureText));
  console.log(`\n-- failed requests (${bad.length})`);
  for (const e of bad.slice(-20)) console.log(`* ${e.snapshot.response.status} ${e.snapshot.request.method} ${short(e.snapshot.request.url, 160)}${e.snapshot.response._failureText ? `  ${e.snapshot.response._failureText}` : ''}`);

  const steps = [...calls.values()].filter((c) => c.class !== 'Test' || c.method === 'expect' || c.method === 'pw:api');
  console.log(`\n-- last steps before the end (of ${steps.length})`);
  for (const c of steps.slice(-8)) console.log(`  ${c.error ? 'x' : ' '} ${short(c.title ?? `${c.class}.${c.method} ${JSON.stringify(c.params ?? {})}`, 160)}`);
}
if (contexts.length) console.log(`\npage snapshot at the failure (open this file):\n${contexts.map((c) => `  ${path.relative(process.cwd(), c)}`).join('\n')}`);
