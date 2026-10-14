// Projects added from a Git URL ("repository projects"). Smith reads the repository's smith.json
// (src/pipeline.ts) and builds the branch tip; the workspace Durable Object stores them beside
// operator-prepared projects (src/projects.ts). Pure helpers, plus RepoAccess for the SQL that
// keeps work away from machines that cannot read a repository.
import { fail, fields, object, string } from './http';
import { smokeSpec, type ResolvedJobSpec, type ScanReport } from './contracts';
import { PipelineError, mapPipeline, resolveAction, slugifyName, type PipelineAction } from './pipeline';
import { isCredentialedRemote } from './remotes';
import { isArtifactsRemote } from './artifacts-repos';
import type { CrewCreator, Project, ProjectArtifacts } from './projects';
import { publicPushHook, type PushHook } from './push-builds';
import type { ProjectHosted } from './git-host';
import { DETECTS, detectBuild, type DetectedKind } from './detect';

export const REPO_LABEL = 'smith-repo-projects';        // only agents that can scan and resolve advertise it
export const ACCESS_TTL_MS = 60 * 60 * 1000;            // a "no access" mark expires after an hour
export const SCAN_PRODUCT = 'read-smith-json';
export const REPO_ACCESS_SCHEMA = 'CREATE TABLE IF NOT EXISTS repo_access (project_id TEXT NOT NULL, node_id TEXT NOT NULL, message TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (project_id, node_id))';
// Claim filter: skip a queued job whose project this node recently could not read. Parameters: node ID, cutoff time.
export const ACCESS_FILTER = 'AND NOT EXISTS (SELECT 1 FROM repo_access a WHERE a.project_id = jobs.project_id AND a.node_id = ? AND a.at > ?)';

export interface ScanState { state: 'waiting' | 'scanning' | 'ready' | 'error'; message: string; via: 'github' | 'machine' | 'smith' | null; host: string | null; jobId: string | null; at: number }
export interface RepoProject {
  // source: 'git' when added from a Git URL; 'smith' when started in Smith (empty or from a zip), so Smith's copies are the repository.
  kind: 'repo'; id: string; name: string; customName: boolean; repoUrl: string; source: 'git' | 'smith'; branch: string; commit: string | null;
  scan: ScanState; actions: PipelineAction[]; unusedRules: number; disabledRules: number; warnings: string[]; createdAt: number;
  onPush?: string[];      // the actions smith.json's webhook triggers build on a push to the branch (push-builds.ts); absent before the project was re-read
  pushChoice?: string[];  // the actions someone ticked on the card to build on a push, which replaces smith.json's triggers (absent: smith.json decides)
  // A new build replaces this project's still-queued build of the same action on the same branch (ticked on the card);
  // absent: the workspace's "New build replaces a queued build" setting decides.
  replaceQueued?: boolean;
  push?: PushHook;        // server-owned: the GitHub push hook, once Build on push was turned on
  // A person's user ID for a project added from a Git URL (whose GitHub link is tried first when Smith reads it), or the
  // crew run that created it (crew-projects.ts: its builds run secretless, and it carries the member's purpose).
  createdBy?: string | CrewCreator; purpose?: string;
  artifacts?: ProjectArtifacts;   // server-owned: the project's copy into Cloudflare Artifacts, if any
  hosted?: ProjectHosted;         // server-owned: the project's copies on Smith's own machines, if any
  home?: 'artifacts' | 'machines';   // server-owned: where the project's git lives (home.ts); never accepted from a caller
  // The repository has no smith.json, so its actions come from the default Smith detected (detect.ts); absent when it has one.
  detected?: { kind: DetectedKind; summary: string; smithJson: string };
}
export interface AccessDenial { host: string; message: string; at: number }
export function isRepoProject(value: unknown): value is RepoProject { return (value as { kind?: unknown } | null | undefined)?.kind === 'repo'; }
// Whether a project can build `product`: a prepared project's product by name, or one of a Git-URL project's smith.json
// build actions that can run here. Chat push and Verify, a crew member's verifyProduct and crew Verify all ask this.
export function offersProduct(project: Project | RepoProject | undefined, product: string): boolean {
  return isRepoProject(project) ? project.actions.some(item => item.id === product && item.available) : Boolean(project?.products.some(p => p.name === product));
}

// How the project builds, for a chat's briefing and a crew run's prompt, when that needs saying: no smith.json (a detected
// default, or nothing Smith can build), a smith.json Smith could not read, or Smith's notes on it. '' when all is well.
export function pipelineBriefing(project: Project | RepoProject | undefined): string {
  if (!isRepoProject(project)) return '';
  if (project.detected) return `This repository has no smith.json. Smith builds it with a default it detected from the files: ${project.detected.summary}. A smith.json at the repository root replaces that default; one is needed for anything more (tests, other platforms, the files a build should keep).`;
  if (project.scan.state === 'error') return `Smith cannot build this project yet: ${project.scan.message}`;
  const unavailable = project.actions.filter(action => !action.available).map(action => `${action.id} (${action.notes.join(' ') || 'cannot run here'})`);
  const notes = [...project.warnings, ...(unavailable.length ? [`Build actions that cannot run: ${unavailable.slice(0, 4).join('; ')}.`] : [])];
  return notes.length ? `Smith's notes on this project's smith.json: ${notes.slice(0, 5).join(' ')}` : '';
}

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/;
const COMMIT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
export function validBranch(branch: string): boolean { return branch === '' || (branch.length <= 256 && BRANCH.test(branch) && !branch.includes('..')); }

// HTTPS, ssh:// or scp-style user@host:path - never a password, whitespace or control character.
export function validateRepoUrl(value: string): string {
  const url = value.trim();
  const ok = url.length <= 256 && !/[\s\x00-\x1f\x7f\\]/.test(url) && (
    /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[^@]+$/.test(url) ||
    /^ssh:\/\/(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+(?::\d+)?\/[^@]+$/.test(url) ||
    /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^/@][^@]*$/.test(url));
  if (!ok) fail(400, 'invalid_repository', 'Use an https://, ssh:// or git@host:owner/repo URL without a password');
  return url;
}
export function repoName(url: string): string { return (url.replace(/\/+$/, '').split(/[/:]/).at(-1) ?? '').replace(/\.git$/i, '') || 'project'; }
export function newProjectId(url: string, taken: ReadonlySet<string>): string {
  const slug = slugifyName(repoName(url)).slice(0, 56);
  const base = slug === 'smoke' ? 'smoke-repo' : slug;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}
export function createRepoProject(body: Record<string, unknown>, taken: ReadonlySet<string>, now: number, createdBy?: string): RepoProject {
  fields(body, ['source', 'url', 'branch', 'name']);
  if (body.source !== 'git') fail(400, 'invalid_source', 'Unsupported project source');
  const repoUrl = validateRepoUrl(string(body, 'url', 256));
  if (body.branch !== undefined && typeof body.branch !== 'string') fail(400, 'invalid_field', 'Invalid field: branch');
  const branch = typeof body.branch === 'string' ? body.branch.trim() : '';
  if (!validBranch(branch)) fail(400, 'invalid_branch', 'Invalid branch name');
  const customName = typeof body.name === 'string' && body.name.trim() !== '';
  const name = customName ? string(body, 'name', 128).trim() : repoName(repoUrl);
  return { kind: 'repo', id: newProjectId(repoUrl, taken), name, customName, repoUrl, source: 'git', branch, commit: null,
    scan: { state: 'waiting', message: '', via: null, host: null, jobId: null, at: now }, actions: [], unusedRules: 0, disabledRules: 0, warnings: [], createdAt: now, ...(createdBy ? { createdBy } : {}) };
}
// A project started in Smith: no repository to read yet. Its repoUrl is Smith's own remote, which exists once the host
// job (git-workspace.ts) has created the repository; the scan is queued then.
export function createSmithProject(body: Record<string, unknown>, taken: ReadonlySet<string>, now: number, remote: (id: string) => string, createdBy?: string): RepoProject {
  const name = string(body, 'name', 128).trim();
  if (!name || /[\x00-\x1f]/.test(name)) fail(400, 'invalid_field', 'Give the project a name');
  if (body.branch !== undefined && typeof body.branch !== 'string') fail(400, 'invalid_field', 'Invalid field: branch');
  const branch = typeof body.branch === 'string' && body.branch.trim() ? body.branch.trim() : 'main';
  if (!validBranch(branch)) fail(400, 'invalid_branch', 'Invalid branch name');
  const id = newProjectId(name, taken);
  return { kind: 'repo', id, name, customName: true, repoUrl: remote(id), source: 'smith', branch, commit: null,
    scan: { state: 'waiting', message: 'Smith is creating the repository.', via: null, host: null, jobId: null, at: now }, actions: [], unusedRules: 0, disabledRules: 0, warnings: [], createdAt: now, ...(createdBy ? { createdBy } : {}) };
}
// Apply what a reader found. A blank branch becomes the one the reader used (the repo's default).
export function applyReport(project: RepoProject, report: ScanReport, via: 'github' | 'machine' | 'smith', host: string | null, now: number): RepoProject {
  const branch = project.branch || report.branch;
  const { detected: _previous, ...rest } = project;
  const detected = report.smithJson === null ? detectBuild(report.paths, project.id, project.name) : null;
  const base: RepoProject = { ...rest, branch, commit: report.commit, scan: { ...project.scan, via, host, at: now }, ...(detected ? { detected } : {}) };
  const failed = (message: string): RepoProject => ({ ...base, actions: [], onPush: [], unusedRules: 0, disabledRules: 0, warnings: [], scan: { ...base.scan, state: 'error', message } });
  const text = report.smithJson ?? detected?.smithJson ?? null;
  if (text === null) return failed(`No smith.json ${project.source === 'smith' ? '' : `at ${report.commit.slice(0, 12)} `}on ${branch}, and nothing Smith builds without one (${DETECTS})${report.truncated ? '; the file list was cut short, so Smith may have missed it' : ''}. To build it, add a smith.json and push (or add a Pipeline setup crew member to write one): Smith reads the project again after every push.`);
  try {
    const pipeline = mapPipeline(text, report.paths, branch, report.truncated);
    return { ...base, name: project.customName ? project.name : pipeline.name, actions: pipeline.actions, onPush: pipeline.onPush, unusedRules: pipeline.unusedRules,
      disabledRules: pipeline.disabledRules, warnings: pipeline.warnings, scan: { ...base.scan, state: 'ready', message: '' } };
  } catch (error) {
    if (error instanceof PipelineError) return failed(error.message);
    throw error;
  }
}
// readToken: the Artifacts read token a machine needs once the project builds from its Artifacts copy
// (a Smith-hosted copy gets its ticket at claim time, so '' here).
const repo = (project: RepoProject, readToken = '', origin = '') => ({ name: 'main', url: project.repoUrl, branch: project.branch, commit: '', checkoutDir: '.', authToken: isCredentialedRemote(project.repoUrl, origin) ? readToken : '' });
const NO_COMMAND = { interpreter: '', script: '', args: [] as string[] };
// A scan for every OS: any updated agent may read the repository with its own Git login.
export function scanSpecs(project: RepoProject, jobId: string, readToken = '', origin = ''): Record<string, ResolvedJobSpec> {
  const specs: Record<string, ResolvedJobSpec> = {};
  for (const os of ['windows', 'linux', 'mac']) specs[os] = { ...smokeSpec(jobId, os), kind: 'scan', projectId: project.id, buildNumber: 0, timeoutSeconds: 600, command: NO_COMMAND, repos: [repo(project, readToken, origin)] };
  return specs;
}
// A branch-tip build for the action's platforms; the command arrives at /resolve after checkout.
// serial: the rule asks for one build of the product at a time (pipeline.ts); the claim query honours it.
export function repoBuildSpecs(project: RepoProject, actionId: string, jobId: string, buildNumber: number, readToken = '', origin = ''): { specs: Record<string, ResolvedJobSpec>; labels: string[]; serial: boolean } {
  const action = project.actions.find(item => item.id === actionId);
  if (!action) fail(400, 'unknown_product', project.scan.state === 'ready' ? 'That build action is not in this project' : "This project's build actions are not known yet");
  if (!action.available) fail(409, 'action_unavailable', action.notes.join(' ') || 'This build action cannot run here');
  const specs: Record<string, ResolvedJobSpec> = {};
  for (const os of action.os) specs[os] = { ...smokeSpec(jobId, os), kind: 'build', projectId: project.id, buildNumber, timeoutSeconds: 0, command: NO_COMMAND, repos: [repo(project, readToken, origin)], resolve: { action: action.id } };
  return { specs, labels: [...action.labels, REPO_LABEL], serial: action.serial === true };
}
// The stored spec, completed with what smith.json defines at the checked-out commit.
export function resolveBuildSpec(spec: ResolvedJobSpec, report: ScanReport, branch: string, os: string): ResolvedJobSpec {
  if (!spec.resolve) throw new PipelineError('This build has nothing to resolve');
  // Without a smith.json, the default detected from this commit's files (as applyReport offered it).
  const text = report.smithJson ?? detectBuild(report.paths, spec.projectId)?.smithJson ?? null;
  if (text === null) throw new PipelineError(`No smith.json at ${report.commit.slice(0, 12)} on ${branch}, and nothing Smith builds without one (${DETECTS})`);
  const build = resolveAction(text, report.paths, spec.resolve.action, os, { branch, commit: report.commit, buildNumber: spec.buildNumber });
  const { resolve: _resolved, ...rest } = spec;
  return { ...rest, repos: [{ ...spec.repos[0], branch, commit: report.commit }], command: build.command, steps: build.steps, workingDir: build.workingDir, env: build.env,
    timeoutSeconds: build.timeoutSeconds, successExitCodes: build.successExitCodes, artifacts: { globs: build.artifacts, exclude: [], excludeDefaults: true, package: 'none', archiveName: '' } };
}
export function validateScanReport(value: unknown): ScanReport {
  const report = object(value); fields(report, ['commit', 'branch', 'smithJson', 'paths', 'truncated']);
  const invalid = (message = 'Invalid scan report'): never => fail(400, 'invalid_report', message);
  if (typeof report.commit !== 'string' || !COMMIT.test(report.commit) || typeof report.branch !== 'string') invalid();
  if (!validBranch(report.branch as string)) invalid(`Branch "${(report.branch as string).slice(0, 100)}" is not supported (use letters, digits, dot, dash, underscore and slash)`);
  if (report.smithJson !== null && (typeof report.smithJson !== 'string' || report.smithJson.length > 262144)) invalid('smith.json must be text of at most 256 KiB');
  if (!Array.isArray(report.paths) || report.paths.length > 20000 || report.paths.some(path => typeof path !== 'string' || path.length > 1024 || /[\x00-\x1f]/.test(path))) invalid('Invalid repository file list');
  if (typeof report.truncated !== 'boolean') invalid();
  return { commit: report.commit as string, branch: report.branch as string, smithJson: report.smithJson as string | null, paths: report.paths as string[], truncated: report.truncated as boolean };
}
// What the dashboard sees: while the project waits on a scan job, the job's state says why.
export function publicRepoProject(project: RepoProject, scanJob: { state: string; nodeHost: string | null; message: string; waiting?: string } | null, denials: AccessDenial[]) {
  let scan = project.scan;
  if (scanJob && scan.state === 'waiting') {
    if (scanJob.state === 'queued') scan = { ...scan, message: [scan.message, denials.length ? 'Waiting for a machine that can read this repository.' : 'Waiting for a machine to read smith.json.', scanJob.waiting ? `(${scanJob.waiting})` : ''].filter(Boolean).join(' ') };
    else if (scanJob.state === 'leased' || scanJob.state === 'running') scan = { ...scan, state: 'scanning', host: scanJob.nodeHost, message: `Reading smith.json on ${scanJob.nodeHost ?? 'a machine'}.` };
    else scan = { ...scan, state: 'error', message: scanJob.message || `Reading smith.json ended as ${scanJob.state}. Use Rescan to try again.` };
    if (scan.state === 'error' && !scan.message.includes('Rescan')) scan = { ...scan, message: `${scan.message} Use Rescan to try again.` };
  }
  // The hook's secret stays inside the Durable Object.
  const { push, ...rest } = project;
  return { ...rest, onPush: pushActions(project), onPushDefault: project.onPush ?? [], pushChosen: Boolean(project.pushChoice), push: publicPushHook(push), scan, access: denials };
}
// What a push builds: the actions ticked on the card when someone chose, else smith.json's webhook triggers. A ticked action
// that smith.json no longer has, or that cannot run here, is left out.
export function pushActions(project: RepoProject): string[] {
  if (!project.pushChoice) return project.onPush ?? [];
  const usable = new Set((project.actions ?? []).filter(a => a.available).map(a => a.id));
  return project.pushChoice.filter(id => usable.has(id));
}
export class RepoAccess {
  constructor(private readonly sql: SqlStorage) {}
  deny(projectId: string, nodeId: string, message: string, now: number): void {
    this.sql.exec('INSERT INTO repo_access VALUES (?, ?, ?, ?) ON CONFLICT(project_id, node_id) DO UPDATE SET message = excluded.message, at = excluded.at', projectId, nodeId, message.slice(0, 300), now);
  }
  clear(projectId: string): void { this.sql.exec('DELETE FROM repo_access WHERE project_id = ?', projectId); }
  denials(projectId: string, now: number): AccessDenial[] {
    return this.sql.exec<{ hostname: string | null; node_id: string; message: string; at: number }>('SELECT n.hostname AS hostname, a.node_id AS node_id, a.message AS message, a.at AS at FROM repo_access a LEFT JOIN nodes n ON n.id = a.node_id WHERE a.project_id = ? AND a.at > ? ORDER BY a.at DESC', projectId, now - ACCESS_TTL_MS)
      .toArray().map(row => ({ host: row.hostname || row.node_id.slice(0, 8), message: row.message, at: row.at }));
  }
}
