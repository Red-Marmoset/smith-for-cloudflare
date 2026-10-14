import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { storeBody } from '../src/r2-store';
import { HttpError } from '../src/http';

const bucket = (env as unknown as { GIT: R2Bucket }).GIT;
async function sha256(bytes: Uint8Array) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join(''); }
function body(size: number, fill = 7) { const out = new Uint8Array(size); for (let i = 0; i < size; i++) out[i] = (fill + i) & 0xff; return out; }

describe('storeBody with a digest', () => {
  it('stores a small body and a multipart body whose hash matches', async () => {
    for (const size of [10, 6 * 1024 * 1024]) {
      const bytes = body(size); const key = 'test/' + crypto.randomUUID();
      const result = await storeBody(bucket, key, new Request('https://x/', { method: 'PUT', body: bytes }), 10 * 1024 * 1024, { sha256: await sha256(bytes) });
      expect(result).toEqual({ size, sha256: await sha256(bytes) });
      expect((await bucket.head(key))?.size).toBe(size);
    }
  });
  it('rejects a body whose hash does not match and leaves no object', async () => {
    for (const size of [10, 6 * 1024 * 1024]) {
      const key = 'test/' + crypto.randomUUID();
      await expect(storeBody(bucket, key, new Request('https://x/', { method: 'PUT', body: body(size) }), 10 * 1024 * 1024, { sha256: 'f'.repeat(64) })).rejects.toMatchObject({ status: 422, message: 'Uploaded data does not match the object id' });
      expect(await bucket.head(key)).toBeNull();
    }
  });
  it('hashes the inflated bytes of a gzipped body', async () => {
    const bytes = body(5000); const key = 'test/' + crypto.randomUUID();
    const gz = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    const result = await storeBody(bucket, key, new Request('https://x/', { method: 'PUT', body: gz, headers: { 'Content-Encoding': 'gzip' } }), 1 << 20, { sha256: await sha256(bytes) });
    expect(result.size).toBe(5000);
    expect(new Uint8Array(await (await bucket.get(key))!.arrayBuffer())).toEqual(bytes);
  });
  it('still caps the body', async () => {
    await expect(storeBody(bucket, 'test/' + crypto.randomUUID(), new Request('https://x/', { method: 'PUT', body: body(100) }), 50)).rejects.toBeInstanceOf(HttpError);
  });
});
