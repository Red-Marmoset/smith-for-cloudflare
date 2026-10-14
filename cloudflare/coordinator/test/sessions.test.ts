import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { fakeArtifacts } from '../src/artifacts-repos';
import { fakeGitHub } from '../src/github-reader';
import { Sessions, chatBranch, chatBriefing, BRIEFING_MAX_BYTES } from '../src/sessions';
import senet from './fixtures/smith-json/senet.json?raw';

const project = {
  id: 'smith', name: 'Smith', repoUrl: 'https://github.com/Red-Marmoset/smith.git', branch: 'feature/cloudflare-experiment', commit: 'd45d5d166ff384710a2f63cfa24271395b689c41',
  products: [{ name: 'build', description: 'Build Smith', labels: [], timeoutSeconds: 1800, commands: { windows: { interpreter: 'ps1', script: 'Build.ps1', args: [] } } }],
};
const FEATURES = ['ask', 'push', 'ollama', 'codex-ask', 'named-branches'];
const claudeOnly = { tools: [{ id: 'claude-code', version: '2.1.4' }], ollama: { up: true, models: [{ name: 'qwen3.5:9b', sizeBytes: 1, remote: false }] }, features: FEATURES };
type Human = { kind: 'human'; userId: string };
type Turn = { sessionId: string; turnId: string; seq: number; leaseToken: string; nextEventSeq: number; prompt: string; permissionMode: string; resume: string | null; repo: { url: string; commit: string; branch: string } };

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
  async function computer(who: Human, ai: unknown = claudeOnly) {
    const { code } = await (await stub.execute(who, 'enrollments', { purpose: 'personal' })).json() as { code: string };
    const response = await stub.execute({ kind: 'enrollment' }, 'enroll', { code, protocolVersion: 2, os: 'windows', hostname: 'pc', labels: [], ai });
    const { token, nodeId } = await response.json() as { token: string; nodeId: string };
    return { node: { kind: 'node' as const, token }, nodeId };
  }
  // A shared build machine (a personal one never claims jobs).
  async function builder(who: Human = owner, labels: string[] = []) {
    const { code } = await (await stub.execute(who, 'enrollments', {})).json() as { code: string };
    const response = await stub.execute({ kind: 'enrollment' }, 'enroll', { code, protocolVersion: 2, os: 'windows', hostname: 'builder', labels });
    return { node: { kind: 'node' as const, token: (await response.json() as { token: string }).token } };
  }
  const start = async (who: Human, nodeId: string, extra: Record<string, unknown> = {}) =>
    stub.execute(who, 'ai-session-create', { requestId: crypto.randomUUID(), nodeId, projectId: 'smith', tool: 'claude-code', brain: 'own-login', permissionMode: 'acceptEdits', prompt: 'Fix the "flaky" test & tidy up', ...extra });
  const claim = async (node: { kind: 'node'; token: string }) => (await (await stub.execute(node, 'ai-claim', {})).json() as { turn: Turn | null }).turn;
  // Runs a message turn to completion with a commit, so the chat has something to push.
  const reply = async (node: { kind: 'node'; token: string }, commit = 'c'.repeat(40)) => {
    const turn = (await claim(node))!;
    await stub.execute(node, 'ai-finish', { turnId: turn.turnId, leaseToken: turn.leaseToken, result: { status: 'completed', message: 'ok', commit } });
    return turn;
  };
  // The push turn Smith queues by itself after a reply that committed: claims it and reports the push done.
  const pushed = async (node: { kind: 'node'; token: string }, commit = 'c'.repeat(40)) => {
    const turn = (await claim(node))! as Turn & { kind: string };
    expect(turn.kind).toBe('push');
    await stub.execute(node, 'ai-finish', { turnId: turn.turnId, leaseToken: turn.leaseToken, result: { status: 'completed', message: 'Pushed', commit } });
    return turn;
  };
  return { stub, owner, member, computer, builder, start, claim, reply, pushed };
}

describe('AI chat sessions', () => {
  it('runs a message on your own machine, streams events back, and resumes the conversation', async () => {
    const f = await setup(); const pc = await f.computer(f.owner);
    const created = await f.start(f.owner, pc.nodeId);
    expect(created.status).toBe(201);
    const session = await created.json() as { id: string; working: boolean; branch: string; turns: { state: string }[] };
    expect(session).toMatchObject({ working: true, turns: [{ state: 'queued' }] });
    const turn = (await f.claim(pc.node))!;
    expect(turn).toMatchObject({ sessionId: session.id, seq: 1, nextEventSeq: 0, prompt: 'Fix the "flaky" test & tidy up', permissionMode: 'acceptEdits', resume: null,
      repo: { url: project.repoUrl, commit: project.commit, branch: session.branch } });
    expect(await f.claim(pc.node)).toEqual(turn); // a lost reply replays the same lease
    const init = { kind: 'claude', data: { type: 'system', subtype: 'init', session_id: 'b1d9a6c2-0000-4000-8000-000000000001', model: 'claude' } };
    const reply = { kind: 'claude', data: { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } } };
    const posted = await f.stub.execute(pc.node, 'ai-events', { turnId: turn.turnId, leaseToken: turn.leaseToken, seq: 0, events: [init, reply] });
    expect(await posted.json()).toMatchObject({ accepted: true, nextSeq: 2, stop: false });
    const events = await (await f.stub.execute(f.owner, 'ai-session-events', { sessionId: session.id })).json() as { events: { seq: number; kind: string }[]; nextSeq: number };
    expect(events.events.map(e => e.seq)).toEqual([0, 1]);
    expect((await f.stub.execute(f.owner, 'ai-session-events', { sessionId: session.id, after: 1 })).json()).resolves.toMatchObject({ events: [], nextSeq: 1 });
    const commit = 'a'.repeat(40);
    expect((await f.stub.execute(pc.node, 'ai-finish', { turnId: turn.turnId, leaseToken: turn.leaseToken, result: { status: 'completed', message: 'ok', commit } })).status).toBe(200);
    expect((await f.stub.execute(pc.node, 'ai-finish', { turnId: turn.turnId, leaseToken: turn.leaseToken, result: { status: 'completed', message: 'ok', commit } })).status).toBe(200);
    expect((await f.stub.execute(pc.node, 'ai-finish', { turnId: turn.turnId, leaseToken: turn.leaseToken, result: { status: 'failed', message: 'no', commit } })).status).toBe(409);
    // The reply committed, so Smith queues the chat's own push turn by itself; the next message waits for it.
    expect(await (await f.stub.execute(f.owner, 'ai-session', { sessionId: session.id })).json()).toMatchObject({ working: true, turns: [{ state: 'completed', result: { commit } }, { kind: 'push', state: 'queued', prompt: `Push branch ${session.branch}` }] });
    expect((await f.stub.execute(f.owner, 'ai-session-message', { sessionId: session.id, requestId: 'early', text: 'Now add a test' })).status).toBe(409);
    expect((await f.pushed(pc.node, commit)).sessionId).toBe(session.id);
    expect(await (await f.stub.execute(f.owner, 'ai-session', { sessionId: session.id })).json()).toMatchObject({ working: false });
    expect((await f.stub.execute(f.owner, 'ai-session-message', { sessionId: session.id, requestId: 'follow-up', text: 'Now add a test' })).status).toBe(201);
    expect((await f.stub.execute(f.owner, 'ai-session-message', { sessionId: session.id, requestId: 'follow-up', text: 'Now add a test' })).status).toBe(201);
    expect((await f.stub.execute(f.owner, 'ai-session-message', { sessionId: session.id, requestId: 'another', text: 'And another' })).status).toBe(409);
    const next = (await f.claim(pc.node))!;
    expect(next).toMatchObject({ seq: 3, nextEventSeq: 2, prompt: 'Now add a test', resume: 'b1d9a6c2-0000-4000-8000-000000000001' });
  });

  it('keeps sessions private to their owner, even from admins', async () => {
    const f = await setup(); const alice = await f.member(); const pc = await f.computer(alice);
    const session = await (await f.start(alice, pc.nodeId)).json() as { id: string };
    for (const action of ['ai-session', 'ai-session-events', 'ai-session-stop', 'ai-session-close', 'ai-session-update', 'ai-session-delete', 'ai-session-approve']) expect((await f.stub.execute(f.owner, action, { sessionId: session.id })).status).toBe(404);
    expect((await f.stub.execute(f.owner, 'ai-session-message', { sessionId: session.id, requestId: 'x', text: 'hi' })).status).toBe(404);
    expect(await (await f.stub.execute(f.owner, 'ai-sessions', {})).json()).toEqual({ sessions: [] });
    expect((await (await f.stub.execute(alice, 'ai-sessions', {})).json() as { sessions: unknown[] }).sessions).toHaveLength(1);
  });

  it('never runs your message on someone else’s machine or login', async () => {
    const f = await setup(); const alice = await f.member(); const hers = await f.computer(alice);
    expect((await f.start(f.owner, hers.nodeId)).status).toBe(403);
    expect((await f.stub.execute(alice, 'ai-share', { nodeId: hers.nodeId, share: true })).status).toBe(200);
    expect((await f.start(f.owner, hers.nodeId)).status).toBe(403); // sharing offers local models, never her login
    const mine = await f.computer(f.owner);
    await f.start(f.owner, mine.nodeId);
    expect(await f.claim(hers.node)).toBeNull();
    // A different machine cannot report on, or finish, this machine's turn.
    const turn = (await f.claim(mine.node))!;
    expect((await f.stub.execute(hers.node, 'ai-events', { turnId: turn.turnId, leaseToken: turn.leaseToken, seq: 0, events: [] })).status).toBe(409);
    expect((await f.stub.execute(hers.node, 'ai-finish', { turnId: turn.turnId, leaseToken: turn.leaseToken, result: { status: 'completed', message: '' } })).status).toBe(409);
  });

  it('runs Claude Code with the model you picked for your own login', async () => {
    const f = await setup(); const pc = await f.computer(f.owner, { ...claudeOnly, features: [...FEATURES, 'login-models'] });
    const created = await f.start(f.owner, pc.nodeId, { brain: 'own-login', model: 'claude-sonnet-5-5' });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ brain: 'own-login', model: 'claude-sonnet-5-5' });
    expect(await f.claim(pc.node)).toMatchObject({ brain: 'own-login', model: 'claude-sonnet-5-5' });
    expect((await f.start(f.owner, pc.nodeId, { brain: 'own-login', model: 'gpt-4o' })).status).toBe(403);
  });

  it('refuses tools, models and modes that are not available yet, and offline machines', async () => {
    const f = await setup(); const pc = await f.computer(f.owner, { tools: [{ id: 'claude-code', version: '1' }, { id: 'codex', version: '1' }], ollama: claudeOnly.ollama });
    expect((await f.start(f.owner, pc.nodeId, { tool: 'gemini' })).status).toBe(400);
    expect((await f.start(f.owner, pc.nodeId, { tool: 'codex' })).status).toBe(400); // acceptEdits is Claude Code's word, not Codex's
    expect((await f.start(f.owner, pc.nodeId, { permissionMode: 'read-only' })).status).toBe(400);
    expect((await f.start(f.owner, pc.nodeId, { brain: 'ollama' })).status).toBe(400);                 // which model?
    expect((await f.start(f.owner, pc.nodeId, { brain: 'own-login', model: 'qwen3.5:9b' })).status).toBe(403);
    expect((await f.start(f.owner, pc.nodeId, { brain: 'own-login', model: 'claude-opus-5-5' })).status).toBe(403); // this agent cannot pick a login model
    expect((await f.start(f.owner, pc.nodeId, { brain: 'ollama', model: 'not-pulled:1b' })).status).toBe(403);
    expect((await f.start(f.owner, pc.nodeId, { permissionMode: 'yolo' })).status).toBe(400);
    expect((await f.start(f.owner, pc.nodeId, { prompt: '   ' })).status).toBe(400);
    expect((await f.start(f.owner, pc.nodeId, { projectId: 'missing' })).status).toBe(400);
    await runInDurableObject(f.stub, (_o, state) => { state.storage.sql.exec('UPDATE nodes SET last_seen_at = 0'); });
    expect((await f.start(f.owner, pc.nodeId)).status).toBe(403);
  });

  it('runs Codex with its own sandbox modes and resumes its thread', async () => {
    const f = await setup(); const pc = await f.computer(f.owner, { tools: [{ id: 'claude-code', version: '1' }, { id: 'codex', version: '0.130.0' }], ollama: claudeOnly.ollama });
    const codexOnly = await f.computer(f.owner, { tools: [{ id: 'codex', version: '1' }], ollama: { up: false, models: [] } });
    expect((await f.start(f.owner, codexOnly.nodeId)).status).toBe(403); // that machine has no Claude Code
    const created = await f.start(f.owner, pc.nodeId, { tool: 'codex', permissionMode: undefined });
    expect(created.status).toBe(201);
    const session = await created.json() as { id: string; tool: string };
    expect(session.tool).toBe('codex');
    const turn = (await f.claim(pc.node))! as Turn & { tool: string };
    expect(turn).toMatchObject({ tool: 'codex', permissionMode: 'workspace-write', resume: null });
    const post = (seq: number, events: unknown[]) => f.stub.execute(pc.node, 'ai-events', { turnId: turn.turnId, leaseToken: turn.leaseToken, seq, events });
    expect((await post(0, [{ kind: 'claude', data: { type: 'system', subtype: 'init', session_id: 'x' } }])).status).toBe(400); // wrong CLI for this session
    const thread = '0199a213-81c0-7800-8aa1-bbab2a035a53';
    expect((await post(0, [{ kind: 'codex', data: { type: 'thread.started', thread_id: thread } }, { kind: 'codex', data: { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Renamed the zebra helper.' } } },
      { kind: 'codex', data: { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } } }])).status).toBe(200);
    expect((await f.stub.execute(pc.node, 'ai-finish', { turnId: turn.turnId, leaseToken: turn.leaseToken, result: { status: 'completed', message: 'ok' } })).status).toBe(200);
    // Claude Code's mode words are refused for Codex; Codex's own are accepted.
    expect((await f.stub.execute(f.owner, 'ai-session-message', { sessionId: session.id, requestId: 'a', text: 'more', permissionMode: 'acceptEdits' })).status).toBe(400);
    expect((await f.stub.execute(f.owner, 'ai-session-message', { sessionId: session.id, requestId: 'b', text: 'more', permissionMode: 'read-only' })).status).toBe(201);
    expect(await f.claim(pc.node)).toMatchObject({ tool: 'codex', permissionMode: 'read-only', resume: thread, prompt: 'more' });
    // Codex's replies are searchable like Claude Code's.
    const found = await (await f.stub.execute(f.owner, 'ai-sessions', { q: 'zebra' })).json() as { sessions: { id: string }[] };
    expect(found.sessions.map(s => s.id)).toEqual([session.id]);
  });

  it('asks you before Claude Code acts in ask mode, and remembers "always allow" for the chat', async () => {
    const f = await setup(); const pc = await f.computer(f.owner); const alice = await f.member();
    const session = await (await f.start(f.owner, pc.nodeId, { permissionMode: 'default' })).json() as { id: string };
    const turn = (await f.claim(pc.node))!;
    expect(turn.permissionMode).toBe('default');
    let seq = 0;
    const post = async (events: unknown[]) => { const r = await f.stub.execute(pc.node, 'ai-events', { turnId: turn.turnId, leaseToken: turn.leaseToken, seq, events }); if (r.ok) seq += events.length; return r; };
    const ask = (id: string, tool: string, input: unknown = {}) => ({ kind: 'approval', data: { id, tool, input } });
    const answer = (body: Record<string, unknown>, who = f.owner) => f.stub.execute(who, 'ai-session-approve', { sessionId: session.id, ...body });
    const detail = async () => await (await f.stub.execute(f.owner, 'ai-session', { sessionId: session.id })).json() as { allowedTools: string[]; approvals: { id: string; behavior: string | null; automatic: boolean; message: string | null }[] };
    expect(await (await post([ask('toolu_1', 'Bash', { command: 'npm test' })])).json()).toMatchObject({ answers: [] });
    expect((await detail()).approvals).toMatchObject([{ id: 'toolu_1', behavior: null }]);
    const listed = async () => ((await (await f.stub.execute(f.owner, 'ai-sessions', {})).json()) as { sessions: { waitingSince: number | null }[] }).sessions[0].waitingSince;
    expect(await listed()).toEqual(expect.any(Number)); // the chat list shows "Waiting for you"
    expect((await post([ask('../x', 'Bash')])).status).toBe(400);
    expect((await post([ask('toolu_x', 'Bash(rm -rf)')])).status).toBe(400); // a tool name, never a permission rule
    expect((await answer({ approvalId: 'toolu_1', behavior: 'allow' }, alice)).status).toBe(404); // only the chat's owner answers
    expect((await answer({ approvalId: 'toolu_1', behavior: 'maybe' })).status).toBe(400);
    expect((await answer({ approvalId: 'toolu_1', behavior: 'allow', always: true })).status).toBe(200);
    expect((await answer({ approvalId: 'toolu_1', behavior: 'allow' })).status).toBe(200); // a retried click
    expect((await answer({ approvalId: 'toolu_1', behavior: 'deny' })).status).toBe(409);
    expect(await (await post([])).json()).toMatchObject({ answers: [{ id: 'toolu_1', behavior: 'allow' }] });
    expect(await listed()).toBeNull();
    // Bash is now allowed for the rest of this chat; Write still asks, and a "no" can say why.
    await post([ask('toolu_2', 'Bash', { command: 'git status' }), ask('toolu_3', 'Write', { file_path: 'a.txt' })]);
    expect((await answer({ approvalId: 'toolu_3', behavior: 'deny', message: 'Put it in notes/ instead' })).status).toBe(200);
    const { answers } = await (await post([])).json() as { answers: { id: string; behavior: string; message?: string }[] };
    expect(answers).toEqual(expect.arrayContaining([{ id: 'toolu_2', behavior: 'allow' }, { id: 'toolu_3', behavior: 'deny', message: 'Put it in notes/ instead' }]));
    expect(await detail()).toMatchObject({ allowedTools: ['Bash'], approvals: [{ id: 'toolu_1' }, { id: 'toolu_2', automatic: true }, { id: 'toolu_3', behavior: 'deny' }] });
    // Once the reply ends nobody is waiting; the allow-list can be cleared from the chat's settings.
    await f.stub.execute(pc.node, 'ai-finish', { turnId: turn.turnId, leaseToken: turn.leaseToken, result: { status: 'completed', message: 'ok' } });
    await post([ask('toolu_4', 'Edit')]).catch(() => undefined);
    expect((await answer({ approvalId: 'toolu_3', behavior: 'deny' })).status).toBe(409);
    expect((await f.stub.execute(f.owner, 'ai-session-update', { sessionId: session.id, allowedTools: [] })).status).toBe(200);
    expect((await detail()).allowedTools).toEqual([]);
  });

  it('only accepts questions from Claude Code in ask mode', async () => {
    const f = await setup(); const pc = await f.computer(f.owner);
    await f.start(f.owner, pc.nodeId);
    const turn = (await f.claim(pc.node))!;
    expect((await f.stub.execute(pc.node, 'ai-events', { turnId: turn.turnId, leaseToken: turn.leaseToken, seq: 0, events: [{ kind: 'approval', data: { id: 'toolu_1', tool: 'Bash', input: {} } }] })).status).toBe(400);
  });

  it('pushes the chat’s own branch from its machine, and Verify builds the pushed commit', async () => {
    const f = await setup(); const pc = await f.computer(f.owner);
    const session = await (await f.start(f.owner, pc.nodeId)).json() as { id: string; branch: string };
    const push = (body: Record<string, unknown> = {}, who = f.owner) => f.stub.execute(who, 'ai-session-push', { sessionId: session.id, requestId: crypto.randomUUID(), ...body });
    expect((await push()).status).toBe(409);                                    // a reply is still queued
    const first = (await f.claim(pc.node))!;
    await f.stub.execute(pc.node, 'ai-finish', { turnId: first.turnId, leaseToken: first.leaseToken, result: { status: 'completed', message: 'ok' } });
    expect(await (await push()).json()).toMatchObject({ error: { code: 'nothing_to_push' } }); // no file changes yet
    await f.stub.execute(f.owner, 'ai-session-message', { sessionId: session.id, requestId: 'edit', text: 'Edit something' });
    await f.reply(pc.node);
    // Smith's own push of that reply goes first, from the chat's machine, with its own Git login.
    const automatic = await f.pushed(pc.node);
    expect(automatic).toMatchObject({ kind: 'push', repo: { url: project.repoUrl, branch: session.branch } });
    expect((automatic as Turn & { repo: { authToken?: string } }).repo.authToken).toBeUndefined();
    expect((await push({ product: 'missing' })).status).toBe(400);
    const pushed = await push({ product: 'build', requestId: 'push-1' });
    expect(pushed.status).toBe(201);
    expect(await pushed.json()).toMatchObject({ kind: 'push', product: 'build', prompt: `Push branch ${session.branch} and build build`, state: 'queued' });
    const turn = (await f.claim(pc.node))! as Turn & { kind: string; repo: { authToken?: string } };
    expect(turn).toMatchObject({ kind: 'push', repo: { url: project.repoUrl, branch: session.branch } });
    expect(turn.repo.authToken).toBeUndefined();                                // GitHub: the machine's own Git login
    const sha = 'd'.repeat(40);
    expect((await f.stub.execute(pc.node, 'ai-finish', { turnId: turn.turnId, leaseToken: turn.leaseToken, result: { status: 'completed', message: 'Pushed', commit: sha } })).status).toBe(200);
    // Verify queued a normal build of the project, pinned to the pushed commit on the chat's branch.
    const detail = await (await f.stub.execute(f.owner, 'ai-session', { sessionId: session.id })).json() as { turns: { kind: string; jobId: string | null }[] };
    const jobId = detail.turns.at(-1)!.jobId!;
    expect(jobId).toEqual(expect.any(String));
    const specs = await runInDurableObject(f.stub, (_o, state) => JSON.parse(state.storage.sql.exec<{ specs: string }>('SELECT specs FROM jobs WHERE id = ?', jobId).one().specs)) as Record<string, { repos: { commit: string; branch: string }[] }>;
    expect(specs.windows.repos[0]).toMatchObject({ commit: sha, branch: session.branch });
    // The branch is model-authored, so its Verify never gets the workspace's secrets: the credential names
    // arrive blank (an empty override hides the build machine's own variable), not absent.
    const TOKEN = 'cf_test_token_1234567890abcdefghij'; const ACCOUNT = 'c'.repeat(32);
    expect((await f.stub.execute(f.owner, 'put-settings', { cloudflareApiToken: TOKEN, cloudflareAccountId: ACCOUNT })).status).toBe(200);
    type Claimed = { hasJob: boolean; envelope: { lease: { jobId: string }; spec: { env: Record<string, string> } } };
    const verifyClaim = await (await f.stub.execute((await f.builder()).node, 'claim', {})).json() as Claimed;
    expect(verifyClaim.envelope.lease.jobId).toBe(jobId);
    expect(verifyClaim.envelope.spec.env).toMatchObject({ CLOUDFLARE_API_TOKEN: '', ANTHROPIC_API_KEY: '', CLOUDFLARE_ACCOUNT_ID: ACCOUNT });
    expect(JSON.stringify(verifyClaim)).not.toContain(TOKEN);
    expect(await (await f.stub.execute(f.owner, 'get', { jobId })).json()).toMatchObject({ id: jobId, secretless: true });
    // An ordinary build of the same project still carries the real token.
    const normal = await (await f.stub.execute(f.owner, 'enqueue', { requestId: 'normal-build', projectId: 'smith', product: 'build' })).json() as { id: string; secretless: boolean };
    expect(normal.secretless).toBe(false);
    const normalClaim = await (await f.stub.execute((await f.builder()).node, 'claim', {})).json() as Claimed;
    expect(normalClaim.envelope.lease.jobId).toBe(normal.id);
    expect(normalClaim.envelope.spec.env).toEqual({ CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT });
    const events = await (await f.stub.execute(f.owner, 'ai-session-events', { sessionId: session.id })).json() as { events: { kind: string; data: unknown }[] };
    expect(events.events.at(-1)).toMatchObject({ kind: 'status', data: expect.stringContaining('Verify: queued a build build') });
    // The next reply continues the transcript after Smith's note.
    await f.stub.execute(f.owner, 'ai-session-message', { sessionId: session.id, requestId: 'after', text: 'More' });
    expect((await f.claim(pc.node))!.nextEventSeq).toBe(events.events.length);
  });

  it('pushes each reply by itself, unless the owner keeps the chat on their computer', async () => {
    const f = await setup(); const pc = await f.computer(f.owner);
    const session = await (await f.start(f.owner, pc.nodeId)).json() as { id: string; branch: string; localOnly: boolean };
    expect(session.localOnly).toBe(false);
    const first = (await f.claim(pc.node))!;
    await f.stub.execute(pc.node, 'ai-finish', { turnId: first.turnId, leaseToken: first.leaseToken, result: { status: 'completed', message: 'ok' } });
    expect(await f.claim(pc.node)).toBeNull();                                                      // nothing changed: nothing to push
    await f.stub.execute(f.owner, 'ai-session-message', { sessionId: session.id, requestId: 'one', text: 'Change something' });
    await f.reply(pc.node, 'a'.repeat(40));
    expect(await f.pushed(pc.node, 'a'.repeat(40))).toMatchObject({ prompt: `Push branch ${session.branch}`, repo: { branch: session.branch } });
    // A reply that failed or was stopped after committing is pushed too: nothing is lost.
    await f.stub.execute(f.owner, 'ai-session-message', { sessionId: session.id, requestId: 'two', text: 'More' });
    const failed = (await f.claim(pc.node))!;
    await f.stub.execute(pc.node, 'ai-finish', { turnId: failed.turnId, leaseToken: failed.leaseToken, result: { status: 'failed', message: 'exited 1', commit: 'b'.repeat(40) } });
    await f.pushed(pc.node, 'b'.repeat(40));
    // Kept on the computer: replies are committed but not pushed, until the owner changes their mind or pushes by hand.
    expect(await (await f.stub.execute(f.owner, 'ai-session-update', { sessionId: session.id, localOnly: true })).json()).toMatchObject({ localOnly: true });
    expect((await f.stub.execute(f.owner, 'ai-session-update', { sessionId: session.id, localOnly: 'yes' })).status).toBe(400);
    await f.stub.execute(f.owner, 'ai-session-message', { sessionId: session.id, requestId: 'three', text: 'Even more' });
    await f.reply(pc.node, 'c'.repeat(40));
    expect(await f.claim(pc.node)).toBeNull();
    expect(await (await f.stub.execute(f.owner, 'ai-session', { sessionId: session.id })).json()).toMatchObject({ working: false, localOnly: true });
    expect((await f.stub.execute(f.owner, 'ai-session-push', { sessionId: session.id, requestId: 'by-hand' })).status).toBe(201);
    await f.pushed(pc.node, 'c'.repeat(40));
    // Pushing to Smith's copy of a project needs the operator role; a viewer's chat says so instead of pushing.
    const viewer = await f.member('viewer'); const theirs = await f.computer(viewer);
    await runInDurableObject(f.stub, (_o, state) => {
      state.storage.sql.exec('UPDATE projects SET definition = ? WHERE id = ?', JSON.stringify({ ...project, repoUrl: 'https://exp.example.test/git/smith.git' }), 'smith');
    });
    const copy = await (await f.start(viewer, theirs.nodeId)).json() as { id: string };
    await f.reply(theirs.node);
    const events = await (await f.stub.execute(viewer, 'ai-session-events', { sessionId: copy.id })).json() as { events: { kind: string; data: string }[] };
    expect(events.events.at(-1)).toMatchObject({ kind: 'status', data: expect.stringContaining('Not pushed: pushing to this project needs the operator role') });
    expect(await f.claim(theirs.node)).toBeNull();
  });

  it('names the branch after the chat on agents that understand such names, and briefs the CLI on where it is', async () => {
    const f = await setup(); const pc = await f.computer(f.owner);
    const session = await (await f.start(f.owner, pc.nodeId)).json() as { id: string; branch: string };
    expect(session.branch).toMatch(/^smith\/ai-fix-the-flaky-test-tidy-up-[a-f0-9]{8}$/);
    expect(chatBranch('3576a6da-0000-4000-8000-000000000001', 'Fix the "flaky" test & tidy up', true)).toBe('smith/ai-fix-the-flaky-test-tidy-up-3576a6da');
    expect(chatBranch('3576a6da-0000-4000-8000-000000000001', 'Fix the "flaky" test & tidy up', false)).toBe('smith/ai-3576a6da');
    expect(chatBranch('3576a6da-0000-4000-8000-000000000001', '!!! ???', true)).toBe('smith/ai-3576a6da');
    expect(chatBranch('3576a6da-0000-4000-8000-000000000001', 'Make the login page remember the e-mail address', true)).toBe('smith/ai-make-the-login-page-remember-the-3576a6da');
    expect(chatBranch('3576a6da-0000-4000-8000-000000000001', 'a'.repeat(31) + ' b', true)).toBe('smith/ai-' + 'a'.repeat(31) + '-3576a6da');
    // Every message turn tells the CLI the project, branch, base commit, what Smith does for it and what the person can build.
    const turn = (await f.claim(pc.node))! as Turn & { briefing?: string };
    expect(turn.briefing).toContain(`on the branch ${session.branch}, started from commit ${project.commit.slice(0, 12)} of its ${project.branch} branch`);
    expect(turn.briefing).toContain('"Smith" (smith)');
    expect(turn.briefing).toContain('Smith commits the files you change after each reply and pushes this branch itself. Do not commit, push');
    expect(turn.briefing).toContain('(build)');
    expect(turn.briefing).toMatch(/^[A-Za-z]/);
    // ...then how smith.json works, within the agent's limit and with no control character it would refuse.
    expect(turn.briefing).toContain('How smith.json works');
    expect(turn.briefing).toContain('"buildProducts"');
    expect(turn.briefing).toContain('${NAME} is replaced in args');
    expect(turn.briefing).toContain('nodeSelector labels ["blender"]');                       // a render project works from one message
    expect(new TextEncoder().encode(turn.briefing).length).toBeLessThanOrEqual(BRIEFING_MAX_BYTES);
    expect(turn.briefing).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
    // Where it is wins over the primer when both do not fit.
    const huge = chatBriefing({ project_id: 'smith', branch: session.branch, base_commit: project.commit }, { ...project, name: 'x'.repeat(8000) } as unknown as Parameters<typeof chatBriefing>[1]);
    expect(huge).toContain('x'.repeat(8000)); expect(huge).not.toContain('How smith.json works');
    // A project with no smith.json: the chat is told the default Smith detected and builds with.
    const detected = chatBriefing({ project_id: 'site', branch: session.branch, base_commit: project.commit },
      { id: 'site', name: 'Site', kind: 'repo', branch: 'main', actions: [], warnings: [], scan: { state: 'ready' }, detected: { kind: 'npm', summary: 'npm ci, then npm run build', smithJson: '{}' } } as unknown as Parameters<typeof chatBriefing>[1]);
    expect(detected).toContain('This repository has no smith.json. Smith builds it with a default it detected from the files: npm ci, then npm run build.');
    await f.stub.execute(pc.node, 'ai-finish', { turnId: turn.turnId, leaseToken: turn.leaseToken, result: { status: 'completed', message: 'ok', commit: 'a'.repeat(40) } });
    const push = (await f.claim(pc.node))! as Turn & { briefing?: string };
    expect(push).toMatchObject({ kind: 'push' }); expect(push.briefing).toBeUndefined();            // nothing runs a CLI in a push turn
  });

  it('lets only builders start a Verify, and asks owners of older agents to update first', async () => {
    const f = await setup(); const viewer = await f.member('viewer'); const pc = await f.computer(viewer);
    const session = await (await f.start(viewer, pc.nodeId)).json() as { id: string };
    await f.reply(pc.node); await f.pushed(pc.node);                                                 // pushing to GitHub needs no role
    expect((await f.stub.execute(viewer, 'ai-session-push', { sessionId: session.id, requestId: 'a', product: 'build' })).status).toBe(403);
    expect((await f.stub.execute(viewer, 'ai-session-push', { sessionId: session.id, requestId: 'b' })).status).toBe(201); // pushing to GitHub uses their own Git login
    const old = await f.computer(f.owner, { tools: claudeOnly.tools, ollama: claudeOnly.ollama });      // no features reported
    expect(await (await f.start(f.owner, old.nodeId, { permissionMode: 'default' })).json()).toMatchObject({ error: { code: 'agent_update_needed' } });
    const mine = await (await f.start(f.owner, old.nodeId)).json() as { id: string; branch: string };
    expect(mine.branch).toMatch(/^smith\/ai-[a-f0-9]{8}$/);                                            // an older agent accepts only the short branch names
    await f.reply(old.node);
    // No push by itself either: the chat says why, with the fix.
    const events = await (await f.stub.execute(f.owner, 'ai-session-events', { sessionId: mine.id })).json() as { events: { kind: string; data: string }[] };
    expect(events.events.at(-1)).toMatchObject({ kind: 'status', data: expect.stringMatching(/^Not pushed: pushing from chats needs a newer Smith agent on pc/) });
    expect(await (await f.stub.execute(f.owner, 'ai-session', { sessionId: mine.id })).json()).toMatchObject({ working: false });
    expect(await (await f.stub.execute(f.owner, 'ai-session-push', { sessionId: mine.id, requestId: 'c' })).json()).toMatchObject({ error: { code: 'agent_update_needed' } });
  });

  it('gives the machine an Artifacts token only for the turn it runs: read to clone and build, write to push', async () => {
    fakeArtifacts.reset();
    const f = await setup(); const pc = await f.computer(f.owner);
    const remote = fakeArtifacts.remote('smith-chat');
    fakeArtifacts.repos.set(`${fakeArtifacts.account}/smith-chat`, { name: 'smith-chat', remote, defaultBranch: 'main', heads: {} });
    await runInDurableObject(f.stub, (_o, state) => {
      const artifacts = { repo: 'smith-chat', namespace: 'default', remote, status: 'done', accountId: fakeArtifacts.account, source: 'smith', sourceRepoUrl: project.repoUrl, updatedAt: 1 };
      state.storage.sql.exec('UPDATE projects SET definition = ? WHERE id = ?', JSON.stringify({ ...project, repoUrl: remote, artifacts }), 'smith');
    });
    const session = await (await f.start(f.owner, pc.nodeId)).json() as { id: string };
    const scopeOf = (token: string | undefined) => ({ r: 'read', w: 'write' })[/^art_v1_0{28}([rw])/.exec(token ?? '')?.[1] as 'r' | 'w'];
    const first = (await f.claim(pc.node))! as Turn & { repo: { authToken?: string } };
    expect(first.repo.url).toBe(remote);
    expect(scopeOf(first.repo.authToken)).toBe('read');
    await f.stub.execute(pc.node, 'ai-finish', { turnId: first.turnId, leaseToken: first.leaseToken, result: { status: 'completed', message: 'ok', commit: 'e'.repeat(40) } });
    const automatic = (await f.claim(pc.node))! as Turn & { kind: string; repo: { authToken?: string } };
    expect(automatic.kind).toBe('push'); expect(scopeOf(automatic.repo.authToken)).toBe('write');   // Smith's own push of the reply
    await f.stub.execute(pc.node, 'ai-finish', { turnId: automatic.turnId, leaseToken: automatic.leaseToken, result: { status: 'completed', message: 'Pushed', commit: 'e'.repeat(40) } });
    await f.stub.execute(f.owner, 'ai-session-push', { sessionId: session.id, requestId: 'p', product: 'build' });
    const push = (await f.claim(pc.node))! as Turn & { repo: { authToken?: string } };
    expect(scopeOf(push.repo.authToken)).toBe('write');
    await f.stub.execute(pc.node, 'ai-finish', { turnId: push.turnId, leaseToken: push.leaseToken, result: { status: 'completed', message: 'Pushed', commit: 'f'.repeat(40) } });
    const detail = await (await f.stub.execute(f.owner, 'ai-session', { sessionId: session.id })).json() as { turns: { jobId: string | null }[] };
    const specs = await runInDurableObject(f.stub, (_o, state) => JSON.parse(state.storage.sql.exec<{ specs: string }>('SELECT specs FROM jobs WHERE id = ?', detail.turns.at(-1)!.jobId).one().specs)) as Record<string, { repos: { authToken: string; commit: string }[] }>;
    expect(specs.windows.repos[0].commit).toBe('f'.repeat(40));
    expect(scopeOf(specs.windows.repos[0].authToken)).toBe('read');
  });

  it('gives the machine a git ticket for a chat on a project started in Smith, whose home is storage behind Smith’s URL', async () => {
    fakeArtifacts.reset();
    const f = await setup(); const pc = await f.computer(f.owner);
    const created = await f.stub.execute(f.owner, 'add-smith-project', { source: 'empty', name: 'Test Web' });
    expect(created.status).toBe(201);
    const shown = await created.json() as { id: string; repoUrl: string; home: string };
    expect([shown.home, shown.repoUrl]).toEqual(['artifacts', 'https://exp.redmarmosetstudios.com/git/test-web.git']);
    expect((await f.start(f.owner, pc.nodeId, { projectId: shown.id })).status).toBe(201);
    const scopes = () => runInDurableObject(f.stub, (_o, state) => state.storage.sql.exec<{ scope: string; label: string }>('SELECT scope, label FROM git_tickets WHERE repo_id = ? ORDER BY created_at', shown.id).toArray().map(r => r.scope + ':' + r.label));
    const first = (await f.claim(pc.node))! as Turn & { repo: { authToken?: string } };
    expect(first.repo.url).toBe(shown.repoUrl);
    expect(first.repo.authToken).toMatch(/^smith_git_/);                                  // without it the machine’s git asks for a password and the turn fails
    expect(await scopes()).toEqual(['read:chat']);
    await f.stub.execute(pc.node, 'ai-finish', { turnId: first.turnId, leaseToken: first.leaseToken, result: { status: 'completed', message: 'ok', commit: 'e'.repeat(40) } });
    const automatic = (await f.claim(pc.node))! as Turn & { kind: string; repo: { authToken?: string } };
    expect(automatic.kind).toBe('push'); expect(automatic.repo.authToken).toMatch(/^smith_git_/);
    expect(await scopes()).toEqual(['read:chat', 'write:chat']);
  });

  it('runs a chat on an Ollama model on your own machine', async () => {
    const f = await setup(); const pc = await f.computer(f.owner);
    const created = await f.start(f.owner, pc.nodeId, { brain: 'ollama', model: 'qwen3.5:9b', permissionMode: 'bypassPermissions' });
    expect(created.status).toBe(201);
    expect(await f.claim(pc.node)).toMatchObject({ tool: 'claude-code', brain: 'ollama', model: 'qwen3.5:9b', permissionMode: 'bypassPermissions', shared: false });
    const old = await f.computer(f.owner, { tools: claudeOnly.tools, ollama: claudeOnly.ollama, features: ['ask', 'push'] });
    expect(await (await f.start(f.owner, old.nodeId, { brain: 'ollama', model: 'qwen3.5:9b' })).json()).toMatchObject({ error: { code: 'agent_update_needed' } });
  });

  it('lets members chat with a machine’s shared local models, safely, while its owner stays in charge', async () => {
    const f = await setup(); const alice = await f.member(); const bob = await f.member(); const hers = await f.computer(alice);
    const ask = (who: Human, extra: Record<string, unknown> = {}) => f.start(who, hers.nodeId, { brain: 'ollama', model: 'qwen3.5:9b', ...extra });
    expect((await ask(f.owner)).status).toBe(403);                                      // not shared yet
    await f.stub.execute(alice, 'ai-share', { nodeId: hers.nodeId, share: true });
    for (const permissionMode of ['bypassPermissions', 'default']) expect(await (await ask(f.owner, { permissionMode })).json()).toMatchObject({ error: { code: 'guest_mode' } });
    expect((await ask(f.owner, { tool: 'codex', permissionMode: 'danger-full-access' })).status).toBe(403);
    const session = await (await ask(f.owner, { permissionMode: 'plan' })).json() as { id: string };
    expect(session.id).toEqual(expect.any(String));
    // The machine runs the guest's turn with an empty config of its own.
    const turn = (await f.claim(hers.node))!;
    expect(turn).toMatchObject({ sessionId: session.id, brain: 'ollama', model: 'qwen3.5:9b', permissionMode: 'plan', shared: true });
    await f.stub.execute(hers.node, 'ai-finish', { turnId: turn.turnId, leaseToken: turn.leaseToken, result: { status: 'completed', message: 'ok', commit: 'a'.repeat(40) } });
    // A guest's reply is never pushed with Alice's Git login: not by itself (the chat says so) and not by the button.
    const guestEvents = await (await f.stub.execute(f.owner, 'ai-session-events', { sessionId: session.id })).json() as { events: { kind: string; data: string }[] };
    expect(guestEvents.events.at(-1)).toMatchObject({ kind: 'status', data: expect.stringContaining('Not pushed: this chat runs on another member’s computer') });
    expect(await (await f.stub.execute(f.owner, 'ai-session-push', { sessionId: session.id, requestId: 'p' })).json()).toMatchObject({ error: { code: 'guest_push' } });
    expect((await f.stub.execute(f.owner, 'ai-session-message', { sessionId: session.id, requestId: 'm', text: 'go on', permissionMode: 'bypassPermissions' })).status).toBe(403);
    expect((await f.stub.execute(f.owner, 'ai-session-message', { sessionId: session.id, requestId: 'm', text: 'go on', permissionMode: 'acceptEdits' })).status).toBe(201);
    // Alice sees the guest chat on her machine and can stop it; Bob, another member, cannot.
    const nodes = await (await f.stub.execute(alice, 'nodes', {})).json() as { nodes: { id: string; guestChats?: { sessionId: string; userId: string }[] }[] };
    expect(nodes.nodes.find(n => n.id === hers.nodeId)!.guestChats).toMatchObject([{ sessionId: session.id, userId: f.owner.userId }]);
    const others = await (await f.stub.execute(bob, 'nodes', {})).json() as { nodes: { guestChats?: unknown }[] };
    expect(others.nodes.every(n => n.guestChats === undefined)).toBe(true);
    expect((await f.stub.execute(bob, 'ai-guest-stop', { nodeId: hers.nodeId, sessionId: session.id })).status).toBe(404);
    // When she stops sharing, a queued guest message is no longer handed to her machine.
    await f.stub.execute(alice, 'ai-share', { nodeId: hers.nodeId, share: false });
    expect(await f.claim(hers.node)).toBeNull();
    expect(await (await f.stub.execute(alice, 'ai-guest-stop', { nodeId: hers.nodeId, sessionId: session.id })).json()).toEqual({ stopped: true });
    expect(await (await f.stub.execute(f.owner, 'ai-session', { sessionId: session.id })).json()).toMatchObject({ working: false });
  });

  it('relays Codex’s questions in its ask mode, and only there', async () => {
    const f = await setup(); const inventory = { tools: [{ id: 'codex', version: '0.160.0' }], ollama: { up: false, models: [] } };
    const old = await f.computer(f.owner, { ...inventory, features: ['ask', 'push'] });
    expect(await (await f.start(f.owner, old.nodeId, { tool: 'codex', permissionMode: 'untrusted' })).json()).toMatchObject({ error: { code: 'agent_update_needed' } });
    const pc = await f.computer(f.owner, { ...inventory, features: FEATURES });
    const session = await (await f.start(f.owner, pc.nodeId, { tool: 'codex', permissionMode: 'untrusted' })).json() as { id: string };
    const turn = (await f.claim(pc.node))!;
    expect(turn.permissionMode).toBe('untrusted');
    const command = { kind: 'approval', data: { id: 'call_1', tool: 'Command', input: { command: 'npm test' } } };
    expect(await (await f.stub.execute(pc.node, 'ai-events', { turnId: turn.turnId, leaseToken: turn.leaseToken, seq: 0, events: [command] })).json()).toMatchObject({ answers: [] });
    expect((await f.stub.execute(f.owner, 'ai-session-approve', { sessionId: session.id, approvalId: 'call_1', behavior: 'deny', message: 'Run the unit tests only' })).status).toBe(200);
    expect(await (await f.stub.execute(pc.node, 'ai-events', { turnId: turn.turnId, leaseToken: turn.leaseToken, seq: 1, events: [] })).json())
      .toMatchObject({ answers: [{ id: 'call_1', behavior: 'deny', message: 'Run the unit tests only' }] });
    await f.stub.execute(pc.node, 'ai-finish', { turnId: turn.turnId, leaseToken: turn.leaseToken, result: { status: 'completed', message: 'ok' } });
    // Codex's sandboxed mode never asks, so a question there is refused.
    await f.stub.execute(f.owner, 'ai-session-message', { sessionId: session.id, requestId: 'next', text: 'go', permissionMode: 'workspace-write' });
    const next = (await f.claim(pc.node))!;
    expect((await f.stub.execute(pc.node, 'ai-events', { turnId: next.turnId, leaseToken: next.leaseToken, seq: 1, events: [command] })).status).toBe(400);
  });

  it('allows one working reply per person and tool at a time', async () => {
    const f = await setup(); const pc = await f.computer(f.owner);
    expect((await f.start(f.owner, pc.nodeId)).status).toBe(201);
    expect((await f.start(f.owner, pc.nodeId)).status).toBe(429);
  });

  it('stops a queued reply at once and a running one through its machine', async () => {
    const f = await setup(); const pc = await f.computer(f.owner);
    const first = await (await f.start(f.owner, pc.nodeId)).json() as { id: string };
    expect(await (await f.stub.execute(f.owner, 'ai-session-stop', { sessionId: first.id })).json()).toMatchObject({ working: false, turns: [{ state: 'stopped' }] });
    expect(await f.claim(pc.node)).toBeNull();
    const second = await (await f.start(f.owner, pc.nodeId)).json() as { id: string };
    const turn = (await f.claim(pc.node))!;
    await f.stub.execute(f.owner, 'ai-session-stop', { sessionId: second.id });
    expect(await (await f.stub.execute(pc.node, 'ai-events', { turnId: turn.turnId, leaseToken: turn.leaseToken, seq: 0, events: [] })).json()).toMatchObject({ stop: true });
    expect((await f.stub.execute(f.owner, 'ai-session-delete', { sessionId: second.id })).status).toBe(409);
    expect((await f.stub.execute(pc.node, 'ai-finish', { turnId: turn.turnId, leaseToken: turn.leaseToken, result: { status: 'stopped', message: 'Stopped' } })).status).toBe(200);
    expect((await f.stub.execute(f.owner, 'ai-session-close', { sessionId: second.id })).status).toBe(200);
    // Archiving ("close") hides a chat; sending a message to it brings it back.
    expect(await (await f.stub.execute(f.owner, 'ai-session', { sessionId: second.id })).json()).toMatchObject({ archived: true });
    expect((await f.stub.execute(f.owner, 'ai-session-message', { sessionId: second.id, requestId: 'late', text: 'hello?' })).status).toBe(201);
    expect(await (await f.stub.execute(f.owner, 'ai-session', { sessionId: second.id })).json()).toMatchObject({ archived: false });
  });

  it('keeps the transcript contiguous and rejects stale or conflicting reports', async () => {
    const f = await setup(); const pc = await f.computer(f.owner);
    await f.start(f.owner, pc.nodeId);
    const turn = (await f.claim(pc.node))!;
    const post = (seq: number, events: unknown[], leaseToken = turn.leaseToken) => f.stub.execute(pc.node, 'ai-events', { turnId: turn.turnId, leaseToken, seq, events });
    const a = { kind: 'status', data: 'Cloning' }, b = { kind: 'stderr', data: 'warning' };
    expect((await post(0, [a, b])).status).toBe(200);
    expect((await post(0, [a, b])).status).toBe(200);           // lost acknowledgement replay
    expect((await post(0, [b, a])).status).toBe(409);           // different content for the same sequence
    expect((await post(5, [a])).status).toBe(409);              // gap
    expect((await post(2, [a], 'stolen')).status).toBe(409);    // wrong lease
    expect((await post(2, [{ kind: 'shell', data: 'rm -rf /' }])).status).toBe(400);
    expect((await post(2, [{ kind: 'status', data: 'x'.repeat(40000) }])).status).toBe(413);
  });

  it('marks a reply lost when its machine stops reporting', async () => {
    const f = await setup(); const pc = await f.computer(f.owner);
    const session = await (await f.start(f.owner, pc.nodeId)).json() as { id: string };
    const turn = (await f.claim(pc.node))!;
    await runInDurableObject(f.stub, async (instance, state) => {
      state.storage.sql.exec('UPDATE ai_turns SET lease_expires_at = 1');
      await (instance as unknown as { alarm(): Promise<void> }).alarm();
    });
    expect(await (await f.stub.execute(f.owner, 'ai-session', { sessionId: session.id })).json()).toMatchObject({ working: false, turns: [{ state: 'lost' }] });
    expect((await f.stub.execute(pc.node, 'ai-finish', { turnId: turn.turnId, leaseToken: turn.leaseToken, result: { status: 'completed', message: '' } })).status).toBe(409);
  });
});

describe('chat library', () => {
  type Listed = { id: string; title: string; pinned: boolean; archived: boolean };
  async function library() {
    const f = await setup(); const pc = await f.computer(f.owner);
    // One reply at a time per person: start each chat and stop it before the next.
    async function chat(prompt: string) {
      const session = await (await f.start(f.owner, pc.nodeId, { prompt })).json() as { id: string };
      await f.stub.execute(f.owner, 'ai-session-stop', { sessionId: session.id });
      return session.id;
    }
    const list = async (body: Record<string, unknown> = {}, who = f.owner) => (await (await f.stub.execute(who, 'ai-sessions', body)).json() as { sessions: Listed[] }).sessions;
    const update = (sessionId: string, body: Record<string, unknown>) => f.stub.execute(f.owner, 'ai-session-update', { sessionId, ...body });
    return { ...f, pc, chat, list, update };
  }

  it('renames, pins and archives chats without losing them', async () => {
    const f = await library();
    const a = await f.chat('First chat about the build'); const b = await f.chat('Second chat'); const c = await f.chat('Third chat');
    expect((await f.list()).map(s => s.id)).toEqual([c, b, a]);
    expect((await f.update(a, { title: '  Fix the Linux build  ' })).status).toBe(200);
    expect((await f.update(a, { pinned: true })).status).toBe(200);
    expect((await f.list()).map(s => [s.id, s.title, s.pinned])).toEqual([[a, 'Fix the Linux build', true], [c, 'Third chat', false], [b, 'Second chat', false]]);
    expect((await f.update(b, { archived: true })).status).toBe(200);
    expect((await f.list()).map(s => s.id)).toEqual([a, c]);
    expect(await f.list({ archived: true })).toEqual([expect.objectContaining({ id: b, archived: true })]);
    expect((await f.update(b, { archived: false })).status).toBe(200);
    expect((await f.list()).map(s => s.id)).toContain(b);
    for (const bad of [{ title: '' }, { title: '   ' }, { title: 'x'.repeat(121) }, { title: 'line\nbreak' }, { archived: 'yes' }, { pinned: 1 }, { owner: 'me' }])
      expect((await f.update(a, bad)).status).toBe(400);
  });

  it('finds chats by title, by what you asked, and by what the assistant replied', async () => {
    const f = await library();
    const build = await f.chat('Why is the MSVC build red?');
    const docs = await f.chat('Tidy the README');
    const percent = await f.chat('Explain 100% coverage');
    // The assistant's reply in the docs chat mentions something the title does not.
    await f.stub.execute(f.owner, 'ai-session-message', { sessionId: docs, requestId: 'r', text: 'and the changelog' });
    const turn = (await f.claim(f.pc.node))!;
    await f.stub.execute(f.pc.node, 'ai-events', { turnId: turn.turnId, leaseToken: turn.leaseToken, seq: 0, events: [{ kind: 'claude', data: { type: 'assistant', message: { content: [{ type: 'text', text: 'The flux capacitor section is outdated.' }] } } }] });
    expect((await f.list({ q: 'msvc' })).map(s => s.id)).toEqual([build]);
    expect((await f.list({ q: 'changelog' })).map(s => s.id)).toEqual([docs]);
    expect((await f.list({ q: 'flux capacitor' })).map(s => s.id)).toEqual([docs]);
    expect((await f.list({ q: '%' })).map(s => s.id)).toEqual([percent]); // wildcards are literal
    expect(await f.list({ q: 'nothing like this' })).toEqual([]);
    expect((await f.stub.execute(f.owner, 'ai-sessions', { q: 'x'.repeat(101) })).status).toBe(400);
  });

  it('deletes a chat and its transcript, but not while it is replying or for anyone else', async () => {
    const f = await library(); const other = await f.member();
    const done = await f.chat('Old experiment');
    expect((await f.stub.execute(other, 'ai-session-delete', { sessionId: done })).status).toBe(404);
    expect((await f.stub.execute(other, 'ai-session-update', { sessionId: done, title: 'mine now' })).status).toBe(404);
    expect((await f.stub.execute(f.owner, 'ai-session-delete', { sessionId: done })).status).toBe(200);
    expect(await f.list()).toEqual([]);
    expect((await f.stub.execute(f.owner, 'ai-session', { sessionId: done })).status).toBe(404);
    const working = await (await f.start(f.owner, f.pc.nodeId)).json() as { id: string };
    expect((await f.stub.execute(f.owner, 'ai-session-delete', { sessionId: working.id })).status).toBe(409);
    await runInDurableObject(f.stub, (_o, state) => {
      expect(state.storage.sql.exec('SELECT COUNT(*) AS n FROM ai_turns WHERE session_id = ?', done).one().n).toBe(0);
      expect(state.storage.sql.exec('SELECT COUNT(*) AS n FROM ai_events WHERE session_id = ?', done).one().n).toBe(0);
    });
  });
  it('starts chats on a project from a Git URL only once its smith.json is read, and checks its build actions', async () => {
    const f = await setup(); const pc = await f.computer(f.owner);
    await f.stub.execute(f.owner, 'add-repo-project', { source: 'git', url: 'https://github.com/o/fresh.git' });
    const early = await f.start(f.owner, pc.nodeId, { projectId: 'fresh' });
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({ error: { code: 'not_ready', message: expect.stringContaining('smith.json') } });
    fakeGitHub.reset();
    fakeGitHub.repos.set('Red-Marmoset/senet', { defaultBranch: 'master', branches: { master: { commit: 'f'.repeat(40), smithJson: senet, paths: [], truncated: false } } });
    await f.stub.execute(f.owner, 'put-settings', { githubToken: 'github_pat_' + 'K4'.repeat(15) });
    expect((await f.stub.execute(f.owner, 'add-repo-project', { source: 'git', url: 'git@github.com:Red-Marmoset/senet.git' })).status).toBe(201);
    const started = await f.start(f.owner, pc.nodeId, { projectId: 'senet' });
    expect(started.status).toBe(201);
    const session = await started.json() as { id: string; baseCommit: string };
    expect(session.baseCommit).toBe('f'.repeat(40));
    await f.reply(pc.node); await f.pushed(pc.node);
    const push = (product: string) => f.stub.execute(f.owner, 'ai-session-push', { sessionId: session.id, requestId: crypto.randomUUID(), product });
    expect((await push('stats-reconcile-prod')).status).toBe(400);          // not an action on master
    expect((await push('build-check')).status).toBe(201);
  });
  it('keeps the Verify of a Git-URL project secretless once its command is resolved, while a normal build of it keeps the workspace credentials', async () => {
    const f = await setup(); const pc = await f.computer(f.owner);
    fakeGitHub.reset();
    fakeGitHub.repos.set('Red-Marmoset/senet', { defaultBranch: 'master', branches: { master: { commit: 'f'.repeat(40), smithJson: senet, paths: [], truncated: false } } });
    const TOKEN = 'cf_test_token_1234567890abcdefghij'; const ACCOUNT = 'c'.repeat(32);
    expect((await f.stub.execute(f.owner, 'put-settings', { githubToken: 'github_pat_' + 'K4'.repeat(15), cloudflareApiToken: TOKEN, cloudflareAccountId: ACCOUNT })).status).toBe(200);
    expect((await f.stub.execute(f.owner, 'add-repo-project', { source: 'git', url: 'git@github.com:Red-Marmoset/senet.git' })).status).toBe(201);
    const session = await (await f.start(f.owner, pc.nodeId, { projectId: 'senet' })).json() as { id: string; branch: string };
    await f.reply(pc.node); await f.pushed(pc.node);
    expect((await f.stub.execute(f.owner, 'ai-session-push', { sessionId: session.id, requestId: crypto.randomUUID(), product: 'build-check' })).status).toBe(201);
    const pushTurn = (await f.claim(pc.node))!; const sha = 'd'.repeat(40);
    expect((await f.stub.execute(pc.node, 'ai-finish', { turnId: pushTurn.turnId, leaseToken: pushTurn.leaseToken, result: { status: 'completed', message: 'Pushed', commit: sha } })).status).toBe(200);
    // A machine that builds Git-URL projects checks the chat's commit out, then asks Smith what smith.json runs there:
    // the spec it gets back replaces the claimed one, so it must carry the same blanks.
    const machine = await f.builder(f.owner, ['node', 'smith-repo-projects']);
    type Claimed = { hasJob: boolean; envelope: { lease: Record<string, unknown>; spec: { env: Record<string, string> } } };
    const claimed = await (await f.stub.execute(machine.node, 'claim', {})).json() as Claimed;
    expect(claimed.envelope.spec.env).toMatchObject({ CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: ACCOUNT });
    const resolved = await f.stub.execute(machine.node, 'resolve', { ...claimed.envelope.lease, report: { commit: sha, branch: session.branch, smithJson: senet, paths: [], truncated: false } });
    expect(resolved.status).toBe(200);
    const { spec } = await resolved.json() as { spec: { env: Record<string, string> } };
    expect(spec.env).toMatchObject({ CLOUDFLARE_API_TOKEN: '', ANTHROPIC_API_KEY: '', CLOUDFLARE_ACCOUNT_ID: ACCOUNT, SMITH_COMMIT: sha, SMITH_BRANCH: 'master' });
    expect(spec.env).not.toHaveProperty('SENET_ASSUME_YES');                // smith.json's own env at that commit is dropped
    expect(JSON.stringify(spec)).not.toContain(TOKEN);
    // The control: an ordinary build of the same project (the branch tip, not a chat's commit) is not secretless, so the
    // credentials the secretless job lost reach it at the claim and again once /resolve has mapped its command.
    expect((await f.stub.execute(f.owner, 'enqueue', { requestId: 'normal-build', projectId: 'senet', product: 'build-check' })).status).toBe(201);
    const builder = await f.builder(f.owner, ['node', 'smith-repo-projects']);
    const normal = await (await f.stub.execute(builder.node, 'claim', {})).json() as Claimed;
    expect(normal.envelope.spec.env).toMatchObject({ CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT });
    const tip = 'e'.repeat(40);
    const built = await f.stub.execute(builder.node, 'resolve', { ...normal.envelope.lease, report: { commit: tip, branch: 'master', smithJson: senet, paths: [], truncated: false } });
    expect(built.status).toBe(200);
    expect((await built.json() as { spec: { env: Record<string, string> } }).spec.env).toMatchObject({ CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT, SMITH_COMMIT: tip, SMITH_BRANCH: 'master' });
  });
});

// A crew run is a session of kind 'crew' (see crew.test.ts for the whole run); chats must not notice it.
describe('crew sessions beside chats', () => {
  it('keeps crew sessions out of chat lists, chat actions, the busy check and the quota, and lets chats go first', async () => {
    const f = await setup(); const pc = await f.computer(f.owner);
    const crewSession = await runInDurableObject(f.stub, (_o, state) => new Sessions(state.storage.sql).createCrewSession({ crewId: crypto.randomUUID(), ownerUserId: f.owner.userId,
      nodeId: pc.nodeId, projectId: 'smith', tool: 'claude-code', brain: 'api-key', model: null, repoUrl: project.repoUrl, baseCommit: project.commit, branch: 'smith/crew-standards-0123abcd',
      title: 'Standards: Run now', permissionMode: 'plan', prompt: 'Look around', trigger: '{"kind":"manual"}' }, Date.now()));
    expect(await (await f.stub.execute(f.owner, 'ai-sessions', {})).json()).toEqual({ sessions: [] });
    for (const action of ['ai-session', 'ai-session-events', 'ai-session-stop', 'ai-session-update', 'ai-session-delete', 'ai-session-push', 'ai-session-approve'])
      expect((await f.stub.execute(f.owner, action, { sessionId: crewSession })).status, action).toBe(404);
    expect((await f.stub.execute(f.owner, 'ai-session-message', { sessionId: crewSession, requestId: 'x', text: 'hi' })).status).toBe(404);
    await runInDurableObject(f.stub, (_o, state) => {
      expect(state.storage.sql.exec<{ kind: string; crew_id: string }>('SELECT kind, crew_id FROM ai_sessions WHERE id = ?', crewSession).one()).toMatchObject({ kind: 'crew', crew_id: expect.any(String) });
      expect(state.storage.sql.exec('SELECT request_id, state, kind FROM ai_turns WHERE session_id = ?', crewSession).toArray()).toEqual([{ request_id: 'crew-' + crewSession, state: 'queued', kind: 'message' }]);
      // Fill the chat quota with crew sessions: they keep their own retention instead.
      for (let i = 0; i < 500; i++) state.storage.sql.exec("INSERT INTO ai_sessions (id, request_id, owner_user_id, node_id, project_id, tool, brain, repo_url, base_commit, branch, title, created_at, updated_at, kind) VALUES (?, ?, ?, 'n', 'smith', 'claude-code', 'api-key', 'x', 'c', 'b', 't', 1, 1, 'crew')", crypto.randomUUID(), crypto.randomUUID(), f.owner.userId);
    });
    // The crew turn is not the owner's working reply, so their chat starts; and their machine takes the chat first.
    const chat = await f.start(f.owner, pc.nodeId);
    expect(chat.status).toBe(201);
    expect((await f.claim(pc.node))!.sessionId).toBe((await chat.json() as { id: string }).id);
  });
});
