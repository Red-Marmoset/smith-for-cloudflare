import { it, expect } from 'vitest';
import { submitBuild } from '../public/build-requests.js';

it('retries an unacknowledged build using the same request ID, including after a view reload', async () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  const received = []; let responseLost = true;
  const send = async id => { received.push(id); if (responseLost) { responseLost = false; throw new Error('Response lost after acceptance'); } return { id: 'accepted-job' }; };
  await expect(submitBuild(send, storage, 'workspace/project/build')).rejects.toThrow('Response lost');
  expect(await submitBuild(send, { ...storage }, 'workspace/project/build')).toEqual({ id: 'accepted-job' });
  expect(received[1]).toBe(received[0]);
  await submitBuild(send, storage, 'workspace/project/build');
  expect(received[2]).not.toBe(received[0]);
});
