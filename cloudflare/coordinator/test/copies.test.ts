import { describe, expect, it } from 'vitest';
import { planCopies, repoCost, type CopyItem, type CopyNode } from '../src/copies';

const GiB = 1073741824;
const node = (id: string, over: Partial<CopyNode> = {}): CopyNode => ({ id, hostname: id.toUpperCase(), eligible: true, freeBytes: 400 * GiB, budgetBytes: 50 * GiB, usageBytes: 0, ...over });
const repo = (id: string, bytes: number, holders: CopyItem['holders'] = [], over: Partial<CopyItem> = {}): CopyItem => ({ kind: 'repo', key: id, repoId: id, bytes, createdAt: 1, copyable: true, holders, pending: [], ...over });
const lfs = (repoId: string, oid: string, bytes: number, holders: CopyItem['holders'] = []): CopyItem => ({ kind: 'lfs', key: `${repoId}/${oid}`, repoId, oid, bytes, createdAt: 2, copyable: true, holders, pending: [] });
const input = (nodes: CopyNode[], items: CopyItem[], over = {}) => ({ nodes, items, copiesPerItem: 2, reserveBytes: 10 * GiB, lfsPlanLimit: 50, ...over });

describe('planCopies', () => {
  it('places each item on the machines with the most unused budget, up to the target, deterministically', () => {
    const plan = planCopies(input([node('a', { usageBytes: 30 * GiB }), node('b'), node('c', { usageBytes: 10 * GiB })], [repo('senet', GiB)]));
    expect(plan.fetches.map(f => f.nodeId)).toEqual(['b', 'c']);
    expect(plan.under).toEqual([]);
  });
  it('counts the free-disk reserve and the budget, and reports what is full', () => {
    const small = node('a', { freeBytes: 12 * GiB });            // 12 free − 3 cost < 10 reserve
    const tight = node('b', { budgetBytes: GiB / 2 });           // a 1 GiB copy does not fit half a GiB of budget
    const plan = planCopies(input([small, tight], [repo('senet', GiB)]));
    expect(plan.fetches).toEqual([]);
    expect(plan.under.map(i => i.key)).toEqual(['senet']);
    expect(plan.full).toEqual({ a: 'reserve', b: 'budget' });
  });
  it('refreshes stale copies before making new ones, and never asks a holder again', () => {
    const items = [repo('senet', GiB, [{ nodeId: 'a', current: false, primary: false, heldAt: 1 }])];
    const plan = planCopies(input([node('a'), node('b')], items));
    expect(plan.refreshes.map(r => r.nodeId)).toEqual(['a']);
    expect(plan.fetches.map(f => f.nodeId)).toEqual(['b']);
  });
  it('refreshes a stale copy on a switched-on machine that is offline, so the task waits for it to return', () => {
    const items = [repo('senet', GiB, [{ nodeId: 'a', current: false, primary: false, heldAt: 1 }, { nodeId: 'b', current: true, primary: true, heldAt: 2 }])];
    const plan = planCopies(input([node('a', { eligible: false, switchedOn: true, gitLabelled: true }), node('b')], items));
    expect(plan.refreshes.map(r => r.nodeId)).toEqual(['a']);
    expect(plan.fetches).toEqual([]);   // a holds it already; nothing new goes to an offline machine
  });
  it('orders items by copies held, repositories before large files, oldest first', () => {
    const items = [lfs('senet', 'o1', 100, [{ nodeId: 'a', current: true, primary: false, heldAt: 1 }]), repo('late', 10, [], { createdAt: 9 }), repo('early', 10), lfs('senet', 'o2', 100)];
    const plan = planCopies(input([node('a'), node('b')], items));
    expect(plan.fetches.map(f => f.item.key + '@' + f.nodeId)).toEqual(['early@a', 'early@b', 'late@a', 'late@b', 'senet/o2@a', 'senet/o2@b', 'senet/o1@b']);
  });
  it('gives a machine at most fifty new large-file tasks a pass, spreading the rest and reporting what waits', () => {
    const items = [repo('r1', 1), repo('r2', 1), ...Array.from({ length: 120 }, (_, i) => lfs('senet', 'o' + i, 1))];
    const plan = planCopies(input([node('a'), node('b')], items, { copiesPerItem: 1 }));
    expect(plan.fetches.filter(f => f.item.kind === 'repo').map(f => f.nodeId)).toEqual(['a', 'b']);   // the least-loaded machine each time
    expect(plan.fetches.filter(f => f.item.kind === 'lfs' && f.nodeId === 'a')).toHaveLength(50);
    expect(plan.fetches.filter(f => f.item.kind === 'lfs' && f.nodeId === 'b')).toHaveLength(50);
    expect(plan.under).toHaveLength(20);   // next pass
  });
  it('sheds one item per pass from a machine over budget, newest copy first, never the primary or the last current copy', () => {
    const holders = (...ids: string[]) => ids.map((id, i) => ({ nodeId: id, current: true, primary: false, heldAt: i }));
    const over = node('a', { budgetBytes: GiB, usageBytes: 3 * GiB });
    const items = [repo('r1', 1, holders('a', 'b', 'c')), repo('r2', 1, [...holders('b', 'c'), { nodeId: 'a', current: true, primary: false, heldAt: 9 }]), repo('p', 1, [{ nodeId: 'a', current: true, primary: true, heldAt: 10 }, ...holders('b', 'c')])];
    const plan = planCopies(input([over, node('b'), node('c')], items));
    expect(plan.drops).toEqual([{ nodeId: 'a', item: items[1] }]);   // r2: newest on a, others still hold it; p is the primary
  });
  it('shedding stops at the last current copy', () => {
    const over = node('a', { budgetBytes: GiB, usageBytes: 3 * GiB });
    const items = [repo('r1', 1, [{ nodeId: 'a', current: true, primary: false, heldAt: 1 }, { nodeId: 'b', current: false, primary: false, heldAt: 2 }])];
    const plan = planCopies(input([over, node('b', { budgetBytes: 0 })], items));
    expect(plan.drops).toEqual([]);
    expect(plan.full.a).toBe('budget');
  });
  it('never copies an oversize repository and skips machines without a report', () => {
    const plan = planCopies(input([node('a', { freeBytes: 0 }), node('b')], [repo('big', 2 * GiB, [], { copyable: false }), repo('ok', 1)]));
    expect(plan.fetches.map(f => f.item.key + '@' + f.nodeId)).toEqual(['ok@b']);
    expect(plan.under.map(i => i.key)).toEqual(['ok']);   // one of two copies placed
  });
  it('repoCost is the replicate margin', () => { expect(repoCost(GiB)).toBe(3 * GiB); });
});
