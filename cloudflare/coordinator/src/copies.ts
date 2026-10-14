// One budgeted copies layer (spec §4): which machine gets which repository or large-file copy. Pure: the workspace object
// builds the input from its tables and queues what comes back, so every rule here is tested without a Durable Object.
// A machine keeps large files once it is switched on and online (`eligible`); repository copies also need its agent's
// git-host label (`gitEligible`), since serving git needs git 2.36 and the store.
// switchedOn / gitLabelled: the same without the online check, for refreshing a stale copy a machine already holds: the
// task waits in its queue until the machine is back (a returning primary syncs on its first poll).
export interface CopyNode { id: string; hostname: string; eligible: boolean; gitEligible?: boolean; switchedOn?: boolean; gitLabelled?: boolean; freeBytes: number; budgetBytes: number; usageBytes: number }
export interface CopyItem { kind: 'repo' | 'lfs'; key: string; repoId: string; oid?: string; bytes: number; createdAt: number; copyable: boolean; holders: { nodeId: string; current: boolean; primary: boolean; heldAt: number }[]; pending: string[] }
// lfsPlanLimit: new large-file tasks a machine is given per pass (the poll hands out a few at a time; the queue holds the rest).
export interface CopyPlanInput { nodes: CopyNode[]; items: CopyItem[]; copiesPerItem: number; reserveBytes: number; lfsPlanLimit: number }
export interface CopyPlan { fetches: { nodeId: string; item: CopyItem }[]; refreshes: { nodeId: string; item: CopyItem }[]; drops: { nodeId: string; item: CopyItem }[]; under: CopyItem[]; full: Record<string, 'budget' | 'reserve' | ''> }

export function repoCost(bytes: number): number { return 2 * bytes + 1024 * 1024 * 1024; }
export function itemCost(item: CopyItem): number { return item.kind === 'repo' ? repoCost(item.bytes) : item.bytes; }
const held = (item: CopyItem) => item.holders.length + item.pending.length;
const byOrder = (a: CopyItem, b: CopyItem) => held(a) - held(b) || (a.kind === b.kind ? 0 : a.kind === 'repo' ? -1 : 1) || a.createdAt - b.createdAt || (a.key < b.key ? -1 : 1);

export function planCopies(input: CopyPlanInput): CopyPlan {
  const plan: CopyPlan = { fetches: [], refreshes: [], drops: [], under: [], full: {} };
  type Room = CopyNode & { unused: number; free: number; lfsNew: number; whyFull: 'budget' | 'reserve' | '' };
  const rooms = new Map<string, Room>();
  for (const n of input.nodes) rooms.set(n.id, { ...n, unused: n.budgetBytes - n.usageBytes, free: n.freeBytes, lfsNew: input.lfsPlanLimit, whyFull: '' });
  const able = (room: Room, item: CopyItem) => room.eligible && (item.kind === 'lfs' || room.gitEligible !== false);
  const ableToRefresh = (room: Room, item: CopyItem) => (room.switchedOn ?? room.eligible) && (item.kind === 'lfs' || (room.gitLabelled ?? room.gitEligible) !== false);
  // The budget counts the bytes a copy occupies; the free-disk reserve is checked against what the transfer needs
  // (itemCost: a repository fetch wants twice its size plus a margin while git unpacks it).
  const fits = (room: Room, item: CopyItem): boolean => {
    if (room.unused < item.bytes) { room.whyFull = room.whyFull || 'budget'; return false; }
    if (room.free - itemCost(item) < input.reserveBytes) { room.whyFull = room.whyFull || 'reserve'; return false; }
    return true;
  };
  const slot = (room: Room, item: CopyItem): boolean => item.kind === 'repo' || room.lfsNew > 0;
  const take = (room: Room, item: CopyItem) => { room.unused -= item.bytes; room.free -= itemCost(item); if (item.kind === 'lfs') room.lfsNew--; };
  const candidates = (item: CopyItem) => [...rooms.values()].filter(r => able(r, item) && r.freeBytes > 0 && !item.holders.some(h => h.nodeId === r.id) && !item.pending.includes(r.id)).sort((a, b) => b.unused - a.unused || (a.hostname < b.hostname ? -1 : 1));
  // Stale copies first: they already hold most of the bytes. A refresh is a replicate to the holder (no new room needed).
  for (const item of [...input.items].sort(byOrder)) {
    for (const holder of item.holders.filter(h => !h.current && !h.primary)) {
      const room = rooms.get(holder.nodeId);
      if (room && ableToRefresh(room, item) && !item.pending.includes(holder.nodeId)) plan.refreshes.push({ nodeId: holder.nodeId, item });
    }
  }
  for (const item of [...input.items].sort(byOrder)) {
    if (!item.copyable) continue;
    let missing = input.copiesPerItem - held(item);
    for (const room of candidates(item)) {
      if (missing <= 0) break;
      if (!slot(room, item)) continue;
      if (!fits(room, item)) continue;
      plan.fetches.push({ nodeId: room.id, item }); take(room, item); missing--;
    }
    if (missing > 0) plan.under.push(item);
  }
  // Shedding: a machine over budget drops its newest copy of an item that others still hold enough of (never a primary,
  // never the last current copy). One item per machine per pass; the next pass re-places it elsewhere.
  for (const room of rooms.values()) {
    if (room.budgetBytes - room.usageBytes >= 0) continue;
    room.whyFull = room.whyFull || 'budget';
    const mine = input.items.filter(i => i.holders.some(h => h.nodeId === room.id && !h.primary)).sort((a, b) => b.holders.find(h => h.nodeId === room.id)!.heldAt - a.holders.find(h => h.nodeId === room.id)!.heldAt);
    const victim = mine.find(i => { const others = i.holders.filter(h => h.nodeId !== room.id); return others.length >= input.copiesPerItem && others.some(h => h.current); });
    if (victim) plan.drops.push({ nodeId: room.id, item: victim });
  }
  for (const room of rooms.values()) if (room.eligible) plan.full[room.id] = room.whyFull;
  return plan;
}
