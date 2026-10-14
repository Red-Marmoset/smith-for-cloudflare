import { githubRepo } from './github-reader';

export interface CheckInMetadata {
  changes: Array<{ path: string; oldPath: string | null; added: number | null; deleted: number | null }>;
  complete: boolean; ancestor: boolean; testState: 'unknown' | 'failed'; testSource?: { kind: 'smith-build'; jobId: string }; reason?: string;
}
const MAX_BYTES = 10 * 1024 * 1024;
const encoder = new TextEncoder();
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const validCommit = (value: string) => /^[a-f0-9]{40}$/.test(value) && !/^0+$/.test(value);
const validPath = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && encoder.encode(value).length <= 512 && !/[\u0000-\u001f\u007f\\:]/.test(value) && !value.startsWith('/')
  && !value.split('/').some(part => part === '' || part === '.' || part === '..');
const lineCount = (value: unknown): number | null => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body?.cancel(); throw new Error('metadata_size_limit'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('metadata_empty_response');
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let size = 0, text = '';
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error('metadata_size_limit'); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}

export async function readCheckInMetadata(repoUrl: string, baseCommit: string, headCommit: string, token: string): Promise<CheckInMetadata> {
  const incomplete = (reason: string, ancestor = false): CheckInMetadata => ({ changes: [], complete: false, ancestor, testState: 'unknown', reason });
  const target = githubRepo(repoUrl);
  if (!target || [target.owner, target.repo].some(part => part === '.' || part === '..') || !validCommit(baseCommit) || !validCommit(headCommit)) return incomplete('invalid_repository_or_commit');
  const signal = AbortSignal.timeout(60_000);
  try {
    const response = await fetch(`https://api.github.com/repos/${target.owner}/${target.repo}/compare/${baseCommit}...${headCommit}?per_page=1&page=1`, {
      redirect: 'manual', signal,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'smith-coordinator', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!response.ok) { await response.body?.cancel(); return incomplete(`github_http_${response.status}`); }
    const data = record(await boundedJson(response, signal));
    // Compare's three-dot file list is relative to the merge base, not necessarily baseCommit.
    // Requiring the merge base to equal our pinned base verifies ancestry and exact range semantics.
    const ancestor = record(data.base_commit).sha === baseCommit && record(data.merge_base_commit).sha === baseCommit
      && (data.status === 'ahead' || (data.status === 'identical' && baseCommit === headCommit));
    if (!ancestor) return incomplete('unverified_ancestor');
    if (!Array.isArray(data.files)) return incomplete('missing_file_list', true);
    // GitHub only returns up to 300 files, on page one; further pages paginate commits, not files.
    // At the ceiling we cannot prove completeness, even when exactly 300 paths changed.
    if (data.files.length >= 300) return incomplete('github_file_limit', true);
    const changes: CheckInMetadata['changes'] = [], paths = new Set<string>();
    for (const value of data.files) {
      const file = record(value);
      if (!validPath(file.filename) || paths.has(file.filename)) return incomplete('invalid_changed_path', true);
      paths.add(file.filename);
      const oldPath = file.previous_filename ?? null;
      if ((oldPath !== null && !validPath(oldPath)) || (file.status === 'renamed' && oldPath === null)) return incomplete('invalid_changed_path', true);
      changes.push({ path: file.filename, oldPath: oldPath as string | null, added: lineCount(file.additions), deleted: lineCount(file.deletions) });
    }
    return { changes, complete: true, ancestor: true, testState: 'unknown' };
  } catch (error) {
    return incomplete(error instanceof Error && error.message === 'metadata_size_limit' ? 'metadata_size_limit' : signal.aborted ? 'metadata_timeout' : 'metadata_read_failed');
  }
}
