// Pushes and pulls two large files (1 MB, 20 MB) through a coordinator with a real git-lfs client, then checks that a
// fresh clone gets the same bytes back. Nothing is deployed; point it at `npm run dev` (http://localhost:8787) or at
// a staging coordinator you own.
//
// Usage: tools\lfs-e2e.bat --username <12-hex workspace prefix> [--project senet] [--origin http://localhost:8787]
// The token (a smith_pat_… with the build scope) comes from SMITH_TOKEN (kept out of the command line), or --token.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({ options: {
  origin: { type: 'string', default: 'http://localhost:8787' },
  project: { type: 'string', default: 'senet' },
  token: { type: 'string', default: process.env.SMITH_TOKEN },
  username: { type: 'string' },
} });
for (const required of ['token', 'username'])
  if (!opts[required]) { console.error(`--${required} is required (see the top of tools/lfs-e2e.mjs)`); process.exit(2); }
const { origin, project, token, username } = opts;

// The credential rides in lfs.url (a local drill; git-lfs otherwise needs a credential helper it can run non-interactively).
const lfsUrl = `${origin.replace(/^(https?:\/\/)/, `$1${username}:${token}@`)}/git/${project}.git/info/lfs`;
const work = mkdtempSync(path.join(tmpdir(), 'lfs-e2e-'));
const src = path.join(work, 'src'), bare = path.join(work, 'bare.git'), dst = path.join(work, 'dst');

function git(args, extraEnv = {}) {
  const result = spawnSync('git', args, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv }, stdio: ['ignore', 'inherit', 'inherit'] });
  if (result.status !== 0) throw new Error(`git ${args.filter(a => !a.startsWith('-') && a !== src && a !== dst).slice(0, 2).join(' ')} failed (${result.status})`);
}
function configure(repo) {
  git(['-C', repo, 'lfs', 'install', '--local']);
  git(['-C', repo, 'config', 'lfs.url', lfsUrl]);
  git(['-C', repo, 'config', 'lfs.locksverify', 'false']);
}
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');

// A repository with two tracked binaries, pushed to a bare neighbour so git-lfs has a remote to push objects for.
git(['init', '-q', src]); git(['init', '-q', '--bare', bare]);
configure(src);
git(['-C', src, 'remote', 'add', 'origin', bare]);
git(['-C', src, 'lfs', 'track', '*.bin']);
for (const mb of [1, 20]) writeFileSync(path.join(src, `file${mb}.bin`), randomBytes(mb * 1024 * 1024));
git(['-C', src, 'add', '.gitattributes', 'file1.bin', 'file20.bin']);
git(['-C', src, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.test', 'commit', '-qm', 'lfs objects']);
console.log(`--- pushing LFS objects to ${origin}/git/${project}.git/info/lfs`);
git(['-C', src, 'lfs', 'push', 'origin', 'HEAD']);
git(['-C', src, 'push', '-q', 'origin', 'HEAD:master']);

console.log('--- a fresh clone pulls the objects back');
// The clone keeps the pointers (no smudge yet): the LFS endpoint is configured on the clone before the objects are pulled.
git(['clone', '-q', bare, dst], { GIT_LFS_SKIP_SMUDGE: '1' });
configure(dst);
git(['-C', dst, 'lfs', 'pull']);
for (const mb of [1, 20]) {
  const name = `file${mb}.bin`;
  if (statSync(path.join(dst, name)).size !== mb * 1024 * 1024) throw new Error(`${name} is a pointer, not the object`);
  if (sha(path.join(dst, name)) !== sha(path.join(src, name))) throw new Error(`${name} differs after pull`);
}
console.log(`OK: both objects round-tripped through ${origin}/git/${project}.git/info/lfs (work dir ${work})`);
