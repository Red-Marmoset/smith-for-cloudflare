import { env } from 'cloudflare:workers';
import { describe, expect, it, beforeEach } from 'vitest';
import worker from '../src/index';
import { forgetReleaseManifests, parseManifest, updateOffer } from '../src/agent-update';

const origin = 'https://exp.redmarmosetstudios.com';
const NEW = 'hosted-bbbbbbbbbbbb', OLD = 'hosted-aaaaaaaaaaaa';
const manifest = { schemaVersion: 1, version: NEW, commit: 'b'.repeat(40), os: 'windows', arch: 'x64', sha256: 'c'.repeat(64), size: 10 };

async function enrolledNode(os = 'windows') {
  const workspaceId = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
  const userId = crypto.randomUUID();
  const stub = env.WORKSPACES.getByName(workspaceId);
  await stub.initialize(workspaceId, userId);
  const { code } = await (await stub.execute({ kind: 'human', userId }, 'enrollments', {})).json() as { code: string };
  const enrolled = await stub.execute({ kind: 'enrollment' }, 'enroll', { code, protocolVersion: 2, os, hostname: 'runner', arch: 'x64', labels: [], agentVersion: OLD });
  const { token } = await enrolled.json() as { token: string };
  return { workspaceId, token };
}
function call(workspaceId: string, token: string, path: string, body?: unknown) {
  return worker.fetch(new Request(`${origin}/api/v2/workspaces/${workspaceId}/${path}`, body === undefined
    ? { headers: { Authorization: `Bearer ${token}` } }
    : { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env);
}
const beat = (version: string, arch = 'x64') => ({ hostname: 'runner', os: 'windows', arch, labels: [], agentVersion: version });

describe('agent self-update', () => {
  beforeEach(async () => {
    await env.RELEASES.delete(['smith-experiment-windows.json', 'smith-experiment-windows.zip']);
    forgetReleaseManifests();
  });

  it('offers the published package to agents on another version, and only to them', async () => {
    const { workspaceId, token } = await enrolledNode();
    // Nothing published: a plain heartbeat reply, as before.
    expect(await (await call(workspaceId, token, 'heartbeat', beat(OLD))).json()).toEqual({ accepted: true, gitHost: false });
    await env.RELEASES.put('smith-experiment-windows.zip', 'PK-new');
    await env.RELEASES.put('smith-experiment-windows.json', JSON.stringify(manifest));
    forgetReleaseManifests();
    const offered = await call(workspaceId, token, 'heartbeat', beat(OLD));
    expect(offered.status).toBe(200);
    expect(await offered.json()).toMatchObject({ accepted: true, update: { version: NEW, sha256: manifest.sha256, size: 10 } });
    // Current, an unpackaged development agent, or a package for another architecture: no offer.
    expect(await (await call(workspaceId, token, 'heartbeat', beat(NEW))).json()).toEqual({ accepted: true, gitHost: false });
    expect(await (await call(workspaceId, token, 'heartbeat', beat('0.1.0-hosted-v2'))).json()).toEqual({ accepted: true, gitHost: false });
    expect(await (await call(workspaceId, token, 'heartbeat', beat(OLD, 'arm64'))).json()).toEqual({ accepted: true, gitHost: false });
  });

  it('serves the package for the node\'s own OS to its token and to nobody else', async () => {
    const { workspaceId, token } = await enrolledNode();
    expect((await call(workspaceId, token, 'agent-package')).status).toBe(404);
    await env.RELEASES.put('smith-experiment-windows.zip', 'PK-new');
    const response = await call(workspaceId, token, 'agent-package');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/zip');
    expect(await response.text()).toBe('PK-new');
    expect((await call(workspaceId, 'smn.not-a-node.token', 'agent-package')).status).toBe(401);
    // A Mac node gets the Mac zip, which is not published here.
    const mac = await enrolledNode('mac');
    expect((await call(mac.workspaceId, mac.token, 'agent-package')).status).toBe(404);
  });

  it('ignores malformed manifests', () => {
    expect(parseManifest(manifest)).toEqual({ version: NEW, sha256: manifest.sha256, size: 10, arch: 'x64' });
    expect(parseManifest({ ...manifest, version: 'latest' })).toBeNull();
    expect(parseManifest({ ...manifest, sha256: 'x' })).toBeNull();
    expect(parseManifest({ ...manifest, size: 0 })).toBeNull();
    expect(parseManifest(null)).toBeNull();
    expect(updateOffer(parseManifest({ ...manifest, arch: '' }), OLD, 'arm64')).toEqual({ version: NEW, sha256: manifest.sha256, size: 10 });
  });
});
