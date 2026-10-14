import { describe, expect, it } from 'vitest';
// @ts-expect-error the dashboard's card module is plain browser JavaScript without declarations
import { byPlatform, copyProblem, groupActions, projectLine, repoName } from '../public/repo-projects.js';

const action = (product: string, variant: string | null, os: string[]) => ({ id: `${product}/${variant ?? ''}`, label: product, product, rule: 'r', variant, os, labels: [], notes: [], available: true });

describe('project card action grouping', () => {
  it('groups actions by product in smith.json order', () => {
    const actions = [action('unity', 'Steam (Windows)', ['windows']), action('steam-deploy', null, ['windows']), action('unity', 'Steam (Mac)', ['mac'])];
    expect(groupActions(actions).map((g: { product: string; actions: unknown[] }) => [g.product, g.actions.length])).toEqual([['unity', 2], ['steam-deploy', 1]]);
  });
  it('lists variants under their single platform and multi-platform ones under Any platform', () => {
    const buckets = byPlatform([action('unity', 'Steam (Mac)', ['mac']), action('unity', 'Google Play (Android)', ['windows', 'linux', 'mac']), action('unity', 'Steam (Windows)', ['windows']), action('unity', 'No Steam (Mac)', ['mac'])]);
    expect(buckets.map((b: { title: string; actions: unknown[] }) => [b.title, b.actions.length])).toEqual([['macOS', 2], ['Any platform', 1], ['Windows', 1]]);
  });
});

describe('folded project card line', () => {
  const project = (extra: Record<string, unknown> = {}) => ({ id: 'soccer', name: 'Soccer Boy', kind: 'repo', repoUrl: 'git@github.com:Red-Marmoset/soccer-boy.git', branch: 'main',
    scan: { state: 'ready' }, actions: [action('unity', 'Steam (Windows)', ['windows']), action('unity', 'Steam (Mac)', ['mac']), action('steam-deploy', null, ['windows'])], ...extra });
  it('names the repository, branch, products and builds', () => {
    expect(projectLine(project())).toBe('Red-Marmoset/soccer-boy · main · 2 products, 3 builds');
  });
  it('says when it builds on push, which machines cannot read it, and when a copy failed', () => {
    const line = projectLine(project({ push: { enabled: true }, access: [{ host: 'a' }, { host: 'b' }], hosted: { status: 'failed' } }));
    expect(line).toBe('Red-Marmoset/soccer-boy · main · 2 products, 3 builds · builds on push · copy failed · 2 machines can’t read it');
    expect(copyProblem(project({ hosted: { status: 'failed' } }))).toBe('failed');
    expect(copyProblem(project())).toBe('');
  });
  it('shortens any Git URL form to owner/repo', () => {
    for (const url of ['https://github.com/a/b.git', 'git@github.com:a/b.git', 'ssh://git@git.example.com:2222/a/b.git', 'https://github.com/a/b/'])
      expect(repoName(url)).toBe('a/b');
  });
});
