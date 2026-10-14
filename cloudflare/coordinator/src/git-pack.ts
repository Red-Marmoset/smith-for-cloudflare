// Just enough git to make a first commit without a git client: object IDs, trees, a commit, a version 2 packfile
// streamed object by object (zlib through the runtime's CompressionStream), and a smart-HTTP receive-pack (protocol v1)
// push of that pack to an empty repository. Cloudflare Artifacts has no write API besides a push
// (developers.cloudflare.com/artifacts/api/git-protocol), so this is how a project starts there with no machine online.

const encoder = new TextEncoder();
export type Sha = string;   // 40 lower-case hex digits
export interface Sha1 { update(bytes: Uint8Array): void; digest(): Promise<Uint8Array> }
// SHA-1 over a stream of chunks: the Workers runtime's DigestStream (no copy of the pack is kept).
export function workerSha1(): Sha1 {
  const stream = new (crypto as unknown as { DigestStream: new (algorithm: string) => WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> } }).DigestStream('SHA-1');
  const writer = stream.getWriter();
  return { update: bytes => { void writer.write(bytes); }, digest: async () => { await writer.close(); return new Uint8Array(await stream.digest); } };
}
export const hex = (bytes: Uint8Array): string => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
export async function objectId(type: 'blob' | 'tree' | 'commit', body: Uint8Array): Promise<Sha> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-1', concat([encoder.encode(`${type} ${body.length}\0`), body]))));
}

// Trees for a set of files ('a/b.txt' -> blob ID): one per directory, children sorted as git sorts them (a directory
// compares as its name plus '/'). Returns the root tree's ID and every tree, children before parents.
export async function buildTrees(files: Map<string, Sha>): Promise<{ root: Sha; trees: { id: Sha; body: Uint8Array }[] }> {
  interface Dir { files: Map<string, Sha>; dirs: Map<string, Dir> }
  const top: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, id] of files) {
    const parts = path.split('/'); let dir = top;
    for (const part of parts.slice(0, -1)) { let next = dir.dirs.get(part); if (!next) { next = { files: new Map(), dirs: new Map() }; dir.dirs.set(part, next); } dir = next; }
    dir.files.set(parts.at(-1)!, id);
  }
  const trees: { id: Sha; body: Uint8Array }[] = [];
  const write = async (dir: Dir): Promise<Sha> => {
    const entries: { key: string; mode: string; name: string; id: Sha }[] = [];
    for (const [name, child] of dir.dirs) entries.push({ key: name + '/', mode: '40000', name, id: await write(child) });
    for (const [name, id] of dir.files) entries.push({ key: name, mode: '100644', name, id });
    entries.sort((a, b) => compareBytes(encoder.encode(a.key), encoder.encode(b.key)));
    const body = concat(entries.flatMap(e => [encoder.encode(`${e.mode} ${e.name}\0`), Uint8Array.from(e.id.match(/../g)!.map(h => parseInt(h, 16)))]));
    const id = await objectId('tree', body); trees.push({ id, body }); return id;
  };
  return { root: await write(top), trees };
}
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
export function commitBody(tree: Sha, message: string, when: Date, author = 'Smith <smith@noreply.invalid>'): Uint8Array {
  const stamp = `${Math.floor(when.getTime() / 1000)} +0000`;
  return encoder.encode(`tree ${tree}\nauthor ${author} ${stamp}\ncommitter ${author} ${stamp}\n\n${message}\n`);
}

const TYPES = { commit: 1, tree: 2, blob: 3 } as const;
function objectHeader(type: keyof typeof TYPES, size: number): Uint8Array {
  const bytes: number[] = []; let byte = (TYPES[type] << 4) | (size & 15); size = Math.floor(size / 16);
  while (size > 0) { bytes.push(byte | 0x80); byte = size & 0x7f; size = Math.floor(size / 128); }
  bytes.push(byte); return Uint8Array.from(bytes);
}
async function deflate(body: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([body]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
}
export interface PackObject { type: 'blob' | 'tree' | 'commit'; body: Uint8Array }
// A version 2 packfile of `count` objects, produced one object at a time by `next` (null when done), as a stream.
export function packStream(count: number, next: () => Promise<PackObject | null>, sha1: Sha1 = workerSha1()): ReadableStream<Uint8Array> {
  let started = false, finished = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const emit = (bytes: Uint8Array) => { sha1.update(bytes); controller.enqueue(bytes); };
      if (!started) {
        started = true;
        const head = new Uint8Array(12); head.set(encoder.encode('PACK')); new DataView(head.buffer).setUint32(4, 2); new DataView(head.buffer).setUint32(8, count);
        emit(head); return;
      }
      if (finished) return;
      const object = await next();
      if (object) { emit(concat([objectHeader(object.type, object.body.length), await deflate(object.body)])); return; }
      finished = true; controller.enqueue(await sha1.digest()); controller.close();
    },
  });
}

// pkt-line framing.
export function pktLine(text: string | Uint8Array): Uint8Array {
  const body = typeof text === 'string' ? encoder.encode(text) : text;
  return concat([encoder.encode((body.length + 4).toString(16).padStart(4, '0')), body]);
}
export function parsePktLines(bytes: Uint8Array): string[] {
  const lines: string[] = []; const decoder = new TextDecoder();
  for (let at = 0; at + 4 <= bytes.length;) {
    const length = parseInt(decoder.decode(bytes.subarray(at, at + 4)), 16);
    if (Number.isNaN(length)) break;
    if (length < 4) { at += 4; continue; }
    lines.push(decoder.decode(bytes.subarray(at + 4, at + length)).replace(/\n$/, '')); at += length;
  }
  return lines;
}

export class PushError extends Error {}
const ZERO = '0'.repeat(40);
// Pushes `pack` (containing `commit` and everything it needs) as the new branch `ref` of an empty repository at
// `remote` (smart HTTP, Basic auth with `secret` as the password). Throws PushError with what the server said.
export async function pushNewBranch(remote: string, secret: string, ref: string, commit: Sha, pack: ReadableStream<Uint8Array>, fetcher: typeof fetch = fetch): Promise<void> {
  const auth = 'Basic ' + btoa(`x:${secret}`);
  const advert = await fetcher(`${remote}/info/refs?service=git-receive-pack`, { headers: { Authorization: auth } });
  if (!advert.ok) { await pack.cancel(); throw new PushError(`The repository refused the push (${advert.status})`); }
  const refs = parsePktLines(new Uint8Array(await advert.arrayBuffer())).filter(line => /^[0-9a-f]{40} /.test(line));
  const existing = refs.find(line => line.split(/[ \0]/)[1] === ref);
  if (existing && existing.slice(0, 40) !== ZERO) { await pack.cancel(); throw new PushError(`${ref} already exists in the repository`); }
  const command = pktLine(`${ZERO} ${commit} ${ref}\0report-status agent=smith\n`);
  const head = concat([command, encoder.encode('0000')]);
  const reader = pack.getReader();
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(head); },
    async pull(controller) { const next = await reader.read(); if (next.done) controller.close(); else controller.enqueue(next.value); },
    cancel(reason) { return reader.cancel(reason); },
  });
  // A streamed body: the pack is never held whole (`duplex` is what fetch requires for a stream outside Workers).
  const response = await fetcher(`${remote}/git-receive-pack`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/x-git-receive-pack-request', Accept: 'application/x-git-receive-pack-result' }, body, duplex: 'half' } as RequestInit);
  const result = parsePktLines(new Uint8Array(await response.arrayBuffer()));
  if (!response.ok) throw new PushError(`The repository refused the push (${response.status})`);
  const unpack = result.find(line => line.startsWith('unpack '));
  if (unpack && unpack !== 'unpack ok') throw new PushError(`The repository could not store the files (${unpack.slice(7)})`);
  const status = result.find(line => line.endsWith(` ${ref}`) || line.includes(` ${ref} `));
  if (!status || !status.startsWith('ok ')) throw new PushError(`The repository refused the first commit${status ? ` (${status})` : ''}`);
}
