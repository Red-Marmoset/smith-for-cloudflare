// Projects that look like the same repository on the same branch (an import beside a project added by URL, the same
// repository written as SSH and as HTTPS): a "Duplicate?" hint on their cards, never a block. Pure, tested.

// "host/owner/repo" in lower case from any way of writing a Git URL; '' when it is not one.
export function repoKey(url) {
  const text = String(url || '').trim();
  const match = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(text) || /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(text);
  if (!match) return '';
  const path = match[2].replace(/\/+$/, '').replace(/\.git$/i, '').replace(/^\/+/, '');
  return path && !/\s/.test(path) ? `${match[1].toLowerCase()}/${path.toLowerCase()}` : '';
}
// Every repository a project stands for: where it builds from, where its copy came from, what it was detached from.
function keysOf(project) {
  const urls = [project.repoUrl, project.artifacts?.sourceRepoUrl, project.hosted?.sourceRepoUrl, project.artifacts?.detachedFrom, project.hosted?.detachedFrom];
  return new Set(urls.map(repoKey).filter(Boolean));
}
// A blank branch is the repository's default, which may be any named one.
const sameBranch = (a, b) => !a || !b || a === b;
// Project id -> the other projects that look like the same repository and branch, in list order.
export function duplicates(projects) {
  const keyed = projects.map(project => ({ project, keys: keysOf(project) }));
  const found = new Map();
  for (const { project, keys } of keyed) {
    const others = [];
    for (const other of keyed) {
      if (other.project.id === project.id || !sameBranch(project.branch || '', other.project.branch || '')) continue;
      const shared = [...keys].find(key => other.keys.has(key));
      if (shared) others.push({ id: other.project.id, name: other.project.name || other.project.id, repository: shared, branch: other.project.branch || '' });
    }
    if (others.length) found.set(project.id, others);
  }
  return found;
}
// What the hint says when opened.
export function duplicateText(others) {
  const names = others.map(o => `“${o.name}”`);
  const listed = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const branches = new Set(others.map(o => o.branch));
  const branch = branches.size === 1 && others[0].branch ? `, branch ${others[0].branch}` : '';
  const one = others.length === 1;
  return `${listed} ${one ? 'looks' : 'look'} like the same repository (${others[0].repository}${branch}). Each project fetches, builds and keeps its own copies, so a push can build twice and storage holds it twice. If you meant to have one, remove the ${one ? 'other from its card' : 'others from their cards'}; if they differ on purpose, ignore this.`;
}
// The hint on a card (a <details> from projectFold): "Duplicate?" beside its state opens the card on the explanation,
// with a button to each look-alike in `list`.
export function markDuplicate(card, others, { element, list }) {
  const link = element('button', 'Duplicate?', 'build-link duplicate'); link.type = 'button';
  link.title = 'Another project seems to build the same repository and branch. Click for what that means.';
  const note = element('p', duplicateText(others), 'duplicate-note'); note.hidden = true;
  for (const other of others) {
    const show = element('button', `Show “${other.name}”`, 'build-link'); show.type = 'button';
    show.addEventListener('click', () => {
      const target = list.querySelector(`details[data-project-id="${CSS.escape(other.id)}"]`);
      if (target) { target.open = true; target.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    });
    note.append(document.createTextNode(' '), show);
  }
  // Inside the card's summary a click would fold or unfold it: it opens the card itself and toggles the note instead.
  link.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); card.open = true; note.hidden = !note.hidden; });
  card.querySelector(':scope > summary .project-state')?.prepend(link);
  card.querySelector(':scope > summary')?.after(note);
}
