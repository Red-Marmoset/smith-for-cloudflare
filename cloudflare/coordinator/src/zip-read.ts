// Reading a zip archive that sits in R2 without loading it whole: the central directory with two ranged reads, then
// each entry's bytes with one more (inflated with the runtime's DecompressionStream). Used to start a project in
// Smith from an uploaded zip (smith-projects.ts). Entry names are checked as the agent checks them (HostedGitInit.cpp):
// no absolute paths, no "..", no names Windows cannot hold; .git and __MACOSX are left out; one wrapping folder is dropped.

export interface ZipEntry { name: string; method: number; compressedSize: number; size: number; offset: number; directory: boolean }
export class ZipError extends Error {}
export type RangeRead = (offset: number, length: number) => Promise<Uint8Array>;

const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const decoder = new TextDecoder('utf-8');
const cp437 = new TextDecoder('latin1');   // close enough for names without the UTF-8 flag (ASCII in practice)

// The entries of a zip of `size` bytes, from its central directory.
export async function readZipDirectory(read: RangeRead, size: number): Promise<ZipEntry[]> {
  if (size < 22) throw new ZipError('That file is not a zip archive');
  const tailLength = Math.min(size, 65557);
  const tail = await read(size - tailLength, tailLength);
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new ZipError('That file is not a zip archive');
  const count = u16(tail, end + 10), dirSize = u32(tail, end + 12), dirOffset = u32(tail, end + 16);
  if (count === 0xffff || dirOffset === 0xffffffff) throw new ZipError('Zip64 archives are not supported; zip the project with a standard tool');
  if (dirOffset + dirSize > size) throw new ZipError('The zip archive is damaged');
  const dir = await read(dirOffset, dirSize);
  const entries: ZipEntry[] = [];
  for (let at = 0, n = 0; n < count; n++) {
    if (at + 46 > dir.length || u32(dir, at) !== 0x02014b50) throw new ZipError('The zip archive is damaged');
    const flags = u16(dir, at + 8), method = u16(dir, at + 10), compressedSize = u32(dir, at + 20), entrySize = u32(dir, at + 24);
    const nameLength = u16(dir, at + 28), extraLength = u16(dir, at + 30), commentLength = u16(dir, at + 32), offset = u32(dir, at + 42);
    const raw = dir.subarray(at + 46, at + 46 + nameLength);
    const name = (flags & 0x800 ? decoder : cp437).decode(raw);
    if (flags & 1) throw new ZipError('Encrypted zip archives are not supported');
    entries.push({ name, method, compressedSize, size: entrySize, offset, directory: name.endsWith('/') || name.endsWith('\\') });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// One entry's contents, inflated.
export async function readZipEntry(read: RangeRead, entry: ZipEntry): Promise<Uint8Array> {
  const header = await read(entry.offset, 30);
  if (u32(header, 0) !== 0x04034b50) throw new ZipError('The zip archive is damaged');
  const start = entry.offset + 30 + u16(header, 26) + u16(header, 28);
  const data = entry.compressedSize ? await read(start, entry.compressedSize) : new Uint8Array(0);
  if (entry.method === 0) return data;
  if (entry.method !== 8) throw new ZipError(`"${entry.name}" uses a compression method Smith cannot read`);
  const inflated = await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
  if (inflated.byteLength !== entry.size) throw new ZipError(`"${entry.name}" in the zip archive is damaged`);
  return new Uint8Array(inflated);
}

function parts(name: string): string[] { return name.replace(/\\/g, '/').split('/').filter(part => part && part !== '.'); }
function skipped(p: string[]): boolean { return !p.length || p[0] === '__MACOSX' || p.some(part => part.toLowerCase() === '.git'); }
const DEVICES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
function unportable(part: string): string {
  if (/[\x00-\x1f<>:"|?*]/.test(part)) return 'a character Windows cannot use in a file name';
  if (/[. ]$/.test(part)) return 'a name ending in a dot or space';
  if (DEVICES.test(part.split('.')[0])) return 'a name Windows reserves for a device';
  return '';
}
// The folder every entry sits in ("game/"), or '' when entries differ or a file sits at the top.
export function zipCommonRoot(names: string[]): string {
  let root: string | null = null;
  for (const name of names) {
    const p = parts(name);
    if (skipped(p)) continue;
    const directory = name.endsWith('/') || name.endsWith('\\');
    if (!directory && p.length < 2) return '';
    if (root === null) root = p[0]; else if (p[0] !== root) return '';
  }
  return root === null ? '' : root + '/';
}
// Where an entry goes ('' to leave it out); throws for a hostile or unportable name.
export function zipEntryPath(name: string, root: string): string {
  if (!name || name.endsWith('/') || name.endsWith('\\')) return '';
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) throw new ZipError(`The zip holds "${name.slice(0, 200)}", an absolute path`);
  let p = parts(normalized);
  if (p.includes('..')) throw new ZipError(`The zip holds "${name.slice(0, 200)}", a path that leaves the project folder`);
  if (skipped(p)) return '';
  const r = parts(root);
  if (r.length && p.length > r.length && r.every((part, i) => p[i] === part)) p = p.slice(r.length);
  for (const part of p) { const reason = unportable(part); if (reason) throw new ZipError(`The zip holds "${name.slice(0, 200)}", ${reason}`); }
  const path = p.join('/');
  if (path.length > 400) throw new ZipError(`The zip holds "${name.slice(0, 200)}", a path longer than 400 characters`);
  return path;
}
