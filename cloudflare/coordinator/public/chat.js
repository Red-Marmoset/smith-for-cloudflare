'use strict';
import { renderMarkdown } from './markdown.js';
import { createTranscriptRenderers } from './transcript.js';
// "Work with AI": chats with Claude Code or Codex running on the signed-in person's own computer,
// with the login they completed there. This page only relays messages and renders each CLI's own
// events. Chats are kept on the server like a chat app's history: searchable, renamable, pinnable,
// archivable, exportable, and reopened by their #chat=<id> link.

const toolNames = { 'claude-code': 'Claude Code', codex: 'Codex' };
// Each tool's own permission choices, in its own words. The first is the default for new chats.
const toolModes = {
  'claude-code': [
    ['acceptEdits', 'Accept edits', 'Claude Code may edit files in its copy of the project. Anything else, like running commands, is refused and reported here.'],
    ['default', 'Ask before each action', 'Claude Code asks you here before it edits a file or runs a command, and waits for your answer. Reading the project needs no permission.'],
    ['plan', 'Plan only (changes nothing)', 'Claude Code reads the project and proposes a plan. It changes nothing.'],
    ['bypassPermissions', 'Bypass permissions', 'Claude Code may run any command on your computer without asking. Deployment credentials are removed from its environment, but use this only on projects you trust.'],
  ],
  codex: [
    ['workspace-write', 'Edit files (sandboxed)', 'Codex may edit files in its copy of the project, and runs commands in its sandbox. Anything needing more access is refused and reported here.'],
    ['untrusted', 'Ask before each action', 'Codex asks you here before it runs a command or changes files, and waits for your answer. What you allow still runs in its sandbox.', 'codex-ask'],
    ['read-only', 'Read only', 'Codex reads the project and answers. It changes nothing.'],
    ['danger-full-access', 'Full access (no sandbox)', 'Codex may run any command on your computer without a sandbox. Deployment credentials are removed from its environment, but use this only on projects you trust.'],
  ],
};
// On another member's computer (its shared Ollama models) a chat may only edit its own copy, or read.
const guestModes = { 'claude-code': ['acceptEdits', 'plan'], codex: ['workspace-write', 'read-only'] };
const DAY = 86400000;

export function createChat({ $, api, base, element, action, badge, projects, generation, jobs = () => [], openJob = () => undefined, openPull = async () => {} }) {
  let sessions = [], options = [], selected = null, detail = null, afterSeq = -1, epoch = 0;
  let blocks = new Map(), pendingRequest = null, sessionSnapshot = '', machineSnapshot = '', modeSnapshot = '';
  let showArchived = false, query = '', searchTimer, approvalCards = new Map();
  // Notifications: what was already announced, and the page title to decorate.
  const announced = new Set(), baseTitle = document.title; let lastStates = new Map();
  const path = id => `${base()}/ai/sessions/${encodeURIComponent(id)}`;

  // ---- Composer ------------------------------------------------------------------------------
  // Your computers (with your own login or their Ollama models; one without the tool is listed so it can
  // be installed from here), and other members' computers that share their local Ollama models.
  function machinesFor(tool) { return options.filter(m => m.ownedByYou || m.options.some(o => o.tool === tool)); }
  // With any of your computers online, both CLIs are offered: a missing one can be installed from here.
  function availableTools() {
    if (options.some(m => m.ownedByYou && m.online)) return Object.keys(toolNames);
    return Object.keys(toolNames).filter(tool => options.some(m => m.online && m.options.some(o => o.tool === tool)));
  }
  // Ready to run with your own login (or a shared model) right now, so it is picked first.
  function runnable(machine, tool) {
    if (!machine.online) return false;
    if (!machine.ownedByYou) return machine.options.some(o => o.tool === tool);
    const status = toolStatus(machine, tool);
    return Boolean(status) && (status.signedIn !== false || machine.options.some(o => o.tool === tool && o.brain === 'ollama'));
  }
  function machineLabel(m, tool) {
    const status = toolStatus(m, tool);
    const state = !m.online ? ' (offline)' : !m.ownedByYou ? '' : !status ? ' (not installed)' : status.signedIn === false ? ' (not signed in)' : '';
    return `${m.hostname}${m.ownedByYou ? '' : ' (shared models)'}${state}`;
  }
  function currentTool() { return detail?.tool || $('chat-tool').value || 'claude-code'; }
  function currentMachine() { return options.find(m => m.nodeId === (detail ? detail.nodeId : $('chat-machine').value)); }
  function guest() { const machine = currentMachine(); return detail ? Boolean(machine && !machine.ownedByYou) || (detail.brain === 'ollama' && !machine) : Boolean(machine && !machine.ownedByYou); }
  // The brain picker's value: 'own-login' (the CLI's default model), 'own-login:<model>' or 'ollama:<model>'.
  function brainChoice(value) {
    const at = value.indexOf(':');
    return at < 0 ? { brain: value, model: null } : { brain: value.slice(0, at), model: value.slice(at + 1) };
  }
  // Your login's models by name (Fable 5.1, Opus 5.5...), then the CLI's own default, then models on the machine.
  function brainsFor(tool, machine) {
    const login = `${toolNames[tool]} default model`;
    const brains = (machine?.options || []).filter(o => o.tool === tool)
      .map(o => o.brain === 'own-login' ? (o.model ? [`own-login:${o.model}`, o.label || o.model] : ['own-login', login]) : [`ollama:${o.model}`, `Model on machine · ${o.model}`]);
    // On your own computer your login is always offered; what stops it is shown in red below.
    if (machine?.ownedByYou && !brains.some(([value]) => value === 'own-login')) brains.unshift(['own-login', login]);
    return brains;
  }
  function modelName(session) {
    if (session.brain === 'ollama') return `${session.model} on machine`;
    return session.model ? (options.flatMap(m => m.options).find(o => o.brain === 'own-login' && o.model === session.model)?.label || session.model) : '';
  }
  function renderModes() {
    const tool = currentTool(), restricted = guest(), features = currentMachine()?.features;
    const canAsk = features?.includes('ask') ?? true, canCodexAsk = features?.includes('codex-ask') ?? true;
    const key = `${tool}/${detail?.id ?? ''}/${restricted}/${canAsk}/${canCodexAsk}`;
    if (modeSnapshot === key) return; modeSnapshot = key;
    $('chat-mode').replaceChildren(...toolModes[tool].filter(([value]) => !restricted || guestModes[tool].includes(value)).map(([value, label]) => {
      // Ask mode needs an up-to-date agent on that computer.
      const needsUpdate = (value === 'default' && !canAsk) || (value === 'untrusted' && !canCodexAsk);
      const option = element('option', needsUpdate ? `${label} (update Smith on that computer)` : label); option.value = value; option.disabled = needsUpdate; return option;
    }));
    // A chat continues in the mode its last message used, until you pick another.
    const last = detail?.turns.at(-1)?.permissionMode;
    if (last && toolModes[tool].some(([value]) => value === last)) $('chat-mode').value = last;
  }
  function renderComposer() {
    const snapshot = JSON.stringify([options, projects().map(p => p.id)]);
    if (snapshot !== machineSnapshot) {
      machineSnapshot = snapshot;
      const tool = $('chat-tool').value, project = $('chat-project').value;
      const tools = availableTools();
      $('chat-tool').replaceChildren(...(tools.length ? tools : ['claude-code']).map(t => { const option = element('option', toolNames[t]); option.value = t; return option; }));
      if (tools.includes(tool)) $('chat-tool').value = tool;
      $('chat-project').replaceChildren(...projects().map(p => { const option = element('option', p.name || p.id); option.value = p.id; return option; }));
      if (project) $('chat-project').value = project;
      modeSnapshot = '';
    }
    const starting = !detail, tool = currentTool();
    const machine = $('chat-machine').value;
    $('chat-machine').replaceChildren(...machinesFor(tool).map(m => {
      const option = element('option', machineLabel(m, tool)); option.value = m.nodeId; option.disabled = !m.online; return option;
    }));
    if (machine) $('chat-machine').value = machine;
    const ready = machinesFor(tool).filter(m => m.online);
    if (!$('chat-machine').value || $('chat-machine').selectedOptions[0]?.disabled) $('chat-machine').value = (ready.find(m => runnable(m, tool)) ?? ready[0])?.nodeId ?? '';
    const brain = $('chat-brain').value, brains = brainsFor(tool, currentMachine());
    $('chat-brain').replaceChildren(...brains.map(([value, label]) => { const option = element('option', label); option.value = value; return option; }));
    if (brains.some(([value]) => value === brain)) $('chat-brain').value = brain;
    renderModes();
    const brainKind = starting ? brainChoice($('chat-brain').value).brain : detail.brain;
    renderApiKey(tool, currentMachine(), brainKind);
    const { blocked, shown } = renderSetup(tool, currentMachine(), brainKind);
    $('chat-new-fields').hidden = !starting;
    $('chat-send').textContent = starting ? 'Start chat' : 'Send';
    $('chat-input').placeholder = `Ask ${toolNames[tool]} to work on this project… (Ctrl+Enter to send)`;
    const busy = Boolean(detail?.working);
    $('chat-send').disabled = busy || Boolean(blocked) || (starting && (!ready.length || !projects().length));
    let hint = toolModes[tool].find(([value]) => value === $('chat-mode').value)?.[2] || '';
    const machineNow = currentMachine();
    if (starting && $('chat-brain').value.startsWith('ollama:')) hint = machineNow && !machineNow.ownedByYou
      ? `Runs ${toolNames[tool]} with ${$('chat-brain').value.slice(7)} on ${machineNow.hostname}, which its owner shares. It works in a private copy of the project and can only edit that copy or read it; the owner can see and stop it. ${hint}`
      : `Runs ${toolNames[tool]} with ${$('chat-brain').value.slice(7)}, a model on ${machineNow?.hostname ?? 'your computer'}${tool === 'claude-code' ? ' (with Claude Code this needs Ollama 0.14 or newer there)' : ''}. ${hint}`;
    // Codex's own Windows sandbox must be set up on that computer, or its sandboxed modes refuse commands and edits.
    if (tool === 'codex' && machineNow?.os === 'windows' && $('chat-mode').value !== 'danger-full-access') {
      if (!machineNow.ownedByYou) hint += ` On this Windows computer Codex's sandbox is not set up for guests, so Codex can read the project but not run commands or change files.`;
      else if (machineNow.codexSandbox && machineNow.codexSandbox !== 'ready') hint += ` Codex's Windows sandbox is ${machineNow.codexSandbox === 'setup-pending' ? 'chosen but not set up yet' : 'not set up'} on ${machineNow.hostname}, so Codex will refuse to run commands or change files here. Set it up once on that computer: run \`codex\` in a terminal and accept its sandbox setup (needs an administrator), or add \`[windows]\` then \`sandbox = "unelevated"\` to %USERPROFILE%\\.codex\\config.toml.`;
    }
    if (starting && !availableTools().length) hint = 'Connect your computer with “Connect my computer”. Once its agent is running it appears here, and Claude Code or Codex can be installed and signed in from here.';
    else if (starting && !ready.length) hint = `No online computer offers ${toolNames[tool]} to you.`;
    else if (blocked) hint = shown ? '' : blocked; // the red notice above already says it
    else if (starting && !projects().length) hint = 'No projects are prepared for this workspace yet.';
    else if (busy && pendingApprovals().length) hint = `${toolNames[tool]} is waiting for your answer above.`;
    else if (busy) hint = `${toolNames[tool]} is working${guest() ? ` on ${machineNow?.hostname ?? 'a shared computer'}` : ' on your computer'}. You can stop it at any time.`;
    else if (detail?.archived) hint = 'This chat is archived. Sending a message brings it back to your chats.';
    $('chat-hint').textContent = hint;
    $('chat-mode').title = toolModes[tool].find(([value]) => value === $('chat-mode').value)?.[2] || '';
    $('chat-mode').setAttribute('aria-describedby', 'chat-hint');
    $('chat-stop').hidden = !busy;
    renderHandoff(busy);
  }

  // ---- Tool setup: install and sign in from here ----------------------------------------------
  // Whatever stops a chat on your own computer is a red notice right here, with the one button that
  // fixes it. Nothing starts until that button is clicked; links in the task's output open only when
  // clicked; a code to paste is the sign-in page's fallback, never the main path.
  let setupTask = null, setupTimer = null, following = null, noticeKey = '', apiKeyFor = '';
  const dismissed = new Set();
  const finished = state => ['succeeded', 'failed', 'stopped'].includes(state);
  function toolStatus(machine, tool) { return machine?.tools?.find(t => t.id === tool); }
  const apiKeyNames = { 'claude-code': 'ANTHROPIC_API_KEY', codex: 'OPENAI_API_KEY' };
  const apiKeyLogins = { 'claude-code': 'Claude', codex: 'Codex' };
  function apiKeyOffered(tool, machine, brain) { return Boolean(machine?.ownedByYou && brain === 'own-login' && toolStatus(machine, tool)?.apiKey); }
  // The machine has an API key for the tool: run with the owner's own login (the default, so connectors
  // work and the subscription pays) unless they tick this. Not remembered: each page starts unticked.
  function renderApiKey(tool, machine, brain) {
    const show = apiKeyOffered(tool, machine, brain);
    const key = `${tool}/${machine?.nodeId ?? ''}/${detail?.id ?? ''}`;
    if (key !== apiKeyFor) { apiKeyFor = key; $('chat-use-api-key').checked = false; }
    $('chat-api-key').hidden = !show;
    if (show) $('chat-api-key-text').textContent = `Use the API key set on ${machine.hostname} (${apiKeyNames[tool]}) instead of your ${apiKeyLogins[tool]} login — billed to that API account`;
  }
  function usingApiKey() { return !$('chat-api-key').hidden && $('chat-use-api-key').checked; }
  // What stops `tool` running with your own login on `machine`, and the action that fixes it.
  function blocker(tool, machine, brain) {
    if (!machine?.ownedByYou || !machine.online || brain !== 'own-login' || !machine.tools) return null;
    const name = toolNames[tool], host = machine.hostname, status = toolStatus(machine, tool);
    const canSetUp = machine.features?.includes('setup');
    if (!status) {
      if (!canSetUp) return { text: `${name} isn't installed on ${host}. Update Smith on ${host} (SmithAgent.bat update) to install and sign in from here.` };
      if (machine.installable?.includes(tool)) return { text: `${name} isn't installed on ${host}.`, action: 'install', button: `Install ${name}` };
      if (tool === 'codex') {
        // Installing Node.js itself would need an administrator prompt on that computer, which Smith never raises.
        const needs = machine.os === 'mac' ? 'Node.js (npm) or Homebrew' : 'Node.js (npm)';
        return { text: `Codex isn't installed on ${host}, and Smith can't install it there: that needs ${needs}, which ${host} doesn't have. Once Node.js (nodejs.org) is installed on ${host}, Codex can be installed from here.` };
      }
      return { text: `${name} isn't installed on ${host}, and Smith can't install it there by itself.` };
    }
    if (status.signedIn === false && !usingApiKey()) {
      const or = status.apiKey ? ' Sign in, or tick “Use the API key” below.' : '';
      if (!canSetUp) return { text: `${name} on ${host} isn't signed in. Update Smith on ${host} (SmithAgent.bat update) to sign in from here.` };
      return { text: `${name} on ${host} isn't signed in.${or}`, action: 'sign-in', button: `Sign in to ${name}` };
    }
    return null;
  }
  // Draws the notice and the task panel; returns why Start/Send is disabled ('' when it is not), and
  // whether the red notice already says so.
  function renderSetup(tool, machine, brain) {
    // Resume a task the computer is running (after a reload, or one started in another tab).
    const summary = machine?.ownedByYou ? machine.setup : null;
    if (summary && !finished(summary.state) && following !== summary.id && setupTask?.id !== summary.id) void followSetup(summary.id);
    const task = setupTask && setupTask.nodeId === machine?.nodeId && !dismissed.has(setupTask.id) ? setupTask : null;
    const active = Boolean(task && !finished(task.state));
    const block = blocker(tool, machine, brain);
    // The computer reports its new state a few seconds after a task succeeds; until then don't ask
    // again for what was just done.
    const settling = Boolean(block && task?.state === 'succeeded' && task.tool === tool && block.action === task.action && Date.now() - (task.seenFinishedAt ?? 0) < 30000);
    renderTask(task, machine, settling);
    const notice = !active && !settling && block ? block : null;
    const key = JSON.stringify([notice, machine?.nodeId, tool]);
    if (key !== noticeKey) {
      noticeKey = key;
      const box = $('chat-setup-notice'); box.replaceChildren(); box.hidden = !notice;
      if (notice) {
        box.append(element('span', notice.text));
        if (notice.button) {
          const fix = element('button', notice.button); fix.type = 'button';
          fix.addEventListener('click', () => action(fix, () => startSetup(machine, tool, notice.action)));
          box.append(fix);
        }
      }
    }
    if (active) return { blocked: `Wait for ${machine.hostname} to finish ${task.action === 'install' ? `installing ${toolNames[task.tool]}` : `signing in to ${toolNames[task.tool]}`}, or stop it.`, shown: false };
    if (settling) return { blocked: `Waiting for ${machine.hostname} to report ${toolNames[tool]}…`, shown: false };
    return { blocked: block ? block.text : '', shown: Boolean(block) };
  }
  async function startSetup(machine, tool, what) {
    try {
      const { task } = await api(`${base()}/ai/setup`, { nodeId: machine.nodeId, tool, action: what });
      setupTask = task; renderComposer(); await followSetup(task.id);
    } catch (error) { await refresh().catch(() => undefined); throw error; } // e.g. a task already running there: show it
  }
  async function followSetup(id) {
    clearTimeout(setupTimer); following = id;
    const ws = generation();
    try {
      const { task } = await api(`${base()}/ai/setup/${encodeURIComponent(id)}`);
      if (ws !== generation() || following !== id) return;
      task.seenFinishedAt = setupTask?.id === id && setupTask.seenFinishedAt ? setupTask.seenFinishedAt : finished(task.state) ? Date.now() : undefined;
      setupTask = task;
      if (finished(task.state)) { following = null; await refresh().catch(() => undefined); } // the computer's new state
      else setupTimer = setTimeout(() => void followSetup(id), 1500);
      renderComposer();
    } catch {
      if (ws === generation() && following === id) setupTimer = setTimeout(() => void followSetup(id), 3000);
    }
  }
  // The task's output with its links clickable (in a new tab, only when clicked) and Codex's
  // one-time code (like ABCD-12345) made easy to read.
  function setupOutput(text) {
    const clean = text.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
    const nodes = [], codes = part => {
      let at = 0;
      for (const match of part.matchAll(/\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/g)) { nodes.push(document.createTextNode(part.slice(at, match.index))); nodes.push(element('strong', match[0], 'chat-setup-code')); at = match.index + match[0].length; }
      nodes.push(document.createTextNode(part.slice(at)));
    };
    let at = 0;
    for (const match of clean.matchAll(/https?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]]/g)) {
      codes(clean.slice(at, match.index));
      const link = element('a', match[0]); link.href = match[0]; link.target = '_blank'; link.rel = 'noopener noreferrer';
      nodes.push(link); at = match.index + match[0].length;
    }
    codes(clean.slice(at));
    return nodes;
  }
  const taskView = (() => {
    const box = $('chat-setup-task'), title = element('strong'), buttons = element('span', undefined, 'chat-setup-buttons');
    const stop = element('button', 'Stop', 'quiet danger'), close = element('button', 'Dismiss', 'quiet');
    stop.type = 'button'; close.type = 'button'; buttons.append(stop, close);
    const head = element('div', undefined, 'chat-setup-head'); head.append(title, buttons);
    const guide = element('p', '', 'muted small'), output = element('pre', undefined, 'chat-setup-output');
    const paste = element('div', undefined, 'chat-setup-paste');
    const label = element('label', 'If the sign-in page shows a code, paste it here'); label.htmlFor = 'chat-setup-code';
    const input = element('input'); input.id = 'chat-setup-code'; input.type = 'text'; input.maxLength = 2048; input.autocomplete = 'off'; input.spellcheck = false;
    const send = element('button', 'Submit', 'quiet'); send.type = 'button';
    const row = element('div', undefined, 'chat-setup-paste-row'); row.append(input, send); paste.append(label, row);
    const sent = element('p', '', 'muted small');
    box.append(head, guide, output, paste, sent);
    stop.addEventListener('click', () => action(stop, async () => {
      if (!setupTask) return;
      setupTask = { ...setupTask, ...(await api(`${base()}/ai/setup/${encodeURIComponent(setupTask.id)}/stop`, {})).task }; renderComposer();
    }));
    close.addEventListener('click', () => { if (setupTask) dismissed.add(setupTask.id); renderComposer(); });
    send.addEventListener('click', () => action(send, async () => {
      const text = input.value.trim();
      if (!text || !setupTask) return;
      await api(`${base()}/ai/setup/${encodeURIComponent(setupTask.id)}/input`, { text });
      input.value = ''; sent.textContent = 'Sent to the sign-in.';
    }));
    // Enter here sends the code, never the chat message.
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); send.click(); } });
    return { box, title, guide, output, paste, stop, close, sent, text: null };
  })();
  function renderTask(task, machine, settling) {
    const view = taskView;
    view.box.hidden = !task;
    if (!task) { view.text = null; view.sent.textContent = ''; return; }
    const name = toolNames[task.tool] || task.tool, host = machine.hostname, install = task.action === 'install';
    const running = task.state === 'running' && !task.stopRequested;
    view.title.textContent = task.stopRequested && !finished(task.state) ? 'Stopping…'
      : task.state === 'queued' ? `Waiting for ${host} to start ${install ? `installing ${name}` : `signing in to ${name}`}…`
      : task.state === 'running' ? (install ? `Installing ${name} on ${host}…` : `Signing in to ${name} on ${host}…`)
      : task.state === 'succeeded' ? (install ? (settling ? `${name} is installed. Waiting for ${host} to report it…` : `${name} is installed on ${host}.`) : settling ? `Signed in. Waiting for ${host} to report it…` : `Signed in to ${name} on ${host}.`)
      : task.state === 'stopped' ? 'Stopped.' : `${install ? `Installing ${name}` : `Signing in to ${name}`} failed.`;
    view.title.className = task.state === 'failed' ? 'chat-setup-failed' : '';
    view.guide.textContent = !install && running ? (task.tool === 'codex' ? 'Open the link below and enter the one-time code shown with it.' : 'Open the link below and sign in.') + ' Links open only when you click them.'
      : finished(task.state) && task.state !== 'succeeded' ? task.message : ''; // success: the title says it all
    view.guide.hidden = !view.guide.textContent;
    if (view.text !== task.output) {
      const follow = view.output.scrollHeight - view.output.scrollTop - view.output.clientHeight < 40;
      view.text = task.output; view.output.replaceChildren(...setupOutput(task.output));
      if (follow) view.output.scrollTop = view.output.scrollHeight;
    }
    // Once it worked there is nothing left to read; the output stays for anything that did not.
    view.output.hidden = !task.output || task.state === 'succeeded';
    // Codex's one-time code goes into OpenAI's page, not here; only Claude Code's sign-in page hands back a code.
    view.paste.hidden = install || !running || task.tool === 'codex';
    if (view.paste.hidden) view.sent.textContent = '';
    view.stop.hidden = finished(task.state); view.close.hidden = !finished(task.state);
  }

  // ---- Handoff: Push branch, and Verify (push, then build it with Smith) ----------------------
  function machineOf(session) { return options.find(m => m.nodeId === session?.nodeId); }
  function renderHandoff(busy) {
    // Pushing uses the computer's own Git login, so only chats on your own computer offer it.
    const show = Boolean(detail) && !guest();
    $('chat-push').hidden = !show; $('chat-verify').hidden = !show; $('chat-pull').hidden = !show;
    if (!show) return;
    // A pull request proposes what was pushed, so it needs a completed push.
    const pushed = detail.turns.some(t => t.kind === 'push' && t.state === 'completed');
    $('chat-pull').disabled = busy || !pushed;
    $('chat-pull').title = !pushed ? 'Push the branch first; the pull request proposes what was pushed' : `Propose ${detail.branch} for merging into the project, as a Smith pull request`;
    const machine = machineOf(detail), changed = detail.turns.some(t => t.result?.commit);
    const why = busy ? 'Wait for the current reply first' : !changed ? 'Nothing to push yet: this chat has not changed any files'
      : !machine?.online ? 'The chat’s computer is offline' : !machine.features?.includes('push') ? `Update Smith on ${machine.hostname} (SmithAgent.bat update) to push from chats` : '';
    $('chat-push').disabled = Boolean(why); $('chat-push').title = why || (detail.localOnly ? `Push ${detail.branch} once, from ${machine.hostname} with its own Git login. Never forced, never to another branch.`
      : `Smith pushes each reply to ${detail.branch} by itself. Push it again now from ${machine.hostname}, with its own Git login. Never forced, never to another branch.`);
    // A project added from a Git URL (or started in Smith) offers the smith.json build actions that can run here instead of products.
    const project = projects().find(p => p.id === detail.projectId);
    const products = project?.kind === 'repo' ? (project.actions || []).filter(a => a.available).map(a => a.id) : (project?.products || []).map(p => p.name);
    const snapshot = JSON.stringify([detail.id, why, products]);
    if ($('chat-verify').dataset.snapshot === snapshot) return;
    $('chat-verify').dataset.snapshot = snapshot;
    const box = element('details', undefined, 'chat-menu chat-verify-menu');
    const summary = element('summary', 'Verify'); summary.title = why || 'Push this chat’s branch, then build it with Smith on a build machine';
    const list = element('div', undefined, 'chat-menu-items');
    for (const product of products) {
      const button = element('button', `Push and build ${product}`, 'quiet'); button.type = 'button'; button.disabled = Boolean(why);
      button.addEventListener('click', event => { event.stopPropagation(); box.open = false; void action(button, () => push(product)); });
      list.append(button);
    }
    if (!products.length) list.append(element('p', project?.kind === 'repo' ? `Nothing to build on ${project.branch || 'the project branch'} yet. A smith.json this chat adds becomes buildable once its pull request is merged.` : 'This project has no products to build.', 'muted small'));
    box.append(summary, list); box.addEventListener('click', event => event.stopPropagation());
    if (why) box.classList.add('disabled');
    $('chat-verify').replaceChildren(box);
  }
  async function openPullRequest() {
    if (!selected || !detail) return;
    const title = prompt('Pull request title', detail.title || detail.branch);
    if (title === null || !title.trim()) return;
    const pull = await api(`${base()}/pulls`, { chatSessionId: selected, title: title.trim().slice(0, 200) });
    await openPull(pull.id);
  }
  async function push(product) {
    if (!selected) return;
    await api(`${path(selected)}/push`, { requestId: crypto.randomUUID(), ...(product ? { product } : {}) });
    await refresh();
  }
  // A push turn that started a Verify build links to it, with the build's current state.
  function renderVerifyLinks() {
    for (const turn of detail.turns) {
      if (!turn.jobId || !blocks.has(turn.id)) continue;
      const b = blocks.get(turn.id), job = jobs().find(j => j.id === turn.jobId);
      const key = `${turn.jobId}/${job?.state ?? ''}`;
      if (b.verifyKey === key) continue; b.verifyKey = key;
      b.verify?.remove();
      const link = element('div', undefined, 'chat-verify-link');
      const open = element('button', 'Open Verify build', 'build-link'); open.type = 'button';
      open.addEventListener('click', () => openJob(turn.jobId));
      link.append(open); if (job) link.append(document.createTextNode(' '), badge(job.state));
      b.verify = link; b.el.append(link);
    }
  }

  // ---- Chat list -----------------------------------------------------------------------------
  function groupOf(session) {
    if (session.pinned && !showArchived) return 'Pinned';
    const age = Date.now() - session.updatedAt, today = new Date(); today.setHours(0, 0, 0, 0);
    if (session.updatedAt >= today.getTime()) return 'Today';
    if (session.updatedAt >= today.getTime() - DAY) return 'Yesterday';
    if (age < 7 * DAY) return 'Previous 7 days';
    if (age < 30 * DAY) return 'Previous 30 days';
    return new Date(session.updatedAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }
  // Today's chats show the time, older ones the date, like a chat app's list.
  function when(time) {
    const at = new Date(time);
    return at.toDateString() === new Date().toDateString() ? at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
  function menu(session, label = 'Chat options') {
    const box = element('details', undefined, 'chat-menu');
    const summary = element('summary', '⋯'); summary.setAttribute('aria-label', label); summary.title = label;
    const list = element('div', undefined, 'chat-menu-items');
    const item = (text, task, className = '') => {
      const button = element('button', text, `quiet ${className}`.trim()); button.type = 'button';
      button.addEventListener('click', event => { event.stopPropagation(); box.open = false; void action(button, task); });
      list.append(button);
    };
    item('Rename', () => rename(session));
    item(session.pinned ? 'Unpin' : 'Pin', () => update(session.id, { pinned: !session.pinned }));
    item(session.archived ? 'Unarchive' : 'Archive', () => update(session.id, { archived: !session.archived }));
    // Smith pushes each reply to the chat's branch by itself; a chat not ready to be seen can stay on the computer.
    const guestChat = session.brain === 'ollama' && !(machineOf(session)?.ownedByYou);
    if (!guestChat) item(session.localOnly ? 'Push each reply again' : 'Keep this chat on my computer only', () => update(session.id, { localOnly: !session.localOnly }));
    if (session.allowedTools?.length) item(`Ask again before ${session.allowedTools.join(', ')}`, () => update(session.id, { allowedTools: [] }));
    item('Export as Markdown', () => exportChat(session.id));
    item('Delete', () => remove(session), 'danger');
    box.append(summary, list);
    box.addEventListener('click', event => event.stopPropagation());
    return box;
  }
  function renderSessions() {
    const snapshot = JSON.stringify([sessions, selected, showArchived]);
    if (snapshot === sessionSnapshot) return; sessionSnapshot = snapshot;
    $('chat-sessions').replaceChildren();
    if (!sessions.length) $('chat-sessions').append(element('p', query ? 'No chats match.' : showArchived ? 'No archived chats.' : 'No chats yet.', 'empty small'));
    let group = '';
    for (const session of sessions) {
      const heading = groupOf(session);
      if (heading !== group) { group = heading; $('chat-sessions').append(element('p', heading, 'chat-group')); }
      const row = element('div', undefined, `chat-session${session.id === selected ? ' selected' : ''}`);
      const open = element('button', undefined, 'chat-session-open'); open.type = 'button';
      open.append(element('span', session.title, 'chat-session-title'),
        element('span', `${session.waitingSince ? 'Waiting for you · ' : session.working ? 'Working · ' : ''}${toolNames[session.tool] || session.tool} · ${when(session.updatedAt)}`, `small ${session.waitingSince ? 'chat-waiting' : 'muted'}`));
      open.addEventListener('click', () => action(open, () => select(session.id)));
      row.append(open, menu(session));
      $('chat-sessions').append(row);
    }
  }
  async function update(id, change) {
    await api(`${path(id)}/update`, change);
    sessionSnapshot = ''; await refresh();
  }
  async function rename(session) {
    const title = prompt('Rename chat', session.title);
    if (title === null || !title.trim() || title.trim() === session.title) return;
    await update(session.id, { title: title.trim() });
  }
  async function remove(session) {
    if (!confirm(`Delete “${session.title}” and its transcript? This cannot be undone. Changes already committed on your computer (branch ${session.branch}) are kept there.`)) return;
    await api(`${path(session.id)}/delete`, {});
    if (selected === session.id) await select(null);
    sessionSnapshot = ''; await refresh();
  }

  // ---- Transcript ----------------------------------------------------------------------------
  const transcript = createTranscriptRenderers({ element, renderMarkdown, badge });
  const { details, toolSummary, turnFooter } = transcript;
  // ---- Ask mode: Claude Code's questions, answered here ------------------------------------------
  function pendingApprovals() {
    const running = detail?.turns.find(t => t.state === 'running')?.id;
    return (detail?.approvals || []).filter(a => a.behavior === null && a.turnId === running);
  }
  function question(tool, input) {
    if (tool === 'Bash' || tool === 'Command') return ['run a command', input?.command];
    if (tool === 'FileChange') return ['change files', (input?.changes || []).map(c => `${c.kind === 'add' ? 'Add' : c.kind === 'delete' ? 'Delete' : 'Change'} ${c.path}`).join('\n') || input?.reason];
    if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(tool)) return [tool === 'Write' ? 'write a file' : 'edit a file', input?.file_path ?? input?.notebook_path];
    if (tool === 'WebFetch') return ['fetch a web page', input?.url];
    if (tool === 'WebSearch') return ['search the web', input?.query];
    return [`use ${tool}`, null];
  }
  function renderApproval(event) {
    const { id, tool, input } = event.data || {};
    const [verb, subject] = question(String(tool), input);
    const card = element('div', undefined, 'chat-approval');
    card.append(element('p', `${toolNames[detail?.tool] || 'The assistant'} wants to ${verb}`, 'chat-approval-title'));
    if (subject) card.append(element('pre', String(subject).slice(0, 4000), 'chat-approval-subject'));
    card.append(details('Details', JSON.stringify(input ?? {}, null, 2), 'chat-tool'));
    const actions = element('div', undefined, 'chat-approval-actions');
    const answer = (label, className, body) => {
      const button = element('button', label, className); button.type = 'button';
      button.addEventListener('click', () => action(button, async () => {
        const extra = typeof body === 'function' ? body() : body;
        if (extra === null) return;
        const result = await api(`${path(selected)}/approve`, { approvalId: id, ...extra });
        if (detail) { detail.approvals = result.approvals; updateApprovals(); renderComposer(); }
      }));
      actions.append(button);
    };
    answer('Allow', '', { behavior: 'allow' });
    const kinds = { Command: 'commands', FileChange: 'file changes' };
    answer(`Always allow ${kinds[tool] || tool} in this chat`, 'quiet', { behavior: 'allow', always: true });
    const who = detail?.tool === 'codex' ? 'Codex' : 'Claude';
    answer(`No, tell ${who} what to do instead`, 'quiet', () => {
      const message = prompt(`Tell ${who} what to do instead (optional)`, '');
      return message === null ? null : { behavior: 'deny', ...(message.trim() ? { message: message.trim() } : {}) };
    });
    const state = element('p', '', 'chat-approval-state');
    card.append(actions, state);
    approvalCards.set(`${event.turnId}/${id}`, { card, actions, state, turnId: event.turnId, id });
    return card;
  }
  function updateApprovals() {
    if (!detail) return;
    const answers = new Map((detail.approvals || []).map(a => [`${a.turnId}/${a.id}`, a]));
    for (const [key, view] of approvalCards) {
      const approval = answers.get(key), turn = detail.turns.find(t => t.id === view.turnId);
      const waiting = approval?.behavior === null && turn?.state === 'running';
      view.actions.hidden = !waiting; view.card.classList.toggle('waiting', waiting);
      view.state.textContent = waiting ? 'Waiting for your answer.' : approval?.behavior === 'allow' ? (approval.automatic ? `Allowed (you always allow ${approval.tool} in this chat).` : 'Allowed.')
        : approval?.behavior === 'deny' ? `Declined${approval.message ? `: ${approval.message}` : '.'}` : 'Not answered before the reply ended.';
    }
  }
  const renderEvent = event => transcript.renderEvent(event, { approval: renderApproval });
  function block(turnId) {
    if (!blocks.has(turnId)) {
      const el = element('section', undefined, 'chat-turn');
      const prompt = element('div', '', 'chat-bubble you'); const body = element('div'); const footer = element('div', undefined, 'chat-footer');
      el.append(prompt, body, footer); $('chat-log').append(el);
      blocks.set(turnId, { el, prompt, body, footer });
    }
    return blocks.get(turnId);
  }
  function renderDetail(events) {
    const log = $('chat-log'); const follow = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
    for (const turn of detail.turns) {
      const b = block(turn.id); b.prompt.textContent = turn.prompt;
      if (turnFooter(b.footer, turn, detail.branch, 'Your computer stopped responding, so this reply was lost.')) b.el.classList.toggle('chat-turn-push', turn.kind === 'push');
    }
    renderVerifyLinks();
    for (const event of events) {
      if (event.seq <= afterSeq) continue;
      const rendered = renderEvent(event); if (rendered) block(event.turnId).body.append(rendered);
      afterSeq = event.seq;
    }
    updateApprovals();
    if (follow) log.scrollTop = log.scrollHeight;
    $('chat-title-text').textContent = detail.title;
    const machine = options.find(m => m.nodeId === detail.nodeId);
    $('chat-meta').textContent = `${toolNames[detail.tool] || detail.tool}${modelName(detail) ? ` · ${modelName(detail)}` : ''} · ${machine?.hostname || (detail.brain === 'ollama' ? 'a shared computer' : 'your computer')} · ${detail.projectId} · branch ${detail.branch} from ${detail.baseCommit.slice(0, 12)}${detail.localOnly ? ' · kept on your computer' : guest() ? '' : ' · pushed after each reply'}${detail.archived ? ' · archived' : ''}`;
    const headerSnapshot = JSON.stringify([detail.id, detail.title, detail.pinned, detail.archived, detail.branch, detail.allowedTools, detail.localOnly]);
    if ($('chat-header-menu').dataset.snapshot !== headerSnapshot) { $('chat-header-menu').dataset.snapshot = headerSnapshot; $('chat-header-menu').replaceChildren(menu(detail, 'This chat’s options')); }
  }

  // ---- Export --------------------------------------------------------------------------------
  function markdownOfEvent(event) {
    const data = event.data || {};
    if (event.kind === 'codex') {
      const item = data.type === 'item.completed' ? data.item || {} : {};
      if (item.type === 'agent_message') return String(item.text ?? '');
      if (item.type === 'command_execution') return `- Ran \`${String(item.command ?? '').split('\n')[0]}\`${Number.isInteger(item.exit_code) ? ` (exit ${item.exit_code})` : ''}`;
      if (item.type === 'file_change') return (item.changes || []).map(c => `- ${c.kind} \`${c.path}\``).join('\n');
      return '';
    }
    if (event.kind === 'approval') return `- Asked to use ${data.tool}`;
    if (event.kind !== 'claude') return '';
    const parts = data.type === 'assistant' ? data.message?.content || [] : [];
    return parts.map(part => part.type === 'text' ? String(part.text) : part.type === 'tool_use' ? `- ${toolSummary(part.name, part.input)}` : '').filter(Boolean).join('\n\n');
  }
  async function exportChat(id) {
    const session = await api(path(id));
    const events = []; let after = -1;
    for (;;) { const page = await api(`${path(id)}/events?after=${after}`); events.push(...page.events); if (page.events.length < 200) break; after = page.events.at(-1).seq; }
    const name = toolNames[session.tool] || session.tool;
    const lines = [`# ${session.title}`, '', `${name} · project ${session.projectId} · branch \`${session.branch}\` from \`${session.baseCommit.slice(0, 12)}\` · started ${new Date(session.createdAt).toLocaleString()}`, ''];
    for (const turn of session.turns) {
      lines.push('## You', '', turn.prompt, '', `## ${name}`, '');
      const replies = events.filter(e => e.turnId === turn.id).map(markdownOfEvent).filter(Boolean);
      lines.push(replies.length ? replies.join('\n\n') : '_No reply recorded._', '');
      if (turn.result?.commit) lines.push(`_Committed \`${turn.result.commit.slice(0, 12)}\` on \`${session.branch}\`._`, '');
      if (turn.state !== 'completed') lines.push(`_Reply ${turn.state}._`, '');
    }
    const link = element('a');
    link.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/markdown' }));
    link.download = `${session.title.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'chat'}.md`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  // ---- Selection, refresh, links -------------------------------------------------------------
  function fromLink() { return /^#chat=([a-f0-9-]{36})$/.exec(location.hash)?.[1] ?? null; }
  function linkTo(id) {
    if (fromLink() === id) return;
    history.replaceState(null, '', id ? `#chat=${id}` : location.pathname + location.search);
  }
  async function select(id, keepLink = false) {
    epoch++; selected = id; detail = null; afterSeq = -1; blocks = new Map(); approvalCards = new Map(); pendingRequest = null; modeSnapshot = '';
    $('chat-log').replaceChildren(); $('chat-header').hidden = !id; $('chat-header-menu').dataset.snapshot = ''; sessionSnapshot = '';
    if (!keepLink) linkTo(id);
    renderSessions(); renderComposer();
    if (id) {
      try { await refresh(); }
      catch (error) {
        if (error.status !== 404) throw error;
        await select(null); throw Object.assign(new Error('That chat no longer exists.'), { missing: true });
      }
    }
  }
  async function refresh() {
    const current = epoch; const ws = generation();
    const listQuery = new URLSearchParams({ ...(showArchived ? { archived: '1' } : {}), ...(query ? { q: query } : {}) }).toString();
    const [list, available] = await Promise.all([api(`${base()}/ai/sessions${listQuery ? '?' + listQuery : ''}`), api(base() + '/ai/options')]);
    if (current !== epoch || ws !== generation()) return;
    sessions = list.sessions; options = available.machines;
    renderSessions(); announce();
    if (selected) {
      const [session, events] = await Promise.all([api(path(selected)), api(`${path(selected)}/events?after=${afterSeq}`)]);
      if (current !== epoch || ws !== generation()) return;
      detail = session; renderDetail(events.events);
    }
    renderComposer();
  }
  // Resetting (sign-in, workspace switch) keeps a #chat= link so it can still be opened afterwards.
  function reset() {
    selected = null; detail = null; sessions = []; options = []; machineSnapshot = '';
    clearTimeout(setupTimer); setupTask = null; following = null; noticeKey = '';
    void select(null, true);
  }

  $('chat-tool').addEventListener('change', () => { modeSnapshot = ''; renderComposer(); });
  $('chat-mode').addEventListener('change', renderComposer);
  $('chat-machine').addEventListener('change', () => { modeSnapshot = ''; renderComposer(); });
  $('chat-brain').addEventListener('change', renderComposer);
  $('chat-use-api-key').addEventListener('change', renderComposer);
  $('new-chat').addEventListener('click', () => action($('new-chat'), () => select(null)));
  $('chat-search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { query = $('chat-search').value.trim(); sessionSnapshot = ''; void refresh().catch(() => undefined); }, 250);
  });
  for (const [id, archived] of [['chat-tab-active', false], ['chat-tab-archived', true]]) $(id).addEventListener('click', () => action($(id), async () => {
    showArchived = archived;
    for (const [tab, on] of [['chat-tab-active', !archived], ['chat-tab-archived', archived]]) { $(tab).classList.toggle('selected', on); $(tab).setAttribute('aria-pressed', String(on)); }
    sessionSnapshot = ''; await refresh();
  }));
  $('chat-input').addEventListener('input', () => { pendingRequest = null; });
  $('chat-input').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) $('chat-form').requestSubmit(); });
  $('chat-push').addEventListener('click', () => action($('chat-push'), () => push(null)));
  $('chat-pull').addEventListener('click', () => action($('chat-pull'), openPullRequest));
  $('chat-stop').addEventListener('click', () => action($('chat-stop'), async () => {
    if (selected) { await api(`${path(selected)}/stop`, {}); await refresh(); }
  }));
  window.addEventListener('hashchange', () => { const id = fromLink(); if (id !== selected) void select(id).catch(() => undefined); });
  document.addEventListener('click', () => document.querySelectorAll('.chat-menu[open]').forEach(open => { open.open = false; }));
  $('chat-form').addEventListener('submit', event => {
    event.preventDefault();
    // Ask mode waits for your answers, so offer to notify you when a question arrives in a background tab.
    if ($('chat-mode').value === 'default' && 'Notification' in window && Notification.permission === 'default') void Notification.requestPermission().catch(() => undefined);
    void action($('chat-send'), async () => {
      const text = $('chat-input').value;
      if (!text.trim()) return;
      // Reuse the request ID until it succeeds, so a retried send never starts a reply twice.
      pendingRequest ??= crypto.randomUUID();
      const permissionMode = $('chat-mode').value;
      if (!selected) {
        const session = await api(base() + '/ai/sessions', { requestId: pendingRequest, nodeId: $('chat-machine').value, projectId: $('chat-project').value,
          tool: currentTool(), ...brainChoice($('chat-brain').value), permissionMode, prompt: text,
          ...(usingApiKey() ? { useApiKey: true } : {}) });
        pendingRequest = null; $('chat-input').value = ''; await select(session.id);
      } else {
        await api(`${path(selected)}/messages`, { requestId: pendingRequest, text, permissionMode, ...(usingApiKey() ? { useApiKey: true } : {}) });
        pendingRequest = null; $('chat-input').value = ''; await refresh();
      }
    });
  });
  // Tab title and (when allowed) a browser notification when a CLI asks you something or a reply ends
  // while this tab is in the background.
  function notify(title, body, id) {
    if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const note = new Notification(title, { body, tag: `smith-chat-${id}` });
      note.onclick = () => { window.focus(); location.hash = `chat=${id}`; note.close(); };
    } catch { /* some browsers only notify from a service worker */ }
  }
  function announce() {
    const waiting = sessions.filter(s => s.waitingSince);
    document.title = waiting.length ? `(${waiting.length}) Waiting for you · ${baseTitle}` : baseTitle;
    for (const s of waiting) {
      const key = `${s.id}/${s.waitingSince}`;
      if (!announced.has(key)) { announced.add(key); notify(`${toolNames[s.tool] || s.tool} is waiting for your answer`, s.title, s.id); }
    }
    const states = new Map(sessions.map(s => [s.id, s.working]));
    for (const s of sessions) if (lastStates.get(s.id) === true && !s.working) notify(`${toolNames[s.tool] || s.tool} finished`, s.title, s.id);
    lastStates = states;
  }
  renderComposer();
  // A #chat=<id> link opens that chat once the dashboard has loaded the workspace.
  let linked = false;
  return {
    async refresh() {
      if (!linked) {
        linked = true; const id = fromLink();
        // A link to a chat that was deleted, or that lives in another workspace, just opens the chat list.
        if (id) { try { await select(id); return; } catch (error) { if (!error.missing) throw error; } }
      }
      await refresh();
    },
    reset() { linked = false; lastStates = new Map(); document.title = baseTitle; reset(); },
    // Whether any of your chats has a reply running (the dashboard keeps following them in a background tab).
    busy() { return sessions.some(s => s.working); },
  };
}
