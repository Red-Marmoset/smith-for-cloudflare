import { fail, fields, json, object, randomToken, string } from './http';
import { AI_TOOLS, ONLINE_MS, aiFeatures, type AiInventory, type AiNode, type AiSetupSummary, type AiTool } from './ai';

// Installing a coding CLI on a machine, or signing in to it, started by the machine's owner from the
// chat composer. The machine's agent picks the task up with its next chat claim, runs it on its own
// thread and streams the output back here; the page shows it live, with links that open only when
// clicked, and relays a code pasted from the sign-in page to the CLI. At most one unfinished task per
// machine. Nobody but the machine's owner can see or start these.
export const SETUP_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ai_setup_tasks (id TEXT PRIMARY KEY, node_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, tool TEXT NOT NULL, action TEXT NOT NULL,
    state TEXT NOT NULL, lease_token TEXT, lease_expires_at INTEGER, stop_requested INTEGER NOT NULL DEFAULT 0, input TEXT NOT NULL DEFAULT '[]',
    output TEXT NOT NULL DEFAULT '', message TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER);
  CREATE INDEX IF NOT EXISTS ai_setup_node ON ai_setup_tasks(node_id, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS ai_setup_one_active ON ai_setup_tasks(node_id) WHERE state IN ('queued', 'running');
`;

const LEASE_MS = 90000;
const ACTIONS = ['install', 'sign-in'] as const;
const FINISHED = ['succeeded', 'failed', 'stopped'] as const;
const MAX_OUTPUT = 64 * 1024;
const MAX_INPUT = 10;
const RECENT_MS = 10 * 60000; // a finished task stays on the machine's options this long
const KEEP_PER_NODE = 10;
const TOOL_NAMES: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };
type SetupState = 'queued' | 'running' | typeof FINISHED[number];
type SetupRow = { id: string; node_id: string; owner_user_id: string; tool: AiTool; action: typeof ACTIONS[number]; state: SetupState; lease_token: string | null;
  lease_expires_at: number | null; stop_requested: number; input: string; output: string; message: string; created_at: number; updated_at: number; finished_at: number | null };
export interface SetupClaim { setupId: string; leaseToken: string; tool: AiTool; action: typeof ACTIONS[number] }

// Keeps the end of the output (where the link, the code and the outcome are), cut at a line start.
function trimOutput(output: string): string {
  if (output.length <= MAX_OUTPUT) return output;
  const tail = output.slice(-MAX_OUTPUT), cut = tail.indexOf('\n');
  return cut >= 0 ? tail.slice(cut + 1) : tail;
}

export class Setups {
  constructor(private sql: SqlStorage) {}

  // A task whose machine stopped reporting is over; the owner can start another.
  expire(now: number): void {
    this.sql.exec("UPDATE ai_setup_tasks SET state = 'failed', message = 'The agent stopped responding.', finished_at = ?, updated_at = ? WHERE state = 'running' AND lease_expires_at <= ?", now, now, now);
  }
  nextLeaseExpiry(): number | null {
    return this.sql.exec<{ due: number | null }>("SELECT MIN(lease_expires_at) AS due FROM ai_setup_tasks WHERE state = 'running'").one().due;
  }

  // For the composer: each of the owner's machines' unfinished task, else its most recent one if it
  // finished in the last ten minutes (so the page can say how it went, and resume after a reload).
  latest(userId: string, now: number): Map<string, AiSetupSummary> {
    const rows = this.sql.exec<SetupRow>(`SELECT * FROM ai_setup_tasks WHERE owner_user_id = ? AND (state IN ('queued', 'running') OR finished_at >= ?)
      ORDER BY state IN ('queued', 'running') DESC, created_at DESC`, userId, now - RECENT_MS).toArray();
    const latest = new Map<string, AiSetupSummary>();
    for (const row of rows) if (!latest.has(row.node_id)) latest.set(row.node_id, { id: row.id, tool: row.tool, action: row.action, state: row.state });
    return latest;
  }

  execute(userId: string, action: string, body: Record<string, unknown>, now: number): Response {
    this.expire(now);
    if (action === 'ai-setup-create') {
      fields(body, ['nodeId', 'tool', 'action']);
      const node = this.sql.exec<AiNode>('SELECT * FROM nodes WHERE id = ? AND active = 1 AND owner_user_id = ?', string(body, 'nodeId', 64), userId).toArray()[0];
      if (!node) fail(404, 'not_found', 'You have no active machine with that ID');
      const tool = body.tool as AiTool, task = body.action as typeof ACTIONS[number];
      if (!AI_TOOLS.includes(tool)) fail(400, 'invalid_field', 'Unknown tool');
      if (!ACTIONS.includes(task)) fail(400, 'invalid_field', 'action must be install or sign-in');
      const host = node.hostname || 'that computer';
      if (now - node.last_seen_at >= ONLINE_MS) fail(409, 'machine_offline', `${host} is offline. Start Smith there, then try again.`);
      if (!aiFeatures(node).includes('setup')) fail(409, 'agent_update_needed', `Installing and signing in from here needs a newer Smith agent on ${host}. Update it there (SmithAgent.bat update), then try again.`);
      if (task === 'sign-in' && !(JSON.parse(node.ai) as AiInventory).tools.some(t => t.id === tool)) fail(409, 'not_installed', `${TOOL_NAMES[tool]} isn't installed on ${host} yet. Install it first.`);
      if (this.sql.exec("SELECT 1 FROM ai_setup_tasks WHERE node_id = ? AND state IN ('queued', 'running')", node.id).toArray().length) fail(409, 'setup_active', `${host} is already installing or signing in. Wait for it to finish, or stop it.`);
      const id = crypto.randomUUID();
      this.sql.exec("INSERT INTO ai_setup_tasks (id, node_id, owner_user_id, tool, action, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)", id, node.id, userId, tool, task, now, now);
      // Only the last few finished tasks per machine are kept.
      this.sql.exec(`DELETE FROM ai_setup_tasks WHERE node_id = ? AND state NOT IN ('queued', 'running') AND id NOT IN
        (SELECT id FROM ai_setup_tasks WHERE node_id = ? ORDER BY created_at DESC LIMIT ?)`, node.id, node.id, KEEP_PER_NODE);
      return json({ task: this.publicTask(this.task(id)) }, 201);
    }
    fields(body, action === 'ai-setup-input' ? ['setupId', 'text'] : ['setupId']);
    const task = this.sql.exec<SetupRow>('SELECT t.* FROM ai_setup_tasks t JOIN nodes n ON n.id = t.node_id WHERE t.id = ? AND t.owner_user_id = ? AND n.owner_user_id = ?',
      string(body, 'setupId', 64), userId, userId).toArray()[0];
    if (!task) fail(404, 'not_found', 'Setup task not found');
    if (action === 'ai-setup-get') return json({ task: this.publicTask(task) });
    if (action === 'ai-setup-input') {
      // One line for the CLI's standard input, such as the code the sign-in page shows.
      const text = body.text;
      if (typeof text !== 'string' || text.length > 2048 || /[\x00-\x1f\x7f]/.test(text)) fail(400, 'invalid_field', 'Paste a single line of up to 2,048 characters');
      if (task.state !== 'queued' && task.state !== 'running') fail(409, 'setup_finished', 'This task has already finished');
      const input = JSON.parse(task.input) as string[];
      if (input.length >= MAX_INPUT) fail(429, 'input_queue_full', 'Wait for the computer to pick up what you already sent');
      this.sql.exec('UPDATE ai_setup_tasks SET input = ?, updated_at = ? WHERE id = ?', JSON.stringify([...input, text]), now, task.id);
      return json({ task: this.publicTask(this.task(task.id)) });
    }
    if (action === 'ai-setup-stop') {
      if (task.state === 'queued') this.sql.exec("UPDATE ai_setup_tasks SET state = 'stopped', message = 'Stopped before it started.', finished_at = ?, updated_at = ? WHERE id = ?", now, now, task.id);
      else if (task.state === 'running') this.sql.exec('UPDATE ai_setup_tasks SET stop_requested = 1, updated_at = ? WHERE id = ?', now, task.id);
      return json({ task: this.publicTask(this.task(task.id)) });
    }
    fail(404, 'not_found', 'Route not found');
  }

  // Rides on the machine's chat claim: its oldest queued task, unless one is already running there.
  // A lost reply is not replayed: the task's lease lapses and it fails, and the owner starts it again.
  claim(nodeId: string, now: number): SetupClaim | null {
    this.expire(now);
    if (this.sql.exec("SELECT 1 FROM ai_setup_tasks WHERE node_id = ? AND state = 'running'", nodeId).toArray().length) return null;
    const task = this.sql.exec<SetupRow>("SELECT * FROM ai_setup_tasks WHERE node_id = ? AND state = 'queued' ORDER BY created_at, id LIMIT 1", nodeId).toArray()[0];
    if (!task) return null;
    const leaseToken = randomToken();
    this.sql.exec("UPDATE ai_setup_tasks SET state = 'running', lease_token = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?", leaseToken, now + LEASE_MS, now, task.id);
    return { setupId: task.id, leaseToken, tool: task.tool, action: task.action };
  }

  // The machine's report on a running task: output lines, and finally the outcome. The reply carries
  // whether the owner asked to stop, and anything they pasted since the last report.
  events(nodeId: string, body: Record<string, unknown>, now: number): Response {
    this.expire(now);
    fields(body, ['setupId', 'leaseToken', 'lines', 'finish']);
    const task = this.sql.exec<SetupRow>('SELECT * FROM ai_setup_tasks WHERE id = ? AND node_id = ?', string(body, 'setupId', 64), nodeId).toArray()[0];
    if (!task) fail(404, 'not_found', 'Setup task not found');
    if (task.lease_token !== string(body, 'leaseToken', 200) || task.state !== 'running') fail(409, 'stale_setup', 'Setup task is not current');
    const lines = body.lines ?? [];
    if (!Array.isArray(lines) || lines.length > 64 || lines.some(line => typeof line !== 'string' || line.length > 4000)) fail(400, 'invalid_events', 'Send at most 64 lines of up to 4,000 characters');
    let finish: { status: typeof FINISHED[number]; message: string } | null = null;
    if (body.finish !== undefined && body.finish !== null) {
      const input = object(body.finish); fields(input, ['status', 'message']);
      if (!FINISHED.includes(input.status as typeof FINISHED[number]) || (input.message !== undefined && (typeof input.message !== 'string' || input.message.length > 500))) fail(400, 'invalid_result', 'Invalid setup result');
      finish = { status: input.status as typeof FINISHED[number], message: (input.message as string | undefined) ?? '' };
    }
    const output = lines.length ? trimOutput(task.output + (lines as string[]).map(line => line + '\n').join('')) : task.output;
    const input = JSON.parse(task.input) as string[];
    if (finish) this.sql.exec("UPDATE ai_setup_tasks SET output = ?, input = '[]', state = ?, message = ?, finished_at = ?, updated_at = ? WHERE id = ?", output, finish.status, finish.message, now, now, task.id);
    else this.sql.exec("UPDATE ai_setup_tasks SET output = ?, input = '[]', lease_expires_at = ?, updated_at = ? WHERE id = ?", output, now + LEASE_MS, now, task.id);
    return json({ stop: Boolean(task.stop_requested), input: finish ? [] : input });
  }

  private task(id: string): SetupRow { return this.sql.exec<SetupRow>('SELECT * FROM ai_setup_tasks WHERE id = ?', id).one(); }
  private publicTask(t: SetupRow) {
    return { id: t.id, nodeId: t.node_id, tool: t.tool, action: t.action, state: t.state, output: t.output, message: t.message, stopRequested: Boolean(t.stop_requested),
      createdAt: t.created_at, finishedAt: t.finished_at };
  }
}
