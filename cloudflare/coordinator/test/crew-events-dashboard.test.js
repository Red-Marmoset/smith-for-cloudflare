import { describe, expect, it, vi } from 'vitest';
import { createEvents, eventView, findingView, parseMemberPolicy, parseWorkspacePolicy, reasonText } from '../public/crew-events.js';

describe('check-in dashboard views', () => {
  it('keeps exact commits, metadata failures and delivery identity visible', () => {
    const event = { id: 'event', project_id: 'p', kind: 'push', branch: '<script>', base_commit: 'a'.repeat(40), head_commit: 'b'.repeat(40), state: 'blocked', reason: 'github_file_limit', delivery_id: 'delivery', source: 'github' };
    expect(eventView(event, 'Project')).toMatchObject({ title: 'Project · push · <script>', range: `${'a'.repeat(40)} → ${'b'.repeat(40)}`, reason: 'GitHub’s changed-file list reached its limit. Metadata is incomplete.', delivery: 'github · delivery' });
  });
  it('explains native capability and lease waits without hiding unknown reasons', () => {
    expect(reasonText('agent_update_required')).toContain('Update');
    expect(reasonText('lease_conflict')).toContain('writer');
    expect(reasonText('new-server-reason')).toBe('new-server-reason');
  });
  it('keeps missing confidence unknown and external merge status explicit', () => {
    expect(findingView({ id: 'f', disposition: 'merge_blocking', value: { title: '<img>', confidence: null, files: ['src/a.ts'] } })).toMatchObject({ title: '<img>', confidence: 'Confidence unknown', files: ['src/a.ts'], hold: 'Internal review hold only; GitHub merge checks are unchanged.' });
  });
  it('preserves a configured member policy through JSON editing and permits explicit removal', () => {
    const policy = { mode: 'read_only', eventKinds: ['push'], writeScopes: [], canRequest: ['reviewer'], debounceMs: 9000 };
    expect(parseMemberPolicy(JSON.stringify(policy))).toEqual(policy);
    expect(parseMemberPolicy('')).toBeNull();
    expect(() => parseMemberPolicy('[]')).toThrow('object');
    expect(() => parseMemberPolicy('{')).toThrow('JSON');
  });
  it('sets workspace enabling independently of the advanced budget JSON', () => {
    expect(parseWorkspacePolicy('{"maxDepth":1,"enabled":true}', false)).toEqual({ maxDepth: 1, enabled: false });
  });
  it('takes activity limits from the visible controls, preserving advanced event rules and zero limits', () => {
    expect(parseWorkspacePolicy('{"maxDepth":1,"concurrency":{"expensive":9},"globalStartsPerHour":100}', true,
      { cheap: '2', medium: '1', expensive: '0', startsPerHour: '4' })).toEqual({
      enabled: true, maxDepth: 1, concurrency: { cheap: 2, medium: 1, expensive: 0 }, globalStartsPerHour: 4,
    });
    expect(() => parseWorkspacePolicy('{}', false, { cheap: '1', medium: '1', expensive: '', startsPerHour: '4' })).toThrow('limit');
    expect(() => parseWorkspacePolicy('{}', false, { cheap: '1', medium: '1', expensive: '1', startsPerHour: '0' })).toThrow('limit');
  });
});

// Tiny DOM contract: rendering through text is allowed; HTML interpolation fails immediately.
class Node {
  constructor(tag = 'div', text = '') { this.tag = tag; this.textContent = text; this.children = []; this.dataset = {}; this.listeners = {}; this.value = ''; }
  set innerHTML(_value) { throw new Error('Untrusted HTML rendering'); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  setAttribute() {}
  contains() { return false; }
  reset() {}
}
const flatten = node => [node, ...node.children.flatMap(flatten)];
function harness(api, { manage = false, generation = () => 1 } = {}) {
  const nodes = new Map(), $ = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  const events = createEvents({ $, api, base: () => '/workspaces/w', element: (tag, text) => new Node(tag, text), action: (_button, task) => task(), date: value => String(value), projects: () => [{ id: 'p', name: 'Project' }], members: () => [], canManage: () => manage, generation });
  return { $, events };
}
it('renders repository text safely and hides mutation controls from viewers', async () => {
  const event = { id: 'e', project_id: 'p', kind: 'push', branch: '<script>alert(1)</script>', state: 'blocked', base_commit: 'a'.repeat(40), head_commit: 'b'.repeat(40), source: 'github', delivery_id: 'd' };
  const api = vi.fn(async path => path.endsWith('/e') ? { event, findings: [{ id: 'f', value: { title: '<img onerror=x>' }, disposition: 'human_review' }] } : { events: [event], nextCursor: null });
  const { $, events } = harness(api);
  await events.refresh();
  expect($('crew-checkin-form').hidden).toBe(true);
  const open = flatten($('crew-events-list')).find(node => node.tag === 'button');
  expect(open.textContent).toContain('<script>');
  await open.listeners.click();
  const detail = flatten($('crew-event-detail'));
  expect(detail.some(node => node.textContent === '<img onerror=x>')).toBe(true);
  expect(detail.filter(node => node.tag === 'button').map(node => node.textContent)).toEqual(['Close event']);
  expect(api.mock.calls.every(call => call.length === 1)).toBe(true);
});
it('discards a response after the workspace changes', async () => {
  let resolve, generation = 1;
  const api = () => new Promise(done => { resolve = done; });
  const { $, events } = harness(api, { generation: () => generation });
  const loading = events.refresh(); generation++;
  resolve({ events: [{ id: 'old-workspace' }], nextCursor: null }); await loading;
  expect($('crew-events-list').children).toEqual([]);
});

it('preserves unrelated project rules while visible automation takes precedence', () => {
  const text = JSON.stringify({ projectRules: { p: { modules: ['src'], riskRules: [{ pattern: 'auth' }], automation: { mode: 'automatic_fix' } }, other: { automation: { mode: 'suggest' } } } });
  const result = parseWorkspacePolicy(text, true, undefined, { p: { mode: 'report_only' } });
  expect(result.projectRules).toEqual({ p: { modules: ['src'], riskRules: [{ pattern: 'auth' }], automation: { mode: 'report_only' } }, other: { automation: { mode: 'suggest' } } });
  expect(parseWorkspacePolicy(text, true, undefined, {}).projectRules).toEqual(JSON.parse(text).projectRules);
  expect(parseWorkspacePolicy(text, true, undefined, { p: null }).projectRules.p).toEqual({ modules: ['src'], riskRules: [{ pattern: 'auth' }] });
});

it('retries finding actions with stable IDs and shows refusals beside the finding', async () => {
  const event = { id: 'e', project_id: 'p', kind: 'push', branch: 'main', state: 'done' };
  let attempts = 0;
  const api = vi.fn(async (path, body) => {
    if (path.endsWith('/action')) { attempts++; if (attempts === 1) throw new Error('Network unavailable'); return { state: 'refused', reason: 'Project is report only' }; }
    if (path.endsWith('/e')) return { event, findings: [{ id: 'f', value: { title: '<finding>' }, disposition: 'human_review' }] };
    return { events: [event], nextCursor: null };
  });
  const { $, events } = harness(api, { manage: true });
  await events.refresh(); await flatten($('crew-events-list')).find(node => node.tag === 'button').listeners.click();
  const buttons = flatten($('crew-event-detail')).filter(node => node.tag === 'button');
  expect(buttons.some(node => node.textContent === 'Add regression test')).toBe(true);
  const fix = buttons.find(node => node.textContent === 'Request fix');
  await fix.listeners.click();
  expect(flatten($('crew-event-detail')).some(node => node.textContent === 'Network unavailable')).toBe(true);
  await fix.listeners.click();
  const requests = api.mock.calls.filter(([path]) => path.endsWith('/action'));
  expect(requests[0][1]).toEqual(requests[1][1]);
  expect(requests[0][1]).toEqual({ eventId: 'e', kind: 'fix', requestId: expect.any(String) });
  expect(flatten($('crew-event-detail')).some(node => node.textContent === 'Project is report only')).toBe(true);
});

it('links audited actions to their event run and preserves unknown refusal reasons', async () => {
  const event = { id: 'e', project_id: 'p', kind: 'push', branch: 'main', state: 'done' };
  const api = vi.fn(async path => path.endsWith('/e') ? { event, runs: [{ id: 'r', crew_id: 'c', state: 'queued' }], actions: [{ id: 'a', finding_id: 'f', event_id: 'e', kind: 'fix', target_crew_id: 'c', run_id: 'r', state: 'queued', reason: '<reason>', created_at: 1, verify_job_id: 'verify', verification_state: 'success' }] } : { events: [event], nextCursor: null });
  const { $, events } = harness(api);
  await events.refresh(); await flatten($('crew-events-list')).find(node => node.tag === 'button').listeners.click();
  const detail = flatten($('crew-event-detail'));
  expect(detail.find(node => node.tag === 'a').href).toBe('#crew-event-run-r');
  expect(detail.some(node => node.textContent === 'Run r · queued')).toBe(true);
  expect(detail.some(node => node.textContent === '<reason>')).toBe(true);
  expect(detail.some(node => node.textContent === 'Verification verify · success')).toBe(true);
});

it('refreshes a combined event after an accepted build-only finding action with an informational reason', async () => {
  const event = { id: 'root', project_id: 'p', kind: 'test_failure', source: 'smith-build', branch: 'main', state: 'evaluated' };
  let queued = false;
  const api = vi.fn(async (path, body) => {
    if (path.endsWith('/action')) { queued = true; return { actionId: 'a', runId: 'r', state: 'queued', reason: 'Queued through crew admission' }; }
    if (path.endsWith('/delivery')) return { requestedEventId: 'delivery', event, runs: queued ? [{ id: 'r', crew_id: 'fixer', state: 'queued' }] : [], findings: [{ id: 'build-finding', value: { title: 'Failed Smith build', detail: 'Inspect failed build log' }, disposition: 'human_review' }], actions: queued ? [{ id: 'a', finding_id: 'build-finding', event_id: 'root', kind: 'fix', target_crew_id: 'fixer', run_id: 'r', state: 'queued', reason: 'Queued through crew admission', created_at: 1 }] : [] };
    return { events: [{ ...event, id: 'delivery' }], nextCursor: null };
  });
  const { $, events } = harness(api, { manage: true });
  await events.refresh(); await flatten($('crew-events-list')).find(node => node.tag === 'button').listeners.click();
  expect(flatten($('crew-event-detail')).some(node => node.textContent === 'Failed Smith build')).toBe(true);
  await flatten($('crew-event-detail')).find(node => node.textContent === 'Request fix').listeners.click();
  expect(api.mock.calls.find(([path]) => path.endsWith('/action'))[1]).toMatchObject({ eventId: 'root', kind: 'fix' });
  expect(api.mock.calls.filter(([path]) => path.endsWith('/delivery'))).toHaveLength(2);
  expect(flatten($('crew-event-detail')).some(node => node.textContent === 'Run r · queued')).toBe(true);
});

it('shows API mode refusals for combined events and retains request identity when policy is corrected', async () => {
  const event = { id: 'root', project_id: 'p', kind: 'push', branch: 'main', state: 'evaluated' };
  const api = vi.fn(async path => {
    if (path.endsWith('/action')) throw new Error('This project does not allow this action in its current automation mode');
    if (path.endsWith('/delivery')) return { event, findings: [{ id: 'f', value: { title: 'Finding' }, disposition: 'human_review' }] };
    return { events: [{ ...event, id: 'delivery' }], nextCursor: null };
  });
  const { $, events } = harness(api, { manage: true });
  await events.refresh(); await flatten($('crew-events-list')).find(node => node.tag === 'button').listeners.click();
  const button = flatten($('crew-event-detail')).find(node => node.textContent === 'Add regression test');
  await button.listeners.click(); await button.listeners.click();
  expect(flatten($('crew-event-detail')).some(node => node.textContent === 'This project does not allow this action in its current automation mode')).toBe(true);
  const calls = api.mock.calls.filter(([path]) => path.endsWith('/action'));
  expect(calls[0][1]).toEqual(calls[1][1]);
  expect(calls[0][1].kind).toBe('regression_test');
});
