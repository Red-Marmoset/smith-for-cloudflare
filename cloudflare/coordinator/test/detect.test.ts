import { describe, expect, it } from 'vitest';
import { detectBuild } from '../src/detect';
import { mapPipeline } from '../src/pipeline';
import { applyReport, createRepoProject, pipelineBriefing, repoBuildSpecs, resolveBuildSpec } from '../src/repo-projects';
import { chatBriefing } from '../src/sessions';
import { composeCrewPrompt } from '../src/crew-prompt';
import { CREW_TEMPLATES, validateCrewMember } from '../src/crew-model';

const commit = 'c'.repeat(40), now = 1_700_000_000_000;
const report = (paths: string[], smithJson: string | null = null) => ({ commit, branch: 'main', smithJson, paths, truncated: false });
const draft = () => createRepoProject({ source: 'git', url: 'https://github.com/acme/site.git' }, new Set(), now);

describe('detectBuild', () => {
  it('finds nothing in a repository it does not recognise', () => {
    expect(detectBuild(['README.md', 'src/index.html', 'docs/build.sh'], 'x')).toBeNull();
  });
  it('packs a static site with tar on every OS and keeps the archive', () => {
    const found = detectBuild(['index.html', 'style.css', 'img/logo.png'], 'site')!;
    expect(found).toMatchObject({ kind: 'site' });
    const pipeline = mapPipeline(found.smithJson, [], 'main');
    expect(pipeline.actions).toMatchObject([{ id: 'site', os: ['windows', 'linux', 'mac'], labels: [], notes: [], available: true }]);
  });
  it('builds an npm project on machines with npm, through cmd.exe on Windows', () => {
    const found = detectBuild(['package.json', 'package-lock.json', 'index.html', 'src/main.ts'], 'app')!;
    expect(found.kind).toBe('npm');
    const [action] = mapPipeline(found.smithJson, [], 'main').actions;
    expect(action).toMatchObject({ id: 'build', labels: ['npm'], available: true });
    const project = applyReport(draft(), report(['package.json', 'package-lock.json']), 'github', null, now);
    const { specs } = repoBuildSpecs(project, 'build', 'job-1', 3);
    const windows = resolveBuildSpec(specs.windows, report(['package.json', 'package-lock.json']), 'main', 'windows');
    expect(windows.steps.map(s => [s.interpreter, s.script, ...s.args])).toEqual([['exe', 'cmd.exe', '/d', '/c', 'npm', 'ci'], ['exe', 'cmd.exe', '/d', '/c', 'npm', 'run', 'build', '--if-present']]);
    const linux = resolveBuildSpec(specs.linux, report(['package.json']), 'main', 'linux');
    expect(linux.steps.map(s => [s.script, ...s.args])).toEqual([['npm', 'install'], ['npm', 'run', 'build', '--if-present']]);
    expect(linux.env).toMatchObject({ CI: 'true' });
  });
  it("prefers the repository's own build scripts, as the repo spells them", () => {
    const found = detectBuild(['Build.bat', 'build.sh', 'package.json'], 'game')!;
    expect(found.kind).toBe('script');
    const [action] = mapPipeline(found.smithJson, [], 'main').actions;
    expect(action).toMatchObject({ id: 'build', os: ['windows', 'linux', 'mac'], scripts: ['Build.bat', 'build.sh'] });
    expect(mapPipeline(detectBuild(['build.ps1'], 'p')!.smithJson, [], 'main').actions[0].os).toEqual(['windows']);
  });
});

describe('projects without smith.json', () => {
  it('are ready with the detected default, which a real smith.json then replaces', () => {
    const detected = applyReport(draft(), report(['index.html']), 'github', null, now);
    expect(detected).toMatchObject({ scan: { state: 'ready' }, detected: { kind: 'site' } });
    expect(detected.actions.map(a => a.id)).toEqual(['site']);
    const own = JSON.stringify({ project: { id: 'site' }, buildProducts: [{ name: 'Check', rules: [{ command: { linux: { interpreter: 'sh', script: 'check.sh' } } }] }] });
    const replaced = applyReport(detected, report(['index.html'], own), 'github', null, now);
    expect(replaced.detected).toBeUndefined();
    expect(replaced.actions.map(a => a.id)).toEqual(['check']);
  });
  it('say what Smith looks for when nothing is recognised', () => {
    const project = applyReport(draft(), report(['README.md']), 'machine', 'PC', now);
    expect(project.scan).toMatchObject({ state: 'error', message: expect.stringContaining('No smith.json at cccccccccccc on main, and nothing Smith builds without one') });
    expect(project.scan.message).toContain('Pipeline setup');
  });
});

describe('chat and crew are told about the pipeline', () => {
  const session = { project_id: 'site', branch: 'chat/x', base_commit: commit };
  it('in the chat briefing', () => {
    expect(chatBriefing(session, applyReport(draft(), report(['index.html']), 'github', null, now))).toContain('This repository has no smith.json. Smith builds it with a default it detected');
    expect(chatBriefing(session, applyReport(draft(), report(['README.md']), 'github', null, now))).toContain('Smith cannot build this project yet: No smith.json');
    const own = JSON.stringify({ project: { id: 'site' }, buildProducts: [{ name: 'Check', rules: [{ command: { linux: { interpreter: 'sh', script: 'check.sh' } } }] }] });
    expect(pipelineBriefing(applyReport(draft(), report([], own), 'github', null, now))).toBe('');
  });
  it('in a crew run prompt, and a Pipeline setup member can be made from its template', () => {
    const member = validateCrewMember({ template: 'pipeline-setup', projectIds: ['site'] }, undefined, 'user-1', now);
    expect(member).toMatchObject({ name: 'Pipeline setup', permissionMode: 'acceptEdits', charter: CREW_TEMPLATES['pipeline-setup'].charter });
    const pipeline = pipelineBriefing(applyReport(draft(), report(['README.md']), 'github', null, now));
    const { prompt } = composeCrewPrompt({ member, projects: [{ id: 'site', name: 'site', repoUrl: 'https://github.com/acme/site.git', branch: 'main', pipeline }],
      branch: 'crew/pipeline-setup/1', baseCommit: null, trigger: { kind: 'manual' }, previousSummary: null, inbox: [], sharedProjects: [], mayCreateProjects: false });
    expect(prompt).toContain('Pipeline: Smith cannot build this project yet: No smith.json');
  });
});
