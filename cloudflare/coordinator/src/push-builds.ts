// Build on push: a GitHub push webhook for a project added from a Git URL. Turning it on registers the
// hook on the repository through the GitHub link of whoever turns it on (or another member's, or the
// Settings token), with a secret Smith made; when no link can register it, the dashboard shows the
// URL and secret to add by hand. Each delivery is checked against that secret (HMAC-SHA256 over the
// raw body, GitHub's X-Hub-Signature-256) before anything is read from it, then the push's branch is
// matched against the project's and the smith.json `webhook` triggers say what to build.
// Pure helpers plus the GitHub hooks adapter (with its in-memory fake for GITHUB_MODE=fake).
import { githubRepo, GitHubReadError } from './github-reader';

export const PUSH_EVENTS = ['ping', 'push'] as const;
export const MAX_DELIVERY_BYTES = 1024 * 1024;   // a push with many commits lists their files; GitHub caps payloads at 25 MB, Smith at 1 MiB
export const HOOK_VERSION = 1;

// Stored on the project; `secret` never leaves the Durable Object (publicPushHook strips it).
// via: 'github' (Smith registered the hook), 'manual' (added by hand), or 'smith' (a project that builds from Smith's copy with
// no linked repository: a push to the copy itself is the trigger, so there is no webhook at all).
export interface PushHook { enabled: boolean; secret: string; hookId: number | null; via: 'github' | 'manual' | 'smith'; message: string; lastDelivery: PushDelivery | null; updatedAt: number; pending?: PushPending }
export interface PushDelivery { at: number; event: string; deliveryId: string; branch: string; commit: string; outcome: string; jobIds: string[] }
// A push to a project that builds from Smith's copy builds once the commit is in the copy (stage 'pull': a Pull from the
// linked repository is under way) and smith.json has been read at it (stage 'scan': a machine is reading it).
export interface PushPending { delivery: PushDelivery; stage: 'pull' | 'scan' }
export interface PublicPushHook { enabled: boolean; via: 'github' | 'manual' | 'smith'; registered: boolean; message: string; lastDelivery: PushDelivery | null; updatedAt: number; pending: PushPending['stage'] | null }

export function hookUrl(origin: string, workspaceId: string, projectId: string): string { return `${origin}/api/v2/hooks/github/${workspaceId}/${projectId}`; }
export function publicPushHook(hook: PushHook | undefined): PublicPushHook | null {
  if (!hook) return null;
  return { enabled: hook.enabled, via: hook.via, registered: hook.hookId !== null, message: hook.message, lastDelivery: hook.pending?.delivery ?? hook.lastDelivery, updatedAt: hook.updatedAt, pending: hook.pending?.stage ?? null };
}

const encoder = new TextEncoder();
async function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}
// What GitHub sends: "sha256=<hex>". Verified with WebCrypto, which compares in constant time.
export async function verifySignature(secret: string, body: string, header: string | null): Promise<boolean> {
  const match = /^sha256=([a-f0-9]{64})$/.exec((header ?? '').trim());
  if (!match || !secret) return false;
  const signature = new Uint8Array(match[1].match(/../g)!.map(byte => parseInt(byte, 16)));
  return crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), signature, encoder.encode(body));
}
// For tests and tools that deliver a payload the way GitHub does.
export async function signPayload(secret: string, body: string): Promise<string> {
  const bytes = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), encoder.encode(body));
  return 'sha256=' + Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

// The parts of a push event Smith acts on. A deleted branch and a tag push build nothing.
export interface PushEvent { branch: string | null; commit: string; deleted: boolean; forced: boolean }
export function parsePush(payload: unknown): PushEvent {
  const p = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const ref = typeof p.ref === 'string' ? p.ref : '';
  const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
  const after = typeof p.after === 'string' && /^[a-f0-9]{40}$/.test(p.after) ? p.after : '';
  const deleted = p.deleted === true || /^0{40}$/.test(after);
  return { branch, commit: deleted ? '' : after, deleted, forced: p.forced === true };
}

// ---- Registering the hook on GitHub ----
export interface HookClient { create(repoUrl: string, token: string, url: string, secret: string): Promise<number>; remove(repoUrl: string, token: string, hookId: number): Promise<void> }
const headersFor = (token: string) => ({ Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'smith-coordinator', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' });
const realHooks: HookClient = {
  // A hook Smith already registered for this URL is reused (GitHub refuses a duplicate URL with 422), so
  // turning push builds off and on, or a lost record, never leaves a second hook behind.
  async create(repoUrl, token, url, secret) {
    const target = githubRepo(repoUrl);
    if (!target) throw new GitHubReadError('Not a GitHub repository URL');
    const signal = AbortSignal.timeout(8000);
    const base = `https://api.github.com/repos/${target.owner}/${target.repo}/hooks`;
    const existing = await fetch(`${base}?per_page=100`, { redirect: 'manual', signal, headers: headersFor(token) });
    if (existing.ok) {
      const hooks = await existing.json() as { id?: unknown; config?: { url?: unknown } }[];
      const mine = hooks.find(hook => hook.config?.url === url && Number.isSafeInteger(hook.id));
      if (mine) {
        const updated = await fetch(`${base}/${mine.id}`, { method: 'PATCH', redirect: 'manual', signal, headers: headersFor(token), body: JSON.stringify({ active: true, events: ['push'], config: { url, content_type: 'json', secret, insecure_ssl: '0' } }) });
        if (!updated.ok) throw new GitHubReadError(`GitHub answered ${updated.status} when updating the webhook`);
        return mine.id as number;
      }
    }
    const response = await fetch(base, { method: 'POST', redirect: 'manual', signal, headers: headersFor(token), body: JSON.stringify({ name: 'web', active: true, events: ['push'], config: { url, content_type: 'json', secret, insecure_ssl: '0' } }) });
    if (!response.ok) throw new GitHubReadError(`GitHub answered ${response.status} when adding the webhook`);
    const created = await response.json() as { id?: unknown };
    if (!Number.isSafeInteger(created.id)) throw new GitHubReadError('GitHub did not return the webhook ID');
    return created.id as number;
  },
  async remove(repoUrl, token, hookId) {
    const target = githubRepo(repoUrl);
    if (!target) return;
    const response = await fetch(`https://api.github.com/repos/${target.owner}/${target.repo}/hooks/${hookId}`, { method: 'DELETE', redirect: 'manual', signal: AbortSignal.timeout(8000), headers: headersFor(token) });
    if (!response.ok && response.status !== 404) throw new GitHubReadError(`GitHub answered ${response.status} when removing the webhook`);
  },
};

// Test double: hooks keyed "owner/repo", visible to the tokens the fake repository lists (github-reader's fakeGitHub).
export const fakeHooks = {
  hooks: new Map<string, { id: number; url: string; secret: string; active: boolean }[]>(),
  next: 1000,
  refuse: new Set<string>(),   // tokens whose hook calls GitHub refuses (no admin on the repository)
  reset(): void { this.hooks.clear(); this.next = 1000; this.refuse.clear(); },
};
const fake: HookClient = {
  async create(repoUrl, token, url, secret) {
    const target = githubRepo(repoUrl);
    if (!target || fakeHooks.refuse.has(token)) throw new GitHubReadError('GitHub answered 404 when adding the webhook');
    const key = `${target.owner}/${target.repo}`;
    const list = fakeHooks.hooks.get(key) ?? [];
    const mine = list.find(hook => hook.url === url);
    if (mine) { mine.secret = secret; mine.active = true; return mine.id; }
    const hook = { id: fakeHooks.next++, url, secret, active: true };
    list.push(hook); fakeHooks.hooks.set(key, list);
    return hook.id;
  },
  async remove(repoUrl, token, hookId) {
    const target = githubRepo(repoUrl);
    if (!target || fakeHooks.refuse.has(token)) throw new GitHubReadError('GitHub answered 404 when removing the webhook');
    const key = `${target.owner}/${target.repo}`;
    fakeHooks.hooks.set(key, (fakeHooks.hooks.get(key) ?? []).filter(hook => hook.id !== hookId));
  },
};
export function githubHooks(env: unknown): HookClient { return (env as { GITHUB_MODE?: unknown } | null)?.GITHUB_MODE === 'fake' ? fake : realHooks; }
