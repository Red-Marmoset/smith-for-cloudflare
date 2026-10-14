import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

const project = {
  id: 'smith', name: 'Smith', repoUrl: 'https://github.com/Red-Marmoset/smith.git', branch: 'main', commit: 'd45d5d166ff384710a2f63cfa24271395b689c41',
  products: [{ name: 'build', description: 'Build Smith', labels: [], timeoutSeconds: 1800, commands: { windows: { interpreter: 'ps1', script: 'Build.ps1', args: [] } } }],
};
const FEATURES = ['ask', 'push', 'ollama', 'codex-ask', 'setup', 'api-key-choice'];
const inventory = {
  tools: [{ id: 'claude-code', version: '2.1.4', signedIn: true, apiKey: true }],
  installable: ['codex'], ollama: { up: true, models: [{ name: 'qwen3.5:9b', sizeBytes: 1, remote: false }] }, features: FEATURES,
};
type Human = { kind: 'human'; userId: string };
type Node = { kind: 'node'; token: string };
type Task = { id: string; nodeId: string; tool: string; action: string; state: string; output: string; message: string; stopRequested: boolean; createdAt: number; finishedAt: number | null };
type MachineView = { nodeId: string; setup?: { id: string; tool: string; action: string; state: string }; tools?: unknown; installable?: unknown };
type Claim = { turn: { turnId: string; useApiKey: boolean } | null; setup: { setupId: string; leaseToken: string; tool: string; action: string } | null };

async function setup() {
  const id = crypto.randomUUID(); const owner: Human = { kind: 'human', userId: crypto.randomUUID() };
  const stub = env.WORKSPACES.getByName(id);
  await stub.initialize(id, owner.userId);
  expect((await stub.execute(owner, 'put-project', project)).status).toBe(201);
  async function member(role = 'operator'): Promise<Human> {
    const userId = crypto.randomUUID();
    await runInDurableObject(stub, (_o, state) => { state.storage.sql.exec('INSERT INTO members (user_id, role) VALUES (?, ?)', userId, role); });
    return { kind: 'human', userId };
  }
  async function computer(who: Human, ai: unknown = inventory) {
    const { code } = await (await stub.execute(who, 'enrollments', { purpose: 'personal' })).json() as { code: string };
    const response = await stub.execute({ kind: 'enrollment' }, 'enroll', { code, protocolVersion: 2, os: 'windows', hostname: 'pc', labels: [], ai });
    const { token, nodeId } = await response.json() as { token: string; nodeId: string };
    return { node: { kind: 'node' as const, token }, nodeId };
  }
  const create = (who: Human, nodeId: string, tool = 'codex', action = 'install') => stub.execute(who, 'ai-setup-create', { nodeId, tool, action });
  const get = async (who: Human, setupId: string) => (await (await stub.execute(who, 'ai-setup-get', { setupId })).json() as { task: Task }).task;
  const claim = async (node: Node) => await (await stub.execute(node, 'ai-claim', {})).json() as Claim;
  const machines = async (who: Human) => (await (await stub.execute(who, 'ai-options', {})).json() as { machines: MachineView[] }).machines;
  const sql = (query: string, ...args: unknown[]) => runInDurableObject(stub, (_o, state) => { state.storage.sql.exec(query, ...args); });
  return { stub, owner, member, computer, create, get, claim, machines, sql };
}

describe('AI tool setup tasks', () => {
  it('installs from the page: queued, claimed with the chat claim, streamed, fed input, stopped and finished', async () => {
    const f = await setup(); const pc = await f.computer(f.owner);
    const created = await f.create(f.owner, pc.nodeId);
    expect(created.status).toBe(201);
    const { task } = await created.json() as { task: Task };
    expect(task).toMatchObject({ nodeId: pc.nodeId, tool: 'codex', action: 'install', state: 'queued', output: '', finishedAt: null });
    expect((await f.machines(f.owner))[0].setup).toEqual({ id: task.id, tool: 'codex', action: 'install', state: 'queued' });
    // A second task on the same machine waits until this one is over.
    expect((await f.create(f.owner, pc.nodeId, 'claude-code')).status).toBe(409);

    const claimed = await f.claim(pc.node);
    expect(claimed).toMatchObject({ turn: null, setup: { setupId: task.id, tool: 'codex', action: 'install' } });
    const { leaseToken } = claimed.setup!;
    expect((await f.claim(pc.node)).setup).toBeNull(); // one running task per machine
    expect(await f.get(f.owner, task.id)).toMatchObject({ state: 'running' });

    const report = (body: Record<string, unknown>) => f.stub.execute(pc.node, 'ai-setup-events', { setupId: task.id, leaseToken, ...body });
    expect(await (await report({ lines: ['Open https://auth.openai.com/codex/device', 'Code: ABCD-12345'] })).json()).toEqual({ stop: false, input: [] });
    expect((await f.stub.execute(f.owner, 'ai-setup-input', { setupId: task.id, text: 'pasted-code' })).status).toBe(200);
    expect((await f.stub.execute(f.owner, 'ai-setup-input', { setupId: task.id, text: 'two\nlines' })).status).toBe(400);
    expect((await f.stub.execute(f.owner, 'ai-setup-input', { setupId: task.id, text: 'x'.repeat(2049) })).status).toBe(400);
    expect(await (await report({ lines: [] })).json()).toEqual({ stop: false, input: ['pasted-code'] });
    expect(await (await report({})).json()).toEqual({ stop: false, input: [] }); // input is drained once delivered
    expect((await f.stub.execute(f.owner, 'ai-setup-stop', { setupId: task.id })).status).toBe(200);
    expect(await (await report({ lines: ['stopping'] })).json()).toEqual({ stop: true, input: [] });
    expect((await f.stub.execute(pc.node, 'ai-setup-events', { setupId: task.id, leaseToken: 'wrong', lines: [] })).status).toBe(409);
    expect((await report({ lines: ['x'.repeat(4001)] })).status).toBe(400);
    expect((await report({ finish: { status: 'stopped', message: 'Stopped by you.' } })).status).toBe(200);
    expect((await report({ lines: ['late'] })).status).toBe(409);
    expect(await f.get(f.owner, task.id)).toMatchObject({ state: 'stopped', message: 'Stopped by you.', output: 'Open https://auth.openai.com/codex/device\nCode: ABCD-12345\nstopping\n' });
    expect((await f.stub.execute(f.owner, 'ai-setup-input', { setupId: task.id, text: 'late' })).status).toBe(409);
    // The finished task is still shown for a while, and the machine is free for the next one.
    expect((await f.machines(f.owner))[0].setup).toMatchObject({ id: task.id, state: 'stopped' });
    expect((await f.create(f.owner, pc.nodeId, 'claude-code', 'sign-in')).status).toBe(201);
  });

  it('is for the machine’s owner only, on an up-to-date online agent', async () => {
    const f = await setup(); const alice = await f.member(); const pc = await f.computer(f.owner);
    await f.stub.execute(f.owner, 'ai-share', { nodeId: pc.nodeId, share: true });
    expect((await f.create(alice, pc.nodeId)).status).toBe(404);
    const { task } = await (await f.create(f.owner, pc.nodeId)).json() as { task: Task };
    for (const action of ['ai-setup-get', 'ai-setup-stop']) expect((await f.stub.execute(alice, action, { setupId: task.id })).status).toBe(404);
    expect((await f.stub.execute(alice, 'ai-setup-input', { setupId: task.id, text: 'x' })).status).toBe(404);
    const shared = (await f.machines(alice))[0] as Record<string, unknown>;
    expect(shared.tools).toBeUndefined(); expect(shared.installable).toBeUndefined(); expect(shared.setup).toBeUndefined();
    // Another member's agent cannot report on it either.
    const hers = await f.computer(alice);
    const claimed = await f.claim(pc.node);
    expect((await f.stub.execute(hers.node, 'ai-setup-events', { setupId: task.id, leaseToken: claimed.setup!.leaseToken, lines: [] })).status).toBe(404);

    const old = await f.computer(f.owner, { ...inventory, features: ['ask'] });
    expect(await (await f.create(f.owner, old.nodeId)).json()).toMatchObject({ error: { code: 'agent_update_needed' } });
    expect((await f.create(f.owner, old.nodeId, 'gemini')).status).toBe(400);
    expect((await f.create(f.owner, old.nodeId, 'codex', 'uninstall')).status).toBe(400);
    const fresh = await f.computer(f.owner);
    expect(await (await f.create(f.owner, fresh.nodeId, 'codex', 'sign-in')).json()).toMatchObject({ error: { code: 'not_installed' } });
    await f.sql('UPDATE nodes SET last_seen_at = 0 WHERE id = ?', fresh.nodeId);
    expect(await (await f.create(f.owner, fresh.nodeId)).json()).toMatchObject({ error: { code: 'machine_offline' } });
  });

  it('fails a task whose agent stopped responding, and stops a queued one at once', async () => {
    const f = await setup(); const pc = await f.computer(f.owner);
    const { task } = await (await f.create(f.owner, pc.nodeId)).json() as { task: Task };
    const claimed = (await f.claim(pc.node)).setup;
    await f.sql('UPDATE ai_setup_tasks SET lease_expires_at = 1 WHERE id = ?', task.id);
    expect(await f.get(f.owner, task.id)).toMatchObject({ state: 'failed', message: 'The agent stopped responding.' });
    expect((await f.stub.execute(pc.node, 'ai-setup-events', { setupId: task.id, leaseToken: claimed!.leaseToken, lines: [] })).status).toBe(409);
    const next = await (await f.create(f.owner, pc.nodeId, 'claude-code', 'sign-in')).json() as { task: Task };
    expect(await (await f.stub.execute(f.owner, 'ai-setup-stop', { setupId: next.task.id })).json()).toMatchObject({ task: { state: 'stopped' } });
    expect((await f.claim(pc.node)).setup).toBeNull();
  });

  it('keeps only the end of a long output, cut at a line', async () => {
    const f = await setup(); const pc = await f.computer(f.owner);
    const { task } = await (await f.create(f.owner, pc.nodeId)).json() as { task: Task };
    const claimed = (await f.claim(pc.node)).setup;
    for (let i = 0; i < 20; i++) expect((await f.stub.execute(pc.node, 'ai-setup-events', { setupId: task.id, leaseToken: claimed!.leaseToken, lines: Array.from({ length: 64 }, (_, n) => `${i}-${n} ${'.'.repeat(90)}`) })).status).toBe(200);
    const { output } = await f.get(f.owner, task.id);
    expect(output.length).toBeLessThanOrEqual(64 * 1024);
    expect(output.split('\n')[0]).toMatch(/^\d+-\d+ \.+$/);
    expect(output.endsWith(`19-63 ${'.'.repeat(90)}\n`)).toBe(true);
  });

  it('hands out a chat turn and a setup task in the same claim, independently', async () => {
    const f = await setup(); const pc = await f.computer(f.owner);
    expect((await f.stub.execute(f.owner, 'ai-session-create', { requestId: crypto.randomUUID(), nodeId: pc.nodeId, projectId: 'smith', tool: 'claude-code', brain: 'own-login', prompt: 'hi' })).status).toBe(201);
    const { task } = await (await f.create(f.owner, pc.nodeId)).json() as { task: Task };
    const both = await f.claim(pc.node);
    expect(both.turn).not.toBeNull();
    expect(both.setup?.setupId).toBe(task.id);
    const again = await f.claim(pc.node);
    expect(again.turn?.turnId).toBe(both.turn!.turnId); // the turn replays its lease, the setup task does not
    expect(again.setup).toBeNull();
  });
});

describe('API-key choice', () => {
  it('is off by default, round-trips into the claimed turn, and is refused for Ollama and guests', async () => {
    const f = await setup(); const pc = await f.computer(f.owner);
    const start = (who: Human, extra: Record<string, unknown>) => f.stub.execute(who, 'ai-session-create', { requestId: crypto.randomUUID(), nodeId: pc.nodeId, projectId: 'smith', tool: 'claude-code', brain: 'own-login', prompt: 'hi', ...extra });
    const session = await (await start(f.owner, {})).json() as { id: string; turns: { useApiKey: boolean }[] };
    expect(session.turns[0].useApiKey).toBe(false);
    const first = await f.claim(pc.node);
    expect(first.turn?.useApiKey).toBe(false);
    await f.stub.execute(pc.node, 'ai-finish', { turnId: first.turn!.turnId, leaseToken: (first.turn as unknown as { leaseToken: string }).leaseToken, result: { status: 'completed', message: 'ok' } });
    expect((await f.stub.execute(f.owner, 'ai-session-message', { sessionId: session.id, requestId: 'k', text: 'again', useApiKey: 'yes' })).status).toBe(400);
    expect((await f.stub.execute(f.owner, 'ai-session-message', { sessionId: session.id, requestId: 'k', text: 'again', useApiKey: true })).status).toBe(201);
    expect((await f.claim(pc.node)).turn?.useApiKey).toBe(true);

    expect((await start(f.owner, { brain: 'ollama', model: 'qwen3.5:9b', useApiKey: true })).status).toBe(400);
    const alice = await f.member();
    await f.stub.execute(f.owner, 'ai-share', { nodeId: pc.nodeId, share: true });
    expect((await start(alice, { brain: 'ollama', model: 'qwen3.5:9b', useApiKey: true })).status).toBe(403);
  });
});

