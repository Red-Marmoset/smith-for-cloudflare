// Smith's own pull requests (src/pulls.ts): a crew proposal opens one by itself, a build machine whose agent runs pull jobs
// compares it, people comment, an operator merges it into Smith's Artifacts copy with a write token minted for that merge
// (revoked once it is over), and a copy made from GitHub can publish the branch for a GitHub pull request.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import identity from '../migrations/0001_identity.sql?raw';
import { fakeArtifacts, repoNameFor } from '../src/artifacts-repos';
import { githubCompareUrl, githubTarget, mergeAuthor, mergeMessage } from '../src/pulls';
import { commit, crewSetup, errorOf, origin, type Human, type Node } from './crew-fixture';

type Pull = { id: string; number: number; state: string; title: string; body: string; headBranch: string; headCommit: string; baseBranch: string;
  crew: { id: string; name: string | null; sessionId: string; status: string | null } | null; diff: { current: boolean; mergeable: boolean | null; conflicts: string[]; job: { jobId: string; state: string } | null };
  merge: { jobId: string; state: string; message: string } | null; mergeCommit: string | null; mergedBy: string | null; message: string | null;
  github: { repo: string; url: string | null; needsPublish: boolean; publish: { state: string } | null } | null; comments?: { userId: string; body: string }[] };
type Spec = { kind: string; repos: { url: string; commit: string; authToken: string }[]; pull: Record<string, string>; artifacts: { globs: string[] } };
type Assignment = { hasJob: boolean; envelope?: { lease: { jobId: string; attemptId: string; leaseToken: string; leaseExpiresAt: number; nodeId: string }; spec: Spec } };
const HEAD = 'a'.repeat(40), MERGED = 'b'.repeat(40);
beforeAll(async () => { await env.DB.exec(identity); });

async function pullSetup() {
  const f = await crewSetup();
  // The build machine's agent runs pull jobs.
  expect((await f.stub.execute(f.builder.node, 'heartbeat', { labels: ['smith-pull-requests'] })).status).toBe(200);
  const viewer = await f.member('viewer');
  const member = await f.create();
  const propose = (sessionId = crypto.randomUUID(), status = 'pending', branch = `smith/crew-${member.slug}-1`) => f.sql(s => {
    s.exec(`INSERT INTO crew_reports (session_id, crew_id, summary, findings, proposal, files, status, created_at, project_id, branch, head_commit, base_commit)
      VALUES (?, ?, 'Fixes the lint', '[]', ?, '["src/a.ts"]', ?, ?, 'smith', ?, ?, ?)`, sessionId, member.id, JSON.stringify({ title: 'Tidy the build', summary: 'Removes dead code' }), status, Date.now(), branch, HEAD, commit);
    return sessionId;
  });
  const list = async (who: Human = f.operator) => (await (await f.stub.execute(who, 'pulls', {})).json() as { pulls: Pull[]; machineReady: boolean });
  const get = async (pullId: string, who: Human = f.operator) => await (await f.stub.execute(who, 'pull', { pullId })).json() as Pull;
  const claim = async (node: Node = f.builder.node) => await (await f.stub.execute(node, 'claim', {})).json() as Assignment;
  // A job's declared files, as if uploaded (the upload path has tests of its own).
  const uploaded = (jobId: string, attemptId: string, names: string[]) => f.sql(s => { for (const name of names) s.exec('INSERT INTO artifacts VALUES (?, ?, ?, ?, 1, ?, 1)', jobId, attemptId, name, 'c'.repeat(64), `k/${jobId}/${name}`); });
  const complete = (a: Assignment, result: Record<string, unknown>) => f.stub.execute(f.builder.node, 'complete', { ...a.envelope!.lease, result: { exitCode: 0, durationMs: 1, message: 'done', ...result } });
  return { ...f, viewer, member, propose, list, get, claim, uploaded, complete };
}

describe('pull requests', () => {
  it('opens one for a crew proposal, diffs, takes comments, merges into Smith’s copy and revokes the merge token', async () => {
    const f = await pullSetup();
    const sessionId = await f.propose();
    const { pulls, machineReady } = await f.list(f.viewer);
    expect(machineReady).toBe(true);
    expect(pulls).toHaveLength(1);
    const pull = pulls[0];
    expect(pull).toMatchObject({ number: 1, state: 'open', title: 'Tidy the build', headCommit: HEAD, baseBranch: 'main', crew: { id: f.member.id, sessionId } });
    expect(pull.diff.job?.state).toBe('queued');

    // The diff runs on the build machine against Smith's copy, with a read token.
    const diff = await f.claim();
    expect(diff.envelope!.spec).toMatchObject({ kind: 'diff', pull: { baseBranch: 'main' }, artifacts: { globs: ['pull.patch', 'pull-files.txt'] } });
    expect(diff.envelope!.spec.repos[0]).toMatchObject({ url: fakeArtifacts.remote(repoNameFor(f.id, 'smith')), commit: HEAD });
    expect([...fakeArtifacts.tokens.values()].some(t => t.scope === 'read' && !t.revoked)).toBe(true);
    expect((await f.complete(diff, { status: 'success' })).status).toBe(409);   // its files must be uploaded first
    await f.uploaded(diff.envelope!.lease.jobId, diff.envelope!.lease.attemptId, ['pull.patch', 'pull-files.txt']);
    expect((await f.complete(diff, { status: 'success', commit: HEAD, pull: { baseCommit: commit, mergeBase: commit, mergeable: true, conflicts: [], truncated: false } })).status).toBe(200);
    expect((await f.get(pull.id)).diff).toMatchObject({ current: true, mergeable: true });

    // Every member may comment; a crew member reads comments on its pull requests in its memory.
    expect((await f.stub.execute(f.viewer, 'pull-comment', { pullId: pull.id, body: 'Please keep the old flag' })).status).toBe(201);
    const memory = await f.sql(s => s.exec<{ memory: string }>('SELECT memory FROM crew_members WHERE id = ?', f.member.id).one().memory);
    expect(memory).toContain('Please keep the old flag');
    expect((await f.get(pull.id)).comments?.map(c => c.body)).toEqual(['Please keep the old flag']);

    // Only operators merge. The merge carries a write token of Smith's copy and who merged.
    expect((await errorOf(f.stub.execute(f.viewer, 'pull-merge', { pullId: pull.id }))).status).toBe(403);
    const merging = await f.stub.execute(f.operator, 'pull-merge', { pullId: pull.id, authorName: 'Ops Person', authorEmail: 'ops@example.com' });
    expect(merging.status, await merging.clone().text()).toBe(201);
    expect((await errorOf(f.stub.execute(f.operator, 'pull-merge', { pullId: pull.id }))).code).toBe('merging');
    const merge = await f.claim();
    expect(merge.envelope!.spec.kind).toBe('merge');
    expect(merge.envelope!.spec.pull).toMatchObject({ baseBranch: 'main', authorName: 'Ops Person', authorEmail: 'ops@example.com' });
    expect(merge.envelope!.spec.pull.message).toContain('Merge pull request #1 from smith/crew-');
    const write = [...fakeArtifacts.tokens.entries()].find(([, t]) => t.scope === 'write' && !t.revoked);
    expect(write).toBeDefined();
    expect(merge.envelope!.spec.repos[0].authToken).toContain('w');
    expect((await f.complete(merge, { status: 'success', commit: MERGED, pull: { baseCommit: commit } })).status).toBe(200);

    const merged = await f.get(pull.id);
    expect(merged).toMatchObject({ state: 'merged', mergeCommit: MERGED, mergedBy: f.operator.userId });
    expect(fakeArtifacts.tokens.get(write![0])?.revoked).toBe(true);
    const report = await f.sql(s => s.exec<{ status: string }>('SELECT status FROM crew_reports WHERE session_id = ?', sessionId).one());
    expect(report.status).toBe('accepted');
    expect((await errorOf(f.stub.execute(f.operator, 'pull-merge', { pullId: pull.id }))).code).toBe('not_open');
  });

  it('refuses to merge a branch that conflicts, and a failed merge says why and can be tried again', async () => {
    const f = await pullSetup();
    await f.propose();
    const [pull] = (await f.list()).pulls;
    const diff = await f.claim();
    await f.uploaded(diff.envelope!.lease.jobId, diff.envelope!.lease.attemptId, ['pull.patch', 'pull-files.txt']);
    await f.complete(diff, { status: 'success', commit: HEAD, pull: { baseCommit: commit, mergeBase: commit, mergeable: false, conflicts: ['src/a.ts'] } });
    expect((await f.get(pull.id)).diff).toMatchObject({ mergeable: false, conflicts: ['src/a.ts'] });
    expect((await errorOf(f.stub.execute(f.operator, 'pull-merge', { pullId: pull.id }))).code).toBe('conflicts');
    expect([...fakeArtifacts.tokens.values()].some(t => t.scope === 'write' && !t.revoked)).toBe(false);   // a refused merge mints nothing

    // Refresh compares again (the base may have moved); this time it merges cleanly, but the push is refused.
    expect((await f.stub.execute(f.operator, 'pull-refresh', { pullId: pull.id })).status).toBe(200);
    const again = await f.claim();
    expect(again.envelope!.spec.kind).toBe('diff');
    await f.uploaded(again.envelope!.lease.jobId, again.envelope!.lease.attemptId, ['pull.patch', 'pull-files.txt']);
    await f.complete(again, { status: 'success', commit: HEAD, pull: { baseCommit: commit, mergeBase: commit, mergeable: true, conflicts: [] } });
    expect((await f.stub.execute(f.operator, 'pull-merge', { pullId: pull.id })).status).toBe(201);
    const merge = await f.claim();
    expect((await f.complete(merge, { status: 'failed', exitCode: 1, message: 'Pushing the merge to main failed; if the branch moved since, merge again' })).status).toBe(200);
    const failed = await f.get(pull.id);
    expect(failed.state).toBe('open');
    expect(failed.message).toContain('The merge failed: Pushing the merge');
    expect((await f.stub.execute(f.operator, 'pull-merge', { pullId: pull.id })).status).toBe(201);
  });

  it('opens one from a chosen branch, closes and reopens it, and publishes a copy’s branch to its GitHub origin', async () => {
    const f = await pullSetup();
    const opened = await f.stub.execute(f.operator, 'pull-open', { projectId: 'smith', branch: 'feature/x', commit: HEAD, title: 'Feature X', body: 'Adds X' });
    expect(opened.status, await opened.clone().text()).toBe(201);
    const pull = await opened.json() as Pull;
    expect(pull).toMatchObject({ number: 1, baseBranch: 'main', github: { repo: 'Red-Marmoset/smith', url: null, needsPublish: true } });
    expect((await errorOf(f.stub.execute(f.viewer, 'pull-open', { projectId: 'smith', branch: 'feature/y', commit: HEAD, title: 'Y' }))).status).toBe(403);
    expect((await errorOf(f.stub.execute(f.operator, 'pull-open', { projectId: 'smith', branch: 'main', commit: HEAD, title: 'Self' }))).code).toBe('invalid_branch');

    await f.list();                         // queues the diff
    const diff = await f.claim();
    expect(diff.envelope!.spec.kind).toBe('diff');
    expect((await f.stub.execute(f.operator, 'pull-publish', { pullId: pull.id })).status).toBe(201);
    const busy = await f.claim();
    expect(busy.envelope!.lease.jobId).toBe(diff.envelope!.lease.jobId);   // the machine finishes the diff first
    await f.uploaded(diff.envelope!.lease.jobId, diff.envelope!.lease.attemptId, ['pull.patch', 'pull-files.txt']);
    await f.complete(diff, { status: 'success', commit: HEAD, pull: { mergeable: true } });
    const next = await f.claim();
    expect(next.envelope!.spec).toMatchObject({ kind: 'publish', pull: { targetRemote: 'https://github.com/Red-Marmoset/smith.git', targetBranch: 'feature/x' } });
    expect(next.envelope!.spec.repos[0].authToken).not.toBe('');
    await f.complete(next, { status: 'success', commit: HEAD });
    const published = await f.get(pull.id);
    expect(published.github?.url).toBe('https://github.com/Red-Marmoset/smith/compare/main...feature%2Fx?expand=1&title=Feature+X&body=Adds+X');

    expect((await f.stub.execute(f.operator, 'pull-close', { pullId: pull.id, note: 'Not now' })).status).toBe(200);
    expect((await f.get(pull.id)).state).toBe('closed');
    expect((await f.get(pull.id)).comments?.map(c => c.body)).toEqual(['Not now']);
    expect((await f.stub.execute(f.operator, 'pull-reopen', { pullId: pull.id })).status).toBe(200);
    expect((await f.get(pull.id)).state).toBe('open');
  });

  it('closing a crew proposal’s pull request dismisses the proposal, and a stale proposal gets none', async () => {
    const f = await pullSetup();
    const sessionId = await f.propose();
    await f.propose(crypto.randomUUID(), 'stale', 'smith/crew-old');
    const { pulls } = await f.list();
    expect(pulls).toHaveLength(1);
    expect((await f.stub.execute(f.operator, 'pull-close', { pullId: pulls[0].id, note: 'Wrong approach' })).status).toBe(200);
    const report = await f.sql(s => s.exec<{ status: string; note: string }>('SELECT status, note FROM crew_reports WHERE session_id = ?', sessionId).one());
    expect(report).toMatchObject({ status: 'dismissed', note: 'Wrong approach' });
  });
});

describe('pull request helpers', () => {
  it('finds the GitHub repository, builds the compare link and the merge commit', () => {
    expect(githubTarget({ id: 'p', name: 'p', repoUrl: 'git@github.com:o/r.git', branch: 'main', commit, products: [] }, origin)).toMatchObject({ owner: 'o', repo: 'r', pushed: true });
    expect(githubTarget({ id: 'p', name: 'p', repoUrl: 'https://gitlab.com/o/r.git', branch: 'main', commit, products: [] }, origin)).toBeNull();
    expect(githubCompareUrl({ owner: 'o', repo: 'r' }, 'main', 'smith/crew-a-1', 'T', '')).toBe('https://github.com/o/r/compare/main...smith%2Fcrew-a-1?expand=1&title=T&body=');
    expect(mergeMessage({ number: 7, title: 'Fix', head_branch: 'b', body: '' }, 'Sem')).toBe('Merge pull request #7 from b\n\nFix\n\nMerged in Smith by Sem.');
    expect(mergeAuthor('u-1', 'Sem <x>', 'not-an-email')).toEqual({ authorName: 'Sem x', authorEmail: 'u1@users.smith.invalid' });
    expect(mergeAuthor('u', '', 'sem@example.com')).toEqual({ authorName: 'A Smith user', authorEmail: 'sem@example.com' });
  });
});
