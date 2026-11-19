// Closes an iteration: bumps the minor version, commits "Release vX.Y.0" and adds an annotated tag.
//   npm run iteration -- "Short summary of the iteration"
// Requires a clean working tree (commit the subject commits first). Uses the repo-local git identity.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const summary = process.argv.slice(2).join(' ').trim();
if (!summary) {
  console.error('Usage: npm run iteration -- "Short summary"');
  process.exit(1);
}
if (git('status', '--porcelain')) {
  console.error('Working tree is not clean — commit (or stash) your changes first.');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const tags = git('tag', '--list', 'v*', '--sort=-v:refname').split('\n').filter(Boolean);
const [maj, min] = (tags[0] ?? `v${pkg.version}`).replace(/^v/, '').split('.').map(Number);
// The very first iteration tags the current version; later ones bump the minor.
const next = tags.length ? `${maj}.${min + 1}.0` : pkg.version;

if (next !== pkg.version) {
  execFileSync('npm', ['version', next, '--no-git-tag-version', '--allow-same-version'], { stdio: 'ignore', shell: process.platform === 'win32' });
  git('add', 'package.json', 'package-lock.json');
  git('commit', '-q', '-m', `Release v${next}`);
}
git('tag', '-a', `v${next}`, '-m', summary);
console.log(`Tagged v${next}: ${summary}`);
