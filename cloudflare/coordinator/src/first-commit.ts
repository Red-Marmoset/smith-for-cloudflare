// The first commit of a project started in Smith, made by the coordinator itself so it needs no machine: a README, or
// the files of an uploaded zip (its .gitignore honoured). Two passes over the zip: the first hashes every file (a push
// names its commit before the pack, so every ID must be known up front) and reads smith.json; the second streams the
// pack. Only one file is in memory at a time. Limits follow Cloudflare Artifacts: 32 MB per file, 1 GB in all.
import { readZipDirectory, readZipEntry, zipCommonRoot, zipEntryPath, ZipError, type RangeRead, type ZipEntry } from './zip-read';
import { addIgnoreFile, isIgnored, type IgnoreRules } from './gitignore';
import { objectId, buildTrees, commitBody, packStream, type PackObject, type Sha, type Sha1 } from './git-pack';

export const MAX_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
export const MAX_FILES = 100000;
// Too big for Artifacts: the caller may still create the project on a machine that keeps copies.
export class TooBigError extends Error {}

export interface FirstCommit { commit: Sha; count: number; smithJson: string | null; paths: string[]; pack(sha1?: Sha1): ReadableStream<Uint8Array> }
export interface FirstCommitSource { kind: 'empty' | 'zip'; name: string; archiveName?: string; read?: RangeRead; size?: number; now?: Date }

export function readme(name: string): string {
  return `# ${name}\n\nThis project lives in Smith. Clone it from the project card, add your files and a smith.json, and push:\nSmith reads smith.json after every push and offers its build actions.\n`;
}
export function commitMessage(kind: 'empty' | 'zip', name: string, archiveName = ''): string {
  return kind === 'zip' ? `Import ${name} from ${archiveName || 'a zip'}` : `Start ${name}`;
}

export async function prepareFirstCommit(source: FirstCommitSource): Promise<FirstCommit> {
  const files = new Map<string, Sha>();          // path -> blob ID
  const blobs = new Map<Sha, () => Promise<Uint8Array>>();   // unique blob -> how to read it again
  let smithJson: string | null = null;
  if (source.kind === 'empty') {
    const body = new TextEncoder().encode(readme(source.name));
    const id = await objectId('blob', body); files.set('README.md', id); blobs.set(id, async () => body);
  } else {
    if (!source.read || !source.size) throw new ZipError('Upload the zip first');
    const read = source.read;
    const entries = await readZipDirectory(read, source.size);
    if (entries.length > MAX_FILES) throw new ZipError(`The zip holds more than ${MAX_FILES} entries`);
    const root = zipCommonRoot(entries.map(e => e.name));
    const placed: { entry: ZipEntry; path: string }[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const path = zipEntryPath(entry.name, root);
      if (!path) continue;
      if (seen.has(path.toLowerCase())) throw new ZipError(`The zip holds "${path}" twice`);
      seen.add(path.toLowerCase()); placed.push({ entry, path });
    }
    // .gitignore files first, shallowest first, so a deeper one can re-include what a shallower one left out.
    const rules: IgnoreRules = { rules: [] };
    for (const { entry, path } of placed.filter(p => p.path === '.gitignore' || p.path.endsWith('/.gitignore')).sort((a, b) => a.path.split('/').length - b.path.split('/').length)) {
      addIgnoreFile(rules, path.slice(0, -'.gitignore'.length), new TextDecoder().decode(await readZipEntry(read, entry)));
    }
    const kept = placed.filter(p => !isIgnored(rules, p.path));
    if (!kept.length) throw new ZipError('The zip holds no files (or its .gitignore leaves none)');
    let total = 0;
    for (const { entry, path } of kept) {
      if (entry.size > MAX_FILE_BYTES) throw new TooBigError(`"${path}" is ${Math.ceil(entry.size / 1048576)} MB; Cloudflare Artifacts takes files up to 32 MB`);
      total += entry.size;
      if (total > MAX_TOTAL_BYTES) throw new TooBigError('The files come to more than 1 GB, the most Cloudflare Artifacts keeps in one repository');
    }
    for (const { entry, path } of kept) {
      const body = await readZipEntry(read, entry);
      const id = await objectId('blob', body);
      files.set(path, id);
      if (!blobs.has(id)) blobs.set(id, () => readZipEntry(read, entry));
      if (path === 'smith.json' && body.length <= 262144) smithJson = new TextDecoder().decode(body);
    }
  }
  const { root, trees } = await buildTrees(files);
  const body = commitBody(root, commitMessage(source.kind, source.name, source.archiveName), source.now ?? new Date());
  const commit = await objectId('commit', body);
  const count = blobs.size + trees.length + 1;
  return {
    commit, count, smithJson, paths: [...files.keys()].sort(),
    pack(sha1?: Sha1) {
      const queue: (() => Promise<PackObject>)[] = [
        ...[...blobs.values()].map(load => async () => ({ type: 'blob' as const, body: await load() })),
        ...trees.map(tree => async () => ({ type: 'tree' as const, body: tree.body })),
        async () => ({ type: 'commit' as const, body }),
      ];
      let at = 0;
      return packStream(count, async () => at < queue.length ? queue[at++]() : null, sha1);
    },
  };
}
