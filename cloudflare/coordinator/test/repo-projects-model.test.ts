import { describe, expect, it } from 'vitest';
import { applyReport, createRepoProject, newProjectId, publicRepoProject, repoBuildSpecs, resolveBuildSpec, scanSpecs, validateRepoUrl, validateScanReport, REPO_LABEL } from '../src/repo-projects';
import senet from './fixtures/smith-json/senet.json?raw';

const now = 1_000_000;
const commit = 'c'.repeat(40);
const draft = (body: object = {}) => createRepoProject({ source: 'git', url: 'git@github.com:Red-Marmoset/senet.git', ...body }, new Set(), now);

describe('repository projects', () => {
  it('accepts HTTPS, ssh and scp-style URLs without passwords', () => {
    for (const url of ['https://github.com/a/b.git', 'ssh://git@host.example:2222/a/b.git', 'git@gitlab.com:a/b.git', 'https://git.example.com/scm/a/b']) expect(validateRepoUrl(url)).toBe(url);
    for (const url of ['https://user:pw@github.com/a/b.git', 'http://github.com/a/b.git', 'file:///c/repo', 'git@github.com:a/b.git x', 'C:\\repo']) expect(() => validateRepoUrl(url)).toThrow('without a password');
  });
  it('names the project after the repository and gives a second repo with the same name its own ID', () => {
    expect(draft()).toMatchObject({ kind: 'repo', id: 'senet', name: 'senet', branch: '', commit: null, customName: false, scan: { state: 'waiting', jobId: null } });
    expect(newProjectId('https://github.com/other/senet.git', new Set(['senet']))).toBe('senet-2');
    expect(newProjectId('git@github.com:a/smoke.git', new Set())).toBe('smoke-repo');
    expect(draft({ name: 'Senet game', branch: 'staging' })).toMatchObject({ name: 'Senet game', customName: true, branch: 'staging' });
    expect(() => draft({ branch: '../x' })).toThrow('Invalid branch');
    expect(() => draft({ source: 'svn' })).toThrow('Unsupported project source');
  });
  it('fills a blank branch from a report and maps smith.json into actions', () => {
    const ready = applyReport(draft(), { commit, branch: 'master', smithJson: senet, paths: [], truncated: false }, 'github', null, now + 1);
    expect(ready).toMatchObject({ branch: 'master', commit, name: 'Senet', scan: { state: 'ready', via: 'github' }, unusedRules: 5 });
    expect(ready.actions.map(a => a.id)).toContain('build-check');
  });
  it('reports a missing or broken smith.json as an error on the project', () => {
    expect(applyReport(draft(), { commit, branch: 'main', smithJson: null, paths: [], truncated: false }, 'machine', 'PC', now).scan)
      .toMatchObject({ state: 'error', message: expect.stringContaining('No smith.json at cccccccccccc on main') });
    expect(applyReport(draft(), { commit, branch: 'main', smithJson: '{', paths: [], truncated: false }, 'machine', 'PC', now).scan.message).toBe('smith.json is not a valid JSON object');
  });
  it('builds scan specs for every OS and build specs only for the action\'s OS', () => {
    const project = applyReport(draft(), { commit, branch: 'master', smithJson: senet, paths: [], truncated: false }, 'github', null, now);
    const scan = scanSpecs(project, 'job-1');
    expect(Object.keys(scan)).toEqual(['windows', 'linux', 'mac']);
    expect(scan.windows).toMatchObject({ kind: 'scan', projectId: 'senet', repos: [{ url: project.repoUrl, branch: 'master', commit: '' }] });
    const build = repoBuildSpecs(project, 'build-check', 'job-2', 3);
    expect(Object.keys(build.specs)).toEqual(['windows']);
    expect(build.specs.windows).toMatchObject({ kind: 'build', buildNumber: 3, resolve: { action: 'build-check' }, repos: [{ commit: '' }] });
    expect(build.labels).toEqual(['node', REPO_LABEL]);
    expect(() => repoBuildSpecs(project, 'nope', 'j', 1)).toThrow('not in this project');
    expect(() => repoBuildSpecs(draft(), 'build-check', 'j', 1)).toThrow('not known yet');
  });
  it('resolves a stored build spec at the checked-out commit', () => {
    const project = applyReport(draft(), { commit, branch: 'master', smithJson: senet, paths: [], truncated: false }, 'github', null, now);
    const stored = repoBuildSpecs(project, 'build-check', 'job-2', 3).specs.windows;
    const resolved = resolveBuildSpec(stored, { commit, branch: 'master', smithJson: senet, paths: [], truncated: false }, 'master', 'windows');
    expect(resolved).not.toHaveProperty('resolve');
    expect(resolved).toMatchObject({ jobId: 'job-2', repos: [{ commit, branch: 'master' }], command: { interpreter: 'bat', script: 'build.bat' }, artifacts: { globs: [], package: 'none' } });
    expect(resolved.env.SMITH_COMMIT).toBe(commit);
  });
  it('validates scan reports from machines', () => {
    expect(validateScanReport({ commit, branch: 'main', smithJson: null, paths: ['a'], truncated: false }).paths).toEqual(['a']);
    for (const bad of [{ commit: 'x', branch: 'main', smithJson: null, paths: [], truncated: false }, { commit, branch: 'main', smithJson: 'x'.repeat(262145), paths: [], truncated: false },
      { commit, branch: 'main', smithJson: null, paths: Array(20001).fill('a'), truncated: true }, { commit, branch: 'main', smithJson: null, paths: [], truncated: false, extra: 1 }]) expect(() => validateScanReport(bad)).toThrow();
  });
  it('shows a waiting project as scanning, waiting or failed from its scan job', () => {
    const waiting = { ...draft(), scan: { ...draft().scan, jobId: 'scan-1' } };
    expect(publicRepoProject(waiting, { state: 'queued', nodeHost: null, message: '' }, []).scan.message).toBe('Waiting for a machine to read smith.json.');
    expect(publicRepoProject(waiting, { state: 'queued', nodeHost: null, message: '' }, [{ host: 'PC', message: 'Permission denied (publickey)', at: now }]).scan.message).toBe('Waiting for a machine that can read this repository.');
    expect(publicRepoProject(waiting, { state: 'running', nodeHost: 'PC', message: '' }, []).scan).toMatchObject({ state: 'scanning', host: 'PC' });
    expect(publicRepoProject(waiting, { state: 'lost', nodeHost: null, message: '' }, []).scan).toMatchObject({ state: 'error', message: expect.stringContaining('Rescan') });
  });
});
