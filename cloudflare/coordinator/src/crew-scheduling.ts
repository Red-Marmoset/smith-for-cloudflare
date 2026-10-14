import type { Priority } from './crew-orchestration-model';
export interface DueInput { firstReceived:number;lastReceived:number;lastStarted:number|null;cooldownMs:number;debounceMs:number;maxDebounceWaitMs:number;jitterMs:number }
export function computeDue(input:DueInput):number {
 const debounce=Math.min(input.lastReceived+input.debounceMs,input.firstReceived+input.maxDebounceWaitMs);
 return Math.max(debounce,input.lastStarted===null?0:input.lastStarted+input.cooldownMs)+input.jitterMs;
}
// FNV-1a provides a stable scheduling spread, not a security primitive.
export function stableJitter(key:string,maxJitterMs:number):number {
 if(!Number.isSafeInteger(maxJitterMs)||maxJitterMs<=0)return 0;
 let hash=2166136261;for(const byte of new TextEncoder().encode(key)){hash^=byte;hash=Math.imul(hash,16777619);}
 return (hash>>>0)%(maxJitterMs+1);
}
export interface RankedCandidate {priority:Priority;dueAt:number;sequence:number}
export function rankCandidate(candidate:RankedCandidate,now:number):number {
 return ({high:100,normal:50,low:0}[candidate.priority])+Math.min(100,Math.max(0,Math.floor((now-candidate.dueAt)/60000)));
}
export function compareCandidates(a:RankedCandidate,b:RankedCandidate,now:number):number {
 return rankCandidate(b,now)-rankCandidate(a,now)||a.dueAt-b.dueAt||a.sequence-b.sequence;
}
