// The public git endpoint <origin>/git/<project>.git and the machine side of its relay.
//
// A git client authenticates with HTTP Basic (the password is a Smith token, the username the workspace's
// twelve-digit prefix) or Bearer. The Worker opens a relay in the workspace Durable Object, writes the request
// body to the R2 mailbox, waits for the machine that holds the repository to answer, and streams the answer
// back. Bodies are never buffered whole: a gzipped body is inflated in flight and capped, and anything over
// 5 MiB goes up in multipart parts. Machines fetch the body, run git, and upload the output in parts through
// the routes at the bottom; every one of those is authorised by the Durable Object against the relay's lease.
import { fail, json, hash, readBody, HttpError } from './http';
import { tokenWorkspace, isRunToken } from './tokens';
import { ticketWorkspace, pktErr, pktLine, parseLsRefs, v2Advertisement, type GitService, type RelayOp } from './git-host';
import { nodeAction as linkedNodeAction, routedLeaseToken } from './linked-nodes';
import type { Principal } from './contracts';
import { storeBody, MAX_PART_BODY } from './r2-store';
import { proxyGit, STORAGE_UNREACHABLE } from './git-proxy';

const GIT_PATH = /^\/git\/([a-z0-9][a-z0-9-]{0,63})(?:\.git)?(?:\/(info\/refs|git-upload-pack|git-receive-pack))?\/?$/;
const NO_CACHE = { 'Cache-Control': 'no-cache, max-age=0, must-revalidate', Pragma: 'no-cache', Expires: 'Fri, 01 Jan 1980 00:00:00 GMT', 'X-Content-Type-Options': 'nosniff' };
export const CHALLENGE = { 'WWW-Authenticate': 'Basic realm="Smith", charset="UTF-8"' };
type Env2 = Env & { GIT_RATE?: RateLimit; GIT_FAIL_RATE?: RateLimit };
type Opened = { relayId: string; repoId: string; writer: boolean; nodeId: string; waitMs: number; bodyCap: number };
// The workspace object's answer for an Artifacts home: the Worker proxies to `remote` with a token of `scope` (spec §2).
type ProxyOpen = { backend: 'artifacts'; repoId: string; remote: string; scope: 'read' | 'write'; writer: boolean };
type WorkspaceStub = ReturnType<Env['WORKSPACES']['getByName']>;
type RelayView = { id: string; state: string; status: number | null; resKey: string | null; size: number | null; message: string; uploadId: string | null; parts: { part: number; etag: string; size: number }[]; reqKey: string | null };

function text(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(message + '\n', { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...NO_CACHE, ...headers } });
}
// What the git client should see for a refused request: an ERR pkt-line in an advertisement (git prints it as
// "fatal: remote error: …"), a plain text body for an RPC. Authentication failures stay true 401s with the
// challenge, so credential helpers forget a bad password and ask again.
function refusal(op: RelayOp, service: GitService, status: number, code: string, message: string): Response {
  if (status === 401 || code === 'unauthenticated' || code === 'invalid_token' || code === 'invalid_ticket' || code === 'wrong_workspace' || code === 'run_over') return text(401, message || 'Authentication required', CHALLENGE);
  const friendly = code === 'scope' && service === 'receive-pack' ? 'This Smith token cannot push. In the dashboard, create a token that can start builds and use it as the password' : message;
  if (op === 'info-refs' && status !== 404 && status !== 429) {
    return new Response(pktErr(friendly), { status: 200, headers: { 'Content-Type': `application/x-git-${service}-advertisement`, ...NO_CACHE } });
  }
  return text(status, friendly);
}
function credentialOf(request: Request): { credential: string; username: string } | null {
  const header = request.headers.get('Authorization') ?? '';
  if (header.startsWith('Bearer ')) { const credential = header.slice(7).trim(); return credential && credential.length <= 512 ? { credential, username: '' } : null; }
  if (!header.startsWith('Basic ')) return null;
  let decoded: string;
  try { decoded = atob(header.slice(6).trim()); } catch { return null; }
  const colon = decoded.indexOf(':'); if (colon < 0) return null;
  const credential = decoded.slice(colon + 1).trim();
  return credential && credential.length <= 512 ? { credential, username: decoded.slice(0, colon).slice(0, 128) } : null;
}
async function limited(limit: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limit || !key) return false;
  try { return !(await limit.limit({ key })).success; } catch { return false; }
}

// GET/POST /git/<repo>[.git]/(info/refs|git-upload-pack|git-receive-pack): null when the path is not git at all.
export type GitAuth = { ok: true; principal: Principal; workspaceId: string; username: string; credential: string; ticket: boolean; stub: ReturnType<Env['WORKSPACES']['getByName']>; failed: (response: Response) => Promise<Response> } | { ok: false; response: Response };

// The credential rules shared by git and LFS: Basic/Bearer with a Smith token or git ticket, the rate limits, the
// workspace directory check. `challenge` is the header set a 401 carries (git: WWW-Authenticate; LFS adds LFS-Authenticate)
// and `reply` shapes refusals (git: plain text; LFS: its JSON media type).
export async function authenticateGit(request: Request, env: Env, challenge: Record<string, string>, reply: (status: number, message: string, headers?: Record<string, string>) => Response = text): Promise<GitAuth> {
  const env2 = env as Env2;
  const ip = request.headers.get('CF-Connecting-IP') ?? '';
  const parsed = credentialOf(request);
  if (!parsed) return { ok: false, response: await limited(env2.GIT_FAIL_RATE, ip) ? reply(429, 'Too many failed git requests; wait a minute') : reply(401, 'Sign in with a Smith token as the password', challenge) };
  const { credential, username } = parsed;
  if (/^smn\./.test(credential)) return { ok: false, response: await limited(env2.GIT_FAIL_RATE, ip) ? reply(429, 'Too many failed git requests; wait a minute') : reply(401, 'A machine credential cannot clone; use a Smith token', challenge) };
  if (isRunToken(credential)) return { ok: false, response: reply(403, 'A crew run token cannot use git') };
  const workspaceId = tokenWorkspace(credential) ?? ticketWorkspace(credential);
  if (!workspaceId) return { ok: false, response: await limited(env2.GIT_FAIL_RATE, ip) ? reply(429, 'Too many failed git requests; wait a minute') : reply(401, 'That is not a Smith token', challenge) };
  if (await limited(env2.GIT_RATE, await hash(credential))) return { ok: false, response: reply(429, 'Too many git requests; wait a minute') };
  // Failures count against the client address; past the budget they turn into 429s rather than more 401s.
  const failed = async (response: Response) => await limited(env2.GIT_FAIL_RATE, ip) ? reply(429, 'Too many failed git requests; wait a minute') : response;
  const ticket = credential.startsWith('smith_git_');
  const principal: Principal = ticket ? { kind: 'ticket', token: credential, nodeToken: request.headers.get('X-Smith-Node') } : { kind: 'token', token: credential };
  if (!ticket && !await env.DB.prepare('SELECT id FROM workspaces WHERE id = ?').bind(workspaceId).first()) return { ok: false, response: await failed(reply(401, 'That token belongs to no workspace', challenge)) };
  return { ok: true, principal, workspaceId, username, credential, ticket, stub: env.WORKSPACES.getByName(workspaceId), failed };
}

// The Artifacts backend (spec §2): a token from the workspace object's cache, the request passed through; a rejected token
// is re-minted once; Artifacts down lets a reader fall over to a machine copy and tells a writer to try later.
async function viaArtifacts(request: Request, stub: WorkspaceStub, open: ProxyOpen, path: 'info/refs' | 'git-upload-pack' | 'git-receive-pack', search: string, op: RelayOp, service: GitService): Promise<Response | 'relay'> {
  let force = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    let minted: Response;
    try { minted = await stub.artifactsToken(open.repoId, open.scope, force); } catch { return text(502, 'Smith could not reach its copy of this project'); }
    if (!minted.ok) return text(502, 'Smith could not reach its copy of this project');
    const { token } = await minted.json() as { token: string };
    const outcome = await proxyGit(request, open.remote, token, path, search);
    if (outcome.kind === 'response') return outcome.response;
    if (outcome.kind === 'refused') {
      console.error(JSON.stringify({ event: 'artifacts_token_refused', repoId: open.repoId, attempt }));
      // A push's body went with the first attempt: nothing was pushed, a fresh token is cached for the next one, and git says why.
      if (op === 'rpc' && service === 'receive-pack') { try { await stub.artifactsToken(open.repoId, open.scope, true); } catch { /* the next push mints */ } return text(503, 'Smith’s storage refused its credential for this push; nothing was pushed. Push again'); }
      force = true; continue;
    }
    console.error(JSON.stringify({ event: 'artifacts_unavailable', repoId: open.repoId, reason: outcome.reason }));
    if (open.writer) return op === 'info-refs' ? new Response(pktErr(STORAGE_UNREACHABLE), { status: 200, headers: { 'Content-Type': `application/x-git-${service}-advertisement`, ...NO_CACHE } }) : text(503, STORAGE_UNREACHABLE);
    return 'relay';
  }
  return text(502, 'Smith could not reach its copy of this project');
}

export async function handleGit(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/git/')) return null;
  const match = GIT_PATH.exec(url.pathname);
  if (!match || !match[2]) return text(404, 'Not a git endpoint. Clone with: git clone <this address>/git/<project>.git');
  const [, repoId, route] = match;
  let service: GitService; let op: RelayOp;
  if (route === 'info/refs') {
    if (request.method !== 'GET') return text(405, 'Method not allowed');
    const wanted = url.searchParams.get('service');
    if (wanted !== 'git-upload-pack' && wanted !== 'git-receive-pack') return text(403, 'Smith serves only the smart git protocol: use a current git client');
    service = wanted.slice(4) as GitService; op = 'info-refs';
  } else {
    if (request.method !== 'POST') return text(405, 'Method not allowed');
    service = route.slice(4) as GitService; op = 'rpc';
    if ((request.headers.get('Content-Type') ?? '').split(';')[0].trim() !== `application/x-git-${service}-request`) return text(415, `Expected application/x-git-${service}-request`);
  }
  const auth = await authenticateGit(request, env, CHALLENGE);
  if (!auth.ok) return auth.response;
  const { principal, workspaceId, username, ticket, stub, failed } = auth;
  const gitProtocol = (request.headers.get('Git-Protocol') ?? '').slice(0, 64);
  const v2 = /(^|:)version=2(:|$)/.test(gitProtocol);
  const refuse = async (opened: Response) => {
    const error = (await opened.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    const response = refusal(op, service, opened.status, error.error?.code ?? '', error.error?.message ?? 'Request refused');
    return opened.status === 401 || opened.status === 403 ? await failed(response) : response;
  };
  // An Artifacts home is proxied (spec §2): the workspace object says so when it authorises the request. A reader's RPC
  // body is kept so a proxy that gets no answer can fall over to the relay with the same bytes (negotiation bodies are small).
  const proxyPath = route === 'info/refs' ? 'info/refs' : route as 'git-upload-pack' | 'git-receive-pack';
  let bodyBytes: Uint8Array | null = null;
  if (op === 'rpc' && service === 'upload-pack') { const peeked = await peekBody(request, 16 * 1024 * 1024); bodyBytes = peeked.bytes; request = peeked.request; }
  const again = () => bodyBytes ? new Request(request, { body: bodyBytes }) : request;
  const proxied = async (open: ProxyOpen): Promise<Response | 'relay'> => {
    const r = await viaArtifacts(again(), stub, open, proxyPath, url.search, op, service);
    if (r === 'relay' || service !== 'receive-pack' || op !== 'rpc' || r.status !== 200 || !r.body) return r;
    // The refs move while the push's result streams: the record reads the advertisement once the whole result went out,
    // whether or not the client read it.
    const [toClient, toDrain] = r.body.tee();
    ctx.waitUntil(toDrain.pipeTo(new WritableStream()).catch(() => undefined).then(() => stub.artifactsPushed(open.repoId)));
    return new Response(toClient, { status: r.status, statusText: r.statusText, headers: r.headers });
  };
  let forced: Record<string, unknown> = {};
  // A clone's first two requests need no machine: the protocol v2 advertisement is fixed, and the ref list comes from
  // the coordinator's record (authorised exactly like a relayed request; the machine that would serve them is online).
  // An Artifacts home answers both from Artifacts itself, so a client always sees storage's truth.
  if (service === 'upload-pack' && op === 'info-refs' && v2) {
    const allowed = await stub.execute(principal, 'git-advertise', { repo: repoId, service, op, username, gitProtocol, label: ticket ? undefined : 'member' });
    if (!allowed.ok) return await refuse(allowed);
    const answer = await allowed.json() as { backend?: string } & ProxyOpen;
    if (answer.backend === 'artifacts') { const r = await proxied(answer); if (r !== 'relay') return r; forced = { backend: 'relay' }; }
    else return new Response(v2Advertisement(), { status: 200, headers: { 'Content-Type': `application/x-git-${service}-advertisement`, ...NO_CACHE } });
  }
  if (service === 'upload-pack' && op === 'rpc' && v2 && !request.headers.get('Content-Encoding') && !forced.backend) {
    // ls-refs requests are a few hundred bytes; the head of the body was read above without consuming the rest.
    const lsRefs = bodyBytes ? parseLsRefs(bodyBytes.subarray(0, 65536)) : null;
    if (lsRefs) {
      const answered = await stub.execute(principal, 'git-ls-refs', { repo: repoId, service, op, username, gitProtocol, label: ticket ? undefined : 'member', lsRefs });
      if (!answered.ok) return await refuse(answered);
      const answer = await answered.json() as { lines?: string[] | null; backend?: string } & Partial<ProxyOpen>;
      if (answer.backend === 'artifacts') { const r = await proxied(answer as ProxyOpen); if (r !== 'relay') return r; forced = { backend: 'relay' }; }
      else if (answer.lines) return new Response(answer.lines.map(line => pktLine(line + '\n')).join('') + '0000', { status: 200, headers: { 'Content-Type': `application/x-git-${service}-result`, ...NO_CACHE } });
    }
  }
  let relay: Opened;
  for (;;) {
    const opened = await stub.execute(principal, service === 'receive-pack' ? 'git-write' : 'git-read', { repo: repoId, service, op, username, gitProtocol, label: ticket ? undefined : 'member', ...forced });
    if (!opened.ok) return await refuse(opened);
    const answer = await opened.json() as Opened | ProxyOpen;
    if ('backend' in answer && answer.backend === 'artifacts') {
      const r = await proxied(answer); if (r !== 'relay') return r;
      forced = { backend: 'relay' }; continue;
    }
    relay = answer as Opened; break;
  }
  const abort = async (message: string) => { await stub.gitRelay('abort', { relayId: relay.relayId, message }); };
  // The request body into the mailbox: inflated if the client gzipped it, capped, in parts past 5 MiB.
  const reqKey = `relay/${workspaceId}/${relay.relayId}/req`;
  let size = 0;
  if (op === 'rpc') {
    try { size = (await storeBody(env.GIT, reqKey, again(), relay.bodyCap)).size; }
    catch (error) {
      await abort(error instanceof HttpError ? error.message : 'The request body could not be read');
      if (error instanceof HttpError) return text(error.status, error.message);
      console.error(JSON.stringify({ event: 'git_body_failed', type: error instanceof Error ? error.name : 'unknown', message: error instanceof Error ? error.message.slice(0, 200) : '' }));
      return text(400, 'The request body could not be read');
    }
  }
  await stub.gitRelay('ready', { relayId: relay.relayId, reqKey: op === 'rpc' ? reqKey : null, size });
  // Wait for the machine. The Durable Object holds each wait for up to 25 s; the state is in SQLite, so nothing is lost
  // if the object restarts between waits.
  const until = Date.now() + relay.waitMs;
  let view: RelayView;
  let thrown = 0;
  for (;;) {
    // The object restarting (a deploy, an eviction) throws the call in flight; the relay is in SQLite, so ask again.
    let waited: Response;
    try { waited = await stub.gitRelay('wait', { relayId: relay.relayId, until }); thrown = 0; }
    catch (error) {
      console.error(JSON.stringify({ event: 'git_wait_thrown', attempt: thrown + 1, message: error instanceof Error ? error.message.slice(0, 200) : '' }));
      if (++thrown >= 5 || Date.now() >= until) { view = { state: 'failed', message: 'Smith lost track of this request while it restarted; try again' } as RelayView; break; }
      await new Promise(resolve => setTimeout(resolve, 500 * thrown));
      continue;
    }
    // An error from the object is an answer too: asking again at once would spin until the subrequest limit and end as a bare 500.
    if (!waited.ok) {
      const error = (await waited.json().catch(() => ({}))) as { error?: { message?: string } };
      const message = `Smith could not follow this request (${error.error?.message || 'status ' + waited.status}); try again`;
      console.error(JSON.stringify({ event: 'git_wait_failed', status: waited.status, message: error.error?.message ?? '' }));
      try { await abort(message); } catch { /* the relay may be gone */ }
      view = { state: 'failed', message } as RelayView; break;
    }
    view = await waited.json() as RelayView;
    if (view.state === 'completed' || view.state === 'delivered' || view.state === 'failed') break;
    if (Date.now() >= until) { await abort(relay.writer ? 'push outcome unknown; run git fetch and push again' : 'The machine did not answer in time'); view = { ...view, state: 'failed', message: relay.writer ? 'push outcome unknown; run git fetch and push again' : 'No machine answered this request in time' }; break; }
  }
  const cleanup = async () => {
    try { await stub.gitRelay('delivered', { relayId: relay.relayId }); } catch { /* best effort */ }
    try { if (op === 'rpc') await env.GIT.delete(reqKey); if (view.resKey) await env.GIT.delete(view.resKey); } catch { /* lifecycle rule cleans up */ }
  };
  if (view.state === 'failed') {
    ctx.waitUntil(cleanup());
    const message = view.message || 'The request failed';
    return op === 'info-refs' ? refusal(op, service, 503, 'relay_failed', message) : text(relay.writer && /outcome unknown/.test(message) ? 504 : 503, message);
  }
  const object = view.resKey ? await env.GIT.get(view.resKey) : null;
  if (!object && (view.size ?? 0) > 0) { ctx.waitUntil(cleanup()); return text(502, 'The machine’s answer was lost; try again'); }
  ctx.waitUntil(cleanup());
  const contentType = op === 'info-refs' ? `application/x-git-${service}-advertisement` : `application/x-git-${service}-result`;
  return new Response(object?.body ?? null, { status: view.status ?? 200, headers: { 'Content-Type': view.status && view.status >= 400 ? 'text/plain; charset=utf-8' : contentType, ...NO_CACHE } });
}

// Reads up to `limit` bytes of a request body. A body within the limit comes back whole (`bytes`) with a request that
// still carries it; a longer one comes back as `bytes: null` with a request whose stream replays what was read first.
async function peekBody(request: Request, limit: number): Promise<{ bytes: Uint8Array | null; request: Request }> {
  if (!request.body) return { bytes: new Uint8Array(0), request };
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let total = 0; let done = false;
  while (total <= limit) {
    const next = await reader.read();
    if (next.done) { done = true; break; }
    chunks.push(next.value); total += next.value.byteLength;
  }
  const head = new Uint8Array(total); let at = 0; for (const chunk of chunks) { head.set(chunk, at); at += chunk.byteLength; }
  if (done) return { bytes: head, request: new Request(request, { body: head }) };
  const rest = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(head); },
    async pull(controller) { const next = await reader.read(); if (next.done) controller.close(); else controller.enqueue(next.value); },
    cancel(reason) { return reader.cancel(reason); },
  });
  return { bytes: null, request: new Request(request, { body: rest }) };
}

// ---- the machine's side: body download, response parts and completion ----

const NODE_RELAY = /^\/api\/v2\/workspaces\/([a-f0-9]{64})\/git\/relay\/([a-f0-9-]{36})\/(body|response|complete)$/;
function bearer(request: Request): string { const h = request.headers.get('Authorization') ?? ''; return h.startsWith('Bearer ') && h.length < 512 ? h.slice(7) : ''; }

// Handles the three raw relay routes a machine calls; null for any other path. Matched before the JSON body reader.
export async function handleNodeRelay(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const match = NODE_RELAY.exec(url.pathname);
  if (!match) return null;
  const [, workspaceId, relayId, step] = match;
  const token = bearer(request);
  const leaseHeader = request.headers.get('X-Smith-Lease-Token') ?? '';
  const routed = routedLeaseToken(leaseHeader);
  const leaseToken = routed?.token ?? leaseHeader;
  const act = (action: string, body: Record<string, unknown>) => linkedNodeAction(env, workspaceId, token, action, { ...body, relayId, leaseToken: routed ? leaseHeader : leaseToken });
  try {
    if (step === 'body') {
      if (request.method !== 'GET') fail(405, 'method', 'GET the body');
      const granted = await act('git-relay-body', {});
      if (!granted.ok) return granted;
      const { reqKey, size } = await granted.json() as { reqKey: string; size: number };
      const object = await env.GIT.get(reqKey);
      if (!object) fail(503, 'body_unavailable', 'The request body is no longer available');
      return new Response(object.body, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size), 'Cache-Control': 'private, no-store' } });
    }
    if (step === 'response') {
      if (request.method !== 'POST') fail(405, 'method', 'POST a part');
      const part = Number(url.searchParams.get('part') ?? '0');
      if (!Number.isSafeInteger(part) || part < 1) fail(400, 'invalid_part', 'part must be 1 or more');
      const length = Number(request.headers.get('Content-Length') ?? 'x');
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_PART_BODY) fail(413, 'part_too_large', 'Parts are at most 5 MiB');
      const granted = await act('git-relay-response', { part });
      if (!granted.ok) return granted;
      const grant = await granted.json() as { resKey: string; uploadId: string | null };
      let { uploadId } = grant;
      const key = grant.resKey || `relay/${workspaceId}/${relayId}/res`;
      if (!uploadId) {
        const upload = await env.GIT.createMultipartUpload(key);
        const recorded = await act('git-relay-upload', { uploadId: upload.uploadId, resKey: key });
        if (!recorded.ok) { try { await upload.abort(); } catch { /* lifecycle */ } return recorded; }
        uploadId = upload.uploadId;
      }
      const bytes = await readExact(request, length);
      const uploaded = await env.GIT.resumeMultipartUpload(key, uploadId).uploadPart(part, bytes);
      const noted = await act('git-relay-part', { part, etag: uploaded.etag, size: bytes.byteLength });
      if (!noted.ok) return noted;
      return json({ accepted: true, part, size: bytes.byteLength });
    }
    // complete: finish the multipart upload, check the size, then record the completion (tips, status) in the Durable Object.
    if (request.method !== 'POST') fail(405, 'method', 'POST the completion');
    const body = await readBody(request, 1024 * 1024);
    const finish = await act('git-relay-finish', {});
    if (!finish.ok) return finish;
    const view = await finish.json() as RelayView;
    const declared = Number(body.size ?? -1);
    let stored = 0;
    if (view.uploadId && view.resKey && view.parts.length) {
      const upload = env.GIT.resumeMultipartUpload(view.resKey, view.uploadId);
      try { await upload.complete(view.parts.map(p => ({ partNumber: p.part, etag: p.etag }))); }
      catch { /* a replayed completion already finished it */ }
      stored = (await env.GIT.head(view.resKey))?.size ?? -1;
    } else if (declared === 0) {
      const key = view.resKey ?? `relay/${workspaceId}/${relayId}/res`;
      await env.GIT.put(key, new Uint8Array(0));
      if (!view.resKey) await act('git-relay-upload', { uploadId: 'empty', resKey: key });
    } else fail(409, 'no_parts', 'Upload the response parts before completing');
    if (declared !== stored) fail(400, 'size_mismatch', `Stored ${stored} bytes but the completion declares ${declared}`);
    return await act('git-relay-complete', body);
  } catch (error) {
    if (error instanceof HttpError) return json({ error: { code: error.code, message: error.message } }, error.status);
    console.error(JSON.stringify({ event: 'git_relay_failed', type: error instanceof Error ? error.name : 'unknown' }));
    return json({ error: { code: 'internal_error', message: 'Request failed' } }, 500);
  }
}
async function readExact(request: Request, length: number): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const bytes = new Uint8Array(length); let offset = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      if (offset + next.value.byteLength > length) { await reader.cancel(); fail(413, 'part_too_large', 'Part exceeds its declared size'); }
      bytes.set(next.value, offset); offset += next.value.byteLength;
    }
  } finally { reader.releaseLock(); }
  if (offset !== length) fail(400, 'size_mismatch', 'Part does not match its declared size');
  return bytes;
}
