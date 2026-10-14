import { DEFAULT_ORCHESTRATION_POLICY, validateOrchestrationPolicy, type OrchestrationPolicy } from './crew-orchestration-model';
// Settings shared by the dashboard, the auth profile route and the workspace Durable Object.
// Account preferences live in D1 (per user); workspace settings live in the workspace DO.
// Validation is pure so it is unit-testable without bindings.
import { fail, fields, object } from './http';
import { AI_ORDER_CHOICES, DEFAULT_AI_ORDER, type AiOrderChoice } from './ai';
import type { CrewBrain } from './crew-model';
import { STUDIO_ACCESS, type StudioAccess } from './members';

export const CLOCKS = ['auto', '12', '24'] as const;
export const LOG_TIMESTAMPS = ['off', 'time', 'datetime', 'iso', 'elapsed'] as const;
import { DEFAULT_LFS_QUOTA_BYTES, DEFAULT_LFS_RESERVE_BYTES } from './lfs';

export interface AccountPreferences {
  timeZone: string;                                  // IANA zone, or 'auto' for the browser's zone
  clock: typeof CLOCKS[number];                      // hour cycle for rendered dates
  logTimestamps: typeof LOG_TIMESTAMPS[number];      // how build output lines are stamped
  followOutput: boolean;                             // auto-scroll live build output
  refreshSeconds: number;                            // dashboard poll cadence (2–60)
}
export interface AccountProfile { displayName: string; email: string; preferences: AccountPreferences }
export const DEFAULT_PREFERENCES: AccountPreferences = { timeZone: 'auto', clock: 'auto', logTimestamps: 'time', followOutput: true, refreshSeconds: 2 };

export interface WorkspaceSettings {
  orchestration: OrchestrationPolicy;
  name: string;                                      // shown in the workspace picker and summaries
  nodeOfflineSeconds: number;                        // a machine is shown offline after this long without a heartbeat (15–3600)
  supersedeQueued: boolean;                          // a new build cancels a still-queued build of the same project + product
  cloudflareAccountId: string;                       // delivered to jobs as CLOUDFLARE_ACCOUNT_ID (not secret)
  crewMayCreateProjects: boolean;                    // workspace-wide gate: crew members may ask for new projects (each member also needs its own flag)
  crewMaxConcurrentRuns: number;                     // crew runs working at once across the workspace (1–10)
  crewDailyUsdLimit: number;                         // API spend the crew may reserve in any rolling 24 hours, in whole dollars (0–1000)
  crewStopped: boolean;                              // kill switch: no crew run starts and running ones are stopped
  studioAccess: StudioAccess;                        // every Google Workspace account of GOOGLE_ALLOWED_DOMAIN joins with this role ('off': nobody)
  lfsQuotaBytes: number;                             // large files (Git LFS) the workspace may keep in R2, in bytes (0–1 TiB)
  lfsMachineReserveBytes: number;                    // free disk a machine keeps while copying large files (1 GiB–1 TiB)
  aiOrder: AiOrderChoice[];                          // which AI an automatic crew member uses on a machine, first ready wins (Claude, GPT, local by default)
  copyBudgetBytes: number;                           // copies (repositories and large files) a machine may keep unless its card says otherwise (1 GiB–10 TiB)
  copiesPerItem: number;                             // machines that should hold each repository and each large file (1–5)
  lfsImportThresholdBytes: number;                   // Import from GitHub moves files over this to large files (1–32 MiB)
}
export const DEFAULT_COPY_BUDGET_BYTES = 50 * 1024 * 1024 * 1024;
export const DEFAULT_COPIES_PER_ITEM = 2;
export const DEFAULT_IMPORT_THRESHOLD_BYTES = 10 * 1024 * 1024;
export const MAX_IMPORT_THRESHOLD_BYTES = 32 * 1024 * 1024;   // Artifacts refuses larger blobs
export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = { orchestration: DEFAULT_ORCHESTRATION_POLICY, name: 'Smith experiment', nodeOfflineSeconds: 60, supersedeQueued: false, cloudflareAccountId: '',
  crewMayCreateProjects: false, crewMaxConcurrentRuns: 1, crewDailyUsdLimit: 10, crewStopped: false, studioAccess: 'off', aiOrder: [...DEFAULT_AI_ORDER], lfsQuotaBytes: DEFAULT_LFS_QUOTA_BYTES, lfsMachineReserveBytes: DEFAULT_LFS_RESERVE_BYTES,
  copyBudgetBytes: DEFAULT_COPY_BUDGET_BYTES, copiesPerItem: DEFAULT_COPIES_PER_ITEM, lfsImportThresholdBytes: DEFAULT_IMPORT_THRESHOLD_BYTES };
// Secret names the workspace holds. Values are write-only: the API reports only whether one is set.
export const WORKSPACE_SECRETS = ['cloudflareApiToken', 'githubToken', 'anthropicApiKey', 'checkInWebhookSecret'] as const;
export type WorkspaceSecret = typeof WORKSPACE_SECRETS[number];
const clearKey = (name: string) => 'clear' + name[0].toUpperCase() + name.slice(1);

export function validTimeZone(value: string): boolean {
  if (value === 'auto') return true;
  if (!/^[A-Za-z0-9_+\-/]{1,64}$/.test(value)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; }
}
export function text(body: Record<string, unknown>, key: string, max: number): string {
  const value = body[key];
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail(400, 'invalid_field', `Invalid field: ${key}`);
  return value.trim();
}
export function integer(body: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = body[key];
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) fail(400, 'invalid_field', `${key} must be ${min}–${max}`);
  return Number(value);
}
export function flag(body: Record<string, unknown>, key: string): boolean {
  if (typeof body[key] !== 'boolean') fail(400, 'invalid_field', `Invalid field: ${key}`);
  return body[key] as boolean;
}
export function choice<T extends string>(body: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const value = body[key];
  if (typeof value !== 'string' || !allowed.includes(value as T)) fail(400, 'invalid_field', `${key} must be one of ${allowed.join(', ')}`);
  return value as T;
}

// Merge a partial preferences object onto current ones; unknown keys are rejected.
export function validatePreferences(input: unknown, current: AccountPreferences): AccountPreferences {
  const body = object(input); fields(body, Object.keys(DEFAULT_PREFERENCES));
  const next = { ...current };
  if ('timeZone' in body) { next.timeZone = text(body, 'timeZone', 64); if (!validTimeZone(next.timeZone)) fail(400, 'invalid_field', 'Unknown time zone'); }
  if ('clock' in body) next.clock = choice(body, 'clock', CLOCKS);
  if ('logTimestamps' in body) next.logTimestamps = choice(body, 'logTimestamps', LOG_TIMESTAMPS);
  if ('followOutput' in body) next.followOutput = flag(body, 'followOutput');
  if ('refreshSeconds' in body) next.refreshSeconds = integer(body, 'refreshSeconds', 2, 60);
  return next;
}
// Parse stored preferences JSON, tolerating older or hand-edited rows.
export function parsePreferences(stored: string | null | undefined): AccountPreferences {
  return parseStored(stored, DEFAULT_PREFERENCES, (body, current) => validatePreferences(body, current));
}
// Apply stored JSON one known key at a time so a stale or bad value only loses that key.
function parseStored<T extends object>(stored: string | null | undefined, defaults: T, validate: (body: Record<string, unknown>, current: T) => T): T {
  let parsed: unknown; try { parsed = JSON.parse(stored || '{}'); } catch { return { ...defaults }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...defaults };
  let result = { ...defaults };
  for (const key of Object.keys(defaults)) {
    if (!(key in parsed)) continue;
    try { result = validate({ [key]: (parsed as Record<string, unknown>)[key] }, result); } catch { /* keep the default for this key */ }
  }
  return result;
}
export function validateProfile(body: Record<string, unknown>, current: AccountProfile): AccountProfile {
  fields(body, ['displayName', 'email', 'preferences']);
  const next = { ...current, preferences: { ...current.preferences } };
  if ('displayName' in body) next.displayName = text(body, 'displayName', 64);
  if ('email' in body) {
    next.email = text(body, 'email', 254);
    if (next.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email)) fail(400, 'invalid_field', 'Enter a valid e-mail address');
  }
  if ('preferences' in body) next.preferences = validatePreferences(body.preferences, current.preferences);
  return next;
}

// The AI order: each kind at most once, at least one. A kind left out is never used by an automatic crew member.
function aiOrder(value: unknown): AiOrderChoice[] {
  if (!Array.isArray(value) || !value.length || value.length > AI_ORDER_CHOICES.length || value.some(v => !AI_ORDER_CHOICES.includes(v as AiOrderChoice)) || new Set(value).size !== value.length)
    fail(400, 'invalid_field', `aiOrder must list one or more of ${AI_ORDER_CHOICES.join(', ')}, each once`);
  return [...value] as AiOrderChoice[];
}
export interface WorkspaceSettingsUpdate { settings: WorkspaceSettings; secrets: Partial<Record<WorkspaceSecret, string | null>> }
// A write-only secret: a blank value keeps the stored one, clear<Name>: true removes it.
function secretField(body: Record<string, unknown>, secrets: WorkspaceSettingsUpdate['secrets'], name: WorkspaceSecret, pattern: RegExp, invalid: string): void {
  const clear = clearKey(name);
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
// Validate a settings POST. A blank or absent secret keeps the stored value; `clear<Name>: true` removes it.
export function validateWorkspaceSettings(body: Record<string, unknown>, current: WorkspaceSettings): WorkspaceSettingsUpdate {
  fields(body, [...Object.keys(DEFAULT_WORKSPACE_SETTINGS), ...WORKSPACE_SECRETS, ...WORKSPACE_SECRETS.map(clearKey)]);
  const settings = { ...current };
  if ('name' in body) { settings.name = text(body, 'name', 64); if (!settings.name) fail(400, 'invalid_field', 'Workspace name is required'); }
  if ('nodeOfflineSeconds' in body) settings.nodeOfflineSeconds = integer(body, 'nodeOfflineSeconds', 15, 3600);
  if ('supersedeQueued' in body) settings.supersedeQueued = flag(body, 'supersedeQueued');
  if ('studioAccess' in body) settings.studioAccess = choice(body, 'studioAccess', STUDIO_ACCESS);
  if ('cloudflareAccountId' in body) {
    settings.cloudflareAccountId = text(body, 'cloudflareAccountId', 64);
    if (settings.cloudflareAccountId && !/^[a-f0-9]{32}$/.test(settings.cloudflareAccountId)) fail(400, 'invalid_field', 'Cloudflare account IDs are 32 hex characters');
  }
  if ('crewMayCreateProjects' in body) settings.crewMayCreateProjects = flag(body, 'crewMayCreateProjects');
  if ('crewMaxConcurrentRuns' in body) settings.crewMaxConcurrentRuns = integer(body, 'crewMaxConcurrentRuns', 1, 10);
  if ('crewDailyUsdLimit' in body) settings.crewDailyUsdLimit = integer(body, 'crewDailyUsdLimit', 0, 1000);
  if ('orchestration' in body) settings.orchestration = validateOrchestrationPolicy(body.orchestration, current.orchestration);
  if ('crewStopped' in body) settings.crewStopped = flag(body, 'crewStopped');
  if ('lfsQuotaBytes' in body) settings.lfsQuotaBytes = integer(body, 'lfsQuotaBytes', 0, 1099511627776);
  if ('lfsMachineReserveBytes' in body) settings.lfsMachineReserveBytes = integer(body, 'lfsMachineReserveBytes', 1073741824, 1099511627776);
  if ('copyBudgetBytes' in body) settings.copyBudgetBytes = integer(body, 'copyBudgetBytes', 1073741824, 10995116277760);
  if ('copiesPerItem' in body) settings.copiesPerItem = integer(body, 'copiesPerItem', 1, 5);
  if ('lfsImportThresholdBytes' in body) settings.lfsImportThresholdBytes = integer(body, 'lfsImportThresholdBytes', 1048576, MAX_IMPORT_THRESHOLD_BYTES);
  if ('aiOrder' in body) settings.aiOrder = aiOrder(body.aiOrder);
  const secrets: WorkspaceSettingsUpdate['secrets'] = {};
  secretField(body, secrets, 'cloudflareApiToken', /^[A-Za-z0-9_\-.]{20,256}$/, 'That does not look like a Cloudflare API token');
  // Read-only GitHub access for reading smith.json when a project is added; never given to jobs.
  secretField(body, secrets, 'githubToken', /^(?:github_pat_[A-Za-z0-9_]{20,250}|gh[pousr]_[A-Za-z0-9]{20,250})$/, 'That does not look like a GitHub token (github_pat_… or ghp_…)');
  // The crew's Anthropic API key; only crew turns on the api-key brain receive it (crewTurnEnv).
  secretField(body, secrets, 'anthropicApiKey', /^sk-ant-[A-Za-z0-9_\-]{20,256}$/, 'That does not look like an Anthropic API key');
  secretField(body, secrets, 'checkInWebhookSecret', /^[A-Za-z0-9_\-.]{32,256}$/, 'Webhook secret must be 32–256 letters, digits, underscores, dots or hyphens');
  return { settings, secrets };
}
export function parseWorkspaceSettings(stored: string | null | undefined): WorkspaceSettings {
  return parseStored(stored, DEFAULT_WORKSPACE_SETTINGS, (body, current) => validateWorkspaceSettings(body, current).settings);
}
// Environment a workspace contributes to every job it hands out. Project env wins on a clash.
// The GitHub token is deliberately absent: it is used only by the coordinator to read smith.json.
export function workspaceJobEnv(settings: WorkspaceSettings, secrets: Partial<Record<WorkspaceSecret, string>>): Record<string, string> {
  const env: Record<string, string> = {};
  if (secrets.cloudflareApiToken) env.CLOUDFLARE_API_TOKEN = secrets.cloudflareApiToken;
  if (settings.cloudflareAccountId) env.CLOUDFLARE_ACCOUNT_ID = settings.cloudflareAccountId;
  return env;
}
// Environment a crew turn contributes to the CLI it launches on a machine. Kept apart from
// workspaceJobEnv so builds never receive the Anthropic key; the login and Ollama brains need none.
export function crewTurnEnv(brain: CrewBrain | string, secrets: Partial<Record<WorkspaceSecret, string>>): Record<string, string> {
  return brain === 'api-key' && secrets.anthropicApiKey ? { ANTHROPIC_API_KEY: secrets.anthropicApiKey } : {};
}
