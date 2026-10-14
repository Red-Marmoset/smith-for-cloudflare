import { fail, fields, object } from './http';

// Coding CLIs an agent may report. Each runs unmodified on the reporting machine with whatever
// login its owner completed there; Smith never receives or stores those credentials.
export const AI_TOOLS = ['claude-code', 'codex'] as const;
export type AiTool = typeof AI_TOOLS[number];
export interface OllamaModel { name: string; sizeBytes: number; remote: boolean }
// What a machine's Smith agent can do for chats beyond plain replies. Older agents report none, and
// the dashboard asks their owner to update Smith before offering these. 'crew' marks agents that
// understand autonomous crew turns; the coordinator never offers one to an agent without it.
// 'setup': installs and signs in its CLIs from the dashboard; 'api-key-choice': honours a chat's useApiKey.
// 'crew-codex': also runs crew members with Codex (its sign-in, or a local model through it).
// 'login-models': a chat with your own Claude Code login may name the model it runs (`claude --model`).
export const AI_FEATURES = ['ask', 'push', 'ollama', 'codex-ask', 'crew', 'setup', 'api-key-choice', 'crew-orchestration-v1', 'named-branches', 'crew-codex', 'login-models'] as const;
export type AiFeature = typeof AI_FEATURES[number];
// On Windows: whether Codex's own sandbox is set up there (without it Codex refuses commands and edits).
export const CODEX_SANDBOX_STATES = ['ready', 'setup-pending', 'not-set-up'] as const;
// signedIn: the CLI's own login (checked with API-key variables removed; absent when unknown). apiKey:
// an API key for it is set in the agent's environment (only its presence is ever reported).
export interface AiToolStatus { id: AiTool; version: string; signedIn?: boolean; apiKey?: boolean }
export interface AiInventory { tools: AiToolStatus[]; installable?: AiTool[]; ollama: { up: boolean; models: OllamaModel[] }; features?: AiFeature[]; codexSandbox?: typeof CODEX_SANDBOX_STATES[number] }
// The workspace's AI order (Settings, aiOrder): which kind of AI an automatic crew member tries first on a machine.
export const AI_ORDER_CHOICES = ['claude', 'gpt', 'local'] as const;
export type AiOrderChoice = typeof AI_ORDER_CHOICES[number];
export const DEFAULT_AI_ORDER: AiOrderChoice[] = ['claude', 'gpt', 'local'];
export const EMPTY_AI: AiInventory = { tools: [], ollama: { up: false, models: [] } };
export const ONLINE_MS = 60000;

export function validateAiInventory(value: unknown): AiInventory {
  const input = object(value); fields(input, ['tools', 'ollama', 'features', 'codexSandbox', 'installable']);
  if (input.codexSandbox !== undefined && !CODEX_SANDBOX_STATES.includes(input.codexSandbox as typeof CODEX_SANDBOX_STATES[number])) fail(400, 'invalid_ai', 'Invalid Codex sandbox state');
  if (!Array.isArray(input.tools) || input.tools.length > AI_TOOLS.length) fail(400, 'invalid_ai', 'Invalid AI tool inventory');
  const tools = input.tools.map(raw => {
    const tool = object(raw); fields(tool, ['id', 'version', 'signedIn', 'apiKey']);
    if (!AI_TOOLS.includes(tool.id as AiTool) || typeof tool.version !== 'string' || tool.version.length > 64 || /[\x00-\x1f]/.test(tool.version)) fail(400, 'invalid_ai', 'Invalid AI tool');
    if ((tool.signedIn !== undefined && typeof tool.signedIn !== 'boolean') || (tool.apiKey !== undefined && typeof tool.apiKey !== 'boolean')) fail(400, 'invalid_ai', 'Invalid AI tool status');
    return { id: tool.id as AiTool, version: tool.version, ...(tool.signedIn !== undefined ? { signedIn: tool.signedIn as boolean } : {}), ...(tool.apiKey !== undefined ? { apiKey: tool.apiKey as boolean } : {}) };
  });
  // Missing tools the agent could install by itself.
  if (input.installable !== undefined && (!Array.isArray(input.installable) || input.installable.length > AI_TOOLS.length * 2 || input.installable.some(t => !AI_TOOLS.includes(t as AiTool)))) fail(400, 'invalid_ai', 'Invalid installable tools');
  if (new Set(tools.map(t => t.id)).size !== tools.length) fail(400, 'invalid_ai', 'Duplicate AI tool');
  const ollama = object(input.ollama ?? { up: false, models: [] }); fields(ollama, ['up', 'models']);
  if (typeof ollama.up !== 'boolean' || !Array.isArray(ollama.models) || ollama.models.length > 50) fail(400, 'invalid_ai', 'Invalid Ollama inventory');
  const models = ollama.models.map(raw => {
    const model = object(raw); fields(model, ['name', 'sizeBytes', 'remote']);
    if (typeof model.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model.name) || !Number.isSafeInteger(model.sizeBytes) || Number(model.sizeBytes) < 0 || typeof model.remote !== 'boolean') fail(400, 'invalid_ai', 'Invalid Ollama model');
    return { name: model.name, sizeBytes: Number(model.sizeBytes), remote: model.remote };
  });
  // Unknown features (from a newer agent) are ignored rather than refused, so agents can be updated first.
  if (input.features !== undefined && (!Array.isArray(input.features) || input.features.length > 32 || input.features.some(f => typeof f !== 'string' || f.length > 32))) fail(400, 'invalid_ai', 'Invalid AI features');
  const features = ((input.features ?? []) as string[]).filter((f): f is AiFeature => AI_FEATURES.includes(f as AiFeature));
  return { tools, ollama: { up: ollama.up, models: ollama.up ? models : [] }, features: [...new Set(features)],
    ...(input.installable !== undefined ? { installable: [...new Set(input.installable as AiTool[])] } : {}),
    ...(input.codexSandbox !== undefined ? { codexSandbox: input.codexSandbox as typeof CODEX_SANDBOX_STATES[number] } : {}) };
}
export function aiFeatures(node: { ai: string }): AiFeature[] { return (JSON.parse(node.ai) as AiInventory).features ?? []; }

export type AiNode = { id: string; hostname: string; owner_user_id: string | null; active: number; last_seen_at: number; ai: string; share_local_models: number; os?: string };
export interface AiOption { tool: AiTool; brain: 'own-login' | 'ollama'; model: string | null; label?: string }
// The models a chat may pick with your own login, as the composer names them. A tool without a list
// (Codex) runs its own default; model null is always offered too, so earlier chats can continue.
export const LOGIN_MODELS: Record<AiTool, { id: string; label: string }[]> = {
  'claude-code': [
    { id: 'claude-fable-5-1', label: 'Fable 5.1' },
    { id: 'claude-opus-5-5', label: 'Opus 5.5' },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
    { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  ],
  codex: [],
};
// A machine's install / sign-in task as the chat composer shows it (see setup.ts).
export interface AiSetupSummary { id: string; tool: string; action: string; state: string }
// Owners also see each CLI's status, what the agent could install, and its current setup task, so the
// composer can show what blocks a chat there and the one button that fixes it.
export interface AiMachine { nodeId: string; hostname: string; ownedByYou: boolean; online: boolean; options: AiOption[]; features: AiFeature[]; os?: string; codexSandbox?: string;
  tools?: AiToolStatus[]; installable?: AiTool[]; setup?: AiSetupSummary }

// Who may run what where. Your own machines offer each installed CLI with your own login on that
// machine, plus every Ollama model (cloud models bill the owner's Ollama account, so they stay
// owner-only). Another member's machine is offered only when its owner shares local models, and
// then only local models: a session there must never fall back to the owner's subscription.
export function aiMachines(userId: string, nodes: AiNode[], now: number, setups: Map<string, AiSetupSummary> = new Map()): AiMachine[] {
  const machines: AiMachine[] = [];
  for (const node of nodes) {
    if (!node.active || !node.owner_user_id) continue;
    const ownedByYou = node.owner_user_id === userId;
    if (!ownedByYou && !node.share_local_models) continue;
    const ai = JSON.parse(node.ai) as AiInventory;
    const online = now - node.last_seen_at < ONLINE_MS;
    const models = ai.ollama.models.filter(m => ownedByYou || !m.remote);
    const options: AiOption[] = [];
    if (online) for (const { id: tool } of ai.tools) {
      if (ownedByYou) {
        if ((ai.features ?? []).includes('login-models')) for (const { id, label } of LOGIN_MODELS[tool] ?? []) options.push({ tool, brain: 'own-login', model: id, label });
        options.push({ tool, brain: 'own-login', model: null });
      }
      for (const model of models) options.push({ tool, brain: 'ollama', model: model.name });
    }
    if (ownedByYou || options.length) machines.push({ nodeId: node.id, hostname: node.hostname, ownedByYou, online, options, features: ai.features ?? [], ...(node.os ? { os: node.os } : {}),
      ...(ownedByYou && ai.codexSandbox ? { codexSandbox: ai.codexSandbox } : {}),
      ...(ownedByYou ? { tools: ai.tools, installable: ai.installable ?? [], ...(setups.has(node.id) ? { setup: setups.get(node.id) } : {}) } : {}) });
  }
  return machines.sort((a, b) => Number(b.ownedByYou) - Number(a.ownedByYou) || a.hostname.localeCompare(b.hostname));
}

// What other members may see about a machine's AI setup: nothing unless it is shared, and then
// only its local models. Owners see their full inventory.
export function visibleInventory(userId: string, node: AiNode): AiInventory | null {
  const ai = JSON.parse(node.ai) as AiInventory;
  if (node.owner_user_id === userId) return ai;
  if (!node.share_local_models) return null;
  // Whether the owner is signed in there, or has an API key set, is the owner's business.
  return { tools: ai.tools.map(({ id, version }) => ({ id, version })), ollama: { up: ai.ollama.up, models: ai.ollama.models.filter(m => !m.remote) } };
}
