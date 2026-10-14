// SigV4 query-string presigning on WebCrypto, for R2's S3 endpoint (https://<account>.r2.cloudflarestorage.com/<bucket>/<key>).
// Presigning needs no call to R2: with the two R2 API-token secrets the coordinator hands git-lfs a URL and the bytes
// go straight to the bucket, so the Workers request-body limit no longer caps object size.
export interface SigV4Target { accessKeyId: string; secretAccessKey: string; region: string; host: string; path: string }
export interface R2Presigner { accountId: string; bucket: string; accessKeyId: string; secretAccessKey: string }

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
async function sha256Hex(text: string): Promise<string> { return hex(await crypto.subtle.digest('SHA-256', encoder.encode(text))); }
async function hmac(key: ArrayBuffer | Uint8Array, text: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, encoder.encode(text));
}
// RFC 3986 unreserved characters only; S3 wants each path segment encoded this way and '/' kept.
function encodeRfc3986(value: string): string { return encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()); }
function encodePath(path: string): string { return path.split('/').map(encodeRfc3986).join('/'); }

export async function presign(target: SigV4Target, method: 'GET' | 'PUT' | 'HEAD', expiresSeconds: number, now = new Date()): Promise<string> {
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${target.region}/s3/aws4_request`;
  const query: [string, string][] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'], ['X-Amz-Credential', `${target.accessKeyId}/${scope}`], ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresSeconds)], ['X-Amz-SignedHeaders', 'host'],
  ];
  const canonicalQuery = query.map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`).join('&');
  const canonicalRequest = [method, encodePath(target.path), canonicalQuery, `host:${target.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
  const kDate = await hmac(encoder.encode('AWS4' + target.secretAccessKey), date);
  const kRegion = await hmac(kDate, target.region);
  const kService = await hmac(kRegion, 's3');
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = hex(await hmac(kSigning, stringToSign));
  return `https://${target.host}${encodePath(target.path)}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export function presignConfig(env: Env): R2Presigner | null {
  const e = env as unknown as Record<string, string | undefined>;
  const accountId = (e.R2_ACCOUNT_ID ?? '').trim(), bucket = (e.GIT_BUCKET ?? '').trim(), accessKeyId = (e.R2_ACCESS_KEY_ID ?? '').trim(), secretAccessKey = (e.R2_SECRET_ACCESS_KEY ?? '').trim();
  return accountId && bucket && accessKeyId && secretAccessKey ? { accountId, bucket, accessKeyId, secretAccessKey } : null;
}
export function lfsMode(env: Env): 'direct' | 'proxy' { return presignConfig(env) ? 'direct' : 'proxy'; }
export function presignObject(config: R2Presigner, method: 'GET' | 'PUT' | 'HEAD', key: string, expiresSeconds: number, now = new Date()): Promise<string> {
  return presign({ accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, region: 'auto', host: `${config.accountId}.r2.cloudflarestorage.com`, path: `/${config.bucket}/${key}` }, method, expiresSeconds, now);
}
