'use strict';
// The CLI transcript renderers shared by chats and crew runs: Claude Code's stream-json events and Codex's
// thread/turn/item events become DOM nodes. `element` sets text only, and `renderMarkdown` renders replies with raw
// HTML disabled, so nothing a model prints becomes markup. `badge` (a state's badge) is needed only by turnFooter.

export function createTranscriptRenderers({ element, renderMarkdown, badge }) {
  function toolSummary(name, input) {
    const value = input?.command ?? input?.file_path ?? input?.path ?? input?.pattern ?? input?.url ?? input?.description;
    return value ? `${name}: ${String(value).split('\n')[0].slice(0, 160)}` : name;
  }
  function resultText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(part => typeof part?.text === 'string' ? part.text : '').join('\n');
    return JSON.stringify(content ?? '', null, 2);
  }
  function details(summary, body, className) {
    const box = element('details', undefined, className);
    box.append(element('summary', summary), element('pre', body.length > 6000 ? body.slice(0, 6000) + '\n…' : body));
    return box;
  }
  function bubble(text) {
    const node = element('div', undefined, 'chat-bubble assistant');
    node.innerHTML = renderMarkdown(String(text)); // markdown-it with raw HTML disabled
    return node;
  }
  function renderClaude(data) {
    if (data.type === 'system' && data.subtype === 'init') return element('p', `Claude Code started${data.model ? ` · ${data.model}` : ''}${data.permissionMode ? ` · ${data.permissionMode}` : ''}`, 'chat-status');
    if (data.type === 'assistant' || data.type === 'user') {
      const out = element('div');
      for (const part of data.message?.content || []) {
        if (part.type === 'text' && data.type === 'assistant') out.append(bubble(part.text));
        else if (part.type === 'tool_use') out.append(details(toolSummary(part.name, part.input), JSON.stringify(part.input ?? {}, null, 2), 'chat-tool'));
        else if (part.type === 'tool_result') out.append(details(part.is_error ? 'Tool error' : 'Tool result', resultText(part.content), `chat-tool result${part.is_error ? ' error' : ''}`));
      }
      return out.childNodes.length ? out : null;
    }
    if (data.type === 'result') {
      const out = element('div', undefined, 'chat-result');
      const seconds = Number.isFinite(data.duration_ms) ? ` in ${Math.round(data.duration_ms / 1000)}s` : '';
      out.append(element('p', `${data.subtype === 'success' ? 'Finished' : 'Ended early'}${seconds}${Number.isFinite(data.num_turns) ? ` · ${data.num_turns} steps` : ''}`, 'chat-status'));
      const denied = (data.permission_denials || []).map(d => d?.tool_name).filter(Boolean);
      if (denied.length) out.append(element('p', `Not allowed in this mode: ${[...new Set(denied)].join(', ')}. Pick a different permission mode and send again to allow it.`, 'chat-warning'));
      return out;
    }
    return null;
  }
  // Codex prints thread/turn/item events; each item is shown once, when it completes.
  function renderCodex(data) {
    if (data.type === 'thread.started') return element('p', 'Codex started', 'chat-status');
    if (data.type === 'turn.completed') return element('p', `Finished${Number.isFinite(data.usage?.output_tokens) ? ` · ${data.usage.output_tokens} output tokens` : ''}`, 'chat-status');
    if (data.type === 'turn.failed' || data.type === 'error') return element('p', `Codex stopped: ${data.error?.message || data.message || 'unknown error'}`, 'chat-warning');
    // A command's start is relayed so a long build shows up before it finishes.
    if (data.type === 'item.started' && data.item?.type === 'command_execution') return element('p', `Running: ${String(data.item.command ?? '').split('\n')[0].slice(0, 160)}`, 'chat-status');
    if (data.type !== 'item.completed' || !data.item) return null;
    const item = data.item;
    if (item.type === 'agent_message') return bubble(item.text ?? '');
    if (item.type === 'reasoning') return details('Thinking', String(item.text ?? ''), 'chat-tool');
    if (item.type === 'command_execution') {
      const declined = item.status === 'declined';
      const summary = `${declined ? 'Refused' : item.status === 'failed' ? 'Failed' : 'Ran'}: ${String(item.command ?? '').split('\n')[0].slice(0, 160)}${Number.isInteger(item.exit_code) ? ` (exit ${item.exit_code})` : ''}`;
      return details(summary, String(item.aggregated_output ?? ''), `chat-tool${declined || item.status === 'failed' ? ' error' : ''}`);
    }
    if (item.type === 'file_change') {
      const changes = (item.changes || []).map(c => `${c.kind === 'add' ? 'Added' : c.kind === 'delete' ? 'Deleted' : 'Changed'} ${c.path}`);
      return details(`Files: ${changes.length} ${changes.length === 1 ? 'change' : 'changes'}`, changes.join('\n'), `chat-tool${item.status === 'failed' ? ' error' : ''}`);
    }
    if (item.type === 'mcp_tool_call') return details(`Tool ${item.server ?? ''}.${item.tool ?? ''}${item.error ? ' (error)' : ''}`, JSON.stringify({ arguments: item.arguments, result: item.result, error: item.error }, null, 2), `chat-tool${item.error ? ' error' : ''}`);
    if (item.type === 'web_search') return element('p', `Searched the web: ${item.query ?? ''}`, 'chat-status');
    if (item.type === 'todo_list') return details('Plan', (item.items || []).map(t => `${t.completed ? '[x]' : '[ ]'} ${t.text}`).join('\n'), 'chat-tool');
    if (item.type === 'error') return element('p', String(item.message ?? 'Error'), 'chat-warning');
    return null;
  }
  // One stored session event: Smith's status lines, the CLI's stderr, its own events; `approval` renders a question
  // the CLI asked (absent: not shown).
  function renderEvent(event, { approval } = {}) {
    if (event.kind === 'approval') return approval ? approval(event) : null;
    if (event.kind === 'status') return element('p', String(event.data), 'chat-status');
    if (event.kind === 'stderr') return element('pre', String(event.data), 'chat-stderr');
    const data = event.data || {};
    return event.kind === 'codex' ? renderCodex(data) : renderClaude(data);
  }
  // A turn's footer: its state, the commit it made or pushed, and why it ended early. Redrawn only when the turn
  // changed; true when it was.
  const footerKeys = new WeakMap();
  function turnFooter(footer, turn, branch, lostText) {
    const key = JSON.stringify([turn.state, turn.result, turn.stopRequested]);
    if (footerKeys.get(footer) === key) return false;
    footerKeys.set(footer, key);
    footer.replaceChildren(badge(turn.stopRequested && turn.state === 'running' ? 'stopping' : turn.state));
    if (turn.kind === 'push' && turn.result?.commit) footer.append(element('span', ` Pushed ${turn.result.commit.slice(0, 12)} to ${branch}`, 'muted small'));
    else if (turn.result?.commit) footer.append(element('span', ` Committed ${turn.result.commit.slice(0, 12)} on ${branch}`, 'muted small'));
    if (turn.state === 'lost') footer.append(element('span', ` ${lostText}`, 'muted small'));
    else if (turn.state === 'failed' && turn.result?.message) footer.append(element('span', ` ${turn.result.message}`, 'muted small'));
    return true;
  }
  return { renderClaude, renderCodex, renderEvent, turnFooter, details, bubble, toolSummary, resultText };
}
