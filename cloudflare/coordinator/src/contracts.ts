// Mirrors every field in Modules/SmithProtocol/WireTypes.h::JobSpec.
export interface CommandSpec { interpreter: string; script: string; args: string[] }
export type JobKind = 'build' | 'mirror' | 'scan' | 'checkin' | 'host' | 'diff' | 'merge' | 'publish' | 'import';
// A host job: the machine that claims it clones the source into a bare mirror it will keep serving
// (Smith-hosted repositories, src/git-host.ts). `repoUuid` names the store; `defaultBranch` is what HEAD
// should point at when the source has no usable HEAD.
// `init`, for a project started in Smith: the machine creates the repository (a README, or an uploaded zip) instead of copying one.
export interface HostSpec { repoUuid: string; defaultBranch: string; maxBytes: number; init?: { kind: 'empty' | 'zip'; name: string; archiveName: string; archiveSize: number } }
// A build of a repository project's branch tip: after checkout the agent posts a ScanReport to
// /resolve and receives the command smith.json defines for `action` at that commit.
export interface ResolveSpec { action: string }
// What a machine (or the GitHub reader) found in a repository at one commit.
export interface ScanReport { commit: string; branch: string; smithJson: string | null; paths: string[]; truncated: boolean }
// A mirror job's push target: the source repo's pinned commit (as `branch`) and tags are
// copied into a Cloudflare Artifacts repository by a native agent (the Worker has no git).
export interface MirrorSpec { remote: string; authToken: string; branch: string; pushTags: boolean; allRefs?: boolean }   // allRefs: every branch and tag (Move to storage)
// Large files (Git LFS): the Smith remote whose /info/lfs endpoint holds the project's objects and a read ticket for
// it, set at claim for builds of projects that keep any. The agent turns it into git config (lfs.url + extraheader).
export interface LfsSpec { url: string; authToken: string }
// A Smith pull request's job (src/pulls.ts): the branch it merges into, a merge's commit message and author, a publish's target.
export interface PullSpec { baseBranch?: string; message?: string; authorName?: string; authorEmail?: string; targetRemote?: string; targetBranch?: string }
// What a pull job reports beyond a build: the base it compared with or merged into, and (a diff) whether it merges cleanly.
export interface PullResult { baseCommit?: string; mergeBase?: string | null; mergeable?: boolean | null; conflicts?: string[]; truncated?: boolean }
// An import job (src/imports.ts): mirror-clone `source` with the machine's own login, move blobs over `thresholdBytes`
// to LFS (bundling the original history to the job blob `originalBlob` first), push the objects to `smithRemote`'s LFS
// (the ticket rides in `lfs`) and the mirror to `artifactsRemote` with `artifactsToken`. Over `maxRepoBytes` after the
// rewrite: the job reports failure 'oversize' and the coordinator hosts the repository on a machine instead.
export interface ImportSpec { source: string; artifactsRemote: string; artifactsToken: string; smithRemote: string; thresholdBytes: number; maxRepoBytes: number; originalBlob: string }
// What an import job reports: the scan of the rewritten (or untouched) default branch, what moved, what it pushed.
export interface ImportReport { commit: string; branch: string; scan: ScanReport; rewritten: boolean; movedFiles: number; movedBytes: number; lfsObjects: number; lfsBytes: number; originalBundle?: { size: number; sha256: string } }
export interface ResolvedJobSpec {
  jobId: string; kind: JobKind; projectId: string; buildNumber: number;
  // hostedUuid/tip: set at claim when this machine itself keeps a current copy of a Smith-hosted repository,
  // so it clones from its own store (verifying the expected tip) instead of relaying to itself.
  repos: { name: string; url: string; branch: string; commit: string; checkoutDir: string; authToken: string; hostedUuid?: string; tip?: string }[];
  command: CommandSpec; steps: CommandSpec[]; workingDir: string; env: Record<string, string>;
  timeoutSeconds: number; successExitCodes: number[];
  artifacts: { globs: string[]; exclude: string[]; excludeDefaults: boolean; package: string; archiveName: string };
  handoff: { name: string; type: string; fields: Record<string, string>; continueOnError: boolean }[];
  inputs: { jobId: string; archiveName: string; product: string; variant: string; buildNumber: number; commit: string }[];
  clean: boolean;
  checkIn?: {eventId:string;baseCommit:string;headCommit:string};
  mirror?: MirrorSpec;
  resolve?: ResolveSpec;
  host?: HostSpec;
  lfs?: LfsSpec;
  pull?: PullSpec;
  import?: ImportSpec;
}
export type JobState = 'queued' | 'leased' | 'running' | 'success' | 'failed' | 'error' | 'cancelled' | 'lost';
// ticket: a coordinator-minted git credential (smith_git_…) presented on /git/*, with the node credential of the
// machine presenting it when the ticket is bound to one.
// hook: a GitHub webhook delivery; the project's hook secret, checked inside the Durable Object, is its credential.
export type Principal = { kind: 'human'; userId: string } | { kind: 'node'; token: string } | { kind: 'enrollment' } | { kind: 'token'; token: string }
  | { kind: 'ticket'; token: string; nodeToken: string | null } | { kind: 'hook' };
export interface AttemptRef { jobId: string; attemptId: string; leaseToken: string }
export interface Lease extends AttemptRef { leaseExpiresAt: number; nodeId: string }
export type HostedAssignment = { hasJob: false } | { hasJob: true; envelope: { protocolVersion: 2; workspaceId: string; lease: Lease; spec: ResolvedJobSpec } };
// commit: what a branch-tip build or scan checked out. failure "repo_access": this machine's Git
// login cannot read the repository, so the job goes back to the queue for another machine.
// host: what a host job's machine now holds (its refs as [sha, ref] pairs, the HEAD branch and the store size).
export interface JobResult { checkIn?: Record<string,unknown>; status: 'success' | 'failed' | 'error'; exitCode: number; durationMs: number; message: string; commit?: string; failure?: 'repo_access' | 'oversize'; import?: ImportReport; host?: { tips: [string, string][]; defaultBranch: string; bytes: number }; pull?: PullResult }
export function smokeSpec(jobId: string, os: string): ResolvedJobSpec {
  return {
    jobId, kind: 'build', projectId: 'smoke', buildNumber: 1, repos: [],
    command: os === 'windows'
      ? { interpreter: 'exe', script: 'cmd.exe', args: ['/d', '/c', 'echo Smith Cloudflare smoke'] }
      : { interpreter: 'exe', script: '/bin/echo', args: ['Smith Cloudflare smoke'] },
    steps: [], workingDir: '.', env: {}, timeoutSeconds: 30, successExitCodes: [0],
    artifacts: { globs: [], exclude: [], excludeDefaults: true, package: 'none', archiveName: '' },
    handoff: [], inputs: [], clean: false,
  };
}
