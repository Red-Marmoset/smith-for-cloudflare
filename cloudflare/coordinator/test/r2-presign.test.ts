import { describe, expect, it } from 'vitest';
import { presign, presignConfig, presignObject } from '../src/r2-presign';

// "Authenticating Requests: Using Query Parameters (AWS Signature Version 4)", example 1 (GET, 24 h).
const aws = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt' };
const when = new Date('2013-05-24T00:00:00Z');

describe('SigV4 query presigning', () => {
  it('reproduces the AWS documentation example', async () => {
    const url = new URL(await presign(aws, 'GET', 86400, when));
    expect(url.origin + url.pathname).toBe('https://examplebucket.s3.amazonaws.com/test.txt');
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Credential')).toBe('AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request');
    expect(url.searchParams.get('X-Amz-Date')).toBe('20130524T000000Z');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('86400');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(url.searchParams.get('X-Amz-Signature')).toBe('aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  });
  it('signs R2 object URLs for the account, bucket and key, region auto', async () => {
    const config = { accountId: 'bab833826312fe2b0c81bd7608a6dbf7', bucket: 'smith-experiment-git', accessKeyId: 'k', secretAccessKey: 's' };
    const url = new URL(await presignObject(config, 'PUT', 'lfs/w/senet/' + 'a'.repeat(64), 3600, when));
    expect(url.host).toBe('bab833826312fe2b0c81bd7608a6dbf7.r2.cloudflarestorage.com');
    expect(url.pathname).toBe('/smith-experiment-git/lfs/w/senet/' + 'a'.repeat(64));
    expect(url.searchParams.get('X-Amz-Credential')).toBe('k/20130524/auto/s3/aws4_request');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/);
    const other = new URL(await presignObject(config, 'GET', 'lfs/w/senet/' + 'a'.repeat(64), 3600, when));
    expect(other.searchParams.get('X-Amz-Signature')).not.toBe(url.searchParams.get('X-Amz-Signature'));   // the method is signed
  });
  it('is off unless every secret and var is present', () => {
    const base = { R2_ACCOUNT_ID: 'a', GIT_BUCKET: 'b', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's' };
    expect(presignConfig(base as unknown as Env)).toEqual({ accountId: 'a', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' });
    for (const missing of Object.keys(base)) expect(presignConfig({ ...base, [missing]: '' } as unknown as Env)).toBeNull();
  });
});
