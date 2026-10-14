'use strict';
// Messages: what crew members send each other and people send them (src/crew-messages.ts), newest first, with a filter
// (every message, those to everyone, or one member's) and, for operators, a composer and Delete. A body is untrusted
// text: it is rendered by renderMarkdown (raw HTML disabled), as chat replies are, and never set as markup any other way.

const SIZE = 8192;   // MESSAGE_BYTES in src/crew-messages.ts
const byteLength = text => new TextEncoder().encode(text).length;

// What a message's row says and offers. A person is shown by name, never by ID. Pure, for tests.
export function messageView(m, { memberName = () => null, names = {}, canManage = false } = {}) {
  const from = m.from?.crewId ? memberName(m.from.crewId) || m.from.name || 'A deleted crew member'
    : m.from?.name || names[m.from?.userId] || 'A workspace member';
  const to = m.to ? memberName(m.to) || 'a deleted crew member' : 'everyone';
  return { from, to, meta: `${from} to ${to}`, byMember: Boolean(m.from?.crewId), deletable: canManage };
}
// Whether a message shows under the filter: '' every message, 'everyone' those to the whole crew, or a member's ID for
// the messages it sent or was sent.
export function messageMatches(m, filter) {
  if (!filter) return true;
  if (filter === 'everyone') return !m.to;
  return m.to === filter || m.from?.crewId === filter;
}
// Why the composer cannot send this body, or '' when it can.
export function composeProblem(body) {
  if (!body.trim()) return 'Write a message first.';
  return byteLength(body) > SIZE ? `A message holds at most ${SIZE} bytes; this one has ${byteLength(body)}.` : '';
}

export function createMessages({ $, api, base, element, date, action, renderMarkdown, members, canManage, generation }) {
  let messages = [], names = {}, snapshot = '', choices = '';
  const memberName = id => members().find(m => m.id === id)?.name ?? null;
  const option = (value, label) => { const node = element('option', label); node.value = value; return node; };

  async function refresh() {
    const current = generation();
    const result = await api(`${base()}/crew/messages`);
    if (current !== generation()) return;
    messages = result.messages; names = result.names ?? {};
    render();
  }
  // The filter and the composer's recipient follow the crew (rebuilt only when it changes, so a poll never closes an open
  // list); a choice whose member is gone falls back to every message, or to everyone.
  function fillChoices() {
    const crew = members().map(m => [m.id, m.name]);
    if (JSON.stringify(crew) === choices) return; choices = JSON.stringify(crew);
    const filter = $('crew-messages-filter'), to = $('crew-message-to');
    const keepFilter = filter.value, keepTo = to.value;
    filter.replaceChildren(option('', 'All messages'), option('everyone', 'To everyone'), ...crew.map(([id, name]) => option(id, `${name}’s messages`)));
    to.replaceChildren(option('', 'Everyone'), ...crew.map(([id, name]) => option(id, name)));
    filter.value = [...filter.options].some(o => o.value === keepFilter) ? keepFilter : '';
    to.value = [...to.options].some(o => o.value === keepTo) ? keepTo : '';
  }
  function render() {
    fillChoices();
    $('crew-message-form').hidden = !canManage();
    const filter = $('crew-messages-filter').value;
    const shown = messages.filter(m => messageMatches(m, filter)).map(m => ({ m, view: messageView(m, { memberName, names, canManage: canManage() }) }));
    const next = JSON.stringify([filter, shown.map(({ m, view }) => [m.seq, m.body, m.createdAt, view])]);
    if (next === snapshot) return; snapshot = next;
    const box = $('crew-messages'); box.replaceChildren();
    if (!shown.length) {
      box.append(element('p', messages.length ? 'No messages match this filter.' : 'No crew messages yet. Members that may message post here, and operators can write to them above.', 'empty small'));
      return;
    }
    for (const { m, view } of shown) box.append(row(m, view));
  }
  function row(m, view) {
    const item = element('article', undefined, 'crew-row crew-message');
    item.append(element('p', `${view.meta} · ${date(m.createdAt)}`, 'muted small'));
    const body = element('div', undefined, 'crew-message-body');
    body.innerHTML = renderMarkdown(String(m.body));   // markdown-it with raw HTML disabled
    item.append(body);
    if (view.deletable) {
      const buttons = element('div', undefined, 'crew-actions');
      const remove = element('button', 'Delete', 'quiet danger'); remove.type = 'button';
      remove.addEventListener('click', () => action(remove, async () => {
        if (!confirm(`Delete this message from ${view.from}? Runs that already received it keep their copy.`)) return;
        await api(`${base()}/crew/messages/${encodeURIComponent(m.seq)}/delete`, {}); snapshot = ''; await refresh();
      }));
      buttons.append(remove); item.append(buttons);
    }
    return item;
  }
  function reset() {
    messages = []; names = {}; snapshot = ''; choices = '';
    $('crew-messages').replaceChildren(); $('crew-message-body').value = ''; $('crew-message-hint').textContent = '';
  }

  $('crew-messages-filter').addEventListener('change', render);
  $('crew-message-body').addEventListener('input', () => { $('crew-message-hint').textContent = byteLength($('crew-message-body').value) > SIZE ? composeProblem($('crew-message-body').value) : ''; });
  $('crew-message-form').addEventListener('submit', event => {
    event.preventDefault();
    void action($('send-crew-message'), async () => {
      const body = $('crew-message-body').value, problem = composeProblem(body);
      $('crew-message-hint').textContent = problem;
      if (problem) return;
      const current = generation(), to = $('crew-message-to').value;
      await api(`${base()}/crew/messages`, to ? { to, body } : { body });
      if (current !== generation()) return;
      $('crew-message-body').value = ''; snapshot = ''; await refresh();
    });
  });
  return { refresh, reset };
}
