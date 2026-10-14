// Where a project's git lives (spec §1): on Cloudflare Artifacts behind Smith's URL, or on the workspace's own machines.
// Artifacts whenever the workspace can use it and the repository fits; machines only otherwise, or by an owner's choice.
import { MAX_REPO_BYTES, smithRemote, smithRemoteRepo } from './git-host';
import { isArtifactsRemote } from './artifacts-repos';
import type { Project } from './projects';
import type { RepoProject } from './repo-projects';

export type Home = 'artifacts' | 'machines';
export function homeOf(project: Project | RepoProject | undefined): Home | undefined { return project?.home; }
export function fitsArtifacts(bytes: number): boolean { return bytes <= MAX_REPO_BYTES; }
// The upgrade pass (one alarm after deploy): the home a legacy project gets, with the repoUrl it should have, or null when
// nothing changes. Both copies present keeps the machines (Move to storage is offered on the card); only an Artifacts
// copy becomes an Artifacts home behind Smith's URL; only a machine copy becomes a machines home.
export function assignHome(project: Project | RepoProject, origin: string): { home: Home; repoUrl: string } | null {
  if (project.home) return null;
  const onMachines = project.hosted?.status === 'ready' && smithRemoteRepo(project.repoUrl, origin) === project.id;
  if (onMachines) return { home: 'machines', repoUrl: project.repoUrl };
  const copy = project.artifacts;
  if (copy?.status === 'done' && (project.repoUrl === copy.remote || isArtifactsRemote(project.repoUrl))) return { home: 'artifacts', repoUrl: smithRemote(origin, project.id) };
  return null;
}
