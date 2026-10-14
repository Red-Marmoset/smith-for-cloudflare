// Names a secretless build (a Verify of a model-authored branch, or a crew-created project) never inherits.
export const SECRETLESS_BLANKS = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CF_API_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY',
  'GITHUB_TOKEN', 'GH_TOKEN', 'NPM_TOKEN', 'BUTLER_API_KEY', 'STEAM_PASSWORD', 'STEAM_TOTP_SECRET', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AZURE_OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN'] as const;
// The whole environment of a secretless job: every name above blanked, because the agent merges `spec.env`
// over the machine owner's own variables, so an empty value hides theirs. The product's own env is dropped
// rather than filtered, so a model-authored project cannot set one of those names back; only the public
// account ID stays, so a script can still address the account without a token.
export function secretlessEnv(accountId: string): Record<string, string> {
  const env: Record<string, string> = Object.fromEntries(SECRETLESS_BLANKS.map(name => [name, '']));
  if (accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId;
  return env;
}
// The build context Smith itself computes when it resolves a smith.json build action (pipeline.ts resolveAction).
const BUILD_CONTEXT = ['SMITH_BUILD_NUMBER', 'SMITH_BRANCH', 'SMITH_COMMIT', 'SMITH_PROJECT'] as const;
// A secretless job's environment once /resolve has mapped smith.json at its commit: the same blanks as at its claim, plus
// only Smith's build context, never the variables smith.json sets at that (model-authored) commit.
export function secretlessResolvedEnv(accountId: string, resolved: Record<string, string>): Record<string, string> {
  const context = Object.fromEntries(BUILD_CONTEXT.filter(name => name in resolved).map(name => [name, resolved[name]]));
  return { ...context, ...secretlessEnv(accountId) };
}
