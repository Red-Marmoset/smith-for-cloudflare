import { describe, expect, it } from 'vitest';
import { homeOf, fitsArtifacts, assignHome } from '../src/home';
import { copyOf } from '../src/upstream';

const origin = 'https://exp.redmarmosetstudios.com';
const artifacts = { repo: 'ws-senet', namespace: 'default', remote: 'https://bab833826312fe2b0c81bd7608a6dbf7.artifacts.cloudflare.net/git/default/ws-senet.git', status: 'done' as const, accountId: 'bab833826312fe2b0c81bd7608a6dbf7', source: 'smith' as const, sourceRepoUrl: 'git@github.com:Red-Marmoset/senet.git', updatedAt: 1 };
const hosted = { repoId: 'senet', uuid: 'u', status: 'ready' as const, sourceRepoUrl: 'git@github.com:Red-Marmoset/senet.git', updatedAt: 1 };
const base = { id: 'senet', name: 'Senet', branch: 'master', commit: 'a'.repeat(40), products: [] };

describe('home', () => {
  it('reads the stored home and nothing else', () => {
    expect(homeOf({ ...base, repoUrl: `${origin}/git/senet.git`, home: 'artifacts', artifacts })).toBe('artifacts');
    expect(homeOf({ ...base, repoUrl: `${origin}/git/senet.git`, home: 'machines', hosted })).toBe('machines');
    expect(homeOf({ ...base, repoUrl: 'git@github.com:Red-Marmoset/senet.git' })).toBeUndefined();
  });
  it('copyOf answers Smith’s URL for an Artifacts home and keeps the link and sync', () => {
    const copy = copyOf({ ...base, repoUrl: `${origin}/git/senet.git`, home: 'artifacts', artifacts: { ...artifacts, detachedFrom: 'x' } }, origin);
    expect(copy).toEqual({ kind: 'artifacts', remote: `${origin}/git/senet.git`, sourceRepoUrl: artifacts.sourceRepoUrl, detachedFrom: 'x', sync: undefined });
    expect(copyOf({ ...base, repoUrl: `${origin}/git/senet.git`, home: 'machines', hosted }, origin)?.kind).toBe('hosted');
    // The old shape (an Artifacts remote as repoUrl, no home) is still a copy until the upgrade pass runs.
    expect(copyOf({ ...base, repoUrl: artifacts.remote, artifacts }, origin)?.kind).toBe('artifacts');
  });
  it('assigns a home to the three legacy shapes without moving bytes', () => {
    expect(assignHome({ ...base, repoUrl: artifacts.remote, artifacts }, origin)).toEqual({ home: 'artifacts', repoUrl: `${origin}/git/senet.git` });
    expect(assignHome({ ...base, repoUrl: `${origin}/git/senet.git`, hosted }, origin)).toEqual({ home: 'machines', repoUrl: `${origin}/git/senet.git` });
    expect(assignHome({ ...base, repoUrl: `${origin}/git/senet.git`, hosted, artifacts }, origin)).toEqual({ home: 'machines', repoUrl: `${origin}/git/senet.git` });
    expect(assignHome({ ...base, repoUrl: 'git@github.com:Red-Marmoset/senet.git' }, origin)).toBeNull();
    expect(assignHome({ ...base, repoUrl: `${origin}/git/senet.git`, home: 'artifacts', artifacts }, origin)).toBeNull();   // already assigned
  });
  it('knows what Artifacts can hold', () => {
    expect(fitsArtifacts(1024 * 1024 * 1024)).toBe(true);
    expect(fitsArtifacts(1024 * 1024 * 1024 + 1)).toBe(false);
  });
});
