// Workspace builders shared by the crew and scheduler tests: a workspace with members and machines, and one ready for
// crew work. Not a test file itself (no `.test.` in its name), so vitest only runs it through its importers.
import { env } from 'cloudflare:workers';
import { runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { expect } from 'vitest';
import { fakeArtifacts, repoNameFor } from '../src/artifacts-repos';
import type { Project } from '../src/projects';

export type Human = { kind: 'human'; userId: string };
export type Node = { kind: 'node'; token: string };
export const origin = 'https://exp.redmarmosetstudios.com';
export const commit = 'd45d5d166ff384710a2f63cfa24271395b689c41';
export const KEY = 'sk-ant-' + 'a'.repeat(40);
export const product = { name: 'build', description: 'Build', labels: [], timeoutSeconds: 1800, commands: { windows: { interpreter: 'ps1', script: 'Build.ps1', args: [] } } };
export const projectBody = (id: string) => ({ id, name: id, repoUrl: `https://github.com/Red-Marmoset/${id}.git`, branch: 'main', commit, products: [product] });
// What a hosted agent that understands crew turns reports about itself.
export const CREW_AI = { tools: [{ id: 'claude-code', version: '2.1' }], ollama: { up: false, models: [] }, features: ['crew', 'push'] };
export const MEMBER = { name: 'Standards', charter: 'Enforce CLAUDE.md on recent commits', projectIds: ['smith'], brain: 'api-key', permissionMode: 'acceptEdits', trigger: { kind: 'manual' } };
export type Member = { id: string; slug: string; name: string; projectIds: string[]; memory: string; lastSeen: Record<string, string>; nextRunAt: number | null; enabled: boolean };
export type CrewTurn = { sessionId: string; turnId: string; leaseToken: string; kind: string; sessionKind?: string; shared: boolean; prompt: string; systemPrompt: string; schema: string;
  env: Record<string, string>; mcp: { url: string; token: string }; related: { projectId: string; url: string; commit: string; branch: string; authToken: string }[]; repo: { url: string; branch: string; authToken?: string };
  projectBranch?: string; member?: { id: string }; dryRun?: boolean };

export async function setup() {
  // A 64-hex workspace ID registered in D1, so a run token names a real workspace and /mcp accepts it.
  const id = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
  const owner: Human = { kind: 'human', userId: crypto.randomUUID() };
  const stub = env.WORKSPACES.getByName(id);
  await stub.initialize(id, owner.userId);
  await env.DB.prepare('INSERT INTO workspaces VALUES (?, ?)').bind(id, Date.now()).run();
  async function member(role: string): Promise<Human> {
    const userId = crypto.randomUUID();
    await runInDurableObject(stub, (_o, state) => { state.storage.sql.exec('INSERT INTO members (user_id, role) VALUES (?, ?)', userId, role); });
    return { kind: 'human', userId };
  }
  // A machine enrolled the way the dashboard does it: a person's own computer, or (admins only) a build machine.
  async function machine(who: Human, purpose: 'personal' | 'build', ai: unknown = { tools: [], ollama: { up: false, models: [] } }) {
    const created = await stub.execute(who, 'enrollments', { purpose });
    expect(created.status).toBe(201);
    const { code } = await created.json() as { code: string };
    const response = await stub.execute({ kind: 'enrollment' }, 'enroll', { code, protocolVersion: 2, os: 'windows', hostname: purpose === 'build' ? 'builder' : 'pc', labels: [], ai });
    expect(response.status).toBe(201);
    const { nodeId, token } = await response.json() as { nodeId: string; token: string };
    return { nodeId, node: { kind: 'node', token } as Node };
  }
  const computer = async (who: Human, ai?: unknown) => (await machine(who, 'personal', ai)).nodeId;
  const nodes = async (who: Human) => (await (await stub.execute(who, 'nodes', {})).json() as { nodes: { id: string; runCrew: boolean; crewWhileBuilding: boolean; guestChats?: unknown[] }[] }).nodes;
  return { id, stub, owner, member, machine, computer, nodes };
}

// A workspace ready for crew work: the project copied to Cloudflare Artifacts, an admin-enrolled build machine whose agent
// understands crew turns and whose owner opted it in, the workspace's Anthropic key, and an operator who manages the crew.
export async function crewSetup() {
  fakeArtifacts.reset();
  const f = await setup();
  async function copied(id: string) {
    expect((await f.stub.execute(f.owner, 'put-project', projectBody(id))).status).toBe(201);
    fakeArtifacts.seed(repoNameFor(f.id, id), 'main', commit);   // the copy already holds the pinned commit, so it switches without a push
    const response = await f.stub.execute(f.owner, 'mirror-project', { requestId: crypto.randomUUID(), projectId: id });
    expect(response.status).toBe(201);
    expect((await response.json() as { project: Project }).project.artifacts?.status).toBe('done');
  }
  await copied('smith');
  const builder = await f.machine(f.owner, 'build', CREW_AI);
  expect((await f.stub.execute(f.owner, 'node-crew', { nodeId: builder.nodeId, run: true })).status).toBe(200);
  expect((await f.stub.execute(f.owner, 'put-settings', { anthropicApiKey: KEY })).status).toBe(200);
  const operator = await f.member('operator');
  const put = (who: Human, body: Record<string, unknown> = {}) => f.stub.execute(who, 'crew-put', { ...MEMBER, ...body });
  const create = async (body: Record<string, unknown> = {}, who: Human = operator) => {
    const response = await put(who, body);
    expect(response.status, await response.clone().text()).toBe(201);
    return await response.json() as Member;
  };
  const run = (crewId: string, who: Human = operator, requestId: string = crypto.randomUUID(), extra: Record<string, unknown> = {}) => f.stub.execute(who, 'crew-run', { crewId, requestId, ...extra });
  const claim = async (node: Node = builder.node) => (await (await f.stub.execute(node, 'ai-claim', {})).json() as { turn: CrewTurn | null }).turn;
  const finish = (turn: CrewTurn, result: Record<string, unknown>, node: Node = builder.node) => f.stub.execute(node, 'ai-finish', { turnId: turn.turnId, leaseToken: turn.leaseToken, result });
  const list = async (who: Human = operator) => (await (await f.stub.execute(who, 'crew-list', {})).json() as { members: Member[] }).members;
  const runs = async (crewId: string, who: Human = operator) => (await (await f.stub.execute(who, 'crew-runs', { crewId })).json() as { runs: Record<string, unknown>[] }).runs;
  // Direct SQL on the workspace's storage, for arranging time (a due member, an old turn) and reading what the API hides.
  const sql = <T>(fn: (sql: SqlStorage) => T) => runInDurableObject(f.stub, (_o, state) => fn(state.storage.sql));
  // Run the alarm now, whenever it was set for (setting one first if nothing is due, as a lease or an interval would). An
  // alarm set for "now" by the last request may be mid-dispatch on its own: gone from storage, handler not yet run, so
  // runDurableObjectAlarm finds nothing and returns false. Under load the caller then read state no alarm had touched
  // (the flaky "pending, job_id null" check-in failure), so keep setting and running one until this call has run it.
  const alarm = async () => {
    for (let ran = false; !ran;) {
      await runInDurableObject(f.stub, async (_o, state) => { if (await state.storage.getAlarm() === null) await state.storage.setAlarm(Date.now() + 60000); });
      ran = await runDurableObjectAlarm(f.stub);
    }
  };
  // Make an interval member due `ago` milliseconds ago.
  const due = (crewId: string, ago = 1000) => sql(s => { s.exec('UPDATE crew_members SET next_run_at = ? WHERE id = ?', Date.now() - ago, crewId); });
  return { ...f, copied, builder, operator, put, create, run, claim, finish, list, runs, sql, alarm, due };
}
export async function errorOf(response: Response | Promise<Response>) {
  const r = await response;
  return { status: r.status, ...(await r.json() as { error: { code: string; message: string; waitReason?: string } }).error };
}
