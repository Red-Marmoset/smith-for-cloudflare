export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function fail(status: number, code: string, message: string): never { throw new HttpError(status, code, message); }
export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return json({ error: { code: error.code, message: error.message } }, error.status);
  // The message and the top of the stack, so Workers Logs says what failed (a bare type never did).
  console.error(JSON.stringify({ event: 'request_failed', type: error instanceof Error ? error.name : 'unknown', message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
    at: error instanceof Error ? (error.stack ?? '').split('\n').slice(1, 4).map(line => line.trim()).join(' | ').slice(0, 400) : '' }));
  return json({ error: { code: 'internal_error', message: 'Request failed' } }, 500);
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_body', 'Expected a JSON object');
  return value as Record<string, unknown>;
}
export function fields(body: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) fail(400, 'unsupported_field', `Unsupported field: ${key}`);
}
export function string(body: Record<string, unknown>, key: string, max = 128): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.length || value.length > max) fail(400, 'invalid_field', `Invalid field: ${key}`);
  return value;
}
export async function readBody(request: Request, maxBytes = 65536): Promise<Record<string, unknown>> {
  if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') fail(415, 'content_type', 'Use application/json');
  let value: unknown;
  try { value = JSON.parse(await readText(request, maxBytes)); }
  catch (error) { if (error instanceof HttpError) throw error; fail(400, 'invalid_json', 'Invalid JSON'); }
  return object(value);
}
// The body as UTF-8 text, at most maxBytes (a webhook signature covers the exact bytes, so it is read before any parsing).
export async function readText(request: Request, maxBytes: number): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'invalid_body', 'JSON body required');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) { await reader.cancel(); fail(413, 'body_too_large', `Maximum request size is ${Math.round(maxBytes / 1024)} KiB`); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const buffer = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buffer); }
  catch { fail(400, 'invalid_body', 'Body is not UTF-8'); }
}
export async function hash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
export function randomToken(): string { return crypto.randomUUID() + crypto.randomUUID(); }
