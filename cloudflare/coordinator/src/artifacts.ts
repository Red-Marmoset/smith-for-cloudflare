import { fail, json } from './http';
import type { Principal } from './contracts';
const MAX_BYTES = 20 * 1024 * 1024;
export async function uploadArtifact(request: Request, env: Env, workspaceId: string, principal: Principal, leaseToken?: string): Promise<Response> {
  if (request.headers.get('Content-Type') !== 'application/octet-stream') fail(415, 'content_type', 'Use application/octet-stream');
  const contentLength = request.headers.get('Content-Length');
  if (!contentLength || !/^[0-9]+$/.test(contentLength)) fail(411, 'length_required', 'Artifact Content-Length is required');
  const size = Number(contentLength);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_BYTES) fail(413, 'artifact_too_large', 'Artifacts must be 1 byte to 20 MiB');
  const metadata = {jobId:request.headers.get('X-Smith-Job-Id'),attemptId:request.headers.get('X-Smith-Attempt-Id'),leaseToken:leaseToken ?? request.headers.get('X-Smith-Lease-Token'),name:request.headers.get('X-Smith-Artifact-Name'),sha256:request.headers.get('X-Smith-SHA256'),size};
  const stub = env.WORKSPACES.getByName(workspaceId);
  const reservation = await stub.execute(principal, 'artifact-start', metadata);
  if (!reservation.ok) return reservation;
  const artifact = await reservation.json() as {object_key:string;sha256:string};
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'body_missing', 'Artifact bytes are required');
  const bytes = new Uint8Array(size); let offset = 0;
  try {
    for (;;) {
      const chunk=await reader.read();if(chunk.done)break;
      if(offset+chunk.value.byteLength>size){await reader.cancel();fail(413,'artifact_too_large','Upload exceeds declared size');}
      bytes.set(chunk.value,offset);offset+=chunk.value.byteLength;
    }
  } finally {reader.releaseLock();}
  if(offset!==size)fail(400,'size_mismatch','Upload does not match declared size');
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  if(digest!==artifact.sha256)fail(400,'digest_mismatch','Upload does not match declared SHA-256');
  // Immutable key reservation and checksum make a lost-response replay safe.
  await env.RELEASES.put(artifact.object_key,bytes,{sha256:digest,httpMetadata:{contentType:'application/octet-stream'}});
  const finalized=await stub.execute(principal,'artifact-finish',metadata);
  if(!finalized.ok)return finalized;
  return json({accepted:true,name:metadata.name,sha256:digest,size},201);
}
export async function downloadArtifact(request: Request, env: Env, workspaceId:string, principal:Principal, jobId:string,name:string):Promise<Response>{
  const authorized=await env.WORKSPACES.getByName(workspaceId).execute(principal,'artifact-read',{jobId,name});
  if(!authorized.ok)return authorized;
  const record=await authorized.json() as {object_key:string;name:string;sha256:string;size:number};
  const artifact=await env.RELEASES.get(record.object_key);
  if(!artifact)fail(503,'artifact_unavailable','Stored artifact is temporarily unavailable');
  return new Response(artifact.body,{headers:{'Content-Type':'application/octet-stream','Content-Length':String(record.size),'Content-Disposition':`attachment; filename="${record.name}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','X-Smith-SHA256':record.sha256}});
}
