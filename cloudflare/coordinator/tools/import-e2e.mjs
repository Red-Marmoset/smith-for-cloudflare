// Imports one repository into a coordinator you own, follows the import to its end, then clones the result back through
// the proxy with its large files and checks that git-lfs resolves them. Nothing is deployed and nothing reaches GitHub
// beyond reading the source you name.
//
// What it needs: a coordinator (`npm run dev` at http://localhost:8787 with its local D1 seeded, or a staging coordinator)
// whose workspace has an online build machine with git-lfs installed (its agent then advertises `smith-import`); an owner
// or admin token for that workspace; and --source, an https:// or ssh:// (or git@) URL the machine's own git login can
// clone. A source with a file over the threshold (10 MB here) exercises the rewrite: pass --expect-rewrite to insist on it,
// as the drill of the spec does with a 15 MB and a 40 MB file (the 40 MB one is over what storage takes, so the import
// must move both to large files for the clone to succeed). The Worker refuses file:// sources, so a local repository has
// to be served over https or ssh (a GitHub repository of your own is the simplest).
//
// Usage: tools\import-e2e.bat --workspace <64-hex id> --source <url> [--origin http://localhost:8787] [--expect-rewrite]
// The owner token comes from SMITH_TOKEN (kept out of the command line), or --token <smith_pat_…>.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({ options: {
  origin: { type: 'string', default: 'http://localhost:8787' },
  token: { type: 'string', default: process.env.SMITH_TOKEN },
  workspace: { type: 'string' },
  source: { type: 'string' },
  'expect-rewrite': { type: 'boolean', default: false },
} });
for (const required of ['token', 'workspace', 'source'])
  if (!opts[required]) { console.error(`--${required} is required (see the top of tools/import-e2e.mjs)`); process.exit(2); }
const { origin, token, workspace, source } = opts;

const work = mkdtempSync(path.join(tmpdir(), 'import-e2e-'));
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
const api = `${origin}/api/v2/workspaces/${workspace}`;
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const name = source.replace(/\.git$/, '').replace(/^.*[/:]/, '');

async function call(route, body) {
  const response = await fetch(`${api}${route}`, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`${body ? 'POST' : 'GET'} ${route} answered ${response.status}: ${text}`);
  return JSON.parse(text);
}
function git(args) {
  const result = spawnSync('git', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (result.status !== 0) throw new Error(`git ${args.find(a => !a.startsWith('-') && !a.includes('=')) ?? ''} failed (${result.status})`);
  return result.stdout;
}

console.log(`--- starting the import of ${source}`);
const started = await call('/imports', { org: 'e2e', repos: [{ fullName: `e2e/${name}`, url: source, defaultBranch: '' }], thresholdBytes: 10 * 1024 * 1024, link: false });
const id = started.import.id;
let row = null;
for (let i = 0; i < 360; i++) {
  await new Promise(resolve => setTimeout(resolve, 5000));
  row = (await call(`/imports/${id}`)).import.repos[0];
  console.log(`  ${row.state} ${row.message ?? ''}`);
  if (['done', 'failed', 'machine', 'cancelled'].includes(row.state)) break;
}
if (row?.state !== 'done') throw new Error(`import ended as ${row?.state}: ${row?.message}`);
if (opts['expect-rewrite'] && !row.rewritten) throw new Error(`the import did not rewrite history (a file over the threshold must have moved to large files): ${row.message}`);

console.log('--- cloning back through the proxy');
// The credential rides as a header on every git and git-lfs request to this coordinator, never in a URL or a config file.
const auth = 'Authorization: Basic ' + Buffer.from(`${workspace.slice(0, 12)}:${token}`).toString('base64');
const dst = path.join(work, 'dst');
git(['-c', `http.${origin}/.extraheader=${auth}`, '-c', 'credential.helper=', 'clone', '-q', `${origin}/git/${row.projectId}.git`, dst]);
const pointers = git(['-C', dst, 'lfs', 'ls-files']).split('\n').filter(Boolean);
for (const line of pointers) {
  const file = line.split(' ').slice(2).join(' ');
  const size = statSync(path.join(dst, file)).size;
  if (size < 1024) throw new Error(`${file} is still a pointer (${size} bytes): git-lfs did not resolve it through the proxy`);
}
const rewritten = row.rewritten ? `, rewritten (${row.movedFiles} file(s) to large files)` : '';
console.log(`OK: imported as ${row.projectId}${rewritten}, cloned back with its large files: ${pointers.length ? pointers.join('; ') : 'none'} (work dir ${work})`);
