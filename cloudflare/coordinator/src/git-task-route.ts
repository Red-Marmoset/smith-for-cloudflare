// The machine side of a hosted-repository task (git-tasks.ts) that moves bytes: a backup bundle goes up to R2 in
// 5 MiB parts, a restore fetches the bundles back. Every step is authorised by the workspace Durable Object against
// the task's lease, exactly like the relay routes in git-route.ts; the object only ever names keys it owns.
import { fail, json, readBody, HttpError } from './http';
import { nodeAction as linkedNodeAction, routedLeaseToken } from './linked-nodes';

const NODE_TASK = /^\/api\/v2\/workspaces\/([a-f0-9]{64})\/git\/task\/([a-f0-9-]{36})\/(body|part|complete)$/;
const PART_SIZE = 5 * 1024 * 1024;
const MAX_PART_BODY = PART_SIZE + 1024;
type Finish = { kind: string; key: string | null; uploadId: string | null; parts: { part: number; etag: string; size: number }[] };

function bearer(request: Request): string { const h = request.headers.get('Authorization') ?? ''; return h.startsWith('Bearer ') && h.length < 512 ? h.slice(7) : ''; }
async function readExact(request: Request, length: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength !== length) fail(400, 'length_mismatch', 'The part is not as long as Content-Length says');
  return bytes;
}
export async function handleNodeTask(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const match = NODE_TASK.exec(url.pathname);
  if (!match) return null;
  const [, workspaceId, taskId, step] = match;
  const token = bearer(request);
  const leaseHeader = request.headers.get('X-Smith-Lease-Token') ?? '';
  const routed = routedLeaseToken(leaseHeader);
  const leaseToken = routed?.token ?? leaseHeader;
  const act = (action: string, body: Record<string, unknown>) => linkedNodeAction(env, workspaceId, token, action, { ...body, taskId, leaseToken: routed ? leaseHeader : leaseToken });
  const bucket = (env as { GIT?: R2Bucket }).GIT;
  try {
    if (!bucket) fail(503, 'no_bucket', 'This coordinator has no repository bucket');
    if (step === 'body') {
      if (request.method !== 'GET') fail(405, 'method', 'GET the bundle');
      const granted = await act('git-task-body', { backupId: url.searchParams.get('backup') ?? '' });
      if (!granted.ok) return granted;
      const { key, size } = await granted.json() as { key: string; size: number };
      const object = await bucket.get(key);
      if (!object) fail(503, 'backup_unavailable', 'The backup is no longer in the bucket');
      return new Response(object.body, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size), 'Cache-Control': 'private, no-store' } });
    }
    if (step === 'part') {
      if (request.method !== 'POST') fail(405, 'method', 'POST a part');
      const part = Number(url.searchParams.get('part') ?? '0');
      if (!Number.isSafeInteger(part) || part < 1) fail(400, 'invalid_part', 'part must be 1 or more');
      const length = Number(request.headers.get('Content-Length') ?? 'x');
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_PART_BODY) fail(413, 'part_too_large', 'Parts are at most 5 MiB');
      const granted = await act('git-task-part', { part });
      if (!granted.ok) return granted;
      const grant = await granted.json() as { key: string; uploadId: string | null };
      let { uploadId } = grant;
      if (!uploadId) {
        const upload = await bucket.createMultipartUpload(grant.key);
        const recorded = await act('git-task-upload', { uploadId: upload.uploadId });
        if (!recorded.ok) { try { await upload.abort(); } catch { /* lifecycle */ } return recorded; }
        uploadId = upload.uploadId;
      }
      const bytes = await readExact(request, length);
      const uploaded = await bucket.resumeMultipartUpload(grant.key, uploadId).uploadPart(part, bytes);
      const noted = await act('git-task-part-done', { part, etag: uploaded.etag, size: bytes.byteLength });
      if (!noted.ok) return noted;
      return json({ accepted: true, part, size: bytes.byteLength });
    }
    if (request.method !== 'POST') fail(405, 'method', 'POST the completion');
    const body = await readBody(request, 2 * 1024 * 1024);
    const finish = await act('git-task-finish', {});
    if (!finish.ok) return finish;
    const view = await finish.json() as Finish;
    if (view.kind === 'backup' && body.ok === true) {
      // The bundle must be whole in the bucket before the manifest becomes ready.
      if (!view.key || !view.uploadId || !view.parts.length) fail(409, 'no_parts', 'Upload the bundle before completing');
      const upload = bucket.resumeMultipartUpload(view.key, view.uploadId);
      try { await upload.complete(view.parts.map(p => ({ partNumber: p.part, etag: p.etag }))); } catch { /* a replayed completion already finished it */ }
      const stored = (await bucket.head(view.key))?.size ?? -1;
      if (Number(body.size ?? -1) !== stored) fail(400, 'size_mismatch', `Stored ${stored} bytes but the completion declares ${String(body.size)}`);
    }
    return await act('git-task-complete', body);
  } catch (error) {
    if (error instanceof HttpError) return json({ error: { code: error.code, message: error.message } }, error.status);
    console.error(JSON.stringify({ event: 'git_task_failed', type: error instanceof Error ? error.name : 'unknown' }));
    return json({ error: { code: 'internal_error', message: 'Request failed' } }, 500);
  }
}
