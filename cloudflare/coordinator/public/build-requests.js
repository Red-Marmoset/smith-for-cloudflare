export async function submitBuild(send, storage, key) {
  const storageKey = 'smith.pending-build:' + key;
  const requestId = storage.getItem(storageKey) || crypto.randomUUID();
  storage.setItem(storageKey, requestId);
  const result = await send(requestId);
  if (storage.getItem(storageKey) === requestId) storage.removeItem(storageKey);
  return result;
}
