// Creates an invitation and prepared Smith project for a trusted experiment tester.
// The caller must secure --state-dir to its OS account before running this tool.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(await readFile(path.join(root, 'wrangler.jsonc'), 'utf8'));
const index = process.argv.indexOf('--state-dir');
if (index === -1 || !process.argv[index + 1]) throw new Error('Provide an existing, owner-restricted --state-dir');
const directory = path.resolve(process.argv[index + 1]);
const metadata = await stat(directory);
if (!metadata.isDirectory() || (process.platform !== 'win32' && (metadata.mode & 0o077))) throw new Error('State directory must be owner-only');
if (process.platform === 'win32') {
  // Inspect the ACL before writing credentials. Only the current account, SYSTEM
  // and the local Administrators group may have an allow rule.
  const script = "$a=Get-Acl -LiteralPath $env:SMITH_STATE_DIR; $u=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $bad=@($a.Access | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -notin @($u,'S-1-5-18','S-1-5-32-544') }); if($bad.Count){exit 1}";
  const check = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, SMITH_STATE_DIR: directory }, windowsHide: true });
  if (check.status !== 0) throw new Error('Restrict the Windows state directory ACL before provisioning');
}
const managementToken = process.env.CLOUDFLARE_API_TOKEN;
if (!managementToken) throw new Error('CLOUDFLARE_API_TOKEN is required');
const statePath = path.join(directory, 'tester.json');
let previous;
try { previous = JSON.parse(await readFile(statePath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const userId = previous?.userId ?? `tester-${randomUUID()}`;
const session = randomBytes(32).toString('hex');
const code = randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('hex');
async function sql(query, params = []) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${config.account_id}/d1/database/${config.d1_databases[0].database_id}/query`, {
    method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${managementToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ sql: query, params }),
  });
  const body = await response.json();
  if (!response.ok || !body.success) throw new Error(`Provisioning database operation failed (${response.status})`);
}
async function api(route, body) {
  const response = await fetch(config.vars.ORIGIN + route, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Provisioning ${route} failed (${response.status})`);
  return response.json();
}
await sql('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)', [userId, Date.now()]);
if (previous?.sessionToken) await sql('DELETE FROM sessions WHERE token_hash = ?', [digest(previous.sessionToken)]);
await sql('DELETE FROM invites WHERE user_id = ?', [userId]);
await sql('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', [digest(session), userId, Date.now() + 86400000]);
try {
  const { workspaceId } = await api('/api/v2/workspaces', { requestId: 'primary-experiment' });
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (revision.status !== 0 || !/^[a-f0-9]{40}$/.test(revision.stdout.trim())) throw new Error('Cannot resolve source revision');
  const repository = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' });
  const branch = spawnSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' });
  if (repository.status !== 0 || branch.status !== 0 || !branch.stdout.trim()) throw new Error('Run provisioning from the intended source branch with an origin remote');
  await api(`/api/v2/workspaces/${workspaceId}/projects`, {
    id: 'smith', name: 'Smith', repoUrl: repository.stdout.trim(), branch: branch.stdout.trim(), commit: revision.stdout.trim(),
    products: [{ name: 'build', description: 'Build the experimental Smith console application from its pinned Git revision.', labels: ['una-engine'], timeoutSeconds: 1800,
      commands: { windows: { interpreter: 'ps1', script: 'Build.ps1', args: ['-Project', 'Smith', '-Config', 'Release'] }, linux: { interpreter: 'sh', script: 'Build.sh', args: ['Smith'] }, mac: { interpreter: 'sh', script: 'Build.sh', args: ['Smith'] } } },
      { name: 'self-release', description: 'Build and test the coordinator and Windows agent. Publish a candidate for explicit promotion; do not activate it.', labels: ['una-engine', 'node', 'npm'], timeoutSeconds: 7200,
        commands: { windows: { interpreter: 'ps1', script: 'tools/self-release/build.ps1', args: ['-Branch', branch.stdout.trim(), '-CoordinatorUrl', config.vars.ORIGIN] } },
        artifacts: {globs: ['Build/SelfRelease/smith-release.zip'], package: 'none'} }],
  });
  await sql('INSERT INTO invites (token_hash, user_id, expires_at) VALUES (?, ?, ?)', [digest(code), userId, Date.now() + 3600000]);
  await writeFile(statePath, JSON.stringify({ userId, workspaceId, origin: config.vars.ORIGIN, sessionToken: session, sessionExpiresAt: Date.now() + 86400000 }, null, 2), { mode: 0o600 });
  await writeFile(path.join(directory, 'invitation.txt'), code, { mode: 0o600 });
  console.log(JSON.stringify({ workspaceId, origin: config.vars.ORIGIN, invitationFile: path.join(directory, 'invitation.txt'), invitationExpiresInMinutes: 60, sourceCommit: revision.stdout.trim() }, null, 2));
} catch (error) {
  await sql('DELETE FROM sessions WHERE token_hash = ?', [digest(session)]);
  throw error;
}
