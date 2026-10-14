// Starting a project from a zip: the person's browser uploads the zip (at most 100 MB, one request) to the GIT bucket
// under imports/<workspace>/, and the workspace queues the host job that turns it into Smith's repository
// (git-workspace.ts addSmithProject). The machine running that job downloads the zip here with its job lease.
// Both routes take raw bytes, so index.ts matches them before its JSON body reader.
import { fail } from './http';
import { authenticateHuman as human } from './auth';
import { routedLeaseToken } from './linked-nodes';
import { storeBody } from './r2-store';
import { MAX_IMPORT_BYTES } from './git-host';

const UPLOAD = /^\/api\/v2\/workspaces\/([a-f0-9]{64})\/projects\/import$/;
const DOWNLOAD = /^\/api\/v2\/workspaces\/([a-f0-9]{64})\/jobs\/([a-f0-9-]{36})\/import$/;
const ZIP_TYPES = ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'];

function bearer(request: Request): string { const h = request.headers.get('Authorization') ?? ''; return h.startsWith('Bearer ') && h.length < 512 ? h.slice(7) : ''; }
// The zip's own name, for the first commit's message: a plain file name, nothing that could be a path.
export function archiveName(value: string | null): string {
  const name = (value ?? '').split(/[\\/]/).at(-1)!.replace(/[^A-Za-z0-9 ._()-]/g, '').trim().slice(0, 120);
  return name || 'upload.zip';
}

export async function handleProjectImport(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const upload = UPLOAD.exec(url.pathname);
  if (upload && request.method === 'POST') {
    const principal = await human(request, env);
    const stub = env.WORKSPACES.getByName(upload[1]);
    if (!ZIP_TYPES.includes((request.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase())) fail(415, 'content_type', 'Upload a .zip file');
    const length = Number(request.headers.get('Content-Length') ?? 'x');
    if (Number.isSafeInteger(length) && length > MAX_IMPORT_BYTES) fail(413, 'too_large', 'The zip is larger than 100 MB. Push the project with git instead: start an empty project and push to it');
    const name = url.searchParams.get('name') ?? '', branch = url.searchParams.get('branch') ?? '';
    // Refuse before taking 100 MB: no admin rights, no machine to create it on, or the workspace is full.
    const check = await stub.execute(principal, 'smith-project-check', {});
    if (!check.ok) { void request.body?.cancel().catch(() => {}); return check; }
    const key = `imports/${upload[1]}/${crypto.randomUUID()}.zip`;
    const size = (await storeBody(env.GIT, key, new Request(request, { headers: { 'Content-Type': 'application/zip' } }), MAX_IMPORT_BYTES)).size;
    if (size < 22) { await env.GIT.delete(key); fail(400, 'invalid_zip', 'That file is not a zip archive'); }   // 22 bytes: an empty zip's end record
    const head = await env.GIT.get(key, { range: { offset: 0, length: 4 } });
    const magic = head ? new Uint8Array(await head.arrayBuffer()) : new Uint8Array(0);
    if (magic[0] !== 0x50 || magic[1] !== 0x4b) { await env.GIT.delete(key); fail(400, 'invalid_zip', 'That file is not a zip archive'); }
    const created = await stub.execute(principal, 'add-smith-project', { source: 'zip', name, ...(branch ? { branch } : {}), upload: { key, size, fileName: archiveName(url.searchParams.get('file')) } });
    if (!created.ok) await env.GIT.delete(key);
    return created;
  }
  const download = DOWNLOAD.exec(url.pathname);
  if (download && request.method === 'GET') {
    // A job handed out by another of the owner's workspaces carries that workspace in its lease token (linked-nodes.ts).
    const leaseHeader = request.headers.get('X-Smith-Lease-Token') ?? '';
    const routed = routedLeaseToken(leaseHeader);
    const stub = env.WORKSPACES.getByName(routed?.workspaceId ?? download[1]);
    const granted = await stub.execute({ kind: 'node', token: bearer(request) }, 'host-import',
      { jobId: download[2], attemptId: request.headers.get('X-Smith-Attempt-Id') ?? '', leaseToken: routed?.token ?? leaseHeader });
    if (!granted.ok) return granted;
    const { key, size } = await granted.json() as { key: string; size: number };
    const object = await env.GIT.get(key);
    if (!object) fail(410, 'upload_gone', 'The uploaded zip is no longer stored. Start the project again with a new upload');
    return new Response(object.body, { headers: { 'Content-Type': 'application/zip', 'Content-Length': String(size), 'Cache-Control': 'private, no-store' } });
  }
  return null;
}
