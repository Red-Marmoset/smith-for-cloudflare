import { describe, expect, it } from 'vitest';
import { PipelineError, branchMatches, classifyVariant, discoverVariants, globToRegex, parseSmithJson, slugifyName, subst, type Discover } from '../src/pipeline';

const minimal = (extra: object = {}) => JSON.stringify({ project: { id: 'x' }, buildProducts: [{ name: 'b', rules: [{ name: 'r', command: { windows: { interpreter: 'bat', script: 'build.bat' } } }] }], ...extra });
const discover = (overrides: Partial<Discover> = {}): Discover => ({ type: 'files', glob: 'profiles/*.asset', values: [], as: 'PROFILE',
  classify: [{ match: '\\(Mac\\)', os: 'mac', labels: [], preferOs: '' }, { match: '\\(Linux\\)', os: 'any', labels: ['linux-il2cpp'], preferOs: '' }, { match: '.*', os: 'windows', labels: [], preferOs: '' }], ...overrides });

describe('smith.json parsing (LAN RepoConfig.cpp semantics)', () => {
  it('accepts a BOM and CRLF', () => {
    const config = parseSmithJson('﻿' + minimal().replace(/,/g, ',\r\n'));
    expect(config.id).toBe('x');
    expect(config.products[0].rules[0].commandByOs.windows).toEqual({ interpreter: 'bat', script: 'build.bat', args: [] });
  });
  it('requires project.id and a JSON object', () => {
    expect(() => parseSmithJson('{"buildProducts":[]}')).toThrow('project.id is required');
    expect(() => parseSmithJson('[1]')).toThrow('not a valid JSON object');
    expect(() => parseSmithJson('{"project":{"id":"x"}} trailing')).toThrow(PipelineError);
  });
  it('throws where LAN value() throws, and tolerates what StrArray tolerates', () => {
    expect(() => parseSmithJson(JSON.stringify({ project: { id: 'x' }, buildProducts: [{ name: 'b', rules: [{ name: 'r', enabled: 1 }] }] }))).toThrow('enabled must be true or false');
    expect(() => parseSmithJson(JSON.stringify({ project: { id: 'x', name: null } }))).toThrow('project.name must be a string');
    expect(() => parseSmithJson(JSON.stringify({ project: { id: 'x' }, buildProducts: [{ rules: [{ command: { windows: 'build.bat' } }] }] }))).toThrow('command.windows must be an object');
    const config = parseSmithJson(JSON.stringify({ project: { id: 'x' }, buildProducts: [{ name: 'b', rules: [{ branches: ['main', 3], timeoutSeconds: true, successExitCodes: [0, 1.5, '2'], env: { A: '1', B: 2 }, command: { windows: [], linux: [{ interpreter: 'sh', script: 'b.sh', args: ['x', 1] }] } }] }] }));
    const rule = config.products[0].rules[0];
    expect(rule.branches).toEqual(['main']);
    expect(rule.timeoutSeconds).toBe(1);
    expect(rule.successExitCodes).toEqual([0]);
    expect(rule.env).toEqual({ A: '1' });
    expect(rule.stepsByOs).toEqual({ linux: [{ interpreter: 'sh', script: 'b.sh', args: ['x'] }] });
    expect(rule.commandByOs).toEqual({});
  });
  it('reads only buildProducts and the primary repo default branch', () => {
    const config = parseSmithJson(JSON.stringify({ project: { id: 'x' }, products: [{ name: 'ignored' }], repos: [{ name: 'a' }, { name: 'b', primary: true, defaultBranch: 'master' }] }));
    expect(config.products).toEqual([]);
    expect(config.defaultBranch).toBe('master');
  });
});

describe('variants (LAN Variants.cpp / Strings.cpp semantics)', () => {
  it('slugifies like SlugifyName', () => {
    expect(slugifyName('Steam (Windows)')).toBe('steam-windows');
    expect(slugifyName('No Steam (Mac)')).toBe('no-steam-mac');
    expect(slugifyName('   ')).toBe('build');
    expect(slugifyName('Café Build')).toBe('caf-build');
  });
  it('translates globs like GlobToRegex', () => {
    expect(globToRegex('profiles/*.asset').test('profiles/a.asset')).toBe(true);
    expect(globToRegex('profiles/*.asset').test('profiles/a.asset.meta')).toBe(false);
    expect(globToRegex('profiles/*.asset').test('profiles/sub/a.asset')).toBe(false);
    expect(globToRegex('**/*.asset').test('a.asset')).toBe(false);
    expect(globToRegex('**/*.asset').test('x/y/a.asset')).toBe(true);
    expect(globToRegex('a?.txt').test('ab.txt')).toBe(true);
    expect(globToRegex('[x].txt').test('[x].txt')).toBe(true);
  });
  it('discovers file variants by stem, deduped and byte-sorted, then classifies them', () => {
    const variants = discoverVariants(discover(), ['profiles/Steam (Windows).asset', 'profiles/Steam (Windows).asset.meta', 'profiles/Steam (Mac).asset', 'profiles/No Steam (Linux).asset', 'profiles/notes.txt', 'other/x.asset']);
    expect(variants.map(v => [v.name, v.slug, v.os, v.labels])).toEqual([
      ['No Steam (Linux)', 'no-steam-linux', 'any', ['linux-il2cpp']], ['Steam (Mac)', 'steam-mac', 'mac', []], ['Steam (Windows)', 'steam-windows', 'windows', []]]);
    expect(discoverVariants(discover({ glob: '' }), ['profiles/a.asset'])).toEqual([]);
  });
  it('keeps list variants in a byte-sorted, deduped order', () => {
    expect(discoverVariants(discover({ type: 'list', values: ['b', 'B', '', 'b'] }), []).map(v => v.name)).toEqual(['B', 'b']);
  });
  it('classifies first match wins, invalid patterns never match, unmatched stays any', () => {
    expect(classifyVariant('x (Mac)', discover({ classify: [{ match: '(', os: 'linux', labels: [], preferOs: '' }, { match: 'Mac', os: 'mac', labels: [], preferOs: '' }] })).os).toBe('mac');
    expect(classifyVariant('plain', discover({ classify: [] }))).toEqual({ name: 'plain', slug: 'plain', os: 'any', labels: [], preferOs: '' });
  });
});

describe('branches and substitution (LAN Coordinator.cpp / CoordinatorJobs.cpp semantics)', () => {
  it('matches branch globs where only * is special', () => {
    expect(branchMatches([], 'anything')).toBe(true);
    expect(branchMatches(['feature/*'], 'feature/a/b')).toBe(true);
    expect(branchMatches(['main'], 'Main')).toBe(false);
    expect(branchMatches(['ma?n'], 'main')).toBe(false);
  });
  it('substitutes keys in sorted order and leaves unknown tokens', () => {
    expect(subst('${A} ${C}', { A: '${B}', B: 'x' })).toBe('x ${C}');
  });
});
