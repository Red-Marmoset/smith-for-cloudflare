// A connected machine serves every workspace its owner is in, not only the one it was enrolled in.
//
// The agent knows one workspace (its home: the one in its connect code) and calls only that one's
// routes. The Worker does the rest, so agents need no update:
//  - a heartbeat that the home accepts also adds the machine to each of the owner's other workspaces
//    (the same node ID and credential; WorkspaceCoordinator.linkNode) and refreshes it there, so it
//    shows online in all of them;
//  - a claim (build, or chat/setup) that finds nothing at home is offered to those workspaces in turn;
//  - work handed out by another workspace carries that workspace in its lease token ("lw.<id>.<token>"),
//    and every follow-up call (logs, renew, resolve, complete, artifacts, chat events, ...) echoes the
//    token, so it is routed back there. The home ID stands in for it in a build envelope, which the
//    agent checks against its own.
// Each workspace still authenticates the credential itself, so a forged prefix reaches nothing the
// machine was not added to. Removing the machine in one workspace keeps it out of that one only.
import { hash, json } from './http';
import type { Principal } from './contracts';
import type { LinkedNode } from './workspace';

const PREFIX = 'lw.';
const CACHE_MS = 60000;
const sources = new Map<string, { at: number; node: LinkedNode | null }>();
const directories = new Map<string, { at: number; ids: string[] }>();

export function routedLeaseToken(token: string | null): { workspaceId: string; token: string } | null {
  const match = token ? /^lw\.([a-f0-9]{64})\.(.+)$/.exec(token) : null;
  return match ? { workspaceId: match[1], token: match[2] } : null;
}
function routed(workspaceId: string, token: unknown): unknown {
  return typeof token === 'string' ? `${PREFIX}${workspaceId}.${token}` : token;
}

// The machine behind a credential and the owner's other workspaces. Any failure (a D1 outage, say)
// leaves the machine serving its home workspace alone, never interrupting it.
async function linkedWorkspaces(env: Env, homeId: string, token: string): Promise<{ node: LinkedNode; ids: string[] } | null> {
  try {
    const credentialHash = await hash(token), now = Date.now();
    let source = sources.get(credentialHash);
    if (!source || now - source.at > CACHE_MS) {
      source = { at: now, node: await env.WORKSPACES.getByName(homeId).linkSource(credentialHash) };
      sources.set(credentialHash, source);
    }
    if (!source.node) return null;
    let directory = directories.get(source.node.ownerUserId);
    if (!directory || now - directory.at > CACHE_MS) {
      const rows = await env.DB.prepare('SELECT workspace_id FROM workspace_directory WHERE user_id = ? ORDER BY workspace_id LIMIT 20').bind(source.node.ownerUserId).all<{ workspace_id: string }>();
      directory = { at: now, ids: rows.results.map(row => row.workspace_id) };
      directories.set(source.node.ownerUserId, directory);
    }
    return { node: source.node, ids: directory.ids.filter(id => id !== homeId && /^[a-f0-9]{64}$/.test(id)) };
  } catch (error) {
    console.error(JSON.stringify({ event: 'linked_workspaces_failed', message: String(error) }));
    return null;
  }
}

async function bodyOf(response: Response): Promise<Record<string, unknown> | null> {
  try { return await response.clone().json() as Record<string, unknown>; } catch { return null; }
}

// Node calls arriving at the home workspace's routes. `action` is the Durable Object action.
export async function nodeAction(env: Env, homeId: string, token: string, action: string, body: Record<string, unknown>): Promise<Response> {
  const principal: Principal = { kind: 'node', token };
  const home = env.WORKSPACES.getByName(homeId);
  if (action === 'heartbeat') {
    const response = await home.execute(principal, action, body);
    if (!response.ok) return response;
    const linked = await linkedWorkspaces(env, homeId, token);
    // The machine keeps copies of repositories if any workspace switched it on: that flag is the OR of every answer.
    let gitHost = Boolean((await bodyOf(response))?.gitHost);
    if (linked) await Promise.allSettled(linked.ids.map(async id => {
      const stub = env.WORKSPACES.getByName(id);
      if (await stub.linkNode(linked.node)) { const other = await stub.execute(principal, action, body); if (other.ok && (await bodyOf(other))?.gitHost) gitHost = true; }
    }));
    return gitHost !== Boolean((await bodyOf(response))?.gitHost) ? json({ ...await bodyOf(response), gitHost }) : response;
  }
  if (action === 'claim' || action === 'ai-claim' || action === 'git-poll') {
    // A git poll also hands out large-file tasks (`lfs`), leased like the relay and the git task.
    const found = (reply: Record<string, unknown> | null) => action === 'claim' ? Boolean(reply?.hasJob) : action === 'git-poll' ? Boolean(reply?.relay || reply?.task || (Array.isArray(reply?.lfs) && reply.lfs.length)) : Boolean(reply?.turn || reply?.setup);
    const response = await home.execute(principal, action, body);
    if (!response.ok || found(await bodyOf(response))) return response;
    const linked = await linkedWorkspaces(env, homeId, token);
    // One at a time: whatever a workspace hands out is leased, so stop at the first that has work.
    for (const id of linked?.ids ?? []) {
      let reply: Record<string, unknown> | null;
      try {
        const other = await env.WORKSPACES.getByName(id).execute(principal, action, body);
        if (!other.ok) continue;
        reply = await bodyOf(other);
      } catch { continue; }
      if (!reply || !found(reply)) continue;
      if (action === 'claim') {
        const envelope = reply.envelope as { workspaceId: string; lease: { leaseToken: string } };
        envelope.workspaceId = homeId; envelope.lease.leaseToken = routed(id, envelope.lease.leaseToken) as string;
      } else if (action === 'git-poll') {
        for (const key of ['relay', 'task']) {
          const item = reply[key] as Record<string, unknown> | null;
          if (item) item.leaseToken = routed(id, item.leaseToken);
        }
        for (const item of (Array.isArray(reply.lfs) ? reply.lfs : []) as Record<string, unknown>[]) item.leaseToken = routed(id, item.leaseToken);
      } else {
        for (const key of ['turn', 'setup']) {
          const item = reply[key] as Record<string, unknown> | null;
          if (item) item.leaseToken = routed(id, item.leaseToken);
        }
      }
      return json(reply);
    }
    return response;
  }
  // Follow-ups to work another workspace handed out go back to it, with its own lease token.
  const target = routedLeaseToken(typeof body.leaseToken === 'string' ? body.leaseToken : null);
  if (target) return await env.WORKSPACES.getByName(target.workspaceId).execute(principal, action, { ...body, leaseToken: target.token });
  return await home.execute(principal, action, body);
}
