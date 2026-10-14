// Crew messages: what members send each other (crew_send) and people send them (the dashboard's composer), the inbox a run
// gets at its claim and through crew_inbox, and the roster crew_list shows. Bodies are untrusted text: stored and shown as
// data, quoted and attributed wherever a prompt carries them (crew-prompt.ts), and never acted on here. Re-exported from crew.ts.
import { fail, fields, json } from './http';
import type { Project } from './projects';
import type { RepoProject } from './repo-projects';

export const MESSAGE_BYTES = 8192;                 // the most a message body holds
export const MESSAGES_PER_RUN = 20;                // crew_send calls one run may make
const KEEP_MESSAGES = 2000;                        // the workspace keeps its newest messages
const INBOX_SIZE = 50;                             // the newest messages a run is handed
const FEED_SIZE = 200;                             // the newest messages the dashboard is sent

// One message in a run's inbox: who sent it, as the prompt names them, and when.
export interface CrewInboxEntry { seq: number; from: string; body: string; at: number }
// One message in the workspace's feed. A person's `name` is filled in by the Worker from the identity database.
export interface CrewMessage { seq: number; from: { crewId: string; name: string } | { userId: string; name: string }; to: string | null; body: string; sessionId: string | null; createdAt: number }
type MessageRow = { seq: number; from_crew_id: string | null; from_user_id: string | null; to_crew_id: string | null; session_id: string | null; body: string; created_at: number;
  from_name: string | null; from_role: string | null };
const SELECT = `SELECT m.seq, m.from_crew_id, m.from_user_id, m.to_crew_id, m.session_id, m.body, m.created_at, c.name AS from_name, p.role AS from_role
  FROM crew_messages m LEFT JOIN crew_members c ON c.id = m.from_crew_id LEFT JOIN members p ON p.user_id = m.from_user_id`;

// A message from neither a member nor a person is Smith's own (a project a member created, or could not create).
function feedEntry(r: MessageRow): CrewMessage {
  return { seq: r.seq, from: r.from_crew_id ? { crewId: r.from_crew_id, name: r.from_name ?? 'A deleted crew member' } : { userId: r.from_user_id ?? '', name: r.from_user_id ? '' : 'Smith' },
    to: r.to_crew_id, body: r.body, sessionId: r.session_id, createdAt: r.created_at };
}
// The Durable Object has no names for people (they live in the identity database), so a run reads their role instead.
function sender(r: MessageRow): string {
  if (r.from_crew_id) return r.from_name ?? 'a deleted crew member';
  if (!r.from_user_id) return 'Smith';
  return r.from_role ? `a person (${r.from_role})` : 'a person no longer in the workspace';
}

export class CrewMessages {
  constructor(private sql: SqlStorage) {}

  // crew-messages: the feed, newest first; `after` returns only messages newer than that seq.
  list(body: Record<string, unknown>): Response {
    fields(body, ['after']);
    const after = body.after ?? 0;
    if (!Number.isSafeInteger(after) || (after as number) < 0) fail(400, 'invalid_field', 'after must be a message seq');
    return json({ messages: this.sql.exec<MessageRow>(`${SELECT} WHERE m.seq > ? ORDER BY m.seq DESC LIMIT ?`, after, FEED_SIZE).toArray().map(feedEntry) });
  }

  // crew-message: a person (an operator, checked by the workspace) writes to one member or to everyone.
  post(userId: string, body: Record<string, unknown>, now: number): Response {
    fields(body, ['to', 'body']);
    const text = this.body(body), to = this.recipient(body);
    const seq = this.insert({ fromUserId: userId, to, sessionId: null, body: text, now });
    return json(feedEntry(this.sql.exec<MessageRow>(`${SELECT} WHERE m.seq = ?`, seq).one()), 201);
  }

  // crew-message-delete: an operator removes one message from the feed (and from every inbox not yet handed out).
  remove(body: Record<string, unknown>): Response {
    fields(body, ['seq']);
    if (!Number.isSafeInteger(body.seq)) fail(400, 'invalid_field', 'seq must be a message seq');
    if (!this.sql.exec('SELECT 1 FROM crew_messages WHERE seq = ?', body.seq).toArray().length) fail(404, 'not_found', 'Message not found');
    this.sql.exec('DELETE FROM crew_messages WHERE seq = ?', body.seq);
    return json({ deleted: true });
  }

  // crew-tool-send: a running member writes, as itself and from its session, at most MESSAGES_PER_RUN times per run.
  send(crewId: string, sessionId: string, body: Record<string, unknown>, now: number): Response {
    fields(body, ['to', 'body']);
    const member = this.sql.exec<{ may_message: number }>('SELECT may_message FROM crew_members WHERE id = ?', crewId).toArray()[0];
    if (!member) fail(409, 'crew_member_missing', 'This crew run’s member no longer exists');
    if (!member.may_message) fail(403, 'forbidden', 'This crew member may not send messages (a person turned that off in its settings); put what you would say in your report');
    const text = this.body(body), to = this.recipient(body);
    const sent = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM crew_messages WHERE session_id = ?', sessionId).one().n;
    if (sent >= MESSAGES_PER_RUN) fail(409, 'message_cap', `This run has sent its ${MESSAGES_PER_RUN} messages, the most one run may; put anything more in your report`);
    const seq = this.insert({ fromCrewId: crewId, to, sessionId, body: text, now });
    const name = to ? this.sql.exec<{ name: string }>('SELECT name FROM crew_members WHERE id = ?', to).one().name : null;
    return json({ seq, to, toName: name }, 201);
  }

  // What a run is handed (claim material, the prompt, crew_inbox): messages to its member or to everyone since its previous
  // completed or failed run started (all of them before its first), never its own, the newest INBOX_SIZE, oldest first.
  inbox(crewId: string): CrewInboxEntry[] {
    const rows = this.sql.exec<MessageRow>(`${SELECT}
      WHERE (m.to_crew_id = ? OR m.to_crew_id IS NULL) AND (m.from_crew_id IS NULL OR m.from_crew_id != ?)
        AND m.created_at >= COALESCE((SELECT MAX(started_at) FROM crew_runs WHERE crew_id = ? AND state IN ('completed', 'failed')), 0)
      ORDER BY m.seq DESC LIMIT ?`, crewId, crewId, crewId, INBOX_SIZE).toArray();
    return rows.reverse().map(r => ({ seq: r.seq, from: sender(r), body: r.body, at: r.created_at }));
  }

  // crew_list: who is in the crew (with the first line of each charter) and the projects crew members made, which any
  // member may read. `shared` is the crew-made projects (crew.ts crewCreated).
  roster(shared: (Project | RepoProject)[]): Response {
    const members = this.sql.exec<{ id: string; slug: string; name: string; charter: string }>('SELECT id, slug, name, charter FROM crew_members ORDER BY created_at, id').toArray()
      .map(m => ({ id: m.id, slug: m.slug, name: m.name, charter: m.charter.split('\n')[0].trim().slice(0, 200) }));
    return json({ members, sharedProjects: shared.map(p => ({ id: p.id, name: p.name, purpose: p.purpose ?? '', remote: p.repoUrl })) });
  }

  // Smith's own message to one member, or (null) to everyone.
  system(to: string | null, body: string, now: number): void { this.insert({ to, sessionId: null, body: body.slice(0, MESSAGE_BYTES / 4), now }); }

  // The workspace keeps its newest KEEP_MESSAGES messages (Crew.retention, from the alarm).
  retention(): void {
    this.sql.exec('DELETE FROM crew_messages WHERE seq <= (SELECT seq FROM crew_messages ORDER BY seq DESC LIMIT 1 OFFSET ?)', KEEP_MESSAGES);
  }

  private insert(m: { fromCrewId?: string; fromUserId?: string; to: string | null; sessionId: string | null; body: string; now: number }): number {
    return this.sql.exec<{ seq: number }>('INSERT INTO crew_messages (from_crew_id, from_user_id, to_crew_id, session_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING seq',
      m.fromCrewId ?? null, m.fromUserId ?? null, m.to, m.sessionId, m.body, m.now).one().seq;
  }
  private body(body: Record<string, unknown>): string {
    const text = body.body;
    if (typeof text !== 'string' || !text.trim() || new TextEncoder().encode(text).length > MESSAGE_BYTES) fail(400, 'invalid_field', `body must be 1 to ${MESSAGE_BYTES} bytes of text`);
    return text;
  }
  // A member's ID, or nothing (null) for everyone.
  private recipient(body: Record<string, unknown>): string | null {
    if (body.to === undefined || body.to === null) return null;
    if (typeof body.to !== 'string' || !this.sql.exec('SELECT 1 FROM crew_members WHERE id = ?', body.to).toArray().length)
      fail(400, 'invalid_field', 'to must be a crew member’s ID (see crew_list), or left out to write to everyone');
    return body.to;
  }
}
