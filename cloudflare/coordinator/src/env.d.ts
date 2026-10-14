// Optional sign-in providers. Set with `wrangler secret put` (SetupSignIn.bat); a provider is offered
// only when both its client ID and secret are present.
interface Env {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_APP_SLUG?: string;          // the GitHub App's URL slug, for the "Install Smith on GitHub" link (optional var)
  // Large files (Git LFS) straight to R2: an R2 API token's pair. Without both, objects move through the Worker instead.
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  // The fake Artifacts client's remote base for the import drill (tools/import-e2e.mjs): a local git server.
  ARTIFACTS_FAKE_REMOTE?: string;
}
