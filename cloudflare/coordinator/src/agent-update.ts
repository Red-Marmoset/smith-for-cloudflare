// Agents keep themselves on the package published for their OS. Publishing a package uploads
// smith-experiment-<os>.zip and then its manifest smith-experiment-<os>.json (PackageAgent.bat
// --upload / tools/package-experiment.py); a heartbeat from an agent on another version is answered
// with an `update` offer, and the agent fetches the zip from /agent-package with its node token.
export type PackageOs = 'windows' | 'mac' | 'linux';
export type ReleaseManifest = { version: string; sha256: string; size: number; arch: string };
export const PACKAGE_OSES: PackageOs[] = ['windows', 'mac', 'linux'];

export function packageOs(value: unknown): PackageOs | null {
  return typeof value === 'string' && (PACKAGE_OSES as string[]).includes(value) ? value as PackageOs : null;
}

// Pure: a manifest object as uploaded, or null when it is missing or malformed.
export function parseManifest(value: unknown): ReleaseManifest | null {
  if (!value || typeof value !== 'object') return null;
  const m = value as Record<string, unknown>;
  if (typeof m.version !== 'string' || !/^hosted-[a-f0-9]{12}$/.test(m.version)) return null;
  if (typeof m.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(m.sha256)) return null;
  if (!Number.isSafeInteger(m.size) || (m.size as number) < 1 || (m.size as number) > 512 * 1024 * 1024) return null;
  const arch = typeof m.arch === 'string' && /^[a-z0-9_]{0,16}$/.test(m.arch) ? m.arch : '';
  return { version: m.version, sha256: m.sha256, size: m.size as number, arch };
}

// Pure: what a heartbeat reply offers an agent, or null when it is current. Only agents that report
// a packaged version (hosted-<commit>) can update themselves; a package built for another
// architecture (an arm64 Mac zip on an Intel Mac) is never offered.
export function updateOffer(manifest: ReleaseManifest | null, agentVersion: unknown, arch: unknown) {
  if (!manifest || typeof agentVersion !== 'string' || !/^hosted-[a-f0-9]{12}$/.test(agentVersion)) return null;
  if (agentVersion === manifest.version) return null;
  if (manifest.arch && typeof arch === 'string' && arch !== manifest.arch) return null;
  return { version: manifest.version, sha256: manifest.sha256, size: manifest.size };
}

// Manifests change only when someone publishes, so each isolate reads one at most once a minute.
const cache = new Map<PackageOs, { at: number; manifest: ReleaseManifest | null }>();
export async function releaseManifest(env: Env, os: PackageOs): Promise<ReleaseManifest | null> {
  const cached = cache.get(os);
  if (cached && Date.now() - cached.at < 60_000) return cached.manifest;
  let manifest: ReleaseManifest | null = null;
  try {
    const object = await env.RELEASES.get(`smith-experiment-${os}.json`);
    manifest = object ? parseManifest(await object.json()) : null;
  } catch { manifest = null; }
  cache.set(os, { at: Date.now(), manifest });
  return manifest;
}
// For tests that publish a package and expect the next heartbeat to see it.
export function forgetReleaseManifests() { cache.clear(); }
