'use strict';
// Pull requests: Smith's own (src/pulls.ts), for any project wherever it is hosted. A crew proposal opens one by itself;
// a chat opens one from its pushed branch. The list shows each with its state; one opens into its description, the
// change (the diff a build machine computed), whether it merges cleanly, the conversation and, for operators, Merge,
// Close/Reopen and Publish to GitHub. Merging is a build machine's git merge, pushed to the project's branch, never forced.
import { renderMarkdown } from './markdown.js';

const MANAGERS = ['owner', 'admin', 'operator'];
const ACTIVE = ['queued', 'leased', 'running'];
const MAX_FILE_LINES = 3000;

// Pure: a unified diff (git diff) as files, each with its lines classified. Lines Smith adds ("# smith ...") are skipped.
export function parsePatch(text) {
  const files = []; let file = null, oldNo = 0, newNo = 0;
  for (const raw of String(text).split('\n')) {
    if (raw.startsWith('# smith ')) continue;
    const start = /^diff --git a\/(.*) b\/(.*)$/.exec(raw);
    if (start) { file = { path: start[2], oldPath: start[1], status: 'modified', binary: false, additions: 0, deletions: 0, lines: [] }; files.push(file); continue; }
    if (!file) continue;
    if (raw.startsWith('new file mode')) { file.status = 'added'; continue; }
    if (raw.startsWith('deleted file mode')) { file.status = 'deleted'; continue; }
    if (raw.startsWith('rename from ')) { file.status = 'renamed'; file.oldPath = raw.slice(12); continue; }
    if (raw.startsWith('rename to ')) { file.path = raw.slice(10); continue; }
    if (raw.startsWith('Binary files ')) { file.binary = true; continue; }
    if (raw.startsWith('--- ') || raw.startsWith('+++ ') || raw.startsWith('index ') || raw.startsWith('similarity index') || raw.startsWith('old mode') || raw.startsWith('new mode') || raw.startsWith('dissimilarity')) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { oldNo = Number(hunk[1]); newNo = Number(hunk[2]); file.lines.push({ kind: 'hunk', text: raw }); continue; }
    if (raw.startsWith('+')) { file.additions++; file.lines.push({ kind: 'add', text: raw.slice(1), newNo: newNo++ }); continue; }
    if (raw.startsWith('-')) { file.deletions++; file.lines.push({ kind: 'del', text: raw.slice(1), oldNo: oldNo++ }); continue; }
    if (raw.startsWith(' ')) { file.lines.push({ kind: 'ctx', text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ }); continue; }
    if (raw.startsWith('\\')) file.lines.push({ kind: 'meta', text: raw });
  }
  return files;
}

// Pure: what a pull request's header and merge box say, from the pull request and who is looking. For tests.
export function pullView(p, { canManage = false, machineReady = true } = {}) {
  const diffJob = p.diff?.job, mergeJob = p.merge;
  const merging = Boolean(mergeJob && ACTIVE.includes(mergeJob.state) && p.state === 'open');
  // A diff is due (queued by the server on its next pass) or running; one that ended without a result leaves Refresh.
  const comparing = p.state === 'open' && (Boolean(diffJob && ACTIVE.includes(diffJob.state)) || (p.diff?.commit !== p.headCommit && !p.message));
  const diffLost = p.state === 'open' && !comparing && !p.diff?.current && diffJob && ['lost', 'cancelled', 'error'].includes(diffJob.state) ? `The comparison with ${p.baseBranch} did not finish (${diffJob.state}); press Refresh to compare again.` : '';
  const author = p.crew ? (p.crew.name ? `${p.crew.name} (crew)` : 'A deleted crew member') : null;
  let mergeState;
  if (p.state === 'merged') mergeState = { tone: 'merged', text: `Merged into ${p.baseBranch}${p.mergeCommit ? ` as ${p.mergeCommit.slice(0, 12)}` : ''}.` };
  else if (p.state === 'closed') mergeState = { tone: 'closed', text: 'Closed without merging.' };
  else if (merging) mergeState = { tone: 'running', text: mergeJob.state === 'queued' ? `Waiting for a build machine to merge into ${p.baseBranch}…` : `Merging into ${p.baseBranch}…` };
  else if (comparing) mergeState = { tone: 'running', text: `Comparing with ${p.baseBranch}…` };
  else if (p.diff?.current && p.diff.mergeable === false) mergeState = { tone: 'failed', text: `Conflicts with ${p.baseBranch}${p.diff.conflicts?.length ? ` in ${p.diff.conflicts.slice(0, 5).join(', ')}${p.diff.conflicts.length > 5 ? ` and ${p.diff.conflicts.length - 5} more` : ''}` : ''}. Resolve them on the branch, then Refresh.` };
  else if (p.diff?.current && p.diff.mergeable === true) mergeState = { tone: 'success', text: `No conflicts with ${p.baseBranch}.` };
  else mergeState = { tone: 'queued', text: p.diff?.current ? `Smith could not tell whether this merges cleanly into ${p.baseBranch} (the build machine’s Git is older than 2.38); Merge tries it.` : `Not compared with ${p.baseBranch} yet.` };
  const waiting = (merging && mergeJob.state === 'queued') || (comparing && (!diffJob || diffJob.state === 'queued'));
  const blocked = waiting && !machineReady ? 'No build machine can run pull requests yet. Build machines update themselves once the new Smith agent is published; a machine set up before self-update needs SmithAgent.bat update once.' : '';
  const mergeWhy = !canManage ? 'Only operators and above can merge' : p.state !== 'open' ? '' : merging ? 'Already merging'
    : p.diff?.current && p.diff.mergeable === false ? `Resolve the conflicts with ${p.baseBranch} first` : '';
  return {
    title: `${p.title} #${p.number}`, status: p.state, author,
    meta: [author, p.projectName || p.projectId, `${p.headBranch} → ${p.baseBranch}`].filter(Boolean).join(' · '),
    mergeState, blocked, message: p.message || diffLost || (mergeJob && mergeJob.state !== 'success' && !ACTIVE.includes(mergeJob.state) && p.state === 'open' && mergeJob.message ? `The last merge did not finish: ${mergeJob.message}` : ''),
    merge: p.state === 'open' && canManage ? { disabled: Boolean(mergeWhy), why: mergeWhy } : null,
    close: canManage && p.state === 'open' && !merging, reopen: canManage && p.state === 'closed', refresh: canManage && p.state === 'open' && !comparing,
    github: p.github ? (p.github.url ? { link: p.github.url, label: `Open a pull request on GitHub (${p.github.repo})` }
      : p.github.needsPublish && canManage && p.state === 'open' ? { publish: true, busy: Boolean(p.github.publish && ACTIVE.includes(p.github.publish.state)), label: `Publish the branch to GitHub (${p.github.repo})` } : null) : null,
  };
}

export function createPulls({ $, api, base, element, badge, date, action, settings, generation, onChange = () => {} }) {
  let pulls = [], names = {}, machineReady = true, filter = 'open', openId = null, detail = null;
  let listSnapshot = '', detailSnapshot = '', patchFor = null, patchFiles = null, patchError = '';
  const canManage = () => MANAGERS.includes(settings()?.role);
  const path = id => `${base()}/pulls/${encodeURIComponent(id)}`;
  const nameOf = id => (id && names[id]) || 'someone';

  async function refresh() {
    const current = generation();
    const result = await api(`${base()}/pulls${filter === 'all' ? '' : `?state=${filter}`}`);
    if (current !== generation()) return;
    pulls = result.pulls; names = { ...names, ...result.names }; machineReady = result.machineReady;
    renderList();
    onChange(pulls);
    if (openId) await refreshDetail();
  }
  async function refreshDetail() {
    const current = generation(), id = openId;
    const result = await api(path(id));
    if (current !== generation() || id !== openId) return;
    names = { ...names, ...result.names }; detail = result;
    renderDetail();
  }
  function renderList() {
    const snapshot = JSON.stringify([pulls.map(p => pullView(p, { canManage: canManage(), machineReady })), pulls.map(p => [p.id, p.commentCount, p.createdAt]), openId, filter]);
    if (snapshot === listSnapshot) return; listSnapshot = snapshot;
    const box = $('pulls-list'); box.replaceChildren();
    if (!pulls.length) {
      box.append(element('p', filter === 'open' ? 'No open pull requests. A crew member’s proposal opens one here by itself, and a chat opens one from its pushed branch.' : 'Nothing here yet.', 'empty small'));
      return;
    }
    for (const p of pulls) {
      const view = pullView(p, { canManage: canManage(), machineReady });
      const row = element('article', undefined, `crew-row pull-row${p.id === openId ? ' selected' : ''}`);
      const top = element('div', undefined, 'crew-member-top');
      const open = element('button', view.title, 'build-link pull-open'); open.type = 'button';
      open.addEventListener('click', () => show(p.id));
      top.append(open, badge(p.state === 'open' && view.mergeState.tone === 'failed' ? 'conflicts' : p.state));
      row.append(top, element('p', `${view.meta} · ${p.authorUserId ? `opened by ${nameOf(p.authorUserId)} · ` : ''}${date(p.createdAt)}${p.commentCount ? ` · ${p.commentCount} comment${p.commentCount === 1 ? '' : 's'}` : ''}`, 'muted small'));
      if (view.blocked) row.append(element('p', view.blocked, 'small crew-warn'));
      box.append(row);
    }
  }

  // ---- One pull request ---------------------------------------------------------------------------------------------
  async function show(id) {
    openId = id; detail = null; detailSnapshot = ''; patchFor = null; patchFiles = null; patchError = '';
    $('pull-detail').hidden = false; $('pull-detail').replaceChildren(element('p', 'Loading…', 'muted small'));
    listSnapshot = ''; renderList();
    await refreshDetail();
    $('pull-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function hide() { openId = null; detail = null; $('pull-detail').hidden = true; $('pull-detail').replaceChildren(); listSnapshot = ''; renderList(); }
  async function loadPatch(p) {
    const jobId = p.diff?.current ? p.diff.job?.jobId : null;
    if (!jobId || patchFor === jobId) return;
    patchFor = jobId; patchFiles = null; patchError = '';
    try {
      const response = await fetch(`${base()}/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(p.diff.patchFile)}`, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error(`The diff could not be loaded (${response.status}).`);
      patchFiles = parsePatch(await response.text());
    } catch (error) { patchError = error.message; }
    if (openId === p.id) { detailSnapshot = ''; renderDetail(); }
  }
  function renderDetail() {
    const p = detail; if (!p) return;
    const view = pullView(p, { canManage: canManage(), machineReady });
    const snapshot = JSON.stringify([view, p, names, patchFor, Boolean(patchFiles), patchError]);
    if (snapshot === detailSnapshot) return; detailSnapshot = snapshot;
    void loadPatch(p);
    const box = $('pull-detail');
    const draft = box.querySelector('#pull-comment')?.value ?? '';
    box.replaceChildren();
    const heading = element('div', undefined, 'section-heading');
    const titles = element('div'); const h = element('h3', view.title); h.id = 'pull-title'; h.tabIndex = -1;
    titles.append(h, element('p', `${view.meta} · ${p.authorUserId ? `opened by ${nameOf(p.authorUserId)}, ` : ''}${date(p.createdAt)}`, 'muted small'));
    const close = element('button', 'Close', 'quiet'); close.type = 'button'; close.addEventListener('click', hide);
    heading.append(titles, close); box.append(heading);
    if (p.body) { const body = element('div', undefined, 'chat-bubble assistant pull-body'); body.innerHTML = renderMarkdown(p.body); box.append(body); }   // markdown-it with raw HTML disabled

    // Merge box: state, blocking notice, the buttons.
    const merge = element('div', undefined, `pull-merge ${view.mergeState.tone}`);
    merge.append(element('p', view.mergeState.text, 'pull-merge-state'));
    if (view.blocked) merge.append(element('p', view.blocked, 'small crew-warn'));
    if (view.message) merge.append(element('p', view.message, 'small crew-warn'));
    if (p.state === 'merged' && p.mergedBy) merge.append(element('p', `Merged by ${nameOf(p.mergedBy)}, ${date(p.mergedAt)}.`, 'muted small'));
    if (p.state === 'closed' && p.closedBy) merge.append(element('p', `Closed by ${nameOf(p.closedBy)}, ${date(p.closedAt)}.`, 'muted small'));
    const buttons = element('div', undefined, 'crew-actions');
    const post = (verb, extra = {}) => api(`${path(p.id)}/${verb}`, extra).then(result => { detail = result; names = { ...names, ...result.names }; detailSnapshot = ''; renderDetail(); return refresh(); });
    if (view.merge) {
      const button = element('button', `Merge into ${p.baseBranch}`); button.type = 'button'; button.disabled = view.merge.disabled; button.title = view.merge.why;
      button.addEventListener('click', () => action(button, async () => {
        if (!confirm(`Merge #${p.number} “${p.title}” into ${p.baseBranch}?\n\nA build machine merges ${p.headBranch} at ${p.headCommit.slice(0, 12)} and pushes ${p.baseBranch}. It is never forced: if ${p.baseBranch} moved meanwhile, the merge stops and says so.`)) return;
        await post('merge');
      }));
      buttons.append(button);
    }
    if (view.refresh) { const b = element('button', 'Refresh', 'quiet'); b.type = 'button'; b.title = `Compare with ${p.baseBranch} again`; b.addEventListener('click', () => action(b, () => post('refresh'))); buttons.append(b); }
    if (view.github?.link) { const a = element('a', view.github.label, 'button-link pull-github'); a.href = view.github.link; a.target = '_blank'; a.rel = 'noopener noreferrer'; buttons.append(a); }
    else if (view.github?.publish) {
      const b = element('button', view.github.busy ? 'Publishing to GitHub…' : view.github.label, 'quiet'); b.type = 'button'; b.disabled = view.github.busy;
      b.title = `A build machine pushes ${p.headBranch} to GitHub with its own Git login; then a link here opens GitHub’s pull request page`;
      b.addEventListener('click', () => action(b, () => post('publish'))); buttons.append(b);
    }
    if (view.close) {
      const b = element('button', 'Close', 'quiet danger'); b.type = 'button';
      b.addEventListener('click', () => action(b, async () => {
        const note = prompt(`Close #${p.number} without merging?\n\nOptionally say why${p.crew ? `: ${p.crew.name ?? 'the crew member'} reads it as feedback` : ''}.`, '');
        if (note === null) return;
        await post('close', note.trim() ? { note: note.trim().slice(0, 2000) } : {});
      }));
      buttons.append(b);
    }
    if (view.reopen) { const b = element('button', 'Reopen', 'quiet'); b.type = 'button'; b.addEventListener('click', () => action(b, () => post('reopen'))); buttons.append(b); }
    if (buttons.childElementCount) merge.append(buttons);
    box.append(merge);

    // The change.
    const change = element('section', undefined, 'pull-change');
    const facts = [`${p.headBranch} at ${p.headCommit.slice(0, 12)}`, p.diff?.mergeBase ? `compared with ${p.baseBranch} from ${p.diff.mergeBase.slice(0, 12)}` : ''].filter(Boolean).join(' · ');
    change.append(element('h4', 'Changes'), element('p', facts, 'muted small'));
    if (patchError) change.append(element('p', patchError, 'small crew-warn'));
    else if (!p.diff?.current) change.append(element('p', 'The change appears here once a build machine has compared the branch.', 'muted small'));
    else if (!patchFiles) change.append(element('p', 'Loading the change…', 'muted small'));
    else {
      if (p.diff.truncated) change.append(element('p', 'This change is large, so Smith shows its first 8 MB.', 'small crew-warn'));
      const added = patchFiles.reduce((n, f) => n + f.additions, 0), removed = patchFiles.reduce((n, f) => n + f.deletions, 0);
      change.append(element('p', `${patchFiles.length} file${patchFiles.length === 1 ? '' : 's'} changed, +${added} −${removed}`, 'small'));
      if (!patchFiles.length) change.append(element('p', `No differences from ${p.baseBranch}.`, 'muted small'));
      const total = patchFiles.reduce((n, f) => n + f.lines.length, 0);
      for (const file of patchFiles) change.append(fileView(file, total < 1500));
    }
    box.append(change);

    // Conversation.
    const talk = element('section', undefined, 'pull-comments');
    talk.append(element('h4', 'Conversation'));
    for (const c of p.comments ?? []) {
      const item = element('article', undefined, 'pull-comment');
      item.append(element('p', `${nameOf(c.userId)} · ${date(c.createdAt)}`, 'muted small'));
      const body = element('div', undefined, 'chat-bubble assistant'); body.innerHTML = renderMarkdown(c.body);   // markdown-it with raw HTML disabled
      item.append(body); talk.append(item);
    }
    const form = element('form', undefined, 'pull-comment-form');
    const label = element('label', p.crew ? `Comment (${p.crew.name ?? 'the crew member'} reads comments as feedback)` : 'Comment'); label.htmlFor = 'pull-comment';
    const text = element('textarea'); text.id = 'pull-comment'; text.rows = 3; text.maxLength = 8000; text.value = draft;
    const send = element('button', 'Comment', 'quiet'); send.type = 'submit';
    form.append(label, text, send);
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (!text.value.trim()) return;
      void action(send, async () => { await post('comment', { body: text.value.trim() }); const fresh = $('pull-comment'); if (fresh) fresh.value = ''; });
    });
    talk.append(form); box.append(talk);
  }
  function fileView(file, expanded) {
    const box = element('details', undefined, 'pull-file'); box.open = expanded;
    const summary = element('summary');
    summary.append(element('code', file.status === 'renamed' ? `${file.oldPath} → ${file.path}` : file.path),
      element('span', ` ${file.status === 'added' ? 'added' : file.status === 'deleted' ? 'deleted' : file.status === 'renamed' ? 'renamed' : ''} +${file.additions} −${file.deletions}`, 'muted small'));
    box.append(summary);
    if (file.binary) { box.append(element('p', 'Binary file.', 'muted small')); return box; }
    const pre = element('div', undefined, 'pull-diff'); pre.setAttribute('role', 'table'); pre.setAttribute('aria-label', `Changes to ${file.path}`);
    for (const line of file.lines.slice(0, MAX_FILE_LINES)) {
      const row = element('div', undefined, `pull-line ${line.kind}`); row.setAttribute('role', 'row');
      if (line.kind === 'hunk') { row.append(element('span', line.text, 'pull-text')); pre.append(row); continue; }
      row.append(element('span', line.oldNo ?? '', 'pull-no'), element('span', line.newNo ?? '', 'pull-no'),
        element('span', line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' ', 'pull-sign'), element('span', line.text, 'pull-text'));
      pre.append(row);
    }
    box.append(pre);
    if (file.lines.length > MAX_FILE_LINES) box.append(element('p', `${file.lines.length - MAX_FILE_LINES} more lines not shown.`, 'muted small'));
    return box;
  }
  function setFilter(value) { filter = value; listSnapshot = ''; return refresh(); }
  function reset() { pulls = []; names = {}; openId = null; detail = null; listSnapshot = ''; detailSnapshot = ''; patchFor = null; patchFiles = null; $('pulls-list').replaceChildren(); $('pull-detail').hidden = true; $('pull-detail').replaceChildren(); }
  // Opens one from elsewhere (a crew proposal's card), showing every state so a merged or closed one is found too.
  async function openFor(predicate) {
    let found = pulls.find(predicate);
    if (!found) { filter = 'all'; $('pulls-filter').value = 'all'; listSnapshot = ''; await refresh(); found = pulls.find(predicate); }
    if (found) await show(found.id);
  }
  return { refresh, reset, setFilter, openFor, all: () => pulls };
}
