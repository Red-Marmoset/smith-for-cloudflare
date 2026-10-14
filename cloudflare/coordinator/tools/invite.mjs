// Creates a one-use, one-hour invitation code for signing in to the hosted Smith dashboard.
// It uses Wrangler's own Cloudflare login (the same one DeployWorker.bat uses), so no API token or
// state folder is needed. The code is printed once; only its SHA-256 is stored.
//
//   node tools/invite.mjs            invite the existing user (asks which one if there are several)
//   node tools/invite.mjs --new      invite a brand-new user (who then creates their own workspace)
//   node tools/invite.mjs --local    use `wrangler dev`'s local database instead (testing)
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const wrangler = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const config = JSON.parse((await readFile(path.join(root, 'wrangler.jsonc'), 'utf8')).replace(/^\s*\/\/.*$/gm, ''));
const database = config.d1_databases[0].database_name;
const local = process.argv.includes('--local');
const fresh = process.argv.includes('--new');

function run(args, capture) {
  const result = spawnSync(process.execPath, [wrangler, ...args], { cwd: root, encoding: 'utf8', stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit' });
  if (result.error) throw result.error;
  return result;
}
function sql(command) {
  const result = run(['d1', 'execute', database, local ? '--local' : '--remote', '--json', '--command', command], true);
  if (result.status !== 0) throw new Error(`Database query failed:\n${(result.stderr || result.stdout).trim()}`);
  const parsed = JSON.parse(result.stdout);
  return (Array.isArray(parsed) ? parsed : [parsed]).flatMap(part => part.results ?? []);
}

if (!local) {
  const whoami = run(['whoami'], true);
  if (whoami.status !== 0 || /not authenticated/i.test(whoami.stdout + whoami.stderr)) {
    console.log('Logging in to Cloudflare in your browser...');
    if (run(['login'], false).status !== 0) throw new Error('Cloudflare login failed');
  }
}

let userId;
if (fresh) {
  userId = `user-${randomUUID()}`;
  sql(`INSERT INTO users (id, created_at) VALUES ('${userId}', ${Date.now()})`);
} else {
  const users = sql(`SELECT u.id, u.created_at AS createdAt, (SELECT COUNT(*) FROM workspace_directory w WHERE w.user_id = u.id) AS workspaces
    FROM users u ORDER BY workspaces DESC, u.created_at`);
  if (!users.length) throw new Error('There are no users yet; run with --new to create the first one');
  // Every value embedded in SQL below is checked first; Wrangler's --command takes no parameters.
  const valid = users.filter(u => typeof u.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(u.id));
  if (valid.length === 1) userId = valid[0].id;
  else {
    console.log('Smith users:');
    valid.forEach((u, i) => console.log(`  ${i + 1}. ${u.id}  (created ${new Date(u.createdAt).toISOString().slice(0, 10)}, ${u.workspaces} workspace${u.workspaces === 1 ? '' : 's'})`));
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = Number((await rl.question('Invite which user? Number (the one with your workspace is usually 1): ')).trim());
    rl.close();
    if (!Number.isInteger(answer) || answer < 1 || answer > valid.length) throw new Error('No user chosen');
    userId = valid[answer - 1].id;
  }
}

const code = randomBytes(32).toString('base64url');
const hash = createHash('sha256').update(code).digest('hex');
const expiresAt = Date.now() + 3600000;
sql(`INSERT INTO invites (token_hash, user_id, expires_at) VALUES ('${hash}', '${userId}', ${expiresAt})`);
console.log('');
console.log(`Invitation code (works once, for the next hour) for ${userId}:`);
console.log('');
console.log(`  ${code}`);
console.log('');
console.log(`Open ${local ? 'your local wrangler dev page' : config.vars.ORIGIN}, paste it into "Invitation code" and sign in.`);
console.log('Your browser then stays signed in for seven days.');
