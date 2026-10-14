import { fail, json, errorResponse, readBody, readText, hash, fields, string } from './http';
import { authenticateHuman as human, handleAuth } from './auth';
import { handleMcp } from './mcp';
import { uploadArtifact, downloadArtifact } from './artifacts';
import { secure, cspReport, CSP_REPORT_PATH } from './security';
import { nodeAction as linkedNodeAction, routedLeaseToken } from './linked-nodes';
import { packageOs, releaseManifest, updateOffer, PACKAGE_OSES } from './agent-update';
import { MAX_DELIVERY_BYTES } from './push-builds';
import { handleGit, handleNodeRelay } from './git-route';
import { handleLfs } from './lfs-route';
import { DEFAULT_IMPORT_THRESHOLD_BYTES } from './settings';
import { handleNodeLfsTask } from './lfs-task-route';
import { handleNodeTask } from './git-task-route';
import { handleJobBlob } from './job-blob-route';
import { handleProjectImport } from './project-import';
export { WorkspaceCoordinator } from './workspace';
const PACKAGE_LABELS: Record<string, string> = { windows: 'Windows', mac: 'macOS', linux: 'Linux' };
function bearer(request: Request): string {
  const authorization = request.headers.get('Authorization') ?? '';
  return authorization.startsWith('Bearer ') && authorization.length < 512 ? authorization.slice(7) : '';
}
// The signature covers bytes, so do not parse, normalize whitespace or strip a UTF-8 BOM here.
async function readCheckInWebhookBody(request: Request): Promise<string> {
  const limit = 256 * 1024;
  if (Number(request.headers.get('Content-Length')) > limit) { void request.body?.cancel().catch(() => {}); fail(413, 'body_too_large', 'Maximum webhook size is 256 KiB'); }
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'invalid_body', 'Webhook body required');
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let size = 0, raw = '';
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) { void reader.cancel().catch(() => {}); fail(413, 'body_too_large', 'Maximum webhook size is 256 KiB'); }
      try { raw += decoder.decode(next.value, { stream: true }); } catch { fail(400, 'invalid_body', 'Webhook must be valid UTF-8'); }
    }
    try { raw += decoder.decode(); } catch { fail(400, 'invalid_body', 'Webhook must be valid UTF-8'); }
    return raw;
  } finally { reader.releaseLock(); }
}
export default {
  // ctx is optional so tests may call fetch(request, env); cleanup then runs inline.
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const context: ExecutionContext = ctx ?? { waitUntil(promise: Promise<unknown>) { void promise.catch(() => undefined); }, passThroughOnException() { /* tests only */ }, props: {} } as ExecutionContext;
    return secure(await route(request, env, context), env.ORIGIN);
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    const url = new URL(request.url);
    // GitHub authenticates with the project-bound webhook secret inside the Durable Object.
    // This route deliberately precedes browser origin/session authentication and JSON parsing.
    const checkInWebhook = /^\/api\/v2\/workspaces\/([a-f0-9]{64})\/crew\/webhooks\/github\/([a-z0-9][a-z0-9-]{0,63})$/.exec(url.pathname);
    if (checkInWebhook) {
      if (request.method !== 'POST') fail(405, 'method', 'Use POST for GitHub webhooks');
      const signature = request.headers.get('X-Hub-Signature-256') ?? '';
      if (!/^sha256=[a-fA-F0-9]{64}$/.test(signature)) fail(401, 'webhook_signature', 'A SHA-256 webhook signature is required');
      const delivery = request.headers.get('X-GitHub-Delivery') ?? '', event = request.headers.get('X-GitHub-Event') ?? '';
      if (!/^[A-Za-z0-9-]{1,128}$/.test(delivery) || !/^[a-z_]{1,64}$/.test(event)) fail(400, 'webhook_headers', 'Valid GitHub event and delivery headers are required');
      const raw = await readCheckInWebhookBody(request);
      return await env.WORKSPACES.getByName(checkInWebhook[1]).checkInWebhook(checkInWebhook[2], event, delivery, signature, raw);
    }
    if (url.pathname === CSP_REPORT_PATH) return await cspReport(request);
    if (request.method === 'GET' && url.pathname === '/health') return json({ service: 'smith', runtime: 'cloudflare-workers', protocolVersion: 2, stage: 'hosted-builds', deployment: env.DEPLOYMENT.id, version: env.RELEASE_VERSION, sourceCommit: env.RELEASE_SHA });
    if (url.pathname === '/mcp') return await handleMcp(request, env);
    const auth = await handleAuth(request, env); if (auth) return auth;
    // Smith-hosted repositories: git clients (Basic auth with a Smith token) ahead of the asset fall-through, the
    // Origin check and the JSON body reader, none of which apply to git.
    // Large files: <project>.git/info/lfs/... is the Git LFS API (lfs-route.ts), on git's credentials.
    const lfs = await handleLfs(request, env, ctx); if (lfs) return lfs;
    const git = await handleGit(request, env, ctx); if (git) return git;
    // Agent packages, one per OS, served from private R2 to signed-in people only. A
    // package that has not been uploaded yet is "coming soon" (503), never a 404 that
    // looks like a typo - the dashboard labels those from /api/v2/downloads.
    const download = /^\/downloads\/smith-experiment-(windows|mac|linux)\.zip$/.exec(url.pathname);
    if (download && request.method === 'GET') {
      await human(request, env);
      const name = `smith-experiment-${download[1]}.zip`;
      const release = await env.RELEASES.get(name);
      if (!release) fail(503, 'release_unavailable', `The ${PACKAGE_LABELS[download[1]]} agent package is not available yet`);
      return new Response(release.body, { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'private, no-store', 'ETag': release.httpEtag, 'X-Content-Type-Options': 'nosniff' } });
    }
    if (request.method === 'GET' && !url.pathname.startsWith('/api/')) {
      return await env.ASSETS.fetch(request);   // security headers + CSP are added by secure()
    }
    // A GitHub push webhook (Build on push). GitHub sends no Origin and no cookie: the project's hook
    // secret, checked inside the workspace object against X-Hub-Signature-256, is the whole credential.
    const hook = /^\/api\/v2\/hooks\/github\/([a-f0-9]{64})\/([a-z0-9][a-z0-9-]{0,63})$/.exec(url.pathname);
    if (hook && request.method === 'POST') {
      const payload = await readText(request, MAX_DELIVERY_BYTES);
      return await env.WORKSPACES.getByName(hook[1]).execute({ kind: 'hook' }, 'push-delivery', { projectId: hook[2], event: request.headers.get('X-GitHub-Event') ?? '',
        deliveryId: request.headers.get('X-GitHub-Delivery') ?? '', signature: request.headers.get('X-Hub-Signature-256') ?? '', payload });
    }
    if (!url.pathname.startsWith('/api/v2/')) fail(404, 'not_found', 'Route not found');
    // A machine's side of a large-file task (a restore PUTs the object), authorised by the Durable Object per lease.
    const lfsTask = await handleNodeLfsTask(request, env); if (lfsTask) return lfsTask;
    if (!['GET', 'POST'].includes(request.method)) fail(405, 'method', 'Method not supported');
    if (request.headers.has('Origin') && request.headers.get('Origin') !== env.ORIGIN) fail(403, 'origin', 'Origin not permitted');
    if (url.pathname === '/api/v2/downloads' && request.method === 'GET') {
      await human(request, env);
      const packages: Record<string, { available: boolean; path: string; version: string | null }> = {};
      for (const os of PACKAGE_OSES) {
        const name = `smith-experiment-${os}.zip`;
        packages[os] = { available: (await env.RELEASES.head(name)) !== null, path: `/downloads/${name}`, version: (await releaseManifest(env, os))?.version ?? null };
      }
      return json({ packages });
    }
    // A machine's side of a git relay: raw bodies and multipart parts, authorised by the Durable Object per lease.
    const relay = await handleNodeRelay(request, env); if (relay) return relay;
    const task = await handleNodeTask(request, env); if (task) return task;
    const jobBlob = await handleJobBlob(request, env); if (jobBlob) return jobBlob;
    // A project started from a zip: the browser's upload and the machine's download are raw bytes, not JSON.
    const imported = await handleProjectImport(request, env); if (imported) return imported;
    const upload = /^\/api\/v2\/workspaces\/([a-f0-9]{64})\/artifacts$/.exec(url.pathname);
    if (upload && request.method === 'POST') {
      // An artifact of a build another of the owner's workspaces handed out goes to that workspace (linked-nodes.ts).
      const routed = routedLeaseToken(request.headers.get('X-Smith-Lease-Token'));
      return await uploadArtifact(request, env, routed?.workspaceId ?? upload[1], {kind:'node',token:bearer(request)}, routed?.token);
    }
    // Scan reports (a repository's smith.json and file list) ride on a node's /complete and /resolve.
    const large = request.method === 'POST' && /^\/api\/v2\/workspaces\/[a-f0-9]{64}\/(?:complete|resolve|git\/tips)$/.test(url.pathname);
    // A setup task's output report holds up to 64 lines of 4,000 characters.
    const setupEvents = request.method === 'POST' && /^\/api\/v2\/workspaces\/[a-f0-9]{64}\/ai\/setup\/events$/.test(url.pathname);
    const body = request.method === 'POST' ? await readBody(request, large ? (url.pathname.endsWith('/complete') ? 11 : 2) * 1024 * 1024 : setupEvents ? 1024 * 1024 : undefined) : {};
    if (url.pathname === '/api/v2/workspaces' && request.method === 'GET') {
      const principal = await human(request, env);
      await joinStudioWorkspaces(env, principal);
      const directory = await env.DB.prepare('SELECT workspace_id FROM workspace_directory WHERE user_id = ? ORDER BY workspace_id LIMIT 20').bind(principal.userId).all<{ workspace_id: string }>();
      const workspaces = [];
      for (const row of directory.results) {
        const response = await env.WORKSPACES.getByName(row.workspace_id).execute(principal, 'summary', {});
        if (response.ok) workspaces.push(await response.json());
      }
      return json({ workspaces });
    }
    if (url.pathname === '/api/v2/workspaces' && request.method === 'POST') {
      const principal = await human(request, env); fields(body, ['requestId']);
      const workspaceId = await hash(principal.userId + ':' + string(body, 'requestId'));
      // New workspaces are numbered: the lowest "Workspace N" none of yours is called (rename it in the dashboard).
      const taken = new Set((await env.DB.prepare('SELECT name FROM workspace_directory WHERE user_id = ?').bind(principal.userId).all<{ name: string }>()).results.map(row => row.name));
      let number = 1; while (taken.has(`Workspace ${number}`)) number++;
      // Reserve capacity atomically; retain reservations so interrupted initialization can be retried.
      await env.DB.prepare('INSERT OR IGNORE INTO workspace_directory (workspace_id, user_id, name) SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM workspace_directory WHERE user_id = ?) < 20').bind(workspaceId, principal.userId, `Workspace ${number}`, principal.userId).run();
      const reserved = await env.DB.prepare('SELECT name FROM workspace_directory WHERE workspace_id = ? AND user_id = ?').bind(workspaceId, principal.userId).first<{ name: string }>();
      if (!reserved) fail(429, 'workspace_quota', 'Experiment workspace quota reached');
      const initialized = await env.WORKSPACES.getByName(workspaceId).initialize(workspaceId, principal.userId, reserved.name);
      // Read the Durable Object's reply before awaiting D1: under workerd its body stream does
      // not survive the extra round trip, and the dashboard needs the new workspace ID.
      const result = json(await initialized.json(), initialized.status);
      if (result.ok) await env.DB.batch([
        env.DB.prepare('INSERT OR IGNORE INTO workspaces VALUES (?, ?)').bind(workspaceId, Date.now()),
        env.DB.prepare('INSERT OR IGNORE INTO workspace_directory VALUES (?, ?, ?)').bind(workspaceId, principal.userId, reserved.name),
      ]);
      return result;
    }
    const match = /^\/api\/v2\/workspaces\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (!match) fail(404, 'not_found', 'Route not found');
    const [, workspaceId, path] = match;
    // An agent fetching the package it was offered: the node token decides which OS's zip it gets.
    if (path === 'agent-package' && request.method === 'GET') {
      if (!/^[a-f0-9]{64}$/.test(workspaceId)) fail(404, 'not_found', 'Workspace not found');
      const node = await env.WORKSPACES.getByName(workspaceId).execute({ kind: 'node', token: bearer(request) }, 'agent-package', {});
      if (!node.ok) return node;
      const os = packageOs((await node.json<{ os?: string }>()).os);
      const release = os ? await env.RELEASES.get(`smith-experiment-${os}.zip`) : null;
      if (!release) fail(404, 'release_unavailable', 'No agent package is published for this OS');
      return new Response(release.body, { headers: { 'Content-Type': 'application/zip', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    const nodeActions: Record<string, string> = { claims: 'claim', renew: 'renew', complete: 'complete', resolve: 'resolve', logs: 'logs', heartbeat: 'heartbeat', 'ai/claims': 'ai-claim', 'ai/events': 'ai-events', 'ai/finish': 'ai-finish', 'ai/setup/events': 'ai-setup-events', 'git/poll': 'git-poll', 'git/tips': 'git-tips' };
    const enrolling = path === 'nodes/enroll' && request.method === 'POST';
    const nodeAction = request.method === 'POST' ? nodeActions[path] : undefined;
    const principal = enrolling ? { kind: 'enrollment' as const } : nodeAction ? { kind: 'node' as const, token: bearer(request) } : await human(request, env);
    if (!/^[a-f0-9]{64}$/.test(workspaceId)) fail(404, 'not_found', 'Workspace not found');
    // Node identity and leases are authoritative in the DO; D1 outages must not interrupt active work.
    if (!nodeAction && !await env.DB.prepare('SELECT id FROM workspaces WHERE id = ?').bind(workspaceId).first()) fail(404, 'not_found', 'Workspace not found');
    const stub = env.WORKSPACES.getByName(workspaceId);
    const artifact = /^jobs\/([a-f0-9-]{36})\/artifacts\/([A-Za-z0-9_-][A-Za-z0-9_.-]{0,127})$/.exec(path);
    if (artifact && request.method === 'GET') return await downloadArtifact(request, env, workspaceId, principal, artifact[1], artifact[2]);
    if (enrolling) return await stub.execute(principal, 'enroll', body);
    // A machine serves all of its owner's workspaces, not only this one (linked-nodes.ts).
    if (nodeAction === 'heartbeat') {
      // The heartbeat reply also tells an agent on another version about the published package.
      const response = await linkedNodeAction(env, workspaceId, bearer(request), nodeAction, body);
      const os = packageOs(body.os);
      if (!response.ok || !os) return response;
      const offer = updateOffer(await releaseManifest(env, os), body.agentVersion, body.arch);
      if (!offer) return response;
      return json({ ...await response.json<Record<string, unknown>>(), update: offer }, response.status);
    }
    if (nodeAction) return await linkedNodeAction(env, workspaceId, bearer(request), nodeAction, body);
    if (path === 'jobs') return await stub.execute(principal, request.method === 'GET' ? 'list' : 'enqueue', body);
    // A project from a Git URL (source 'git'), or started in Smith as an empty repository (source 'empty'); a zip
    // goes to projects/import, so an upload's R2 key never comes from a caller.
    if (path === 'projects' && request.method === 'POST' && (body.source === 'empty' || body.source === 'zip')) {
      if (body.source === 'zip' || body.upload !== undefined) fail(400, 'invalid_source', 'Upload a zip to projects/import');
      return await stub.execute(principal, 'add-smith-project', body);
    }
    if (path === 'projects') return await stub.execute(principal, request.method === 'GET' ? 'projects' : body.source !== undefined ? 'add-repo-project' : 'put-project', body);
    if (path === 'github/repos' && request.method === 'GET') return await stub.execute(principal, 'github-repos', {});
    if (path === 'github/branches' && request.method === 'GET') return await stub.execute(principal, 'github-branches', { repo: url.searchParams.get('repo') ?? '' });
    // Import from GitHub: the organisations a person can see, and one organisation's repositories with the large-file preflight.
    if (path === 'imports') { if (request.method !== 'GET' && request.method !== 'POST') fail(405, 'method', 'GET lists imports; POST starts one'); return await stub.execute(principal, request.method === 'GET' ? 'imports' : 'import-start', body); }
    const importOne = /^imports\/([a-f0-9-]{36})(?:\/(retry|cancel))?$/.exec(path);
    if (importOne && request.method === 'GET' && !importOne[2]) return await stub.execute(principal, 'import-get', { importId: importOne[1] });
    if (importOne && request.method === 'POST' && importOne[2]) { fields(body, importOne[2] === 'retry' ? ['fullName'] : []); return await stub.execute(principal, `import-${importOne[2]}`, { ...body, importId: importOne[1] }); }
    if (path === 'imports/github/orgs' && request.method === 'GET') return await stub.execute(principal, 'import-orgs', {});
    if (path === 'imports/github/repos' && request.method === 'GET') return await stub.execute(principal, 'import-repos', { org: url.searchParams.get('org') ?? '', thresholdBytes: Number(url.searchParams.get('threshold') ?? DEFAULT_IMPORT_THRESHOLD_BYTES) });
    const rescan = /^projects\/([a-z0-9][a-z0-9-]{0,63})\/rescan$/.exec(path);
    if (rescan && request.method === 'POST') { fields(body, []); return await stub.execute(principal, 'rescan-project', { projectId: rescan[1] }); }
    const push = /^projects\/([a-z0-9][a-z0-9-]{0,63})\/push$/.exec(path);
    if (push && request.method === 'POST') { fields(body, ['enabled']); return await stub.execute(principal, 'push-builds', { projectId: push[1], enabled: body.enabled }); }
    const pushChoose = /^projects\/([a-z0-9][a-z0-9-]{0,63})\/push-actions$/.exec(path);
    if (pushChoose && request.method === 'POST') { fields(body, ['actions']); return await stub.execute(principal, 'push-choose', { projectId: pushChoose[1], actions: body.actions }); }
    const replaceQueued = /^projects\/([a-z0-9][a-z0-9-]{0,63})\/replace-queued$/.exec(path);
    if (replaceQueued && request.method === 'POST') { fields(body, ['enabled']); return await stub.execute(principal, 'replace-queued', { projectId: replaceQueued[1], enabled: body.enabled }); }
    const editProject = /^projects\/([a-z0-9][a-z0-9-]{0,63})\/edit$/.exec(path);
    if (editProject && request.method === 'POST') { fields(body, ['name', 'branch', 'buildFrom']); return await stub.execute(principal, 'edit-project', { ...body, projectId: editProject[1] }); }
    const removeProject = /^projects\/([a-z0-9][a-z0-9-]{0,63})\/remove$/.exec(path);
    if (removeProject && request.method === 'POST') { fields(body, []); return await stub.execute(principal, 'remove-project', { projectId: removeProject[1] }); }
    if (path === 'settings') return await stub.execute(principal, request.method === 'GET' ? 'settings' : 'put-settings', body);
    if (path === 'members' && request.method === 'GET') return await withMemberNames(env, await stub.execute(principal, 'members', {}));
    const member = /^members\/([A-Za-z0-9_-]{1,100})(?:\/(remove|allow))?$/.exec(path);
    if (member && request.method === 'POST') {
      fields(body, member[2] ? [] : ['role']);
      return await stub.execute(principal, member[2] === 'remove' ? 'remove-member' : member[2] === 'allow' ? 'allow-member' : 'put-member', { ...body, userId: member[1] });
    }
    if (path === 'nodes' && request.method === 'GET') return await withGuestNames(env, await withUpdates(env, await stub.execute(principal, 'nodes', body)));
    const guestStop = /^nodes\/([a-f0-9-]{36})\/guest-chats\/([a-f0-9-]{36})\/stop$/.exec(path);
    if (guestStop && request.method === 'POST') { fields(body, []); return await stub.execute(principal, 'ai-guest-stop', { nodeId: guestStop[1], sessionId: guestStop[2] }); }
    const mirror = /^projects\/([a-z0-9][a-z0-9-]{0,63})\/mirror$/.exec(path);
    if (mirror && request.method === 'POST') { fields(body, ['requestId']); return await stub.execute(principal, 'mirror-project', { requestId: body.requestId, projectId: mirror[1] }); }
    // Smith-hosted repositories: start keeping copies of a project; what to clone it with.
    const host = /^projects\/([a-z0-9][a-z0-9-]{0,63})\/host$/.exec(path);
    if (host && request.method === 'POST') { fields(body, ['requestId']); return await stub.execute(principal, 'host-project', { requestId: body.requestId, projectId: host[1] }); }
    // Where a project lives (home.ts): a machines home moved into storage, a lost storage home restored from a machine's copy.
    const moveToStorage = /^projects\/([a-z0-9][a-z0-9-]{0,63})\/move-to-storage$/.exec(path);
    if (moveToStorage && request.method === 'POST') { fields(body, ['requestId']); return await stub.execute(principal, 'move-to-storage', { requestId: body.requestId, projectId: moveToStorage[1] }); }
    const restoreToStorage = /^projects\/([a-z0-9][a-z0-9-]{0,63})\/restore-to-storage$/.exec(path);
    if (restoreToStorage && request.method === 'POST') { fields(body, ['requestId']); return await stub.execute(principal, 'restore-to-storage', { requestId: body.requestId, projectId: restoreToStorage[1] }); }
    const cloneInfo = /^projects\/([a-z0-9][a-z0-9-]{0,63})\/clone-info$/.exec(path);
    if (cloneInfo && request.method === 'GET') return await stub.execute(principal, 'git-clone-info', { repo: cloneInfo[1] });
    // Recovery of Smith's copies (owner/admin): restore from the backups, accept a restore that is behind the record,
    // and decide about refs a copy held that the record never had.
    // A project's original-history bundle (an import's history before its rewrite), for owners and admins.
    const backupDownload = /^projects\/([a-z0-9][a-z0-9-]{0,63})\/backups\/([a-f0-9-]{36})$/.exec(path);
    if (backupDownload && request.method === 'GET') {
      const authorized = await stub.execute(principal, 'backup-download', { projectId: backupDownload[1], backupId: backupDownload[2] });
      if (!authorized.ok) return authorized;
      const record = await authorized.json() as { key: string; size: number; name: string };
      const object = await (env as { GIT?: R2Bucket }).GIT?.get(record.key);
      if (!object) fail(503, 'backup_unavailable', 'The bundle is no longer in storage');
      return new Response(object.body, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(record.size), 'Content-Disposition': `attachment; filename="${record.name}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    const restore = /^projects\/([a-z0-9][a-z0-9-]{0,63})\/restore$/.exec(path);
    if (restore && request.method === 'POST') { fields(body, []); return await stub.execute(principal, 'git-restore', { repoId: restore[1] }); }
    const accept = /^projects\/([a-z0-9][a-z0-9-]{0,63})\/accept-dataloss$/.exec(path);
    if (accept && request.method === 'POST') { fields(body, []); return await stub.execute(principal, 'git-accept-dataloss', { repoId: accept[1] }); }
    const recovered = /^projects\/([a-z0-9][a-z0-9-]{0,63})\/recovered$/.exec(path);
    if (recovered && request.method === 'POST') { fields(body, ['nodeId', 'ref', 'action']); return await stub.execute(principal, 'git-recovered', { repoId: recovered[1], nodeId: body.nodeId, ref: body.ref, action: body.action }); }
    // Smith's copy and the repository it is linked to (upstream.ts): Pull/Push, and link or detach (url '').
    const sync = /^projects\/([a-z0-9][a-z0-9-]{0,63})\/sync$/.exec(path);
    if (sync && request.method === 'POST') { fields(body, ['requestId', 'direction']); return await stub.execute(principal, 'sync-project', { requestId: body.requestId, direction: body.direction, projectId: sync[1] }); }
    const upstream = /^projects\/([a-z0-9][a-z0-9-]{0,63})\/upstream$/.exec(path);
    if (upstream && request.method === 'POST') { fields(body, ['url']); return await stub.execute(principal, 'link-project', { url: body.url, projectId: upstream[1] }); }
    if (path === 'enrollments' && request.method === 'POST') return await stub.execute(principal, 'enrollments', body);
    if (path === 'tokens') return await stub.execute(principal, request.method === 'GET' ? 'tokens' : 'token-create', body);
    const revokeToken = /^tokens\/([a-f0-9-]{36})\/revoke$/.exec(path);
    if (revokeToken && request.method === 'POST') { fields(body, []); return await stub.execute(principal, 'token-revoke', { tokenId: revokeToken[1] }); }
    if (path === 'ai/options' && request.method === 'GET') return await stub.execute(principal, 'ai-options', {});
    if (path === 'ai/sessions' && request.method === 'GET') {
      const q = url.searchParams.get('q'), limit = url.searchParams.get('limit');
      return await stub.execute(principal, 'ai-sessions', { archived: url.searchParams.get('archived') === '1', ...(q ? { q } : {}), ...(limit ? { limit: Number(limit) } : {}) });
    }
    if (path === 'ai/sessions') return await stub.execute(principal, 'ai-session-create', body);
    const session = /^ai\/sessions\/([a-f0-9-]{36})(?:\/(events|messages|stop|close|update|delete|approve|push))?$/.exec(path);
    if (session) {
      const [, sessionId, verb] = session;
      if (request.method === 'GET' && !verb) return await stub.execute(principal, 'ai-session', { sessionId });
      if (request.method === 'GET' && verb === 'events') return await stub.execute(principal, 'ai-session-events', { sessionId, after: Number(url.searchParams.get('after') ?? '-1') });
      if (request.method === 'POST' && verb === 'messages') return await stub.execute(principal, 'ai-session-message', { ...body, sessionId });
      if (request.method === 'POST' && (verb === 'stop' || verb === 'close' || verb === 'delete')) { fields(body, []); return await stub.execute(principal, `ai-session-${verb}`, { sessionId }); }
      if (request.method === 'POST' && verb === 'update') return await stub.execute(principal, 'ai-session-update', { ...body, sessionId });
      if (request.method === 'POST' && verb === 'approve') return await stub.execute(principal, 'ai-session-approve', { ...body, sessionId });
      if (request.method === 'POST' && verb === 'push') return await stub.execute(principal, 'ai-session-push', { ...body, sessionId });
    }
    if (path === 'ai/setup' && request.method === 'POST') return await stub.execute(principal, 'ai-setup-create', body);
    const setup = /^ai\/setup\/([a-f0-9-]{36})(?:\/(input|stop))?$/.exec(path);
    if (setup) {
      const [, setupId, verb] = setup;
      if (request.method === 'GET' && !verb) return await stub.execute(principal, 'ai-setup-get', { setupId });
      if (request.method === 'POST' && verb === 'input') return await stub.execute(principal, 'ai-setup-input', { ...body, setupId });
      if (request.method === 'POST' && verb === 'stop') { fields(body, []); return await stub.execute(principal, 'ai-setup-stop', { setupId }); }
    }
    // The crew: autonomous members that look after projects. The Durable Object owns every rule; these are its doors, and an
    // answer that mentions people (who made a member, who sent or decided something) gets their names from the identity database.
    if (path === 'crew') {
      if (request.method === 'GET') return await withUserNames(env, await stub.execute(principal, 'crew-list', {}));
      return await stub.execute(principal, 'crew-put', body);
    }
    if (path === 'crew/review' && request.method === 'GET') return await withUserNames(env, await stub.execute(principal, 'crew-review', {}));
    if (path === 'crew/checkins') {
      if (request.method === 'POST') return await stub.execute(principal, 'crew-checkin', body);
      const before = url.searchParams.get('before');
      return await stub.execute(principal, 'crew-checkins', before === null ? {} : { before: Number(before) });
    }
    const checkIn = /^crew\/checkins\/([a-f0-9-]{36})(?:\/(retry|dry-run))?$/.exec(path);
    if (checkIn) {
      if (request.method === 'GET' && !checkIn[2]) return await stub.execute(principal, 'crew-checkin-detail', { eventId: checkIn[1] });
      if (request.method === 'POST' && checkIn[2]) { fields(body, []); return await stub.execute(principal, `crew-checkin-${checkIn[2]}`, { eventId: checkIn[1] }); }
    }
    const finding = /^crew\/findings\/([a-f0-9-]{36})\/decide$/.exec(path);
    if (finding && request.method === 'POST') { fields(body, ['disposition']); return await stub.execute(principal, 'crew-finding-decide', { findingId: finding[1], disposition: body.disposition }); }
    const findingAction = /^crew\/findings\/([a-f0-9-]{36})\/action$/.exec(path);
    if (findingAction && request.method === 'POST') { fields(body, ['eventId','kind','requestId']); return await stub.execute(principal, 'crew-finding-action', { ...body, findingId: findingAction[1] }); }
    if (path === 'crew/messages') {
      if (request.method === 'POST') return await stub.execute(principal, 'crew-message', body);
      const after = url.searchParams.get('after');
      return await withSenderNames(env, await stub.execute(principal, 'crew-messages', after === null ? {} : { after: Number(after) }));
    }
    const crewMessage = /^crew\/messages\/(\d{1,15})\/delete$/.exec(path);
    if (crewMessage && request.method === 'POST') { fields(body, []); return await stub.execute(principal, 'crew-message-delete', { seq: Number(crewMessage[1]) }); }
    const crewProject = /^crew\/projects\/([a-z0-9][a-z0-9-]{0,63})\/delete$/.exec(path);
    if (crewProject && request.method === 'POST') { fields(body, []); return await stub.execute(principal, 'crew-project-delete', { projectId: crewProject[1] }); }
    const crewRun = /^crew\/runs\/([a-f0-9-]{36})(?:\/(events|stop))?$/.exec(path);
    if (crewRun) {
      const [, sessionId, verb] = crewRun;
      if (request.method === 'GET' && !verb) return await stub.execute(principal, 'crew-run-session', { sessionId });
      if (request.method === 'GET' && verb === 'events') return await stub.execute(principal, 'crew-run-events', { sessionId, after: Number(url.searchParams.get('after') ?? '-1') });
      if (request.method === 'POST' && verb === 'stop') { fields(body, []); return await stub.execute(principal, 'crew-run-stop', { sessionId }); }
    }
    const crewReview = /^crew\/review\/([a-f0-9-]{36})(?:\/(verify))?$/.exec(path);
    if (crewReview && request.method === 'POST') return await stub.execute(principal, crewReview[2] ? 'crew-verify' : 'crew-decide', { ...body, sessionId: crewReview[1] });
    // The member in the path is the one acted on, whatever the body says.
    const crewMember = /^crew\/([a-f0-9-]{36})\/(delete|enable|run|runs|prompt)$/.exec(path);
    if (crewMember) {
      const [, crewId, verb] = crewMember;
      if (request.method === 'GET' && verb === 'runs') return await withUserNames(env, await stub.execute(principal, 'crew-runs', { crewId }));
      if (request.method === 'GET' && verb === 'prompt') return await stub.execute(principal, 'crew-prompt', { crewId });
      if (request.method === 'POST' && verb === 'delete') { fields(body, []); return await stub.execute(principal, 'crew-delete', { crewId }); }
      if (request.method === 'POST' && (verb === 'enable' || verb === 'run')) return await stub.execute(principal, `crew-${verb}`, { ...body, crewId });
    }
    // Smith's own pull requests (pulls.ts): listed and read by every member, commented on by every member, opened, merged,
    // closed, published and refreshed by operators. A merge commit names the person who merged, from the identity database.
    if (path === 'pulls') {
      if (request.method === 'GET') return await withUserNames(env, await stub.execute(principal, 'pulls', url.searchParams.get('state') ? { state: url.searchParams.get('state') } : {}), PULL_PEOPLE);
      return await withUserNames(env, await stub.execute(principal, 'pull-open', body), PULL_PEOPLE);
    }
    const pull = /^pulls\/([a-f0-9-]{36})(?:\/(comment|merge|close|reopen|publish|refresh))?$/.exec(path);
    if (pull) {
      const [, pullId, verb] = pull;
      if (request.method === 'GET' && !verb) return await withUserNames(env, await stub.execute(principal, 'pull', { pullId }), PULL_PEOPLE);
      if (request.method === 'POST' && verb) {
        const { authorName: _name, authorEmail: _email, ...rest } = body;
        const author = verb === 'merge' && principal.kind === 'human' ? await userProfile(env, principal.userId) : {};
        return await withUserNames(env, await stub.execute(principal, `pull-${verb}`, { ...rest, ...author, pullId }), PULL_PEOPLE);
      }
    }
    const job = /^jobs\/([a-f0-9-]{36})$/.exec(path);
    if (job && request.method === 'GET') return await stub.execute(principal, 'get', { jobId: job[1] });
    const logs = /^jobs\/([a-f0-9-]{36})\/logs$/.exec(path);
    if (logs && request.method === 'GET') return await stub.execute(principal, 'read-logs', { jobId: logs[1], after: Number(url.searchParams.get('after') ?? '-1') });
    const cancel = /^jobs\/([a-f0-9-]{36})\/cancel$/.exec(path);
    if (cancel && request.method === 'POST') { fields(body, []); return await stub.execute(principal, 'cancel', { jobId: cancel[1] }); }
    const node = /^nodes\/([a-f0-9-]{36})\/revoke$/.exec(path);
    if (node && request.method === 'POST') { fields(body, []); return await stub.execute(principal, 'revoke', { nodeId: node[1] }); }
    const share = /^nodes\/([a-f0-9-]{36})\/share-models$/.exec(path);
    if (share && request.method === 'POST') { fields(body, ['share']); return await stub.execute(principal, 'ai-share', { nodeId: share[1], share: body.share }); }
    const crewNode = /^nodes\/([a-f0-9-]{36})\/crew$/.exec(path);
    if (crewNode && request.method === 'POST') { fields(body, ['run', 'whileBuilding']); return await stub.execute(principal, 'node-crew', { nodeId: crewNode[1], run: body.run, whileBuilding: body.whileBuilding }); }
    // Large files: the owner's request to check every object against R2.
    if (path === 'lfs/check' && request.method === 'POST') { fields(body, []); return await stub.execute(principal, 'check-lfs', {}); }
    // "Keep copies here" (repositories and large files alike) and the machine's budget.
    const hostNode = /^nodes\/([a-f0-9-]{36})\/host$/.exec(path);
    if (hostNode && request.method === 'POST') { fields(body, ['host', 'budgetBytes']); return await stub.execute(principal, 'node-host', { nodeId: hostNode[1], host: body.host, ...(body.budgetBytes !== undefined ? { budgetBytes: body.budgetBytes } : {}) }); }
    const nodeLabels = /^nodes\/([a-f0-9-]{36})\/labels$/.exec(path);
    if (nodeLabels && request.method === 'POST') { fields(body, ['labels']); return await stub.execute(principal, 'node-labels', { nodeId: nodeLabels[1], labels: body.labels }); }
    const drain = /^nodes\/([a-f0-9-]{36})\/drain$/.exec(path);
    if (drain && request.method === 'POST') { fields(body, ['draining']); return await stub.execute(principal, 'drain', {nodeId:drain[1],draining:body.draining}); }
    fail(404, 'not_found', 'Route not found');
  } catch (error) { return errorResponse(error); }
}

const PULL_PEOPLE = ['authorUserId', 'mergedBy', 'closedBy', 'userId'];
// A person's name and address for a merge commit they made; empty when the identity database has neither.
async function userProfile(env: Env, userId: string): Promise<{ authorName: string; authorEmail: string }> {
  try {
    const row = await env.DB.prepare('SELECT display_name, email FROM users WHERE id = ?').bind(userId).first<{ display_name: string; email: string }>();
    return { authorName: row?.display_name || row?.email?.split('@')[0] || '', authorEmail: row?.email ?? '' };
  } catch { return { authorName: '', authorEmail: '' }; }
}
// What a person's name reads as when the identity database has no better one: display name, else email, else this.
const GENERIC_NAME = 'A workspace member';
async function userNames(env: Env, ids: string[]): Promise<Record<string, string>> {
  const names: Record<string, string> = {};
  for (let start = 0; start < ids.length; start += 50) {   // D1 binds at most 100 values to a statement
    const chunk = ids.slice(start, start + 50);
    try {
      const rows = await env.DB.prepare(`SELECT id, display_name, email FROM users WHERE id IN (${chunk.map(() => '?').join(', ')})`).bind(...chunk).all<{ id: string; display_name: string; email: string }>();
      for (const row of rows.results) names[row.id] = row.display_name || row.email;
    } catch { /* an identity database without profiles: names stay generic */ }
  }
  for (const id of ids) names[id] ||= GENERIC_NAME;
  return names;
}

// Adds `names` (user ID -> display name) for every person a Durable Object answer mentions: a string at one of `keys`, on the
// answer itself or on the objects of an array it holds. Names come from the identity database, so IDs alone never reach a screen.
async function withUserNames(env: Env, response: Response, keys: string[] = ['createdBy', 'fromUserId', 'decidedBy']): Promise<Response> {
  if (!response.ok) return response;
  const body = await response.json() as Record<string, unknown>;
  const holders = [body, ...Object.values(body).flatMap(value => Array.isArray(value) ? value : [])];
  const ids = new Set<string>();
  for (const holder of holders) {
    if (!holder || typeof holder !== 'object') continue;
    for (const key of keys) { const id = (holder as Record<string, unknown>)[key]; if (typeof id === 'string') ids.add(id); }
  }
  return json({ ...body, names: await userNames(env, [...ids]) }, response.status);
}

// The crew's message feed names the people who wrote: each message's `from.userId` gets their name, from the same identity
// lookup as withUserNames (the ID sits one level down, on `from`), and `names` maps them for the dashboard.
async function withSenderNames(env: Env, response: Response): Promise<Response> {
  if (!response.ok) return response;
  const body = await response.json() as { messages: { from: { userId?: string; name: string } }[] };
  const names = await userNames(env, [...new Set(body.messages.flatMap(m => m.from.userId ? [m.from.userId] : []))]);
  for (const message of body.messages) if (message.from.userId) message.from.name = names[message.from.userId];
  return json({ ...body, names }, response.status);
}

// Who is chatting on your machine with its shared models: names come from the identity database.
// Each machine's update state against the package published for its OS: `published` is that
// version (null when none is), `updateTo` set while the agent has yet to install it.
async function withUpdates(env: Env, response: Response): Promise<Response> {
  if (!response.ok) return response;
  const body = await response.json() as { nodes: { os?: string; arch?: string; agentVersion?: string; published?: string | null; updateTo?: string | null }[] };
  for (const node of body.nodes) {
    const os = packageOs(node.os); const manifest = os ? await releaseManifest(env, os) : null;
    node.published = manifest?.version ?? null;
    node.updateTo = updateOffer(manifest, node.agentVersion, node.arch)?.version ?? null;
  }
  return Response.json(body);
}
// Studio access (members.ts): someone whose last Google sign-in proved the allowed Workspace domain joins every
// workspace shared with the studio that they are not in yet. The workspace itself decides (setting, removals).
async function joinStudioWorkspaces(env: Env, principal: { kind: 'human'; userId: string }): Promise<void> {
  const domain = (env.GOOGLE_ALLOWED_DOMAIN ?? '').trim().toLowerCase();
  if (!domain) return;
  let pending: { workspace_id: string }[];
  try {
    const user = await env.DB.prepare('SELECT google_domain FROM users WHERE id = ?').bind(principal.userId).first<{ google_domain: string | null }>();
    if (user?.google_domain !== domain) return;
    pending = (await env.DB.prepare(`SELECT workspace_id FROM studio_workspaces WHERE workspace_id NOT IN (SELECT workspace_id FROM workspace_directory WHERE user_id = ?)
      ORDER BY workspace_id LIMIT 20`).bind(principal.userId).all<{ workspace_id: string }>()).results;
  } catch (error) { if (/no such (column|table)/.test(String(error))) return; throw error; }
  for (const { workspace_id: workspaceId } of pending) {
    const joined = await env.WORKSPACES.getByName(workspaceId).execute(principal, 'studio-join', {});
    if (!joined.ok) continue;   // turned off since, or this person was removed
    await env.DB.prepare('INSERT OR IGNORE INTO workspace_directory (workspace_id, user_id, name) SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM workspace_directory WHERE user_id = ?) < 20')
      .bind(workspaceId, principal.userId, 'Smith experiment', principal.userId).run();
  }
}
// Members are stored by user ID; the dashboard shows each person's display name or e-mail.
async function withMemberNames(env: Env, response: Response): Promise<Response> {
  if (!response.ok) return response;
  const body = await response.json() as { members: { userId: string; name?: string }[]; removed: { userId: string; name?: string }[] };
  const names = await userNames(env, [...new Set([...body.members, ...body.removed].map(m => m.userId))]);
  for (const person of [...body.members, ...body.removed]) person.name = names[person.userId];
  return Response.json(body);
}
async function withGuestNames(env: Env, response: Response): Promise<Response> {
  if (!response.ok) return response;
  const body = await response.json() as { nodes: { guestChats?: { userId: string; by?: string }[] }[] };
  const ids = [...new Set(body.nodes.flatMap(n => (n.guestChats ?? []).map(g => g.userId)))];
  if (!ids.length) return Response.json(body);
  const names = await userNames(env, ids);
  for (const node of body.nodes) for (const guest of node.guestChats ?? []) guest.by = names[guest.userId];
  return Response.json(body);
}
