'use strict';
// Review: the workspace's crew proposals, newest first (src/crew-review.ts). Each card shows who proposed what on which
// project, the files it touched, proposals it overlaps, its branch and commit, cost and last Verify build, and (for
// operators) Verify, Accept and Dismiss. Verify is always a person's choice: it builds code a crew member wrote.

const STATUS_TEXT = {
  pending: 'pending review', verifying: 'confirming the push', accepted: 'accepted', dismissed: 'dismissed', stale: 'stale',
  'findings-only': 'findings only', failed: 'failed',
};
export const VERIFY_WARNING = 'runs this branch’s build script on a build machine';
const usd = value => `$${Number(value).toFixed(2)}`;

// What a proposal's card says and offers, from the proposal and what the page knows around it. Pure, for tests.
export function proposalView(p, { projectName = p.projectId ?? '', remote = '', memberName = p.member?.name ?? null, verifyProduct = null, canManage = false, titleOf = () => null } = {}) {
  const count = p.findings?.length ?? 0;
  const who = memberName || 'A deleted crew member';
  const meta = [who, projectName || 'a removed project', p.costUsd != null ? usd(p.costUsd) : null].filter(Boolean).join(' · ');
  // A report of findings has no branch: it can only be dismissed once read (accept needs a branch).
  const decidable = p.status === 'pending' || p.status === 'stale' || p.status === 'findings-only';
  return {
    title: p.title || p.summary?.split('\n')[0]?.slice(0, 120) || (count ? 'Findings' : 'Report'),
    status: STATUS_TEXT[p.status] ?? p.status, tone: p.status,
    meta, summary: p.title ? p.summary : '',
    findings: count ? `${count} ${count === 1 ? 'finding' : 'findings'}` : '',
    branch: p.branch && p.commit ? `Branch ${p.branch} at ${p.commit.slice(0, 12)}` : '',
    files: p.files ?? [],
    // A list the agent had to cut: Verify refuses it (it could hide a change to smith.json or a build script).
    filesNote: p.filesTruncated ? `Smith recorded ${(p.files ?? []).length} of ${p.filesTotal ?? 'more'} changed files, so this change cannot be verified.` : '',
    overlaps: (p.overlaps ?? []).map(id => titleOf(id) ?? 'another proposal'),
    message: p.status === 'failed' ? p.message || 'The push could not be confirmed.' : '',
    verifyJob: p.verifyJobId ? `Verify build: ${p.verifyJobState ?? 'removed'}` : '',
    decided: p.decidedAt ? `${p.status === 'accepted' ? 'Accepted' : 'Dismissed'}${p.note ? `: “${p.note}”` : ''}` : '',
    // Where to merge an accepted proposal from: the project's Artifacts copy and the run's branch.
    mergeFrom: p.status === 'accepted' && p.branch ? `Merge from ${remote || 'the project’s Artifacts copy'}, branch ${p.branch}` : '',
    verify: canManage && p.status === 'pending' ? (verifyProduct ? { label: `Verify ${verifyProduct} (${VERIFY_WARNING})`, disabled: false }
      : { label: 'Verify (no Verify product set for this member)', disabled: true }) : null,
    accept: canManage && decidable && Boolean(p.branch), dismiss: canManage && decidable,
  };
}

export function createReview({ $, api, base, element, badge, date, action, projects, members, canManage, generation, pullOf = () => null, openPull = () => {} }) {
  let snapshot = '', names = {};
  const projectOf = id => projects().find(p => p.id === id);
  const memberOf = id => members().find(m => m.id === id);
  const path = sessionId => `${base()}/crew/review/${encodeURIComponent(sessionId)}`;

  async function refresh() {
    const current = generation();
    const result = await api(`${base()}/crew/review`);
    if (current !== generation()) return;
    names = result.names ?? {};
    render(result.proposals);
  }
  function render(proposals) {
    const titles = new Map(proposals.map(p => [p.sessionId, `${p.member?.name ?? 'a crew member'}: ${p.title || 'a proposal'}`]));
    const views = proposals.map(p => {
      const project = projectOf(p.projectId);
      return { p, view: proposalView(p, { projectName: project?.name || p.projectId, remote: project?.artifacts?.remote ?? project?.repoUrl ?? '',
        verifyProduct: memberOf(p.crewId)?.verifyProduct ?? null, canManage: canManage(), titleOf: id => titles.get(id) ?? null }) };
    });
    const next = JSON.stringify([views.map(v => v.view), views.map(v => v.p.createdAt), names, views.map(v => pullOf(v.p.sessionId)?.number ?? null)]);
    if (next === snapshot) return; snapshot = next;
    const box = $('crew-review'); box.replaceChildren();
    if (!views.length) {
      box.append(element('p', 'No proposals yet. When a crew member changes files or reports findings, its proposal waits here and opens a pull request, for a person to verify, merge or dismiss. Nothing is merged until a person presses Merge.', 'empty small'));
      return;
    }
    for (const { p, view } of views) box.append(card(p, view));
  }
  function card(p, view) {
    const item = element('article', undefined, 'crew-row crew-proposal-card');
    const top = element('div', undefined, 'crew-member-top');
    top.append(element('strong', view.title), badge(view.tone));
    if (view.status !== view.tone) top.lastElementChild.textContent = view.status;
    item.append(top, element('p', `${view.meta} · ${date(p.createdAt)}`, 'muted small'));
    if (view.summary) item.append(element('p', view.summary, 'crew-report-text'));
    const facts = [view.findings, view.branch, view.verifyJob].filter(Boolean);
    if (facts.length) item.append(element('p', facts.join(' · '), 'muted small'));
    if (view.message) item.append(element('p', view.message, 'small crew-warn'));
    for (const other of view.overlaps) item.append(element('p', `Touches the same files as ${other}.`, 'small crew-warn'));
    if (view.files.length) {
      const files = element('details', undefined, 'chat-tool crew-text');
      files.append(element('summary', `${view.files.length} ${view.files.length === 1 ? 'file' : 'files'} touched`));
      const list = element('ul', undefined, 'crew-files');
      for (const file of view.files) { const li = element('li'); li.append(element('code', file)); list.append(li); }
      files.append(list); item.append(files);
    }
    if (view.filesNote) item.append(element('p', view.filesNote, 'small crew-warn'));
    if (view.decided) item.append(element('p', `${view.decided}${p.decidedBy ? ` (${names[p.decidedBy] ?? 'someone'}, ${date(p.decidedAt)})` : ''}`, 'muted small'));
    if (view.mergeFrom) item.append(element('p', view.mergeFrom, 'small crew-merge-from'));
    const buttons = element('div', undefined, 'crew-actions');
    // Its pull request: where the change is reviewed, discussed and merged.
    const pull = pullOf(p.sessionId);
    if (pull) {
      const open = element('button', `Pull request #${pull.number}${pull.state === 'open' ? '' : ` (${pull.state})`}`); open.type = 'button';
      open.addEventListener('click', () => action(open, () => openPull(p.sessionId)));
      buttons.append(open);
    }
    if (view.verify) {
      const verify = element('button', view.verify.label); verify.type = 'button'; verify.disabled = view.verify.disabled;
      verify.addEventListener('click', () => action(verify, async () => {
        if (!confirm(`Verify ${view.title}?\n\nThis ${VERIFY_WARNING}, without the workspace’s secrets. Check the files it touched first.`)) return;
        await api(`${path(p.sessionId)}/verify`, { requestId: crypto.randomUUID() }); snapshot = ''; await refresh();
      }));
      buttons.append(verify);
    }
    if (view.accept) {
      const accept = element('button', 'Accept', 'quiet'); accept.type = 'button';
      const remote = projectOf(p.projectId)?.artifacts?.remote ?? projectOf(p.projectId)?.repoUrl ?? 'the project’s Artifacts copy';
      accept.addEventListener('click', () => action(accept, async () => {
        if (!confirm(`Accept ${view.title}?\n\nSmith only marks it accepted. To merge it, use Merge on its pull request, or merge from:\n${remote}\nbranch ${p.branch}`)) return;
        await api(path(p.sessionId), { status: 'accepted' }); snapshot = ''; await refresh();
      }));
      buttons.append(accept);
    }
    if (view.dismiss) {
      const dismiss = element('button', 'Dismiss', 'quiet'); dismiss.type = 'button';
      dismiss.addEventListener('click', () => action(dismiss, async () => {
        const note = prompt(`Dismiss ${view.title}?\n\nOptionally say why: your note is added to ${p.member?.name ?? 'the member'}’s memory as feedback for its next runs.`, '');
        if (note === null) return;
        await api(path(p.sessionId), { status: 'dismissed', ...(note.trim() ? { note: note.trim().slice(0, 2000) } : {}) }); snapshot = ''; await refresh();
      }));
      buttons.append(dismiss);
    }
    if (buttons.childElementCount) item.append(buttons);
    return item;
  }
  function reset() { snapshot = ''; names = {}; $('crew-review').replaceChildren(); }
  return { refresh, reset };
}
