import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCheckInMetadata } from '../src/checkin-metadata';
const base = 'a'.repeat(40), head = 'b'.repeat(40);
const file = { filename: 'src/new.ts', previous_filename: 'src/old.ts', status: 'renamed', additions: 2, deletions: 1 };
const body = (files: unknown[] = [file]) => ({ base_commit: { sha: base }, merge_base_commit: { sha: base }, status: 'ahead', files });
const read = () => readCheckInMetadata('https://github.com/owner/repo.git', base, head, 'token');
afterEach(() => vi.restoreAllMocks());
describe('bounded GitHub check-in metadata', () => {
  it('reads exact hashes and preserves both rename sides without following redirects', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(body()));
    expect(await read()).toEqual({ complete: true, ancestor: true, testState: 'unknown', changes: [{ path: 'src/new.ts', oldPath: 'src/old.ts', added: 2, deleted: 1 }] });
    expect(fetch).toHaveBeenCalledWith(`https://api.github.com/repos/owner/repo/compare/${base}...${head}?per_page=1&page=1`, expect.objectContaining({ redirect: 'manual', signal: expect.any(AbortSignal) }));
  });
  it('fails closed for divergent history and the GitHub file-list ceiling', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ...body(), merge_base_commit: { sha: 'c'.repeat(40) }, status: 'diverged' }));
    expect(await read()).toMatchObject({ complete: false, ancestor: false, changes: [] });
    fetch.mockResolvedValue(Response.json(body(Array.from({ length: 300 }, (_, i) => ({ ...file, filename: `src/${i}.ts` })))));
    expect(await read()).toMatchObject({ complete: false, reason: 'github_file_limit' });
  });
  it('rejects unsafe paths, missing file lists, malformed hashes and arbitrary remotes', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    for (const filename of ['../secret', '/absolute', 'C:/absolute', 'src\\escape', 'src/../secret', 'x\u0000', 'a'.repeat(513)]) {
      fetch.mockResolvedValue(Response.json(body([{ ...file, filename }])));
      expect(await read()).toMatchObject({ complete: false, changes: [] });
    }
    fetch.mockResolvedValue(Response.json({ ...body(), files: undefined }));
    expect(await read()).toMatchObject({ complete: false });
    fetch.mockClear();
    expect(await readCheckInMetadata('https://evil.test/a/b', base, head, 'token')).toMatchObject({ complete: false });
    expect(await readCheckInMetadata('https://github.com/a/b', 'main', head, 'token')).toMatchObject({ complete: false });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('cancels oversized streams and refuses redirects', async () => {
    const cancel = vi.fn();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel })));
    expect(await read()).toMatchObject({ complete: false, reason: 'metadata_size_limit' });
    expect(cancel).toHaveBeenCalled();
    fetch.mockResolvedValue(new Response('', { status: 302, headers: { location: 'https://evil.test' } }));
    expect(await read()).toMatchObject({ complete: false, reason: 'github_http_302' });
  });
});
