import { fail } from './http';
// An empty prefix denotes the whole repository. Preserve native filesystem case;
// only conflict comparison folds case across supported operating systems.
export function normalizeScope(value: string): string {
 if (typeof value !== 'string' || /[\\:*?\[\]{}()"\x00-\x20\x7f]/.test(value) || value.startsWith('/')) fail(400,'invalid_field','Write scopes must be repository-relative literal directories');
 if (value === '') return '';
 const parts=value.replace(/\/$/,'').split('/');
 const controls=['.git','.claude','.mcp.json','claude.md','claude.local.md','agents.md'];
 if (parts.some(p=>!p || p==='.' || p==='..' || controls.includes(p.toLowerCase()) || p.endsWith('.') || /^(con|prn|aux|nul|(com|lpt)[0-9])$/i.test(p.split('.')[0]))) fail(400,'invalid_field','Invalid write scope');
 const prefix=parts.join('/')+'/';
 // Native claim validation appends the four-byte probe name "file".
 if(new TextEncoder().encode(prefix).length>508)fail(400,'invalid_field','Write scope is too long');
 return prefix;
}
export function scopesOverlap(a: string,b: string): boolean {
 const left=normalizeScope(a).toLowerCase(),right=normalizeScope(b).toLowerCase();
 return left.startsWith(right) || right.startsWith(left);
}
