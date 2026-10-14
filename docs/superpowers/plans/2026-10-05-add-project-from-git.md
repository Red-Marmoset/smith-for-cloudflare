# Add a Project from a Git URL — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Owners paste a Git URL in the hosted dashboard; Smith reads the repo's `smith.json` (through the GitHub API with a workspace token, or on a build machine with its own Git login) and offers its build actions, which build the branch tip on machines that can clone the repo.

**Architecture:** One TypeScript `smith.json` reader (`src/pipeline.ts`) ports LAN Smith's semantics exactly and serves every path: the GitHub fast path (`src/github-reader.ts`), machine scans (a new `scan` job kind) and build-time resolution (a new node route `/resolve`, called by the agent after it checks out the branch tip). Repository projects live beside operator-prepared projects in the workspace Durable Object (`src/repo-projects.ts` + `src/workspace.ts`); a `repo_access` table routes work away from machines that cannot read a repo. The C++ hosted agent gains scan jobs, branch-tip checkout, the `/resolve` round trip and Git failure classification.

**Tech Stack:** Cloudflare Worker + Durable Object SQLite (TypeScript, vitest with `@cloudflare/vitest-plugin`), vanilla ES-module dashboard, C++ hosted agent (Una engine BuildTool, nlohmann JSON).

**Spec:** `docs/superpowers/specs/2026-10-05-add-project-from-git-design.md` (read it first).

**Refinement from the spec (LAN parity):** In LAN Smith a build targets a *product* (plus a discovered variant); the *rule* is the first enabled rule whose `branches` match the branch (`Coordinator.cpp` `FindRule`). So an action here is one product or product variant, using that rule — not one action per rule. Action IDs are `slugify(product)` or `slugify(product)/<variant slug>`; labels read `product · rule · Variant`. Rules no product uses on the branch are counted (`unusedRules`).

## Global Constraints

- **Work in a worktree branch** `feature/repo-projects` cut from `origin/feature/cloudflare-experiment` (use superpowers:using-git-worktrees). Other sessions push to `feature/cloudflare-experiment` constantly; merge it into your branch before Task 13 and resolve conflicts there.
- **Never run a real deploy.** No `DeployWorker.bat`, no `wrangler deploy`, no `wrangler secret put`, no clicking deploy actions. Verify with `npm run verify` (it includes `wrangler deploy --dry-run`) and local tests. The user deploys.
- **Deploy order:** the Worker must be deployed before updated agents run, because today's coordinator rejects unknown result fields (`commit`, `failure`, `scan`) with 400.
- **Workers `fetch`:** always `redirect: 'manual'` (the runtime throws on `'error'`). Test fakes of `fetch` must first call `new Request(input, init)`.
- **No new dependencies** (npm or C++). Reuse `http.ts` helpers (`fail`, `fields`, `object`, `string`).
- **Limits (exact):** `smith.json` ≤ 256 KiB (262144 chars); scan report ≤ 20000 paths and ≤ 512 KiB of path text; ≤ 100 actions per project; Worker body limit 2 MiB (2097152) for `/complete` and `/resolve`, 64 KiB elsewhere; no-access marks last 1 hour (3600000 ms); GitHub fast path budget 5 seconds; projects quota 20 per workspace (existing).
- **Labels:** repo scans and repo builds require the label `smith-repo-projects`, which only updated agents advertise.
- **GitHub token:** stored as workspace secret `githubToken` (write-only), never in job env, API responses, logs or MCP output.
- **C++ style:** match the surrounding dense style in `Modules/SmithAgent/Hosted*.cpp`; PascalCase functions; no `#ifdef _WIN32` in common code; 800-line soft limit per file.
- **Commits:** `git commit --author="Claude Opus 5.5 <noreply@anthropic.com>"` with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Imperative subject lines like the repo's history.
- **Commands:** TypeScript checks run from `cloudflare/coordinator`: `npx vitest run test/<file>` and `npm run verify`. C++: `.\Build.bat` then `.\RunTests.ps1` from the repo root (RunTests builds every test project with `--clean`; expect several minutes).

## Review Focus

1. **`smith.json` saved by Windows editors** (UTF-8 BOM, CRLF) must parse — pinned in Task 1 (`accepts a BOM and CRLF`).
2. **Branch left blank** must resolve to the repo's default branch from the reader, and later builds must use that branch — pinned in Task 7 (`fills a blank branch from the scan`) and Task 5 (`reads the default branch`).
3. **Two repos with the same name** (`…/a/smith.git` and `…/b/smith.git`) must get distinct project IDs — pinned in Task 6 (`gives a second repo with the same name its own ID`).
4. **No machine can read the repo** must leave the work queued with the reasons visible, and Rescan / the one-hour expiry must let a fixed machine try again — pinned in Task 8 (`skips a machine that could not read the repo, until rescan or an hour`).
5. **A scan that dies** (lease lost, cancelled) must show an error with a way out, not "waiting" forever — pinned in Task 7 (`shows a lost or cancelled scan as an error`).

---

## File map

| File | Responsibility |
| --- | --- |
| `cloudflare/coordinator/src/pipeline.ts` (new) | Pure `smith.json` reader: parse, slugify, glob, discover, classify, branch match, actions, build resolution |
| `cloudflare/coordinator/src/github-reader.ts` (new) | GitHub API fast path + in-memory fake (`GITHUB_MODE=fake`) |
| `cloudflare/coordinator/src/repo-projects.ts` (new) | Repo project model, URL/branch validation, scan/build job specs, report validation, dashboard view, `RepoAccess` SQL helper |
| `cloudflare/coordinator/src/contracts.ts` | `scan` job kind, `ResolveSpec`, `ScanReport`, `JobResult.commit/failure` |
| `cloudflare/coordinator/src/http.ts` | `readBody(request, maxBytes)` |
| `cloudflare/coordinator/src/settings.ts` | `githubToken` workspace secret |
| `cloudflare/coordinator/src/workspace.ts` | Add/rescan, scan completion, access routing, `/resolve`, repo builds |
| `cloudflare/coordinator/src/index.ts` | Routes and body limits |
| `cloudflare/coordinator/src/mcp.ts` | `list_projects` shows repo actions |
| `cloudflare/coordinator/vitest.config.ts` | `GITHUB_MODE: 'fake'` binding |
| `cloudflare/coordinator/test/fixtures/smith-json/*` (new) | Real `smith.json` copies, a file list, expected variants |
| `cloudflare/coordinator/public/repo-projects.js` (new) | Repo project card |
| `cloudflare/coordinator/public/{index.html,app.js,style.css}` | Source choice in Add project, GitHub token setting, polling, builds table |
| `Modules/SmithProtocol/{WireTypes.h,WireJson.cpp}` | `ResolveSpec` on `JobSpec` |
| `Modules/SmithAgent/{HostedAgent.h,HostedPolicy.cpp}` | Policy for scan/tip jobs; `HostedClassifyGitFailure`, `HostedScanReport` |
| `Modules/SmithAgent/HostedAgent.cpp` | Scan jobs, branch tip, `/resolve`, failure reporting, capability label |
| `Tests/SmithCoreTest/Main.cpp`, `Tests/SmithProtocolTest/Main.cpp`, `Tests/SmithHostedAgentTest/Main.cpp` | C++ tests |
| `docs/cloudflare/operations.md`, `docs/cloudflare/progress.md` | API and operator docs |

---

### Task 1: smith.json reader primitives

**Files:**
- Create: `cloudflare/coordinator/src/pipeline.ts`
- Test: `cloudflare/coordinator/test/pipeline-parse.test.ts`

**Interfaces:**
- Produces (exported from `src/pipeline.ts`): `class PipelineError extends Error`; types `Command {interpreter, script, args}`, `Selector {os, labels, preferOs}`, `Rule`, `ClassifyRule`, `Discover`, `Product`, `SmithConfig {id, name, defaultBranch, products}`, `Variant {name, slug, os, labels, preferOs}`; functions `parseSmithJson(text): SmithConfig`, `slugifyName(raw): string`, `globToRegex(glob): RegExp`, `discoverVariants(spec, paths): Variant[]`, `classifyVariant(name, spec): Variant`, `branchMatches(patterns, branch): boolean`, `subst(text, vars): string`.

- [ ] **Step 1: Write the failing tests**

`cloudflare/coordinator/test/pipeline-parse.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { PipelineError, branchMatches, classifyVariant, discoverVariants, globToRegex, parseSmithJson, slugifyName, subst, type Discover } from '../src/pipeline';

const minimal = (extra: object = {}) => JSON.stringify({ project: { id: 'x' }, buildProducts: [{ name: 'b', rules: [{ name: 'r', command: { windows: { interpreter: 'bat', script: 'build.bat' } } }] }], ...extra });
const discover = (overrides: Partial<Discover> = {}): Discover => ({ type: 'files', glob: 'profiles/*.asset', values: [], as: 'PROFILE',
  classify: [{ match: '\\(Mac\\)', os: 'mac', labels: [], preferOs: '' }, { match: '\\(Linux\\)', os: 'any', labels: ['linux-il2cpp'], preferOs: '' }, { match: '.*', os: 'windows', labels: [], preferOs: '' }], ...overrides });

describe('smith.json parsing (LAN RepoConfig.cpp semantics)', () => {
  it('accepts a BOM and CRLF', () => {
    const config = parseSmithJson('\uFEFF' + minimal().replace(/,/g, ',\r\n'));
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/pipeline-parse.test.ts`
Expected: FAIL — `Failed to resolve import "../src/pipeline"`.

- [ ] **Step 3: Write `src/pipeline.ts`**

```ts
// smith.json, read the way LAN Smith reads it (Modules/SmithCore: RepoConfig.cpp, Variants.cpp,
// Strings.cpp; Modules/SmithCoordinator: Coordinator.cpp, CoordinatorJobs.cpp), so a repository
// behaves the same here as on a LAN coordinator. One implementation serves every reader: the
// GitHub fast path, machine scans and build-time resolution. Pure: no bindings, no I/O.

export class PipelineError extends Error {}

type Obj = Record<string, unknown>;
function isObject(value: unknown): value is Obj { return typeof value === 'object' && value !== null && !Array.isArray(value); }

// nlohmann's j.value(key, fallback): an absent key gives the fallback; a present one (null
// included) must have the type, or LAN Smith's parse throws - and so does this one.
function str(o: Obj, key: string, fallback: string, at: string): string {
  if (!(key in o)) return fallback;
  if (typeof o[key] !== 'string') throw new PipelineError(`smith.json: ${at}.${key} must be a string`);
  return o[key] as string;
}
function bool(o: Obj, key: string, fallback: boolean, at: string): boolean {
  if (!(key in o)) return fallback;
  if (typeof o[key] !== 'boolean') throw new PipelineError(`smith.json: ${at}.${key} must be true or false`);
  return o[key] as boolean;
}
function int(o: Obj, key: string, fallback: number, at: string): number {
  if (!(key in o)) return fallback;
  const value = o[key];
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  throw new PipelineError(`smith.json: ${at}.${key} must be a number`);
}
// The tolerant readers (RepoConfig.cpp StrArray/IntArray/StrMap): a wrong container reads as
// empty and elements of the wrong type are dropped.
function strArray(o: Obj, key: string): string[] { const v = o[key]; return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; }
function intArray(o: Obj, key: string): number[] { const v = o[key]; return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isInteger(x)) : []; }
function strMap(o: Obj, key: string): Record<string, string> {
  const v = o[key]; const out: Record<string, string> = {};
  if (isObject(v)) for (const [k, x] of Object.entries(v)) if (typeof x === 'string') out[k] = x;
  return out;
}
function objects(o: Obj, key: string): Obj[] { const v = o[key]; return Array.isArray(v) ? v.filter(isObject) : []; }

export interface Command { interpreter: string; script: string; args: string[] }
export interface Selector { os: string; labels: string[]; preferOs: string }
export interface Rule {
  name: string; enabled: boolean; branches: string[]; nodeSelector: Selector;
  commandByOs: Record<string, Command>; stepsByOs: Record<string, Command[]>;
  workingDir: string; env: Record<string, string>; timeoutSeconds: number; successExitCodes: number[];
  artifacts: { globs: string[]; package: string }; handoff: { name: string; type: string }[]; inputs: { product: string; variant: string }[];
}
export interface ClassifyRule { match: string; os: string; labels: string[]; preferOs: string }
export interface Discover { type: string; glob: string; values: string[]; as: string; classify: ClassifyRule[] }
export interface Product { name: string; outputPath: string; discover: Discover; rules: Rule[] }
export interface SmithConfig { id: string; name: string; defaultBranch: string; products: Product[] }
export interface Variant { name: string; slug: string; os: string; labels: string[]; preferOs: string }

function parseSelector(value: unknown, at: string): Selector {
  if (!isObject(value)) return { os: 'any', labels: [], preferOs: '' };
  return { os: str(value, 'os', 'any', at), labels: strArray(value, 'labels'), preferOs: str(value, 'preferOs', '', at) };
}
function parseCommand(value: unknown, at: string): Command {
  if (!isObject(value)) throw new PipelineError(`smith.json: ${at} must be an object`);
  return { interpreter: str(value, 'interpreter', '', at), script: str(value, 'script', '', at), args: strArray(value, 'args') };
}
function parseDiscover(value: unknown, at: string): Discover {
  if (!isObject(value)) return { type: '', glob: '', values: [], as: 'VARIANT', classify: [] };
  return { type: str(value, 'type', '', at), glob: str(value, 'glob', '', at), values: strArray(value, 'values'), as: str(value, 'as', 'VARIANT', at),
    classify: objects(value, 'classify').map((rule, i) => {
      const where = `${at}.classify[${i}]`;
      return { match: str(rule, 'match', '', where), os: str(rule, 'os', '', where), labels: strArray(rule, 'labels'), preferOs: str(rule, 'preferOs', '', where) };
    }) };
}
function parseRule(j: Obj, at: string): Rule {
  const artifacts = isObject(j.artifacts) ? j.artifacts : null;
  if (artifacts) { bool(artifacts, 'excludeDefaults', true, `${at}.artifacts`); str(artifacts, 'archiveName', '', `${at}.artifacts`); }
  const rule: Rule = {
    name: str(j, 'name', '', at), enabled: bool(j, 'enabled', true, at), branches: strArray(j, 'branches'),
    nodeSelector: parseSelector(j.nodeSelector, `${at}.nodeSelector`), commandByOs: {}, stepsByOs: {},
    workingDir: str(j, 'workingDir', '.', at), env: strMap(j, 'env'), timeoutSeconds: int(j, 'timeoutSeconds', 0, at),
    successExitCodes: intArray(j, 'successExitCodes'),
    // LAN's ArtifactSpec: package defaults to "none" inside an artifacts object, "" without one.
    artifacts: artifacts ? { globs: strArray(artifacts, 'globs'), package: str(artifacts, 'package', 'none', `${at}.artifacts`) } : { globs: [], package: '' },
    handoff: objects(j, 'handoff').map((step, i) => {
      const where = `${at}.handoff[${i}]`; bool(step, 'continueOnError', false, where);
      return { name: str(step, 'name', '', where), type: str(step, 'type', '', where) };
    }),
    inputs: objects(j, 'inputs').map((input, i) => ({ product: str(input, 'product', '', `${at}.inputs[${i}]`), variant: str(input, 'variant', '', `${at}.inputs[${i}]`) }))
      .filter(input => input.product),
  };
  // An array is ordered steps (an empty one defines nothing); an object is a single command.
  if (isObject(j.command)) for (const os of Object.keys(j.command).sort()) {
    const value = j.command[os];
    if (Array.isArray(value)) {
      const steps = value.map((step, i) => parseCommand(step, `${at}.command.${os}[${i}]`));
      if (steps.length) rule.stepsByOs[os] = steps;
    } else rule.commandByOs[os] = parseCommand(value, `${at}.command.${os}`);
  }
  return rule;
}
export function parseSmithJson(text: string): SmithConfig {
  let root: unknown;
  try { root = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { root = undefined; }
  if (!isObject(root)) throw new PipelineError('smith.json is not a valid JSON object');
  int(root, 'schemaVersion', 1, 'smith.json');
  const project = isObject(root.project) ? root.project : {};
  const id = str(project, 'id', '', 'project'); const name = str(project, 'name', '', 'project'); str(project, 'description', '', 'project');
  if (!id) throw new PipelineError('smith.json: project.id is required');
  const repos = objects(root, 'repos').map((repo, i) => {
    const at = `repos[${i}]`; str(repo, 'name', 'main', at); str(repo, 'url', '', at); str(repo, 'checkoutDir', '.', at);
    return { primary: bool(repo, 'primary', false, at), defaultBranch: str(repo, 'defaultBranch', 'main', at) };
  });
  parseSelector(root.defaultNodeSelector, 'defaultNodeSelector');
  const products = objects(root, 'buildProducts').map((product, i): Product => {
    const at = `buildProducts[${i}]`;
    return { name: str(product, 'name', '', at), outputPath: str(product, 'outputPath', '', at), discover: parseDiscover(product.discover, `${at}.discover`),
      rules: objects(product, 'rules').map((rule, r) => parseRule(rule, `${at}.rules[${r}]`)) };
  });
  objects(root, 'triggers').forEach((trigger, i) => { const at = `triggers[${i}]`; str(trigger, 'type', '', at); int(trigger, 'intervalSeconds', 0, at); str(trigger, 'cron', '', at); str(trigger, 'product', '', at); });
  objects(root, 'chains').forEach((chain, i) => { const at = `chains[${i}]`; str(chain, 'name', '', at); str(chain, 'onFailure', '', at); });
  return { id, name, defaultBranch: (repos.find(repo => repo.primary) ?? repos[0])?.defaultBranch ?? 'main', products };
}

// SlugifyName: ASCII letters and digits lowercased, every other run of bytes (UTF-8 included) one '-'.
export function slugifyName(raw: string): string {
  let out = ''; let dash = false;
  for (const byte of new TextEncoder().encode(raw)) {
    const alnum = (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122);
    if (alnum) { out += String.fromCharCode(byte >= 65 && byte <= 90 ? byte + 32 : byte); dash = false; }
    else if (!dash && out) { out += '-'; dash = true; }
  }
  return out.replace(/-+$/, '') || 'build';
}
// GlobToRegex: '*' stays inside a path segment, '**' crosses '/', '?' is one non-'/' character;
// brackets and braces are literal. Anchored and case-sensitive.
export function globToRegex(glob: string): RegExp {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') { if (glob[i + 1] === '*') { re += '.*'; i++; } else re += '[^/]*'; }
    else if (c === '?') re += '[^/]';
    else if ('.()[]{}+^$|\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp(re + '$');
}
export function classifyVariant(name: string, spec: Discover): Variant {
  const variant: Variant = { name, slug: slugifyName(name), os: 'any', labels: [], preferOs: '' };
  for (const rule of spec.classify) {
    let matches = !rule.match;                       // an empty pattern is a catch-all
    if (!matches) { try { matches = new RegExp(rule.match).test(name); } catch { matches = false; } }
    if (matches) return { ...variant, os: rule.os || 'any', labels: [...rule.labels], preferOs: rule.preferOs };
  }
  return variant;
}
const byteOrder = (a: Variant, b: Variant) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
// Variants from the repository's tracked paths (forward slashes, relative to the root): one per
// file the glob matches, named by its stem (last extension removed); or the declared list.
export function discoverVariants(spec: Discover, paths: readonly string[]): Variant[] {
  const out: Variant[] = []; const seen = new Set<string>();
  if (spec.type === 'list') {
    for (const value of spec.values) if (value && !seen.has(value)) { seen.add(value); out.push(classifyVariant(value, spec)); }
  } else if (spec.type === 'files' && spec.glob) {
    let re: RegExp;
    try { re = globToRegex(spec.glob); } catch { return []; }
    for (const path of paths) {
      if (!re.test(path)) continue;
      const base = path.slice(path.lastIndexOf('/') + 1); const dot = base.lastIndexOf('.');
      const name = dot > 0 ? base.slice(0, dot) : base;
      if (name && !seen.has(name)) { seen.add(name); out.push(classifyVariant(name, spec)); }
    }
  }
  return out.sort(byteOrder);
}
// GlobMatch: '*' matches any run of characters (including '/'); everything else is literal.
// An empty pattern list matches every branch.
export function branchMatches(patterns: readonly string[], branch: string): boolean {
  if (!patterns.length) return true;
  return patterns.some(pattern => {
    let p = 0, q = 0, star = -1, mark = 0;
    while (q < branch.length) {
      if (p < pattern.length && pattern[p] === branch[q]) { p++; q++; }
      else if (p < pattern.length && pattern[p] === '*') { star = p++; mark = q; }
      else if (star !== -1) { p = star + 1; q = ++mark; }
      else return false;
    }
    while (p < pattern.length && pattern[p] === '*') p++;
    return p === pattern.length;
  });
}
// Subst: each ${KEY}, one key at a time in sorted key order; unknown tokens stay.
export function subst(text: string, vars: Record<string, string>): string {
  for (const key of Object.keys(vars).sort()) {
    const token = '${' + key + '}'; let pos = 0;
    while ((pos = text.indexOf(token, pos)) !== -1) { text = text.slice(0, pos) + vars[key] + text.slice(pos + token.length); pos += vars[key].length; }
  }
  return text;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/pipeline-parse.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add cloudflare/coordinator/src/pipeline.ts cloudflare/coordinator/test/pipeline-parse.test.ts
git commit --author="Claude Opus 5.5 <noreply@anthropic.com>" -m "Read smith.json in the Worker exactly as LAN Smith does" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Build actions and build-time resolution

**Files:**
- Modify: `cloudflare/coordinator/src/pipeline.ts` (append)
- Create: `cloudflare/coordinator/test/fixtures/smith-json/soccer-boy.json`, `senet.json`, `smith.json` (copies), `soccer-boy.paths.txt`, `soccer-boy.variants.txt`
- Test: `cloudflare/coordinator/test/pipeline.test.ts`

**Interfaces:**
- Consumes: Task 1 exports.
- Produces: `type Os = 'windows' | 'linux' | 'mac'`; `interface PipelineAction { id; label; product; rule; variant: string | null; os: Os[]; labels: string[]; notes: string[]; available: boolean }`; `interface Pipeline { projectId; name; actions: PipelineAction[]; unusedRules: number; disabledRules: number; warnings: string[] }`; `interface BuildContext { branch; commit; buildNumber }`; `interface ResolvedBuild { command: Command; steps: Command[]; workingDir; env; timeoutSeconds; successExitCodes: number[]; artifacts: string[] }`; `const MAX_ACTIONS = 100`; `ruleFor(product, branch)`; `mapPipeline(text, paths, branch, truncated?): Pipeline`; `resolveAction(text, paths, actionId, os, context): ResolvedBuild` (throws `PipelineError`).

- [ ] **Step 1: Create the fixtures**

From the repo root (bash):
```bash
F=cloudflare/coordinator/test/fixtures/smith-json; mkdir -p $F
cp /c/code/soccer-boy/smith.json $F/soccer-boy.json
cp /c/code/kemetic/senet/smith.json $F/senet.json
git show origin/feature/cloudflare-experiment:smith.json > $F/smith.json
```
Never open other files under `C:\code\kemetic` (it holds secrets). Then write `$F/soccer-boy.paths.txt` exactly (LF line endings):
```
Assets/Settings/Build Profiles.meta
Assets/Settings/Build Profiles/App Store (Mac).asset
Assets/Settings/Build Profiles/App Store (Mac).asset.meta
Assets/Settings/Build Profiles/App Store (iOS).asset
Assets/Settings/Build Profiles/App Store (iOS).asset.meta
Assets/Settings/Build Profiles/Demo Steam (Mac).asset
Assets/Settings/Build Profiles/Demo Steam (Windows).asset
Assets/Settings/Build Profiles/Jamaine - Demo Build (Mac).asset
Assets/Settings/Build Profiles/Jamaine - Demo Build.asset
Assets/Settings/Build Profiles/Jamaine - Demo Steam (Mac).asset
Assets/Settings/Build Profiles/Jamaine - Demo Steam.asset
Assets/Settings/Build Profiles/No Steam (Linux).asset
Assets/Settings/Build Profiles/No Steam (Mac).asset
Assets/Settings/Build Profiles/No Steam (Windows).asset
Assets/Settings/Build Profiles/Sebastian - Demo Build.asset
Assets/Settings/Build Profiles/Steam (Linux).asset
Assets/Settings/Build Profiles/Steam (Mac).asset
Assets/Settings/Build Profiles/Steam (Windows).asset
Assets/Settings/Build Profiles/Steam (Windows).asset.meta
ProjectSettings/ProjectVersion.txt
smith.json
tools/smith-build.ps1
tools/smith-build.sh
```
and `$F/soccer-boy.variants.txt` (`product|name|slug|os|labels`, the order `discoverVariants` must produce):
```
unity|App Store (Mac)|app-store-mac|mac|
unity|App Store (iOS)|app-store-ios|mac|unity-ios
unity|Demo Steam (Mac)|demo-steam-mac|mac|
unity|Demo Steam (Windows)|demo-steam-windows|windows|
unity|Jamaine - Demo Build|jamaine-demo-build|windows|
unity|Jamaine - Demo Build (Mac)|jamaine-demo-build-mac|mac|
unity|Jamaine - Demo Steam|jamaine-demo-steam|windows|
unity|Jamaine - Demo Steam (Mac)|jamaine-demo-steam-mac|mac|
unity|No Steam (Linux)|no-steam-linux|any|unity-linux-il2cpp
unity|No Steam (Mac)|no-steam-mac|mac|
unity|No Steam (Windows)|no-steam-windows|windows|
unity|Sebastian - Demo Build|sebastian-demo-build|windows|
unity|Steam (Linux)|steam-linux|any|unity-linux-il2cpp
unity|Steam (Mac)|steam-mac|mac|
unity|Steam (Windows)|steam-windows|windows|
```

- [ ] **Step 2: Write the failing tests**

`cloudflare/coordinator/test/pipeline.test.ts`:
```ts
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
    expect([soccer, senet, smith].map(text => parseSmithJson(text).products.length)).toEqual([5, 6, 5]);
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
    expect(pipeline.actions.map(a => [a.id, a.os.join()])).toEqual([['self-release', 'windows'], ['build-experiment', 'windows,linux,mac'], ['build', 'windows,linux,mac'], ['test', 'windows,linux,mac'], ['tray', 'windows,mac']]);
    expect(pipeline.actions.find(a => a.id === 'tray')!.labels).toEqual(['una-engine', 'wxwidgets']);
    expect(mapPipeline(smith, [], 'main').unusedRules).toBe(1);
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/pipeline.test.ts`
Expected: FAIL — `mapPipeline` / `resolveAction` are not exported.

- [ ] **Step 4: Append to `src/pipeline.ts`**

```ts
// ---- Build actions: what a project offers on a branch, and what a build runs ----

export type Os = 'windows' | 'linux' | 'mac';
const OSES: Os[] = ['windows', 'linux', 'mac'];
export const MAX_ACTIONS = 100;
export interface PipelineAction { id: string; label: string; product: string; rule: string; variant: string | null; os: Os[]; labels: string[]; notes: string[]; available: boolean }
export interface Pipeline { projectId: string; name: string; actions: PipelineAction[]; unusedRules: number; disabledRules: number; warnings: string[] }
export interface BuildContext { branch: string; commit: string; buildNumber: number }
export interface ResolvedBuild { command: Command; steps: Command[]; workingDir: string; env: Record<string, string>; timeoutSeconds: number; successExitCodes: number[]; artifacts: string[] }

// The rule LAN Smith runs for a product on a branch: the first enabled one whose branches match.
export function ruleFor(product: Product, branch: string): Rule | undefined { return product.rules.find(rule => rule.enabled && branchMatches(rule.branches, branch)); }

interface Candidate { id: string; product: Product; rule: Rule; variant: Variant | null }
// Every product (and discovered variant) buildable on the branch, with a stable action ID: the
// slugged product name, plus "/<variant slug>" for a variant; a clash gets "-2", "-3"...
function candidates(config: SmithConfig, paths: readonly string[], branch: string): Candidate[] {
  const out: Candidate[] = []; const ids = new Set<string>();
  for (const product of config.products) {
    const rule = ruleFor(product, branch);
    if (!rule) continue;
    const variants = discoverVariants(product.discover, paths);
    for (const variant of variants.length ? variants : [null]) {
      const base = slugifyName(product.name) + (variant ? '/' + variant.slug : '');
      let id = base;
      for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
      ids.add(id); out.push({ id, product, rule, variant });
    }
  }
  return out;
}
// The node selector a variant build dispatches with (CoordinatorJobs.cpp): the variant's OS wins
// unless it is "any", its labels are added, its preferred OS wins when set.
function selectorFor(rule: Rule, variant: Variant | null): Selector {
  const selector: Selector = { os: rule.nodeSelector.os, labels: [...rule.nodeSelector.labels], preferOs: rule.nodeSelector.preferOs };
  if (variant) {
    if (variant.os && variant.os !== 'any') selector.os = variant.os;
    selector.labels.push(...variant.labels);
    if (variant.preferOs) selector.preferOs = variant.preferOs;
  }
  return selector;
}
function platforms(rule: Rule, selector: Selector): Os[] {
  const wanted = selector.os.toLowerCase();
  return OSES.filter(os => Boolean(rule.stepsByOs[os] || rule.commandByOs[os]) && (!wanted || wanted === 'any' || wanted === os));
}
// Hosted builds upload at most four exact files with package "none". Globs, zip packaging and
// LAN's default "${OUTPUT}/**" zip (a product with an outputPath and no globs) are not collected.
function collected(product: Product, rule: Rule, vars?: Record<string, string>): string[] | null {
  if (!rule.artifacts.globs.length) return product.outputPath ? null : [];
  if (!['', 'none'].includes(rule.artifacts.package) || rule.artifacts.globs.length > 4) return null;
  const globs = rule.artifacts.globs.map(glob => vars ? subst(glob, vars) : glob);
  if (globs.some(glob => /[*?]/.test(glob) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(glob.split('/').at(-1) ?? ''))) return null;
  return globs;
}
function describe(candidate: Candidate): PipelineAction {
  const { id, product, rule, variant } = candidate;
  const selector = selectorFor(rule, variant); const os = platforms(rule, selector); const notes: string[] = [];
  const handoffs = rule.handoff.filter(step => step.type !== 'collect').map(step => step.type || step.name || 'unnamed');
  if (handoffs.length) notes.push(`Handoff not run in hosted builds: ${handoffs.join(', ')}`);
  if (collected(product, rule) === null) notes.push('Artifacts are not collected here yet (globs or zip packaging)');
  if (rule.inputs.length) notes.push(`Needs artifacts from ${rule.inputs.map(input => input.variant ? `${input.product} / ${input.variant}` : input.product).join(', ')}, which hosted builds cannot provide yet`);
  if (!os.length) notes.push('No command for Windows, Linux or macOS');
  return { id, label: [product.name, rule.name, variant?.name].filter(Boolean).join(' · '), product: product.name, rule: rule.name, variant: variant?.name ?? null,
    os, labels: [...new Set(selector.labels)], notes, available: !rule.inputs.length && os.length > 0 };
}
export function mapPipeline(text: string, paths: readonly string[], branch: string, truncated = false): Pipeline {
  const config = parseSmithJson(text);
  const all = candidates(config, paths, branch);
  const used = new Set(all.map(candidate => candidate.rule));
  const rules = config.products.flatMap(product => product.rules);
  const warnings: string[] = [];
  if (truncated && config.products.some(product => product.discover.type === 'files')) warnings.push('The repository file list was cut short, so some discovered variants may be missing');
  if (all.length > MAX_ACTIONS) warnings.push(`Only the first ${MAX_ACTIONS} of ${all.length} build actions are offered`);
  return { projectId: config.id, name: config.name || config.id, actions: all.slice(0, MAX_ACTIONS).map(describe),
    unusedRules: rules.filter(rule => rule.enabled && !used.has(rule)).length, disabledRules: rules.filter(rule => !rule.enabled).length, warnings };
}
// What a build of `actionId` runs on `os` at the checked-out commit (Coordinator::ResolveJobSpec).
export function resolveAction(text: string, paths: readonly string[], actionId: string, os: string, context: BuildContext): ResolvedBuild {
  const config = parseSmithJson(text);
  const candidate = candidates(config, paths, context.branch).slice(0, MAX_ACTIONS).find(item => item.id === actionId);
  if (!candidate) throw new PipelineError(`${actionId} is not in smith.json at ${context.commit.slice(0, 12)} on ${context.branch}`);
  const { product, rule, variant } = candidate;
  if (rule.inputs.length) throw new PipelineError(`${actionId} needs artifacts from other builds, which hosted builds cannot provide yet`);
  const steps = rule.stepsByOs[os]; const single = rule.commandByOs[os];
  if (!steps && !single) throw new PipelineError(`${actionId} has no ${os} command at ${context.commit.slice(0, 12)}`);
  const vars: Record<string, string> = { BUILD_NUMBER: String(context.buildNumber), BRANCH: context.branch, COMMIT: context.commit, COMMIT_SHORT: context.commit.slice(0, 7), PROJECT_ID: config.id };
  if (variant) { vars[product.discover.as] = variant.name; vars[product.discover.as + '_SLUG'] = variant.slug; }
  vars.OUTPUT = product.outputPath ? subst(product.outputPath, vars) : '';
  const command = (step: Command): Command => ({ interpreter: step.interpreter, script: step.script, args: step.args.map(arg => subst(arg, vars)) });
  const resolvedSteps = steps ? steps.map(command) : [];
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(rule.env)) env[key] = subst(value, vars);
  Object.assign(env, { SMITH_BUILD_NUMBER: String(context.buildNumber), SMITH_BRANCH: context.branch, SMITH_COMMIT: context.commit, SMITH_PROJECT: config.id });
  return { command: resolvedSteps[0] ?? command(single!), steps: resolvedSteps, workingDir: rule.workingDir, env,
    timeoutSeconds: Math.min(Math.max(rule.timeoutSeconds, 0), 86400), successExitCodes: rule.successExitCodes, artifacts: collected(product, rule, vars) ?? [] };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/pipeline.test.ts test/pipeline-parse.test.ts`
Expected: PASS. If a senet/smith expectation fails, open the fixture and check the rule's `branches`/`nodeSelector` before changing code — the fixture is the truth; fix the expectation only if the fixture disagrees with this plan's reading of it, and say so in the commit message.

- [ ] **Step 6: Commit**

```bash
git add cloudflare/coordinator/src/pipeline.ts cloudflare/coordinator/test/pipeline.test.ts cloudflare/coordinator/test/fixtures/smith-json
git commit --author="Claude Opus 5.5 <noreply@anthropic.com>" -m "Offer smith.json build actions and resolve them at a commit" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: C++ parity test over the shared fixtures

**Files:**
- Modify: `Tests/SmithCoreTest/Main.cpp` (insert after the `// ---- Variant discovery` block, before `// ---- Agent capability label detection ----`)

**Interfaces:**
- Consumes: Task 2 fixtures; `Smith::ParseProjectConfig(text, ProjectDef&, error)`, `Smith::DiscoverVariants(baseDir, DiscoverSpec)`, `ProjectDef::products`, `BuildProductDef::{name, discover}`, `ProductVariant::{name, slug, os, labels}`.

- [ ] **Step 1: Add the test block**

```cpp
    // ---- smith.json parity with the hosted coordinator (cloudflare/coordinator/src/pipeline.ts) ----
    // The TypeScript reader is tested against these same fixtures; both must agree.
    {
        namespace fs = std::filesystem;
        std::error_code ec3;
        const fs::path fixtures = fs::path("cloudflare") / "coordinator" / "test" / "fixtures" / "smith-json";
        auto slurp = [](const fs::path& p) { std::ifstream in(p, std::ios::binary); std::stringstream s; s << in.rdbuf(); return s.str(); };
        const std::pair<const char*, int> productCounts[] = { { "soccer-boy", 5 }, { "senet", 6 }, { "smith", 5 } };
        for (const auto& [name, count] : productCounts) {
            Smith::ProjectDef def; std::string error;
            ASSERT_TRUE(Smith::ParseProjectConfig(slurp(fixtures / (std::string(name) + ".json")), def, error));
            ASSERT_EQ_INT((int)def.products.size(), count);
        }
        // soccer-boy's Unity build profiles, discovered from its fixture file list.
        Smith::ProjectDef soccer; std::string error;
        ASSERT_TRUE(Smith::ParseProjectConfig(slurp(fixtures / "soccer-boy.json"), soccer, error));
        const fs::path tree = fs::temp_directory_path() / "smith-parity-soccer-boy";
        fs::remove_all(tree, ec3);
        std::istringstream paths(slurp(fixtures / "soccer-boy.paths.txt"));
        for (std::string line; std::getline(paths, line);) {
            if (!line.empty() && line.back() == '\r') line.pop_back();
            if (line.empty()) continue;
            fs::create_directories((tree / line).parent_path(), ec3);
            std::ofstream(tree / line) << "x";
        }
        std::vector<std::string> expected, actual;
        std::istringstream wanted(slurp(fixtures / "soccer-boy.variants.txt"));
        for (std::string line; std::getline(wanted, line);) { if (!line.empty() && line.back() == '\r') line.pop_back(); if (!line.empty()) expected.push_back(line); }
        for (const auto& product : soccer.products)
            for (const auto& v : Smith::DiscoverVariants(tree.string(), product.discover)) {
                std::string labels; for (const auto& l : v.labels) labels += (labels.empty() ? "" : ",") + l;
                actual.push_back(product.name + "|" + v.name + "|" + v.slug + "|" + v.os + "|" + labels);
            }
        ASSERT_EQ_INT((int)actual.size(), (int)expected.size());
        for (size_t i = 0; i < actual.size() && i < expected.size(); ++i) ASSERT_EQ_STR(actual[i], expected[i]);
        fs::remove_all(tree, ec3);
    }
```

- [ ] **Step 2: Build and run the C++ tests**

Run (repo root, PowerShell): `.\RunTests.ps1`
Expected: every project passes, including `SmithCoreTest` (RunTests runs each exe with the repo root as the working directory, so the relative fixture path resolves). If `SmithCoreTest` fails on a variant line, the TypeScript port and LAN disagree: fix `src/pipeline.ts` (not the C++ side) and re-run Task 2's tests.

- [ ] **Step 3: Commit**

```bash
git add Tests/SmithCoreTest/Main.cpp
git commit --author="Claude Opus 5.5 <noreply@anthropic.com>" -m "Check LAN Smith reads the hosted smith.json fixtures the same way" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Contracts, request size and the GitHub token setting

**Files:**
- Modify: `cloudflare/coordinator/src/contracts.ts`, `cloudflare/coordinator/src/http.ts`, `cloudflare/coordinator/src/settings.ts`
- Test: `cloudflare/coordinator/test/settings.test.ts` (append a `describe`)

**Interfaces:**
- Produces: `JobKind = 'build' | 'mirror' | 'scan'`; `interface ResolveSpec { action: string }`; `ResolvedJobSpec.resolve?: ResolveSpec`; `interface ScanReport { commit: string; branch: string; smithJson: string | null; paths: string[]; truncated: boolean }`; `JobResult.commit?: string; JobResult.failure?: 'repo_access'`; `readBody(request, maxBytes = 65536)`; workspace secret `'githubToken'` (`publicSettings` then exposes `githubTokenSet`/`githubTokenUpdatedAt` automatically).

- [ ] **Step 1: Write the failing tests** (append to `test/settings.test.ts`)

```ts
describe('GitHub token setting', () => {
  it('accepts fine-grained and classic tokens, keeps them write-only, and never sends them to jobs', () => {
    const fine = 'github_pat_' + 'A1b2'.repeat(10);
    const update = validateWorkspaceSettings({ githubToken: ` ${fine} ` }, DEFAULT_WORKSPACE_SETTINGS);
    expect(update.secrets).toEqual({ githubToken: fine });
    expect(validateWorkspaceSettings({ githubToken: 'ghp_' + 'x'.repeat(36) }, DEFAULT_WORKSPACE_SETTINGS).secrets.githubToken).toBe('ghp_' + 'x'.repeat(36));
    expect(validateWorkspaceSettings({ githubToken: '' }, DEFAULT_WORKSPACE_SETTINGS).secrets).toEqual({});
    expect(validateWorkspaceSettings({ clearGithubToken: true }, DEFAULT_WORKSPACE_SETTINGS).secrets).toEqual({ githubToken: null });
    expect(() => validateWorkspaceSettings({ githubToken: 'not-a-token' }, DEFAULT_WORKSPACE_SETTINGS)).toThrow('does not look like a GitHub token');
    expect(() => validateWorkspaceSettings({ githubToken: fine, clearGithubToken: true }, DEFAULT_WORKSPACE_SETTINGS)).toThrow('either a new token or clearing');
    expect(workspaceJobEnv(DEFAULT_WORKSPACE_SETTINGS, { githubToken: fine })).toEqual({});
  });
  it('still validates the Cloudflare token the same way', () => {
    expect(() => validateWorkspaceSettings({ cloudflareApiToken: 'short' }, DEFAULT_WORKSPACE_SETTINGS)).toThrow('does not look like a Cloudflare API token');
    expect(() => validateWorkspaceSettings({ clearCloudflareApiToken: 'yes' }, DEFAULT_WORKSPACE_SETTINGS)).toThrow('Invalid field: clearCloudflareApiToken');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/settings.test.ts`
Expected: FAIL — `Unsupported field: githubToken`.

- [ ] **Step 3: Implement**

`src/contracts.ts` — replace the `JobKind` line and extend the interfaces:
```ts
export type JobKind = 'build' | 'mirror' | 'scan';
// A build of a repository project's branch tip: after checkout the agent posts a ScanReport to
// /resolve and receives the command smith.json defines for `action` at that commit.
export interface ResolveSpec { action: string }
// What a machine (or the GitHub reader) found in a repository at one commit.
export interface ScanReport { commit: string; branch: string; smithJson: string | null; paths: string[]; truncated: boolean }
```
In `ResolvedJobSpec` add after `mirror?: MirrorSpec;`:
```ts
  resolve?: ResolveSpec;
```
Replace the `JobResult` line:
```ts
// commit: what a branch-tip build or scan checked out. failure "repo_access": this machine's Git
// login cannot read the repository, so the job goes back to the queue for another machine.
export interface JobResult { status: 'success' | 'failed' | 'error'; exitCode: number; durationMs: number; message: string; commit?: string; failure?: 'repo_access' }
```

`src/http.ts` — replace the `readBody` signature and size check:
```ts
export async function readBody(request: Request, maxBytes = 65536): Promise<Record<string, unknown>> {
```
```ts
      if (size > maxBytes) { await reader.cancel(); fail(413, 'body_too_large', `Maximum request size is ${Math.round(maxBytes / 1024)} KiB`); }
```

`src/settings.ts`:
```ts
export const WORKSPACE_SECRETS = ['cloudflareApiToken', 'githubToken'] as const;
```
Replace the whole body of `validateWorkspaceSettings` from `const secrets: WorkspaceSettingsUpdate['secrets'] = {};` through the closing of the Cloudflare `if ('cloudflareApiToken' in body) { … }` block with:
```ts
  const secrets: WorkspaceSettingsUpdate['secrets'] = {};
  secretField(body, secrets, 'cloudflareApiToken', /^[A-Za-z0-9_\-.]{20,256}$/, 'That does not look like a Cloudflare API token');
  // Read-only GitHub access for reading smith.json when a project is added; never given to jobs.
  secretField(body, secrets, 'githubToken', /^(?:github_pat_[A-Za-z0-9_]{20,250}|gh[pousr]_[A-Za-z0-9]{20,250})$/, 'That does not look like a GitHub token (github_pat_… or ghp_…)');
```
and change its `fields(...)` call to:
```ts
  fields(body, [...Object.keys(DEFAULT_WORKSPACE_SETTINGS), 'cloudflareApiToken', 'clearCloudflareApiToken', 'githubToken', 'clearGithubToken']);
```
Add above `validateWorkspaceSettings`:
```ts
// A write-only secret: a blank value keeps the stored one, clear<Name>: true removes it.
function secretField(body: Record<string, unknown>, secrets: WorkspaceSettingsUpdate['secrets'], name: WorkspaceSecret, pattern: RegExp, invalid: string): void {
  const clear = 'clear' + name[0].toUpperCase() + name.slice(1);
  if (body[clear] === true) secrets[name] = null;
  else if (clear in body && body[clear] !== false) fail(400, 'invalid_field', `Invalid field: ${clear}`);
  if (!(name in body)) return;
  const value = body[name];
  if (typeof value !== 'string' || value.length > 256) fail(400, 'invalid_field', `Invalid field: ${name}`);
  const token = value.trim();
  if (!token) return;                              // blank = keep the stored token
  if (!pattern.test(token)) fail(400, 'invalid_field', invalid);
  if (secrets[name] === null) fail(400, 'invalid_field', 'Choose either a new token or clearing the token');
  secrets[name] = token;
}
```
`workspaceJobEnv` stays as it is (it only reads `cloudflareApiToken`); add one comment line above it: `// The GitHub token is deliberately absent: it is used only by the coordinator to read smith.json.`

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/settings.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add cloudflare/coordinator/src/contracts.ts cloudflare/coordinator/src/http.ts cloudflare/coordinator/src/settings.ts cloudflare/coordinator/test/settings.test.ts
git commit --author="Claude Opus 5.5 <noreply@anthropic.com>" -m "Add the scan job contract and a write-only GitHub token setting" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: GitHub reader (fast path)

**Files:**
- Create: `cloudflare/coordinator/src/github-reader.ts`
- Modify: `cloudflare/coordinator/vitest.config.ts`
- Test: `cloudflare/coordinator/test/github-reader.test.ts`

**Interfaces:**
- Consumes: `ScanReport` (Task 4).
- Produces: `class GitHubReadError extends Error`; `githubRepo(url): { owner: string; repo: string } | null`; `readGitHub(url, branch, token, timeoutMs = 5000): Promise<ScanReport>`; `fakeGitHub { repos: Map<string, { defaultBranch: string; branches: Record<string, Omit<ScanReport, 'branch'>> }>; failNext: string | null; reset(): void }`; `githubReader(env: { GITHUB_MODE?: string }): typeof readGitHub`.

- [ ] **Step 1: Write the failing tests**

`cloudflare/coordinator/test/github-reader.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubReadError, githubRepo, readGitHub } from '../src/github-reader';

afterEach(() => vi.restoreAllMocks());
const sha = 'b'.repeat(40);
function fakeApi(routes: Record<string, () => Response>) {
  const seen: Request[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);   // reject what real fetch rejects (e.g. redirect: 'error')
    seen.push(request);
    const route = routes[new URL(request.url).pathname + new URL(request.url).search];
    return route ? route() : new Response('{"message":"Not Found"}', { status: 404 });
  });
  return seen;
}

describe('GitHub fast path', () => {
  it('recognises GitHub HTTPS, scp and ssh URLs only', () => {
    expect(githubRepo('https://github.com/Red-Marmoset/senet.git')).toEqual({ owner: 'Red-Marmoset', repo: 'senet' });
    expect(githubRepo('git@github.com:Red-Marmoset/senet.git')).toEqual({ owner: 'Red-Marmoset', repo: 'senet' });
    expect(githubRepo('ssh://git@github.com/Red-Marmoset/smith')).toEqual({ owner: 'Red-Marmoset', repo: 'smith' });
    expect(githubRepo('https://gitlab.com/a/b.git')).toBeNull();
  });
  it('reads the default branch, its tip, the file list and smith.json', async () => {
    const seen = fakeApi({
      '/repos/o/r': () => Response.json({ default_branch: 'master' }),
      '/repos/o/r/commits/master': () => new Response(sha),
      [`/repos/o/r/git/trees/${sha}?recursive=1`]: () => Response.json({ truncated: false, tree: [{ path: 'smith.json', type: 'blob' }, { path: 'src', type: 'tree' }, { path: 'src/a.ts', type: 'blob' }] }),
      [`/repos/o/r/contents/smith.json?ref=${sha}`]: () => new Response('{"project":{"id":"r"}}'),
    });
    expect(await readGitHub('git@github.com:o/r.git', '', 'tok')).toEqual({ commit: sha, branch: 'master', smithJson: '{"project":{"id":"r"}}', paths: ['smith.json', 'src/a.ts'], truncated: false });
    expect(seen.every(request => request.redirect === 'manual' && request.headers.get('Authorization') === 'Bearer tok')).toBe(true);
  });
  it('keeps slashes in branch names and reports a missing smith.json as null', async () => {
    fakeApi({
      '/repos/o/r/commits/feature/x': () => new Response(sha),
      [`/repos/o/r/git/trees/${sha}?recursive=1`]: () => Response.json({ truncated: true, tree: [{ path: 'README.md', type: 'blob' }] }),
    });
    expect(await readGitHub('https://github.com/o/r', 'feature/x', 'tok')).toEqual({ commit: sha, branch: 'feature/x', smithJson: null, paths: ['README.md'], truncated: true });
  });
  it('fails with the GitHub status so the caller can fall back to a machine', async () => {
    fakeApi({});
    await expect(readGitHub('https://github.com/o/r', 'main', 'tok')).rejects.toThrow(new GitHubReadError('GitHub answered 404 for branch main'));
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/github-reader.test.ts`
Expected: FAIL — cannot resolve `../src/github-reader`.

- [ ] **Step 3: Implement `src/github-reader.ts`**

```ts
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
  let smithJson: string | null = null;
  if (paths.includes('smith.json')) {
    const file = await get(`/contents/smith.json?ref=${commit}`, 'application/vnd.github.raw+json');
    if (!file.ok) throw new GitHubReadError(`GitHub answered ${file.status} for smith.json`);
    smithJson = await file.text();
    if (smithJson.length > 262144) throw new GitHubReadError('smith.json is larger than 256 KiB');
  }
  return { commit, branch: name, smithJson, paths: paths.slice(0, MAX_PATHS), truncated: listing.truncated === true || paths.length > MAX_PATHS };
}

// ---- Test double (GITHUB_MODE=fake): repositories keyed "owner/repo" ----
export const fakeGitHub = {
  repos: new Map<string, { defaultBranch: string; branches: Record<string, Omit<ScanReport, 'branch'>> }>(),
  failNext: null as string | null,
  reset(): void { this.repos.clear(); this.failNext = null; },
};
async function readFake(url: string, branch: string, _token: string): Promise<ScanReport> {
  if (fakeGitHub.failNext) { const message = fakeGitHub.failNext; fakeGitHub.failNext = null; throw new GitHubReadError(message); }
  const target = githubRepo(url);
  const repo = target ? fakeGitHub.repos.get(`${target.owner}/${target.repo}`) : undefined;
  if (!repo) throw new GitHubReadError('GitHub answered 404 for the repository');
  const name = branch || repo.defaultBranch;
  const found = repo.branches[name];
  if (!found) throw new GitHubReadError(`GitHub answered 404 for branch ${name}`);
  return { ...found, branch: name };
}
export function githubReader(env: { GITHUB_MODE?: string }): typeof readGitHub { return env.GITHUB_MODE === 'fake' ? readFake : readGitHub; }
```

`vitest.config.ts` — change the bindings to:
```ts
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' }, miniflare: { bindings: { ARTIFACTS_MODE: 'fake', GITHUB_MODE: 'fake' } } })],
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/github-reader.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cloudflare/coordinator/src/github-reader.ts cloudflare/coordinator/test/github-reader.test.ts cloudflare/coordinator/vitest.config.ts
git commit --author="Claude Opus 5.5 <noreply@anthropic.com>" -m "Read smith.json through the GitHub API with a workspace token" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Repository project model

**Files:**
- Create: `cloudflare/coordinator/src/repo-projects.ts`
- Test: `cloudflare/coordinator/test/repo-projects-model.test.ts`

**Interfaces:**
- Consumes: `fail`, `fields`, `object`, `string` (http.ts); `smokeSpec`, `ResolvedJobSpec`, `ScanReport` (contracts.ts); `mapPipeline`, `resolveAction`, `slugifyName`, `PipelineError`, `PipelineAction` (pipeline.ts).
- Produces: `REPO_LABEL = 'smith-repo-projects'`; `ACCESS_TTL_MS = 3600000`; `SCAN_PRODUCT = 'read-smith-json'`; `REPO_ACCESS_SCHEMA`; `ACCESS_FILTER`; types `ScanState`, `RepoProject`, `AccessDenial`; `isRepoProject(value)`; `validBranch(branch)`; `validateRepoUrl(url)`; `repoName(url)`; `newProjectId(url, taken)`; `createRepoProject(body, taken, now)`; `applyReport(project, report, via, host, now)`; `scanSpecs(project, jobId)`; `repoBuildSpecs(project, actionId, jobId, buildNumber)`; `resolveBuildSpec(spec, report, branch, os)`; `validateScanReport(value)`; `publicRepoProject(project, scanJob, denials)`; `class RepoAccess { deny; clear; denials }`.

- [ ] **Step 1: Write the failing tests**

`cloudflare/coordinator/test/repo-projects-model.test.ts`:
```ts
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
    expect(ready).toMatchObject({ branch: 'master', commit, name: 'senet', scan: { state: 'ready', via: 'github' }, unusedRules: 5 });
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/repo-projects-model.test.ts`
Expected: FAIL — cannot resolve `../src/repo-projects`.

- [ ] **Step 3: Implement `src/repo-projects.ts`**

```ts
// Projects added from a Git URL ("repository projects"). Smith reads the repository's smith.json
// (src/pipeline.ts) and builds the branch tip; the workspace Durable Object stores them beside
// operator-prepared projects (src/projects.ts). Pure helpers, plus RepoAccess for the SQL that
// keeps work away from machines that cannot read a repository.
import { fail, fields, object, string } from './http';
import { smokeSpec, type ResolvedJobSpec, type ScanReport } from './contracts';
import { PipelineError, mapPipeline, resolveAction, slugifyName, type PipelineAction } from './pipeline';

export const REPO_LABEL = 'smith-repo-projects';        // only agents that can scan and resolve advertise it
export const ACCESS_TTL_MS = 60 * 60 * 1000;            // a "no access" mark expires after an hour
export const SCAN_PRODUCT = 'read-smith-json';
export const REPO_ACCESS_SCHEMA = 'CREATE TABLE IF NOT EXISTS repo_access (project_id TEXT NOT NULL, node_id TEXT NOT NULL, message TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (project_id, node_id))';
// Claim filter: skip a queued job whose project this node recently could not read. Parameters: node ID, cutoff time.
export const ACCESS_FILTER = 'AND NOT EXISTS (SELECT 1 FROM repo_access a WHERE a.project_id = jobs.project_id AND a.node_id = ? AND a.at > ?)';

export interface ScanState { state: 'waiting' | 'scanning' | 'ready' | 'error'; message: string; via: 'github' | 'machine' | null; host: string | null; jobId: string | null; at: number }
export interface RepoProject {
  kind: 'repo'; id: string; name: string; customName: boolean; repoUrl: string; source: 'git'; branch: string; commit: string | null;
  scan: ScanState; actions: PipelineAction[]; unusedRules: number; disabledRules: number; warnings: string[]; createdAt: number;
}
export interface AccessDenial { host: string; message: string; at: number }
export function isRepoProject(value: unknown): value is RepoProject { return (value as { kind?: unknown } | null | undefined)?.kind === 'repo'; }

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/;
const COMMIT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
export function validBranch(branch: string): boolean { return branch === '' || (branch.length <= 256 && BRANCH.test(branch) && !branch.includes('..')); }

// HTTPS, ssh:// or scp-style user@host:path - never a password, whitespace or control character.
export function validateRepoUrl(value: string): string {
  const url = value.trim();
  const ok = url.length <= 256 && !/[\s\x00-\x1f\x7f\\]/.test(url) && (
    /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[^@]+$/.test(url) ||
    /^ssh:\/\/(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+(?::\d+)?\/[^@]+$/.test(url) ||
    /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^/@][^@]*$/.test(url));
  if (!ok) fail(400, 'invalid_repository', 'Use an https://, ssh:// or git@host:owner/repo URL without a password');
  return url;
}
export function repoName(url: string): string { return (url.replace(/\/+$/, '').split(/[/:]/).at(-1) ?? '').replace(/\.git$/i, '') || 'project'; }
export function newProjectId(url: string, taken: ReadonlySet<string>): string {
  const slug = slugifyName(repoName(url)).slice(0, 56);
  const base = slug === 'smoke' ? 'smoke-repo' : slug;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}
export function createRepoProject(body: Record<string, unknown>, taken: ReadonlySet<string>, now: number): RepoProject {
  fields(body, ['source', 'url', 'branch', 'name']);
  if (body.source !== 'git') fail(400, 'invalid_source', 'Unsupported project source');
  const repoUrl = validateRepoUrl(string(body, 'url', 256));
  if (body.branch !== undefined && typeof body.branch !== 'string') fail(400, 'invalid_field', 'Invalid field: branch');
  const branch = typeof body.branch === 'string' ? body.branch.trim() : '';
  if (!validBranch(branch)) fail(400, 'invalid_branch', 'Invalid branch name');
  const customName = typeof body.name === 'string' && body.name.trim() !== '';
  const name = customName ? string(body, 'name', 128).trim() : repoName(repoUrl);
  return { kind: 'repo', id: newProjectId(repoUrl, taken), name, customName, repoUrl, source: 'git', branch, commit: null,
    scan: { state: 'waiting', message: '', via: null, host: null, jobId: null, at: now }, actions: [], unusedRules: 0, disabledRules: 0, warnings: [], createdAt: now };
}
// Apply what a reader found. A blank branch becomes the one the reader used (the repo's default).
export function applyReport(project: RepoProject, report: ScanReport, via: 'github' | 'machine', host: string | null, now: number): RepoProject {
  const branch = project.branch || report.branch;
  const base: RepoProject = { ...project, branch, commit: report.commit, scan: { ...project.scan, via, host, at: now } };
  const failed = (message: string): RepoProject => ({ ...base, actions: [], unusedRules: 0, disabledRules: 0, warnings: [], scan: { ...base.scan, state: 'error', message } });
  if (report.smithJson === null) return failed(`No smith.json at ${report.commit.slice(0, 12)} on ${branch}. Projects without one are not supported yet.`);
  try {
    const pipeline = mapPipeline(report.smithJson, report.paths, branch, report.truncated);
    return { ...base, name: project.customName ? project.name : pipeline.name, actions: pipeline.actions, unusedRules: pipeline.unusedRules,
      disabledRules: pipeline.disabledRules, warnings: pipeline.warnings, scan: { ...base.scan, state: 'ready', message: '' } };
  } catch (error) {
    if (error instanceof PipelineError) return failed(error.message);
    throw error;
  }
}
const repo = (project: RepoProject) => ({ name: 'main', url: project.repoUrl, branch: project.branch, commit: '', checkoutDir: '.', authToken: '' });
const NO_COMMAND = { interpreter: '', script: '', args: [] as string[] };
// A scan for every OS: any updated agent may read the repository with its own Git login.
export function scanSpecs(project: RepoProject, jobId: string): Record<string, ResolvedJobSpec> {
  const specs: Record<string, ResolvedJobSpec> = {};
  for (const os of ['windows', 'linux', 'mac']) specs[os] = { ...smokeSpec(jobId, os), kind: 'scan', projectId: project.id, buildNumber: 0, timeoutSeconds: 600, command: NO_COMMAND, repos: [repo(project)] };
  return specs;
}
// A branch-tip build for the action's platforms; the command arrives at /resolve after checkout.
export function repoBuildSpecs(project: RepoProject, actionId: string, jobId: string, buildNumber: number): { specs: Record<string, ResolvedJobSpec>; labels: string[] } {
  const action = project.actions.find(item => item.id === actionId);
  if (!action) fail(400, 'unknown_product', project.scan.state === 'ready' ? 'That build action is not in this project' : "This project's build actions are not known yet");
  if (!action.available) fail(409, 'action_unavailable', action.notes.join(' ') || 'This build action cannot run here');
  const specs: Record<string, ResolvedJobSpec> = {};
  for (const os of action.os) specs[os] = { ...smokeSpec(jobId, os), kind: 'build', projectId: project.id, buildNumber, timeoutSeconds: 0, command: NO_COMMAND, repos: [repo(project)], resolve: { action: action.id } };
  return { specs, labels: [...action.labels, REPO_LABEL] };
}
// The stored spec, completed with what smith.json defines at the checked-out commit.
export function resolveBuildSpec(spec: ResolvedJobSpec, report: ScanReport, branch: string, os: string): ResolvedJobSpec {
  if (!spec.resolve) throw new PipelineError('This build has nothing to resolve');
  if (report.smithJson === null) throw new PipelineError(`No smith.json at ${report.commit.slice(0, 12)} on ${branch}`);
  const build = resolveAction(report.smithJson, report.paths, spec.resolve.action, os, { branch, commit: report.commit, buildNumber: spec.buildNumber });
  const { resolve: _resolved, ...rest } = spec;
  return { ...rest, repos: [{ ...spec.repos[0], branch, commit: report.commit }], command: build.command, steps: build.steps, workingDir: build.workingDir, env: build.env,
    timeoutSeconds: build.timeoutSeconds, successExitCodes: build.successExitCodes, artifacts: { globs: build.artifacts, exclude: [], excludeDefaults: true, package: 'none', archiveName: '' } };
}
export function validateScanReport(value: unknown): ScanReport {
  const report = object(value); fields(report, ['commit', 'branch', 'smithJson', 'paths', 'truncated']);
  const invalid = (message = 'Invalid scan report'): never => fail(400, 'invalid_report', message);
  if (typeof report.commit !== 'string' || !COMMIT.test(report.commit) || typeof report.branch !== 'string' || !validBranch(report.branch)) invalid();
  if (report.smithJson !== null && (typeof report.smithJson !== 'string' || report.smithJson.length > 262144)) invalid('smith.json must be text of at most 256 KiB');
  if (!Array.isArray(report.paths) || report.paths.length > 20000 || report.paths.some(path => typeof path !== 'string' || path.length > 1024 || /[\x00-\x1f]/.test(path))) invalid('Invalid repository file list');
  if (typeof report.truncated !== 'boolean') invalid();
  return { commit: report.commit as string, branch: report.branch as string, smithJson: report.smithJson as string | null, paths: report.paths as string[], truncated: report.truncated as boolean };
}
// What the dashboard sees: while the project waits on a scan job, the job's state says why.
export function publicRepoProject(project: RepoProject, scanJob: { state: string; nodeHost: string | null; message: string } | null, denials: AccessDenial[]) {
  let scan = project.scan;
  if (scanJob && scan.state === 'waiting') {
    if (scanJob.state === 'queued') scan = { ...scan, message: [scan.message, denials.length ? 'Waiting for a machine that can read this repository.' : 'Waiting for a machine to read smith.json.'].filter(Boolean).join(' ') };
    else if (scanJob.state === 'leased' || scanJob.state === 'running') scan = { ...scan, state: 'scanning', host: scanJob.nodeHost, message: `Reading smith.json on ${scanJob.nodeHost ?? 'a machine'}.` };
    else scan = { ...scan, state: 'error', message: scanJob.message || `Reading smith.json ended as ${scanJob.state}. Use Rescan to try again.` };
    if (scan.state === 'error' && !scan.message.includes('Rescan')) scan = { ...scan, message: `${scan.message} Use Rescan to try again.` };
  }
  return { ...project, scan, access: denials };
}
export class RepoAccess {
  constructor(private readonly sql: SqlStorage) {}
  deny(projectId: string, nodeId: string, message: string, now: number): void {
    this.sql.exec('INSERT INTO repo_access VALUES (?, ?, ?, ?) ON CONFLICT(project_id, node_id) DO UPDATE SET message = excluded.message, at = excluded.at', projectId, nodeId, message.slice(0, 300), now);
  }
  clear(projectId: string): void { this.sql.exec('DELETE FROM repo_access WHERE project_id = ?', projectId); }
  denials(projectId: string, now: number): AccessDenial[] {
    return this.sql.exec<{ hostname: string | null; node_id: string; message: string; at: number }>('SELECT n.hostname AS hostname, a.node_id AS node_id, a.message AS message, a.at AS at FROM repo_access a LEFT JOIN nodes n ON n.id = a.node_id WHERE a.project_id = ? AND a.at > ? ORDER BY a.at DESC', projectId, now - ACCESS_TTL_MS)
      .toArray().map(row => ({ host: row.hostname || row.node_id.slice(0, 8), message: row.message, at: row.at }));
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/repo-projects-model.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cloudflare/coordinator/src/repo-projects.ts cloudflare/coordinator/test/repo-projects-model.test.ts
git commit --author="Claude Opus 5.5 <noreply@anthropic.com>" -m "Model projects added from a Git URL" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Coordinator — add, scan and rescan

**Files:**
- Modify: `cloudflare/coordinator/src/workspace.ts`, `cloudflare/coordinator/src/index.ts`
- Test: `cloudflare/coordinator/test/repo-projects.test.ts`

**Interfaces:**
- Consumes: Tasks 4–6.
- Produces (DO actions): `add-repo-project` (body `{ source: 'git', url, branch?, name? }`, owners/admins, 201 with the public project), `rescan-project` (`{ projectId }`), node `complete` accepting `commit`, `failure`, `scan`; `projects` returning repo projects through `publicRepoProject`. Routes: `POST /projects` with `source` → `add-repo-project`; `POST /projects/{id}/rescan` → `rescan-project`. Private helpers later tasks use: `anyProject(id)`, `queueScan(project, now, note)`, `repoAccess` getter, `publicProject(project, now)`.

- [ ] **Step 1: Write the failing tests**

`cloudflare/coordinator/test/repo-projects.test.ts`:
```ts
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { hash } from '../src/http';
import { fakeGitHub } from '../src/github-reader';
import senet from './fixtures/smith-json/senet.json?raw';
import identity from '../migrations/0001_identity.sql?raw';
import browser from '../migrations/0002_browser_auth.sql?raw';
import directory from '../migrations/0003_workspace_directory.sql?raw';
import profile from '../migrations/0005_account_profile.sql?raw';

const commit = 'd'.repeat(40);
const ghToken = 'github_pat_' + 'Z9'.repeat(15);
type Lease = { jobId: string; attemptId: string; leaseToken: string; leaseExpiresAt: number; nodeId: string };
type Assignment = { hasJob: boolean; envelope: { lease: Lease; spec: { kind: string; projectId: string; repos: { url: string; branch: string; commit: string }[]; resolve?: { action: string } } } };
type PublicProject = { id: string; name: string; branch: string; commit: string | null; scan: { state: string; message: string; via: string | null; host: string | null; jobId: string | null }; actions: { id: string }[]; access: { host: string; message: string }[] };

beforeEach(() => fakeGitHub.reset());
async function setup() {
  const id = crypto.randomUUID(); const userId = crypto.randomUUID();
  const stub = env.WORKSPACES.getByName(id);
  await stub.initialize(id, userId);
  const human = { kind: 'human' as const, userId };
  async function node(labels: string[] = ['smith-repo-projects', 'node'], os = 'windows', hostname = 'PC-' + crypto.randomUUID().slice(0, 4)) {
    const { code } = await (await stub.execute(human, 'enrollments', {})).json() as { code: string };
    const response = await stub.execute({ kind: 'enrollment' }, 'enroll', { code, protocolVersion: 2, os, hostname, arch: 'x64', labels, agentVersion: '0.2.0' });
    const { token } = await response.json() as { token: string };
    return { kind: 'node' as const, token, hostname };
  }
  const add = async (body: object = {}) => {
    const response = await stub.execute(human, 'add-repo-project', { source: 'git', url: 'git@github.com:Red-Marmoset/senet.git', ...body });
    return { status: response.status, project: await response.json() as PublicProject };
  };
  const projects = async () => (await (await stub.execute(human, 'projects', {})).json() as { projects: PublicProject[] }).projects;
  const claim = async (n: { kind: 'node'; token: string }) => await (await stub.execute(n, 'claim', {})).json() as Assignment;
  const complete = (n: { kind: 'node'; token: string }, lease: Lease, result: object) => stub.execute(n, 'complete', { ...lease, result: { exitCode: 0, durationMs: 5, message: '', status: 'success', ...result } });
  return { stub, human, node, add, projects, claim, complete };
}
const report = (extra: object = {}) => ({ commit, branch: 'master', smithJson: senet, paths: [], truncated: false, ...extra });

describe('adding a project from a Git URL', () => {
  it('reads smith.json through GitHub straight away when the workspace token can', async () => {
    const f = await setup();
    await f.stub.execute(f.human, 'put-settings', { githubToken: ghToken });
    fakeGitHub.repos.set('Red-Marmoset/senet', { defaultBranch: 'master', branches: { master: { commit, smithJson: senet, paths: [], truncated: false } } });
    const { status, project } = await f.add();
    expect(status).toBe(201);
    expect(project).toMatchObject({ id: 'senet', branch: 'master', commit, scan: { state: 'ready', via: 'github', jobId: null } });
    expect(project.actions.map(a => a.id)).toEqual(['build-check', 'web-deploy', 'd1-limit-workaround', 'ai-ladder']);
    const settings = await (await f.stub.execute(f.human, 'settings', {})).text();
    expect(settings).toContain('"githubTokenSet":true');
    expect(settings).not.toContain(ghToken);
  });
  it('queues a scan for an updated machine when GitHub cannot read it, and fills a blank branch from the scan', async () => {
    const f = await setup();
    await f.stub.execute(f.human, 'put-settings', { githubToken: ghToken });
    fakeGitHub.failNext = 'GitHub answered 404 for the repository';
    const { project } = await f.add();
    expect(project.scan).toMatchObject({ state: 'waiting', message: expect.stringContaining('could not read this repository (GitHub answered 404') });
    const old = await f.node(['node']);
    expect((await f.claim(old)).hasJob).toBe(false);                    // agents without the label never see scans
    const pc = await f.node();
    const assigned = await f.claim(pc);
    expect(assigned.envelope.spec).toMatchObject({ kind: 'scan', projectId: 'senet', repos: [{ branch: '', commit: '' }] });
    expect((await f.projects())[0].scan).toMatchObject({ state: 'scanning', host: pc.hostname });
    expect((await f.complete(pc, assigned.envelope.lease, { commit, scan: report() })).status).toBe(200);
    const [ready] = await f.projects();
    expect(ready).toMatchObject({ branch: 'master', commit, scan: { state: 'ready', via: 'machine', host: pc.hostname } });
  });
  it('waits without a GitHub token, and needs an admin', async () => {
    const f = await setup();
    expect((await f.add()).project.scan).toMatchObject({ state: 'waiting', message: 'Waiting for a machine to read smith.json.' });
    await runInDurableObject(f.stub, (_object, state) => { state.storage.sql.exec("UPDATE members SET role = 'operator'"); });
    expect((await f.add({ url: 'https://github.com/a/b.git' })).status).toBe(403);
  });
  it('shows a lost or cancelled scan as an error, and Rescan queues a fresh one without duplicating', async () => {
    const f = await setup();
    const { project } = await f.add();
    await f.stub.execute(f.human, 'cancel', { jobId: project.scan.jobId });
    expect((await f.projects())[0].scan).toMatchObject({ state: 'error', message: expect.stringContaining('Rescan') });
    const first = await (await f.stub.execute(f.human, 'rescan-project', { projectId: 'senet' })).json() as PublicProject;
    const second = await (await f.stub.execute(f.human, 'rescan-project', { projectId: 'senet' })).json() as PublicProject;
    expect(first.scan.state).toBe('waiting');
    expect(second.scan.jobId).toBe(first.scan.jobId);
  });
  it('records a scan that found no smith.json', async () => {
    const f = await setup();
    await f.add();
    const pc = await f.node();
    const assigned = await f.claim(pc);
    await f.complete(pc, assigned.envelope.lease, { commit, scan: report({ smithJson: null }) });
    expect((await f.projects())[0].scan).toMatchObject({ state: 'error', message: expect.stringContaining('No smith.json') });
  });
  it('routes POST /projects with a source and /projects/{id}/rescan through the Worker', async () => {
    for (const sql of [identity, browser, directory, profile]) await env.DB.exec(sql);
    const token = crypto.randomUUID(); const userId = crypto.randomUUID();
    await env.DB.batch([env.DB.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').bind(userId, Date.now()),
      env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(await hash(token), userId, Date.now() + 60000)]);
    const call = (path: string, body: unknown) => worker.fetch(new Request('https://exp.redmarmosetstudios.com' + path, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env);
    const { workspaceId } = await (await call('/api/v2/workspaces', { requestId: crypto.randomUUID() })).json() as { workspaceId: string };
    const added = await call(`/api/v2/workspaces/${workspaceId}/projects`, { source: 'git', url: 'https://github.com/o/routed.git' });
    expect(added.status).toBe(201);
    expect(await added.json()).toMatchObject({ id: 'routed', kind: 'repo' });
    expect((await call(`/api/v2/workspaces/${workspaceId}/projects/routed/rescan`, {})).status).toBe(200);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/repo-projects.test.ts`
Expected: FAIL — `Command not permitted for this identity` (unknown actions).

- [ ] **Step 3: Implement in `src/workspace.ts`**

1. Imports — add:
```ts
import { RepoAccess, REPO_ACCESS_SCHEMA, ACCESS_FILTER, ACCESS_TTL_MS, REPO_LABEL, SCAN_PRODUCT, applyReport, createRepoProject, isRepoProject, newProjectId, publicRepoProject, repoBuildSpecs, resolveBuildSpec, scanSpecs, validateScanReport, type RepoProject } from './repo-projects';
import { githubReader, githubRepo, GitHubReadError } from './github-reader';
import { PipelineError } from './pipeline';
```
and add `type ScanReport` to the existing `./contracts` import.

2. Schema — after `this.ctx.storage.sql.exec(TOKEN_SCHEMA);` add:
```ts
    this.ctx.storage.sql.exec(REPO_ACCESS_SCHEMA);
```

3. Helpers — after `private saveProject(...)`, add (and widen `saveProject`'s parameter to `Project | RepoProject`):
```ts
  // Prepared projects and projects added from a Git URL share the table; `project()` keeps
  // returning the prepared shape for the Artifacts code, which never handles repo projects.
  private anyProject(id: string): Project | RepoProject | undefined {
    const row = this.sql.exec<{ definition: string }>('SELECT definition FROM projects WHERE id = ?', id).toArray()[0];
    return row ? JSON.parse(row.definition) as Project | RepoProject : undefined;
  }
  private get repoAccess() { return new RepoAccess(this.sql); }
  private publicProject(project: Project | RepoProject, now: number) {
    if (!isRepoProject(project)) return project;
    const job = project.scan.jobId ? this.sql.exec<JobRow>('SELECT * FROM jobs WHERE id = ?', project.scan.jobId).toArray()[0] : undefined;
    const host = job?.node_id ? this.sql.exec<{ hostname: string }>('SELECT hostname FROM nodes WHERE id = ?', job.node_id).toArray()[0]?.hostname ?? null : null;
    return publicRepoProject(project, job ? { state: job.state, nodeHost: host, message: job.result ? (JSON.parse(job.result) as JobResult).message : '' } : null, this.repoAccess.denials(project.id, now));
  }
```

4. `execute` — next to the existing `mirror-project` early return add:
```ts
      if (principal.kind === 'human' && action === 'add-repo-project') return await this.addRepoProject(principal.userId, body);
      if (principal.kind === 'human' && action === 'rescan-project') return await this.rescanProject(principal.userId, body);
```

5. `projects` action — replace its line with:
```ts
          if (action === 'projects') return json({ projects: this.sql.exec<{ definition: string }>('SELECT definition FROM projects ORDER BY id').toArray().map(p => this.publicProject(JSON.parse(p.definition) as Project | RepoProject, now)) });
```

6. `complete` — replace the result parsing inside `if (action === 'complete') { … }` with:
```ts
            if (action === 'complete') {
              const input = object(body.result); fields(input, ['status', 'exitCode', 'durationMs', 'message', 'commit', 'failure', 'scan']);
              if (!['success', 'failed', 'error'].includes(String(input.status)) || !Number.isSafeInteger(input.exitCode) || !Number.isSafeInteger(input.durationMs) || Number(input.durationMs) < 0 || typeof input.message !== 'string' || input.message.length > 4096) fail(400, 'invalid_result', 'Invalid job result');
              if (input.commit !== undefined && (typeof input.commit !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(input.commit))) fail(400, 'invalid_result', 'Invalid job result');
              if (input.failure !== undefined && input.failure !== 'repo_access') fail(400, 'invalid_result', 'Invalid job result');
              scanReport = input.scan === undefined ? undefined : validateScanReport(input.scan);
              result = { status: input.status as JobResult['status'], exitCode: Number(input.exitCode), durationMs: Number(input.durationMs), message: input.message,
                ...(typeof input.commit === 'string' ? { commit: input.commit } : {}), ...(input.failure === 'repo_access' ? { failure: 'repo_access' as const } : {}) };
              if (job.result) {
                if (job.result !== JSON.stringify(result)) fail(409, 'conflicting_result', 'Result differs from accepted completion');
                return json({ accepted: true, jobId: job.id });
              }
            }
```
declare `let scanReport: ScanReport | undefined;` next to `let result: JobResult | undefined;`. Then inside `if (result) {`, before the success-artifacts check, add:
```ts
              if (result.failure === 'repo_access') {
                // This machine's Git login cannot read the repository: remember that, and give the
                // job back to the queue for a machine that can (claims skip this node for an hour).
                this.repoAccess.deny(job.project_id, node.id, result.message, now);
                this.sql.exec("UPDATE jobs SET state = 'queued', node_id = NULL, attempt_id = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ?, revision = revision + 1 WHERE id = ?", now, job.id); this.event(job.id);
                return json({ accepted: true, jobId: job.id, requeued: true });
              }
```
and after the existing `UPDATE jobs SET state = ?, result = ? …` line add:
```ts
              if (job.kind === 'scan') this.finishScan(job, result, scanReport, node, now);
```

7. New private methods (after `reconcileMirrors`):
```ts
  // ---- Projects added from a Git URL ----

  private async readViaGitHub(project: RepoProject): Promise<{ report: ScanReport | null; note: string }> {
    const token = this.secrets().githubToken;
    if (!token || !githubRepo(project.repoUrl)) return { report: null, note: '' };
    try { return { report: await githubReader(this.env)(project.repoUrl, project.branch, token), note: '' }; }
    catch (error) {
      const reason = error instanceof GitHubReadError ? error.message : error instanceof Error && error.name === 'TimeoutError' ? 'GitHub did not answer within 5 seconds' : 'GitHub could not be reached';
      return { report: null, note: `The workspace's GitHub token could not read this repository (${reason}).` };
    }
  }
  private queueScan(project: RepoProject, now: number, note: string): RepoProject {
    if (this.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM jobs').one().count >= 1000) fail(429, 'quota', 'Experiment job quota reached');
    const id = crypto.randomUUID();
    this.sql.exec("INSERT INTO jobs (id, kind, request_id, specs, project_id, product, required_labels, state, created_at, updated_at, revision) VALUES (?, 'scan', ?, ?, ?, ?, ?, 'queued', ?, ?, 1)",
      id, `scan-${id}`, JSON.stringify(scanSpecs(project, id)), project.id, SCAN_PRODUCT, JSON.stringify([REPO_LABEL]), now, now);
    this.event(id);
    return { ...project, scan: { state: 'waiting', message: note, via: null, host: null, jobId: id, at: now } };
  }
  private async addRepoProject(userId: string, body: Record<string, unknown>): Promise<Response> {
    this.requireHuman(userId, true, true);
    const now = Date.now();
    const draft = createRepoProject(body, new Set(this.sql.exec<{ id: string }>('SELECT id FROM projects').toArray().map(row => row.id)), now);
    const read = await this.readViaGitHub(draft);      // outside the transaction: an external call
    const response = this.ctx.storage.transactionSync(() => {
      const taken = new Set(this.sql.exec<{ id: string }>('SELECT id FROM projects').toArray().map(row => row.id));
      if (taken.size >= 20) fail(429, 'quota', 'Experiment project quota reached');
      const project = { ...draft, id: taken.has(draft.id) ? newProjectId(draft.repoUrl, taken) : draft.id };
      const saved = read.report ? applyReport(project, read.report, 'github', null, now) : this.queueScan(project, now, read.note);
      this.sql.exec('INSERT INTO projects VALUES (?, ?)', saved.id, JSON.stringify(saved));
      return json(this.publicProject(saved, now), 201);
    });
    await this.schedule();
    return response;
  }
  private async rescanProject(userId: string, body: Record<string, unknown>): Promise<Response> {
    fields(body, ['projectId']);
    const projectId = string(body, 'projectId', 64);
    this.requireHuman(userId, true, true);
    const project = this.anyProject(projectId);
    if (!project) fail(404, 'not_found', 'Project not found');
    if (!isRepoProject(project)) fail(409, 'unsupported_project', 'Rescan is for projects added from a Git URL');
    const active = (id: string | null) => Boolean(id && this.sql.exec("SELECT id FROM jobs WHERE id = ? AND state IN ('queued', 'leased', 'running')", id).toArray().length);
    const read = active(project.scan.jobId) ? null : await this.readViaGitHub(project);
    const response = this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const current = this.anyProject(projectId);
      if (!isRepoProject(current)) fail(404, 'not_found', 'Project not found');
      this.repoAccess.clear(projectId);                 // every machine gets another chance
      let saved: RepoProject = current;
      if (!active(current.scan.jobId)) saved = read?.report ? applyReport({ ...current, scan: { ...current.scan, jobId: null } }, read.report, 'github', null, now) : this.queueScan(current, now, read?.note ?? '');
      this.saveProject(saved);
      return json(this.publicProject(saved, now));
    });
    await this.schedule();
    return response;
  }
  private finishScan(job: JobRow, result: JobResult, report: ScanReport | undefined, node: NodeRow, now: number): void {
    const project = this.anyProject(job.project_id);
    if (!isRepoProject(project) || project.scan.jobId !== job.id) return;     // superseded by a rescan
    const saved = result.status === 'success' && report ? applyReport(project, report, 'machine', node.hostname, now)
      : { ...project, scan: { ...project.scan, state: 'error' as const, message: result.status === 'success' ? 'The machine returned no scan report' : result.message || 'Reading smith.json failed', at: now } };
    this.saveProject(saved);
  }
```

8. `mirrorProject` — right after `const project = this.project(projectId); if (!project) …` add:
```ts
    if (isRepoProject(project)) fail(409, 'unsupported_project', 'Copy to Artifacts is for projects pinned to a commit');
```
and in `readTokenFor`, change `if (!project || isArtifactsRemote(...)` to `if (!project || isRepoProject(project) || !isArtifactsRemote(...)` keeping the rest of the condition.

`src/index.ts`:
- Replace `if (path === 'projects') return await stub.execute(principal, request.method === 'GET' ? 'projects' : 'put-project', body);` with:
```ts
      if (path === 'projects') return await stub.execute(principal, request.method === 'GET' ? 'projects' : body.source !== undefined ? 'add-repo-project' : 'put-project', body);
      const rescan = /^projects\/([a-z0-9][a-z0-9-]{0,63})\/rescan$/.exec(path);
      if (rescan && request.method === 'POST') { fields(body, []); return await stub.execute(principal, 'rescan-project', { projectId: rescan[1] }); }
```
- Replace the body read line with:
```ts
      // Scan reports (a repository's smith.json and file list) ride on a node's /complete and /resolve.
      const large = request.method === 'POST' && /^\/api\/v2\/workspaces\/[a-f0-9]{64}\/(?:complete|resolve)$/.test(url.pathname);
      const body = request.method === 'POST' ? await readBody(request, large ? 2 * 1024 * 1024 : undefined) : {};
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/repo-projects.test.ts && npx vitest run && npx tsc --noEmit`
Expected: the new file passes and the whole suite stays green (existing artifacts, settings, build-loop and MCP tests included).

- [ ] **Step 5: Commit**

```bash
git add cloudflare/coordinator/src/workspace.ts cloudflare/coordinator/src/index.ts cloudflare/coordinator/test/repo-projects.test.ts
git commit --author="Claude Opus 5.5 <noreply@anthropic.com>" -m "Add projects from a Git URL and read their smith.json" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Coordinator — branch-tip builds, access routing, /resolve, MCP

**Files:**
- Modify: `cloudflare/coordinator/src/workspace.ts`, `cloudflare/coordinator/src/index.ts`, `cloudflare/coordinator/src/mcp.ts`
- Test: `cloudflare/coordinator/test/repo-projects.test.ts` (append), `cloudflare/coordinator/test/mcp.test.ts` (append)

**Interfaces:**
- Consumes: Task 7 helpers; `repoBuildSpecs`, `resolveBuildSpec`, `ACCESS_FILTER`, `ACCESS_TTL_MS`.
- Produces: node route `POST /resolve` (body: lease fields + `report`) → `200 { spec: ResolvedJobSpec }` with workspace env merged, `422 action_missing` with a message, `409 stale_attempt`/`not_resolvable`; `enqueue` for repo projects; `claim` skipping no-access nodes.

- [ ] **Step 1: Write the failing tests** (append to `test/repo-projects.test.ts`)

```ts
describe('building a repository project', () => {
  async function ready() {
    const f = await setup();
    await f.stub.execute(f.human, 'put-settings', { githubToken: ghToken });
    fakeGitHub.repos.set('Red-Marmoset/senet', { defaultBranch: 'master', branches: { master: { commit, smithJson: senet, paths: [], truncated: false } } });
    await f.add();
    return f;
  }
  it('builds the branch tip and resolves the command after checkout', async () => {
    const f = await ready();
    const queued = await (await f.stub.execute(f.human, 'enqueue', { requestId: 'b1', projectId: 'senet', product: 'build-check' })).json() as { id: string };
    const pc = await f.node();
    const assigned = await f.claim(pc);
    expect(assigned.envelope.spec).toMatchObject({ kind: 'build', resolve: { action: 'build-check' }, repos: [{ branch: 'master', commit: '' }] });
    const tip = 'e'.repeat(40);
    const resolved = await f.stub.execute(pc, 'resolve', { ...assigned.envelope.lease, report: report({ commit: tip }) });
    expect(resolved.status).toBe(200);
    const { spec } = await resolved.json() as { spec: { repos: { commit: string }[]; command: { script: string }; env: Record<string, string>; resolve?: unknown } };
    expect(spec).toMatchObject({ repos: [{ commit: tip }], command: { script: 'build.bat' }, env: { SMITH_COMMIT: tip } });
    expect(spec.resolve).toBeUndefined();
    expect((await f.complete(pc, assigned.envelope.lease, { commit: tip })).status).toBe(200);
    const job = await (await f.stub.execute(f.human, 'get', { jobId: queued.id })).json() as { state: string; result: { commit: string } };
    expect(job).toMatchObject({ state: 'success', result: { commit: tip } });
    expect((await f.projects())[0].commit).toBe(tip);                   // the build's checkout refreshed the project
  });
  it('fails the build clearly when the action is gone at the new commit', async () => {
    const f = await ready();
    await f.stub.execute(f.human, 'enqueue', { requestId: 'b2', projectId: 'senet', product: 'build-check' });
    const pc = await f.node();
    const assigned = await f.claim(pc);
    const gone = JSON.stringify({ project: { id: 'senet' }, buildProducts: [] });
    const response = await f.stub.execute(pc, 'resolve', { ...assigned.envelope.lease, report: report({ smithJson: gone }) });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: 'action_missing', message: expect.stringContaining('build-check is not in smith.json') } });
  });
  it('skips a machine that could not read the repo, until rescan or an hour', async () => {
    const f = await ready();
    await f.stub.execute(f.human, 'enqueue', { requestId: 'b3', projectId: 'senet', product: 'build-check' });
    const blind = await f.node();
    const first = await f.claim(blind);
    const denied = await f.complete(blind, first.envelope.lease, { status: 'error', exitCode: -1, message: 'Repository clone failed', failure: 'repo_access' });
    expect(await denied.json()).toMatchObject({ accepted: true, requeued: true });
    expect((await f.claim(blind)).hasJob).toBe(false);
    expect((await f.projects())[0].access).toMatchObject([{ host: blind.hostname, message: 'Repository clone failed' }]);
    await runInDurableObject(f.stub, (_object, state) => { state.storage.sql.exec('UPDATE repo_access SET at = at - 3600001'); });
    expect((await f.claim(blind)).hasJob).toBe(true);                   // an hour later it may try again
    const second = await f.claim(blind);
    await f.complete(blind, second.envelope.lease, { status: 'error', exitCode: -1, message: 'Repository clone failed', failure: 'repo_access' });
    expect((await f.claim(blind)).hasJob).toBe(false);
    await f.stub.execute(f.human, 'rescan-project', { projectId: 'senet' });
    expect((await f.claim(blind)).hasJob).toBe(true);                   // Rescan clears the marks
  });
  it('refuses builds of unknown or unavailable actions', async () => {
    const f = await ready();
    expect((await f.stub.execute(f.human, 'enqueue', { requestId: 'b4', projectId: 'senet', product: 'stats-reconcile-prod' })).status).toBe(400);
  });
});
```
Append inside the `describe` of `test/mcp.test.ts` (add the imports `import { fakeGitHub } from '../src/github-reader';` and `import senet from './fixtures/smith-json/senet.json?raw';` at the top):
```ts
  it('lists the build actions of a project added from a Git URL', async () => {
    const f = await setup(); const { token } = await f.token(f.owner);
    await f.stub.execute(f.owner, 'put-settings', { githubToken: 'github_pat_' + 'Q7'.repeat(15) });
    fakeGitHub.reset();
    fakeGitHub.repos.set('Red-Marmoset/senet', { defaultBranch: 'master', branches: { master: { commit: 'f'.repeat(40), smithJson: senet, paths: [], truncated: false } } });
    expect((await f.stub.execute(f.owner, 'add-repo-project', { source: 'git', url: 'git@github.com:Red-Marmoset/senet.git' })).status).toBe(201);
    const listed = (await tool(token, 'list_projects')).json as unknown as { project: string; commit: string; products: { product: string; platforms: string[] }[] }[];
    expect(listed.find(p => p.project === 'senet')).toMatchObject({ commit: 'f'.repeat(40), products: expect.arrayContaining([expect.objectContaining({ product: 'build-check', platforms: ['windows'] })]) });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/repo-projects.test.ts`
Expected: FAIL — enqueue answers `unsupported_project`/`unknown_product` paths from `projectSpecs`, and `resolve` is not permitted.

- [ ] **Step 3: Implement**

`src/workspace.ts`:
1. `enqueue` — replace the `else { const definition = this.project(projectId); … ({ specs, labels } = projectSpecs(…)); }` branch with:
```ts
            else {
              const definition = this.anyProject(projectId);
              if (!definition) fail(400, 'unsupported_project', 'Project not found');
              const count = this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM jobs WHERE project_id = ? AND kind = 'build'", projectId).one().count;
              if (isRepoProject(definition)) ({ specs, labels } = repoBuildSpecs(definition, product, id, count + 1));
              else {
                if (definition.artifacts && ['pushing', 'verifying'].includes(definition.artifacts.status)) fail(409, 'artifacts_pending', 'This project is being copied to Artifacts; build it once the copy settles');
                if (isArtifactsRemote(definition.repoUrl) && !readToken) fail(503, 'artifacts_unconfigured', 'This project builds from Cloudflare Artifacts; set the Cloudflare account ID and API token in workspace Settings');
                ({ specs, labels } = projectSpecs(definition, product, id, count + 1, readToken));
              }
            }
```
(keep any lines the branch has gained since this plan was written; only the dispatch on `isRepoProject` is new).

2. `claim` — change the queued-job query to:
```ts
              job = this.sql.exec<JobRow>(`SELECT * FROM jobs WHERE state = 'queued' AND json_type(specs, ?) IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM json_each(required_labels) needed WHERE NOT EXISTS (SELECT 1 FROM json_each(?) available WHERE available.value = needed.value))
                ${ACCESS_FILTER}
                ORDER BY created_at, id LIMIT 1`, '$.' + node.os, node.labels, node.id, now - ACCESS_TTL_MS).toArray()[0];
```

3. `resolve` — inside `if (node) {`, before the `renew/complete/logs` block:
```ts
          if (action === 'resolve') {
            // A branch-tip build is checked out: map smith.json at that commit to the command to run,
            // freeze it into the job (artifact checks read it), and refresh the project's actions.
            fields(body, ['jobId', 'attemptId', 'leaseToken', 'leaseExpiresAt', 'nodeId', 'report']);
            const job = this.job(string(body, 'jobId'));
            if (job.node_id !== node.id || job.attempt_id !== string(body, 'attemptId') || job.lease_token !== string(body, 'leaseToken', 200) || !['leased', 'running'].includes(job.state) || job.lease_expires_at! <= now) fail(409, 'stale_attempt', 'Attempt is not current');
            const specs = JSON.parse(job.specs) as Record<string, ResolvedJobSpec>;
            const project = this.anyProject(job.project_id);
            if (!specs[node.os]?.resolve || !isRepoProject(project)) fail(409, 'not_resolvable', 'This job has no build action to resolve');
            const scan = validateScanReport(body.report);
            this.saveProject(applyReport(project, scan, 'machine', node.hostname, now));
            let resolved: ResolvedJobSpec;
            try { resolved = resolveBuildSpec(specs[node.os], scan, project.branch || scan.branch, node.os); }
            catch (error) { if (error instanceof PipelineError) fail(422, 'action_missing', error.message); throw error; }
            specs[node.os] = resolved;
            this.sql.exec('UPDATE jobs SET specs = ?, updated_at = ? WHERE id = ?', JSON.stringify(specs), now, job.id);
            return json({ spec: { ...resolved, env: { ...workspaceJobEnv(this.settings(), this.secrets()), ...resolved.env } } });
          }
```

`src/index.ts` — add `resolve: 'resolve'` to the `nodeActions` map.

`src/mcp.ts` — replace the `list_projects` `run` body (the `const { projects } = …` line through the `return text(…)` statement) with:
```ts
      type Prepared = { kind?: undefined; id: string; name: string; repoUrl: string; branch: string; commit: string; products: { name: string; description: string; labels: string[]; commands: Json }[] };
      type FromGit = { kind: 'repo'; id: string; name: string; repoUrl: string; branch: string; commit: string | null; actions: { id: string; label: string; os: string[]; labels: string[]; available: boolean }[] };
      const { projects } = await call('projects', {}) as { projects: (Prepared | FromGit)[] };
      return text(projects.map(p => ({ project: p.id, name: p.name, repository: p.repoUrl, branch: p.branch, commit: p.commit ?? 'branch tip (smith.json not read yet)',
        products: p.kind === 'repo'
          ? p.actions.filter(action => action.available).map(action => ({ product: action.id, description: action.label, platforms: action.os, requiresLabels: action.labels }))
          : p.products.map(product => ({ product: product.name, description: product.description, platforms: Object.keys(product.commands), requiresLabels: product.labels })) })));
```
and change the tool `description` to: `'Projects in this Smith workspace: their repository, branch, the commit Smith last saw (projects added from a Git URL build their branch tip), and the products (build actions) each offers, with the operating systems each product runs on.'`

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run && npm run verify`
Expected: all tests pass; typecheck clean; dry-run bundle builds.

- [ ] **Step 5: Commit**

```bash
git add cloudflare/coordinator/src/workspace.ts cloudflare/coordinator/src/index.ts cloudflare/coordinator/src/mcp.ts cloudflare/coordinator/test/repo-projects.test.ts cloudflare/coordinator/test/mcp.test.ts
git commit --author="Claude Opus 5.5 <noreply@anthropic.com>" -m "Build repository projects at their branch tip on machines that can read them" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Wire format — `ResolveSpec`

**Files:**
- Modify: `Modules/SmithProtocol/WireTypes.h`, `Modules/SmithProtocol/WireJson.cpp`
- Test: `Tests/SmithProtocolTest/Main.cpp`

**Interfaces:**
- Produces: `struct Smith::ResolveSpec { std::string action; }`; `JobSpec::resolve`; JSON key `"resolve": {"action": "..."}` (absent → empty action). `JobSpec::kind` comment gains `"scan"`.

- [ ] **Step 1: Write the failing test** — in `Tests/SmithProtocolTest/Main.cpp`, next to the mirror round-trip test, add:
```cpp
    // A branch-tip build carries the build action the coordinator resolves after checkout.
    {
        Smith::JobSpec spec; spec.jobId = "r1"; spec.kind = "build"; spec.resolve.action = "unity/steam-windows";
        Smith::JobSpec back; ASSERT_TRUE(Smith::FromJson(Smith::ToJson(spec), back));
        ASSERT_EQ_STR(back.resolve.action, "unity/steam-windows");
        Smith::JobSpec plain; ASSERT_TRUE(Smith::FromJson("{\"jobId\":\"j3\"}", plain));
        ASSERT_EQ_STR(plain.resolve.action, "");
        Smith::JobSpec scan; ASSERT_TRUE(Smith::FromJson("{\"jobId\":\"j4\",\"kind\":\"scan\"}", scan));
        ASSERT_EQ_STR(scan.kind, "scan");
    }
```
(Use the same `ToJson`/`FromJson` names the neighbouring mirror test uses.)

- [ ] **Step 2: Run to verify it fails**

Run: `.\RunTests.ps1`
Expected: `SmithProtocolTest` fails to compile — `'resolve': is not a member of 'Smith::JobSpec'`.

- [ ] **Step 3: Implement**

`WireTypes.h`, after `struct MirrorSpec { … };`:
```cpp
    // A build of a repository project's branch tip: after checkout the agent posts what it found
    // to the coordinator's /resolve, which answers with the command smith.json defines for `action`.
    struct ResolveSpec
    {
        std::string action;
    };
```
In `JobSpec`: change the `kind` comment to `// "build" | "mirror" | "scan" (absent in v1 JSON -> build)` and add after `MirrorSpec mirror;`:
```cpp
        ResolveSpec resolve;                          // kind == "build" with an unpinned repo only
```
`WireJson.cpp`, after the `MirrorSpec` `to_json`/`from_json` pair:
```cpp
    static void to_json(json& j, const ResolveSpec& v)
    {
        j = json{{"action", v.action}};
    }
    static void from_json(const json& j, ResolveSpec& v)
    {
        v.action = j.value("action", std::string());
    }
```
In `to_json(json&, const JobSpec&)` append `, {"resolve", v.resolve}` after `{"mirror", v.mirror}`; in `from_json(const json&, JobSpec&)` add `v.resolve = j.value("resolve", ResolveSpec());` after the `mirror` line.

- [ ] **Step 4: Run to verify it passes**

Run: `.\RunTests.ps1`
Expected: all projects pass.

- [ ] **Step 5: Commit**

```bash
git add Modules/SmithProtocol/WireTypes.h Modules/SmithProtocol/WireJson.cpp Tests/SmithProtocolTest/Main.cpp
git commit --author="Claude Opus 5.5 <noreply@anthropic.com>" -m "Carry the build action a branch-tip job resolves after checkout" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Agent policy and pure helpers

**Files:**
- Modify: `Modules/SmithAgent/HostedAgent.h`, `Modules/SmithAgent/HostedPolicy.cpp`
- Test: `Tests/SmithHostedAgentTest/Main.cpp` (insert before `printf("Hosted policy: %d passed, %d failed\n", passed, failed);`)

**Interfaces:**
- Consumes: `JobSpec::resolve` (Task 9).
- Produces: `std::string Smith::HostedClassifyGitFailure(const std::vector<std::string>& errorLines)` → `"repo_access"` or `""`; `std::string Smith::HostedScanReport(const std::string& commit, const std::string& branch, bool hasSmithJson, const std::string& smithJson, const std::vector<std::string>& paths)` → JSON text `{commit, branch, smithJson|null, paths[], truncated}`, throwing `std::runtime_error("smith.json is larger than 256 KiB")`; `ValidateHostedSpec` accepting `scan` jobs and resolving builds with an empty commit.

- [ ] **Step 1: Write the failing tests**

```cpp
    // ---- Repository projects: scans and branch-tip builds ----
    {
        Smith::JobSpec scan; scan.kind = "scan";
        scan.repos.push_back({"main", "git@github.com:Red-Marmoset/senet.git", "", "", ".", ""});
        CHECK(Smith::ValidateHostedSpec(scan).empty());                 // no commit, no command needed
        scan.repos[0].branch = "../x"; CHECK(!Smith::ValidateHostedSpec(scan).empty());
        scan.repos[0].branch = "feature/x"; CHECK(Smith::ValidateHostedSpec(scan).empty());
        scan.repos.push_back(scan.repos[0]); scan.repos[1].checkoutDir = "other"; CHECK(!Smith::ValidateHostedSpec(scan).empty());

        Smith::JobSpec tip; tip.repos.push_back({"main", "https://github.com/o/r.git", "main", "", ".", ""});
        CHECK(!Smith::ValidateHostedSpec(tip).empty());                  // an empty commit needs a resolve action
        tip.resolve.action = "build-check"; CHECK(Smith::ValidateHostedSpec(tip).empty());
        tip.kind = "mirror"; CHECK(!Smith::ValidateHostedSpec(tip).empty());
        tip.kind = "build"; tip.resolve.action = std::string("bad\naction"); CHECK(!Smith::ValidateHostedSpec(tip).empty());

        CHECK(Smith::HostedClassifyGitFailure({"git@github.com: Permission denied (publickey).", "fatal: Could not read from remote repository."}) == "repo_access");
        CHECK(Smith::HostedClassifyGitFailure({"ERROR: Repository not found."}) == "repo_access");
        CHECK(Smith::HostedClassifyGitFailure({"remote: Repository not found.", "fatal: repository 'https://github.com/o/r.git/' not found"}) == "repo_access");
        CHECK(Smith::HostedClassifyGitFailure({"fatal: could not read Username for 'https://github.com': terminal prompts disabled"}) == "repo_access");
        CHECK(Smith::HostedClassifyGitFailure({"ssh: Could not resolve hostname github.com: No such host is known.", "fatal: Could not read from remote repository."}).empty());
        CHECK(Smith::HostedClassifyGitFailure({"fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com"}).empty());

        std::vector<std::string> many(25000, std::string(10, 'p'));
        const auto report = Smith::HostedScanReport(std::string(40, 'a'), "main", true, "{\"project\":{\"id\":\"x\"}}", many);
        CHECK(report.find("\"truncated\":true") != std::string::npos);
        CHECK(report.find("\"smithJson\":\"{\\\"project\\\"") != std::string::npos);
        CHECK(Smith::HostedScanReport(std::string(40, 'a'), "main", false, "", {"a"}).find("\"smithJson\":null") != std::string::npos);
        bool threw = false; try { Smith::HostedScanReport(std::string(40, 'a'), "main", true, std::string(256 * 1024 + 1, ' '), {}); } catch (const std::exception&) { threw = true; }
        CHECK(threw);
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `.\RunTests.ps1`
Expected: `SmithHostedAgentTest` fails to compile (`HostedClassifyGitFailure` undeclared).

- [ ] **Step 3: Implement**

`HostedAgent.h`, after the `HostedCommandArgv` declaration:
```cpp
    // Pure: "repo_access" when git's error output says this machine's Git login cannot read the
    // repository (another machine should try), "" for anything else (network, disk, bad ref).
    std::string HostedClassifyGitFailure(const std::vector<std::string>& errorLines);
    // Pure: the scan report sent to /complete (scan jobs) and /resolve (branch-tip builds), as JSON
    // text. Keeps at most 20000 paths and 512 KiB of path text (then "truncated" is true); throws
    // for a smith.json over 256 KiB.
    std::string HostedScanReport(const std::string& commit, const std::string& branch, bool hasSmithJson, const std::string& smithJson, const std::vector<std::string>& paths);
```
`HostedPolicy.cpp` — in `ValidateHostedSpec`:
- replace `if (spec.kind != "build" && spec.kind != "mirror") return "Unsupported job kind";` with:
```cpp
        if (spec.kind != "build" && spec.kind != "mirror" && spec.kind != "scan") return "Unsupported job kind";
        // Repository jobs leave the commit empty: a scan reads the branch tip, and a build with a
        // resolve action checks the tip out and then asks the coordinator for its command.
        const bool scan = spec.kind == "scan";
        const bool resolving = !spec.resolve.action.empty();
        if (resolving && spec.kind != "build") return "Only build jobs may resolve their command";
        if (resolving && (spec.resolve.action.size() > 200 || spec.resolve.action.find_first_of(std::string("\r\n\t\0", 4)) != std::string::npos)) return "Invalid build action";
        if ((scan || resolving) && spec.repos.size() != 1) return "A repository job needs exactly one repository";
```
- in the repo loop, replace the commit check with:
```cpp
            const bool tip = (scan || resolving) && repo.commit.empty();
            if (!tip && !std::regex_match(repo.commit, std::regex("[a-fA-F0-9]{40}|[a-fA-F0-9]{64}"))) return "Repositories require a full pinned commit";
            if (tip && !repo.branch.empty() && (!std::regex_match(repo.branch, std::regex("[A-Za-z0-9][A-Za-z0-9/_.-]*")) || repo.branch.find("..") != std::string::npos)) return "Invalid branch";
```
- wrap the final command loop: `if (!scan && !resolving) { …existing for (const auto& cmd : commands) loop… }` (keep `const auto commands = …` inside the block).

Add after `ValidateHostedSpec`:
```cpp
    std::string HostedClassifyGitFailure(const std::vector<std::string>& errorLines)
    {
        // Messages git and its SSH/HTTPS transports print when the credentials are refused. A bare
        // "Could not read from remote repository" also follows DNS failures, so it is not enough.
        static const char* const refused[] = {
            "permission denied (publickey", "authentication failed", "could not read username", "could not read password",
            "host key verification failed", "terminal prompts disabled", "invalid username or password",
            "password authentication was removed", "returned error: 401", "returned error: 403", "returned error: 404" };
        for (auto line : errorLines) {
            std::transform(line.begin(), line.end(), line.begin(), [](unsigned char c) { return (char)std::tolower(c); });
            if (line.find("repository") != std::string::npos && line.find("not found") != std::string::npos) return "repo_access";
            for (const char* needle : refused) if (line.find(needle) != std::string::npos) return "repo_access";
        }
        return "";
    }
    std::string HostedScanReport(const std::string& commit, const std::string& branch, bool hasSmithJson, const std::string& smithJson, const std::vector<std::string>& paths)
    {
        if (hasSmithJson && smithJson.size() > 256 * 1024) throw std::runtime_error("smith.json is larger than 256 KiB");
        nlohmann::json report = {{"commit", commit}, {"branch", branch}};
        report["smithJson"] = hasSmithJson ? nlohmann::json(smithJson) : nlohmann::json(nullptr);
        nlohmann::json kept = nlohmann::json::array(); size_t bytes = 0;
        for (const auto& path : paths) {
            if (kept.size() >= 20000 || bytes + path.size() > 512 * 1024) break;
            kept.push_back(path); bytes += path.size();
        }
        report["truncated"] = kept.size() < paths.size();
        report["paths"] = std::move(kept);
        return report.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
    }
```
(Add `#include <stdexcept>` and `#include <algorithm>` to `HostedPolicy.cpp` if absent; it already includes nlohmann for `HostedParseOllamaTags` — reuse that include.)

- [ ] **Step 4: Run to verify they pass**

Run: `.\RunTests.ps1`
Expected: all projects pass.

- [ ] **Step 5: Commit**

```bash
git add Modules/SmithAgent/HostedAgent.h Modules/SmithAgent/HostedPolicy.cpp Tests/SmithHostedAgentTest/Main.cpp
git commit --author="Claude Opus 5.5 <noreply@anthropic.com>" -m "Let hosted agents accept scans and branch-tip builds" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Agent execution — scans, branch tips, /resolve, access failures

**Files:**
- Modify: `Modules/SmithAgent/HostedAgent.cpp`

**Interfaces:**
- Consumes: Task 10 helpers; the coordinator routes from Task 8 (`/resolve` → `{spec}` or `{error:{message}}`).
- Produces: scan results `{status:"success", commit, scan:{…}}`; build results with `commit`; access failures `{status:"error", exitCode:-1, failure:"repo_access", message}`; label `smith-repo-projects` on enrollment and heartbeats.

- [ ] **Step 1: Add the failure type** — in the anonymous namespace, next to `InterruptedResult()`:
```cpp
// A git step failed. `failure` is "repo_access" when this machine's Git login cannot read the
// repository, so the coordinator hands the job to another machine instead of failing it.
struct GitFailure : std::runtime_error { std::string failure; GitFailure(const std::string& message,std::string kind):std::runtime_error(message),failure(std::move(kind)){} };
```

- [ ] **Step 2: Advertise the capability** — in `Runner::Run`, after the `for(const auto& cap:capabilities)…labels.push_back(cap);` line:
```cpp
        // This agent can scan repositories and build branch tips through /resolve.
        if(std::find(labels.begin(),labels.end(),"smith-repo-projects")==labels.end())labels.push_back("smith-repo-projects");
```

- [ ] **Step 3: Capture stderr and keep captured output quiet** — replace the `run` lambda and its comment with:
```cpp
        // capture (optional) receives stdout lines verbatim (unredacted) for commands whose output the
        // agent must parse; errors (optional) receives stderr lines the same way. Every line still
        // streams through log, except captured stdout when quiet (file lists, smith.json).
        auto run=[&](std::vector<std::string> argv,const fs::path& cwd,int timeout,const std::map<std::string,std::string>& env,std::vector<std::string>* capture=nullptr,std::vector<std::string>* errors=nullptr,bool quiet=false){
            Process process; ProcessOptions options;options.argv=std::move(argv);options.workingDir=cwd.string();options.timeoutSeconds=timeout;options.envOverride=env;
            auto sink=[&](bool error,const std::string& line){
                if(capture&&!error&&capture->size()<100000)capture->push_back(line);
                if(errors&&error&&errors->size()<1000)errors->push_back(line);
                if(!(quiet&&capture&&!error))log(error,line);
            };
            {std::lock_guard<std::mutex> lock(processMutex);if(lost)return -1;if(!process.Start(options,sink))return -1;active=&process;}
            int rc=process.Wait();{std::lock_guard<std::mutex> lock(processMutex);active=nullptr;}return rc;
        };
```

- [ ] **Step 4: Replace the checkout loop** (the `for(size_t i=0;i<spec.repos.size()&&!lost;++i) { … }` block) with:
```cpp
            for(size_t i=0;i<spec.repos.size()&&!lost;++i) {
                const auto& repo=spec.repos[i];auto checkout=Contained(job,repo.checkoutDir);
                fs::create_directories(checkout.parent_path());
                // Scans and resolving builds leave the commit empty and take the branch tip (ValidateHostedSpec allows nothing else).
                const bool tip=repo.commit.empty();
                log(false,"Repository URL: "+repo.url);
                log(false,"Requested branch: "+(repo.branch.empty()?std::string("(not specified)"):repo.branch));
                log(false,"Pinned commit: "+(tip?std::string("(branch tip)"):repo.commit));
                // Prompt-only env for GitHub/SSH sources; an Artifacts source additionally gets its
                // repo token as an Authorization header scoped to that origin (never argv/.git/config).
                const auto gitEnv=HostedGitAuthEnv(repo.url,repo.authToken);
                const std::map<std::string,std::string> promptOnly={{"GIT_TERMINAL_PROMPT","0"}};
                // A scan needs only the tree and smith.json: a shallow clone without file contents.
                std::vector<std::string> clone={"git","clone","--no-checkout"},gitErrors;
                if(spec.kind=="scan")clone.insert(clone.end(),{"--depth","1","--filter=blob:none"});
                if(tip&&!repo.branch.empty())clone.insert(clone.end(),{"--branch",repo.branch});
                clone.insert(clone.end(),{"--",repo.url,checkout.string()});
                if(run(clone,job,1800,gitEnv,nullptr,&gitErrors)!=0)throw GitFailure("Repository clone failed",HostedClassifyGitFailure(gitErrors));
                if(i==0)primary=checkout;
                if(spec.kind=="scan")continue;
                if(tip){
                    // --branch made the requested branch (or, without one, the remote's default) the clone's HEAD.
                    if(run({"git","checkout","--detach","HEAD"},checkout,1800,gitEnv)!=0)throw std::runtime_error("Branch checkout failed");
                } else {
                    if(run({"git","fetch","origin",repo.commit},checkout,1800,gitEnv)!=0)throw std::runtime_error("Pinned commit fetch failed");
                    if(spec.kind=="mirror"){
                        // A copy wants the tags too; the submodule step is skipped (a mirror pushes objects, not a tree).
                        if(run({"git","fetch","origin","--tags"},checkout,1800,gitEnv)!=0)throw std::runtime_error("Tag fetch failed");
                        continue;
                    }
                    if(run({"git","checkout","--detach",repo.commit},checkout,1800,gitEnv)!=0)throw std::runtime_error("Pinned commit checkout failed");
                }
                if(run({"git","submodule","update","--init","--recursive"},checkout,1800,promptOnly)!=0)throw std::runtime_error("Submodule checkout failed");
            }
            // The commit a branch-tip checkout landed on: reported with the result and to /resolve.
            std::string commit;
            if(!spec.repos.empty()&&spec.repos[0].commit.empty()&&!lost){
                std::vector<std::string> lines;
                if(run({"git","rev-parse","HEAD"},primary,120,{{"GIT_TERMINAL_PROMPT","0"}},&lines)!=0||lines.empty())throw std::runtime_error("Could not read the checked-out commit");
                commit=lines[0];
                log(false,"Checked out "+(spec.repos[0].branch.empty()?std::string("the default branch"):spec.repos[0].branch)+" @ "+commit.substr(0,12));
            }
            // smith.json and the tracked paths at HEAD, captured quietly so they never flood the build log.
            auto scanReport=[&](){
                const auto gitEnv=HostedGitAuthEnv(spec.repos[0].url,spec.repos[0].authToken);
                std::vector<std::string> branchLines,paths,smith;
                std::string branch=spec.repos[0].branch;
                if(branch.empty()&&run({"git","rev-parse","--abbrev-ref","HEAD"},primary,120,gitEnv,&branchLines)==0&&!branchLines.empty()&&branchLines[0]!="HEAD")branch=branchLines[0];
                if(run({"git","-c","core.quotepath=false","ls-tree","-r","--name-only","HEAD"},primary,600,gitEnv,&paths,nullptr,true)!=0)throw std::runtime_error("Could not list the repository's files");
                const bool hasSmithJson=std::find(paths.begin(),paths.end(),"smith.json")!=paths.end();
                if(hasSmithJson&&run({"git","show","HEAD:smith.json"},primary,600,gitEnv,&smith,nullptr,true)!=0)throw std::runtime_error("Could not read smith.json");
                std::string text;for(const auto& line:smith){text+=line;text+='\n';}
                log(false,hasSmithJson?"Read smith.json and "+std::to_string(paths.size())+" paths":"No smith.json at this commit");
                return HostedScanReport(commit,branch,hasSmithJson,text,paths);
            };
```

- [ ] **Step 5: Scan results and /resolve** — change `if(spec.kind=="mirror"){` (the push block after the loop) to start a chain:
```cpp
            if(spec.kind=="scan"){
                result={{"status","success"},{"exitCode",0},{"durationMs",0},{"message","Read smith.json at "+commit.substr(0,12)},{"commit",commit},{"scan",Json::parse(scanReport())}};
            } else if(spec.kind=="mirror"){
```
and at the start of the existing build `} else {` branch (before `const auto cwd=Contained(primary,spec.workingDir);`) insert:
```cpp
            if(!spec.resolve.action.empty()&&!lost){
                // Ask the coordinator what smith.json says to run for this action at this commit.
                Json request=lease; request["report"]=Json::parse(scanReport());
                Response response;
                for(int attempt=0;attempt<3;++attempt){response=m_transport.Post("/resolve",request);if(response.status!=0&&response.status<500)break;std::this_thread::sleep_for(std::chrono::seconds(2));}
                if(response.status==401||response.status==403||response.status==409){lose();throw std::runtime_error("Lease lost while resolving the build action");}
                if(!response.Ok()){
                    const auto reason=response.body.contains("error")&&response.body.at("error").is_object()?response.body.at("error").value("message",std::string()):std::string();
                    throw std::runtime_error(reason.empty()?"The coordinator could not resolve this build action ("+std::to_string(response.status)+")":reason);
                }
                JobSpec resolved;
                if(!response.body.contains("spec")||!FromJson(response.body.at("spec").dump(),resolved)||resolved.jobId!=spec.jobId||!resolved.resolve.action.empty())throw std::runtime_error("The coordinator returned an invalid build specification");
                const auto refused=ValidateHostedSpec(resolved); if(!refused.empty())throw std::runtime_error(refused);
                log(false,"Build action "+spec.resolve.action+" resolved at "+commit.substr(0,12));
                spec=resolved;
            }
```
After the build branch's `result={{"status",success?"success":"failed"},…};` line add:
```cpp
            if(!commit.empty())result["commit"]=commit;
```

- [ ] **Step 6: Report access failures** — change the end of `Execute`:
```cpp
        }catch(const GitFailure& error){result["message"]=error.what();if(!error.failure.empty())result["failure"]=error.failure;log(true,std::string(error.what())+(error.failure.empty()?"":" (this machine's Git login cannot read the repository; another machine will be tried)"));}
        catch(const std::exception& error){result["message"]=error.what();log(true,error.what());}
        stop=true;logs.join();renewStop=true;renew.join();watchdog.join();
        if(lost){result["status"]="error";result["exitCode"]=-1;result["message"]="Lease lost or cancelled; process tree stopped";result.erase("failure");}
```
(the `catch(const std::exception& error)` line and the two lines after it already exist; only the `GitFailure` catch and `result.erase("failure");` are new).

- [ ] **Step 7: Build and run every test**

Run: `.\Build.bat` then `.\RunTests.ps1` then `python Tests/SmithHostedAgentTest/hosted-runtime-test.py`
Expected: build succeeds; all test projects pass; the runtime test passes unchanged (it still sees `Repository URL:`, `Requested branch:` and `Pinned commit:` lines).

The agent only accepts `https://` coordinators (`HostedOriginValid`), so there is no local end-to-end run; the first end-to-end scan happens on the live experiment after the user deploys (Task 13, Step 4). Never point a development agent at the live coordinator yourself.

- [ ] **Step 8: Commit**

```bash
git add Modules/SmithAgent/HostedAgent.cpp
git commit --author="Claude Opus 5.5 <noreply@anthropic.com>" -m "Scan repositories and build branch tips on hosted agents" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Dashboard

**Files:**
- Create: `cloudflare/coordinator/public/repo-projects.js`
- Modify: `cloudflare/coordinator/public/index.html`, `cloudflare/coordinator/public/app.js`, `cloudflare/coordinator/public/style.css`

**Interfaces:**
- Consumes: `GET /projects` (repo projects carry `kind: 'repo'`, `scan`, `actions`, `access`, `unusedRules`, `disabledRules`, `warnings`), `POST /projects` with `{ source: 'git', url, branch? }`, `POST /projects/{id}/rescan`, settings `githubTokenSet`/`githubTokenUpdatedAt`, `githubToken`/`clearGithubToken`.
- Produces: `repoProjectCard(project, { element, badge, date, onBuild, onRescan, onShowJob })` → `HTMLElement`.

- [ ] **Step 1: Create `public/repo-projects.js`**

```js
'use strict';
// Cards for projects added from a Git URL: their smith.json build actions, or why those are not
// known yet (waiting for a machine that can read the repository, or a read error).

const PLATFORMS = { windows: 'Windows', linux: 'Linux', mac: 'macOS' };

export function repoProjectCard(project, { element, badge, date, onBuild, onRescan, onShowJob }) {
  const card = element('article', undefined, 'project');
  card.append(element('h3', project.name || project.id));
  const via = project.scan.via === 'github' ? 'read via GitHub' : project.scan.host ? `read on ${project.scan.host}` : '';
  card.append(element('p', `${project.repoUrl}\n${project.branch || 'default branch'} · ${project.commit ? project.commit.slice(0, 12) : 'not read yet'}${via ? ' · ' + via : ''}`, 'source'));
  if (project.scan.state !== 'ready') card.append(status(project, { element, badge, date, onShowJob }));
  for (const warning of project.warnings || []) card.append(element('p', warning, 'muted small'));
  for (const item of project.actions || []) {
    const row = element('div', undefined, 'product'); const text = element('div');
    text.append(element('strong', item.label), element('p', [item.os.map(os => PLATFORMS[os] || os).join(', '), ...item.notes].filter(Boolean).join(' · ')));
    const button = element('button', 'Build'); button.disabled = !item.available;
    if (item.available) button.addEventListener('click', () => onBuild(button, item.id));
    row.append(text, button); card.append(row);
  }
  const skipped = [project.unusedRules ? `${project.unusedRules} rule${project.unusedRules === 1 ? '' : 's'} not used on ${project.branch || 'this branch'}` : '',
    project.disabledRules ? `${project.disabledRules} disabled` : ''].filter(Boolean);
  const foot = element('div', undefined, 'repo-foot');
  foot.append(element('span', [...skipped, 'Builds are manual here; smith.json triggers are ignored.'].join(' · '), 'muted small'));
  const rescan = element('button', 'Rescan', 'quiet');
  rescan.addEventListener('click', () => onRescan(rescan, project.id));
  foot.append(rescan); card.append(foot);
  return card;
}
function status(project, { element, badge, date, onShowJob }) {
  const row = element('div', undefined, 'artifacts');
  row.append(badge(project.scan.state), element('span', project.scan.message || '', 'message'));
  if (project.scan.state === 'waiting') row.append(element('span', 'Its build actions (from smith.json) appear once a machine has read it.', 'muted small'));
  for (const denial of project.access || []) row.append(element('span', `${denial.host}: no access (${denial.message}) · ${date(denial.at)}`, 'muted small'));
  if (project.scan.jobId) {
    const open = element('button', 'Show output', 'build-link');
    open.addEventListener('click', () => onShowJob(open, project.scan.jobId));
    row.append(open);
  }
  return row;
}
```

- [ ] **Step 2: `index.html` — the Add project dialog**

Replace the dialog's content between the `section-heading` div and `<div class="dialog-actions">` (the intro paragraph and every field) with:
```html
    <div class="field"><label for="project-source">Source</label><select id="project-source"><option value="git">Git URL (reads smith.json)</option><option value="manual">Manual (pinned commit and products JSON)</option></select></div>
    <fieldset id="git-source-fields" class="source-fields">
      <label for="git-url">Repository URL</label><input id="git-url" required maxlength="256" placeholder="git@github.com:org/repo.git" autocomplete="off" spellcheck="false">
      <label for="git-branch">Branch</label><input id="git-branch" maxlength="256" placeholder="Default branch" autocomplete="off" spellcheck="false">
      <p class="muted small">Smith reads the repository's smith.json and offers its build actions, which build the newest commit on the branch. If the workspace's GitHub token can read the repository this is immediate; otherwise a build machine that can clone it reads it first.</p>
    </fieldset>
    <fieldset id="manual-source-fields" class="source-fields" hidden disabled>
      <p class="muted small">Smith builds the repository at a pinned commit using the script named below. Machines check the source out with their own Git credentials.</p>
      (the existing project-id / project-name / project-repo / project-branch / project-commit / project-products fields, unchanged)
    </fieldset>
```
Move the existing manual fields into `manual-source-fields` verbatim (do not change their IDs or attributes).

In the workspace settings form, after the "Remove the stored token" Cloudflare checkbox field and before `<div class="actions">`, add:
```html
          <h3>GitHub <span id="github-status" class="muted small"></span></h3>
          <p class="muted small">Lets Smith read <code>smith.json</code> from GitHub repositories straight away when a project is added or rescanned, without waiting for a build machine. Use a fine-grained token with read-only <em>Contents</em> and <em>Metadata</em> access to the repositories (or organisation) Smith should read. It is stored write-only and never given to builds or coding agents.</p>
          <div class="field"><label for="github-token">Access token</label><input id="github-token" type="password" maxlength="256" autocomplete="new-password" spellcheck="false"><p class="muted small">Leave blank to keep the current token.</p></div>
          <div class="field check"><label><input id="clear-github-token" type="checkbox"> Remove the stored GitHub token</label></div>
```

- [ ] **Step 3: `app.js`**

1. Import: `import { repoProjectCard } from './repo-projects.js';`
2. Add `'waiting', 'scanning', 'ready'` to the `known` array in `badge()`.
3. Extract the build-button handler in `renderProjects` into:
```js
function startBuild(button, project, product) {
  return action(button, async () => {
    const current = generation;
    const job = await submitBuild(requestId => api(base() + '/jobs', { requestId, projectId: project.id, product }), sessionStorage, `${workspaceId}/${project.id}/${product}`);
    if (current !== generation) return;
    await refresh(); await selectJob(job.id);
  });
}
```
and make the existing button call `startBuild(button, project, product.name)`.
4. In `renderProjects`, change the empty message to `'No projects yet. Use Add project to build a repository from its smith.json.'` and add at the top of the `for (const project of projects)` loop:
```js
    if (project.kind === 'repo') {
      $('projects').append(repoProjectCard(project, { element, badge, date,
        onBuild: (button, product) => startBuild(button, project, product),
        onRescan: (button, id) => action(button, async () => { await api(base() + '/projects/' + encodeURIComponent(id) + '/rescan', {}); await refresh(true); }),
        onShowJob: (button, id) => action(button, () => selectJob(id)) }));
      continue;
    }
```
5. In `refresh`, extend the "keep projects fresh" condition:
```js
  if (projects.some(project => copying.has(project.artifacts?.status) || (project.kind === 'repo' && ['waiting', 'scanning'].includes(project.scan?.state)))) includeProjects = true;
```
6. In `renderJobs`: `const what = job.kind === 'mirror' ? 'copy to Artifacts' : job.kind === 'scan' ? 'read smith.json' : job.product || 'build';` and change the ID line to `first.append(button, element('div', job.id.slice(0, 8) + (job.result?.commit ? ' · ' + job.result.commit.slice(0, 7) : ''), 'muted small'));`.
7. Add-project dialog wiring — replace the existing `$('add-project')` click handler and the submit handler with:
```js
function showSource() {
  const git = $('project-source').value === 'git';
  $('git-source-fields').hidden = !git; $('git-source-fields').disabled = !git;
  $('manual-source-fields').hidden = git; $('manual-source-fields').disabled = git;
}
$('project-source').addEventListener('change', showSource);
$('add-project').addEventListener('click', () => {
  if (!$('project-products').value.trim()) $('project-products').value = JSON.stringify(defaultProducts, null, 2);
  showSource(); $('add-project-dialog').showModal();
  ($('project-source').value === 'git' ? $('git-url') : $('project-id')).focus();
});
$('add-project-form').addEventListener('submit', event => {
  event.preventDefault();
  void action($('submit-add-project'), async () => {
    const current = generation;
    if ($('project-source').value === 'git') {
      const body = { source: 'git', url: $('git-url').value.trim() };
      if ($('git-branch').value.trim()) body.branch = $('git-branch').value.trim();
      await api(base() + '/projects', body);
      if (current !== generation) return;
      $('add-project-dialog').close(); $('add-project-form').reset(); $('project-products').value = '';
      await refresh(true);
      return;
    }
    // (the existing manual branch, unchanged from `let products;` to the askMirror call)
  });
});
```
8. Settings — in `renderWorkspaceSettings` after the Cloudflare lines:
```js
  $('github-token').value = ''; $('clear-github-token').checked = false;
  $('github-token').placeholder = s.githubTokenSet ? '•••••••• token stored (blank keeps it)' : 'Paste a GitHub token (github_pat_…)';
  $('clear-github-token').parentElement.parentElement.hidden = !s.githubTokenSet;
  $('github-status').textContent = s.githubTokenSet ? `● token set${s.githubTokenUpdatedAt ? ' · updated ' + date(s.githubTokenUpdatedAt) : ''}` : '○ no token';
```
and in the workspace form submit after the Cloudflare token lines:
```js
    if ($('clear-github-token').checked) body.clearGithubToken = true;
    else if ($('github-token').value.trim()) body.githubToken = $('github-token').value.trim();
```
plus `$('github-token').value = '';` beside the existing `$('cloudflare-token').value = '';` after saving.

- [ ] **Step 4: `style.css`**

```css
.source-fields { border: 0; padding: 0; margin: 0; min-width: 0; }
.repo-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 12px; border-top: 1px solid var(--border); }
.badge.waiting { background: #1a3043; color: #84c6ff; }
.badge.scanning { background: #1a3043; color: #84c6ff; }
.badge.ready { background: #1c3429; color: var(--ok); }
```

- [ ] **Step 5: Verify in a browser (local, no deploy)**

From `cloudflare/coordinator`: `npx wrangler d1 migrations apply smith-experiment-identity --local`, start `npm run dev` in the background, run `node tools/invite.mjs --local`, open `http://localhost:8787`, sign in, create a workspace, and check:
- Add project shows Source = Git URL with URL and Branch; switching to Manual shows the old fields; submitting Git URL with a blank branch works (manual fields' `required` must not block it).
- The new card shows *Waiting for a machine to read smith.json.* with a Show output link; Builds lists a `read smith.json` job.
- Settings shows the GitHub section; saving a `github_pat_…` value shows "● token set" and the value never reappears.
- At 375px width the dialog and card have no horizontal scroll.
Stop the dev server afterwards.

- [ ] **Step 6: Run the checks and commit**

Run: `npm run verify`
Expected: PASS.
```bash
git add cloudflare/coordinator/public
git commit --author="Claude Opus 5.5 <noreply@anthropic.com>" -m "Add projects from a Git URL in the dashboard" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Docs, full verification and hand-back

**Files:**
- Modify: `docs/cloudflare/operations.md`, `docs/cloudflare/progress.md`

- [ ] **Step 1: Document**

`docs/cloudflare/operations.md` — in the API table add rows:
```
| `POST /projects` with `{ "source": "git", "url", "branch"? }` | Owners/admins add a project from a Git URL; Smith reads its smith.json via the workspace GitHub token or a machine scan |
| `POST /projects/{id}/rescan` | Owners/admins re-read smith.json and clear the project's "no access" marks |
| `POST /resolve` (node) | A branch-tip build posts what it checked out (commit, smith.json, file list) and receives its command |
```
and a short section **Projects from a Git URL** covering: the `smith-repo-projects` label (update agents with `SmithAgent.bat update` or `PackageAgent.bat --install`), the deploy order (Worker first), the GitHub token (Settings → Workspace → GitHub; fine-grained, read-only Contents + Metadata), repo-access routing (a machine whose Git login is refused is skipped for an hour or until Rescan), and what is not supported yet (handoffs, inputs, glob/zip artifacts, triggers, repos without smith.json).

`docs/cloudflare/progress.md` — one dated entry (2026-10-05) summarising the feature and linking the spec and this plan.

- [ ] **Step 2: Bring in the latest branch and run everything**

```bash
git fetch origin && git merge origin/feature/cloudflare-experiment
```
Resolve conflicts keeping both sides' intent (other sessions edit `workspace.ts`, `app.js`, `index.html` often). Then:
Run (from `cloudflare/coordinator`): `npm ci && npm run verify` — Expected: typecheck clean, all tests pass, dry-run bundle builds.
Run (repo root): `.\Build.bat`, `.\RunTests.ps1`, `python Tests/SmithHostedAgentTest/hosted-runtime-test.py` — Expected: all pass.

- [ ] **Step 3: Commit the docs**

```bash
git add docs/cloudflare/operations.md docs/cloudflare/progress.md
git commit --author="Claude Opus 5.5 <noreply@anthropic.com>" -m "Document projects added from a Git URL" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Hand back**

Use superpowers:finishing-a-development-branch. The user asked for work to land on `feature/cloudflare-experiment`: merge `feature/repo-projects` into it (fast-forward if possible), push, and tell the user, in this order:
1. Deploy the Worker (`DeployWorker.bat`) **before** updating agents.
2. Update each agent (`SmithAgent.bat update`, or `PackageAgent.bat --install C:\SmithAgent`, or rebuild `.smith-operator`'s agent).
3. Optional: add a GitHub token in Settings for instant reads.
4. Try: Add project → `git@github.com:Red-Marmoset/senet.git` → build `build-check` only. Never click a deploy action while testing.
