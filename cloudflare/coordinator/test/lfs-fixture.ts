// Shared by the LFS tests: a workspace with one project, a token minter and a machine enroller.
import { env } from 'cloudflare:workers';
import { expect } from 'vitest';
import { hash } from '../src/http';

export const origin = 'https://exp.redmarmosetstudios.com';
const commit = 'd45d5d166ff384710a2f63cfa24271395b689c41';
export const project = { id: 'senet', name: 'Senet', repoUrl: 'git@github.com:Red-Marmoset/senet.git', branch: 'master', commit,
  products: [{ name: 'build', description: '', labels: [], timeoutSeconds: 1800, commands: { windows: { interpreter: 'ps1', script: 'Build.ps1', args: [] }, linux: { interpreter: 'sh', script: 'Build.sh', args: [] } } }] };
export const oidA = 'a'.repeat(64), oidB = 'b'.repeat(64);

export async function setup() {
  const id = await hash(crypto.randomUUID()); const userId = crypto.randomUUID();
  const stub = env.WORKSPACES.getByName(id);
  await stub.initialize(id, userId);
  const human = { kind: 'human' as const, userId };
  const workspaceId = (await (await stub.execute(human, 'summary', {})).json() as { id: string }).id;
  await env.DB.prepare('INSERT OR IGNORE INTO workspaces VALUES (?, ?)').bind(workspaceId, Date.now()).run();
  expect((await stub.execute(human, 'put-project', project)).status).toBe(201);
  async function pat(scopes = ['read', 'build']) {
    const response = await stub.execute(human, 'token-create', { name: 'laptop', scopes, expiresInDays: null });
    expect(response.status).toBe(201);
    return (await response.json() as { token: string }).token;
  }
  async function node(labels = ['git-lfs']) {
    const { code } = await (await stub.execute(human, 'enrollments', {})).json() as { code: string };
    const response = await stub.execute({ kind: 'enrollment' }, 'enroll', { code, protocolVersion: 2, os: 'linux', hostname: 'box', arch: 'x64', labels, agentVersion: 'hosted-abcdef123456' });
    expect(response.status).toBe(201);
    const { token, nodeId } = await response.json() as { token: string; nodeId: string };
    return { kind: 'node' as const, token, id: nodeId };
  }
  return { stub, human, workspaceId, pat, node };
}
export type Fixture = Awaited<ReturnType<typeof setup>>;
