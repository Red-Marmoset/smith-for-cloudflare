'use strict';
// Settings → People: who is in this workspace, how they joined (Studio access or added by hand), and their role.
// Owners and admins change roles and remove people; anyone can leave. Rules are enforced by the coordinator
// (members.ts); this only hides controls that would be refused.

const ROLES = [['owner', 'Owner'], ['admin', 'Admin'], ['operator', 'Operator'], ['viewer', 'Viewer']];
const ROLE_HELP = { owner: 'everything, including ownership', admin: 'settings and people', operator: 'starts builds', viewer: 'sees builds' };

export function createMembers({ $, api, base, element, action, date, generation }) {
  let snapshot = '';

  function roleControl(person, view) {
    const label = ROLES.find(([value]) => value === person.role)?.[1] ?? person.role;
    // Only an owner changes an owner or makes one; nobody edits their own role here.
    const editable = view.canManage && !person.you && (view.role === 'owner' || person.role !== 'owner');
    if (!editable) return element('span', label, 'badge');
    const select = element('select'); select.setAttribute('aria-label', `Role for ${person.name}`);
    for (const [value, text] of ROLES) {
      if (value === 'owner' && view.role !== 'owner') continue;
      const option = element('option', text); option.value = value; select.append(option);
    }
    select.value = person.role;
    select.addEventListener('change', () => action(select, async () => {
      try { await api(`${base()}/members/${encodeURIComponent(person.userId)}`, { role: select.value }); }
      finally { snapshot = ''; await refresh(); }
    }));
    return select;
  }
  function render(view) {
    const next = JSON.stringify(view);
    if (next === snapshot) return; snapshot = next;
    $('members').replaceChildren();
    const owners = view.members.filter(m => m.role === 'owner').length;
    for (const person of view.members) {
      const row = element('div', undefined, 'token-row');
      const info = element('div');
      const how = person.via === 'studio' ? 'joined through Studio access' : person.role === 'owner' ? 'owner' : 'role set by hand';
      info.append(element('strong', person.name + (person.you ? ' (you)' : '')),
        element('p', `${ROLE_HELP[person.role] ?? person.role} · ${how}${person.joinedAt ? ' · since ' + date(person.joinedAt) : ''}`, 'muted small'));
      const controls = element('div', undefined, 'inline-actions');
      controls.append(roleControl(person, view));
      // The last owner can neither leave nor be removed (the coordinator refuses), so no button is offered.
      const lastOwner = person.role === 'owner' && owners <= 1;
      if (!lastOwner && (person.you || (view.canManage && (view.role === 'owner' || person.role !== 'owner')))) {
        const remove = element('button', person.you ? 'Leave' : 'Remove', 'quiet danger'); remove.type = 'button';
        remove.addEventListener('click', () => {
          const question = person.you ? 'Leave this workspace? You lose access until an owner or admin lets you back in.'
            : `Remove ${person.name}? They lose access now and do not rejoin through Studio access until you let them back in.`;
          if (!confirm(question)) return;
          void action(remove, async () => {
            await api(`${base()}/members/${encodeURIComponent(person.userId)}/remove`, {});
            if (person.you) { location.hash = ''; location.reload(); return; }
            snapshot = ''; await refresh();
          });
        });
        controls.append(remove);
      }
      row.append(info, controls); $('members').append(row);
    }
    $('removed-members-section').hidden = !view.removed.length;
    $('removed-members').replaceChildren();
    for (const person of view.removed) {
      const row = element('div', undefined, 'token-row');
      const info = element('div');
      info.append(element('strong', person.name), element('p', `removed ${date(person.removedAt)}`, 'muted small'));
      const allow = element('button', 'Let back in', 'quiet'); allow.type = 'button';
      allow.addEventListener('click', () => action(allow, async () => {
        await api(`${base()}/members/${encodeURIComponent(person.userId)}/allow`, {}); snapshot = ''; await refresh();
      }));
      row.append(info, allow); $('removed-members').append(row);
    }
  }
  async function refresh() {
    const current = generation();
    const view = await api(base() + '/members');
    if (current === generation()) render(view);
  }
  function reset() { snapshot = ''; $('members').replaceChildren(); $('removed-members').replaceChildren(); $('removed-members-section').hidden = true; }
  return { refresh, reset };
}
