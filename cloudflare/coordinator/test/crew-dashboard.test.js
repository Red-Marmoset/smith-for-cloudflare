import { it, expect } from 'vitest';
import { CREW_TEMPLATE_DEFAULTS, DEFAULT_BUDGET, hasSmithCopy, memberStatus, missingProjects, runNeedsPolling, triggerSummary } from '../public/crew.js';
import { CREW_TEMPLATES, DEFAULT_CREW_BUDGET, hasSmithCopy as serverHasCopy } from '../src/crew';
import { proposalView, VERIFY_WARNING } from '../public/crew-review.js';
import { composeProblem, messageMatches, messageView } from '../public/crew-messages.js';

it('offers the server’s templates with their defaults, so the dialog shows what a new member gets', () => {
  expect(Object.keys(CREW_TEMPLATE_DEFAULTS)).toEqual(Object.keys(CREW_TEMPLATES));
  for (const [key, { name, brain, permissionMode, trigger, attachSharedProjects }] of Object.entries(CREW_TEMPLATES)) {
    const { label, ...defaults } = CREW_TEMPLATE_DEFAULTS[key];
    expect([key, defaults]).toEqual([key, { name, brain, permissionMode, trigger, attachSharedProjects }]);
    expect(brain).toBe('auto');
    expect(label).toMatch(/^[A-Z]/);
  }
  expect(DEFAULT_BUDGET).toEqual(DEFAULT_CREW_BUDGET);
});

it('treats a project as ready for the crew exactly when the server does', () => {
  const remote = 'https://acct.artifacts.cloudflare.net/git/default/smith.git';
  const cases = [undefined, { repoUrl: remote }, { repoUrl: remote, artifacts: { status: 'pushing', remote } },
    { repoUrl: 'https://github.com/org/smith.git', artifacts: { status: 'done', remote } }, { repoUrl: remote, artifacts: { status: 'done', remote } },
    // Smith's own copies: ready counts, copying and failed do not.
    { repoUrl: 'https://exp.example.test/git/smith.git', hosted: { status: 'copying' } }, { repoUrl: 'https://github.com/org/smith.git', hosted: { status: 'failed' } },
    { repoUrl: 'https://exp.example.test/git/smith.git', hosted: { status: 'ready' } }];
  for (const project of cases) expect(hasSmithCopy(project)).toBe(serverHasCopy(project));
  expect(hasSmithCopy(cases.at(-1))).toBe(true);
  expect(hasSmithCopy(cases.at(-2))).toBe(false);
});

it('shows the workspace switch first, then a run in flight, then whether the member is paused', () => {
  const member = { enabled: true }, paused = { enabled: false };
  expect(memberStatus(member, undefined)).toEqual({ text: 'idle', tone: 'idle' });
  expect(memberStatus(paused, { state: 'finished' })).toEqual({ text: 'disabled', tone: 'disabled' });
  expect(memberStatus(paused, { state: 'running' }, { hostname: 'DESKTOP-SEM' })).toEqual({ text: 'running on DESKTOP-SEM', tone: 'running' });
  expect(memberStatus(member, { state: 'queued' }).text).toBe('queued');
  expect(memberStatus(member, { state: 'pushing' }).text).toBe('pushing');
  expect(memberStatus(member, { state: 'waiting', waitReason: 'machine busy: build #41' }).text).toBe('waiting: machine busy: build #41');
  expect(memberStatus(member, { state: 'waiting', waitReason: 'budget' }).text).toBe('over budget');
  expect(memberStatus(member, { state: 'running' }, { crewStopped: true }).text).toBe('stopped: workspace');
});

it('summarises triggers in words', () => {
  expect(triggerSummary({ kind: 'manual' })).toBe('on Run now only');
  expect(triggerSummary({ kind: 'interval', intervalMinutes: 360, skipIfUnchanged: true })).toBe('every 6 hours when there are new commits');
  expect(triggerSummary({ kind: 'interval', intervalMinutes: 1440, skipIfUnchanged: false })).toBe('every day');
  expect(triggerSummary({ kind: 'interval', intervalMinutes: 90 })).toBe('every 90 minutes');
  expect(triggerSummary({ kind: 'buildFinished', on: 'failed' })).toBe('after a failed build');
  expect(triggerSummary({ kind: 'buildFinished', on: 'any' })).toBe('after every build');
});

it('keeps polling an open run only while it can still change', () => {
  const finished = { working: false, turns: [{ state: 'completed' }] };
  expect(runNeedsPolling(null, undefined)).toBe(true);                                   // not loaded yet
  expect(runNeedsPolling({ working: true, turns: [{ state: 'running' }] }, 'running')).toBe(true);
  expect(runNeedsPolling({ working: false, turns: [{ state: 'completed' }, { state: 'queued' }] }, 'finished')).toBe(true);
  expect(runNeedsPolling(finished, 'pushing')).toBe(true);                               // its run row says a push is due
  expect(runNeedsPolling(finished, 'finished')).toBe(false);
  expect(runNeedsPolling({ working: false, turns: [] }, undefined)).toBe(false);
});

it('finds the projects a member names that the workspace no longer has', () => {
  const projects = [{ id: 'smith' }, { id: 'senet' }];
  expect(missingProjects(['senet', 'gone', 'smith', 'also-gone'], projects)).toEqual(['gone', 'also-gone']);
  expect(missingProjects([], projects)).toEqual([]);
});

it('shows a proposal’s card from what the server says, offering Verify (with its warning) only on a pending proposal', () => {
  const proposal = { sessionId: 's1', crewId: 'c1', member: { name: 'Standards', slug: 'standards' }, projectId: 'smith', title: 'Fix tabs', summary: 'Replaces tabs', findings: [{}],
    files: ['a.cpp'], status: 'pending', message: null, branch: 'smith/crew-standards-1a2b3c4d', commit: 'c'.repeat(40), costUsd: 0.2, verifyJobId: null, verifyJobState: null,
    overlaps: ['s2'], createdAt: 1, decidedBy: null, decidedAt: null, note: null };
  const titles = { s2: 'Bug hunter: Guard nulls' };
  const view = proposalView(proposal, { projectName: 'Smith', verifyProduct: 'build', canManage: true, titleOf: id => titles[id] });
  expect(view).toMatchObject({ title: 'Fix tabs', status: 'pending review', meta: 'Standards · Smith · $0.20', findings: '1 finding', branch: `Branch smith/crew-standards-1a2b3c4d at ${'c'.repeat(12)}`,
    overlaps: ['Bug hunter: Guard nulls'], accept: true, dismiss: true, mergeFrom: '' });
  expect(view.verify).toEqual({ label: `Verify build (${VERIFY_WARNING})`, disabled: false });
  expect(VERIFY_WARNING).toContain('build script on a build machine');
  expect(proposalView(proposal, { canManage: true }).verify).toMatchObject({ disabled: true });                              // no Verify product
  expect(proposalView(proposal, { verifyProduct: 'build' })).toMatchObject({ verify: null, accept: false, dismiss: false });   // viewers only look
  const remote = 'https://a.artifacts.cloudflare.net/git/default/smith.git';
  const accepted = proposalView({ ...proposal, status: 'accepted', decidedAt: 2, decidedBy: 'u' }, { remote, canManage: true, verifyProduct: 'build' });
  expect(accepted).toMatchObject({ verify: null, accept: false, decided: 'Accepted', mergeFrom: `Merge from ${remote}, branch smith/crew-standards-1a2b3c4d` });
  expect(proposalView({ ...proposal, status: 'failed', message: 'remote rejected' })).toMatchObject({ message: 'remote rejected', status: 'failed' });
  expect(proposalView({ ...proposal, status: 'findings-only', title: '', summary: 'Two slips\nmore', branch: null, commit: null })).toMatchObject({ title: 'Two slips', summary: '', branch: '' });
  // A report of findings can only be dismissed, once read.
  expect(proposalView({ ...proposal, status: 'findings-only', branch: null, commit: null }, { canManage: true })).toMatchObject({ accept: false, dismiss: true, verify: null });
  // A file list Smith had to cut says so, and why Verify refuses it.
  expect(proposalView({ ...proposal, filesTotal: 900, filesTruncated: true }).filesNote).toBe('Smith recorded 1 of 900 changed files, so this change cannot be verified.');
  expect(view.filesNote).toBe('');
});

it('names who wrote a message and to whom, never by ID, and filters by member or by everyone', () => {
  const crew = { a: 'Standards', b: 'Bug hunter' };
  const memberName = id => crew[id] ?? null;
  const fromMember = { seq: 1, from: { crewId: 'a', name: 'Standards (old name)' }, to: null, body: 'Hi', createdAt: 1 };
  const fromPerson = { seq: 2, from: { userId: 'u1', name: 'Sem' }, to: 'b', body: 'Look here', createdAt: 2 };
  expect(messageView(fromMember, { memberName })).toMatchObject({ from: 'Standards', to: 'everyone', meta: 'Standards to everyone', byMember: true, deletable: false });
  expect(messageView(fromPerson, { memberName, canManage: true })).toMatchObject({ meta: 'Sem to Bug hunter', byMember: false, deletable: true });
  // A person the identity database could not name, a deleted sender and a deleted recipient read as such.
  expect(messageView({ ...fromPerson, from: { userId: 'u1', name: '' } }, { memberName }).from).toBe('A workspace member');
  expect(messageView({ ...fromPerson, from: { userId: 'u1', name: '' } }, { memberName, names: { u1: 'Sem' } }).from).toBe('Sem');
  expect(messageView({ ...fromMember, from: { crewId: 'gone', name: 'A deleted crew member' }, to: 'gone' }, { memberName }).meta).toBe('A deleted crew member to a deleted crew member');
  for (const [filter, shown] of [['', [1, 2]], ['everyone', [1]], ['a', [1]], ['b', [2]], ['c', []]])
    expect([fromMember, fromPerson].filter(m => messageMatches(m, filter)).map(m => m.seq), filter).toEqual(shown);
  expect(composeProblem('  ')).toBe('Write a message first.');
  expect(composeProblem('é'.repeat(4096))).toBe('');
  expect(composeProblem('é'.repeat(4097))).toContain('at most 8192 bytes');
});
