// The crew's AI choice (an automatic member uses the workspace's AI order: Claude, GPT, then a local model) and the
// branchChanged trigger (a member runs when a watched branch gets commits it has not seen).
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import schema from '../migrations/0001_identity.sql?raw';
import browserSchema from '../migrations/0002_browser_auth.sql?raw';
import directorySchema from '../migrations/0003_workspace_directory.sql?raw';
import { chooseCrewAi, CREW_REPORT_SCHEMA_STRICT, validateCrewMember, validateCrewReport, type CrewMember } from '../src/crew-model';
import type { AiInventory } from '../src/ai';
import { DEFAULT_WORKSPACE_SETTINGS, validateWorkspaceSettings } from '../src/settings';
import { HttpError } from '../src/http';
import { CREW_AI, commit, crewSetup } from './crew-fixture';

beforeAll(async () => { await env.DB.exec(schema); await env.DB.exec(browserSchema); await env.DB.exec(directorySchema); });

const auto: Pick<CrewMember, 'tool' | 'brain' | 'model'> = { tool: 'auto', brain: 'auto', model: null };
const ORDER = ['claude', 'gpt', 'local'] as const;
function inventory(patch: Partial<AiInventory> = {}): AiInventory {
  return { tools: [], ollama: { up: false, models: [] }, features: ['crew', 'crew-codex'], ...patch };
}
const claude = (signedIn?: boolean) => ({ id: 'claude-code' as const, version: '2.1', ...(signedIn === undefined ? {} : { signedIn }) });
const codex = (signedIn?: boolean) => ({ id: 'codex' as const, version: '0.50', ...(signedIn === undefined ? {} : { signedIn }) });
const models = [{ name: 'nomic-embed-text', sizeBytes: 300, remote: false }, { name: 'qwen3:32b', sizeBytes: 20000, remote: false }, { name: 'gpt-oss:120b-cloud', sizeBytes: 90000, remote: true }];
const machine = (ai: AiInventory, buildMachine = false, apiKeyUsable = false) => ({ ai, buildMachine, apiKeyUsable });

describe('chooseCrewAi', () => {
  it('takes Claude first, then GPT, then a local model, by default', () => {
    expect(chooseCrewAi(auto, machine(inventory({ tools: [claude(true), codex(true)] })), ORDER)).toEqual({ tool: 'claude-code', brain: 'login', model: null });
    expect(chooseCrewAi(auto, machine(inventory({ tools: [claude(false), codex(true)] })), ORDER)).toEqual({ tool: 'codex', brain: 'login', model: null });
    // Neither signed in: the machine's largest local model (never a cloud one), in Claude Code, which needs no sign-in for it.
    expect(chooseCrewAi(auto, machine(inventory({ tools: [claude(false)], ollama: { up: true, models } })), ORDER)).toEqual({ tool: 'claude-code', brain: 'ollama', model: 'qwen3:32b' });
    // No Claude Code at all: the local model runs in Codex.
    expect(chooseCrewAi(auto, machine(inventory({ tools: [codex(false)], ollama: { up: true, models } })), ORDER)).toEqual({ tool: 'codex', brain: 'ollama', model: 'qwen3:32b' });
  });
  it('follows the workspace order and leaves out what it leaves out', () => {
    const both = inventory({ tools: [claude(true), codex(true)], ollama: { up: true, models } });
    expect(chooseCrewAi(auto, machine(both), ['gpt', 'claude'])).toMatchObject({ tool: 'codex', brain: 'login' });
    expect(chooseCrewAi(auto, machine(both), ['local', 'claude'])).toMatchObject({ brain: 'ollama', model: 'qwen3:32b' });
    expect(chooseCrewAi(auto, machine(inventory({ tools: [claude(false)], ollama: { up: true, models } })), ['claude', 'gpt']))
      .toBe('no AI ready (Claude Code is not signed in, Codex is not installed)');
  });
  it('falls back to the workspace key for Claude only on a build machine, and only while the key may be spent', () => {
    const signedOut = inventory({ tools: [claude(false)] });
    expect(chooseCrewAi(auto, machine(signedOut, true, true), ORDER)).toEqual({ tool: 'claude-code', brain: 'api-key', model: null });
    expect(chooseCrewAi(auto, machine(signedOut, false, true), ORDER)).toMatch(/^no AI ready/);
    expect(chooseCrewAi(auto, machine(signedOut, true, false), ORDER)).toMatch(/^no AI ready/);
  });
  it('uses Codex only through an agent that runs crew members with it, and with its sandbox set up', () => {
    expect(chooseCrewAi(auto, machine(inventory({ tools: [codex(true)], features: ['crew'] })), ['gpt'])).toBe('no AI ready (agent update needed for Codex)');
    expect(chooseCrewAi(auto, machine(inventory({ tools: [codex(true)], codexSandbox: 'not-set-up' })), ['gpt'])).toBe('no AI ready (Codex sandbox not set up)');
    expect(chooseCrewAi(auto, machine(inventory({ tools: [codex(true)], codexSandbox: 'ready' })), ['gpt'])).toMatchObject({ tool: 'codex' });
  });
  it('prefers the local model an automatic member names', () => {
    const ai = inventory({ ollama: { up: true, models }, tools: [claude()] });
    expect(chooseCrewAi({ ...auto, model: 'nomic-embed-text' }, machine(ai), ORDER)).toMatchObject({ brain: 'ollama', model: 'nomic-embed-text' });
    expect(chooseCrewAi({ ...auto, model: 'llama3' }, machine(ai), ['local'])).toBe('no AI ready (no local model llama3)');
  });
  it('gives a member that named its AI exactly that', () => {
    const ai = inventory({ tools: [claude(true), codex(false)], ollama: { up: true, models } });
    expect(chooseCrewAi({ tool: 'codex', brain: 'login', model: null }, machine(ai), ORDER)).toBe('no signed-in machine');
    expect(chooseCrewAi({ tool: 'claude-code', brain: 'login', model: null }, machine(ai), ORDER)).toMatchObject({ tool: 'claude-code', brain: 'login' });
    expect(chooseCrewAi({ tool: 'codex', brain: 'ollama', model: null }, machine(ai), ORDER)).toEqual({ tool: 'codex', brain: 'ollama', model: 'qwen3:32b' });
    expect(chooseCrewAi({ tool: 'claude-code', brain: 'login', model: null }, machine(inventory()), ORDER)).toBe('Claude Code is not installed');
  });
});

describe('the AI order setting and the member fields', () => {
  it('defaults to Claude, GPT, local and accepts any order of some of them', () => {
    expect(DEFAULT_WORKSPACE_SETTINGS.aiOrder).toEqual(['claude', 'gpt', 'local']);
    expect(validateWorkspaceSettings({ aiOrder: ['local', 'claude'] }, DEFAULT_WORKSPACE_SETTINGS).settings.aiOrder).toEqual(['local', 'claude']);
    for (const bad of [[], ['claude', 'claude'], ['gemini'], 'claude'])
      expect(() => validateWorkspaceSettings({ aiOrder: bad }, DEFAULT_WORKSPACE_SETTINGS)).toThrow(HttpError);
  });
  it('keeps the tool consistent with the brain', () => {
    const base = { name: 'X', charter: 'c', projectIds: ['p'] };
    expect(validateCrewMember({ ...base }, undefined, 'u', 1)).toMatchObject({ tool: 'auto', brain: 'auto', model: null });
    expect(validateCrewMember({ ...base, brain: 'login', tool: 'codex' }, undefined, 'u', 1)).toMatchObject({ tool: 'codex', brain: 'login' });
    expect(validateCrewMember({ ...base, brain: 'login' }, undefined, 'u', 1)).toMatchObject({ tool: 'claude-code', brain: 'login' });
    expect(validateCrewMember({ ...base, brain: 'auto', tool: 'codex' }, undefined, 'u', 1)).toMatchObject({ tool: 'auto', brain: 'auto' });
  });
  it('watches a branch, never one of Smith’s own', () => {
    const base = { name: 'X', charter: 'c', projectIds: ['p'] };
    expect(validateCrewMember({ ...base, trigger: { kind: 'branchChanged' } }, undefined, 'u', 1).trigger).toEqual({ kind: 'branchChanged', branch: '', checkMinutes: 5 });
    expect(validateCrewMember({ ...base, trigger: { kind: 'branchChanged', branch: 'feature/x', checkMinutes: 2, intervalMinutes: 60 } }, undefined, 'u', 1).trigger)
      .toEqual({ kind: 'branchChanged', branch: 'feature/x', checkMinutes: 2 });
    for (const trigger of [{ kind: 'branchChanged', branch: 'smith/crew-x-0123abcd' }, { kind: 'branchChanged', branch: 'a..b' }, { kind: 'branchChanged', checkMinutes: 1 }])
      expect(() => validateCrewMember({ ...base, trigger }, undefined, 'u', 1)).toThrow(HttpError);
  });
  it('gives Codex a strict schema whose answers the report validator accepts', () => {
    const schema = JSON.parse(CREW_REPORT_SCHEMA_STRICT) as { required: string[]; additionalProperties: boolean };
    expect(schema).toMatchObject({ additionalProperties: false, required: ['summary', 'findings', 'proposal', 'memory', 'skipped'] });
    expect(validateCrewReport({ summary: 's', findings: [{ severity: 'low', title: 't', file: null, line: null, detail: 'd' }], proposal: null, memory: null, skipped: null }))
      .toEqual({ summary: 's', findings: [{ severity: 'low', title: 't', detail: 'd' }] });
  });
});

describe('crew runs on the AI the machine has', () => {
  it('runs an automatic member with Codex where only Codex is signed in, and with a local model where nothing is', async () => {
    const f = await crewSetup();
    const ai = { ...CREW_AI, tools: [{ id: 'claude-code', version: '2.1', signedIn: false }, { id: 'codex', version: '0.50', signedIn: true }], features: ['crew', 'push', 'crew-codex'] };
    const pc = await f.machine(f.owner, 'personal', ai);
    expect((await f.stub.execute(f.owner, 'node-crew', { nodeId: pc.nodeId, run: true })).status).toBe(200);
    const member = await f.create({ brain: 'auto', nodeId: pc.nodeId });
    expect((await f.run(member.id)).status).toBe(201);
    const turn = (await f.claim(pc.node))!;
    expect(turn).toMatchObject({ sessionKind: 'crew', tool: 'codex', brain: 'login', model: null, env: {}, schema: CREW_REPORT_SCHEMA_STRICT });
    expect(turn.systemPrompt).toContain('run commands inside a sandbox');
    expect((await f.finish(turn, { status: 'completed', message: 'ok', baseCommit: commit, files: [], filesTotal: 0, filesTruncated: false, report: { summary: 's', findings: [] } }, pc.node)).status).toBe(200);
    // Codex signed out, a local model up: the same member now runs that model, in Claude Code.
    const local = { ...ai, tools: [{ id: 'claude-code', version: '2.1', signedIn: false }, { id: 'codex', version: '0.50', signedIn: false }], ollama: { up: true, models } };
    expect((await f.stub.execute(pc.node, 'heartbeat', { ai: local })).status).toBe(200);
    expect((await f.run(member.id)).status).toBe(201);
    expect(await f.claim(pc.node)).toMatchObject({ tool: 'claude-code', brain: 'ollama', model: 'qwen3:32b', env: {} });
  });
  it('says why no machine can run an automatic member', async () => {
    const f = await crewSetup();
    expect((await f.stub.execute(f.owner, 'put-settings', { aiOrder: ['gpt'] })).status).toBe(200);
    const member = await f.create({ brain: 'auto' });
    const response = await f.run(member.id);
    expect(response.status).toBe(409);
    expect((await response.json() as { error: { waitReason: string } }).error.waitReason).toBe('no AI ready (Codex is not installed)');
  });
});

describe('the branchChanged trigger', () => {
  it('looks at once, runs on what it has not seen, and keeps a look that found nothing out of the history', async () => {
    const f = await crewSetup();
    const before = Date.now();
    const member = await f.create({ trigger: { kind: 'branchChanged', branch: 'develop', checkMinutes: 5 } });
    expect(member.nextRunAt).toBeGreaterThanOrEqual(before);
    expect(member.nextRunAt).toBeLessThanOrEqual(Date.now());
    await f.due(member.id); await f.alarm();
    // The first look: nothing seen yet, so it runs from develop's tip over its recent commits.
    const first = (await f.claim())! as Record<string, unknown> & Awaited<ReturnType<typeof f.claim>> & object;
    expect(first).toMatchObject({ projectBranch: 'develop', skipIfCommit: null, changesSince: null });
    expect(first.prompt).toContain('New commits arrived on branch develop');
    // Next look is scheduled checkMinutes on; while this run works, a due look adds no second run.
    expect((await f.list()).find(m => m.id === member.id)!.nextRunAt).toBeGreaterThan(Date.now() + 4 * 60000);
    await f.due(member.id); await f.alarm();
    expect(await f.sql(s => s.exec("SELECT COUNT(*) AS n FROM crew_runs WHERE crew_id = ? AND state = 'waiting'", member.id).one().n)).toBe(0);
    expect((await f.finish(first!, { status: 'completed', message: 'ok', baseCommit: commit, files: [], filesTotal: 0, filesTruncated: false, report: { summary: 'Looked', findings: [] } })).status).toBe(200);
    expect((await f.list()).find(m => m.id === member.id)!.lastSeen).toEqual({ 'smith@develop': commit });
    // The next look hands the agent the commit it saw; the agent finds develop there and skips.
    await f.due(member.id); await f.alarm();
    const second = (await f.claim())!;
    expect(second).toMatchObject({ projectBranch: 'develop', skipIfCommit: commit, changesSince: commit });
    expect((await f.finish(second, { status: 'completed', message: 'skipped', commit: null, baseCommit: commit, report: { summary: 'No new commits', findings: [], skipped: true } })).status).toBe(200);
    const quiet = await f.sql(s => s.exec<{ state: string; started_at: number | null }>('SELECT state, started_at FROM crew_runs WHERE session_id = ?', second.sessionId).one());
    expect(quiet).toEqual({ state: 'unchanged', started_at: null });
    expect(await f.sql(s => s.exec('SELECT COUNT(*) AS n FROM crew_reports WHERE session_id = ?', second.sessionId).one().n)).toBe(0);
    expect((await f.runs(member.id)).map(r => r.sessionId)).toEqual([first.sessionId]);
    // Retention drops the quiet look's session (and its run) at the next alarm.
    await f.alarm();
    expect(await f.sql(s => s.exec('SELECT COUNT(*) AS n FROM ai_sessions WHERE id = ?', second.sessionId).one().n)).toBe(0);
    expect(await f.sql(s => s.exec('SELECT COUNT(*) AS n FROM ai_sessions WHERE id = ?', first.sessionId).one().n)).toBe(1);
  });
});
