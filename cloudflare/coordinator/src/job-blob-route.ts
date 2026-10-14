// A job's one named blob (today: an import's original-history bundle), uploaded in 5 MiB parts under the job's lease and
// completed with its size and SHA-256. The workspace object chooses the key and records a git_backups row of kind 'original'.
// Every step is authorised by the Durable Object against the job's lease, exactly like the task routes in git-task-route.ts.
import { fail, json, readBody, HttpError } from './http';
import { nodeAction as linkedNodeAction } from './linked-nodes';
import { hex } from './r2-store';

const JOB_BLOB = /^\/api\/v2\/workspaces\/([a-f0-9]{64})\/jobs\/([a-f0-9-]{36})\/blobs\/([a-z0-9][a-z0-9.-]{0,63})(\/complete)?$/;
const PART_SIZE = 5 * 1024 * 1024;
function bearer(request: Request): string { const h = request.headers.get('Authorization') ?? ''; return h.startsWith('Bearer ') && h.length < 512 ? h.slice(7) : ''; }
export async function handleJobBlob(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url); const match = JOB_BLOB.exec(url.pathname);
  if (!match) return null;
  const [, workspaceId, jobId, name, completing] = match;
  const leaseHeader = request.headers.get('X-Smith-Lease-Token') ?? '';
  const act = (action: string, body: Record<string, unknown>) => linkedNodeAction(env, workspaceId, bearer(request), action, { ...body, jobId, name, leaseToken: leaseHeader });
  const bucket = (env as { GIT?: R2Bucket }).GIT;
  try {
    if (request.method !== 'POST') fail(405, 'method', 'POST the part or the completion');
    if (!bucket) fail(503, 'no_bucket', 'This coordinator has no repository bucket');
    if (!completing) {
      const part = Number(url.searchParams.get('part') ?? '0');
      if (!Number.isSafeInteger(part) || part < 1 || part > 10000) fail(400, 'invalid_part', 'part must be 1 to 10000');
      const length = Number(request.headers.get('Content-Length') ?? 'x');
      if (!Number.isSafeInteger(length) || length < 1 || length > PART_SIZE + 1024) fail(413, 'part_too_large', 'Parts are at most 5 MiB');
      const granted = await act('git-blob-part', { part }); if (!granted.ok) return granted;
      const grant = await granted.json() as { key: string; uploadId: string | null };
      let { uploadId } = grant;
      if (!uploadId) {
        const upload = await bucket.createMultipartUpload(grant.key);
        const recorded = await act('git-blob-upload', { uploadId: upload.uploadId });
        if (!recorded.ok) { try { await upload.abort(); } catch { /* lifecycle */ } return recorded; }
        uploadId = upload.uploadId;
      }
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength !== length) fail(400, 'length_mismatch', 'The part is not as long as Content-Length says');
      const uploaded = await bucket.resumeMultipartUpload(grant.key, uploadId).uploadPart(part, bytes);
      const noted = await act('git-blob-part-done', { part, etag: uploaded.etag, size: bytes.byteLength }); if (!noted.ok) return noted;
      return json({ accepted: true, part, size: bytes.byteLength });
    }
    const body = await readBody(request, 4096);
    const size = Number(body.size), sha256 = String(body.sha256 ?? '');
    if (!Number.isSafeInteger(size) || size < 1 || !/^[a-f0-9]{64}$/.test(sha256)) fail(400, 'invalid_field', 'size and sha256 are required');
    const finish = await act('git-blob-finish', {}); if (!finish.ok) return finish;
    const view = await finish.json() as { key: string; uploadId: string | null; parts: { part: number; etag: string; size: number }[]; done: boolean; size: number };
    if (view.done) return json({ accepted: true, key: view.key, size: view.size });   // a replayed completion
    if (!view.uploadId || !view.parts.length) fail(409, 'no_parts', 'Upload the bundle before completing');
    const upload = bucket.resumeMultipartUpload(view.key, view.uploadId);
    try { await upload.complete(view.parts.map(p => ({ partNumber: p.part, etag: p.etag }))); } catch { /* already completed by a replay */ }
    const object = await bucket.get(view.key);
    if (!object) fail(409, 'no_object', 'The bundle is not in the bucket');
    // A mismatch in size or digest throws the stored bytes away and lets the machine send the parts again.
    const stored = object.size; const digest = new crypto.DigestStream('SHA-256'); await object.body.pipeTo(digest); const actual = hex(await digest.digest);
    if (stored !== size || actual !== sha256) {
      await bucket.delete(view.key); await act('git-blob-reset', {});
      fail(400, stored !== size ? 'size_mismatch' : 'digest_mismatch', stored !== size ? `Stored ${stored} bytes but the completion declares ${size}` : 'The stored bundle does not match the declared SHA-256');
    }
    const recorded = await act('git-blob-complete', { size, sha256 }); if (!recorded.ok) return recorded;
    return json({ accepted: true, key: view.key, size });
  } catch (error) {
    if (error instanceof HttpError) return json({ error: { code: error.code, message: error.message } }, error.status);
    console.error(JSON.stringify({ event: 'job_blob_failed', type: error instanceof Error ? error.name : 'unknown' }));
    return json({ error: { code: 'internal_error', message: 'Request failed' } }, 500);
  }
}
