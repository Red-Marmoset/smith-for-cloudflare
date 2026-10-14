import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { hash } from '../src/http';
import identity from '../migrations/0001_identity.sql?raw';
import browser from '../migrations/0002_browser_auth.sql?raw';
import profile from '../migrations/0005_account_profile.sql?raw';

const origin = 'https://exp.redmarmosetstudios.com';

async function signIn() {
  const userId = crypto.randomUUID(); const code = crypto.randomUUID() + crypto.randomUUID();
  await env.DB.batch([env.DB.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').bind(userId, Date.now()), env.DB.prepare('INSERT INTO invites VALUES (?, ?, ?)').bind(await hash(code), userId, Date.now() + 60000)]);
  const login = await worker.fetch(new Request(origin + '/auth/invite', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ code }) }), env);
  expect(login.status).toBe(200);
  return login.headers.get('Set-Cookie')!.split(';')[0];
}
function get(path: string, cookie?: string) {
  return worker.fetch(new Request(origin + path, { headers: cookie ? { Cookie: cookie } : {} }), env);
}

describe('agent package downloads', () => {
  beforeAll(async () => { for (const schema of [identity, browser, profile]) await env.DB.exec(schema); });

  it('serves each OS package to signed-in people and lists the missing ones as not yet available', async () => {
    const cookie = await signIn();
    await env.RELEASES.put('smith-experiment-windows.zip', 'PK-windows');
    await env.RELEASES.put('smith-experiment-mac.zip', 'PK-mac');

    for (const [os, body] of [['windows', 'PK-windows'], ['mac', 'PK-mac']]) {
      const response = await get(`/downloads/smith-experiment-${os}.zip`, cookie);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Disposition')).toBe(`attachment; filename="smith-experiment-${os}.zip"`);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      expect(await response.text()).toBe(body);
    }
    // Not uploaded yet: "coming soon", not a missing route.
    const linux = await get('/downloads/smith-experiment-linux.zip', cookie);
    expect(linux.status).toBe(503);
    expect(await linux.json()).toMatchObject({ error: { code: 'release_unavailable', message: expect.stringContaining('Linux') } });

    const listing = await get('/api/v2/downloads', cookie);
    expect(listing.status).toBe(200);
    expect(await listing.json()).toEqual({ packages: {
      windows: { available: true, path: '/downloads/smith-experiment-windows.zip', version: null },
      mac: { available: true, path: '/downloads/smith-experiment-mac.zip', version: null },
      linux: { available: false, path: '/downloads/smith-experiment-linux.zip', version: null },
    } });
  });

  it('never serves packages or the listing anonymously, and knows no other package names', async () => {
    expect((await get('/downloads/smith-experiment-windows.zip')).status).toBe(401);
    expect((await get('/api/v2/downloads')).status).toBe(401);
    const cookie = await signIn();
    // An unknown OS falls through to the static assets, not to R2.
    const other = await get('/downloads/smith-experiment-freebsd.zip', cookie);
    expect(other.status).not.toBe(200);
    expect(other.headers.get('Content-Disposition')).toBeNull();
  });
});
