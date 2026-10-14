import { ORCHESTRATION_TEMPLATES } from './crew-orchestration-templates';
import { validateMemberOrchestration, type MemberOrchestration } from './crew-orchestration-model';
// The crew member and report model: types, templates, validation of a crew-put body and of a run's report, and the
// report schema handed to the CLI. Pure (no bindings), so it is unit-testable; re-exported from crew.ts.
import { fail, fields, object } from './http';
import { choice, flag, integer, text } from './settings';
import { validBranch } from './repo-projects';
import type { AiInventory, AiOrderChoice } from './ai';

// 'auto' (the default): whichever AI the machine has ready, in the workspace's AI order (Settings: Claude, then GPT, then a
// local model); 'login': the machine's own sign-in of the member's tool (Claude Code or Codex); 'api-key': the workspace's
// Anthropic key (Claude Code only); 'ollama': a local model. A run always records the brain it was resolved to, never 'auto'.
export type CrewBrain = 'auto' | 'login' | 'api-key' | 'ollama';
export type CrewRunBrain = Exclude<CrewBrain, 'auto'>;
// The CLI a member runs: 'auto' lets the brain decide (a local model runs in whichever CLI the machine has, Claude Code first).
export type CrewTool = 'auto' | 'claude-code' | 'codex';
export type CrewRunTool = Exclude<CrewTool, 'auto'>;
export type CrewMode = 'plan' | 'acceptEdits';
// branchChanged: Smith looks at `branch` (the primary project's own when empty) every checkMinutes, and the member runs when
// its tip moved since the member last looked; a look that finds nothing new is not a run (crew.ts).
export interface CrewTrigger { kind: 'manual' | 'interval' | 'buildFinished' | 'branchChanged'; intervalMinutes?: number; skipIfUnchanged?: boolean; on?: 'failed' | 'any'; branch?: string; checkMinutes?: number }
export interface CrewBudget { usdPerRun: number; maxMinutes: number; runsPerDay: number; buildsPerDay: number }
export interface CrewMember {
  orchestration?: MemberOrchestration | null;
  id: string; slug: string; name: string; template: string | null; charter: string; projectIds: string[]; attachSharedProjects: boolean;
  tool: CrewTool; brain: CrewBrain; model: string | null; nodeId: string | null; permissionMode: CrewMode; trigger: CrewTrigger; budget: CrewBudget;
  verifyProduct: string | null; mayCreateProjects: boolean; mayMessage: boolean; enabled: boolean; memory: string; lastSeen: Record<string, string>;
  nextRunAt: number | null; charterUpdatedAt: number | null; createdBy: string; createdAt: number; updatedAt: number;
}
export interface CrewReport { summary: string; findings: { severity: 'low' | 'medium' | 'high'; title: string; file?: string; line?: number; detail: string; confidence?: number | null; category?: string; files?: string[]; blocking?: boolean }[]; proposal?: { title: string; summary: string }; memory?: string; skipped?: boolean }
// A project the run clones read-only beside its checkout; authToken is an Artifacts read token, or '' for the machine's own Git login.
// commit is '' when Smith knows none yet (a project added from a Git URL before its smith.json was read); the agent then
// clones the tip of branch, or of the remote's HEAD when branch is '' too.
export interface CrewRelated { projectId: string; url: string; commit: string; branch: string; authToken: string }
// What the agent receives on an ai-claim of a crew message turn, beside the chat fields. projectBranch is the primary
// project's branch, whose tip the run starts from ('' for the remote's HEAD); repo.branch is the run's own branch.
export interface CrewClaimMaterial {
  orchestration?: Record<string, unknown> | null;
  sessionKind: 'crew'; systemPrompt: string; schema: string /* minified JSON, cmd-safe */; env: Record<string, string>;
  mcp: { url: string; token: string }; memory: string; inbox: { seq: number; from: string; body: string; at: number }[];
  related: CrewRelated[]; skipIfCommit: string | null; budget: CrewBudget; changesSince: string | null; projectBranch: string;
  member: { id: string; slug: string; name: string; permissionMode: CrewMode; mayCreateProjects: boolean };
  dryRun?: true;   // Dry run: prepare the inputs and decide the skip, but never start the CLI
  buildLog?: { jobId: string; text: string };   // a buildFinished run: the tail of that build's log, written to input/build-<jobId>.log
}
// A crew push turn runs no CLI: beside the chat's push fields it names the member, whose clone holds the branch, and says
// whether there is one to push (pushBranch); a run that created projects adds each with its remote and write token, and the
// author of their first commit.
export interface CrewPushClaimMaterial {
  orchestration?: Record<string, unknown> | null;
  member?: { id: string }; pushBranch: boolean;
  createdProjects?: { id: string; remote: string; authToken: string }[]; author?: { name: string; slug: string };
}

// ---- Choosing the AI a run uses ------------------------------------------------------------------------------
// What one run is resolved to on one machine.
export interface CrewAiPick { tool: CrewRunTool; brain: CrewRunBrain; model: string | null }
// A machine as the choice sees it: its reported AI inventory, whether an admin enrolled it for builds (only those ever
// get the workspace key), and whether the workspace key may be spent on this run (set, and within the daily limit).
export interface CrewAiMachine { ai: AiInventory; buildMachine: boolean; apiKeyUsable: boolean }

const TOOL_LABEL: Record<CrewRunTool, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };
// Codex crew runs need an agent that knows how to run them, and on Windows Codex's own sandbox (without it Codex refuses edits).
function codexBlock(ai: AiInventory): string | null {
  if (!(ai.features ?? []).includes('crew-codex')) return 'agent update needed for Codex';
  if (ai.codexSandbox !== undefined && ai.codexSandbox !== 'ready') return 'Codex sandbox not set up';
  return null;
}
function toolBlock(ai: AiInventory, tool: CrewRunTool): string | null {
  if (!ai.tools.some(t => t.id === tool)) return `${TOOL_LABEL[tool]} is not installed`;
  return tool === 'codex' ? codexBlock(ai) : null;
}
// A sign-in: the CLI is installed, ready, and reports itself signed in (checked with API keys removed, as the run will be).
function signIn(ai: AiInventory, tool: CrewRunTool, signedOut: string): CrewAiPick | string {
  const blocked = toolBlock(ai, tool);
  if (blocked) return blocked;
  return ai.tools.find(t => t.id === tool)?.signedIn === true ? { tool, brain: 'login', model: null } : signedOut;
}
// A local model: the named one, or the machine's largest (the likeliest to be a capable chat model rather than an
// embedding one), never a cloud model; run in the named CLI, or the first installed one (Claude Code, then Codex).
function localModel(ai: AiInventory, model: string | null, tool: CrewTool): CrewAiPick | string {
  const local = ai.ollama.models.filter(m => !m.remote);
  const chosen = model ? local.find(m => m.name === model)?.name : [...local].sort((a, b) => b.sizeBytes - a.sizeBytes || a.name.localeCompare(b.name))[0]?.name;
  if (!chosen) return model ? `no local model ${model}` : 'no local model';
  const tools: CrewRunTool[] = tool === 'auto' ? ['claude-code', 'codex'] : [tool];
  const reasons: string[] = [];
  for (const candidate of tools) {
    const blocked = toolBlock(ai, candidate);
    if (!blocked) return { tool: candidate, brain: 'ollama', model: chosen };
    reasons.push(blocked);
  }
  return tool === 'auto' ? 'neither Claude Code nor Codex is installed to run a local model' : reasons[0];
}
// The AI a member's run uses on a machine, or why it cannot use one there. A member that named its AI gets exactly that;
// an automatic one gets the first kind in the workspace's order the machine has ready: Claude (the machine's Claude Code
// sign-in, else the workspace key on a build machine), GPT (the machine's Codex sign-in), then a local model.
export function chooseCrewAi(member: Pick<CrewMember, 'tool' | 'brain' | 'model'>, machine: CrewAiMachine, order: readonly AiOrderChoice[]): CrewAiPick | string {
  const { ai } = machine;
  if (member.brain === 'login') return signIn(ai, member.tool === 'codex' ? 'codex' : 'claude-code', 'no signed-in machine');
  if (member.brain === 'ollama') return localModel(ai, member.model, member.tool);
  if (member.brain === 'api-key') {
    const blocked = toolBlock(ai, 'claude-code');
    return blocked ?? { tool: 'claude-code', brain: 'api-key', model: null };
  }
  const reasons: string[] = [];
  for (const choice of order) {
    let pick: CrewAiPick | string;
    if (choice === 'claude') {
      pick = signIn(ai, 'claude-code', 'Claude Code is not signed in');
      if (typeof pick === 'string' && ai.tools.some(t => t.id === 'claude-code') && machine.buildMachine && machine.apiKeyUsable) pick = { tool: 'claude-code', brain: 'api-key', model: null };
    } else if (choice === 'gpt') pick = signIn(ai, 'codex', 'Codex is not signed in');
    else pick = localModel(ai, member.model, 'auto');
    if (typeof pick !== 'string') return pick;
    reasons.push(pick);
  }
  return reasons.length ? `no AI ready (${reasons.join(', ')})` : 'no AI allowed in Settings';
}

// ---- Templates -------------------------------------------------------------------------------------------------
// Starting points only: a member copies a template's values and the person edits them freely. `custom` has no charter.
export type CrewTemplateKey = 'standards' | 'bug-hunter' | 'test-proposer' | 'extractor' | 'feature-planner' | 'implementer' | 'bug-fixer' | 'pipeline-setup' | 'failure-triage' | 'dependency-maintenance' | 'custom' | 'standards-reviewer' | 'cleanup-reviewer' | 'test-reviewer' | 'security-reviewer' | 'architecture-reviewer';
export interface CrewTemplate { orchestration?: MemberOrchestration; name: string; charter: string; brain: CrewBrain; permissionMode: CrewMode; trigger: CrewTrigger; attachSharedProjects: boolean }
export const CREW_TEMPLATES: Record<CrewTemplateKey, CrewTemplate> = {
  'failure-triage': { name: 'Failure triage', brain: 'auto', permissionMode: 'plan', trigger: { kind: 'buildFinished', on: 'failed' }, attachSharedProjects: false,
    charter: 'You investigate failed Smith builds using the build log in input/ and the commits in input/changes.md. Identify the likely root cause and distinguish code defects from flaky tests, missing tools and machine or environment failures. Report actionable findings with exact files, lines and supporting log evidence, plus the smallest suggested fix or regression test. Do not edit files, weaken tests, merge or deploy changes.' },
  'dependency-maintenance': { name: 'Dependency maintenance', brain: 'auto', permissionMode: 'plan', trigger: { kind: 'branchChanged', branch: '', checkMinutes: 5 }, attachSharedProjects: false,
    charter: 'You review dependency manifests and lockfiles affected by the commits in input/changes.md. Report evidence-backed security risks, incompatible versions, stale or unused dependencies and manifest/lockfile inconsistencies. Suggest the smallest compatible update with the affected files, compatibility risks and required verification; do not claim a vulnerability without supporting evidence. Do not edit files, perform unsafe or speculative upgrades, weaken security checks, merge or deploy changes.' },
  standards: { name: 'Standards', brain: 'auto', permissionMode: 'acceptEdits', trigger: { kind: 'interval', intervalMinutes: 360, skipIfUnchanged: true }, attachSharedProjects: false,
    charter: 'You enforce this repository\'s coding conventions (its CLAUDE.md or AGENTS.md, and the style of the surrounding code) on the commits listed in input/changes.md. Fix clear violations in small, separate edits; do not reformat unrelated code. Report what you fixed and what you left alone.' },
  'bug-hunter': { name: 'Bug hunter', brain: 'auto', permissionMode: 'plan', trigger: { kind: 'interval', intervalMinutes: 720, skipIfUnchanged: true }, attachSharedProjects: false,
    charter: 'You look for new bugs in the commits listed in input/changes.md: logic errors, unchecked failures, races, off-by-ones, resource leaks. Report each with file and line and a one-paragraph explanation. Remember what you already reported so you do not repeat it.' },
  'test-proposer': { name: 'Test proposer', brain: 'auto', permissionMode: 'acceptEdits', trigger: { kind: 'buildFinished', on: 'any' }, attachSharedProjects: false,
    charter: 'You propose tests for behaviour that changed recently and has none, following the test style already in the repository. Add small tests; never change the code under test.' },
  extractor: { name: 'Extractor', brain: 'auto', permissionMode: 'plan', trigger: { kind: 'interval', intervalMinutes: 1440, skipIfUnchanged: false }, attachSharedProjects: true,
    charter: 'You look across this crew member\'s projects (the primary checkout and input/related/*) for functionality that is duplicated and would be better as one shared project. Report concrete candidates with the files involved in each project. Only propose creating a new project if the workspace allows it and the duplication is real.' },
  // The development crew: a planner that decides what to build next, an implementer that builds it, and a fixer that
  // repairs what broke. They hand work to each other through crew messages; a person still reviews every branch.
  'feature-planner': { name: 'Feature planner', brain: 'auto', permissionMode: 'plan', trigger: { kind: 'interval', intervalMinutes: 1440, skipIfUnchanged: false }, attachSharedProjects: false,
    charter: 'You plan the next features of this project. Read its README, docs, design notes, TODOs and open plans, the commits in input/changes.md and your inbox, and work out the few most valuable next steps that fit where the project is heading. Report each as a finding: what to build and why, the files it touches, and a short step-by-step plan small enough for one implementation run. Then send the most valuable one to the Implementer with crew_send (if it is on the crew; see crew_list). Remember what you already planned and what was built, so you move the project forward instead of repeating yourself. Do not edit files.' },
  implementer: { name: 'Implementer', brain: 'auto', permissionMode: 'acceptEdits', trigger: { kind: 'interval', intervalMinutes: 720, skipIfUnchanged: false }, attachSharedProjects: false,
    charter: 'You implement features on your own branch. Take the next planned piece of work from your inbox (plans from the Feature planner or requests from people), or, if there is none, the next open item in the project\'s own plans and TODOs. Build one small, coherent step per run, following the conventions and style of the surrounding code (its CLAUDE.md or AGENTS.md), with tests in the repository\'s existing test style where it has them. Do not start work that cannot be finished in this run; report what you built, what is left, and anything you could not verify. Remember which plan you are working through.' },
  'bug-fixer': { name: 'Bug fixer', brain: 'auto', permissionMode: 'acceptEdits', trigger: { kind: 'buildFinished', on: 'failed' }, attachSharedProjects: false,
    charter: 'You fix bugs on your own branch. When a build failed, read its log in input/ and the commits in input/changes.md, find the root cause and fix it; also fix the bugs reported in your inbox (from the Bug hunter or from people). Make the smallest change that fixes the cause, not the symptom, and add a regression test in the repository\'s existing test style where you can. Never weaken or delete a test to make it pass. If the failure is in the environment (a missing tool, a flaky machine) rather than the code, change nothing and say so. Remember what you fixed.' },
  // Makes sure the project builds in Smith: the "Pipeline:" line of its prompt (crew-prompt.ts) says when smith.json is
  // missing, detected or unreadable.
  'pipeline-setup': { name: 'Pipeline setup', brain: 'auto', permissionMode: 'acceptEdits', trigger: { kind: 'interval', intervalMinutes: 1440, skipIfUnchanged: true }, attachSharedProjects: false,
    charter: 'You make sure this project builds in Smith. Smith builds what the smith.json at the repository root declares; without one it falls back to a default it detects (the project\'s own build.bat / build.ps1 / build.sh, an npm build, or packing a static site), and the "Pipeline:" line in your prompt says when smith.json is missing, detected or broken. If smith.json is missing, invalid, or no longer matches the project (renamed scripts, new platforms, tests nobody runs), write or fix it and the build scripts it calls. smith.json is strict JSON: "schemaVersion": 1, "project": {"id", "name"}, and "buildProducts": [{"name", "rules": [{"name", "nodeSelector": {"os", "labels"}, "command": {"windows" | "linux" | "mac": {"interpreter": "bat" | "ps1" | "sh" | "python" | "exe", "script": "path/in/repo", "args": []}}, "timeoutSeconds", "artifacts": {"globs": [], "package": "none"}}]}]. Args do not go through a shell, so put pipes and "&&" in a script; give every rule a timeout; name only machine labels such as npm, node, cmake or unity6 that a build really needs. Hosted builds keep at most four exact file paths (no wildcards, no zip packaging) and run no handoff steps, so do the packaging in the script. Never add a deploy, publish or upload step, a credential or a secret unless a person asked for it in your inbox; never change application code. You cannot run the build, so check each script path against the files and say what you could not verify. If the pipeline is already right, change nothing and say so. Remember what you set up.' },
  ...Object.fromEntries(Object.entries(ORCHESTRATION_TEMPLATES).filter(([key])=>key!=='bug-hunter').map(([key,value])=>[key,{...value,brain:'auto',trigger:{kind:'manual'},attachSharedProjects:false}])) as Record<'standards-reviewer'|'cleanup-reviewer'|'test-reviewer'|'security-reviewer'|'architecture-reviewer',CrewTemplate>,
  custom: { name: 'New crew member', brain: 'auto', permissionMode: 'plan', trigger: { kind: 'manual' }, attachSharedProjects: false, charter: '' },
};
const isTemplate = (value: string): value is CrewTemplateKey => Object.keys(CREW_TEMPLATES).includes(value);   // own keys only: `'constructor' in CREW_TEMPLATES` is true
function templateKey(value: unknown): CrewTemplateKey | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !isTemplate(value)) fail(400, 'invalid_field', `template must be one of ${Object.keys(CREW_TEMPLATES).join(', ')}`);
  return value;
}

// ---- Member validation -----------------------------------------------------------------------------------------
export const DEFAULT_CREW_BUDGET: CrewBudget = { usdPerRun: 1, maxMinutes: 20, runsPerDay: 8, buildsPerDay: 4 };
// A watched branch: any the project has except Smith's own (smith/...), whose pushes would wake the crew with its own work.
export function watchableBranch(branch: string): boolean { return validBranch(branch) && !/^smith\//i.test(branch); }
const MEMBER_FIELDS = ['id', 'name', 'charter', 'template', 'projectIds', 'attachSharedProjects', 'tool', 'brain', 'model', 'nodeId', 'permissionMode', 'trigger', 'budget',
  'verifyProduct', 'mayCreateProjects', 'mayMessage', 'enabled', 'orchestration'];
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;                // the project-ID rule from validateProject
// The product-name rule from validateProject, plus '/' for a smith.json build action of a variant ("game/windows") on a
// project added from a Git URL; the caller checks it exists.
const PRODUCT_NAME = /^[a-z0-9][a-z0-9/-]{0,63}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const NODE_ID = /^[a-f0-9-]{36}$/;

// The branch and message name of a member: fixed at creation. Uniqueness is the caller's job (the column is UNIQUE).
export function crewSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '') || 'member';
}
// Charters are multi-line English: allow tabs and newlines, refuse the other control characters.
function charterText(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || !value.trim()) fail(400, 'invalid_field', 'charter must be 1–8000 characters of text');
  return value.trim();
}
function projectIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 10 || value.some(id => typeof id !== 'string' || !PROJECT_ID.test(id)) || new Set(value).size !== value.length)
    fail(400, 'invalid_field', 'projectIds must list 1–10 distinct project IDs');
  return [...value];
}
// A string that matches `pattern`, or null for null/empty ("any machine", "no Verify"). Absent keeps `current`.
function optional(body: Record<string, unknown>, key: string, current: string | null, pattern: RegExp): string | null {
  if (!(key in body)) return current;
  const value = body[key];
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !pattern.test(value)) fail(400, 'invalid_field', `Invalid field: ${key}`);
  return value;
}
// Fields that do not apply to the chosen kind are dropped, so a form that switched kinds cannot leave stale values behind.
function parseTrigger(value: unknown): CrewTrigger {
  const body = object(value); fields(body, ['kind', 'intervalMinutes', 'skipIfUnchanged', 'on', 'branch', 'checkMinutes']);
  const kind = choice(body, 'kind', ['manual', 'interval', 'buildFinished', 'branchChanged'] as const);
  if (kind === 'branchChanged') {
    const branch = body.branch === undefined || body.branch === null ? '' : typeof body.branch === 'string' ? body.branch.trim() : null;
    if (branch === null || !watchableBranch(branch)) fail(400, 'invalid_field', 'branch must be a branch name (not one of Smith’s own smith/… branches), or empty for the project’s branch');
    return { kind, branch, checkMinutes: 'checkMinutes' in body ? integer(body, 'checkMinutes', 2, 1440) : 5 };
  }
  if (kind === 'interval') return { kind, intervalMinutes: integer(body, 'intervalMinutes', 15, 10080), skipIfUnchanged: 'skipIfUnchanged' in body ? flag(body, 'skipIfUnchanged') : true };
  if (kind === 'buildFinished') return { kind, on: choice(body, 'on', ['failed', 'any'] as const) };
  return { kind };
}
function parseBudget(value: unknown, base: CrewBudget): CrewBudget {
  const body = object(value); fields(body, Object.keys(DEFAULT_CREW_BUDGET));
  const budget = { ...base };
  if ('usdPerRun' in body) {
    const usd = typeof body.usdPerRun === 'number' ? Math.round(body.usdPerRun * 100) / 100 : NaN;   // the CLI takes whole cents
    if (!(usd >= 0.01 && usd <= 100)) fail(400, 'invalid_field', 'usdPerRun must be 0.01–100');
    budget.usdPerRun = usd;
  }
  if ('maxMinutes' in body) budget.maxMinutes = integer(body, 'maxMinutes', 1, 180);
  if ('runsPerDay' in body) budget.runsPerDay = integer(body, 'runsPerDay', 1, 96);
  if ('buildsPerDay' in body) budget.buildsPerDay = integer(body, 'buildsPerDay', 0, 48);
  return budget;
}

// Validate a crew-put body. An absent field keeps `current` on an edit; on a create it takes the template's value, then the
// documented default. A template only seeds values, so a member is never tied to it. `slug`, `memory`, `lastSeen` and the
// schedule are not caller-settable: the slug is derived once at creation and the rest belong to the server.
export function validateCrewMember(body: Record<string, unknown>, current: CrewMember | undefined, userId: string, now: number): CrewMember {
  fields(body, MEMBER_FIELDS);
  if ('id' in body && body.id !== current?.id) fail(400, 'invalid_field', 'Invalid field: id');
  const has = (key: string) => key in body;
  const key = has('template') ? templateKey(body.template) : current?.template ?? null;
  const template = key !== null && isTemplate(key) ? CREW_TEMPLATES[key] : null;      // only seeds a create; an edit keeps `current`'s values

  const name = has('name') ? text(body, 'name', 64) : current?.name ?? template?.name ?? '';
  if (!name) fail(400, 'invalid_field', 'name is required (1–64 characters)');
  const charter = has('charter') ? charterText(body.charter) : current?.charter ?? charterText(template?.charter);
  const ids = has('projectIds') ? projectIds(body.projectIds) : current?.projectIds ?? projectIds(undefined);
  const brain = has('brain') ? choice(body, 'brain', ['auto', 'login', 'api-key', 'ollama'] as const) : current?.brain ?? template?.brain ?? 'auto';
  // The tool follows the brain: automatic picks both, the workspace key only works with Claude Code, and a sign-in names whose.
  const askedTool = has('tool') ? choice(body, 'tool', ['auto', 'claude-code', 'codex'] as const) : has('brain') ? 'auto' : current?.tool ?? 'auto';
  // A sign-in without a tool is Claude Code's (what 'login' meant before Codex could run crew members).
  const tool: CrewTool = brain === 'auto' ? 'auto' : brain === 'api-key' || (brain === 'login' && askedTool === 'auto') ? 'claude-code' : askedTool;
  if (brain === 'api-key' && askedTool === 'codex') fail(400, 'invalid_field', 'The workspace’s Anthropic API key only works with Claude Code');
  // A local model is named, or (empty) the machine's largest; an automatic member may name the local model it falls back to.
  let model = optional(body, 'model', current?.model ?? null, MODEL);
  if (brain !== 'ollama' && brain !== 'auto') { if (has('model') && model) fail(400, 'invalid_field', 'Only crew members using a model on a machine choose one'); model = null; }
  const permissionMode = has('permissionMode') ? choice(body, 'permissionMode', ['plan', 'acceptEdits'] as const) : current?.permissionMode ?? template?.permissionMode ?? 'acceptEdits';
  const trigger = has('trigger') ? parseTrigger(body.trigger) : current?.trigger ?? { ...(template?.trigger ?? { kind: 'manual' as const }) };
  const budget = has('budget') ? parseBudget(body.budget, current?.budget ?? DEFAULT_CREW_BUDGET) : current?.budget ?? { ...DEFAULT_CREW_BUDGET };
  const edited = !!current && (charter !== current.charter || JSON.stringify(ids) !== JSON.stringify(current.projectIds));

  const orchestrationInput = has('orchestration') ? body.orchestration : current?.orchestration ?? (!current ? template?.orchestration ?? null : null);
  return {
    orchestration: orchestrationInput == null ? null : validateMemberOrchestration(orchestrationInput, permissionMode),
    id: current?.id ?? crypto.randomUUID(), slug: current?.slug ?? crewSlug(name), name, template: key, charter, projectIds: ids,
    attachSharedProjects: has('attachSharedProjects') ? flag(body, 'attachSharedProjects') : current?.attachSharedProjects ?? template?.attachSharedProjects ?? false,
    tool, brain, model, nodeId: optional(body, 'nodeId', current?.nodeId ?? null, NODE_ID), permissionMode, trigger, budget,
    verifyProduct: optional(body, 'verifyProduct', current?.verifyProduct ?? null, PRODUCT_NAME),
    mayCreateProjects: has('mayCreateProjects') ? flag(body, 'mayCreateProjects') : current?.mayCreateProjects ?? false,
    mayMessage: has('mayMessage') ? flag(body, 'mayMessage') : current?.mayMessage ?? true,
    enabled: has('enabled') ? flag(body, 'enabled') : current?.enabled ?? true,
    memory: current?.memory ?? '', lastSeen: current?.lastSeen ?? {}, nextRunAt: current?.nextRunAt ?? null,
    // Stamped when what the member was told to do or where it works changes, so the dashboard can offer to clear its memory.
    charterUpdatedAt: edited ? now : current?.charterUpdatedAt ?? null,
    // Whoever saves the member (an operator or above) owns its runs from then on: a member whose creator left the workspace
    // or was demoted runs again once someone who may manage the crew saves it (crew.ts startRun refuses it until then).
    createdBy: userId, createdAt: current?.createdAt ?? now, updatedAt: now,
  };
}

// ---- Report ----------------------------------------------------------------------------------------------------
// Handed to the CLI inline (`--json-schema`) and checked again server-side. No `maxLength` keywords: the schema is
// passed on a cmd.exe command line, so it stays short and only [A-Za-z0-9_{}[]":,]; validateCrewReport enforces sizes.
export const CREW_REPORT_SCHEMA = { type: 'object', properties: {
  summary: { type: 'string' }, findings: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string', enum: ['low', 'medium', 'high'] }, title: { type: 'string' }, file: { type: 'string' }, line: { type: 'integer' }, detail: { type: 'string' }, confidence: { type: ['number', 'null'], minimum: 0, maximum: 1 }, category: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, blocking: { type: 'boolean' } }, required: ['severity', 'title', 'detail'] } },
  proposal: { type: 'object', properties: { title: { type: 'string' }, summary: { type: 'string' } }, required: ['title', 'summary'] }, memory: { type: 'string' }, skipped: { type: 'boolean' } }, required: ['summary', 'findings'] } as const;
export const CREW_REPORT_SCHEMA_INLINE = JSON.stringify(CREW_REPORT_SCHEMA);
// The same report for Codex, which hands it to OpenAI's structured output: every property required, the optional ones
// nullable, and no others (validateCrewReport reads null as absent). Codex reads it from a file, so its size is no concern.
const nullable = (type: string) => ({ type: [type, 'null'] });
export const CREW_REPORT_SCHEMA_STRICT = JSON.stringify({ type: 'object', additionalProperties: false, required: ['summary', 'findings', 'proposal', 'memory', 'skipped'], properties: {
  summary: { type: 'string' },
  findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['severity', 'title', 'file', 'line', 'detail'], properties: {
    severity: { type: 'string', enum: ['low', 'medium', 'high'] }, title: { type: 'string' }, file: nullable('string'), line: nullable('integer'), detail: { type: 'string' } } } },
  proposal: { anyOf: [{ type: 'object', additionalProperties: false, required: ['title', 'summary'], properties: { title: { type: 'string' }, summary: { type: 'string' } } }, { type: 'null' }] },
  memory: nullable('string'), skipped: nullable('boolean') } });

function reportText(body: Record<string, unknown>, key: string, max: number, label = key): string {
  const value = body[key];
  if (typeof value !== 'string' || value.length > max) fail(400, 'invalid_report', `${label} must be text of at most ${max} characters`);
  return value;
}
// Validate a run's report, whether it came from the CLI's structured output or the crew_report tool. Model output, so
// unknown keys are dropped rather than refused (the schema does not forbid them); types and sizes are strict.
export function validateCrewReport(value: unknown): CrewReport {
  const body = object(value);
  if (!Array.isArray(body.findings) || body.findings.length > 50) fail(400, 'invalid_report', 'findings must be a list of at most 50');
  const report: CrewReport = { summary: reportText(body, 'summary', 2000), findings: body.findings.map((raw, i): CrewReport['findings'][number] => {
    const f = object(raw);
    const severity = f.severity;
    if (severity !== 'low' && severity !== 'medium' && severity !== 'high') fail(400, 'invalid_report', `findings[${i}].severity must be low, medium or high`);
    const finding: CrewReport['findings'][number] = { severity, title: reportText(f, 'title', 200, `findings[${i}].title`), detail: reportText(f, 'detail', 2000, `findings[${i}].detail`) };
    if (f.file != null) finding.file = reportText(f, 'file', 512, `findings[${i}].file`);
    if (f.line != null) {
      if (!Number.isInteger(f.line) || (f.line as number) < 0 || (f.line as number) > 10_000_000) fail(400, 'invalid_report', `findings[${i}].line must be a whole number`);
      finding.line = f.line as number;
    }
    if ('confidence' in f) {
      if (f.confidence !== null && (typeof f.confidence !== 'number' || !Number.isFinite(f.confidence) || f.confidence < 0 || f.confidence > 1)) fail(400, 'invalid_report', 'confidence must be null or a number between 0 and 1');
      finding.confidence = f.confidence as number | null;
    }
    if ('category' in f) {
      if (typeof f.category !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(f.category)) fail(400, 'invalid_report', 'category must be a lowercase identifier');
      finding.category = f.category;
    }
    if ('files' in f) {
      if (!Array.isArray(f.files) || f.files.length > 100 || f.files.some(p => typeof p !== 'string' || !p || new TextEncoder().encode(p).length > 512 || /[\\:\x00-\x1f\x7f]/.test(p) || p.startsWith('/') || p.split('/').some((part: string) => !part || part === '.' || part === '..'))) fail(400, 'invalid_report', 'files must be repository-relative paths');
      finding.files = [...new Set(f.files as string[])];
    }
    if ('blocking' in f) {
      if (typeof f.blocking !== 'boolean') fail(400, 'invalid_report', 'blocking must be true or false');
      finding.blocking = f.blocking;
    }
    return finding;
  }) };
  if (body.proposal != null) { const p = object(body.proposal); report.proposal = { title: reportText(p, 'title', 200, 'proposal.title'), summary: reportText(p, 'summary', 2000, 'proposal.summary') }; }
  // Bytes, as crew_remember holds a member's memory (crew.ts MEMORY_BYTES).
  if (body.memory != null) {
    report.memory = reportText(body, 'memory', 32768);
    if (new TextEncoder().encode(report.memory).length > 32768) fail(400, 'invalid_report', 'memory must be at most 32768 bytes of text');
  }
  if (body.skipped != null) { if (typeof body.skipped !== 'boolean') fail(400, 'invalid_report', 'skipped must be true or false'); report.skipped = body.skipped; }
  // Bytes, not characters: this is what gets stored and shown. A report filed through the crew_report tool may use all of
  // it; one inside an agent's finish is held to 32 KiB first (crewResult in sessions.ts), so the finish fits its body cap.
  if (new TextEncoder().encode(JSON.stringify(report)).length > 65536) fail(400, 'invalid_report', 'A report may be at most 64 KiB');
  return report;
}
