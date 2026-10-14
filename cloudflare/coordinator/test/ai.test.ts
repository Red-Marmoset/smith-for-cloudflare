import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { validateAiInventory } from '../src/ai';

const inventory = {
  tools: [{ id: 'claude-code', version: '3.1.0' }, { id: 'codex', version: '0.90.0' }],
  ollama: { up: true, models: [{ name: 'qwen3.5:9b', sizeBytes: 6_000_000_000, remote: false }, { name: 'kimi-k2.6:cloud', sizeBytes: 0, remote: true }] },
};
type Machine = { nodeId: string; hostname: string; ownedByYou: boolean; online: boolean; options: { tool: string; brain: string; model: string | null }[] };
type NodeView = { id: string; ownedByYou: boolean; purpose: string; shareLocalModels: boolean; ai: typeof inventory | null };

async function setup() {
  const id = crypto.randomUUID(); const ownerId = crypto.randomUUID();
  const stub = env.WORKSPACES.getByName(id);
  await stub.initialize(id, ownerId);
  const owner = { kind: 'human' as const, userId: ownerId };
  async function member(role: string) {
    const userId = crypto.randomUUID();
    await runInDurableObject(stub, (_object, state) => { state.storage.sql.exec('INSERT INTO members (user_id, role) VALUES (?, ?)', userId, role); });
    return { kind: 'human' as const, userId };
  }
  async function connect(who: { kind: 'human'; userId: string }, purpose: 'build' | 'personal', ai: unknown = inventory, hostname = 'pc') {
    const created = await stub.execute(who, 'enrollments', { purpose });
    expect(created.status).toBe(201);
    const { code } = await created.json() as { code: string };
    const response = await stub.execute({ kind: 'enrollment' }, 'enroll', { code, protocolVersion: 2, os: 'windows', hostname, labels: [], ai });
    expect(response.status).toBe(201);
    const { token, nodeId } = await response.json() as { token: string; nodeId: string };
    return { principal: { kind: 'node' as const, token }, nodeId };
  }
  const machines = async (who: { kind: 'human'; userId: string }) => (await (await stub.execute(who, 'ai-options', {})).json() as { machines: Machine[] }).machines;
  const nodes = async (who: { kind: 'human'; userId: string }) => (await (await stub.execute(who, 'nodes', {})).json() as { nodes: NodeView[] }).nodes;
  return { stub, owner, member, connect, machines, nodes };
}

describe('per-person AI machines', () => {
  it('offers your own CLIs and all your models, and nothing of anyone else by default', async () => {
    const f = await setup(); const alice = await f.member('operator');
    const mine = await f.connect(f.owner, 'build', inventory, 'owner-pc');
    await f.connect(alice, 'personal', inventory, 'alice-pc');
    const ownerView = await f.machines(f.owner);
    expect(ownerView.map(m => m.hostname)).toEqual(['owner-pc']);
    expect(ownerView[0]).toMatchObject({ nodeId: mine.nodeId, ownedByYou: true, online: true });
    expect(ownerView[0].options).toContainEqual({ tool: 'claude-code', brain: 'own-login', model: null });
    expect(ownerView[0].options).toContainEqual({ tool: 'codex', brain: 'ollama', model: 'kimi-k2.6:cloud' });
    expect((await f.machines(alice)).map(m => m.hostname)).toEqual(['alice-pc']);
  });

  it('names the Claude models your login can run once the agent supports choosing one', async () => {
    const f = await setup();
    await f.connect(f.owner, 'personal', { ...inventory, features: ['login-models'] }, 'new-pc');
    const [machine] = await f.machines(f.owner);
    const login = machine.options.filter(o => o.brain === 'own-login');
    expect(login).toEqual([
      { tool: 'claude-code', brain: 'own-login', model: 'claude-fable-5-1', label: 'Fable 5.1' },
      { tool: 'claude-code', brain: 'own-login', model: 'claude-opus-5-5', label: 'Opus 5.5' },
      { tool: 'claude-code', brain: 'own-login', model: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
      { tool: 'claude-code', brain: 'own-login', model: 'claude-haiku-5-5', label: 'Haiku 5.5' },
      { tool: 'claude-code', brain: 'own-login', model: null },
      { tool: 'codex', brain: 'own-login', model: null },
    ]);
  });

  it('shares only local models, never the owner login or cloud models, and only when the owner opts in', async () => {
    const f = await setup(); const alice = await f.member('viewer');
    const mine = await f.connect(f.owner, 'build');
    expect((await f.stub.execute(alice, 'ai-share', { nodeId: mine.nodeId, share: true })).status).toBe(404);
    expect((await f.nodes(alice))[0].ai).toBeNull();
    expect((await f.stub.execute(f.owner, 'ai-share', { nodeId: mine.nodeId, share: true })).status).toBe(200);
    const shared = await f.machines(alice);
    expect(shared).toHaveLength(1);
    expect(shared[0].ownedByYou).toBe(false);
    expect(shared[0].options).toEqual([
      { tool: 'claude-code', brain: 'ollama', model: 'qwen3.5:9b' },
      { tool: 'codex', brain: 'ollama', model: 'qwen3.5:9b' },
    ]);
    expect((await f.nodes(alice))[0].ai?.ollama.models.map(m => m.name)).toEqual(['qwen3.5:9b']);
    expect((await f.nodes(f.owner))[0].ai?.ollama.models).toHaveLength(2);
  });

  it('lets admins not share or claim a member’s machine', async () => {
    const f = await setup(); const alice = await f.member('operator');
    const hers = await f.connect(alice, 'personal');
    expect((await f.stub.execute(f.owner, 'ai-share', { nodeId: hers.nodeId, share: true })).status).toBe(404);
    expect((await f.machines(f.owner))).toEqual([]);
  });

  it('offers nothing on an offline machine', async () => {
    const f = await setup(); const mine = await f.connect(f.owner, 'personal');
    await runInDurableObject(f.stub, (_object, state) => { state.storage.sql.exec('UPDATE nodes SET last_seen_at = 0 WHERE id = ?', mine.nodeId); });
    expect(await f.machines(f.owner)).toMatchObject([{ online: false, options: [] }]);
  });
});

describe('personal machines', () => {
  it('can be connected by any member but never run workspace builds', async () => {
    const f = await setup(); const viewer = await f.member('viewer');
    expect((await f.stub.execute(viewer, 'enrollments', {})).status).toBe(403);
    expect((await f.stub.execute(viewer, 'enrollments', { purpose: 'build' })).status).toBe(403);
    expect((await f.stub.execute(viewer, 'enrollments', { purpose: 'robot' })).status).toBe(400);
    const personal = await f.connect(viewer, 'personal');
    await f.stub.execute(f.owner, 'enqueue', { requestId: 'smoke-1', projectId: 'smoke' });
    expect(await (await f.stub.execute(personal.principal, 'claim', {})).json()).toEqual({ hasJob: false });
    const build = await f.connect(f.owner, 'build');
    expect(await (await f.stub.execute(build.principal, 'claim', {})).json()).toMatchObject({ hasJob: true });
    expect((await f.nodes(viewer)).find(n => n.id === personal.nodeId)).toMatchObject({ ownedByYou: true, purpose: 'personal' });
  });

  it('is limited to five per person, counting unused codes', async () => {
    const f = await setup(); const alice = await f.member('viewer');
    for (let i = 0; i < 5; i++) expect((await f.stub.execute(alice, 'enrollments', { purpose: 'personal' })).status).toBe(201);
    expect((await f.stub.execute(alice, 'enrollments', { purpose: 'personal' })).status).toBe(429);
  });

  it('can be revoked by its owner, but members cannot revoke each other', async () => {
    const f = await setup(); const alice = await f.member('viewer'); const bob = await f.member('viewer');
    const hers = await f.connect(alice, 'personal');
    expect((await f.stub.execute(bob, 'revoke', { nodeId: hers.nodeId })).status).toBe(403);
    expect((await f.stub.execute(alice, 'revoke', { nodeId: hers.nodeId })).status).toBe(200);
    expect((await f.stub.execute(hers.principal, 'heartbeat', {})).status).toBe(401);
    // A removed machine leaves the list.
    expect(await f.nodes(alice)).toEqual([]);
  });
});

describe('AI inventory reports', () => {
  it('updates from heartbeats and rejects malformed reports', async () => {
    const f = await setup(); const mine = await f.connect(f.owner, 'personal', { tools: [], ollama: { up: false, models: [] } });
    expect(await f.machines(f.owner)).toMatchObject([{ options: [] }]);
    expect((await f.stub.execute(mine.principal, 'heartbeat', { ai: inventory })).status).toBe(200);
    expect((await f.machines(f.owner))[0].options).toHaveLength(6);
    for (const bad of [
      { tools: [{ id: 'gemini', version: '1' }], ollama: { up: false, models: [] } },
      { tools: [{ id: 'codex', version: '1' }, { id: 'codex', version: '2' }], ollama: { up: false, models: [] } },
      { tools: [], ollama: { up: true, models: [{ name: '../etc', sizeBytes: 1, remote: false }] } },
      { tools: [], ollama: { up: true, models: [{ name: 'x', sizeBytes: 1, remote: false, token: 'leak' }] } },
      { tools: [], extra: true },
    ]) expect((await f.stub.execute(mine.principal, 'heartbeat', { ai: bad })).status).toBe(400);
    expect((await f.machines(f.owner))[0].options).toHaveLength(6);
  });

  it('reports agent features and Codex’s Windows sandbox state to the machine’s owner only', async () => {
    const f = await setup(); const alice = await f.member('operator'); const hers = await f.connect(alice, 'personal');
    await f.stub.execute(alice, 'ai-share', { nodeId: hers.nodeId, share: true });
    expect((await f.stub.execute(hers.principal, 'heartbeat', { ai: { ...inventory, features: ['ask', 'push', 'from-the-future'], codexSandbox: 'not-set-up' } })).status).toBe(200);
    expect((await f.machines(alice))[0]).toMatchObject({ features: ['ask', 'push'], os: 'windows', codexSandbox: 'not-set-up' });
    const seen = (await f.machines(f.owner)).find(m => m.nodeId === hers.nodeId) as Machine & { codexSandbox?: string };
    expect(seen.codexSandbox).toBeUndefined();
    for (const bad of [{ ...inventory, codexSandbox: 'maybe' }, { ...inventory, features: 'ask' }, { ...inventory, features: ['x'.repeat(40)] }])
      expect((await f.stub.execute(hers.principal, 'heartbeat', { ai: bad })).status).toBe(400);
  });

  it('reports each CLI’s login, API key and what the agent can install to the owner only', async () => {
    const f = await setup(); const alice = await f.member('operator');
    const ai = { tools: [{ id: 'codex', version: 'codex-cli 0.160.1', signedIn: false, apiKey: true }], installable: ['claude-code', 'claude-code'], ollama: { up: true, models: inventory.ollama.models }, features: ['setup', 'api-key-choice'] };
    const mine = await f.connect(f.owner, 'personal', ai);
    await f.stub.execute(f.owner, 'ai-share', { nodeId: mine.nodeId, share: true });
    const own = (await f.machines(f.owner))[0] as Machine & { tools: unknown; installable: unknown; features: string[] };
    expect(own).toMatchObject({ tools: [{ id: 'codex', version: 'codex-cli 0.160.1', signedIn: false, apiKey: true }], installable: ['claude-code'], features: ['setup', 'api-key-choice'] });
    // The own-login option stays: the composer decides how to show a signed-out CLI.
    expect(own.options).toContainEqual({ tool: 'codex', brain: 'own-login', model: null });
    const shared = (await f.machines(alice))[0] as Machine & { tools?: unknown; installable?: unknown };
    expect(shared.tools).toBeUndefined(); expect(shared.installable).toBeUndefined();
    expect((await f.nodes(alice))[0].ai?.tools).toEqual([{ id: 'codex', version: 'codex-cli 0.160.1' }]);
    for (const bad of [
      { ...ai, tools: [{ id: 'codex', version: '1', signedIn: 'yes' }] },
      { ...ai, tools: [{ id: 'codex', version: '1', apiKey: 1 }] },
      { ...ai, tools: [{ id: 'codex', version: '1', apiKeyValue: 'sk-leak' }] },
      { ...ai, installable: ['gemini'] },
      { ...ai, installable: 'codex' },
    ]) expect((await f.stub.execute(mine.principal, 'heartbeat', { ai: bad })).status).toBe(400);
    // An older agent's report (without these fields) leaves nothing installable.
    await f.stub.execute(mine.principal, 'heartbeat', { ai: inventory });
    expect((await f.machines(f.owner))[0]).toMatchObject({ installable: [] });
  });

  it('drops models when Ollama is not answering', async () => {
    const f = await setup();
    await f.connect(f.owner, 'personal', { tools: [{ id: 'codex', version: '1' }], ollama: { up: false, models: inventory.ollama.models } });
    expect((await f.machines(f.owner))[0].options).toEqual([{ tool: 'codex', brain: 'own-login', model: null }]);
  });
});

describe('AI features', () => {
  it('accepts the crew feature, which only agents that understand crew turns report', () => {
    expect(validateAiInventory({ tools: [], ollama: { up: false, models: [] }, features: ['crew'] }).features).toEqual(['crew']);
  });
});
