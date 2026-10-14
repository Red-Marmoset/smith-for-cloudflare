import { fail, fields, json, string } from './http';

// Who may use a workspace. A member is added in one of two ways:
//  - 'studio': the workspace's Studio access setting admits every account of the Google Workspace domain
//    (GOOGLE_ALLOWED_DOMAIN); such a person joins the first time they load the dashboard, with the role the
//    setting names, and leaves again when the setting is turned off.
//  - 'added': the creator (owner), or anyone whose role an owner or admin set by hand, which pins it: a later
//    change of the Studio access role, or turning it off, leaves them alone.
// Removing someone also blocks them from rejoining through Studio access until an admin lets them back.
// The Durable Object is the authority; D1's workspace_directory is only the index that lists a person's
// workspaces, kept in step by the caller (see WorkspaceCoordinator).
export const MEMBER_ROLES = ['owner', 'admin', 'operator', 'viewer'] as const;
export type MemberRole = typeof MEMBER_ROLES[number];
export const STUDIO_ACCESS = ['off', 'viewer', 'operator', 'admin'] as const;
export type StudioAccess = typeof STUDIO_ACCESS[number];
export const MEMBER_ACTIONS = ['members', 'put-member', 'remove-member', 'allow-member'];
// Added by schema migration 15 in WorkspaceCoordinator, after the members table already exists.
export const MEMBER_MIGRATION = [
  "ALTER TABLE members ADD COLUMN via TEXT NOT NULL DEFAULT 'added'",
  'ALTER TABLE members ADD COLUMN joined_at INTEGER',
  'CREATE TABLE member_blocks (user_id TEXT PRIMARY KEY, blocked_at INTEGER NOT NULL)',
];
const USER_ID = /^[A-Za-z0-9_-]{1,100}$/;
type MemberRow = { user_id: string; role: string; via: string; joined_at: number | null };
const isAdmin = (role: string | undefined) => role === 'owner' || role === 'admin';

export class Members {
  constructor(private readonly sql: SqlStorage) {}

  private row(userId: string): MemberRow | undefined {
    return this.sql.exec<MemberRow>('SELECT user_id, role, via, joined_at FROM members WHERE user_id = ?', userId).toArray()[0];
  }
  private owners(): number { return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM members WHERE role = 'owner'").one().n; }

  // Joins `userId` through Studio access. The caller has already checked that this person signed in with
  // a Google account of the allowed domain; this checks the workspace admits them.
  studioJoin(userId: string, access: StudioAccess, now: number): { joined: boolean } {
    if (this.row(userId)) return { joined: false };
    if (access === 'off') fail(403, 'forbidden', 'This workspace is not shared with the studio');
    if (this.sql.exec('SELECT user_id FROM member_blocks WHERE user_id = ?', userId).toArray().length) fail(403, 'forbidden', 'You were removed from this workspace');
    this.sql.exec("INSERT INTO members (user_id, role, via, joined_at) VALUES (?, ?, 'studio', ?)", userId, access, now);
    return { joined: true };
  }

  // Applies a changed Studio access setting to the people who joined through it. Returns who left.
  applyStudioAccess(access: StudioAccess): string[] {
    if (access !== 'off') { this.sql.exec("UPDATE members SET role = ? WHERE via = 'studio'", access); return []; }
    return this.sql.exec<{ user_id: string }>("DELETE FROM members WHERE via = 'studio' RETURNING user_id").toArray().map(r => r.user_id);
  }

  // `left` names anyone who is no longer a member, so the caller can drop them from D1's directory.
  execute(userId: string, action: string, body: Record<string, unknown>, now: number): { response: Response; left: string[] } {
    const me = this.row(userId);
    if (!me) fail(403, 'forbidden', 'Workspace permission required');
    if (action === 'members') {
      fields(body, []);
      const members = this.sql.exec<MemberRow>('SELECT user_id, role, via, joined_at FROM members ORDER BY joined_at IS NULL DESC, joined_at, user_id').toArray()
        .map(m => ({ userId: m.user_id, role: m.role, via: m.via, joinedAt: m.joined_at, you: m.user_id === userId }));
      const removed = isAdmin(me.role) ? this.sql.exec<{ user_id: string; blocked_at: number }>('SELECT user_id, blocked_at FROM member_blocks ORDER BY blocked_at DESC LIMIT 100').toArray()
        .map(b => ({ userId: b.user_id, removedAt: b.blocked_at })) : [];
      return { response: json({ members, removed, role: me.role, canManage: isAdmin(me.role) }), left: [] };
    }
    const targetId = string(body, 'userId', 100);
    if (!USER_ID.test(targetId)) fail(400, 'invalid_field', 'Invalid field: userId');
    if (action === 'allow-member') {
      fields(body, ['userId']);
      if (!isAdmin(me.role)) fail(403, 'forbidden', 'Only owners and admins can let people back in');
      this.sql.exec('DELETE FROM member_blocks WHERE user_id = ?', targetId);
      return { response: json({ allowed: true }), left: [] };
    }
    const target = this.row(targetId);
    if (!target) fail(404, 'not_found', 'That person is not a member of this workspace');
    // Only an owner changes or removes an owner, or makes someone one; the last owner always stays.
    const touchesOwner = target.role === 'owner';
    if (action === 'put-member') {
      fields(body, ['userId', 'role']);
      const role = body.role as MemberRole;
      if (!MEMBER_ROLES.includes(role)) fail(400, 'invalid_field', `role must be one of ${MEMBER_ROLES.join(', ')}`);
      if (!isAdmin(me.role)) fail(403, 'forbidden', 'Only owners and admins can change roles');
      if ((touchesOwner || role === 'owner') && me.role !== 'owner') fail(403, 'forbidden', 'Only an owner can change who owns this workspace');
      if (touchesOwner && role !== 'owner' && this.owners() <= 1) fail(409, 'last_owner', 'A workspace needs an owner. Make someone else an owner first.');
      this.sql.exec("UPDATE members SET role = ?, via = 'added' WHERE user_id = ?", role, targetId);
      return { response: json({ userId: targetId, role, via: 'added' }), left: [] };
    }
    if (action === 'remove-member') {
      fields(body, ['userId']);
      const self = targetId === userId;
      if (!self && !isAdmin(me.role)) fail(403, 'forbidden', 'Only owners and admins can remove people');
      if (!self && touchesOwner && me.role !== 'owner') fail(403, 'forbidden', 'Only an owner can remove an owner');
      if (touchesOwner && this.owners() <= 1) fail(409, 'last_owner', self ? 'You are the only owner. Make someone else an owner before you leave.' : 'A workspace needs an owner.');
      this.sql.exec('DELETE FROM members WHERE user_id = ?', targetId);
      this.sql.exec('INSERT INTO member_blocks (user_id, blocked_at) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET blocked_at = excluded.blocked_at', targetId, now);
      return { response: json({ removed: targetId }), left: [targetId] };
    }
    fail(404, 'not_found', 'Route not found');
  }
}
