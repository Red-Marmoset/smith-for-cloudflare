// The git endpoint's Artifacts backend (spec §2 and §3): pass-through of smart-HTTP requests to the Artifacts remote with
// a repo-scoped token, and the v1 advertisement read as the record's tips (Artifacts has no refs API).
import { tipsDigest, validateTips, validatePeeled, type Peeled, type Tips } from './git-host';

const ZERO = '0'.repeat(40);
// pkt-lines: four hex digits of length (the four included), "0000" is a flush.
function* pktLines(text: string): Generator<string> {
  let at = 0;
  while (at + 4 <= text.length) {
    const length = parseInt(text.slice(at, at + 4), 16);
    if (Number.isNaN(length)) throw new Error('Not a git advertisement');
    if (length === 0) { at += 4; continue; }
    if (length < 4 || at + length > text.length) throw new Error('Not a git advertisement');
    yield text.slice(at + 4, at + length); at += length;
  }
}
export function parseAdvertisement(text: string): { tips: Tips; peeled: Peeled } {
  const lines = [...pktLines(text)];
  if (!lines.length || !lines[0].startsWith('# service=git-upload-pack')) throw new Error('Not a git-upload-pack advertisement');
  const refs: [string, string][] = []; const peeled: Record<string, string> = {};
  for (const raw of lines.slice(1)) {
    const line = raw.split('\0')[0].replace(/\n$/, '');
    const match = /^([a-f0-9]{40}) (\S+)$/.exec(line);
    if (!match) continue;
    const [, sha, ref] = match;
    if (sha === ZERO || ref === 'HEAD' || ref === 'capabilities^{}') continue;
    if (ref.endsWith('^{}')) { peeled[ref.slice(0, -3)] = sha; continue; }
    refs.push([sha, ref]);
  }
  const tips = validateTips(refs.sort((a, b) => a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return { tips, peeled: validatePeeled(peeled, tips) };
}
// The tips Artifacts holds now. `fetcher` is the client's gitFetch in tests (the in-memory git server) and fetch otherwise.
export async function fetchTips(remote: string, token: string, fetcher: typeof fetch = fetch): Promise<{ tips: Tips; peeled: Peeled; digest: string }> {
  const response = await fetcher(`${remote}/info/refs?service=git-upload-pack`, { redirect: 'manual', signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'smith-coordinator' } });
  if (!response.ok) throw new Error(`Artifacts answered ${response.status} for the advertisement`);
  const parsed = parseAdvertisement(await response.text());
  return { ...parsed, digest: await tipsDigest(parsed.tips) };
}

export const STORAGE_UNREACHABLE = "Smith's storage is unreachable; nothing was pushed. Try again in a few minutes";
export const FIRST_BYTE_MS = 30000;
export type ProxyOutcome = { kind: 'response'; response: Response } | { kind: 'unavailable'; reason: string } | { kind: 'refused'; status: 401 | 403 };
const FORWARDED = ['content-type', 'content-encoding', 'accept', 'git-protocol', 'user-agent'];
// Streams one smart-HTTP request to the Artifacts remote and its answer back. Only the time to the first byte is bounded:
// a clone's pack streams for as long as it takes. A 5xx or no answer is 'unavailable'; a 401/403 means the token is bad.
export async function proxyGit(request: Request, remote: string, token: string, path: 'info/refs' | 'git-upload-pack' | 'git-receive-pack', search: string): Promise<ProxyOutcome> {
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  for (const name of FORWARDED) { const value = request.headers.get(name); if (value) headers.set(name, value); }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FIRST_BYTE_MS);
  try {
    const upstream = await fetch(`${remote}/${path}${search}`, { method: request.method, headers, body: request.method === 'POST' ? request.body : undefined, redirect: 'manual', signal: controller.signal });
    clearTimeout(timer);
    if (upstream.status === 401 || upstream.status === 403) return { kind: 'refused', status: upstream.status };
    if (upstream.status >= 500 || upstream.status === 429 || upstream.status === 0) return { kind: 'unavailable', reason: `Artifacts answered ${upstream.status}` };
    const out = new Headers({ 'Cache-Control': 'no-cache, max-age=0, must-revalidate', Pragma: 'no-cache', Expires: 'Fri, 01 Jan 1980 00:00:00 GMT', 'X-Content-Type-Options': 'nosniff' });
    const type = upstream.headers.get('Content-Type'); if (type) out.set('Content-Type', type);
    return { kind: 'response', response: new Response(upstream.body, { status: upstream.status, headers: out }) };
  } catch (error) {
    clearTimeout(timer);
    return { kind: 'unavailable', reason: error instanceof Error ? error.message.slice(0, 200) : 'no answer' };
  }
}
