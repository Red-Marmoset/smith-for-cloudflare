// What Smith builds when a repository has no smith.json: the obvious cases, read from the tracked file list alone, become a
// default smith.json that pipeline.ts reads like any other, so scanning, the card and build-time resolution need no second
// path. A smith.json in the repository always wins. Detection never infers a deploy or publish step: those need a
// destination and a login, and nothing ships on a guess. Pure: no bindings, no I/O.

export type DetectedKind = 'script' | 'npm' | 'site';
export interface Detection { kind: DetectedKind; summary: string; smithJson: string }

type Step = { interpreter: string; script: string; args: string[] };
// A root file by name, ignoring case; returns the path as the repository spells it.
function rootFile(paths: readonly string[], ...names: string[]): string | null {
  const wanted = names.map(name => name.toLowerCase());
  for (const name of wanted) { const hit = paths.find(path => !path.includes('/') && path.toLowerCase() === name); if (hit) return hit; }
  return null;
}
function config(projectId: string, name: string, product: string, rule: Record<string, unknown>): string {
  return JSON.stringify({ schemaVersion: 1, project: { id: projectId, name: name || projectId },
    buildProducts: [{ name: product, rules: [{ name: 'detected', ...rule }] }] }, null, 2);
}

// The first that matches wins: a build script the repository already has (the repo's script owns the work), then an npm
// project, then a static site. null when nothing is recognised.
export function detectBuild(paths: readonly string[], projectId: string, name = ''): Detection | null {
  const bat = rootFile(paths, 'build.bat', 'build.cmd'), ps1 = rootFile(paths, 'build.ps1'), sh = rootFile(paths, 'build.sh');
  if (bat || ps1 || sh) {
    const command: Record<string, Step> = {};
    if (bat) command.windows = { interpreter: 'bat', script: bat, args: [] };
    else if (ps1) command.windows = { interpreter: 'ps1', script: ps1, args: [] };
    if (sh) { command.linux = { interpreter: 'sh', script: sh, args: [] }; command.mac = { interpreter: 'sh', script: sh, args: [] }; }
    const scripts = [bat ?? ps1, sh].filter(Boolean).join(' and ');
    return { kind: 'script', summary: `the repository's own build script (${scripts})`, smithJson: config(projectId, name, 'build', { command, timeoutSeconds: 3600 }) };
  }
  if (rootFile(paths, 'package.json')) {
    // npm is a .cmd shim on Windows, which CreateProcess cannot start by itself; cmd.exe resolves it.
    const install = rootFile(paths, 'package-lock.json', 'npm-shrinkwrap.json') ? ['ci'] : ['install'];
    const steps = (os: string): Step[] => [install, ['run', 'build', '--if-present']].map(args =>
      os === 'windows' ? { interpreter: 'exe', script: 'cmd.exe', args: ['/d', '/c', 'npm', ...args] } : { interpreter: 'exe', script: 'npm', args });
    return { kind: 'npm', summary: `an npm project (npm ${install[0]}, then its build script if it has one)`,
      smithJson: config(projectId, name, 'build', { nodeSelector: { os: 'any', labels: ['npm'] }, env: { CI: 'true' }, timeoutSeconds: 1800,
        command: { windows: steps('windows'), linux: steps('linux'), mac: steps('mac') } }) };
  }
  if (rootFile(paths, 'index.html', 'index.htm')) {
    // tar ships with Windows 10+, macOS and Linux; the archive is the one exact file a hosted build can collect.
    const pack: Step = { interpreter: 'exe', script: 'tar', args: ['-czf', 'site.tar.gz', '--exclude=.git', '--exclude=site.tar.gz', '.'] };
    return { kind: 'site', summary: 'a static website (its files, packed as site.tar.gz)',
      smithJson: config(projectId, name, 'site', { timeoutSeconds: 600, command: { windows: pack, linux: pack, mac: pack }, artifacts: { globs: ['site.tar.gz'], package: 'none' } }) };
  }
  return null;
}
// For the "nothing found" message: what Smith looks for, in plain words.
export const DETECTS = 'a build.bat, build.ps1 or build.sh, a package.json, or an index.html at the root';
