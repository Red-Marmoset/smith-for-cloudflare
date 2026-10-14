// The copies planner runs on every nodes listing and every alarm: its inputs must come from a handful of queries, not one
// (or two) per large file, or a workspace with thousands of objects stalls its Durable Object on each dashboard poll.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { beforeAll, expect, it, vi } from 'vitest';
import { setup } from './lfs-fixture';
import schema from '../migrations/0001_identity.sql?raw';
import browserSchema from '../migrations/0002_browser_auth.sql?raw';
import directorySchema from '../migrations/0003_workspace_directory.sql?raw';

beforeAll(async () => { await env.DB.exec(schema); await env.DB.exec(browserSchema); await env.DB.exec(directorySchema); });
it('the planner loads its inputs in a handful of queries however many large files there are', async () => {
  const f = await setup();
  const calls = await runInDurableObject(f.stub, (instance, state) => {
    const ops = (instance as unknown as { gitOps: { dryPlan(now: number): unknown } }).gitOps; const now = Date.now();
    for (let i = 0; i < 300; i++) state.storage.sql.exec("INSERT INTO lfs_objects (repo_id, oid, size, state, created_at, ready_at) VALUES ('senet', ?, 1024, 'ready', ?, ?)", i.toString(16).padStart(64, '0'), now, now);
    const spy = vi.spyOn(state.storage.sql, 'exec');
    ops.dryPlan(now);
    const n = spy.mock.calls.length; spy.mockRestore(); return n;
  });
  expect(calls).toBeGreaterThan(3);   // the spy saw the planner's queries at all
  expect(calls).toBeLessThan(40);
});
