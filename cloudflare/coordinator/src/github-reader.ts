// The GitHub fast path: with the workspace's GitHub token, read smith.json and the file list
// through the GitHub API, so adding a GitHub project needs no machine. Any failure falls back to
// a machine scan. The token is used only here; tests use the in-memory fake (GITHUB_MODE=fake).
import type { ScanReport } from './contracts';

export class GitHubReadError extends Error {}
const API = 'https://api.github.com';
const MAX_PATHS = 20000;

export function githubRepo(url: string): { owner: string; repo: string } | null {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url);
  return match ? { owner: match[1], repo: match[2] } : null;
}
export async function readGitHub(url: string, branch: string, token: string, timeoutMs = 5000): Promise<ScanReport> {
  const target = githubRepo(url);
  if (!target) throw new GitHubReadError('Not a GitHub repository URL');
  const signal = AbortSignal.timeout(timeoutMs);
  const base = `${API}/repos/${target.owner}/${target.repo}`;
  // redirect: 'manual' because the Workers runtime rejects 'error'; a 3xx is then simply not ok.
  const get = (path: string, accept: string) => fetch(base + path, { redirect: 'manual', signal,
    headers: { Authorization: `Bearer ${token}`, Accept: accept, 'User-Agent': 'smith-coordinator', 'X-GitHub-Api-Version': '2022-11-28' } });
  let name = branch;
  if (!name) {
    const repo = await get('', 'application/vnd.github+json');
    if (!repo.ok) throw new GitHubReadError(`GitHub answered ${repo.status} for the repository`);
    name = String(((await repo.json()) as { default_branch?: unknown }).default_branch ?? '');
    if (!name) throw new GitHubReadError('GitHub did not name a default branch');
  }
  const head = await get(`/commits/${name.split('/').map(encodeURIComponent).join('/')}`, 'application/vnd.github.sha');
  if (!head.ok) throw new GitHubReadError(`GitHub answered ${head.status} for branch ${name}`);
  const commit = (await head.text()).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new GitHubReadError('GitHub returned an unexpected commit');
  const tree = await get(`/git/trees/${commit}?recursive=1`, 'application/vnd.github+json');
  if (!tree.ok) throw new GitHubReadError(`GitHub answered ${tree.status} for the file list`);
  const listing = await tree.json() as { tree?: { path?: unknown; type?: unknown }[]; truncated?: unknown };
  const paths = (listing.tree ?? []).filter(entry => entry.type === 'blob' && typeof entry.path === 'string').map(entry => entry.path as string);
  // Ask for smith.json directly: a large repository's tree listing is cut short, often before the
  // root smith.json (it sorts after "Assets/..."), so its absence from `paths` proves nothing.
  let smithJson: string | null = null;
  const file = await get(`/contents/smith.json?ref=${commit}`, 'application/vnd.github.raw+json');
  if (file.ok) {
    smithJson = await file.text();
    if (smithJson.length > 262144) throw new GitHubReadError('smith.json is larger than 256 KiB');
  } else if (file.status !== 404) throw new GitHubReadError(`GitHub answered ${file.status} for smith.json`);
  return { commit, branch: name, smithJson, paths: paths.slice(0, MAX_PATHS), truncated: listing.truncated === true || paths.length > MAX_PATHS };
}

// ---- Repository picker: what the workspace's token can see, so nobody types a URL ----
export interface GitHubRepoChoice { fullName: string; url: string; defaultBranch: string; private: boolean; pushedAt: string; description: string; archived: boolean; sizeKb: number }
// `installed`: the token reached at least one GitHub App installation (false means the person
// signed in but the App is not installed anywhere they can see, or this is an OAuth App token).
export interface GitHubRepoListing { repos: GitHubRepoChoice[]; installed: boolean }
const headersFor = (token: string) => ({ Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'smith-coordinator', 'X-GitHub-Api-Version': '2022-11-28' });
type RepoRow = { full_name?: unknown; clone_url?: unknown; ssh_url?: unknown; default_branch?: unknown; private?: unknown; pushed_at?: unknown; description?: unknown; archived?: unknown; size?: unknown };
// Private repositories get their SSH URL (what build machines clone with their own keys); public
// ones the HTTPS URL. Either works for the GitHub fast path.
function choice(row: RepoRow): GitHubRepoChoice | null {
  if (typeof row.full_name !== 'string' || typeof row.clone_url !== 'string' || typeof row.ssh_url !== 'string') return null;
  return { fullName: row.full_name, url: row.private === true ? row.ssh_url : row.clone_url, defaultBranch: String(row.default_branch ?? 'main'), private: row.private === true, pushedAt: String(row.pushed_at ?? ''), description: typeof row.description === 'string' ? row.description.slice(0, 200) : '', archived: row.archived === true, sizeKb: typeof row.size === 'number' ? row.size : 0 };
}
async function pages<T>(url: string, token: string, signal: AbortSignal, what: string, pick: (body: unknown) => T[]): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 3; page++) {
    const response = await fetch(`${url}${url.includes('?') ? '&' : '?'}per_page=100&page=${page}`, { redirect: 'manual', signal, headers: headersFor(token) });
    if (!response.ok) throw new GitHubReadError(`GitHub answered ${response.status} when listing ${what}`);
    const rows = pick(await response.json());
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
}
// Everything the person can see: the repositories of every GitHub App installation they can
// reach, plus the ones the token itself reaches (an OAuth App token has no installations and
// sees all of them directly). Newest pushed first.
export async function listGitHubRepos(token: string, timeoutMs = 8000): Promise<GitHubRepoListing> {
  const signal = AbortSignal.timeout(timeoutMs);
  let installations: { id: number }[] = [];
  try { installations = await pages(`${API}/user/installations`, token, signal, 'installations', body => ((body as { installations?: { id?: unknown }[] }).installations ?? []).filter(i => Number.isSafeInteger(i.id)).map(i => ({ id: i.id as number }))); }
  catch { installations = []; }   // an OAuth App token cannot call this endpoint
  const seen = new Map<string, GitHubRepoChoice>();
  for (const installation of installations) {
    const rows = await pages(`${API}/user/installations/${installation.id}/repositories`, token, signal, 'repositories', body => ((body as { repositories?: RepoRow[] }).repositories ?? []));
    for (const row of rows) { const c = choice(row); if (c) seen.set(c.fullName, c); }
  }
  // Always merge what the token itself reaches (personal, collaborator and organisation repos):
  // that is the complete list for an OAuth App token, and fills gaps for a GitHub App token.
  try {
    const rows = await pages(`${API}/user/repos?sort=pushed&affiliation=owner,collaborator,organization_member`, token, signal, 'repositories', body => (Array.isArray(body) ? body as RepoRow[] : []));
    for (const row of rows) { const c = choice(row); if (c) seen.set(c.fullName, c); }
  } catch (error) { if (!installations.length) throw error; }
  const repos = [...seen.values()].sort((a, b) => b.pushedAt.localeCompare(a.pushedAt));
  return { repos, installed: installations.length > 0 };
}
export async function listGitHubBranches(fullName: string, token: string, timeoutMs = 8000): Promise<string[]> {
  const target = githubRepo('https://github.com/' + fullName);
  if (!target) throw new GitHubReadError('Not a GitHub repository');
  const signal = AbortSignal.timeout(timeoutMs); const names: string[] = [];
  for (let page = 1; page <= 3; page++) {
    const response = await fetch(`${API}/repos/${target.owner}/${target.repo}/branches?per_page=100&page=${page}`, { redirect: 'manual', signal, headers: headersFor(token) });
    if (!response.ok) throw new GitHubReadError(`GitHub answered ${response.status} when listing branches`);
    const rows = await response.json() as { name?: unknown }[];
    for (const row of rows) if (typeof row.name === 'string') names.push(row.name);
    if (rows.length < 100) break;
  }
  return names;
}

// ---- Import from GitHub (spec §5): organisations, their repositories, and the large-file preflight ----
export interface GitHubOrg { login: string; description: string }
export async function listGitHubOrgs(token: string, timeoutMs = 8000): Promise<GitHubOrg[]> {
  const signal = AbortSignal.timeout(timeoutMs);
  const rows = await pages(`${API}/user/orgs`, token, signal, 'organisations', body => (Array.isArray(body) ? body as { login?: unknown; description?: unknown }[] : []));
  return rows.filter(r => typeof r.login === 'string').map(r => ({ login: r.login as string, description: typeof r.description === 'string' ? r.description.slice(0, 200) : '' }));
}
// Every repository of an organisation the token can see, newest pushed first; up to ten pages (1,000 repositories).
export async function listOrgRepos(org: string, token: string, timeoutMs = 20000): Promise<GitHubRepoChoice[]> {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(org)) throw new GitHubReadError('Not a GitHub organisation name');
  const signal = AbortSignal.timeout(timeoutMs); const out: GitHubRepoChoice[] = [];
  for (let page = 1; page <= 10; page++) {
    const response = await fetch(`${API}/orgs/${encodeURIComponent(org)}/repos?type=all&sort=pushed&per_page=100&page=${page}`, { redirect: 'manual', signal, headers: headersFor(token) });
    if (response.status === 404) throw new GitHubReadError(`This GitHub token cannot see the organisation ${org}`);
    if (!response.ok) throw new GitHubReadError(`GitHub answered ${response.status} when listing ${org}`);
    const rows = await response.json() as RepoRow[];
    for (const row of rows) { const c = choice(row); if (c) out.push(c); }
    if (rows.length < 100) break;
  }
  return out;
}
export interface LargeBlobs { count: number; largest: number; over32: number; truncated: boolean }
// The preflight: blobs over the threshold on the default branch, from the recursive tree (which carries sizes). Null when
// the tree could not be read; `truncated` when GitHub cut the listing short (history may hold more either way).
export async function largeBlobsOnBranch(fullName: string, branch: string, token: string, thresholdBytes: number, timeoutMs = 10000): Promise<LargeBlobs | null> {
  const target = githubRepo('https://github.com/' + fullName); if (!target) return null;
  const signal = AbortSignal.timeout(timeoutMs); const base = `${API}/repos/${target.owner}/${target.repo}`;
  try {
    const head = await fetch(`${base}/commits/${encodeURIComponent(branch)}`, { redirect: 'manual', signal, headers: { ...headersFor(token), Accept: 'application/vnd.github.sha' } });
    if (!head.ok) return null;
    const tree = await fetch(`${base}/git/trees/${(await head.text()).trim()}?recursive=1`, { redirect: 'manual', signal, headers: headersFor(token) });
    if (!tree.ok) return null;
    const listing = await tree.json() as { tree?: { type?: unknown; size?: unknown }[]; truncated?: unknown };
    let count = 0, largest = 0, over32 = 0;
    for (const entry of listing.tree ?? []) {
      if (entry.type !== 'blob' || typeof entry.size !== 'number') continue;
      if (entry.size > thresholdBytes) count++; if (entry.size > 32 * 1048576) over32++; if (entry.size > largest) largest = entry.size;
    }
    return { count, largest, over32, truncated: listing.truncated === true };
  } catch { return null; }
}

// ---- Test double (GITHUB_MODE=fake): repositories keyed "owner/repo" ----
// `visibleTo`: which tokens may see a repository (empty = every token, as a Settings token would).
export const fakeGitHub = {
  repos: new Map<string, { defaultBranch: string; branches: Record<string, Omit<ScanReport, 'branch'>>; private?: boolean; visibleTo?: string[]; archived?: boolean; sizeKb?: number; sizes?: Record<string, Record<string, number>> }>(),
  orgs: new Map<string, { repos: string[]; visibleTo?: string[] }>(),
  failNext: null as string | null,
  installedFor: new Set<string>(),   // tokens that reach a GitHub App installation
  reset(): void { this.repos.clear(); this.orgs.clear(); this.failNext = null; this.installedFor.clear(); },
};
async function listFakeRepos(token: string): Promise<GitHubRepoListing> {
  if (fakeGitHub.failNext) { const message = fakeGitHub.failNext; fakeGitHub.failNext = null; throw new GitHubReadError(message); }
  const repos = [...fakeGitHub.repos.entries()].filter(([, repo]) => !repo.visibleTo || repo.visibleTo.includes(token))
    .map(([fullName, repo]) => ({ fullName, url: repo.private === false ? `https://github.com/${fullName}.git` : `git@github.com:${fullName}.git`, defaultBranch: repo.defaultBranch, private: repo.private !== false, pushedAt: '', description: '', archived: repo.archived === true, sizeKb: repo.sizeKb ?? 0 }));
  return { repos, installed: fakeGitHub.installedFor.has(token) };
}
async function listFakeBranches(fullName: string, _token: string): Promise<string[]> {
  const repo = fakeGitHub.repos.get(fullName);
  if (!repo) throw new GitHubReadError('GitHub answered 404 when listing branches');
  return Object.keys(repo.branches);
}
async function listFakeOrgs(token: string): Promise<GitHubOrg[]> { return [...fakeGitHub.orgs.entries()].filter(([, o]) => !o.visibleTo || o.visibleTo.includes(token)).map(([login]) => ({ login, description: '' })); }
async function listFakeOrgRepos(org: string, token: string): Promise<GitHubRepoChoice[]> {
  const found = fakeGitHub.orgs.get(org);
  if (!found || (found.visibleTo && !found.visibleTo.includes(token))) throw new GitHubReadError(`This GitHub token cannot see the organisation ${org}`);
  return found.repos.map(fullName => { const repo = fakeGitHub.repos.get(fullName)!; return { fullName, url: repo.private === false ? `https://github.com/${fullName}.git` : `git@github.com:${fullName}.git`, defaultBranch: repo.defaultBranch, private: repo.private !== false, pushedAt: '', description: '', archived: repo.archived === true, sizeKb: repo.sizeKb ?? 0 }; });
}
async function fakeLargeBlobs(fullName: string, branch: string, _token: string, threshold: number): Promise<LargeBlobs | null> {
  const repo = fakeGitHub.repos.get(fullName); const found = repo?.branches[branch]; if (!repo || !found) return null;
  const sizes = Object.values(repo.sizes?.[branch] ?? {});
  return { count: sizes.filter(s => s > threshold).length, largest: Math.max(0, ...sizes), over32: sizes.filter(s => s > 32 * 1048576).length, truncated: found.truncated };
}
export function githubLister(env: unknown): { repos: typeof listGitHubRepos; branches: typeof listGitHubBranches; orgs: typeof listGitHubOrgs; orgRepos: typeof listOrgRepos; largeBlobs: typeof largeBlobsOnBranch } {
  return (env as { GITHUB_MODE?: unknown } | null)?.GITHUB_MODE === 'fake' ? { repos: listFakeRepos, branches: listFakeBranches, orgs: listFakeOrgs, orgRepos: listFakeOrgRepos, largeBlobs: fakeLargeBlobs }
    : { repos: listGitHubRepos, branches: listGitHubBranches, orgs: listGitHubOrgs, orgRepos: listOrgRepos, largeBlobs: largeBlobsOnBranch };
}
async function readFake(url: string, branch: string, _token: string): Promise<ScanReport> {
  if (fakeGitHub.failNext) { const message = fakeGitHub.failNext; fakeGitHub.failNext = null; throw new GitHubReadError(message); }
  const target = githubRepo(url);
  const repo = target ? fakeGitHub.repos.get(`${target.owner}/${target.repo}`) : undefined;
  if (!repo || (repo.visibleTo && !repo.visibleTo.includes(_token))) throw new GitHubReadError('GitHub answered 404 for the repository');
  const name = branch || repo.defaultBranch;
  const found = repo.branches[name];
  if (!found) throw new GitHubReadError(`GitHub answered 404 for branch ${name}`);
  return { ...found, branch: name };
}
export function githubReader(env: unknown): typeof readGitHub { return (env as { GITHUB_MODE?: unknown } | null)?.GITHUB_MODE === 'fake' ? readFake : readGitHub; }
