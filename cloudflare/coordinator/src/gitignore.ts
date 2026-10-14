// .gitignore matching for a project started from a zip in the Worker (smith-projects.ts), so the first commit leaves out
// what the project itself ignores (a Unity Library/, node_modules/, build output), as `git add -A` would on a machine.
// Covers the syntax projects use: comments, `!` negation, a trailing `/` for directories, a leading or inner `/` to
// anchor, and `*`, `?`, `[...]` and `**`. As in git, a file inside an ignored directory stays ignored.

interface Rule { base: string; regex: RegExp; negate: boolean; dirOnly: boolean }
export interface IgnoreRules { rules: Rule[] }

function globToRegex(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const before = i === 0 || glob[i - 1] === '/', after = glob[i + 2] === '/' || i + 2 === glob.length;
        if (before && after) { out += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += glob[i + 2] === '/' ? 2 : 1; continue; }
      }
      out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '[') {
      const close = glob.indexOf(']', i + 2);
      if (close < 0) { out += '\\['; continue; }
      let set = glob.slice(i + 1, close); if (set.startsWith('!')) set = '^' + set.slice(1);
      out += '[' + set.replace(/\\/g, '\\\\') + ']'; i = close;
    } else if (c === '\\' && i + 1 < glob.length) { out += glob[i + 1].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'); i++; }
    else out += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return out;
}

// Adds the rules of the .gitignore in directory `base` ('' for the root, else 'dir/sub/'); call shallower directories first.
export function addIgnoreFile(into: IgnoreRules, base: string, text: string): void {
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/(?<!\\)\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    let negate = false;
    if (line.startsWith('!')) { negate = true; line = line.slice(1); }
    else if (line.startsWith('\\!') || line.startsWith('\\#')) line = line.slice(1);
    let dirOnly = false;
    if (line.endsWith('/')) { dirOnly = true; line = line.replace(/\/+$/, ''); }
    if (!line) continue;
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    const body = globToRegex(line);
    into.rules.push({ base, negate, dirOnly, regex: new RegExp(anchored ? `^${body}$` : `(?:^|/)${body}$`) });
  }
}

function matches(rules: IgnoreRules, path: string, directory: boolean): boolean {
  let ignored = false;
  for (const rule of rules.rules) {
    if (rule.dirOnly && !directory) continue;
    if (rule.base && !path.startsWith(rule.base)) continue;
    if (rule.regex.test(path.slice(rule.base.length))) ignored = !rule.negate;
  }
  return ignored;
}
// Whether a file at `path` (relative, '/'-separated) is left out: it or any folder above it is ignored.
export function isIgnored(rules: IgnoreRules, path: string): boolean {
  if (!rules.rules.length) return false;
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) if (matches(rules, parts.slice(0, i).join('/'), true)) return true;
  return matches(rules, path, false);
}
