import { describe, expect, it } from 'vitest';
import { HttpError } from '../src/http';
import { OID, LFS_MAX_OBJECTS, formatBytes, lfsConfigSnippet, lfsKey, lfsUrl, parseBatchRequest } from '../src/lfs';

const origin = 'https://exp.redmarmosetstudios.com';
const oid = 'a'.repeat(64);

describe('lfs pure helpers', () => {
  it('builds keys, endpoint URLs and the .lfsconfig snippet', () => {
    expect(lfsKey('w'.repeat(64), 'senet', oid)).toBe(`lfs/${'w'.repeat(64)}/senet/${oid}`);
    expect(lfsUrl(origin, 'senet')).toBe(origin + '/git/senet.git/info/lfs');
    expect(lfsConfigSnippet(origin, 'senet')).toBe('[lfs]\n\turl = https://exp.redmarmosetstudios.com/git/senet.git/info/lfs\n');
    expect(OID.test(oid)).toBe(true);
    for (const bad of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), '', '../x']) expect(OID.test(bad)).toBe(false);
  });
  it('formats byte counts the way the dashboard shows them', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(12288)).toBe('12 kB');
    expect(formatBytes(340 * 1048576)).toBe('340 MB');
    expect(formatBytes(5 * 1073741824)).toBe('5 GB');
    expect(formatBytes(5.4 * 1073741824)).toBe('5.4 GB');
    expect(formatBytes(104857600)).toBe('100 MB');
  });
  it('parses a batch request and refuses what the spec refuses', () => {
    expect(parseBatchRequest({ operation: 'upload', transfers: ['basic'], ref: { name: 'refs/heads/main' }, objects: [{ oid, size: 10 }] })).toEqual({ operation: 'upload', objects: [{ oid, size: 10 }] });
    expect(parseBatchRequest({ operation: 'download', objects: [{ oid, size: 0 }], hash_algo: 'sha256' })).toEqual({ operation: 'download', objects: [{ oid, size: 0 }] });
    const refused = (body: unknown, status: number, text: string) => {
      try { parseBatchRequest(body); throw new Error('accepted'); }
      catch (error) { expect(error).toBeInstanceOf(HttpError); expect((error as HttpError).status).toBe(status); expect((error as HttpError).message).toContain(text); }
    };
    refused({ operation: 'delete', objects: [] }, 422, 'operation');
    refused({ operation: 'upload', objects: [{ oid: 'xyz', size: 1 }] }, 422, 'oid');
    refused({ operation: 'upload', objects: [{ oid, size: -1 }] }, 422, 'size');
    refused({ operation: 'upload', objects: [{ oid, size: 1.5 }] }, 422, 'size');
    refused({ operation: 'upload', objects: [{ oid, size: 1 }], hash_algo: 'sha512' }, 422, 'sha256');
    refused({ operation: 'upload', objects: 'nope' }, 422, 'objects');
    refused({ operation: 'upload', objects: Array.from({ length: LFS_MAX_OBJECTS + 1 }, () => ({ oid, size: 1 })) }, 413, '1000');
    refused('not json', 422, 'object');
  });
});
