import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { availableParallelism } from 'node:os';
// Every test worker starts its own workerd runtime, and each reserves a large V8 address space up front. Vitest's
// default (one worker per core) on a many-core Windows machine starts so many at once that workerd dies with "Fatal
// process out of memory" before a test runs, and whole files fail as "(0 test)". Four is what passes everywhere;
// SMITH_TEST_WORKERS overrides it.
const workers = Math.max(1, Number(process.env.SMITH_TEST_WORKERS) || Math.min(4, availableParallelism() - 1));
export default defineConfig({
  test: { testTimeout: 30000, maxWorkers: workers },   // relay round trips move megabytes through R2 in the test runtime
  // Tests never reach the real Artifacts or GitHub APIs: the adapters run their in-memory fakes, and remote bindings
  // (the Artifacts binding has no local simulation) stay off so no Cloudflare login is needed.
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' }, remoteBindings: false, miniflare: { bindings: { ARTIFACTS_MODE: 'fake', GITHUB_MODE: 'fake', GIT_READY_TIMEOUT_MS: '1500', GIT_WAIT_MS: '4000' } } })],
});
