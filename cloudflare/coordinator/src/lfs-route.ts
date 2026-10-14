// Git LFS for every project of a workspace, where git-lfs looks for it: <origin>/git/<project>.git/info/lfs.
// Authentication is the git endpoint's (authenticateGit). Objects move through this Worker (proxy mode) or
// straight to R2 over presigned URLs; this module answers the batch API and routes the transfers.
import { authenticateGit, CHALLENGE, type GitAuth } from './git-route';
import { HttpError, readText } from './http';
import { LFS_MEDIA, LFS_EXPIRES_SECONDS, lfsKey, parseBatchRequest, type LfsRow, type LfsVerdict } from './lfs';
import { storeBody, hex } from './r2-store';
import { presignConfig, presignObject } from './r2-presign';

export const LFS_PATH = /^\/git\/([a-z0-9][a-z0-9-]{0,63})(?:\.git)?\/info\/lfs(?:\/(.*))?$/;
const LFS_CHALLENGE = { ...CHALLENGE, 'LFS-Authenticate': 'Basic realm="Smith"' };
const NO_CACHE = { 'Cache-Control': 'no-cache, no-store, must-revalidate', 'X-Content-Type-Options': 'nosniff' };
const MAX_BATCH_BYTES = 1024 * 1024;

export function lfsJson(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': LFS_MEDIA, ...NO_CACHE, ...headers } });
}
export function lfsError(status: number, message: string, headers: Record<string, string> = {}): Response { return lfsJson({ message }, status, headers); }

type Transfer = { href: string; header?: Record<string, string>; expires_in: number };

// Reads a Durable Object refusal into an LFS error, counting 401/403 against the client address. A token without the
// build scope asking to upload gets the one next step, as git's push refusal does.
async function refuse(response: Response, failed: (r: Response) => Promise<Response>, writer = false): Promise<Response> {
  const error = (await response.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
  const message = writer && error.error?.code === 'scope' ? 'This Smith token cannot upload large files. In the dashboard, create a token that can start builds and use it as the password' : error.error?.message ?? 'Request refused';
  const out = lfsError(response.status, message, response.status === 401 ? LFS_CHALLENGE : {});
  return response.status === 401 || response.status === 403 ? await failed(out) : out;
}

function acceptsLfs(request: Request): boolean {
  return (request.headers.get('Accept') ?? '').split(',').some(part => part.trim().split(';')[0] === LFS_MEDIA);
}

export async function handleLfs(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url);
  const match = LFS_PATH.exec(url.pathname);
  if (!match) return null;
  const [, repoId, rest = ''] = match;
  const object = /^objects\/([a-f0-9]{64})(?:\/(verify))?$/.exec(rest);
  if (rest !== 'objects/batch' && !object) return lfsError(404, 'Smith serves the Git LFS batch API and basic transfers here; locks are not supported');
  // The batch and verify calls speak the LFS media type; raw object transfers (PUT/GET) carry bytes and need no Accept.
  if ((rest === 'objects/batch' || object?.[2]) && !acceptsLfs(request)) return lfsError(406, `Send Accept: ${LFS_MEDIA}`);
  const auth = await authenticateGit(request, env, LFS_CHALLENGE, (status, message, headers) => lfsError(status, message, headers));
  if (!auth.ok) return auth.response;
  if (rest === 'objects/batch') {
    if (request.method !== 'POST') return lfsError(405, 'Method not allowed');
    let batch: ReturnType<typeof parseBatchRequest>;
    try { batch = parseBatchRequest(JSON.parse(await readText(request, MAX_BATCH_BYTES))); }
    catch (error) { return error instanceof HttpError ? lfsError(error.status, error.message) : lfsError(422, 'The batch request is not valid JSON'); }
    const writer = batch.operation === 'upload';
    // With the R2 API-token secrets the bytes go straight to R2 over presigned URLs (no size cap but R2's own);
    // otherwise they move through this Worker, capped by the request-body limit, with the credential echoed back.
    const signer = presignConfig(env);
    const decided = await auth.stub.execute(auth.principal, writer ? 'lfs-write' : 'lfs-read', { repo: repoId, step: 'batch', username: auth.username, objects: batch.objects, presign: Boolean(signer) });
    if (!decided.ok) return await refuse(decided, auth.failed, writer);
    const { verdicts } = await decided.json() as { verdicts: LfsVerdict[] };
    // Same-origin hrefs carry no credential: the client reuses what it authenticated the batch with (its credential
    // helper, the URL, or git's http.<url>.extraheader as the agent sets it), so nothing is sent twice. Presigned
    // R2 hrefs are `authenticated`: they carry their own signature and must get no Smith credential.
    const base = `${env.ORIGIN}/git/${repoId}.git/info/lfs/objects/`;
    const proxy = (oid: string, suffix = ''): Transfer => ({ href: base + oid + suffix, expires_in: LFS_EXPIRES_SECONDS });
    const direct = async (oid: string, method: 'GET' | 'PUT'): Promise<Transfer> => ({ href: await presignObject(signer!, method, lfsKey(auth.workspaceId, repoId, oid), LFS_EXPIRES_SECONDS), expires_in: LFS_EXPIRES_SECONDS });
    const objects: Record<string, unknown>[] = [];
    for (const v of verdicts) {
      if ('error' in v) { objects.push({ oid: v.oid, size: v.size, error: v.error }); continue; }
      if ('have' in v) { objects.push(writer ? { oid: v.oid, size: v.size } : { oid: v.oid, size: v.size, ...(signer ? { authenticated: true } : {}), actions: { download: signer ? await direct(v.oid, 'GET') : proxy(v.oid) } }); continue; }
      objects.push({ oid: v.oid, size: v.size, ...(signer ? { authenticated: true } : {}), actions: { upload: signer ? await direct(v.oid, 'PUT') : proxy(v.oid), verify: proxy(v.oid, '/verify') } });
    }
    return lfsJson({ transfer: 'basic', objects });
  }
  // objects/<oid>[/verify]: the basic transfer through this Worker, and the verify step.
  const [, oid, verify] = object!;
  const bucket = (env as { GIT?: R2Bucket }).GIT;
  if (!bucket) return lfsError(503, 'Large-file storage is not configured on this coordinator');
  const key = lfsKey(auth.workspaceId, repoId, oid);
  if (verify && request.method !== 'POST') return lfsError(405, 'Method not allowed');
  if (!verify && request.method !== 'PUT' && request.method !== 'GET') return lfsError(405, 'Method not allowed');
  const writer = request.method === 'PUT' || Boolean(verify);
  const authorized = await auth.stub.execute(auth.principal, writer ? 'lfs-write' : 'lfs-read', { repo: repoId, step: verify ? 'verify' : 'authorize', username: auth.username, oid });
  if (!authorized.ok) return await refuse(authorized, auth.failed, writer);
  const { row } = await authorized.json() as { row: LfsRow };
  if (verify) {
    const claim = (await readText(request, 4096).then(t => JSON.parse(t)).catch(() => ({}))) as { oid?: unknown; size?: unknown };
    if (claim.oid !== oid || claim.size !== row.size) return lfsError(422, `The object is ${row.size} bytes`);
    if (row.state === 'ready') return lfsJson({});
    return await verifyStored(bucket, key, row, auth, repoId, oid);
  }
  if (request.method === 'GET') {
    const stored = await bucket.get(key);
    if (!stored) {
      // R2 no longer has a ready object: the record marks it lost, and a machine holding a copy restores it (spec §8).
      await auth.stub.execute(auth.principal, 'lfs-read', { repo: repoId, step: 'lost', username: auth.username, oid });
      return lfsError(404, 'Object lost from storage; a machine holding a copy restores it');
    }
    return new Response(stored.body, { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(stored.size), ...NO_CACHE } });
  }
  if (row.state === 'ready') { try { await request.body?.cancel(); } catch { /* nothing to drain */ } return lfsJson({}); }   // a retry of a finished upload
  let stored: { size: number };
  try { stored = await storeBody(bucket, key, request, Math.max(row.size, 1), { sha256: oid }); }
  catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return error.status === 413 ? lfsError(422, `Uploaded data is longer than the object (${row.size} bytes)`) : lfsError(error.status, error.message);
  }
  if (stored.size !== row.size) { try { await bucket.delete(key); } catch { /* best effort */ } return lfsError(422, `Uploaded data is ${stored.size} bytes; the object is ${row.size} bytes`); }
  const done = await auth.stub.execute(auth.principal, 'lfs-write', { repo: repoId, step: 'stored', username: auth.username, oid, size: stored.size });
  if (!done.ok) return await refuse(done, auth.failed, true);
  return lfsJson({});
}

// A verify of a pending object (a presigned upload bypassed this Worker): it must exist in R2 with the recorded size and
// hash to its oid, read back through the binding. A mismatch deletes it, so a wrong body never becomes a ready object.
async function verifyStored(bucket: R2Bucket, key: string, row: LfsRow, auth: Extract<GitAuth, { ok: true }>, repoId: string, oid: string): Promise<Response> {
  const stored = await bucket.get(key);
  if (!stored) return lfsError(404, 'Object not found');
  const reject = async (message: string) => { try { await bucket.delete(key); } catch { /* best effort */ } return lfsError(422, message); };
  if (stored.size !== row.size) { try { await stored.body.cancel(); } catch { /* unread */ } return await reject(`Uploaded data is ${stored.size} bytes; the object is ${row.size} bytes`); }
  const digest = new crypto.DigestStream('SHA-256');
  await stored.body.pipeTo(digest);
  if (hex(await digest.digest) !== oid) return await reject('Uploaded data does not match the object id');
  const done = await auth.stub.execute(auth.principal, 'lfs-write', { repo: repoId, step: 'stored', username: auth.username, oid, size: row.size });
  if (!done.ok) return await refuse(done, auth.failed, true);
  return lfsJson({});
}
