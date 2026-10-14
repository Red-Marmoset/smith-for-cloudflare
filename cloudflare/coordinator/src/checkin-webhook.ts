import { githubRepo } from './github-reader';

export interface GitHubCheckIn {
  kind: 'push' | 'pr_updated' | 'pr_ready' | 'merge';
  branch: string; baseCommit: string; headCommit: string; source: 'github'; deliveryId: string;
}
const encoder = new TextEncoder();
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const commit = (value: unknown): value is string => typeof value === 'string' && /^[a-fA-F0-9]{40}$/.test(value) && !/^0+$/.test(value);
function branchValid(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && encoder.encode(value).length <= 512
    && !/[\u0000-\u0020\u007f~^:?*\[\\]/.test(value) && !value.includes('..') && !value.includes('@{')
    && !value.startsWith('/') && !value.endsWith('/') && !value.endsWith('.') && !value.includes('//')
    && !value.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'))
    && !value.startsWith('smith/crew-') && !value.startsWith('crew/');
}

/** Verify the exact UTF-8 request body before parsing it or accepting delivery identifiers. */
export async function verifyCheckInWebhook(raw: string, signature: string, secret: string): Promise<boolean> {
  if (!secret || !/^sha256=[a-fA-F0-9]{64}$/.test(signature) || encoder.encode(raw).length > 256 * 1024) return false;
  const bytes = Uint8Array.from(signature.slice(7).match(/../g)!, pair => parseInt(pair, 16));
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, bytes, encoder.encode(raw));
}

export function normalizeGitHubCheckIn(eventName: string, payload: unknown, deliveryId: string, expectedRepoUrl: string): GitHubCheckIn | null {
  const target = githubRepo(expectedRepoUrl), body = record(payload);
  if (!target || !/^[A-Za-z0-9-]{1,128}$/.test(deliveryId)) return null;
  const expected = `${target.owner}/${target.repo}`.toLowerCase();
  const matches = (repo: unknown) => typeof record(repo).full_name === 'string' && (record(repo).full_name as string).toLowerCase() === expected;
  if (!matches(body.repository)) return null;
  let kind: GitHubCheckIn['kind'], branch: unknown, base: unknown, head: unknown;
  if (eventName === 'push') {
    if (body.deleted === true || typeof body.ref !== 'string' || !body.ref.startsWith('refs/heads/')) return null;
    kind = 'push'; branch = body.ref.slice(11); base = body.before; head = body.after;
  } else if (eventName === 'pull_request') {
    const pr = record(body.pull_request), prBase = record(pr.base), prHead = record(pr.head);
    if (!matches(prBase.repo)) return null;
    base = prBase.sha;
    if (body.action === 'closed' && pr.merged === true) {
      kind = 'merge'; branch = prBase.ref; head = pr.merge_commit_sha;
    } else {
      if (!matches(prHead.repo)) return null; // A fork head is outside this registered repository.
      if (body.action === 'ready_for_review') kind = 'pr_ready';
      else if (['opened', 'reopened', 'synchronize'].includes(String(body.action))) kind = 'pr_updated';
      else return null;
      branch = prHead.ref; head = prHead.sha;
    }
  } else return null;
  if (!branchValid(branch) || !commit(base) || !commit(head)) return null;
  return { kind, branch, baseCommit: base.toLowerCase(), headCommit: head.toLowerCase(), source: 'github', deliveryId };
}
