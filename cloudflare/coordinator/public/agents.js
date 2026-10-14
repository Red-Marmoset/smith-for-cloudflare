'use strict';
// "Tokens for Claude Code, Codex and git": personal access tokens for the Smith MCP server and for git.
// A token lets your own coding agent see projects and machines, and (if you allow it) start builds, as
// you; the same token is the password for cloning Smith's copies, and with the build scope for pushing.

export function createAgentAccess({ $, api, base, element, action, date, generation }) {
  let snapshot = '';

  function setup(token) {
    const url = `${location.origin}/mcp`;
    const claude = `claude mcp add --transport http --scope user smith ${url} --header 'Authorization: Bearer \${SMITH_TOKEN}'`;
    const codex = `[mcp_servers.smith]\nurl = "${url}"\nbearer_token_env_var = "SMITH_TOKEN"\ntool_timeout_sec = 60`;
    $('token-value').value = token;
    $('token-env-windows').textContent = `setx SMITH_TOKEN "${token}"`;
    $('token-env-posix').textContent = `export SMITH_TOKEN='${token}'   # add to ~/.zshrc or ~/.bashrc`;
    $('token-claude').textContent = claude;
    $('token-codex').textContent = codex;
    $('token-created').hidden = false;
  }
  function render(tokens) {
    const next = JSON.stringify(tokens);
    if (next === snapshot) return; snapshot = next;
    $('tokens').replaceChildren();
    if (!tokens.length) $('tokens').append(element('p', 'No tokens yet. Create one for each computer or tool you connect.', 'empty small'));
    for (const token of tokens) {
      const row = element('div', undefined, 'token-row');
      const info = element('div');
      info.append(element('strong', token.name), element('p', `${token.scopes.includes('build') ? 'Can start and cancel builds, and push to Smith’s copies' : 'Read-only (can clone Smith’s copies)'} · ${token.neverExpires ? 'valid until revoked' : `expires ${date(token.expiresAt)}`} · ${token.lastUsedAt ? `last used ${date(token.lastUsedAt)}` : 'not used yet'}`, 'muted small'));
      const revoke = element('button', 'Revoke', 'quiet danger');
      revoke.title = 'Immediately stop future use of this Smith token. Existing queued builds are separate; create a new token if needed.';
      revoke.setAttribute('aria-description', revoke.title);
      revoke.addEventListener('click', () => action(revoke, async () => {
        await api(`${base()}/tokens/${encodeURIComponent(token.id)}/revoke`, {}); await refresh();
      }));
      row.append(info, revoke); $('tokens').append(row);
    }
  }
  async function refresh() {
    const current = generation();
    const { tokens } = await api(base() + '/tokens');
    if (current === generation()) render(tokens);
  }
  function reset() { snapshot = ''; $('token-created').hidden = true; $('token-value').value = ''; $('tokens').replaceChildren(); }

  $('token-form').addEventListener('submit', event => {
    event.preventDefault();
    void action($('token-create'), async () => {
      const scopes = $('token-build').checked ? ['read', 'build'] : ['read'];
      const created = await api(base() + '/tokens', { name: $('token-name').value.trim(), scopes, expiresInDays: Number($('token-expiry').value) });
      $('token-name').value = ''; setup(created.token); await refresh();
    });
  });
  $('token-done').addEventListener('click', () => { $('token-created').hidden = true; $('token-value').value = ''; });
  return { refresh, reset };
}
