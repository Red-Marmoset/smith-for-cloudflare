// A Git-URL project that builds from Smith's copy can stay linked to the repository it came from
// (GitHub or any Git host): Pull brings that repository's branch into Smith's copy, Push sends
// Smith's copy back out, and Detach drops the link so the project lives only in Smith. Both
// directions are ordinary `mirror` jobs run by a connected machine with its own Git login; the
// push is never forced, so a branch that moved on either side is refused, not overwritten.
import { fail } from './http';
import { smokeSpec, type ResolvedJobSpec } from './contracts';
import { isArtifactsRemote } from './artifacts-repos';
import { smithRemote, smithRemoteRepo } from './git-host';
import { validateRepoUrl, type RepoProject } from './repo-projects';
import type { Project, ProjectArtifacts } from './projects';

// The copy a project builds from, whichever kind: Cloudflare Artifacts (project.artifacts) or Smith's own machines
// (project.hosted). Pull, Push and Detach work the same on both; only the address and the credential differ.
export interface CopyInfo { kind: 'artifacts' | 'hosted'; remote: string; sourceRepoUrl: string; detachedFrom?: string; sync?: UpstreamSync }
export function copyOf(project: Project | RepoProject | undefined, origin: string): CopyInfo | undefined {
  if (!project) return undefined;
  const hosted = project.hosted, copy = project.artifacts;
  if (project.home === 'artifacts' && copy?.status === 'done') return { kind: 'artifacts', remote: smithRemote(origin, project.id), sourceRepoUrl: copy.sourceRepoUrl, detachedFrom: copy.detachedFrom, sync: copy.sync };
  if (hosted?.status === 'ready' && smithRemoteRepo(project.repoUrl, origin) === project.id) return { kind: 'hosted', remote: smithRemote(origin, project.id), sourceRepoUrl: hosted.sourceRepoUrl, detachedFrom: hosted.detachedFrom, sync: hosted.sync };
  // Before the upgrade pass (home.ts assignHome): an Artifacts copy still addressed directly.
  if (copy?.status === 'done' && project.repoUrl === copy.remote) return { kind: 'artifacts', remote: copy.remote, sourceRepoUrl: copy.sourceRepoUrl, detachedFrom: copy.detachedFrom, sync: copy.sync };
  return undefined;
}

export const SYNC_LABEL = 'smith-repo-sync';   // only agents that can mirror a branch tip both ways advertise it
export type SyncDirection = 'pull' | 'push';
export const SYNC_PRODUCT: Record<SyncDirection, string> = { pull: 'pull-from-linked-repo', push: 'push-to-linked-repo' };
// The last Pull or Push: 'running' while its job is queued or running.
export interface UpstreamSync { direction: SyncDirection; status: 'running' | 'done' | 'failed'; jobId: string; tokenId?: string; commit?: string; message?: string; at: number }

// The repository a copied project is linked to, or '' when it lives only in Smith (detached, or
// created by a crew run, whose sourceRepoUrl is the copy itself).
export function upstreamOf(copy: { remote: string; sourceRepoUrl: string } | undefined, origin = ''): string {
  const url = copy?.sourceRepoUrl ?? '';
  return url && url !== copy!.remote && !isArtifactsRemote(url) && !(origin && smithRemoteRepo(url, origin)) ? url : '';
}
// The copy a project builds from, when it has one: Pull, Push and linking need it.
export function smithCopy(project: Project | RepoProject | undefined, origin: string): CopyInfo {
  if (!project) fail(404, 'not_found', 'Project not found');
  if ((project as RepoProject).kind !== 'repo') fail(409, 'unsupported_project', 'Linking is for projects added from a Git URL');
  const copy = copyOf(project, origin);
  if (!copy) fail(409, 'not_in_smith', 'Copy this project into Smith first');
  return copy;
}
export function syncRunning(copy: CopyInfo): boolean { return copy.sync?.status === 'running'; }
// A repository to link: the same addresses Add project accepts, never Smith's own copy.
export function validateUpstreamUrl(value: string, origin = ''): string {
  const url = validateRepoUrl(value);
  if (isArtifactsRemote(url) || (origin && smithRemoteRepo(url, origin))) fail(400, 'invalid_repository', 'Link a repository on another Git host, not Smith’s own copy');
  if (!/^(https:\/\/|ssh:\/\/|git@)/.test(url)) fail(400, 'invalid_repository', 'Use an https://, ssh:// or git@host:owner/repo URL');
  return url;
}
// pull: clone the linked repository's branch tip and push it into the copy with a write credential (an Artifacts
// token, or for Smith's own copy a git ticket bound to the job). push: clone the copy's branch tip (an Artifacts read
// token; Smith's copy gets its ticket or local fast path at claim) and push it to the linked repository with the
// machine's own Git login (no token in the job). Every OS can run either.
export function syncSpecs(project: RepoProject, copy: CopyInfo, direction: SyncDirection, jobId: string, token: string, origin = ''): Record<string, ResolvedJobSpec> {
  const upstream = upstreamOf(copy, origin);
  const source = direction === 'pull' ? { url: upstream, authToken: '' } : { url: copy.remote, authToken: isArtifactsRemote(copy.remote) ? token : '' };
  const target = direction === 'pull' ? { remote: copy.remote, authToken: token } : { remote: upstream, authToken: '' };
  const specs: Record<string, ResolvedJobSpec> = {};
  for (const os of ['windows', 'linux', 'mac']) {
    specs[os] = { ...smokeSpec(jobId, os), kind: 'mirror', projectId: project.id, buildNumber: 0, timeoutSeconds: 3600,
      repos: [{ name: 'main', url: source.url, branch: project.branch, commit: '', checkoutDir: '.', authToken: source.authToken }],
      mirror: { ...target, branch: project.branch, pushTags: true } };
  }
  return specs;
}
// A short name for the linked host in messages: "GitHub", "GitLab", or the host itself.
export function hostName(url: string): string {
  const host = (/^(?:https:\/\/|ssh:\/\/(?:[^@/]+@)?|[^@]+@)([^/:]+)/.exec(url)?.[1] ?? '').toLowerCase();
  return host === 'github.com' ? 'GitHub' : host === 'gitlab.com' ? 'GitLab' : host === 'bitbucket.org' ? 'Bitbucket' : host || 'the linked repository';
}
// What a failed Pull or Push says on the card. The agent reports a refused (non-fast-forward) push
// with "not a fast-forward"; that becomes the one next step for this direction.
export function syncFailure(direction: SyncDirection, upstream: string, message: string, state: string): string {
  const host = hostName(upstream);
  if (/not a fast-forward/i.test(message))
    return direction === 'pull'
      ? `Smith’s copy has commits that ${host} does not. Push to ${host} first; nothing was overwritten.`
      : `${host} has commits that Smith’s copy does not. Pull from ${host} first; nothing was overwritten.`;
  return message || `${direction === 'pull' ? 'Pull' : 'Push'} ended as ${state}`;
}
