import { describe, expect, it } from 'vitest';
import { normalizeGitHubCheckIn, verifyCheckInWebhook } from '../src/checkin-webhook';
const base = 'a'.repeat(40), head = 'b'.repeat(40), merge = 'c'.repeat(40);
const repository = { full_name: 'owner/repo' };
const normalize = (event: string, payload: unknown) => normalizeGitHubCheckIn(event, payload, 'delivery-1', 'git@github.com:owner/repo.git');
describe('signed GitHub check-in intake', () => {
  it('verifies the official raw-body HMAC vector and rejects tampering', async () => {
    const signature = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';
    expect(await verifyCheckInWebhook('Hello, World!', signature, "It's a Secret to Everybody")).toBe(true);
    expect(await verifyCheckInWebhook('Hello, World! ', signature, "It's a Secret to Everybody")).toBe(false);
    expect(await verifyCheckInWebhook('Hello, World!', 'sha256=x', 'secret')).toBe(false);
    expect(await verifyCheckInWebhook('Hello, World!', signature, '')).toBe(false);
  });
  it('binds push ranges to the registered repository and ignores deletions and Crew branches', () => {
    const push = { repository, ref: 'refs/heads/main', before: base, after: head };
    expect(normalize('push', push)).toEqual({ kind: 'push', branch: 'main', baseCommit: base, headCommit: head, source: 'github', deliveryId: 'delivery-1' });
    for (const change of [{ repository: { full_name: 'attacker/repo' } }, { deleted: true }, { after: '0'.repeat(40) }, { before: '0'.repeat(40) }, { ref: 'refs/tags/v1' }, { ref: 'refs/heads/crew/run' }]) expect(normalize('push', { ...push, ...change })).toBeNull();
  });
  it('normalizes PR updates, readiness and merge commits while rejecting fork heads', () => {
    const pull_request = { base: { sha: base, ref: 'main', repo: repository }, head: { sha: head, ref: 'feature', repo: repository }, merged: true, merge_commit_sha: merge };
    expect(normalize('pull_request', { repository, action: 'synchronize', pull_request })).toMatchObject({ kind: 'pr_updated', branch: 'feature', headCommit: head });
    expect(normalize('pull_request', { repository, action: 'ready_for_review', pull_request })).toMatchObject({ kind: 'pr_ready' });
    expect(normalize('pull_request', { repository, action: 'closed', pull_request })).toMatchObject({ kind: 'merge', branch: 'main', baseCommit: base, headCommit: merge });
    expect(normalize('pull_request', { repository, action: 'edited', pull_request })).toBeNull();
    expect(normalize('pull_request', { repository, action: 'opened', pull_request: { ...pull_request, head: { ...pull_request.head, repo: { full_name: 'fork/repo' } } } })).toBeNull();
  });
});
