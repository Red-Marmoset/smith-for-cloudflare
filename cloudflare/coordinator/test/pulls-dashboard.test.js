import { it, expect } from 'vitest';
import { parsePatch, pullView } from '../public/pulls.js';

const PATCH = `# smith pull diff ${'m'.repeat(40)}..${'h'.repeat(40)}
diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 keep
-old
+new
 tail
diff --git a/docs/new.md b/docs/new.md
new file mode 100644
--- /dev/null
+++ b/docs/new.md
@@ -0,0 +1 @@
+hello
diff --git a/old.txt b/moved.txt
similarity index 100%
rename from old.txt
rename to moved.txt
diff --git a/logo.png b/logo.png
Binary files a/logo.png and b/logo.png differ
`;

it('reads a git diff into files with numbered lines', () => {
  const files = parsePatch(PATCH);
  expect(files.map(f => [f.path, f.status, f.additions, f.deletions, f.binary])).toEqual([
    ['src/a.ts', 'modified', 1, 1, false], ['docs/new.md', 'added', 1, 0, false], ['moved.txt', 'renamed', 0, 0, false], ['logo.png', 'modified', 0, 0, true]]);
  expect(files[0].lines).toEqual([
    { kind: 'hunk', text: '@@ -1,3 +1,3 @@' }, { kind: 'ctx', text: 'keep', oldNo: 1, newNo: 1 }, { kind: 'del', text: 'old', oldNo: 2 },
    { kind: 'add', text: 'new', newNo: 2 }, { kind: 'ctx', text: 'tail', oldNo: 3, newNo: 3 }]);
  expect(files[2].oldPath).toBe('old.txt');
  expect(parsePatch('# smith pull diff x..y\n')).toEqual([]);
});

const base = { id: 'p', number: 3, title: 'Tidy', state: 'open', headBranch: 'smith/crew-a-1', headCommit: 'h'.repeat(40), baseBranch: 'main', projectId: 'smith', projectName: 'Smith',
  crew: { id: 'c', name: 'Standards', sessionId: 's' }, message: null, merge: null, github: null,
  diff: { current: true, commit: 'h'.repeat(40), job: { jobId: 'j', state: 'success' }, mergeable: true, conflicts: [] } };

it('says whether a pull request merges and who may merge it', () => {
  expect(pullView(base, { canManage: true })).toMatchObject({ title: 'Tidy #3', meta: 'Standards (crew) · Smith · smith/crew-a-1 → main', mergeState: { tone: 'success' }, merge: { disabled: false }, close: true });
  expect(pullView(base, { canManage: false }).merge).toBeNull();
  const conflicted = pullView({ ...base, diff: { ...base.diff, mergeable: false, conflicts: ['src/a.ts'] } }, { canManage: true });
  expect(conflicted.mergeState).toMatchObject({ tone: 'failed', text: expect.stringContaining('src/a.ts') });
  expect(conflicted.merge).toMatchObject({ disabled: true });
  // Pushed again: the diff is due, so it is being compared (and the server has not queued it yet).
  expect(pullView({ ...base, headCommit: 'x'.repeat(40), diff: { ...base.diff, current: false } }).mergeState.text).toBe('Comparing with main…');
  // Waiting for a machine that can run it: the notice says how it gets fixed.
  const waiting = pullView({ ...base, merge: { jobId: 'm', state: 'queued', message: '' } }, { canManage: true, machineReady: false });
  expect(waiting.blocked).toMatch(/update themselves/);
  expect(waiting.merge).toMatchObject({ disabled: true });
  expect(pullView({ ...base, merge: { jobId: 'm', state: 'failed', message: 'push refused' } }, { canManage: true }).message).toBe('The last merge did not finish: push refused');
  expect(pullView({ ...base, state: 'merged', mergeCommit: 'b'.repeat(40) }).mergeState.text).toBe(`Merged into main as ${'b'.repeat(12)}.`);
  expect(pullView({ ...base, diff: { ...base.diff, current: false, job: { jobId: 'j', state: 'lost' } } }, { canManage: true }).message).toMatch(/did not finish \(lost\)/);
});

it('links to GitHub once the branch is there, and offers to publish it before', () => {
  expect(pullView({ ...base, github: { repo: 'o/r', url: 'https://github.com/o/r/compare/main...b?expand=1', needsPublish: false, publish: null } }).github)
    .toEqual({ link: 'https://github.com/o/r/compare/main...b?expand=1', label: 'Open a pull request on GitHub (o/r)' });
  expect(pullView({ ...base, github: { repo: 'o/r', url: null, needsPublish: true, publish: { state: 'running' } } }, { canManage: true }).github).toMatchObject({ publish: true, busy: true });
  expect(pullView({ ...base, github: { repo: 'o/r', url: null, needsPublish: true, publish: null } }, { canManage: false }).github).toBeNull();
});
