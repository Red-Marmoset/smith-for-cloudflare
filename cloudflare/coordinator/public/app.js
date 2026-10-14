'use strict';
import { submitBuild } from './build-requests.js';
import { attachOutputCopy } from './build-output.js';
import { createChat } from './chat.js';
import { createAgentAccess } from './agents.js';
import { createCrew } from './crew.js';
import { createPulls } from './pulls.js';
import { createImports } from './imports.js';
import { duplicates, markDuplicate } from './duplicates.js';
import { parseWorkspacePolicy, renderProjectAutomation } from './crew-events.js';
import { createMembers } from './members.js';
import { lfsConfigSnippet, lfsSummary, lfsModeText, lfsCopiesText } from './lfs.js';
import { copiesUsageText, copiesFullText, homeText, underReplicatedText } from './copies.js';
import { machineCard, machineSummary } from './machines.js';
import { copyOf, projectFold, repoName, repoProjectCard, shownRepoUrl } from './repo-projects.js';

const $ = id => document.getElementById(id);
attachOutputCopy($('copy-build-output'), $('logs'), $('copy-build-status'));
const activeStates = new Set(['queued', 'leased', 'running']);
let csrfToken = null;
let signedIn = false;
let workspaceId = null;
let selectedJob = null;
let afterSeq = -1;
let logCharacters = 0;
let trimmedLogs = false;
let generation = 0;
let selectionGeneration = 0;
let timer;
let projects = [];
let machines = [];
let jobs = [];
let nodeSnapshot = '';
let jobSnapshot = '';
let artifactSnapshot = '';
const copying = new Set(['pushing', 'verifying', 'copying']);
const artifactsAvailable = () => Boolean(workspaceSettings?.artifactsAvailable);   // Cloudflare account + token set in Settings
// A build machine switched on to keep copies is online (hostsOnline comes with every machine refresh, so the copy
// buttons follow machines coming and going without refetching settings).
const hostingAvailable = () => machines.some(machine => machine.hostsOnline);
const canCopy = () => hostingAvailable() || artifactsAvailable();
const canBuildRole = () => ['owner', 'admin', 'operator'].includes(workspaceSettings?.role);
const adminRole = () => ['owner', 'admin'].includes(workspaceSettings?.role);
// Smith's own copy of a project is served from this site: <origin>/git/<project>.git.
const onSmithCopy = project => project?.hosted?.status === 'ready' && typeof project.repoUrl === 'string' && project.repoUrl.startsWith(location.origin + '/git/');
let cloneProject = null;
let account = { displayName: '', email: '', preferences: {} };
let workspaceSettings = null;
let readProjectAutomation = () => ({});
let renderedSettingsWorkspace = null;
let logStart = null;
const DEFAULT_PREFERENCES = { timeZone: 'auto', clock: 'auto', logTimestamps: 'time', followOutput: true, refreshSeconds: 2 };
const prefs = () => ({ ...DEFAULT_PREFERENCES, ...account.preferences });

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function showError(error) {
  $('error-message').textContent = error.message || 'The request could not be completed. Try again.';
  $('error').classList.remove('success');
  $('error').hidden = false;
}
function clearError() { $('error').hidden = true; }
function connection(text, state = '') {
  $('connection').textContent = text; $('connection').className = `connection ${state}`;
}
function resetSession() {
  signedIn = false; csrfToken = null; workspaceId = null; selectedJob = null; generation++;
  clearTimeout(timer);
  $('dashboard').hidden = true; $('settings').hidden = true; $('account').hidden = true; $('login').hidden = false;
  account = { displayName: '', email: '', preferences: {} }; workspaceSettings = null;
  if (location.hash === '#settings') history.replaceState(null, '', location.pathname);
  $('enrollment').close(); $('enrollment-code').value = ''; $('add-project-dialog').close(); $('logs').replaceChildren();
  chat.reset(); agents.reset(); crew.reset(); members.reset(); pulls.reset(); imports.reset();
}
async function api(path, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json', ...(csrfToken ? { 'X-Smith-CSRF': csrfToken } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401 && path !== '/auth/invite') resetSession();
      const error = new Error(value?.error?.message || `Request failed (${response.status}). Try again.`);
      error.status = response.status;
      throw error;
    }
    return value;
  } catch (error) {
    if (error.name === 'AbortError' || error instanceof TypeError) throw new Error('Cannot reach Smith. Check your connection and try again.');
    throw error;
  } finally { clearTimeout(timeout); }
}
async function action(button, task) {
  button.disabled = true; clearError();
  try { await task(); } catch (error) { showError(error); }
  finally { button.disabled = false; }
}
function base(id = workspaceId) { return `/api/v2/workspaces/${encodeURIComponent(id)}`; }
// Date rendering honours the account's time zone and clock preferences.
function formatOptions(extra) {
  const p = prefs(); const options = { ...extra };
  if (p.timeZone && p.timeZone !== 'auto') options.timeZone = p.timeZone;
  if (p.clock === '12') options.hourCycle = 'h12'; else if (p.clock === '24') options.hourCycle = 'h23';
  return options;
}
function format(value, extra) {
  try { return new Intl.DateTimeFormat(undefined, formatOptions(extra)).format(new Date(value)); }
  catch { return new Date(value).toLocaleString(); }
}
function date(value) { return value ? format(value, { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
function time(value) { return format(value, { timeStyle: 'medium' }); }
function stamp(at) {
  const mode = prefs().logTimestamps;
  if (mode === 'off' || !at) return '';
  if (mode === 'iso') return new Date(at).toISOString() + '  ';
  if (mode === 'datetime') return format(at, { dateStyle: 'short', timeStyle: 'medium' }) + '  ';
  if (mode === 'elapsed') {
    if (logStart === null) logStart = at;
    const total = Math.max(0, Math.round((at - logStart) / 1000));
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
    return `+${h ? h + ':' : ''}${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}  `;
  }
  return time(at) + '  ';
}
function offlineAfterMs() { return (workspaceSettings?.nodeOfflineSeconds || 60) * 1000; }
function badge(state) {
  const known = ['success', 'failed', 'error', 'lost', 'cancelled', 'queued', 'leased', 'running', 'online', 'offline', 'revoked', 'completed', 'stopped', 'stopping', 'pushing', 'verifying', 'copying', 'done', 'waiting', 'scanning', 'ready', 'degraded', 'open', 'merged', 'closed', 'conflicts'];
  return element('span', state, `badge ${known.includes(state) ? state : ''}`);
}

const providerNames = { google: 'Google', github: 'GitHub' };
const signinMessages = {
  not_linked: name => `That ${name} account is not linked to Smith yet.${name === 'Google' ? ' Studio Google accounts get in directly; for any other,' : ''} Sign in once with an invitation code (run NewInvite.bat), then use “Link ${name}” at the top of the dashboard.`,
  state: () => 'That sign-in took too long or was started in another browser tab. Please try again.',
  cancelled: () => 'Sign-in was cancelled.',
  provider_error: name => `${name} sign-in did not work. Please try again.`,
  unverified_email: name => `Your ${name} account’s email address is not verified, so it cannot be used to sign in.`,
  already_linked: name => `That ${name} account is already linked to a different Smith user.`,
};
let signinProviders = [];
// Explains the outcome of a Google/GitHub round trip (?signin_error=… / ?linked=…), then tidies the address bar.
function showSigninOutcome() {
  const params = new URLSearchParams(location.search);
  const error = params.get('signin_error'), linked = params.get('linked');
  const name = providerNames[params.get('provider') || linked || ''] || 'That';
  // `detail` is Smith's short reason code (e.g. token:invalid_client), so a failure says why it failed.
  const detail = params.get('detail');
  if (error) showError(new Error((signinMessages[error] || signinMessages.provider_error)(name === 'That' ? 'provider' : name) + (detail ? ` (Reason: ${detail})` : '')));
  // A provider that cannot use Smith's callback URL sends you to the URL registered with it instead (often
  // this page) with ?error=…; GitHub does this for redirect_uri_mismatch. Show its code rather than nothing.
  const providerError = !error && params.get('error');
  if (providerError) {
    const code = providerError.toLowerCase().replace(/[^a-z0-9_.:-]+/g, '_').slice(0, 80);
    showError(new Error(code === 'redirect_uri_mismatch'
      ? `Sign-in failed: the provider's OAuth app has the wrong callback URL. Set it to exactly ${location.origin}/auth/callback/github (or /google), then try again. (Reason: provider:${code})`
      : `Sign-in failed at the provider. (Reason: provider:${code})`));
  }
  if (linked) { $('error-message').textContent = `${providerNames[linked] || linked} is linked. Next time you can sign in with it.`; $('error').hidden = false; $('error').classList.add('success'); }
  if (linked === 'github' && sessionStorage.getItem('smith.reopen-add-project')) { sessionStorage.removeItem('smith.reopen-add-project'); reopenAddProject = true; }
  if (params.toString()) history.replaceState(null, '', location.pathname);
}
async function loadSigninProviders() {
  try { signinProviders = (await api('/auth/providers')).providers; } catch { signinProviders = []; }
  $('signin-providers').replaceChildren(...signinProviders.map(provider => {
    const link = element('a', `Continue with ${providerNames[provider] || provider}`, `provider-button ${provider}`);
    link.href = `/auth/login/${encodeURIComponent(provider)}`; return link;
  }));
  $('signin-providers').hidden = !signinProviders.length; $('signin-or').hidden = !signinProviders.length;
}
function renderAccount(identity) {
  const linked = identity.identities || [];
  // A chosen display name wins; otherwise show the linked sign-in identities, as before.
  $('account-label').textContent = account.displayName || (linked.length ? `Signed in · ${linked.map(i => `${providerNames[i.provider] || i.provider}: ${i.email || i.login || 'linked'}`).join(' · ')}` : 'Experiment workspace');
  $('link-accounts').replaceChildren(...signinProviders.filter(p => !linked.some(i => i.provider === p)).map(provider => {
    const button = element('button', `Link ${providerNames[provider] || provider}`, 'quiet');
    button.addEventListener('click', () => action(button, async () => { const { url } = await api(`/auth/link/${encodeURIComponent(provider)}`, {}); location.assign(url); }));
    return button;
  }));
}
function applyIdentity(identity) {
  csrfToken = identity.csrfToken;
  account = { displayName: identity.user?.displayName || '', email: identity.user?.email || '', preferences: identity.user?.preferences || {} };
  renderAccount(identity);
}
async function enterDashboard(identity) {
  applyIdentity(identity); signedIn = true;
  $('login').hidden = true; $('account').hidden = false;
  $('invite-code').value = '';
  showSettings(location.hash === '#settings');
  await loadWorkspaces();
}
// The last workspace you looked at is remembered in this browser only, so a reload (or a #chat= link) lands back in it.
function rememberedWorkspace() { try { return localStorage.getItem('smith.workspace'); } catch { return null; } }
async function loadWorkspaces(preferred = rememberedWorkspace()) {
  const response = await api('/api/v2/workspaces');
  const list = response.workspaces;
  $('workspace').replaceChildren(...list.map((workspace, index) => {
    const option = element('option', `${workspace.name || `Workspace ${index + 1}`} · ${workspace.id.slice(0, 8)}`); option.value = workspace.id; return option;
  }));
  $('workspace').disabled = !list.length;
  $('no-workspaces').hidden = Boolean(list.length);
  if (!list.length) { $('workspace-content').hidden = true; connection('Connected', 'online'); return; }
  $('workspace').value = list.some(item => item.id === preferred) ? preferred : list[0].id;
  await selectWorkspace($('workspace').value);
}
async function selectWorkspace(id) {
  try { localStorage.setItem('smith.workspace', id); } catch { /* storage blocked: nothing to remember */ }
  closeRename();
  workspaceId = id; selectedJob = null; afterSeq = -1; generation++;
  projects = []; machines = []; jobs = []; nodeSnapshot = ''; jobSnapshot = ''; workspaceSettings = null;
  clearTimeout(timer); $('job-detail').hidden = true; $('logs').replaceChildren(); chat.reset(); agents.reset(); crew.reset(); members.reset(); pulls.reset();
  if (!$('settings').hidden) void members.refresh().catch(showError);
  $('workspace-content').hidden = false;
  $('projects').replaceChildren(element('p', 'Loading projects…', 'empty'));
  $('nodes').replaceChildren(element('p', 'Loading machines…', 'empty'));
  $('jobs').replaceChildren(); $('no-jobs').hidden = true;
  await refresh(true);
  if (reopenAddProject) { reopenAddProject = false; $('add-project').click(); }
}
function startBuild(button, project, product) {
  return action(button, async () => {
    const current = generation;
    const job = await submitBuild(requestId => api(base() + '/jobs', { requestId, projectId: project.id, product }), sessionStorage, `${workspaceId}/${project.id}/${product}`);
    if (current !== generation) return;
    await refresh(); await selectJob(job.id);
  });
}
// The hook URL and secret of the project whose Build on push was just turned on by hand (shown once, until the next reload).
let pushSetup = null;
// Save what a push builds; the boxes stay disabled while it saves, and a refusal puts them back as they were.
async function choosePushActions(controls, id, actions) {
  for (const control of controls) control.disabled = true;
  try { await api(base() + '/projects/' + encodeURIComponent(id) + '/push-actions', { actions }); await refresh(true); }
  catch (error) { showError(error); await refresh(true); }
  finally { for (const control of controls) control.disabled = false; }
}
async function chooseReplaceQueued(box, id, enabled) {
  box.disabled = true;
  try { await api(base() + '/projects/' + encodeURIComponent(id) + '/replace-queued', { enabled }); await refresh(true); }
  catch (error) { showError(error); await refresh(true); }
  finally { box.disabled = false; }
}
function togglePush(button, id, enabled) {
  return action(button, async () => {
    const result = await api(base() + '/projects/' + encodeURIComponent(id) + '/push', { enabled });
    pushSetup = result.secret ? { projectId: id, url: result.url, secret: result.secret } : null;
    await refresh(true);
  });
}
function renderProjects() {
  $('projects').replaceChildren(); renderProjectCount(); renderFoldAll();
  if (!projects.length) {
    $('projects').append(element('p', 'No projects yet. Use Add project to build a repository from its smith.json.', 'empty'));
    return;
  }
  const dupes = duplicates(projects);
  for (const project of projects) {
    if (project.kind === 'repo') {
      const card = repoProjectCard(project, { element, badge, date,
        onBuild: (button, product) => startBuild(button, project, product),
        onRescan: (button, id) => action(button, async () => { await api(base() + '/projects/' + encodeURIComponent(id) + '/rescan', {}); await refresh(true); }),
        onShowJob: (button, id) => action(button, () => selectJob(id)), artifactsRow: copyRow,
        onSync: (button, direction) => action(button, () => startSync(project, direction)),
        onLink: (button, url) => action(button, async () => { await api(base() + '/projects/' + encodeURIComponent(project.id) + '/upstream', { url }); await refresh(true); }),
        jobState: id => jobs.find(job => job.id === id)?.state,
        onPush: togglePush, pushSetup, hookUrl: id => `${location.origin}/api/v2/hooks/github/${workspaceId}/${id}`,
        onPushChoose: adminRole() ? choosePushActions : null, onReplaceQueued: adminRole() ? chooseReplaceQueued : null });
      // Its crew sits under the source and copy lines, as on a prepared project's card.
      const crewRow = crew.renderProjectCrew(card, project); card.querySelector('.source')?.nextElementSibling?.after(crewRow);
      crew.renderCreatedBy(card, project, () => refresh(true));   // a project a crew member created
      if (adminRole() && !project.createdBy) card.append(projectActionsRow(project));
      if (dupes.has(project.id)) markDuplicate(card, dupes.get(project.id), { element, list: $('projects') });
      $('projects').append(card);
      continue;
    }
    const products = project.products || [];
    const line = [repoName(shownRepoUrl(project)), project.branch || 'pinned revision', `${products.length} action${products.length === 1 ? '' : 's'}`].join(' · ');
    const card = projectFold(project, { element, badge, line });
    if (dupes.has(project.id)) markDuplicate(card, dupes.get(project.id), { element, list: $('projects') });
    const source = element('p', `${shownRepoUrl(project)}\n${project.branch || 'Pinned revision'} · ${(project.commit || '').slice(0, 12)}`, 'source');
    card.append(source, copyRow(project), preparedPushRow(project));
    crew.renderCreatedBy(card, project, () => refresh(true));
    crew.renderProjectCrew(card, project);
    for (const product of project.products || []) {
      const row = element('div', undefined, 'product'); const description = element('div');
      description.append(element('strong', product.name), element('p', product.description || 'Run this prepared project action.'));
      const button = element('button', product.name === 'self-release' ? 'Build candidate' : product.name.toLowerCase() === 'build' ? 'Build' : `Run ${product.name}`);
      button.title = 'Queue this product at the displayed pinned commit. It waits for a compatible machine; building a candidate does not activate it.';
      button.setAttribute('aria-description', button.title);
      button.addEventListener('click', () => startBuild(button, project, product.name));
      row.append(description, button); card.append(row);
    }
    if (adminRole() && !project.createdBy) card.append(projectActionsRow(project));
    $('projects').append(card);
  }
  renderFoldAll();
}
// Remove project (owners and admins): Smith stops listing and building it; the server refuses, with the reason, while a
// build of it runs or a crew member works on it as its main project.
function projectActionsRow(project) {
  const row = element('div', undefined, 'remove-row'); const edit = element('button', 'Edit', 'quiet');
  edit.addEventListener('click', () => openEditProject(project));
  const button = element('button', 'Remove project', 'quiet danger');
  button.addEventListener('click', () => action(button, async () => {
    const name = project.name || project.id;
    const copy = project.hosted?.status === 'ready' ? ' The machines throw away Smith’s copy of it.' : '';
    const push = project.push?.enabled ? ' Build on push is turned off.' : '';
    if (!confirm(`Remove ${name} from this workspace? Queued builds of it are cancelled.${copy}${push} Its past builds stay listed. The repository itself is not touched.`)) return;
    const result = await api(base() + '/projects/' + encodeURIComponent(project.id) + '/remove', {});
    if (result?.message) alert(result.message);
    await refresh(true);
  }));
  row.append(edit, button); return row;
}
// A prepared project is pinned to one commit, so a push cannot build it. Editing it to follow its branch fixes that in place.
function preparedPushRow(project) {
  const row = element('div', undefined, 'artifacts push-row'); const text = element('div');
  text.append(element('strong', 'Build on push is not available yet'),
    element('p', `This project is pinned to one commit, so a push cannot build it. Make it follow ${project.branch || 'its branch'} and its card gets Build on push.`, 'muted small'));
  const button = element('button', 'Follow its branch', 'quiet');
  button.disabled = !adminRole() || Boolean(project.createdBy);
  if (button.disabled) button.title = 'An owner or admin can do this.';
  button.addEventListener('click', () => openEditProject(project));
  row.append(text, button);
  return row;
}
// Edit a project in place: name, branch, and whether it builds from Smith's copy or the repository.
let editing = null;
function openEditProject(project) {
  editing = project;
  const pinned = project.kind !== 'repo', copy = copyOf(project);
  const hasCopy = Boolean(copy) || project.hosted?.status === 'ready' || project.artifacts?.status === 'done';
  $('edit-project-form').reset(); $('edit-project-branches').replaceChildren();
  $('edit-project-pinned').hidden = !pinned;
  $('edit-project-name').value = project.name || project.id;
  $('edit-project-branch').value = project.branch || '';
  const source = copy ? (copy.sourceRepoUrl || '') : project.repoUrl;
  $('edit-project-source').hidden = !hasCopy;
  $('edit-project-from-repository').textContent = source ? `The repository (${repoName(source)})` : 'The repository (not linked)';
  for (const radio of document.querySelectorAll('input[name="edit-project-from"]')) {
    radio.checked = radio.value === (copy ? 'copy' : 'repository');
    radio.disabled = radio.value === 'repository' && copy && !source;
  }
  $('submit-edit-project').textContent = pinned ? 'Follow this branch' : 'Save';
  $('edit-project-dialog').showModal(); $('edit-project-branch').focus();
  // Branches to choose from, when GitHub can list them.
  const github = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(source || '')?.[1];
  const current = generation;
  if (github) void api(base() + '/github/branches?repo=' + encodeURIComponent(github)).then(result => {
    if (current !== generation || editing !== project) return;
    $('edit-project-branches').replaceChildren(...(result.branches || []).map(name => option(name, name)));
  }).catch(() => { /* typing a branch still works */ });
}
$('close-edit-project').addEventListener('click', () => $('edit-project-dialog').close());
$('edit-project-form').addEventListener('submit', event => {
  event.preventDefault();
  const project = editing; if (!project) return;
  void action($('submit-edit-project'), async () => {
    const body = {};
    const name = $('edit-project-name').value.trim(), branch = $('edit-project-branch').value.trim();
    if (name !== (project.name || project.id)) body.name = name;
    if (branch !== (project.branch || '') || project.kind !== 'repo') body.branch = branch;
    if (!$('edit-project-source').hidden) {
      const from = document.querySelector('input[name="edit-project-from"]:checked')?.value;
      if (from && from !== (copyOf(project) ? 'copy' : 'repository')) body.buildFrom = from;
    }
    const current = generation;
    if (Object.keys(body).length) await api(base() + '/projects/' + encodeURIComponent(project.id) + '/edit', body);
    if (current !== generation) return;
    $('edit-project-dialog').close(); editing = null;
    await refresh(true);
  });
});
// Fold all / Unfold all over the project cards; each card's own state is remembered as if it had been clicked.
const projectCards = () => [...$('projects').querySelectorAll(':scope > details.project')];
function renderFoldAll() {
  const cards = projectCards(); $('fold-projects').hidden = cards.length < 2;
  $('fold-projects').textContent = cards.some(card => card.open) ? 'Fold all' : 'Unfold all';
}
$('fold-projects').addEventListener('click', () => { const open = !projectCards().some(card => card.open); for (const card of projectCards()) card.open = open; renderFoldAll(); });
$('projects').addEventListener('toggle', event => { if (event.target.matches?.('details.project')) renderFoldAll(); }, true);
// The project's copy in Smith: kept on the build machines switched on for it and served from this site
// (project.hosted), or, from before that existed, on Cloudflare Artifacts (project.artifacts). A status line while
// a copy is in flight or finished, Clone once Smith serves it, and "Copy into Smith", always rendered: enabled when
// a machine can take the copy, otherwise disabled beside the one thing that would enable it.
function copyRow(project) {
  const row = element('div', undefined, 'artifacts'); const record = project.artifacts, hosted = project.hosted;
  if (hosted) {
    row.append(badge(hosted.status === 'ready' ? (hosted.state === 'lost' || hosted.state === 'degraded' ? hosted.state : 'done') : hosted.status));
    // A project started in Smith (hosted.init) has no repository elsewhere: its machines create it rather than copy it.
    const made = Boolean(hosted.init);
    const text = hosted.status === 'copying' ? (made ? `Creating the project${hosted.init.kind === 'zip' ? ' from ' + (hosted.init.archiveName || 'the zip') : ''}: a machine that keeps copies is making its repository.` : 'Copying into Smith: a machine that keeps copies is cloning the repository.')
      : hosted.status === 'ready' ? `${made ? 'This project lives in Smith. ' : ''}Builds, chats and crew use Smith’s copy of this repository. ${homeText(project, workspaceSettings?.copiesPerItem || 2)}.`
      : `${made ? 'Creating the project' : 'Copying into Smith'} failed${hosted.message ? ': ' + hosted.message : ''}.`;
    row.append(element('span', text, 'message'));
    if (hosted.jobId && hosted.status !== 'ready') {
      const open = element('button', 'Show output', 'build-link');
      open.addEventListener('click', () => action(open, () => selectJob(hosted.jobId)));
      row.append(open);
    }
    if (onSmithCopy(project)) {
      const clone = element('button', 'Clone', 'quiet');
      clone.addEventListener('click', () => action(clone, () => openCloneDialog(project)));
      row.append(clone);
    }
    if (hosted.status === 'ready') hostedDetails(row, project, hosted);
    // Between homes (spec §2.5): into storage while the machines keep their copies, or back into storage from a current copy.
    if (hosted.status === 'ready' && adminRole()) {
      if (project.home === 'machines' && hosted.state === 'hosting' && artifactsAvailable()) row.append(storageButton(project, 'move-to-storage', 'Move to storage'));
      if (project.home === 'artifacts' && hosted.state === 'lost') row.append(storageButton(project, 'restore-to-storage', 'Restore to storage'));
    }
    // A move into storage that failed leaves the home where it was, with the reason here.
    if (project.home === 'machines' && record?.message && !record.move) row.append(element('span', `Smith’s storage: ${record.message}.`, 'message warn wide'));
    // An import that rewrote history says so, with the original history to download.
    if (project.importNote) {
      const original = hosted.backups?.originals?.[0];
      const note = element('p', `${project.importNote}${original ? ': ' : '.'}`, 'muted small');
      if (original) { const link = element('a', 'download the original history'); link.href = `${base()}/projects/${encodeURIComponent(project.id)}/backups/${encodeURIComponent(original.id)}`; note.append(link, document.createTextNode('.')); }
      row.append(note);
    }
  }
  if (record && !hosted) {
    row.append(badge(record.status));
    const text = record.status === 'pushing' && typeof project.createdBy?.crewId === 'string' ? 'Waiting for the crew run’s first push to its new copy in Smith.'
      : record.status === 'pushing' ? 'Copying into Smith: a connected machine sends the pinned branch and tags.'
      : record.status === 'verifying' ? 'Copy sent; Smith is checking it.'
      : record.status === 'done' ? `Builds use Smith’s copy of this repository${record.source === 'workspace' ? ', kept in your Cloudflare account' : ''}.`
      : `Copying into Smith failed${record.message ? ': ' + record.message : ''}.`;
    row.append(element('span', text, 'message'));
    if (record.jobId && record.status !== 'done') {
      const open = element('button', 'Show output', 'build-link');
      open.addEventListener('click', () => action(open, () => selectJob(record.jobId)));
      row.append(open);
    }
  }
  const copied = onSmithCopy(project) || (record?.status === 'done' && project.repoUrl === record.remote);
  if (!copied && !copying.has(hosted?.status) && !copying.has(record?.status)) {
    if (project.kind === 'repo' && !project.commit && !hosted?.init) row.append(element('span', 'Copy into Smith becomes available once the repository has been read.', 'muted small'));
    else {
      const button = element('button', hosted?.init ? 'Try again' : hosted || record ? 'Copy into Smith again' : 'Copy into Smith', 'quiet');
      if (canCopy()) button.addEventListener('click', () => action(button, () => startCopy(project)));
      else { button.disabled = true; row.append(noHostNotice()); }
      row.append(button);
    }
  }
  // Large files (Git LFS): what the project keeps in Smith's storage, which machines hold copies, and the one line a
  // repository hosted elsewhere commits as .lfsconfig (a Smith-hosted repository needs nothing: git-lfs finds the endpoint).
  const lfs = element('div', undefined, 'artifacts');
  const copies = lfsCopiesText(project.lfs?.copies);
  const lost = project.lfs?.lost ? `${project.lfs.lost} lost, being restored` : '';
  lfs.append(badge('lfs'), element('span', `Large files: ${[lfsSummary(project.lfs), copies, lost].filter(Boolean).join(' · ')}.`, 'message'));
  const setup = element('button', 'Setup', 'quiet');
  setup.title = onSmithCopy(project) ? 'Not needed for a Smith-hosted repository: git-lfs finds this endpoint on its own' : 'The .lfsconfig line that points this repository at Smith for large files';
  const snippet = element('pre', lfsConfigSnippet(location.origin, project.id), 'small'); snippet.hidden = true;
  const copy = element('button', 'Copy', 'quiet'); copy.hidden = true;
  setup.addEventListener('click', () => { snippet.hidden = !snippet.hidden; copy.hidden = snippet.hidden; });
  copy.addEventListener('click', () => { void navigator.clipboard?.writeText(snippet.textContent); });
  lfs.append(setup, snippet, copy);
  row.append(lfs);
  return row;
}
function storageButton(project, verb, label) {
  const button = element('button', label, 'quiet');
  button.title = verb === 'move-to-storage' ? 'Push every branch and tag into Smith’s storage; the machines’ copies stay as copies.' : 'A machine holding a current copy pushes it back into Smith’s storage.';
  button.addEventListener('click', () => action(button, async () => { await api(`${base()}/projects/${encodeURIComponent(project.id)}/${verb}`, { requestId: crypto.randomUUID() }); await refresh(true); }));
  return button;
}
// Below the copy line: where the copies are and whether they are current, the backups, work in flight, and the states
// that need a person (lost: Restore; restored behind the record: Accept; refs a copy held beyond the record: Promote/Discard).
function hostedDetails(row, project, hosted) {
  const copies = hosted.copies || [], current = copies.filter(c => c.state === 'current').length, live = copies.filter(c => c.state !== 'lost');
  const parts = [];
  if (live.length) parts.push(`${current} of ${live.length} ${live.length === 1 ? 'copy' : 'copies'} current`);
  if (hosted.backups?.count) parts.push(`backed up ${relative(hosted.backups.newestAt)}`); else if (hosted.state === 'hosting') parts.push('not backed up yet');
  for (const task of hosted.tasks || []) parts.push(`${task.kind === 'replicate' ? 'copying to' : task.kind === 'backup' ? 'backing up on' : task.kind === 'restore' ? 'restoring on' : task.kind === 'discard' ? 'removing from' : task.kind === 'promote' ? 'pushing a kept ref from' : 'tidying'} ${task.host}${task.message ? ` (${task.message})` : ''}`);
  if (parts.length) row.append(element('span', parts.join(' · '), 'muted small wide'));
  // Git requests in flight (a Pull's push, a clone) and how the last ones ended, so a wait is never silent.
  const stage = { open: 'waiting for it to pick the request up', ready: 'waiting for it to pick the request up', leased: 'it is working on it' };
  for (const request of hosted.requests?.open || [])
    row.append(element('span', `A ${request.what} by ${request.who} was handed to ${request.host} ${relative(Date.now() - request.ageMs)}: ${stage[request.state] || request.state}.`, `message wide${request.ageMs > 120000 ? ' warn' : ''}`));
  const failed = (hosted.requests?.recent || []).filter(r => r.state === 'failed' || (r.status ?? 0) >= 400);
  if (failed.length) row.append(element('span', `Last failed ${failed[0].what} (${failed[0].who}) on ${failed[0].host} ${relative(failed[0].updatedAt)}: ${failed[0].message || 'status ' + failed[0].status}.`, 'message warn wide'));
  if (hosted.state === 'lost' || hosted.state === 'degraded') {
    const notice = element('span', hosted.message || (hosted.state === 'lost' ? 'No machine keeps this repository.' : 'This repository was restored from a backup behind Smith’s record.'), 'message warn wide');
    if (adminRole()) {
      const button = element('button', hosted.state === 'lost' ? 'Restore from backup' : 'Accept the restore', 'quiet');
      if (hosted.state === 'lost' && !hosted.backups?.restorable) { button.disabled = true; notice.append(document.createTextNode(' There is no backup to restore from; switch the machine back on.')); }
      button.addEventListener('click', () => action(button, async () => {
        if (hosted.state === 'degraded' && !confirm('Accept the restored copy as the repository? The refs that were newer in Smith’s record are given up unless a machine holding them comes back first.')) return;
        await api(base() + '/projects/' + encodeURIComponent(project.id) + (hosted.state === 'lost' ? '/restore' : '/accept-dataloss'), {}); await refresh(true);
      }));
      notice.append(document.createTextNode(' ')); notice.append(button);
    }
    row.append(notice);
  }
  for (const kept of hosted.recovered || []) {
    const line = element('span', `${kept.host} kept ${kept.ref.replace(/^refs\/smith\/recovered\/\d+\//, '')} @ ${kept.sha.slice(0, 12)}, which Smith’s record never had. `, 'message warn wide');
    if (adminRole()) for (const decision of ['promote', 'discard']) {
      const button = element('button', decision === 'promote' ? 'Push it' : 'Discard', 'quiet');
      button.addEventListener('click', () => action(button, async () => { await api(base() + '/projects/' + encodeURIComponent(project.id) + '/recovered', { nodeId: kept.nodeId, ref: kept.ref, action: decision }); await refresh(true); }));
      line.append(button, document.createTextNode(' '));
    }
    row.append(line);
  }
}
function relative(at) {
  if (!at) return 'never';
  const minutes = Math.round((Date.now() - at) / 60000);
  return minutes < 2 ? 'just now' : minutes < 60 ? `${minutes} min ago` : minutes < 2880 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} days ago`;
}
// Why "Copy into Smith" is disabled, with the fix: no build machine switched on to keep copies is online.
function noHostNotice() {
  const notice = element('span', undefined, 'message warn');
  notice.append(document.createTextNode('No machine keeps copies yet. Turn on “Keep copies of repositories here” on a '));
  const link = element('a', 'build machine'); link.href = '#nodes'; notice.append(link);
  notice.append(document.createTextNode(' that is online (git 2.36 or newer, 2 GB free).'));
  const reasons = machines.filter(machine => machine.active && machine.purpose === 'build').map(machine => `${machine.hostname || 'a machine'}: ${machineHostingState(machine)}`);
  if (reasons.length) notice.append(element('span', ' ' + reasons.join(' · '), 'muted small'));
  return notice;
}
function machineHostingState(machine) {
  if (machine.hostingReason) return machine.hostingReason;
  if (!machine.hostRepos) return 'not switched on';
  if (!(machine.active && Date.now() - machine.lastSeenAt < offlineAfterMs())) return 'offline';
  if (machine.draining) return 'updating';
  return 'keeps copies';
}
// Copy the project into Smith: onto the machines that keep copies, or onto Artifacts where that is all this account has.
function startCopy(project) {
  if (hostingAvailable()) return startHosting(project);
  if (artifactsAvailable()) return startMirror(project);
  throw new Error('No machine keeps copies yet. Turn on “Keep copies of repositories here” on an online build machine.');
}
async function startHosting(project) {
  const current = generation;
  const result = await submitBuild(requestId => api(base() + '/projects/' + encodeURIComponent(project.id) + '/host', { requestId }), sessionStorage, `${workspaceId}/${project.id}/host`);
  if (current !== generation) return;
  await refresh(true);
  if (result.job) await selectJob(result.job.id);
}
// Clone from Smith: the clone URL (its username names the workspace, so credential helpers keep one credential per
// workspace) and a git credential that lasts until revoked, shown once with the clone command.
async function openCloneDialog(project) {
  const info = await api(base() + '/projects/' + encodeURIComponent(project.id) + '/clone-info');
  cloneProject = project;
  $('clone-title').textContent = `Clone ${project.name || project.id} from Smith`;
  $('clone-url').value = info.cloneUrl;
  $('clone-intro').textContent = `Smith serves this repository${project.home === 'artifacts' ? ' from its storage' : ' from the machines that keep copies of it'}; every clone, fetch and push goes through ${location.host}. Large files (Git LFS) work with no setup. The default branch is ${info.defaultBranch || project.branch}.`;
  $('clone-credential-name').value = 'Git on my computer';
  $('clone-push-field').hidden = !canBuildRole(); $('clone-push').checked = canBuildRole();
  $('clone-help-smith').hidden = false; $('clone-credential-name').closest('div').hidden = false;
  $('clone-created-note').textContent = 'It is the password; the username is already in the URL.';
  $('clone-created').hidden = true; $('clone-token').value = ''; $('clone-command').textContent = '';
  $('clone-dialog').showModal();
}
$('close-clone').addEventListener('click', () => $('clone-dialog').close());
// Check large files: every object is verified against storage in batches; the status line follows the next refresh.
$('lfs-check').addEventListener('click', () => action($('lfs-check'), async () => {
  const r = await api(base() + '/lfs/check', {});
  $('lfs-check-status').textContent = `checking ${r.queued}…`;
}));
$('clone-dialog').addEventListener('close', () => { $('clone-token').value = ''; $('clone-command').textContent = ''; cloneProject = null; });
$('copy-clone-url').addEventListener('click', () => { void navigator.clipboard?.writeText($('clone-url').value); });
$('clone-credential-form').addEventListener('submit', event => {
  event.preventDefault();
  void action($('clone-credential-create'), async () => {
    const current = generation;
    const scopes = canBuildRole() && $('clone-push').checked ? ['read', 'build'] : ['read'];
    const created = await api(base() + '/tokens', { name: $('clone-credential-name').value.trim() || 'Git', scopes, expiresInDays: null });
    if (current !== generation) return;
    $('clone-token').value = created.token;
    $('clone-command').textContent = `git clone ${$('clone-url').value}\n# Password: the credential above (the username is already in the URL).`;
    $('clone-created').hidden = false;
    await agents.refresh();
  });
});
// A project added with "Keep a copy in Smith" ticked before Smith had read it:
// the copy starts automatically once a commit is known. Kept per browser, so a reload keeps the promise.
const PENDING_COPIES = 'smith.pending-copies';
function pendingCopies() { try { return JSON.parse(sessionStorage.getItem(PENDING_COPIES) || '[]'); } catch { return []; } }
function rememberCopy(projectId) { const key = `${workspaceId}/${projectId}`; const list = pendingCopies(); if (!list.includes(key)) list.push(key); sessionStorage.setItem(PENDING_COPIES, JSON.stringify(list)); }
async function fulfilPendingCopies() {
  for (const key of pendingCopies()) {
    const [ws, projectId] = key.split('/'); if (ws !== workspaceId) continue;
    const project = projects.find(item => item.id === projectId);
    if (!project) { sessionStorage.setItem(PENDING_COPIES, JSON.stringify(pendingCopies().filter(k => k !== key))); continue; }
    if (!project.commit || project.artifacts || project.hosted || !canCopy()) continue;
    sessionStorage.setItem(PENDING_COPIES, JSON.stringify(pendingCopies().filter(k => k !== key)));
    try { await startCopy(project); } catch (error) { showError(error); }
  }
}
async function startMirror(project) {
  const current = generation;
  const result = await submitBuild(requestId => api(base() + '/projects/' + encodeURIComponent(project.id) + '/mirror', { requestId }), sessionStorage, `${workspaceId}/${project.id}/mirror`);
  if (current !== generation) return;
  await refresh(true);
  if (result.job) await selectJob(result.job.id);
}
// Pull from / Push to the repository a copied project is linked to: a job, like a copy.
async function startSync(project, direction) {
  const current = generation;
  const result = await submitBuild(requestId => api(base() + '/projects/' + encodeURIComponent(project.id) + '/sync', { requestId, direction }), sessionStorage, `${workspaceId}/${project.id}/${direction}`);
  if (current !== generation) return;
  await refresh(true);
  if (result.job) await selectJob(result.job.id);
}
function renderMachines() {
  const snapshot = JSON.stringify([prefs(), machines.map(node => ({ ...node, online: node.active && Date.now() - node.lastSeenAt < offlineAfterMs() }))]);
  if (snapshot === nodeSnapshot) return; nodeSnapshot = snapshot;
  $('nodes').replaceChildren();
  if (!machines.length) $('nodes').append(element('p', 'No machines connected. Connect a machine to run builds.', 'empty'));
  for (const machine of machines) {
    const online = machine.active && Date.now() - machine.lastSeenAt < offlineAfterMs();
    const status = !machine.active ? 'revoked' : machine.draining ? 'updating' : online ? 'online' : 'offline';
    const { card, body: row } = machineCard(machine, { element, badge, status, line: machineSummary(machine, { online, date }) });
    row.append(element('p', `${machine.os || 'Unknown OS'}${machine.labels?.length ? ' · ' + machine.labels.join(', ') : ''}`, 'muted small'), element('p', `Agent version: ${machine.agentVersion || 'Unknown'}${agentUpdateNote(machine)}`, 'muted small'));
    if (!online) row.append(element('p', `Last seen ${date(machine.lastSeenAt)}`, 'muted small'));
    if (machine.assignedLabels?.length) row.append(assignedLabelsRow(machine));
    if (machine.draining) row.append(element('p', machine.activeJobId ? 'Finishing the current build before updating.' : 'Paused for an update; new builds will wait.', 'muted small'));
    renderMachineAi(row, machine);
    renderMachineHosting(row, machine);
    if (machine.ownedByYou) crew.renderMachineToggles(row, machine);
    if (machine.ownedByYou || adminRole()) row.append(removeMachineRow(machine, online));
    $('nodes').append(card);
  }
}
// Labels given on the dashboard (Add on a waiting build's page): shown apart from what the agent advertises, removable here.
function assignedLabelsRow(machine) {
  const row = element('p', undefined, 'muted small'); row.append(`Labels added here: ${machine.assignedLabels.join(', ')} `);
  if (!adminRole()) return row;
  for (const label of machine.assignedLabels) {
    const button = element('button', `Remove ${label}`, 'quiet');
    button.addEventListener('click', () => action(button, async () => {
      await api(`${base()}/nodes/${encodeURIComponent(machine.id)}/labels`, { labels: machine.assignedLabels.filter(item => item !== label) });
      await refresh();
    }));
    row.append(button);
  }
  return row;
}
// Remove: the machine's credential stops working and it leaves the list. A dead machine goes with one click; a live one
// stops taking work (its agent is refused from then on) and needs connecting again to come back.
function removeMachineRow(machine, online) {
  const row = element('div', undefined, 'remove-row'); const button = element('button', 'Remove machine', 'quiet danger');
  button.addEventListener('click', () => action(button, async () => {
    const name = machine.hostname || 'this machine', held = (machine.hosted || []).length;
    const warnings = [online ? `${name} is online: its agent stops working and has to be connected again to come back.` : '',
      machine.activeJobId ? 'The build it is running is marked lost.' : '',
      held ? `It keeps ${held} ${held === 1 ? 'repository' : 'repositories'}; another machine's copy takes over where there is one.` : ''].filter(Boolean);
    if (!confirm([`Remove ${name} from this workspace?`, ...warnings].join('\n\n'))) return;
    await api(`${base()}/nodes/${encodeURIComponent(machine.id)}/revoke`, {});
    nodeSnapshot = ''; await refresh(true);
  }));
  row.append(button); return row;
}
// "Keep copies of repositories here": an owner or admin switches a build machine on for this workspace; the card then
// shows what it keeps, or the one reason it cannot host (old git, low disk, an agent from before hosting).
// "Keep copies here": one switch and a budget per machine for repositories and large files alike (spec §4).
function renderMachineHosting(row, machine) {
  if (machine.purpose !== 'build' || !machine.active) return;
  const label = element('label', undefined, 'muted small share'), box = element('input');
  box.type = 'checkbox'; box.checked = Boolean(machine.hostRepos);
  box.disabled = !adminRole() || (!machine.hostRepos && Boolean(machine.hostingReason));
  label.append(box, document.createTextNode(' Keep copies here')); row.append(label);
  const budget = element('input'); budget.type = 'number'; budget.min = '1'; budget.max = '10240'; budget.step = '1'; budget.className = 'budget';
  budget.value = machine.copyBudgetBytes ? String(Math.round(machine.copyBudgetBytes / 1073741824)) : '';
  budget.placeholder = `${Math.round((workspaceSettings?.copyBudgetBytes || 53687091200) / 1073741824)}`;
  budget.disabled = !adminRole() || !machine.hostRepos; budget.title = 'How much this machine may keep, in GB. Blank: the workspace default from Settings → Copies.';
  const budgetLabel = element('label', 'up to ', 'muted small share'); budgetLabel.append(budget, document.createTextNode(' GB'));
  row.append(budgetLabel);
  const state = machine.hostingReason ? `Not keeping copies: ${machine.hostingReason}.`
    : !machine.hostRepos ? (adminRole() ? 'Off. Switch it on and this machine keeps copies of repositories and large files within its budget, and serves clones, fetches and pushes made through this site.' : 'Not switched on; an owner or admin can switch it on.')
    : [copiesUsageText(machine), copiesFullText(machine), (machine.hosted || []).some(h => h.primary) ? 'serves pushes' : ''].filter(Boolean).join(' · ');
  row.append(element('p', state, 'muted small'));
  const save = async (host, budgetBytes) => {
    const current = generation;
    const saved = await api(`${base()}/nodes/${encodeURIComponent(machine.id)}/host`, budgetBytes === undefined ? { host } : { host, budgetBytes });
    if (current !== generation) return;
    machine.hostRepos = saved.hostRepos; machine.copyBudgetBytes = saved.copyBudgetBytes; nodeSnapshot = '';
    await refresh(true);
  };
  box.addEventListener('change', () => action(box, async () => {
    const held = (machine.hosted || []).length + (machine.lfs?.objects || 0);
    if (!box.checked && held && !confirm(`${machine.hostname || 'This machine'} keeps ${held} ${held === 1 ? 'item' : 'items'}. Switching it off drops its copies; other machines take over where they can. Switch off?`)) { box.checked = true; return; }
    try { await save(box.checked, undefined); } catch (error) { box.checked = !box.checked; throw error; }
  }));
  budget.addEventListener('change', () => action(budget, async () => {
    const gb = budget.value.trim() === '' ? null : Math.round(Number(budget.value));
    if (gb !== null && (!(gb >= 1) || gb > 10240)) throw new Error('Budget must be 1 to 10240 GB, or blank for the workspace default');
    await save(true, gb === null ? null : gb * 1073741824);
  }));
}
// Agents install the published package by themselves; only one from before self-update needs a hand.
function agentUpdateNote(machine) {
  if (!machine.published) return '';
  if (machine.updateTo) return ` · updating to ${machine.updateTo}`;
  if (machine.agentVersion === machine.published) return ' · up to date';
  if (!/^hosted-[a-f0-9]{12}$/.test(machine.agentVersion || '')) return ' · update it once by hand (SmithAgent.bat update); it keeps itself current after that';
  return '';
}
const toolNames = { 'claude-code': 'Claude Code', codex: 'Codex' };
function renderMachineAi(row, machine) {
  const owner = machine.ownedByYou ? 'Yours' : 'Another member’s';
  row.append(element('p', `${owner} · ${machine.purpose === 'personal' ? 'personal computer (AI only, no builds)' : 'build machine'}`, 'muted small'));
  const ai = machine.ai;
  if (!ai) return;
  // Owners also see whether each CLI is signed in and whether an API key for it is set there.
  const tools = ai.tools.map(tool => {
    const state = [tool.signedIn === true ? 'signed in' : tool.signedIn === false ? 'not signed in' : '', tool.apiKey ? 'API key set' : ''].filter(Boolean).join(', ');
    // Version banners name their tool ("2.1.4 (Claude Code)", "codex-cli 0.90.0"); keep just the number.
    const version = tool.version.replace(/\s*\(Claude Code\)\s*$/i, '').replace(/^codex-cli\s+/i, '');
    return `${toolNames[tool.id] || tool.id} ${version}${state ? ` (${state})` : ''}`.trim();
  });
  const models = ai.ollama.up ? ai.ollama.models.map(model => model.remote ? `${model.name} (cloud)` : model.name) : [];
  row.append(element('p', `AI tools: ${tools.length ? tools.join(', ') : 'none detected'}`, 'muted small'));
  row.append(element('p', ai.ollama.up ? `Models on this machine: ${models.length ? models.join(', ') : 'none installed'}` : 'Models on this machine: none running', 'muted small'));
  if (!machine.ownedByYou || !machine.active) return;
  const disconnect = element('button', 'Disconnect', 'quiet danger small-button');
  disconnect.title = 'Revoke this machine’s credential and interrupt its work. For a graceful build stop use SmithAgent.bat stop.';
  disconnect.setAttribute('aria-description', disconnect.title);
  disconnect.addEventListener('click', () => action(disconnect, async () => {
    if (!confirm(`Disconnect ${machine.hostname || 'this machine'}? Its agent stops working until it is connected again with a new code.`)) return;
    await api(base() + '/nodes/' + encodeURIComponent(machine.id) + '/revoke', {}); nodeSnapshot = ''; await refresh();
  }));
  row.append(disconnect);
  // Other members' chats using this machine's shared models: who, and a Stop for each.
  for (const guest of machine.guestChats || []) {
    const line = element('p', `${guest.by || 'A workspace member'} is chatting here with ${guest.model ? `the model ${guest.model}` : 'a shared model'} (${toolNames[guest.tool] || guest.tool}). `, 'muted small guest-chat');
    const stop = element('button', 'Stop', 'quiet danger small-button');
    stop.addEventListener('click', () => action(stop, async () => {
      await api(base() + '/nodes/' + encodeURIComponent(machine.id) + '/guest-chats/' + encodeURIComponent(guest.sessionId) + '/stop', {}); nodeSnapshot = ''; await refresh();
    }));
    line.append(stop); row.append(line);
  }
  // Your Claude/Codex logins are never shared; only models running locally on this machine are.
  const label = element('label', undefined, 'muted small share');
  const box = element('input'); box.type = 'checkbox'; box.checked = machine.shareLocalModels;
  box.title = 'Let workspace members chat on this machine with its local Ollama models. Claude/Codex logins and cloud models stay private.';
  box.setAttribute('aria-description', box.title);
  box.addEventListener('change', () => action(box, async () => {
    try { await api(base() + '/nodes/' + encodeURIComponent(machine.id) + '/share-models', { share: box.checked }); }
    catch (error) { box.checked = !box.checked; throw error; }
    nodeSnapshot = ''; await refresh();
  }));
  label.append(box, document.createTextNode(' Let workspace members chat on this machine using the models running on it. Their chats work in a private copy of the project and may only edit that copy or read it; you see them here and can stop them. Your Claude and Codex logins are never used for them.'));
  row.append(label);
}
// What a job that is not a build reads as in the builds table: copies, scans and pull request work.
function jobKindName(job) {
  const number = /^pull-request-(\d+)$/.exec(job.product || '')?.[1];
  return { mirror: 'copy into Smith', host: 'copy into Smith', scan: 'read smith.json', diff: `compare pull request #${number}`, merge: `merge pull request #${number}`, publish: `publish pull request #${number} to GitHub` }[job.kind] ?? null;
}
// The commit a job builds, labelled, so it is never mistaken for the build's own id (shown on hover).
function jobSourceText(job) {
  const commit = job.source?.commit || job.result?.commit;
  if (commit) return `commit ${commit.slice(0, 7)}${job.source?.branch ? ' on ' + job.source.branch : ''}`;
  return job.source?.branch ? `latest on ${job.source.branch}` : '';
}
function renderJobs() {
  const snapshot = JSON.stringify([jobs, selectedJob, prefs(), machines.map(node => [node.id, node.hostname])]);
  if (snapshot === jobSnapshot) return; jobSnapshot = snapshot;
  $('jobs').replaceChildren(); $('no-jobs').hidden = Boolean(jobs.length);
  for (const job of jobs) {
    const row = element('tr', undefined, selectedJob === job.id ? 'selected' : '');
    const first = element('td'); const project = projects.find(item => item.id === job.projectId);
    const what = jobKindName(job) ?? (job.product || 'build');
    const button = element('button', `${project?.name || job.projectId} / ${what}`, 'build-link');
    button.setAttribute('aria-label', `Open ${project?.name || job.projectId} ${what} ${job.id.slice(0, 8)}`);
    button.addEventListener('click', () => action(button, () => selectJob(job.id)));
    const source = element('div', jobSourceText(job), 'muted small'); source.title = 'Build ' + job.id;
    first.append(button, source);
    const status = element('td'); status.append(badge(job.state));
    const machine = machines.find(item => item.id === job.nodeId);
    const where = element('td', machine?.hostname || (job.nodeId ? job.nodeId.slice(0, 8) : 'Waiting for a machine'));
    if (!job.nodeId && job.waiting) where.append(element('div', job.waiting, 'muted small'));   // why each machine has not taken it
    row.append(first, status, where, element('td', date(job.createdAt)));
    $('jobs').append(row);
  }
}
async function selectJob(id) {
  selectionGeneration++;
  $('job-artifacts').replaceChildren(); artifactSnapshot = '';
  selectedJob = id; afterSeq = -1; logCharacters = 0; trimmedLogs = false; logStart = null; $('logs').replaceChildren(); $('job-result').hidden = true;
  $('copy-build-output').disabled = true; $('copy-build-status').textContent = '';
  $('job-detail').hidden = false; $('job-title').textContent = 'Build output'; $('job-meta').textContent = 'Loading…'; $('cancel').hidden = true;
  renderJobs(); await refreshJob(generation, id);
  $('job-detail').scrollIntoView({ behavior: 'auto', block: 'nearest' });
}
async function refreshJob(current, id) {
  const selection = selectionGeneration;
  const path = base() + '/jobs/' + encodeURIComponent(id);
  const cursor = afterSeq;
  const [job, log] = await Promise.all([api(path), api(`${path}/logs?after=${cursor}`)]);
  if (current !== generation || selection !== selectionGeneration || id !== selectedJob) return;
  $('job-title').textContent = `${projects.find(item => item.id === job.projectId)?.name || job.projectId} / ${jobKindName(job) ?? (job.product || 'build')}`;
  $('job-meta').textContent = [job.state, date(job.createdAt), jobSourceText(job)].filter(Boolean).join(' · '); $('job-meta').title = 'Build ' + job.id;
  $('cancel').hidden = !activeStates.has(job.state);
  $('job-result').hidden = !job.result;
  $('job-result').textContent = job.result ? `${job.result.message || job.result.status || job.state}${job.result.exitCode !== undefined ? ` · Exit code ${job.result.exitCode}` : ''}` : '';
  renderWaiting(job);
  const outputs = JSON.stringify([job.id, job.state, job.artifacts]);
  if (outputs !== artifactSnapshot) {
    artifactSnapshot = outputs; $('job-artifacts').replaceChildren();
    for (const artifact of job.artifacts || []) {
      const row = element('p'); const link = element('a', `Download ${artifact.name}`);
      link.href = path + '/artifacts/' + encodeURIComponent(artifact.name);
      row.append(link, element('span', ` · ${(artifact.size / 1048576).toFixed(2)} MiB · SHA-256 ${artifact.sha256}`, 'muted small'));
      $('job-artifacts').append(row);
    }
    if (job.product === 'self-release' && job.state === 'success') $('job-artifacts').append(element('p', 'Candidate built and tested. It has not been activated. Use the standalone updater to review its targets and explicitly promote this exact package.', 'muted small'));
  }
  const output = $('logs'); const follow = prefs().followOutput && output.scrollHeight - output.scrollTop - output.clientHeight < 80;
  // Multiple refreshes can overlap after a user action. Sequence filtering prevents duplicate output.
  for (const chunk of log.chunks) {
    if (chunk.seq <= afterSeq) continue;
    const lines = Array.isArray(chunk.lines) ? chunk.lines : String(chunk.lines).split('\n');
    const prefix = stamp(chunk.at);
    const span = element('span', undefined, chunk.stream === 'stderr' ? 'stderr' : 'stdout');
    for (const line of lines) {
      if (prefix) span.append(element('span', prefix, 'stamp'));
      span.append(document.createTextNode(line + '\n'));
    }
    output.append(span);
    logCharacters += span.textContent.length;
    afterSeq = chunk.seq;
  }
  while (output.childNodes.length > 1 && (output.childNodes.length > 1500 || logCharacters > 500000)) {
    logCharacters -= output.firstChild.textContent.length; output.firstChild.remove(); trimmedLogs = true;
  }
  if (follow) output.scrollTop = output.scrollHeight;
  $('copy-build-output').disabled = !output.textContent;
  $('log-status').textContent = (trimmedLogs ? 'Showing the most recent output. ' : '') + (activeStates.has(job.state) ? (output.childNodes.length ? 'Following live output…' : 'Waiting for build output…') : (output.childNodes.length ? 'Build finished. Output retained above.' : 'Build finished without captured output.'));
}
// A queued build says on its own page why no machine has taken it, machine by machine, with the one fix where a person
// gives it: a label the build needs (smith-deploy, say) that the agent does not advertise by itself.
let waitingSnapshot = '';
function renderWaiting(job) {
  const box = $('job-waiting'), machinesWaiting = job.state === 'queued' ? job.waitingMachines || [] : [];
  const snapshot = JSON.stringify([job.id, job.state, job.waiting, machinesWaiting, adminRole()]);
  if (snapshot === waitingSnapshot) return; waitingSnapshot = snapshot;
  box.replaceChildren(); box.hidden = job.state !== 'queued';
  if (box.hidden) return;
  box.append(element('p', machinesWaiting.length ? 'No machine has taken this build:' : 'No machine has taken this build: no build machine is connected.'));
  for (const waiting of machinesWaiting) {
    const row = element('p', undefined, 'small'); row.append(element('span', waiting.reason));
    if (waiting.addLabels?.length && adminRole()) {
      const machine = machines.find(item => item.id === waiting.nodeId), list = waiting.addLabels.join(', ');
      const button = element('button', `Add ${list} to ${waiting.hostname}`, 'quiet');
      button.addEventListener('click', () => action(button, async () => {
        if (!confirm(`Give ${waiting.hostname} the label${waiting.addLabels.length === 1 ? '' : 's'} ${list}?\n\nIt then takes this build (${job.product}) and every later build that needs ${list}. You can remove it from the machine's card.`)) return;
        await api(`${base()}/nodes/${encodeURIComponent(waiting.nodeId)}/labels`, { labels: [...new Set([...(machine?.assignedLabels || []), ...waiting.addLabels])] });
        await refresh(); await refreshJob(generation, job.id);
      }));
      row.append(button);
    } else if (waiting.addLabels?.length) row.append(element('span', 'A workspace admin can add it.', 'muted'));
    box.append(row);
  }
}
async function refresh(includeProjects = false) {
  if (!signedIn || !workspaceId) return;
  // A copy in flight changes the project itself (status, then source), so keep projects fresh too.
  if (pendingCopies().length || projects.some(project => copying.has(project.artifacts?.status) || copying.has(project.hosted?.status) || (project.kind === 'repo' && ['waiting', 'scanning'].includes(project.scan?.state)))) includeProjects = true;
  const current = generation; const path = base();
  clearTimeout(timer);
  try {
    const [nodeResponse, jobResponse, projectResponse, settingsResponse] = await Promise.all([
      api(path + '/nodes'), api(path + '/jobs'), includeProjects ? api(path + '/projects') : Promise.resolve(null),
      includeProjects || !workspaceSettings ? api(path + '/settings') : Promise.resolve(null),
    ]);
    if (current !== generation) return;
    const couldCopy = canCopy(), heldBefore = JSON.stringify(machines.map(machine => [machine.id, machine.hosted]));
    machines = nodeResponse.nodes; jobs = jobResponse.jobs;
    if (settingsResponse) { workspaceSettings = settingsResponse; $('open-import').hidden = !adminRole(); renderWorkspaceSettings(); }
    if (projectResponse) { projects = projectResponse.projects; renderProjects(); if (pendingCopies().length) await fulfilPendingCopies(); }
    // A host came or went, or copies moved: the copy buttons and "kept on" lines follow.
    else if (couldCopy !== canCopy() || heldBefore !== JSON.stringify(machines.map(machine => [machine.id, machine.hosted]))) renderProjects();
    renderMachines(); renderJobs();
    // Chat and crew problems (for example an older coordinator without them) must not hide build status; the first
    // one stays on the connection line for this tick instead of "Connected".
    let partFailed = null;
    try { await chat.refresh(); if (includeProjects) await agents.refresh(); } catch (error) { if (error.status !== 404) partFailed = `AI chats could not refresh: ${error.message}`; }
    try { const previousMembers = JSON.stringify(crew.getMembers()); await crew.refresh(); if (current === generation && (includeProjects || previousMembers !== JSON.stringify(crew.getMembers()))) renderWorkspaceSettings(); } catch (error) { if (error.status !== 404) partFailed ??= `The crew could not refresh: ${error.message}`; }
    try { await pulls.refresh(); } catch (error) { if (error.status !== 404) partFailed ??= `Pull requests could not refresh: ${error.message}`; }
    if (selectedJob) await refreshJob(current, selectedJob);
    if (current === generation) connection(partFailed ?? 'Connected · updated ' + time(Date.now()), partFailed ? 'offline' : 'online');
  } catch (error) {
    if (current !== generation) return;
    connection(error.message, 'offline');
    if (includeProjects) showError(error);
  } finally {
    if (signedIn && current === generation) {
      clearTimeout(timer);
      timer = setTimeout(() => { if (!document.hidden) void refresh(); else scheduleVisibleRefresh(); }, refreshMs());
    }
  }
}
function refreshMs() { return Math.min(60, Math.max(2, Number(prefs().refreshSeconds) || 2)) * 1000; }
function scheduleVisibleRefresh() {
  // While an AI reply is running, a background tab keeps following the chats (and nothing else), so a
  // question from Claude Code or Codex still reaches you as a notification and in the tab title.
  const following = signedIn && chat.busy();
  timer = setTimeout(async () => {
    if (!document.hidden) { void refresh(); return; }
    if (following) { const current = generation; try { await chat.refresh(); } catch { /* reported once the tab is visible */ } if (current !== generation) return; }
    scheduleVisibleRefresh();
  }, following ? Math.max(5000, refreshMs()) : refreshMs());
}

// ---- Settings ----
function showSettings(open) {
  if (!signedIn) return;
  $('settings').hidden = !open; $('dashboard').hidden = open;
  if (open) { renderAccountSettings(); renderWorkspaceSettings(); $('account-status').textContent = ''; $('workspace-status').textContent = ''; if (workspaceId) void members.refresh().catch(showError); }
}
function timeZoneOptions() {
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const current = prefs().timeZone; const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const select = $('time-zone'); select.replaceChildren();
  const auto = element('option', `Browser (${local || 'local time'})`); auto.value = 'auto'; select.append(auto);
  if (zones.length && !zones.includes(current) && current !== 'auto') zones.unshift(current);
  if (!zones.length && current !== 'auto') zones.push(current);
  for (const zone of zones) { const option = element('option', zone.replaceAll('_', ' ')); option.value = zone; select.append(option); }
  select.value = current;
}
function renderAccountSettings() {
  const p = prefs();
  $('display-name').value = account.displayName; $('email').value = account.email;
  timeZoneOptions();
  $('clock').value = p.clock; $('log-timestamps').value = p.logTimestamps;
  $('refresh-seconds').value = p.refreshSeconds; $('follow-output').checked = Boolean(p.followOutput);
}
function renderWorkspaceSettings() {
  const form = $('workspace-form'); const s = workspaceSettings;
  const editable = Boolean(s?.canEdit);
  form.setAttribute('aria-disabled', String(!editable));
  for (const control of form.querySelectorAll('input, button, textarea, select')) control.disabled = !s || !editable;
  $('workspace-readonly').hidden = !s || editable;
  $('rename-workspace').hidden = !editable || !$('rename-workspace-form').hidden;
  if (!s) { $('workspace-status').textContent = workspaceId ? 'Loading…' : 'Select a workspace to edit its settings.'; return; }
  // Shown once the coordinator reports the count (an older one does not).
  const builds = s.lifetimeBuildsUsed;
  $('crew-builds-used').hidden = typeof builds !== 'number';
  $('crew-builds-used').textContent = typeof builds === 'number' ? `${builds.toLocaleString()} of 1,000 lifetime builds used` : '';
  if (renderedSettingsWorkspace === workspaceId && document.activeElement && form.contains(document.activeElement)) return;   // don't clobber in-progress edits in this workspace
  renderedSettingsWorkspace = workspaceId;
  $('workspace-name').value = s.name || ''; $('node-offline-seconds').value = s.nodeOfflineSeconds || 60;
  $('lfs-status').textContent = s.lfs ? lfsSummary(s.lfs) : ''; $('lfs-mode').textContent = lfsModeText(s.lfs);
  $('lfs-direct-help').hidden = s.lfs?.mode === 'direct';
  $('lfs-quota-gb').value = Math.round((s.lfsQuotaBytes ?? 5368709120) / 1073741824);
  $('lfs-reserve-gb').value = Math.round((s.lfsMachineReserveBytes ?? 10737418240) / 1073741824);
  $('copies-status').textContent = underReplicatedText(s.copies, s.copiesPerItem || 2);
  $('copy-budget-gb').value = Math.round((s.copyBudgetBytes ?? 53687091200) / 1073741824); $('copies-per-item').value = s.copiesPerItem ?? 2;
  $('lfs-import-threshold-mb').value = Math.round((s.lfsImportThresholdBytes ?? 10485760) / 1048576);
  $('lfs-check-status').textContent = s.lfs ? (s.lfs.checking ? `checking ${s.lfs.checking}…` : s.lfs.lost ? `${s.lfs.lost} lost, being restored` : 'all present at the last check') : '';
  $('supersede-queued').checked = Boolean(s.supersedeQueued); $('cloudflare-account-id').value = s.cloudflareAccountId || '';
  // Shown only when the coordinator admits a Google Workspace domain (GOOGLE_ALLOWED_DOMAIN).
  $('studio-access-section').hidden = !s.studioDomain; $('studio-access').value = s.studioAccess || 'off';
  $('studio-access-help').textContent = s.studioDomain ? `Anyone who signs in with a Google account of ${s.studioDomain} joins this workspace with this role. Turning it off removes them again, except people whose role was set by hand under People.` : '';
  $('cloudflare-token').value = ''; $('clear-cloudflare-token').checked = false;
  $('cloudflare-token').placeholder = s.cloudflareApiTokenSet ? '•••••••• token stored (blank keeps it)' : 'Paste a Cloudflare API token';
  $('clear-cloudflare-token').parentElement.parentElement.hidden = !s.cloudflareApiTokenSet;
  $('cloudflare-status').textContent = s.cloudflareApiTokenSet ? `● token set${s.cloudflareApiTokenUpdatedAt ? ' · updated ' + date(s.cloudflareApiTokenUpdatedAt) : ''}` : '○ no token';
  $('github-token').value = ''; $('clear-github-token').checked = false;
  $('github-token').placeholder = s.githubTokenSet ? '•••••••• token stored (blank keeps it)' : 'Paste a GitHub token (github_pat_…)';
  $('clear-github-token').parentElement.parentElement.hidden = !s.githubTokenSet;
  $('github-status').textContent = s.githubTokenSet ? `● token set${s.githubTokenUpdatedAt ? ' · updated ' + date(s.githubTokenUpdatedAt) : ''}` : '○ no token';
  $('crew-may-create').checked = Boolean(s.crewMayCreateProjects); $('crew-stopped').checked = Boolean(s.crewStopped);
  $('crew-concurrent').value = s.crewMaxConcurrentRuns ?? 1; $('crew-daily-usd').value = s.crewDailyUsdLimit ?? 10;
  renderAiOrder(s.aiOrder || ['claude', 'gpt', 'local']);
  $('checkin-enabled').checked = Boolean(s.orchestration?.enabled);
  const { enabled: _checkinEnabled, concurrency = { cheap: 8, medium: 3, expensive: 1 }, globalStartsPerHour = 60, ...checkinPolicy } = s.orchestration || { eventBudgets: { low: 3, normal: 8, high: 15, pr_ready: 25, release_candidate: 50 }, maxDepth: 2, maxRuns: 6 };
  for (const costClass of ['cheap', 'medium', 'expensive']) $(`checkin-${costClass}-limit`).value = concurrency[costClass];
  $('checkin-starts-limit').value = globalStartsPerHour;
  $('checkin-policy').value = JSON.stringify(checkinPolicy, null, 2);
  readProjectAutomation = renderProjectAutomation({ container: $('checkin-project-automation'), projects, policy: s.orchestration, members: crew.getMembers(), element, editable });
  $('checkin-webhook-secret').value = ''; $('clear-checkin-webhook-secret').checked = false;
  $('checkin-webhook-secret').placeholder = s.checkInWebhookSecretSet ? 'Secret stored (blank keeps it)' : 'Paste a webhook secret';
  $('clear-checkin-webhook-secret').parentElement.hidden = !s.checkInWebhookSecretSet;
  $('checkin-webhook-url').textContent = `Webhook URL: ${location.origin}${base()}/crew/webhooks/github/PROJECT_ID (replace PROJECT_ID with the registered project ID).`;
  $('anthropic-key').value = ''; $('clear-anthropic-key').checked = false;
  $('anthropic-key').placeholder = s.anthropicApiKeySet ? '•••••••• key stored (blank keeps it)' : 'Paste an Anthropic API key (sk-ant-…)';
  $('clear-anthropic-key').parentElement.parentElement.hidden = !s.anthropicApiKeySet;
  $('anthropic-status').textContent = s.anthropicApiKeySet ? `● API key set${s.anthropicApiKeyUpdatedAt ? ' · updated ' + date(s.anthropicApiKeyUpdatedAt) : ''}` : '○ no API key';
  renderProjectCount();
}
// The workspace's AI order (aiOrder in src/settings.ts): three lists, each kind chosen once; a later list offers "nothing".
const AI_ORDER_KINDS = [['claude', 'Claude'], ['gpt', 'GPT (Codex)'], ['local', 'Local model']];
function renderAiOrder(order) {
  [1, 2, 3].forEach((n, i) => {
    const select = $(`ai-order-${n}`);
    select.replaceChildren(...[...(n > 1 ? [['', 'Nothing more']] : []), ...AI_ORDER_KINDS].map(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; return option; }));
    select.value = order[i] ?? '';
  });
}
// The order as chosen, top to bottom, stopping at the first "Nothing more" and skipping a kind already chosen above.
function aiOrderValue() {
  const order = [];
  for (const n of [1, 2, 3]) { const value = $(`ai-order-${n}`).value; if (!value) break; if (!order.includes(value)) order.push(value); }
  return order;
}
// Crew-created projects count inside the workspace's 20-project cap, so the Crew settings show how much room is left.
function renderProjectCount() { $('crew-projects-used').textContent = `${projects.length} of 20 projects`; }
function flash(id, text) { $(id).textContent = text; setTimeout(() => { if ($(id).textContent === text) $(id).textContent = ''; }, 4000); }
$('account-form').addEventListener('submit', event => {
  event.preventDefault();
  void action(event.submitter, async () => {
    const identity = await api('/auth/profile', {
      displayName: $('display-name').value.trim(), email: $('email').value.trim(),
      preferences: { timeZone: $('time-zone').value, clock: $('clock').value, logTimestamps: $('log-timestamps').value,
        followOutput: $('follow-output').checked, refreshSeconds: Math.round(Number($('refresh-seconds').value) || 2) },
    });
    applyIdentity(identity); renderAccountSettings();
    nodeSnapshot = ''; jobSnapshot = ''; renderMachines(); renderJobs();
    flash('account-status', 'Saved');
  });
});
$('workspace-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!workspaceId) return;
  void action(event.submitter, async () => {
    const body = {
      name: $('workspace-name').value.trim(), nodeOfflineSeconds: Math.round(Number($('node-offline-seconds').value) || 60),
      lfsQuotaBytes: Math.round(Number($('lfs-quota-gb').value) || 0) * 1073741824,
      lfsMachineReserveBytes: Math.round(Number($('lfs-reserve-gb').value) || 10) * 1073741824,
      copyBudgetBytes: Math.round(Number($('copy-budget-gb').value) || 50) * 1073741824, copiesPerItem: Math.round(Number($('copies-per-item').value) || 2),
      lfsImportThresholdBytes: Math.round(Number($('lfs-import-threshold-mb').value) || 10) * 1048576,
      supersedeQueued: $('supersede-queued').checked, cloudflareAccountId: $('cloudflare-account-id').value.trim().toLowerCase(),
      crewMayCreateProjects: $('crew-may-create').checked, crewMaxConcurrentRuns: Math.round(Number($('crew-concurrent').value) || 1),
      crewDailyUsdLimit: Math.round(Number($('crew-daily-usd').value)), crewStopped: $('crew-stopped').checked,
      aiOrder: aiOrderValue(),
      orchestration: parseWorkspacePolicy($('checkin-policy').value, $('checkin-enabled').checked, {
        cheap: $('checkin-cheap-limit').value, medium: $('checkin-medium-limit').value,
        expensive: $('checkin-expensive-limit').value, startsPerHour: $('checkin-starts-limit').value,
      }, readProjectAutomation()),
    };
    if (workspaceSettings?.studioDomain) body.studioAccess = $('studio-access').value;
    if ($('clear-cloudflare-token').checked) body.clearCloudflareApiToken = true;
    else if ($('cloudflare-token').value.trim()) body.cloudflareApiToken = $('cloudflare-token').value.trim();
    if ($('clear-github-token').checked) body.clearGithubToken = true;
    else if ($('github-token').value.trim()) body.githubToken = $('github-token').value.trim();
    if ($('clear-anthropic-key').checked) body.clearAnthropicApiKey = true;
    else if ($('anthropic-key').value.trim()) body.anthropicApiKey = $('anthropic-key').value.trim();
    if ($('clear-checkin-webhook-secret').checked) body.clearCheckInWebhookSecret = true;
    else if ($('checkin-webhook-secret').value.trim()) body.checkInWebhookSecret = $('checkin-webhook-secret').value.trim();
    const current = generation;
    const saved = await api(base() + '/settings', body);
    if (current !== generation) return;
    $('cloudflare-token').value = ''; $('github-token').value = ''; $('anthropic-key').value = ''; $('checkin-webhook-secret').value = ''; document.activeElement?.blur?.();
    workspaceSettings = saved; renderWorkspaceSettings(); nodeSnapshot = ''; renderMachines(); void members.refresh().catch(showError);
    const option = $('workspace').selectedOptions[0]; if (option) option.textContent = `${saved.name} · ${workspaceId.slice(0, 8)}`;
    flash('workspace-status', 'Saved');
  });
});
$('open-settings').addEventListener('click', event => { event.preventDefault(); location.hash = '#settings'; });
$('close-settings').addEventListener('click', event => { event.preventDefault(); history.pushState(null, '', location.pathname); showSettings(false); });
window.addEventListener('hashchange', () => showSettings(location.hash === '#settings'));

$('login-form').addEventListener('submit', event => {
  event.preventDefault();
  void action(event.submitter, async () => {
    const identity = await api('/auth/invite', { code: $('invite-code').value.trim() });
    await enterDashboard(identity);
  });
});
$('logout').addEventListener('click', () => action($('logout'), async () => { await api('/auth/logout', {}); resetSession(); }));
$('dismiss-error').addEventListener('click', clearError);
$('workspace').addEventListener('change', () => action($('workspace'), () => selectWorkspace($('workspace').value)));
$('refresh').addEventListener('click', () => action($('refresh'), () => workspaceId ? refresh(true) : loadWorkspaces()));
// Rename swaps the picker for a name box in place; Save keeps it, Cancel or Escape puts the picker back.
function closeRename() {
  $('rename-workspace-form').hidden = true; $('workspace').parentElement.hidden = false;
  $('rename-workspace').hidden = !workspaceSettings?.canEdit;
}
$('rename-workspace').addEventListener('click', () => {
  $('workspace').parentElement.hidden = true; $('rename-workspace').hidden = true; $('rename-workspace-form').hidden = false;
  $('rename-workspace-name').value = workspaceSettings?.name || ''; $('rename-workspace-name').select();
});
$('rename-workspace-cancel').addEventListener('click', closeRename);
$('rename-workspace-form').addEventListener('keydown', event => { if (event.key === 'Escape') closeRename(); });
$('rename-workspace-form').addEventListener('submit', event => {
  event.preventDefault();
  const name = $('rename-workspace-name').value.trim();
  if (!workspaceId || !name) return;
  void action(event.submitter, async () => {
    const current = generation;
    const saved = await api(base() + '/settings', { name });
    if (current !== generation) return;
    workspaceSettings = saved; closeRename(); renderWorkspaceSettings();
    const option = $('workspace').selectedOptions[0]; if (option) option.textContent = `${saved.name} · ${workspaceId.slice(0, 8)}`;
  });
});
$('create-workspace').addEventListener('click', () => action($('create-workspace'), async () => {
  const result = await api('/api/v2/workspaces', { requestId: crypto.randomUUID() }); await loadWorkspaces(result.workspaceId);
}));
$('cancel').addEventListener('click', () => action($('cancel'), async () => {
  if (selectedJob) { await api(base() + '/jobs/' + encodeURIComponent(selectedJob) + '/cancel', {}); await refresh(); }
}));
for (const [id, purpose] of [['enroll', 'build'], ['enroll-personal', 'personal']]) $(id).addEventListener('click', () => action($(id), async () => {
  const current = generation; const result = await api(base() + '/enrollments', { purpose });
  if (current !== generation) return;
  $('enrollment-title').textContent = purpose === 'personal' ? 'Connect your computer' : 'Connect a build machine';
  $('enrollment-purpose').textContent = purpose === 'personal'
    ? 'This computer will be yours alone. It never runs workspace builds. Smith will detect Claude Code, Codex and any models running on it; sign in to Claude Code and Codex yourself on this computer. Smith never sees those logins.'
    : 'This machine will run workspace builds for compatible projects.';
  $('enrollment-command').textContent = 'Setup-Smith.bat';
  // One paste carries both: the agent splits "<workspace id>:<enrollment code>".
  $('enrollment-code').value = `${workspaceId}:${result.code}`; $('copy-enrollment-code').textContent = 'Copy'; $('enrollment-expiry').textContent = `Expires ${date(result.expiresAt)}. This code connects one machine.`;
  $('enrollment').showModal();
  void renderDownloads(workspaceId);
}));
// One line per OS package: a link when its zip has been uploaded, "coming soon" until then.
// The command block gains the POSIX launcher once a macOS or Linux package exists.
async function renderDownloads(forWorkspace) {
  let packages;
  try { ({ packages } = await api('/api/v2/downloads')); } catch { return; }   // keep the static list
  if (forWorkspace !== workspaceId) return;
  const list = $('enrollment-downloads'); list.replaceChildren();
  const labels = { windows: 'Windows', mac: 'macOS', linux: 'Linux' };
  for (const os of Object.keys(labels)) {
    const item = document.createElement('li'); const info = packages[os];
    if (info?.available) { const link = document.createElement('a'); link.href = info.path; link.textContent = labels[os]; item.append(link); }
    else { item.append(labels[os] + ' '); const soon = document.createElement('span'); soon.className = 'muted'; soon.textContent = '(coming soon)'; item.append(soon); }
    list.append(item);
  }
  const posix = packages.mac?.available || packages.linux?.available;
  $('enrollment-command').textContent = 'Setup-Smith.bat' + (posix ? '\nsh start-smith.sh agent      (macOS/Linux)' : '');
}
$('close-enrollment').addEventListener('click', () => $('enrollment').close());
$('copy-enrollment-code').addEventListener('click', async () => {
  const field = $('enrollment-code');
  try { await navigator.clipboard.writeText(field.value); $('copy-enrollment-code').textContent = 'Copied'; }
  catch { field.focus(); field.select(); }   // no clipboard access: leave it selected for Ctrl+C
});
// Add project: pick a repository (or, with no GitHub link, paste a URL), optionally a branch,
// and tick whether Smith keeps its own copy (only offered when the account supports it). One form, nothing else to configure.
let repoChoices = [];
let reopenAddProject = false;   // set when "Connect GitHub" was clicked from the Add project dialog
const OTHER_REPO = '::other';
function option(value, text, disabled = false) { const node = element('option', text); node.value = value; node.disabled = disabled; return node; }
function showUrlField(show) { $('git-url-field').hidden = !show; $('git-url').required = show && projectSource() === 'git'; if (show && projectSource() === 'git') $('git-url').focus(); }
async function loadRepoPicker() {
  const pick = $('git-repo-pick'); const current = generation;
  pick.replaceChildren(option('', 'Loading…', true)); pick.disabled = true; $('git-repo-hint').textContent = ''; showUrlField(false);
  try {
    const result = await api(base() + '/github/repos');
    if (current !== generation) return;
    repoChoices = result.repos || [];
    $('connect-github').hidden = true; $('install-github').hidden = true;
    if (!result.configured) {
      // Nothing to list until this person links GitHub: one click, back here afterwards.
      pick.replaceChildren(option('', 'Connect GitHub to choose from your repositories', true), option(OTHER_REPO, 'Another Git repository (paste its URL)…'));
      pick.disabled = false;
      $('connect-github').hidden = !signinProviders.includes('github');
      if (!signinProviders.includes('github')) { pick.value = OTHER_REPO; showUrlField(true); }
      return;
    }
    pick.replaceChildren(option('', repoChoices.length ? 'Choose a repository…' : 'GitHub shows no repositories for your account yet', true),
      ...repoChoices.map(repo => option(repo.fullName, `${repo.fullName}${repo.private ? ' (private)' : ''}`)), option(OTHER_REPO, 'Another Git repository (paste its URL)…'));
    pick.disabled = false;
    // A GitHub App only reveals the accounts it is installed on: offer the install when some are missing.
    if (result.installUrl && result.via === 'link') { $('install-github').href = result.installUrl; $('install-github').hidden = false; }
    if (!repoChoices.length && !result.installUrl) $('git-repo-hint').textContent = 'If a repository you expect is missing, the Smith GitHub App may not be installed on that organisation yet.';
  } catch (error) {
    if (current !== generation) return;
    pick.replaceChildren(option('', 'Could not list repositories', true), option(OTHER_REPO, 'Another Git repository (paste its URL)…')); pick.disabled = false;
    $('git-repo-hint').textContent = error.message;
  }
}
$('connect-github').addEventListener('click', () => action($('connect-github'), async () => {
  sessionStorage.setItem('smith.reopen-add-project', '1');
  const { url } = await api('/auth/link/github', {}); location.assign(url);
}));
$('git-repo-pick').addEventListener('change', () => {
  const value = $('git-repo-pick').value;
  $('git-branches').replaceChildren();
  if (value === OTHER_REPO) { $('git-url').value = ''; $('git-repo-hint').textContent = ''; showUrlField(true); return; }
  showUrlField(false);
  const repo = repoChoices.find(item => item.fullName === value);
  if (!repo) return;
  $('git-url').value = repo.url; $('git-branch').value = repo.defaultBranch || ''; $('git-repo-hint').textContent = `${repo.url} · default branch ${repo.defaultBranch}`;
  const current = generation;
  void api(base() + '/github/branches?repo=' + encodeURIComponent(repo.fullName)).then(result => {
    if (current !== generation || $('git-repo-pick').value !== repo.fullName) return;
    $('git-branches').replaceChildren(...(result.branches || []).map(name => option(name, name)));
  }).catch(() => { /* the typed branch still works; the default is already filled in */ });
});
// Where a new project starts: a Git repository, nothing (an empty repository Smith creates), or a zip of its files. The
// last two live only in Smith's copies, so they need a machine that keeps copies; without one the dialog says which switch.
const projectSource = () => document.querySelector('input[name="project-source"]:checked')?.value || 'git';
function applyProjectSource() {
  const source = projectSource(), fresh = source !== 'git';
  $('git-source-fields').hidden = fresh; $('new-source-fields').hidden = !fresh; $('zip-field').hidden = source !== 'zip';
  $('new-project-name').required = fresh; $('new-project-zip').required = source === 'zip';
  $('git-url').required = !fresh && !$('git-url-field').hidden;   // a hidden required field would block the form silently
  $('artifacts-choice').hidden = fresh || !canCopy();
  $('git-branch').placeholder = fresh ? 'main' : 'Default branch';
  $('source-explainer').textContent = !fresh ? "Smith reads the repository's smith.json and offers its build actions, which build the newest commit on the branch."
    : `${artifactsAvailable() ? 'Smith creates the repository on Cloudflare Artifacts, so no machine needs to be online; machines that keep copies take their own copies when they are, and Artifacts is kept current.' : 'Smith creates the repository on the machines that keep copies, backs it up, and serves it from this site.'} Clone it, push to it, and link it to GitHub later if you like. ${source === 'zip' ? 'The files become its first commit (a .gitignore in the zip is honoured; a .git folder is left out). Files over 32 MB need a machine that keeps copies.' : 'It starts with one commit holding a README.'} Push a smith.json to get build actions.`;
  const blocked = fresh && !hostingAvailable() && !artifactsAvailable();
  $('new-source-blocked').hidden = !blocked;
  $('new-source-blocked').textContent = blocked ? 'Smith has nowhere to keep a new project yet. Set up Cloudflare Artifacts in workspace Settings, or turn on “Keep copies of repositories here” on a build machine (online, git 2.36 or newer, 2 GB free) under Machines.' : '';
  $('submit-add-project').textContent = fresh ? 'Create project' : 'Add project';
  if (fresh && !$('new-project-name').value) $('new-project-name').focus();
}
for (const radio of document.querySelectorAll('input[name="project-source"]')) radio.addEventListener('change', applyProjectSource);
$('new-project-zip').addEventListener('change', () => {
  const file = $('new-project-zip').files?.[0];
  if (file && !$('new-project-name').value.trim()) $('new-project-name').value = file.name.replace(/\.zip$/i, '');
});
// The zip goes up as raw bytes in one request (Cloudflare caps a request at 100 MB), so it skips api()'s JSON and 15 s timeout.
async function uploadProjectZip(file, name, branch) {
  if (file.size > 100 * 1024 * 1024) throw new Error('That zip is larger than 100 MB. Start an empty project instead and push the files to it with git.');
  const query = new URLSearchParams({ name, file: file.name }); if (branch) query.set('branch', branch);
  let response;
  try {
    response = await fetch(base() + '/projects/import?' + query, { method: 'POST', credentials: 'same-origin', cache: 'no-store', body: file,
      headers: { 'Content-Type': 'application/zip', ...(csrfToken ? { 'X-Smith-CSRF': csrfToken } : {}) } });
  } catch { throw new Error('Cannot reach Smith. Check your connection and try again.'); }
  const value = await response.json().catch(() => null);
  if (response.status === 401) resetSession();
  if (!response.ok) throw new Error(value?.error?.message || `Upload failed (${response.status}). Try again.`);
  return value;
}
$('add-project').addEventListener('click', () => openAddProject());
function openAddProject() {
  $('add-project-form').reset(); $('git-branches').replaceChildren();
  $('artifacts-choice').hidden = !canCopy();
  $('artifacts-choice-hint').textContent = hostingAvailable() ? 'Kept on the build machines switched on to keep copies and served from this site; builds, chats and crew members work on that copy.'
    : workspaceSettings?.artifactsSource === 'workspace' ? 'Kept in your own Cloudflare account (the token in workspace Settings). Crew members need this copy to work on the project.' : 'Crew members need this copy to work on the project.';
  $('add-project-dialog').showModal(); applyProjectSource(); $('git-repo-pick').focus();
  void loadRepoPicker();
}
$('close-add-project').addEventListener('click', () => $('add-project-dialog').close());
$('add-project-form').addEventListener('submit', event => {
  event.preventDefault();
  void action($('submit-add-project'), async () => {
    const source = projectSource();
    if (source !== 'git') {
      if (!hostingAvailable() && !artifactsAvailable()) throw new Error($('new-source-blocked').textContent);
      const name = $('new-project-name').value.trim(), branch = $('git-branch').value.trim(), file = $('new-project-zip').files?.[0];
      if (!name) throw new Error('Give the project a name.');
      if (source === 'zip' && !file) throw new Error('Choose the zip to upload.');
      const current = generation;
      if (source === 'zip') {
        $('submit-add-project').textContent = 'Uploading…';
        try { await uploadProjectZip(file, name, branch); } finally { $('submit-add-project').textContent = 'Create project'; }
      }
      else await api(base() + '/projects', { source: 'empty', name, ...(branch ? { branch } : {}) });
      if (current !== generation) return;
      $('add-project-dialog').close(); $('add-project-form').reset();
      await refresh(true);
      return;
    }
    const url = $('git-url').value.trim();
    if (!url) throw new Error('Choose a repository first.');
    const body = { source: 'git', url };
    if ($('git-branch').value.trim()) body.branch = $('git-branch').value.trim();
    const created = await api(base() + '/projects', body);
    if (current !== generation) return;
    $('add-project-dialog').close(); $('add-project-form').reset();
    // The checkbox: copy now when the repository was read already, else as soon as a machine has read it.
    if (canCopy() && $('store-on-artifacts').checked && !created.artifacts && !created.hosted && !onSmithCopy(created) && !/\.artifacts\.cloudflare\.net\//.test(created.repoUrl)) rememberCopy(created.id);
    await refresh(true);
  });
});
$('enrollment').addEventListener('close', () => { $('enrollment-code').value = ''; });
window.addEventListener('online', () => { if (signedIn) void refresh(true); });
window.addEventListener('offline', () => connection('Offline · reconnect to receive build updates', 'offline'));
document.addEventListener('visibilitychange', () => { if (!document.hidden && signedIn) void refresh(); });

const chat = createChat({ $, api, base, element, action, badge, projects: () => projects, generation: () => generation, jobs: () => jobs, openJob: id => { void selectJob(id).catch(showError); },
  openPull: id => pulls.openFor(p => p.id === id) });
const agents = createAgentAccess({ $, api, base, element, action, date, generation: () => generation });
const members = createMembers({ $, api, base, element, action, date, generation: () => generation });
// A crew proposal's card links to its pull request (pulls is created just below; these run only later, on clicks and renders).
const crew = createCrew({ $, api, base, element, action, badge, date, projects: () => projects, machines: () => machines, settings: () => workspaceSettings, generation: () => generation,
  pullOf: sessionId => pulls.all().find(p => p.crew?.sessionId === sessionId) ?? null, openPull: sessionId => pulls.openFor(p => p.crew?.sessionId === sessionId) });
const pulls = createPulls({ $, api, base, element, badge, date, action, settings: () => workspaceSettings, generation: () => generation });
// Import from GitHub: owners and admins; the panel polls its own import while the dialog is open.
const imports = createImports({ api, base, element, action, refresh, selectJob, settings: () => workspaceSettings });
$('pulls-filter').addEventListener('change', () => { void pulls.setFilter($('pulls-filter').value).catch(showError); });

// The deployed version (0.1.0.<commit count>) and commit, beside "Experiment"; a local `wrangler dev` reports "development".
async function showRelease() {
  try {
    const { version, sourceCommit } = await (await fetch('/health', { cache: 'no-store' })).json();
    if (!version) return;
    const text = version === 'development' ? 'dev' : `v${version}`;
    const title = sourceCommit && sourceCommit !== 'development' ? `Smith ${version}, commit ${sourceCommit}` : 'Smith development build';
    for (const id of ['release', 'login-release']) { $(id).textContent = text; $(id).title = title; $(id).hidden = false; }
  } catch { /* the version is a nicety; never block or warn over it */ }
}

(async () => {
  void showRelease();
  showSigninOutcome();
  await loadSigninProviders();
  try { await enterDashboard(await api('/auth/me')); }
  catch (error) { if (error.status !== 401) { resetSession(); showError(error); } }
  finally { $('starting').hidden = true; }
})();
