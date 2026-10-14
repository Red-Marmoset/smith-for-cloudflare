// Streams a request body into R2: one put below PART_SIZE, else equal multipart parts; gzip is inflated first and the
// cap applies to the inflated bytes. With `sha256`, the bytes are hashed in flight (crypto.DigestStream) and an
// object whose digest differs from it is deleted before the error reaches the caller.
import { fail } from './http';

export const PART_SIZE = 5 * 1024 * 1024;           // R2 multipart parts: all equal but the last, at least 5 MiB
export const MAX_PART_BODY = PART_SIZE + 1024;       // a machine's response part
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export function hex(bytes: ArrayBuffer): string { return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join(''); }

export async function storeBody(bucket: R2Bucket, key: string, request: Request, cap: number, options: { sha256?: string } = {}): Promise<{ size: number; sha256: string | null }> {
  let stream = request.body;
  if (!stream) {
    if (options.sha256 && options.sha256 !== EMPTY_SHA256) fail(422, 'hash_mismatch', 'Uploaded data does not match the object id');
    await bucket.put(key, new Uint8Array(0)); return { size: 0, sha256: options.sha256 ?? null };
  }
  const encoding = (request.headers.get('Content-Encoding') ?? '').toLowerCase();
  if (encoding === 'gzip' || encoding === 'x-gzip') stream = stream.pipeThrough(new DecompressionStream('gzip'));
  else if (encoding && encoding !== 'identity') fail(415, 'content_encoding', `Unsupported Content-Encoding ${encoding}`);
  const digest = options.sha256 ? new crypto.DigestStream('SHA-256') : null;
  const hasher = digest ? digest.getWriter() : null;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = []; let buffered = 0; let total = 0; let part = 0;
  let upload: R2MultipartUpload | null = null; const parts: R2UploadedPart[] = [];
  const flush = async (last: boolean) => {
    if (!upload) {
      if (last) { await bucket.put(key, concat(chunks, buffered)); return; }
      upload = await bucket.createMultipartUpload(key);
    }
    parts.push(await upload.uploadPart(++part, concat(chunks, buffered)));
    chunks.length = 0; buffered = 0;
  };
  try {
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try { next = await reader.read(); }
      catch { fail(400, 'bad_body', 'The request body was not valid ' + (encoding ? encoding : 'data')); }
      if (next.done) break;
      total += next.value.byteLength;
      if (total > cap) fail(413, 'too_large', `This request is larger than Smith accepts here (${Math.round(cap / 1048576)} MB)`);
      if (hasher) await hasher.write(next.value);
      chunks.push(next.value); buffered += next.value.byteLength;
      // Keep parts equal: emit exactly PART_SIZE bytes at a time.
      while (buffered >= PART_SIZE) {
        const whole = concat(chunks, buffered); chunks.length = 0; buffered = 0;
        const head = whole.subarray(0, PART_SIZE); const rest = whole.subarray(PART_SIZE);
        if (!upload) upload = await bucket.createMultipartUpload(key);
        parts.push(await upload.uploadPart(++part, head));
        if (rest.byteLength) { chunks.push(rest); buffered = rest.byteLength; }
      }
    }
    await flush(true);
    if (upload) await upload.complete(parts);
    let sha256: string | null = null;
    if (hasher && digest) {
      await hasher.close();
      sha256 = hex(await digest.digest);
      if (sha256 !== options.sha256) { try { await bucket.delete(key); } catch { /* best effort */ } fail(422, 'hash_mismatch', 'Uploaded data does not match the object id'); }
    }
    return { size: total, sha256 };
  } catch (error) {
    try { await reader.cancel(); } catch { /* already done */ }
    if (hasher) { try { await hasher.abort(); } catch { /* closed */ } }
    if (upload) { try { await upload.abort(); } catch { /* lifecycle rule aborts it */ } }
    throw error;
  }
}
function concat(chunks: Uint8Array[], size: number): Uint8Array {
  if (chunks.length === 1 && chunks[0].byteLength === size) return chunks[0];
  const out = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}
