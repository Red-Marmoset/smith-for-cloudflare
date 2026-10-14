import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { setup } from './lfs-fixture';
import { ArtifactsTokens, ARTIFACTS_TOKEN_SCHEMA, READ_CACHE_MS, WRITE_CACHE_MS } from '../src/artifacts-tokens';
import schema from '../migrations/0001_identity.sql?raw';
import browserSchema from '../migrations/0002_browser_auth.sql?raw';
import directorySchema from '../migrations/0003_workspace_directory.sql?raw';

beforeAll(async () => { await env.DB.exec(schema); await env.DB.exec(browserSchema); await env.DB.exec(directorySchema); });

describe('the Artifacts token cache', () => {
  it('stores, reuses until expiry, replaces and lists per project', async () => {
    const f = await setup();
    await runInDurableObject(f.stub, (_instance, state) => {
      const sql = state.storage.sql; sql.exec(ARTIFACTS_TOKEN_SCHEMA);
      const tokens = new ArtifactsTokens(sql); const now = 1_000_000;
      expect(tokens.get('senet', 'read', now)).toBeUndefined();
      tokens.store('senet', 'read', 'tok_1', 'art_v1_a', now + READ_CACHE_MS);
      expect(tokens.get('senet', 'read', now + READ_CACHE_MS - 1)).toMatchObject({ tokenId: 'tok_1', plaintext: 'art_v1_a' });
      expect(tokens.get('senet', 'read', now + READ_CACHE_MS)).toBeUndefined();   // a token about to lapse is not handed out
      tokens.store('senet', 'write', 'tok_2', 'art_v1_b', now + WRITE_CACHE_MS);
      expect(tokens.forProject('senet').map(t => t.scope).sort()).toEqual(['read', 'write']);
      expect(tokens.drop('senet', 'read')).toEqual({ tokenId: 'tok_1' });
      expect(tokens.get('senet', 'read', now)).toBeUndefined();
      expect(tokens.expired(now + WRITE_CACHE_MS + 1)).toEqual([{ projectId: 'senet', scope: 'write', tokenId: 'tok_2' }]);
    });
  });
});
