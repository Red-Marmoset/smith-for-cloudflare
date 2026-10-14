import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
const workspace = 'a'.repeat(64), endpoint = `https://smith.test/api/v2/workspaces/${workspace}/crew/webhooks/github/project`;
function fixture() {
  const checkInWebhook = vi.fn(async () => Response.json({ accepted: true }));
  const getByName = vi.fn(() => ({ checkInWebhook }));
  const env = { ORIGIN: 'https://smith.test', WORKSPACES: { getByName } } as unknown as Env;
  return { checkInWebhook, getByName, env };
}
const headers = { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=' + 'a'.repeat(64), 'X-GitHub-Event': 'push', 'X-GitHub-Delivery': 'delivery-1' };
describe('GitHub check-in routing', () => {
  it('passes untouched signed bytes to the project-bound RPC without human authentication', async () => {
    const { checkInWebhook, getByName, env } = fixture();
    const raw = '\ufeff{ "message": "é" }\n';
    const response = await worker.fetch(new Request(endpoint, { method: 'POST', headers, body: raw }), env);
    expect(response.status).toBe(200);
    expect(getByName).toHaveBeenCalledWith(workspace);
    expect(checkInWebhook).toHaveBeenCalledWith('project', 'push', 'delivery-1', headers['X-Hub-Signature-256'], raw);
  });
  it('rejects missing signatures and oversized streams before invoking the coordinator', async () => {
    const { checkInWebhook, env } = fixture();
    expect((await worker.fetch(new Request(endpoint, { method: 'POST', body: '{}' }), env)).status).toBe(401);
    const cancel = vi.fn();
    const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(64 * 1024)); }, cancel });
    expect((await worker.fetch(new Request(endpoint, { method: 'POST', headers, body }), env)).status).toBe(413);
    expect(cancel).toHaveBeenCalled(); expect(checkInWebhook).not.toHaveBeenCalled();
  });
  it('rejects malformed UTF-8 instead of changing the signed payload', async () => {
    const { checkInWebhook, env } = fixture();
    expect((await worker.fetch(new Request(endpoint, { method: 'POST', headers, body: new Uint8Array([0xff]) }), env)).status).toBe(400);
    expect(checkInWebhook).not.toHaveBeenCalled();
  });
});
