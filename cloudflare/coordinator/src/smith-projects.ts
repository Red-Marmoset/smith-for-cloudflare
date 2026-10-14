// Projects started in Smith on Cloudflare Artifacts, with no machine needed: the coordinator makes the first commit
// itself (first-commit.ts) and pushes it to a new Artifacts repository (git-pack.ts). git-workspace.ts records the
// project, copies it onto machines that keep copies once one is online, and mirrors later pushes back to Artifacts.
import { fail, HttpError } from './http';
import { repoNameFor, WRITE_TOKEN_TTL, type ArtifactsClient } from './artifacts-repos';
import type { ProjectArtifacts } from './projects';
import type { ScanReport } from './contracts';
import { prepareFirstCommit, TooBigError, type FirstCommit } from './first-commit';
import { pushNewBranch, PushError } from './git-pack';
import { ZipError, type RangeRead } from './zip-read';

export const DUPE_TOKEN_TTL = 7 * 86400;            // a copy onto a machine may wait in the queue for a while
export const BACKUP_RETRY_MS = 10 * 60000;           // a failed mirror back to Artifacts is tried again after this
export const CLONE_TOKEN_TTL = 90 * 86400;           // what a person's git credential for an Artifacts-only project lasts

// Reads of an uploaded zip in R2 through an 8 MiB window, so walking a zip's entries in order costs one read per window
// rather than two per file (a Worker's subrequests are limited; entries larger than the window are read on their own).
export function windowedR2(bucket: R2Bucket, key: string, size: number, window = 8 * 1024 * 1024): RangeRead {
  let start = 0; let buffer: Uint8Array | null = null;
  const raw = async (offset: number, length: number) => {
    const object = await bucket.get(key, { range: { offset, length } });
    if (!object) throw new ZipError('The uploaded zip is no longer stored; upload it again');
    return new Uint8Array(await object.arrayBuffer());
  };
  return async (offset, length) => {
    if (buffer && offset >= start && offset + length <= start + buffer.length) return buffer.subarray(offset - start, offset - start + length);
    if (length > window) return raw(offset, length);
    buffer = await raw(offset, Math.min(window, size - offset)); start = offset;
    return buffer.subarray(0, length);
  };
}

export interface ArtifactsStart { record: ProjectArtifacts; first: FirstCommit }
// Creates the Artifacts repository for project `id` and pushes its first commit. A bad zip (ZipError) or one too big for
// Artifacts (TooBigError) fails before anything is created; a failed push removes the repository again.
export async function startOnArtifacts(client: ArtifactsClient, account: { accountId: string; source: 'workspace' | 'smith' }, workspaceId: string,
  project: { id: string; name: string; branch: string }, kind: 'empty' | 'zip', zip: { read: RangeRead; size: number; fileName: string } | undefined, now: number): Promise<ArtifactsStart> {
  const first = await prepareFirstCommit({ kind, name: project.name, archiveName: zip?.fileName, read: zip?.read, size: zip?.size, now: new Date(now) });
  const name = repoNameFor(workspaceId, project.id);
  const existing = await client.getRepo(name);
  if (existing && await client.branchHead(name, project.branch)) fail(409, 'artifacts_exists', `Cloudflare Artifacts already holds a repository named ${name}. Give the project another name`);
  const repo = existing ?? await client.createRepo(name, project.branch, `Smith project ${project.name} (${project.id})`);
  const token = await client.issueToken(name, 'write', WRITE_TOKEN_TTL);
  try {
    await pushNewBranch(repo.remote, token.plaintext.split('?expires=')[0], `refs/heads/${project.branch}`, first.commit, first.pack(), client.gitFetch);
  } catch (error) {
    await client.deleteRepo(name).catch(() => console.error(JSON.stringify({ event: 'artifacts_cleanup_failed' })));
    if (error instanceof PushError) fail(502, 'artifacts_push_failed', `Cloudflare Artifacts did not take the first commit: ${error.message}`);
    throw error;
  } finally {
    await client.revokeToken(name, token.id).catch(() => console.error(JSON.stringify({ event: 'artifacts_token_revoke_failed' })));
  }
  if (await client.branchHead(name, project.branch) !== first.commit) {
    await client.deleteRepo(name).catch(() => {});
    fail(502, 'artifacts_push_failed', 'Cloudflare Artifacts did not show the first commit after the push; try again');
  }
  return { first, record: { repo: name, namespace: client.namespace, remote: repo.remote, status: 'done', accountId: account.accountId, source: account.source,
    sourceRepoUrl: repo.remote, pushedCommit: first.commit, updatedAt: now } };
}
// What Smith read while making the first commit, in the shape a machine's scan reports it.
export function firstCommitReport(first: FirstCommit, branch: string): ScanReport {
  return { commit: first.commit, branch, smithJson: first.smithJson, paths: first.paths.slice(0, 20000), truncated: first.paths.length > 20000 };
}
// Whether a failure on Artifacts should send the project to a machine instead (when one can take it).
export function machineCanTakeOver(error: unknown): boolean {
  return error instanceof TooBigError || (error instanceof HttpError && error.status >= 500);
}
// A failure the person can act on, as an HTTP error.
export function startFailure(error: unknown): never {
  if (error instanceof ZipError) fail(400, 'invalid_zip', error.message);
  if (error instanceof TooBigError) fail(413, 'too_big', `${error.message}. Turn on “Keep copies of repositories here” on a build machine to keep a project this size in Smith`);
  throw error;
}
