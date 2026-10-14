import { fail, fields, object, string } from './http';
import { smokeSpec, type CommandSpec, type ResolvedJobSpec } from './contracts';
import { isCredentialedRemote } from './remotes';
import { isArtifactsRemote } from './artifacts-repos';
import type { ProjectHosted } from './git-host';
import type { UpstreamSync } from './upstream';

interface Product {
  name: string; description: string; labels: string[]; commands: Record<string, CommandSpec[]>;
  workingDir: string; timeoutSeconds: number; env: Record<string, string>; artifacts: {globs: string[]; package: 'none'};
}
// Server-managed record of a project's copy into Cloudflare Artifacts (never caller-supplied).
// pushing: a mirror job is queued/running; verifying: the job finished and the branch head is
// being confirmed; done: builds now check out from `remote`; failed: `message` says why.
export interface ProjectArtifacts {
  repo: string; namespace: string; remote: string; status: 'pushing' | 'verifying' | 'done' | 'failed';
  accountId: string; source: 'workspace' | 'smith';   // which Cloudflare account holds the copy (fixed at copy time)
  sourceRepoUrl: string; jobId?: string; tokenId?: string; pushedCommit?: string; message?: string; updatedAt: number;
  // The repository it was linked to before Detach (upstream.ts), so the card can offer to link it again.
  detachedFrom?: string;
  sync?: UpstreamSync;   // the last Pull from / Push to the linked repository
  // Move to storage or Restore to storage under way (git-workspace.ts settleMoves): its mirror job and the commit it carries.
  move?: { jobId: string; tokenId?: string; commit: string; at: number; message?: string; product: 'move-to-storage' | 'restore-to-storage'; createdRepo?: boolean };
}
// The crew run that created a project (crew_create_project).
export interface CrewCreator { crewId: string; sessionId: string }
export interface Project {
  id: string; name: string; repoUrl: string; branch: string; commit: string; products: Product[]; artifacts?: ProjectArtifacts;
  hosted?: ProjectHosted;   // server-owned: the project's copies on Smith's own machines (src/git-host.ts), if any
  home?: 'artifacts' | 'machines';   // server-owned: where the project's git lives (home.ts); never accepted from a caller
  // Set only by the server when a crew member creates the project (never accepted from a caller, so absent from
  // validateProject's field list): its builds run secretless.
  createdBy?: CrewCreator; purpose?: string;
}
export const GITHUB_URL = /^(https:\/\/github\.com\/|git@github\.com:)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/;
function relativePath(value: string): string {
  if (value.includes('\\') || value.startsWith('/') || value.includes(':') || value.split('/').includes('..') || /[\x00-\x1f]/.test(value)) fail(400, 'invalid_path', 'Paths must stay inside the job checkout');
  return value;
}
export function strings(value: unknown, name: string, max = 64): string[] {
  if (!Array.isArray(value) || value.length > max || value.some(v => typeof v !== 'string' || v.length > 256 || /[\x00-\x1f]/.test(v))) fail(400, 'invalid_field', `Invalid ${name}`);
  return value as string[];
}
// origin: this coordinator's origin, so a project that builds from its Smith-hosted copy validates too.
export function validateProject(input: Record<string, unknown>, origin = ''): Project {
  fields(input, ['id', 'name', 'repoUrl', 'branch', 'commit', 'products']);
  const id = string(input, 'id', 64);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || id === 'smoke') fail(400, 'invalid_project', 'Invalid or reserved project ID');
  const repoUrl = string(input, 'repoUrl', 256);
  if (!GITHUB_URL.test(repoUrl) && !isCredentialedRemote(repoUrl, origin)) fail(400, 'invalid_repository', 'Use a GitHub HTTPS or SSH URL, without embedded credentials');
  const commit = string(input, 'commit', 40);
  if (!/^[a-f0-9]{40}$/.test(commit)) fail(400, 'invalid_commit', 'Pin a full Git commit SHA');
  const branch = string(input, 'branch', 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(branch) || branch.includes('..')) fail(400, 'invalid_branch', 'Invalid branch');
  if (!Array.isArray(input.products) || !input.products.length || input.products.length > 20) fail(400, 'invalid_products', 'Provide 1–20 products');
  const products = input.products.map((raw): Product => {
    const p = object(raw); fields(p, ['name', 'description', 'labels', 'commands', 'workingDir', 'timeoutSeconds', 'env', 'artifacts']);
    const name = string(p, 'name', 64);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) fail(400, 'invalid_product', 'Invalid product name');
    const commands: Record<string, CommandSpec[]> = {};
    const source = object(p.commands); fields(source, ['windows', 'linux', 'mac']);
    for (const [os, rawCommand] of Object.entries(source)) {
      const steps = Array.isArray(rawCommand) ? rawCommand : [rawCommand];
      if (!steps.length || steps.length > 10) fail(400, 'invalid_steps', 'Provide 1–10 commands per platform');
      commands[os] = steps.map(rawStep => {
        const s = object(rawStep); fields(s, ['interpreter', 'script', 'args']);
        const interpreter = string(s, 'interpreter', 10);
        if (!['ps1', 'bat', 'sh', 'python'].includes(interpreter)) fail(400, 'invalid_interpreter', 'Project commands must invoke a repository script');
        return { interpreter, script: relativePath(string(s, 'script', 256)), args: strings(s.args ?? [], 'args') };
      });
    }
    if (!Object.keys(commands).length) fail(400, 'invalid_commands', 'At least one platform command is required');
    const timeoutSeconds = p.timeoutSeconds ?? 1800;
    if (!Number.isInteger(timeoutSeconds) || Number(timeoutSeconds) < 1 || Number(timeoutSeconds) > 7200) fail(400, 'invalid_timeout', 'Timeout must be 1–7200 seconds');
    const variables = object(p.env ?? {}); const environment: Record<string, string> = {};
    if (Object.keys(variables).length > 32) fail(400, 'invalid_env', 'Too many environment entries');
    for (const [key, value] of Object.entries(variables)) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof value !== 'string' || value.length > 2048 || value.includes('\0')) fail(400, 'invalid_env', 'Invalid environment entry');
      environment[key] = value;
    }
    const output = p.artifacts === undefined ? { globs: [], package: 'none' } : object(p.artifacts);
    fields(output, ['globs', 'package']);
    if (output.package !== 'none') fail(400, 'invalid_artifacts', 'Package outputs in the build script; declare exact files with package=none');
    const artifacts = strings(output.globs, 'artifact paths', 4).map(relativePath);
    if (artifacts.some(path => path.split('/').some(part => part.endsWith('.') || /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(part)))) fail(400, 'invalid_artifacts', 'Artifact paths must use ordinary portable filenames');
    if (artifacts.some(path => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(path.split('/').at(-1)!))) fail(400, 'invalid_artifacts', 'Artifact basenames must start with a letter or digit and contain only letters, digits, dots, hyphens or underscores');
    if (artifacts.some(path => !/^[A-Za-z0-9_./-]+$/.test(path) || path.endsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) || new Set(artifacts.map(path => path.split('/').at(-1)!.toLowerCase())).size !== artifacts.length) fail(400, 'invalid_artifacts', 'Declare unique exact relative output filenames');
    return { name, description: typeof p.description === 'string' ? p.description.slice(0, 256) : '', labels: strings(p.labels ?? [], 'labels'), commands, artifacts: {globs: artifacts, package: 'none'},
      workingDir: relativePath(p.workingDir === undefined ? '.' : string(p, 'workingDir', 256)), timeoutSeconds: Number(timeoutSeconds), env: environment };
  });
  if (new Set(products.map(p => p.name)).size !== products.length) fail(400, 'duplicate_product', 'Product names must be unique');
  return { id, name: string(input, 'name', 128), repoUrl, commit, branch, products };
}
// readToken: an Artifacts read token when the project builds from an Artifacts remote (the agent
// only accepts a token for that host); GitHub sources keep using the machine's own credentials. A
// Smith-hosted remote gets its ticket at claim time instead (workspace.ts), so it carries '' here.
export function projectSpecs(project: Project, productName: string, jobId: string, buildNumber: number, readToken = '', origin = ''): { specs: Record<string, ResolvedJobSpec>; labels: string[] } {
  const product = project.products.find(p => p.name === productName);
  if (!product) fail(400, 'unknown_product', 'Project product not found');
  const specs: Record<string, ResolvedJobSpec> = {};
  for (const [os, commands] of Object.entries(product.commands)) {
    specs[os] = { ...smokeSpec(jobId, os), kind: 'build', projectId: project.id, buildNumber,
      repos: [{ name: 'main', url: project.repoUrl, branch: project.branch, commit: project.commit, checkoutDir: '.', authToken: isCredentialedRemote(project.repoUrl, origin) ? readToken : '' }],
      command: commands[0], steps: commands.length > 1 ? commands : [], workingDir: product.workingDir, env: product.env, timeoutSeconds: product.timeoutSeconds,
      artifacts: { globs: product.artifacts?.globs ?? [], exclude: [], excludeDefaults: true, package: 'none', archiveName: '' } };
  }
  return { specs, labels: product.labels };
}
// A mirror job for every OS: any connected machine clones the source with its own credentials
// and pushes the pinned commit (as the project branch) plus tags to the Artifacts remote.
export function mirrorSpecs(project: { id: string; repoUrl: string; branch: string; commit: string }, jobId: string, remote: string, writeToken: string): Record<string, ResolvedJobSpec> {
  const specs: Record<string, ResolvedJobSpec> = {};
  for (const os of ['windows', 'linux', 'mac']) {
    specs[os] = { ...smokeSpec(jobId, os), kind: 'mirror', projectId: project.id, buildNumber: 0, timeoutSeconds: 3600,
      repos: [{ name: 'main', url: project.repoUrl, branch: project.branch, commit: project.commit, checkoutDir: '.', authToken: '' }],
      mirror: { remote, authToken: writeToken, branch: project.branch, pushTags: true } };
  }
  return specs;
}
