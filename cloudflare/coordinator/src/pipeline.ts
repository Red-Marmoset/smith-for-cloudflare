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
  serial: boolean;   // one build of this product at a time across the workspace (a deploy), whatever the number of machines
}
export interface ClassifyRule { match: string; os: string; labels: string[]; preferOs: string }
export interface Discover { type: string; glob: string; values: string[]; as: string; classify: ClassifyRule[] }
export interface Product { name: string; outputPath: string; discover: Discover; rules: Rule[] }
// A smith.json trigger. Hosted Smith acts on `webhook` ones: a push to the project's branch builds the product (CoordinatorTriggers.cpp
// HandleWebhook picks the first webhook trigger's product; here every webhook trigger that matches the branch builds).
export interface Trigger { type: string; branches: string[]; product: string }
export interface SmithConfig { id: string; name: string; defaultBranch: string; products: Product[]; triggers: Trigger[] }
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
    name: str(j, 'name', '', at), enabled: bool(j, 'enabled', true, at), branches: strArray(j, 'branches'), serial: bool(j, 'serial', false, at),
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
  try { root = JSON.parse(text.replace(/^﻿/, '')); } catch { root = undefined; }
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
  const triggers = objects(root, 'triggers').map((trigger, i): Trigger => {
    const at = `triggers[${i}]`; int(trigger, 'intervalSeconds', 0, at); str(trigger, 'cron', '', at);
    return { type: str(trigger, 'type', '', at), branches: strArray(trigger, 'branches'), product: str(trigger, 'product', '', at) };
  });
  objects(root, 'chains').forEach((chain, i) => { const at = `chains[${i}]`; str(chain, 'name', '', at); str(chain, 'onFailure', '', at); });
  return { id, name, defaultBranch: (repos.find(repo => repo.primary) ?? repos[0])?.defaultBranch ?? 'main', products, triggers };
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

// ---- Build actions: what a project offers on a branch, and what a build runs ----

export type Os = 'windows' | 'linux' | 'mac';
const OSES: Os[] = ['windows', 'linux', 'mac'];
export const MAX_ACTIONS = 100;
// `scripts`: the repository files the action's commands run (as written, and under the rule's workingDir), recorded so a
// crew proposal that edits one cannot be verified from Review. Projects scanned before it was recorded lack it.
export interface PipelineAction { id: string; label: string; product: string; rule: string; variant: string | null; os: Os[]; labels: string[]; notes: string[]; available: boolean; scripts?: string[]; serial?: boolean }
// onPush: the IDs of the actions a push to the branch builds (the smith.json `webhook` triggers that name the branch, or any
// branch), in smith.json order; an unavailable action is left out and named in `warnings`.
export interface Pipeline { projectId: string; name: string; actions: PipelineAction[]; onPush: string[]; unusedRules: number; disabledRules: number; warnings: string[] }
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
  if (rule.serial) notes.push('One at a time: a build waits while another build of this product is running');
  return { id, label: [product.name, rule.name, variant?.name].filter(Boolean).join(' · '), product: product.name, rule: rule.name, variant: variant?.name ?? null,
    os, labels: [...new Set(selector.labels)], notes, available: !rule.inputs.length && os.length > 0, scripts: scriptsOf(rule, os), ...(rule.serial ? { serial: true } : {}) };
}
function scriptsOf(rule: Rule, os: Os[]): string[] {
  const clean = (path: string) => path.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  const scripts = os.flatMap(name => rule.stepsByOs[name] ?? (rule.commandByOs[name] ? [rule.commandByOs[name]] : [])).map(command => clean(command.script)).filter(Boolean);
  const dir = clean(rule.workingDir).replace(/\/+$/, '');
  return [...new Set(dir && dir !== '.' ? scripts.flatMap(script => [script, `${dir}/${script}`]) : scripts)];
}
export function mapPipeline(text: string, paths: readonly string[], branch: string, truncated = false): Pipeline {
  const config = parseSmithJson(text);
  const all = candidates(config, paths, branch);
  const used = new Set(all.map(candidate => candidate.rule));
  const rules = config.products.flatMap(product => product.rules);
  const warnings: string[] = [];
  if (truncated && config.products.some(product => product.discover.type === 'files')) warnings.push('The repository file list was cut short, so some discovered variants may be missing');
  if (all.length > MAX_ACTIONS) warnings.push(`Only the first ${MAX_ACTIONS} of ${all.length} build actions are offered`);
  const actions = all.slice(0, MAX_ACTIONS).map(describe);
  return { projectId: config.id, name: config.name || config.id, actions, onPush: pushActions(config, actions, branch, warnings),
    unusedRules: rules.filter(rule => rule.enabled && !used.has(rule)).length, disabledRules: rules.filter(rule => !rule.enabled).length, warnings };
}
// The actions the branch's webhook triggers build on a push. A trigger without a product means the first product that builds on
// the branch (as LAN's HandleWebhook falls back to the first product); one naming a product builds every action of that product
// (each discovered variant). Products that do not build on the branch, or cannot run here, are reported rather than queued.
function pushActions(config: SmithConfig, actions: PipelineAction[], branch: string, warnings: string[]): string[] {
  const out: string[] = [];
  const add = (action: PipelineAction) => { if (!out.includes(action.id)) out.push(action.id); };
  for (const trigger of config.triggers) {
    if (trigger.type !== 'webhook' || (trigger.branches.length && !branchMatches(trigger.branches, branch))) continue;
    if (!trigger.product) { const first = actions.find(action => action.available); if (first) add(first); continue; }
    const product = config.products.find(p => p.name === trigger.product);
    const matching = product ? actions.filter(action => action.product === product.name) : [];
    if (!matching.length) { warnings.push(`The webhook trigger for "${trigger.product}" names a product that does not build on ${branch || 'this branch'}`); continue; }
    for (const action of matching) action.available ? add(action) : warnings.push(`The webhook trigger for "${trigger.product}" cannot run here: ${action.notes.join(' ') || 'the action is unavailable'}`);
  }
  return out;
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
