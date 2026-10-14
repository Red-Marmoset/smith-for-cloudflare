// Import from GitHub (spec §5): pick an organisation, tick repositories, see which will be rewritten, start, then follow the
// import in the same dialog (the panel), with Retry per row and Cancel. Pure texts first, the dialog below.
import { formatBytes } from './lfs.js';

export function repoRowText(repo, thresholdBytes) {
  if (repo.inSmith) return `already in Smith as ${repo.inSmith}`;
  const large = repo.large;
  if (!large) return 'could not check';
  if (large.over32) return `must be rewritten for Smith’s storage (${large.over32} ${large.over32 === 1 ? 'file' : 'files'} over 32 MB)`;
  if (large.count) return `${large.count} ${large.count === 1 ? 'file' : 'files'} over ${formatBytes(thresholdBytes)} on ${repo.defaultBranch}: history will be rewritten`;
  return large.truncated ? `no large files seen on ${repo.defaultBranch} (listing cut short; history may hold more)` : `no large files on ${repo.defaultBranch}`;
}
export function importSummaryText(s) {
  return [`${s.done} of ${s.total} done`, s.failed ? `${s.failed} failed` : '', s.machine ? `${s.machine} on a machine instead` : '', s.running ? `${s.running} running` : ''].filter(Boolean).join(' · ');
}
const STATE_LABEL = { queued: 'queued', running: 'importing', done: 'done', machine: 'on a machine', failed: 'failed', cancelled: 'cancelled' };

// Every import route answers { import } (git-workspace.ts): start, get, retry and cancel alike.
export function createImports({ api, base, element, action, refresh, selectJob, settings }) {
  const $ = id => document.getElementById(id);
  let current = null, listing = null, timer = null;
  function reset() { current = null; listing = null; clearTimeout(timer); $('import-dialog')?.close(); }
  async function open() {
    const dialog = $('import-dialog'); $('import-repos').replaceChildren(); $('import-panel').hidden = true; $('import-pick').hidden = false;
    $('import-threshold-mb').value = Math.round((settings()?.lfsImportThresholdBytes || 10485760) / 1048576);
    $('import-link').checked = true; $('import-status').textContent = 'Listing your organisations…';
    dialog.showModal();
    try {
      const orgs = await api(base() + '/imports/github/orgs');
      if (!orgs.configured) { $('import-status').replaceChildren(element('span', 'Smith cannot see GitHub for you yet. '), linkGitHub(orgs.installUrl)); return; }
      $('import-org').replaceChildren(...orgs.orgs.map(o => { const option = document.createElement('option'); option.value = o.login; option.textContent = o.login; return option; }));
      $('import-status').textContent = orgs.orgs.length ? '' : 'Your GitHub link sees no organisations; type one below.';
      if (orgs.orgs.length) await list();
    } catch (error) { $('import-status').textContent = error.message; }
  }
  function linkGitHub(installUrl) {
    const a = element('a', 'Link GitHub'); a.href = '/auth/github/link';
    const note = element('span', installUrl ? ' or install the Smith GitHub App on the organisation, or add a fine-grained token with access to it in Settings.' : ' or add a fine-grained token with access to the organisation in Settings.');
    const span = element('span'); span.append(a, note); return span;
  }
  async function list() {
    const org = $('import-org-typed').value.trim() || $('import-org').value; if (!org) return;
    const threshold = Math.round(Number($('import-threshold-mb').value) || 10) * 1048576;
    $('import-status').textContent = `Listing ${org}…`; $('import-repos').replaceChildren();
    listing = await api(`${base()}/imports/github/repos?org=${encodeURIComponent(org)}&threshold=${threshold}`);
    $('import-status').textContent = `${listing.repos.length} repositories, ${formatBytes(listing.totalKb * 1024)} on GitHub`;
    for (const repo of listing.repos) {
      const row = element('label', undefined, 'import-row'); const box = element('input'); box.type = 'checkbox'; box.checked = !repo.inSmith; box.disabled = Boolean(repo.inSmith); box.dataset.fullName = repo.fullName;
      row.append(box, element('strong', repo.fullName + (repo.archived ? ' (archived)' : '')), element('span', ` · ${formatBytes(repo.sizeKb * 1024)} · ${repoRowText(repo, threshold)}`, 'muted small'));
      $('import-repos').append(row);
    }
  }
  async function start() {
    const threshold = Math.round(Number($('import-threshold-mb').value) || 10) * 1048576;
    const ticked = [...$('import-repos').querySelectorAll('input:checked')].map(box => listing.repos.find(r => r.fullName === box.dataset.fullName));
    if (!ticked.length) throw new Error('Tick at least one repository');
    const started = await api(base() + '/imports', { org: listing.org, repos: ticked.map(r => ({ fullName: r.fullName, url: r.url, defaultBranch: r.defaultBranch })), thresholdBytes: threshold, link: $('import-link').checked });
    show(started.import); await refresh(true); tick();
  }
  const fetchImport = async id => (await api(`${base()}/imports/${encodeURIComponent(id)}`)).import;
  function show(imp) {
    current = imp; $('import-pick').hidden = true; $('import-panel').hidden = false;
    $('import-summary').textContent = `${imp.org}: ${importSummaryText(imp.summary)}`;
    $('import-rows').replaceChildren(...imp.repos.map(r => {
      const row = element('div', undefined, 'import-row'); row.append(element('strong', r.fullName), element('span', ` · ${STATE_LABEL[r.state] || r.state}${r.message ? ': ' + r.message : ''}`, 'muted small'));
      if (r.jobId) { const open = element('button', 'Show output', 'build-link'); open.addEventListener('click', () => action(open, () => selectJob(r.jobId))); row.append(open); }
      if (r.state === 'failed') { const retry = element('button', 'Retry', 'quiet'); retry.addEventListener('click', () => action(retry, async () => { await api(`${base()}/imports/${encodeURIComponent(imp.id)}/retry`, { fullName: r.fullName }); show(await fetchImport(imp.id)); tick(); })); row.append(retry); }
      return row;
    }));
    $('import-cancel').hidden = imp.state !== 'running';
  }
  function tick() {
    clearTimeout(timer);
    if (!current || current.state !== 'running' || !$('import-dialog').open) return;
    timer = setTimeout(() => void fetchImport(current.id).then(imp => { show(imp); tick(); }).catch(() => tick()), 3000);
  }
  $('open-import').addEventListener('click', () => void open());
  $('import-list').addEventListener('click', event => action(event.target, list));
  $('import-start').addEventListener('click', event => action(event.target, start));
  $('import-cancel').addEventListener('click', event => action(event.target, async () => { if (!confirm('Cancel this import? Repositories that finished stay; the rest are removed from Smith.')) return; await api(`${base()}/imports/${encodeURIComponent(current.id)}/cancel`, {}); show(await fetchImport(current.id)); await refresh(true); }));
  $('close-import').addEventListener('click', () => { clearTimeout(timer); $('import-dialog').close(); });
  return { open, reset, tick, show };
}
