import { describe, expect, it } from 'vitest';
import { renderProjectAutomation } from '../public/crew-events.js';
class Node {
  constructor(tag, text) { this.tag = tag; this.textContent = text; this.children = []; this.attributes = {}; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(name, handler) { this[name] = handler; }
}
const flatten = node => [node, ...node.children.flatMap(flatten)];
function form(policy, editable = true, members = []) {
  const container = new Node('div');
  const read = renderProjectAutomation({ container, projects: [{ id: 'p', name: '<Project>' }], policy, members, editable, element: (tag, text) => new Node(tag, text) });
  return { read, nodes: flatten(container), field: key => flatten(container).find(node => node.id === `project-automation-0-${key}`) };
}
describe('project automation settings', () => {
  it('defaults new projects to report only with bounded verification disabled', () => {
    const { read, nodes, field } = form();
    expect(read()).toEqual({});
    expect(field('mode').disabled).toBe(true);
    field('apply').checked = true; field('apply').change();
    expect(field('mode').disabled).toBe(false);
    expect(read()).toEqual({ p: { mode: 'report_only', fixerCrewId: null, testCrewId: null, maxFixAttempts: 1, verification: { enabled: false, maxAttempts: 1, timeoutMinutes: 10 } } });
    expect(nodes.some(node => node.textContent?.includes('operator assertion'))).toBe(true);
    expect(nodes.some(node => node.textContent === '<Project>')).toBe(true);
    for (const control of nodes.filter(node => ['input', 'select'].includes(node.tag))) expect(nodes.some(node => node.tag === 'label' && node.attributes.for === control.id)).toBe(true);
  });
  it('round trips policy, reads edits, and validates numeric bounds', () => {
    const automation = { mode: 'suggest', fixerCrewId: 'fix', testCrewId: 'test', maxFixAttempts: 3, verification: { enabled: true, maxAttempts: 2, timeoutMinutes: 30 } };
    const { read, field } = form({ projectRules: { p: { automation } } });
    expect(read().p).toEqual(automation);
    field('mode').value = 'automatic_fix'; field('fixer').value = ' new-fixer ';
    expect(read().p).toMatchObject({ mode: 'automatic_fix', fixerCrewId: 'new-fixer' });
    for (const [key, invalid] of [['fixes', '6'], ['attempts', '0'], ['timeout', '61'], ['timeout', '1.5'], ['timeout', '']]) {
      const old = field(key).value; field(key).value = invalid; expect(() => read()).toThrow('whole number'); field(key).value = old;
    }
  });
  it('disables all project controls for read only settings', () => {
    expect(form(undefined, false).nodes.filter(node => ['input', 'select'].includes(node.tag)).every(node => node.disabled)).toBe(true);
  });
  it('offers only enabled scoped primary-project writers and preserves unavailable selections', () => {
    const writer = { id: 'writer', name: 'Fix it', enabled: true, projectIds: ['p'], permissionMode: 'acceptEdits', orchestration: { mode: 'write', writeScopes: ['src'] } };
    const members = [writer, { ...writer, id: 'disabled', enabled: false }, { ...writer, id: 'secondary', projectIds: ['other', 'p'] }, { ...writer, id: 'reader', permissionMode: 'plan' }, { ...writer, id: 'unscoped', orchestration: { mode: 'write', writeScopes: [] } }];
    const { field, read } = form({ projectRules: { p: { automation: { fixerCrewId: 'missing' } } } }, true, members);
    expect(field('fixer').children.map(node => node.value)).toEqual(['', 'writer', 'missing']);
    expect(field('fixer').children.find(node => node.value === 'writer').textContent).toBe('Fix it');
    expect(field('fixer').children.find(node => node.value === 'missing').disabled).toBe(true);
    expect(read().p.fixerCrewId).toBe('missing');
  });
  it('removes existing policy only when explicitly unchecked', () => {
    const { field, read } = form({ projectRules: { p: { automation: { mode: 'suggest' } } } });
    expect(read().p.mode).toBe('suggest'); field('apply').checked = false;
    expect(read()).toEqual({ p: null });
  });
});
