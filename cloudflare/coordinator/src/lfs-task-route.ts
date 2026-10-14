// The machine side of a large-file task (lfs-tasks.ts): a fetch streams the object down, a restore sends it back
// (straight to R2 over a presigned PUT when enabled, else through this Worker), and the completion is recorded.
// Every step is authorised by the workspace Durable Object against the task's lease, like git-task-route.ts.
import { fail, json, readBody, HttpError } from './http';
import { nodeAction as linkedNodeAction, routedLeaseToken } from './linked-nodes';
import { storeBody, hex } from './r2-store';
import { presignConfig, presignObject } from './r2-presign';
import { LFS_EXPIRES_SECONDS } from './lfs';

const NODE_LFS_TASK = /^\/api\/v2\/workspaces\/([a-f0-9]{64})\/lfs\/task\/([a-f0-9-]{36})\/(body|target|object|complete)$/;
type View = { kind: 'fetch' | 'restore' | 'drop'; key: string; size: number; oid: string; repoId: string };
function bearer(request: Request): string { const h = request.headers.get('Authorization') ?? ''; return h.startsWith('Bearer ') && h.length < 512 ? h.slice(7) : ''; }

export async function handleNodeLfsTask(request: Request, env: Env): Promise<Response | null> {
  const match = NODE_LFS_TASK.exec(new URL(request.url).pathname);
  if (!match) return null;
  const [, workspaceId, taskId, step] = match;
  const token = bearer(request);
  // A completion carries its lease in the body (the agent's Post sends no extra headers); the other steps in the header.
  const body = step === 'complete' ? await readBody(request, 65536) : {};
  const leaseHeader = request.headers.get('X-Smith-Lease-Token') ?? (typeof body.leaseToken === 'string' ? body.leaseToken : '');
  const routed = routedLeaseToken(leaseHeader);
  const leaseToken = routed?.token ?? leaseHeader;
  const act = (action: string, extra: Record<string, unknown>) => linkedNodeAction(env, workspaceId, token, action, { ...extra, taskId, leaseToken: routed ? leaseHeader : leaseToken });
  const bucket = (env as { GIT?: R2Bucket }).GIT;
  try {
    if (!bucket) fail(503, 'no_bucket', 'This coordinator has no repository bucket');
    const viewed = await act('lfs-task-view', {});
    if (!viewed.ok) return viewed;
    const view = await viewed.json() as View;
    if (step === 'body') {
      if (request.method !== 'GET') fail(405, 'method', 'GET the object');
      if (view.kind !== 'fetch') fail(409, 'not_fetch', 'This task does not download an object');
      const object = await bucket.get(view.key);
      if (!object) fail(503, 'object_unavailable', 'The object is no longer in the bucket');
      return new Response(object.body, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(object.size), 'Cache-Control': 'private, no-store' } });
    }
    if (step === 'target') {
      if (request.method !== 'POST') fail(405, 'method', 'POST for the upload target');
      if (view.kind !== 'restore') fail(409, 'not_restore', 'This task does not restore an object');
      const signer = presignConfig(env);
      return json({ href: signer ? await presignObject(signer, 'PUT', view.key, LFS_EXPIRES_SECONDS) : null, size: view.size });
    }
    if (step === 'object') {
      if (request.method !== 'PUT') fail(405, 'method', 'PUT the object');
      if (view.kind !== 'restore') fail(409, 'not_restore', 'This task does not restore an object');
      const stored = await storeBody(bucket, view.key, request, Math.max(view.size, 1), { sha256: view.oid });
      if (stored.size !== view.size) { try { await bucket.delete(view.key); } catch { /* best effort */ } fail(422, 'size_mismatch', `Uploaded ${stored.size} bytes; the object is ${view.size} bytes`); }
      return json({ stored: stored.size });
    }
    if (request.method !== 'POST') fail(405, 'method', 'POST the completion');
    let verified = false;
    if (view.kind === 'restore' && body.ok === true) {
      // Whichever way it arrived, the object in R2 must hash to its id before the record calls it ready.
      const object = await bucket.get(view.key);
      if (!object) fail(409, 'not_stored', 'The object did not arrive in the bucket');
      if (object.size !== view.size) { try { await object.body.cancel(); } catch { /* unread */ } try { await bucket.delete(view.key); } catch { /* best effort */ } fail(422, 'size_mismatch', `Stored ${object.size} bytes; the object is ${view.size} bytes`); }
      const digest = new crypto.DigestStream('SHA-256'); await object.body.pipeTo(digest);
      if (hex(await digest.digest) !== view.oid) { try { await bucket.delete(view.key); } catch { /* best effort */ } fail(422, 'hash_mismatch', 'The restored object does not match its id'); }
      verified = true;
    }
    // `held: false` is the machine saying it has no intact copy (restore only); anything else keeps it a holder.
    return await act('lfs-task-complete', { ok: body.ok, message: body.message ?? '', verified, ...(body.held === false ? { held: false } : {}) });
  } catch (error) {
    if (error instanceof HttpError) return json({ error: { code: error.code, message: error.message } }, error.status);
    console.error(JSON.stringify({ event: 'lfs_task_failed', type: error instanceof Error ? error.name : 'unknown' }));
    return json({ error: { code: 'internal_error', message: 'Request failed' } }, 500);
  }
}
