import { it, expect } from 'vitest';
import { hostName as shownHost, linkedUrl, copyOf as shownCopy } from '../public/repo-projects.js';
import { copyOf, hostName, upstreamOf } from '../src/upstream';

it('tells a linked copy from one that lives only in Smith, and names its host, exactly as the server does', () => {
  const remote = 'https://bab833826312fe2b0c81bd7608a6dbf7.artifacts.cloudflare.net/git/default/abc-senet.git';
  for (const sourceRepoUrl of ['git@github.com:Red-Marmoset/senet.git', remote, '', 'https://gitlab.com/a/b.git']) {
    const copy = { remote, sourceRepoUrl };
    expect(linkedUrl(copy)).toBe(upstreamOf(copy));
  }
  for (const url of ['git@github.com:Red-Marmoset/senet.git', 'https://gitlab.com/a/b.git', 'ssh://git@git.example.com:2222/a/b.git', 'https://bitbucket.org/a/b.git', ''])
    expect(shownHost(url)).toBe(hostName(url));
});

it('finds the copy a project builds from, on Smith’s machines or on Artifacts, as the server does', () => {
  const origin = 'https://exp.redmarmosetstudios.com';
  globalThis.location = { origin };
  const remote = 'https://bab833826312fe2b0c81bd7608a6dbf7.artifacts.cloudflare.net/git/default/abc-senet.git';
  const cases = [
    { id: 'senet', kind: 'repo', repoUrl: `${origin}/git/senet.git`, hosted: { status: 'ready', sourceRepoUrl: 'git@github.com:Red-Marmoset/senet.git', sync: { direction: 'pull', status: 'done' } } },
    { id: 'senet', kind: 'repo', repoUrl: 'git@github.com:Red-Marmoset/senet.git', hosted: { status: 'copying', sourceRepoUrl: 'git@github.com:Red-Marmoset/senet.git' } },
    { id: 'senet', kind: 'repo', repoUrl: remote, artifacts: { status: 'done', remote, sourceRepoUrl: 'git@github.com:Red-Marmoset/senet.git', detachedFrom: 'x' } },
    { id: 'senet', kind: 'repo', repoUrl: 'git@github.com:Red-Marmoset/senet.git' }, undefined];
  for (const project of cases) expect(shownCopy(project)).toEqual(copyOf(project, origin));
  expect(shownCopy(cases[0]).kind).toBe('hosted');
  expect(linkedUrl({ remote: `${origin}/git/senet.git`, sourceRepoUrl: `${origin}/git/senet.git` })).toBe('');
  delete globalThis.location;
});
