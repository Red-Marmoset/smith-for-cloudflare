# Google Workspace sign-in

Smith can require **"Sign in with Google"** for the human web UI/API, restricted to one or
more Google Workspace domains and/or an explicit list of individual emails. It's an
**optional** feature — off unless you pass `--google-client-id`, in which case nothing
changes from the default LAN/`--token` behaviour described in the README.

Build **agents are never affected**: they keep authenticating with `--token`. Only the
browser-facing UI/data routes are gated behind a session.

## How it works (and why)

Smith is plain-HTTP and ships no TLS or crypto by design, so it does **not** implement the
OAuth dance itself:

1. The browser uses **Google Identity Services** (one-tap / the "Sign in with Google"
   button) to obtain a signed **ID token** (a JWT). All HTTPS with Google happens in the
   browser.
2. The browser POSTs that token to Smith (`POST /api/auth/google`).
3. Smith verifies it **out-of-process by shelling out to `curl`** against Google's
   `tokeninfo` endpoint — the same "delegate HTTPS to a command" pattern used for build
   notifications. Smith then checks the token's `aud` (it was minted for *this* app),
   `email_verified`, `exp`, and that the identity is allowed (domain **or** email).
4. On success Smith mints an **opaque random session token** (256-bit, stored in
   `sessions.json` — no JWT/HMAC, since Smith has no crypto) and returns it. The browser
   keeps it in `localStorage` and sends it as `Authorization: Bearer <token>`.

Sessions last 30 days, survive a coordinator restart, and are revoked by **Sign out**
(or by deleting/rotating `sessions.json`, which logs everyone out).

## 1. Create a Google OAuth client

1. In the [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services →
   Credentials**, create an **OAuth client ID** of type **Web application**.
2. Under **Authorized JavaScript origins**, add every origin the UI is served from, e.g.:
   - `http://localhost:9876` (local dev)
   - `https://smith.example.org` (your real, HTTPS origin)
   > Google sign-in requires a **secure origin**: `https://…` or `http://localhost`. A
   > plain-HTTP origin that isn't localhost will not work — serve the UI over HTTPS via a
   > tunnel / reverse proxy (see the README's *Remote / WAN coordinators*).
3. You do **not** need a client *secret* or a redirect URI for this flow — only the
   **client ID** (`<something>.apps.googleusercontent.com`). The client ID is public.

## 2. Run the coordinator with sign-in enabled

```powershell
.\Smith.exe coordinator `
  --google-client-id 1234567890-abc.apps.googleusercontent.com `
  --google-allowed-domains redmarmosetstudios.com `
  --require-login
```

> Prefer not to repeat flags? Put the same settings under the `auth` block of a
> `smith-coordinator.json` config file (auto-loaded from the working directory, or
> `--config <path>`) and just run `.\Smith.exe coordinator`. CLI flags still override the
> file. See *Configuration file* in the main README and `smith-coordinator.example.json`.

### Flags

| Flag | Meaning |
|------|---------|
| `--google-client-id <id>` | Enables the feature. Empty (default) ⇒ feature off. |
| `--google-allowed-domains a.com,b.com` | Allowed Workspace domains. Defaults to `redmarmosetstudios.com` if you enable sign-in without specifying any domain *or* email allowlist. |
| `--google-allowed-emails a@x.com,b@y.com` | Allow these exact emails **regardless of domain**. |
| `--admin-emails a@x.com,…` | These users get `role=admin` on first login (others `member`). |
| `--require-login` | Require a session for the human UI/API (even on loopback, so a local browser can't skip login). Without it, sign-in is *additive* — it identifies you but doesn't block LAN access. |
| `--token-verify-command "<cmd>"` | Override the default `curl` verification. `{token}` is replaced with the ID token. Use on hosts without `curl`, or to point at a different verifier. |

`curl` must be on the coordinator host — it's built into Windows 10+/macOS/Linux.

## 3. Access model — domains **or** specific people

A sign-in is accepted when **either**:

- the verified email's domain (or the token's `hd` Workspace claim) is in
  `--google-allowed-domains`, **or**
- the exact email is allowed — via `--google-allowed-emails`, **or** because an admin
  added that person under **Settings → Add user** with their **Google email**.

So to give a contractor outside your Workspace access, add a user in **Settings** with
their Google email (their `displayName` and optional git emails too). When they sign in,
Smith binds their Google identity to that account.

The same `users.json` account also drives **failure attribution**: a user's *git* emails
(separate from the sign-in email) attribute broken builds to them and target the tray
toast — see the README.

## Security notes

- Smith stays plain-HTTP; **all TLS to Google happens inside `curl`**. Run behind a TLS
  tunnel/reverse proxy for any non-localhost origin (also required for Google's secure
  origin rule).
- Verification checks `aud` (critical — `tokeninfo` returns claims for *any* valid Google
  token; the `aud` check ensures it was minted for **your** client id), `email_verified`,
  `exp`, and the domain/email allowlist.
- Session tokens are opaque and never logged; `GET /api/auth/config` exposes only the
  client id and allowed *domains*, never the email allowlist.
- Rotating or deleting `sessions.json` invalidates all sessions (everyone re-signs-in).

## Endpoints

| Route | Auth | Purpose |
|-------|------|---------|
| `GET /api/auth/config` | public | `{enabled, clientId, domains, requireLogin}` so the page can render the button |
| `POST /api/auth/google` | public | body `{credential}` (the Google ID token) → `{token, user}` or 401/403 |
| `GET /api/auth/me` | session | the current user |
| `POST /api/auth/logout` | session | invalidate the session |

## Troubleshooting

- **Button doesn't render / "unavailable"** — the page origin isn't an Authorized
  JavaScript origin, the origin isn't secure (non-localhost over HTTP), or the host can't
  reach `accounts.google.com`.
- **403 "not in an allowed domain or the user allowlist"** — the account's domain isn't in
  `--google-allowed-domains` and the email isn't allowlisted. Add the domain, or add the
  person under **Settings → Add user** / `--google-allowed-emails`.
- **401 "could not verify Google sign-in"** — `curl` failed or isn't installed on the
  coordinator host, or the token was rejected by Google. Check the coordinator log.
