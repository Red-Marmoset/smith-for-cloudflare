import { describe, expect, it } from 'vitest';
import { PipelineError, discoverVariants, mapPipeline, parseSmithJson, resolveAction } from '../src/pipeline';
import soccer from './fixtures/smith-json/soccer-boy.json?raw';
import senet from './fixtures/smith-json/senet.json?raw';
import smith from './fixtures/smith-json/smith.json?raw';
import soccerPaths from './fixtures/smith-json/soccer-boy.paths.txt?raw';
import soccerVariants from './fixtures/smith-json/soccer-boy.variants.txt?raw';

const lines = (text: string) => text.split(/\r?\n/).filter(Boolean);
const commit = 'a'.repeat(40);

describe('real smith.json files', () => {
  it('parses each fixture with the product counts LAN Smith sees', () => {
    expect([soccer, senet, smith].map(text => parseSmithJson(text).products.length)).toEqual([5, 6, 6]);
  });
  it('discovers the same Unity profiles as LAN Smith (shared with the C++ parity test)', () => {
    const config = parseSmithJson(soccer);
    const actual = config.products.flatMap(product => discoverVariants(product.discover, lines(soccerPaths))
      .map(v => [product.name, v.name, v.slug, v.os, v.labels.join(',')].join('|')));
    expect(actual).toEqual(lines(soccerVariants));
  });
  it('offers senet the rule each product runs on master, and counts the rest', () => {
    const pipeline = mapPipeline(senet, [], 'master');
    expect(pipeline.actions.map(a => a.id)).toEqual(['build-check', 'web-deploy', 'd1-limit-workaround', 'ai-ladder']);
    expect(pipeline.actions.every(a => a.os.join() === 'windows' && a.available)).toBe(true);
    expect(pipeline.actions[0]).toMatchObject({ label: 'build-check · ci-build', labels: ['node'], notes: ['Artifacts are not collected here yet (globs or zip packaging)'] });
    expect(pipeline.actions[1]).toMatchObject({ rule: 'deploy-prod', labels: ['node', 'wrangler', 'butler'] });
    expect(pipeline.actions[3].notes).toEqual([]);
    expect(pipeline.unusedRules).toBe(5);
    expect(mapPipeline(senet, [], 'staging').actions.map(a => a.id)).toEqual(['build-check', 'web-deploy', 'd1-limit-workaround', 'stats-reconcile-prod', 'stats-reconcile-staging', 'ai-ladder']);
  });
  it('maps smith on its feature branch, including steps for every OS', () => {
    const pipeline = mapPipeline(smith, [], 'feature/cloudflare-experiment');
    expect(pipeline.actions.map(a => [a.id, a.os.join()])).toEqual([['self-release', 'windows'], ['build-experiment', 'windows,linux,mac'], ['deploy-experiment', 'windows'], ['build', 'windows,linux,mac'], ['test', 'windows,linux,mac'], ['tray', 'windows,mac']]);
    expect(pipeline.actions.find(a => a.id === 'tray')!.labels).toEqual(['una-engine', 'wxwidgets']);
    // A push to the branch deploys (the webhook trigger); the poll trigger is LAN-only and builds nothing here.
    expect(pipeline.onPush).toEqual(['deploy-experiment']);
    expect(pipeline.actions.find(a => a.id === 'deploy-experiment')!.labels).toEqual(['una-engine', 'smith-deploy']);
    const main = mapPipeline(smith, [], 'main');
    expect(main.unusedRules).toBe(2);
    expect(main.onPush).toEqual([]);
  });
  it('turns each Unity profile into an action and marks deploys that need inputs unavailable', () => {
    const pipeline = mapPipeline(soccer, lines(soccerPaths), 'main');
    expect(pipeline.actions).toHaveLength(19);
    expect(pipeline.actions.find(a => a.id === 'unity/steam-windows')).toMatchObject({ label: 'unity · build-profile · Steam (Windows)', os: ['windows'], labels: ['unity6'], available: true });
    expect(pipeline.actions.find(a => a.id === 'unity/steam-linux')).toMatchObject({ os: ['windows', 'linux', 'mac'], labels: ['unity6', 'unity-linux-il2cpp'] });
    expect(pipeline.actions.find(a => a.id === 'unity/app-store-ios')).toMatchObject({ os: ['mac'], labels: ['unity6', 'unity-ios'] });
    const steam = pipeline.actions.find(a => a.id === 'steam-deploy')!;
    expect(steam.available).toBe(false);
    expect(steam.notes.join(' ')).toContain('Handoff not run in hosted builds: steam');
    expect(steam.notes.join(' ')).toContain('Needs artifacts from unity / Steam (Windows)');
  });
  it('warns when a discover product sees a truncated file list', () => {
    expect(mapPipeline(soccer, lines(soccerPaths), 'main', true).warnings[0]).toContain('cut short');
  });
  it('returns no actions (and counts the rules) when nothing runs on the branch', () => {
    const text = JSON.stringify({ project: { id: 'x' }, buildProducts: [{ name: 'p', rules: [{ name: 'r', branches: ['release/*'], command: { windows: { interpreter: 'bat', script: 'b.bat' } } }, { name: 'off', enabled: false }] }] });
    expect(mapPipeline(text, [], 'main')).toMatchObject({ actions: [], unusedRules: 1, disabledRules: 1 });
  });
});

describe('build-time resolution', () => {
  it('substitutes the variant, output and commit like ResolveJobSpec', () => {
    const build = resolveAction(soccer, lines(soccerPaths), 'unity/steam-windows', 'windows', { branch: 'main', commit, buildNumber: 7 });
    expect(build.command.interpreter).toBe('ps1');
    expect(build.command.script).toBe('tools/smith-build.ps1');
    expect(build.command.args).toContain('Steam (Windows)');
    expect(build.command.args.join(' ')).not.toContain('${');
    expect(build.env).toMatchObject({ SMITH_BUILD: '1', SMITH_BRANCH: 'main', SMITH_COMMIT: commit, SMITH_BUILD_NUMBER: '7', SMITH_PROJECT: 'soccer-boy' });
    expect(build.artifacts).toEqual([]);                 // ${OUTPUT}/** zipped: not collected here yet
    expect(build.timeoutSeconds).toBe(3600);
  });
  it('keeps ordered steps and exact artifacts', () => {
    const steps = resolveAction(smith, [], 'build-experiment', 'linux', { branch: 'feature/cloudflare-experiment', commit, buildNumber: 1 });
    expect(steps.steps.map(s => s.script)).toEqual(['Build.sh', 'tools/package-experiment.py']);
    expect(steps.command).toEqual(steps.steps[0]);
    const release = resolveAction(smith, [], 'self-release', 'windows', { branch: 'main', commit, buildNumber: 2 });
    expect(release.artifacts).toEqual(['Build/SelfRelease/smith-release.zip']);
  });
  it('refuses an action that no longer exists, has no command for the OS, or needs inputs', () => {
    expect(() => resolveAction(senet, [], 'missing', 'windows', { branch: 'master', commit, buildNumber: 1 })).toThrow(/missing is not in smith.json at aaaaaaaaaaaa on master/);
    expect(() => resolveAction(senet, [], 'build-check', 'linux', { branch: 'master', commit, buildNumber: 1 })).toThrow(PipelineError);
    expect(() => resolveAction(soccer, lines(soccerPaths), 'steam-deploy', 'windows', { branch: 'main', commit, buildNumber: 1 })).toThrow(/needs artifacts/);
  });
});
