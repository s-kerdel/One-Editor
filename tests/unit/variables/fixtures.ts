// Shared sample: the variables.md from the user guide (comments, envs, targets, secrets).
import { parseNoteMeta, parseVariablesFile } from '../../../src/renderer/variables/parse';
import type { Scope } from '../../../src/renderer/variables/resolve';

export const VARIABLES_MD = `# Lab variables

Prose is fine here; only the first yaml block is data.

\`\`\`yaml
# Defaults for every environment
vars:
  domain: corp.local   # AD domain
  share: ADMIN$
  ns: default
  port: 8080
  fqdn: "{{host}}.{{domain}}"
  host: web01

secrets: [db_pass, password]

targets:
  DC01:     { ip: 10.0.0.10, user: administrator, os: windows }
  WS01:     { ip: 10.0.0.21, user: alice, os: windows }
  Linux-WS:
    ip: 10.0.0.30
    user: root
    os: ubuntu
    password: vault

envs:
  lab:
    vars:
      ns: lab
  prod:
    vars:
      ns: prod
      db_pass: vault:prod-db
    targets:
      DC01: { ip: 192.168.1.10 }
      PRODWEB: { ip: 192.168.1.50, os: linux }
\`\`\`

\`\`\`yaml
vars: { ignored: true }
\`\`\`
`;

export const file = (text = VARIABLES_MD, path = 'variables.md') => parseVariablesFile(path, text);

export function scope(over: Partial<Scope> & { text?: string; noteText?: string } = {}): Scope {
  const { text, noteText, ...rest } = over;
  return {
    file: file(text),
    note: noteText ? parseNoteMeta(noteText) : null,
    env: null,
    target: null,
    fence: new Map(),
    builtins: { title: 'Runbook', now: new Date(2026, 10, 19, 9, 5), dateFormat: 'YYYY-MM-DD', timeFormat: 'HH:mm' },
    vaultScope: 'C:/work/lab',
    ...rest,
  };
}
