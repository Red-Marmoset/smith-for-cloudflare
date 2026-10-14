import { it, expect } from 'vitest';
import { repoKey, duplicates, duplicateText } from '../public/duplicates.js';

it('reads one repository out of every way of writing its URL', () => {
  for (const url of ['git@github.com:Red-Marmoset/senet.git', 'https://github.com/red-marmoset/senet', 'ssh://git@github.com/Red-Marmoset/senet.git/', 'https://someone@github.com/Red-Marmoset/Senet.git'])
    expect(repoKey(url)).toBe('github.com/red-marmoset/senet');
  expect(repoKey('ssh://git@git.example.test:2222/team/game.git')).toBe('git.example.test/team/game');
  expect(repoKey('https://exp.redmarmosetstudios.com/git/senet.git')).toBe('exp.redmarmosetstudios.com/git/senet');
  expect(repoKey('')).toBe('');
  expect(repoKey('not a url')).toBe('');
  expect(repoKey(undefined)).toBe('');
});

const smith = id => `https://exp.redmarmosetstudios.com/git/${id}.git`;
it('flags projects that come from the same repository and branch, however they were added', () => {
  const projects = [
    { id: 'senet', name: 'Senet', repoUrl: 'git@github.com:Red-Marmoset/senet.git', branch: 'master' },
    // Imported from GitHub (rewritten, so detached): its own address is Smith's, its origin is in detachedFrom.
    { id: 'senet-2', name: 'senet', repoUrl: smith('senet-2'), branch: 'master', artifacts: { sourceRepoUrl: smith('senet-2'), detachedFrom: 'https://github.com/red-marmoset/senet' } },
    { id: 'senet-staging', name: 'Senet staging', repoUrl: 'https://github.com/Red-Marmoset/senet.git', branch: 'staging' },   // another branch, on purpose
    { id: 'tools', name: 'Tools', repoUrl: smith('tools'), branch: 'main', hosted: { sourceRepoUrl: 'git@github.com:Red-Marmoset/tools.git' } },
    { id: 'tools-old', name: 'Tools (old)', repoUrl: 'https://github.com/Red-Marmoset/tools', branch: '' },   // the default branch: could be main
    { id: 'made', name: 'Made in Smith', repoUrl: smith('made'), branch: 'main', artifacts: { sourceRepoUrl: smith('made') } },
  ];
  const found = duplicates(projects);
  expect(found.get('senet')?.map(d => d.id)).toEqual(['senet-2']);
  expect(found.get('senet-2')?.map(d => d.id)).toEqual(['senet']);
  expect(found.get('senet-staging')).toBeUndefined();
  expect(found.get('tools')?.map(d => d.id)).toEqual(['tools-old']);
  expect(found.get('tools-old')?.map(d => d.id)).toEqual(['tools']);
  expect(found.get('made')).toBeUndefined();
  expect(found.get('senet')?.[0]).toEqual({ id: 'senet-2', name: 'senet', repository: 'github.com/red-marmoset/senet', branch: 'master' });
});

it('explains what a duplicate costs and what to do about it', () => {
  expect(duplicateText([{ id: 'senet-2', name: 'senet', repository: 'github.com/red-marmoset/senet', branch: 'master' }]))
    .toBe('“senet” looks like the same repository (github.com/red-marmoset/senet, branch master). Each project fetches, builds and keeps its own copies, so a push can build twice and storage holds it twice. If you meant to have one, remove the other from its card; if they differ on purpose, ignore this.');
  expect(duplicateText([{ id: 'a', name: 'A', repository: 'github.com/x/y', branch: '' }, { id: 'b', name: 'B', repository: 'github.com/x/y', branch: 'main' }]))
    .toBe('“A” and “B” look like the same repository (github.com/x/y). Each project fetches, builds and keeps its own copies, so a push can build twice and storage holds it twice. If you meant to have one, remove the others from their cards; if they differ on purpose, ignore this.');
});
