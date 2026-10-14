# Signing in to the hosted dashboard

Smith is **invite-only**, except for the studio's own Google Workspace. There are three ways in:

| Way | When |
| --- | --- |
| **Invitation code** | The first time, or when you have no linked account. Run `NewInvite.bat` (or `node tools/invite.mjs` from `cloudflare/coordinator`), then paste the one-use code it prints. Codes expire after an hour. |
| **Continue with Google** | Any `@redmarmosetstudios.com` Google Workspace account, straight away (the first sign-in creates its Smith user). Any other Google account after you have linked it. |
| **Continue with GitHub** | After you have linked your GitHub account. |

Browsers stay signed in for seven days, whichever way you signed in.

A Google or GitHub account only ever signs in to the Smith user who linked it. Linking needs a
current Smith session and its CSRF token, so another site cannot link its own account to yours.
One provider account can belong to one Smith user. Accounts are matched by the provider's stable
account ID, never by email, so a changed or reused email address cannot take over an account.
Someone with an unlinked Google or GitHub account is told to get an invitation. The one exception
is the Workspace domain in the `GOOGLE_ALLOWED_DOMAIN` var (`wrangler.jsonc`, `redmarmosetstudios.com`;
empty turns it off): an unlinked Google account whose ID token carries that domain as its `hd` claim
and an email on it gets a new Smith user of its own, linked to that account. Google sets `hd` only for
accounts the Workspace manages, so a personal Google account that merely uses a studio address still
needs an invitation.

## Sharing a workspace with the studio

A workspace is private to its owner until they share it. In **Settings → Workspace → Studio access**
an owner or admin picks the role studio accounts join with: *viewer* (sees builds), *operator* (also
starts builds) or *admin* (also settings and people). From then on, anyone whose last Google sign-in
proved the studio domain joins that workspace the next time they load the dashboard. Smith records
that proof as `users.google_domain` (migration `0007`) and refreshes it at every Google sign-in.
Changing the role applies to everyone who joined this way. Setting it back to *Not shared* removes
them again.

**Settings → People** lists everyone in the workspace. Owners and admins change roles and remove
people, and anyone can leave. A role set by hand pins it: Studio access changes leave that person
alone. Someone who was removed, or who left, does not rejoin through Studio access until an owner or
admin clicks **Let back in**. Only an owner changes who owns a workspace, and the last owner can
neither leave nor be demoted. The workspace's Durable Object is the authority (`src/members.ts`).
D1's `workspace_directory` and `studio_workspaces` are only the index that lists workspaces.

## Turning a provider on

Run `SetupSignIn.bat google` or `SetupSignIn.bat github` from the repository root. It opens the
provider's page and tells you what to enter:

- **Google:** in Google Cloud Console, create an OAuth client ID of type *Web application* with the
  authorized redirect URI `https://exp.redmarmosetstudios.com/auth/callback/google`. Choose the
  *Internal* consent screen so only your Google Workspace accounts can use it.
- **GitHub:** create an OAuth app with the callback URL
  `https://exp.redmarmosetstudios.com/auth/callback/github`, then generate a client secret.

It stores `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (or the `GITHUB_` pair) as Worker secrets with
`wrangler secret put`. They are not in this repository. A provider appears on the sign-in page only
when both of its values are set. The coordinator must be deployed with sign-in support
(`DeployWorker.bat`, which also applies the `0004_external_identities` migration).

Then sign in once with an invitation code and click **Link Google** or **Link GitHub** at the top
of the dashboard. From then on, **Continue with Google** or **Continue with GitHub** signs you in.

Linking GitHub is also what gives Smith access to your repositories: the token GitHub issues
at link time is kept (table `provider_tokens`, migration `0006`; refreshed automatically when
GitHub issues expiring tokens) and used to list your repositories in **Add project** and to
read `smith.json`. Register Smith as a **GitHub App** rather than an OAuth App when you can:
then its token only ever sees the accounts the App is installed on, and the dashboard offers
**Add more organisations on GitHub** (set the `GITHUB_APP_SLUG` var in `wrangler.jsonc` to the
App's slug for that link). With an OAuth App, the `repo` scope requested at link time gives the
same access without installing anything. Unlinking deletes the stored token. For
[Build on push](operations.md#build-on-push) to register a project's webhook through the link,
a GitHub App also needs the repository permission **Webhooks: Read and write** (the OAuth
`repo` scope already covers it); without it the card falls back to a hook added by hand.

## How it works

The flow is the OAuth 2.0 authorization-code flow with PKCE (S256). It uses a random state,
stored hashed in D1, used once, and expiring after 10 minutes; a `SameSite=Lax` cookie binds the
state to the browser that started it.

- **Google:** also uses an OpenID Connect nonce. The ID token comes straight from Google's token
  endpoint over TLS, and its issuer, audience, expiry, nonce and verified email are checked.
- **GitHub:** the account is identified by its numeric user ID; the login and primary verified
  email are for display only.

The provider's access token is used once to identify the account and is never stored.

## OpenAI and Anthropic accounts

Neither can be used to sign in here:

- **Anthropic** does not offer Claude login to other applications, and its terms forbid it.
- **OpenAI's** "Sign in with ChatGPT" for identity is limited to selected commercial partners
  (there is an interest form).

Your Claude and ChatGPT subscriptions are used from your own computer by the official CLIs; see the
[AI integration design](../superpowers/specs/2026-10-04-ai-assistant-integration-design.md).
