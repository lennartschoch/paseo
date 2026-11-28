# OIDC sign-in (fork-only)

The fork lets a daemon accept OIDC sign-in for direct connections. You sign in with your identity
provider (tested against Authelia, any standard OIDC provider works) instead of typing the daemon
password. Upstream has no equivalent. Every site is tagged `FORK(oidc)`:

```bash
rg "FORK\(oidc\)"
```

## Set it up

### 1. Register a client at the provider

Authelia (4.39+) example, a public client with PKCE:

```yaml
identity_providers:
  oidc:
    lifespans:
      custom:
        paseo:
          refresh_token: "30d"
    claims_policies:
      paseo:
        id_token: ["email", "email_verified", "groups", "name", "preferred_username"]
    clients:
      - client_id: "paseo"
        client_name: "Paseo"
        public: true
        authorization_policy: "two_factor"
        consent_mode: "pre-configured"
        pre_configured_consent_duration: "1y"
        require_pkce: true
        pkce_challenge_method: "S256"
        claims_policy: "paseo"
        lifespan: "paseo"
        redirect_uris:
          - "paseo://oidc-callback"
          - "https://paseo.example.com/oidc-callback" # only for the browser web UI
        scopes: ["openid", "profile", "email", "groups", "offline_access"]
        grant_types: ["authorization_code", "refresh_token"]
        response_types: ["code"]
        token_endpoint_auth_method: "none"
```

- `paseo://oidc-callback` serves iOS, Android, and the desktop app. Add `<origin>/oidc-callback`
  for each origin you open the web UI from.
- `claims_policy` puts `email` and `groups` into the ID token. Authelia leaves them out by
  default, and the daemon only reads the ID token, so group and email rules fail without it.
- `offline_access` and the `refresh_token` grant give the app a refresh token. Authelia's default
  refresh lifespan is 90 minutes, after which you sign in again; `lifespan` raises it.
- For a confidential client, set `public: false`, a `client_secret` digest and
  `token_endpoint_auth_method: "client_secret_basic"`, and give the daemon the plain secret as
  `clientSecret`. The app never sees it: the daemon performs every token exchange.

### 2. Configure the daemon

In `$PASEO_HOME/config.json`:

```json
{
  "daemon": {
    "auth": {
      "oidc": {
        "issuer": "https://auth.example.com",
        "clientId": "paseo",
        "allowedGroups": ["paseo"]
      }
    }
  }
}
```

Or the environment, which replaces the whole block: `PASEO_OIDC_ISSUER`, `PASEO_OIDC_CLIENT_ID`,
`PASEO_OIDC_CLIENT_SECRET`, `PASEO_OIDC_SCOPES`, `PASEO_OIDC_AUDIENCES`,
`PASEO_OIDC_ALLOWED_SUBJECTS`, `PASEO_OIDC_ALLOWED_EMAILS`, `PASEO_OIDC_ALLOWED_GROUPS`,
`PASEO_OIDC_GROUPS_CLAIM` (lists are comma or space separated). Restart the daemon; auth is read
at startup only. `paseo config set` refuses `daemon.auth.*` on purpose, so edit the file.

| Field             | Meaning                                                                       |
| ----------------- | ----------------------------------------------------------------------------- |
| `issuer`          | Provider URL. The daemon fetches `/.well-known/openid-configuration` from it. |
| `clientId`        | Required `aud` of the ID token                                                |
| `clientSecret`    | Confidential clients only                                                     |
| `scopes`          | What the app requests. Default `openid profile email groups offline_access`   |
| `audiences`       | Extra accepted `aud` values, for JWT access tokens minted for an API audience |
| `allowedSubjects` | `sub` values allowed in                                                       |
| `allowedEmails`   | Allowed emails; a token with `email_verified: false` never matches            |
| `allowedGroups`   | Allowed groups, read from `groupsClaim` (default `groups`)                    |

Any one allow-list match admits the user. With no allow-list every user the provider signs in for
this client gets in, and the daemon logs a warning at startup. Restrict access either here or with
the provider's per-client policy.

An OIDC user is admitted as the `owner` principal with owner permissions, the same as the daemon
password. A password can stay configured alongside OIDC; both work.

### 3. Sign in from the app

Add a direct connection with the password left empty. When the daemon answers "password required"
and offers OIDC, the app opens the provider's login and saves the host once you return. Settings →
the host's detail page has a **Single sign-on** section to sign in again or sign out.

| Platform      | Login opens in                                           | Comes back through                         |
| ------------- | -------------------------------------------------------- | ------------------------------------------ |
| iOS, Android  | System browser                                           | `paseo://oidc-callback` deep link          |
| Desktop       | A separate Electron window with its own cookie partition | Redirect caught before it loads            |
| Web (browser) | The same tab                                             | `/oidc-callback` route after a page reload |

The CLI has no login flow. Set `PASEO_OIDC_TOKEN` to an ID token, or keep using `PASEO_PASSWORD`.

## How it works

```text
app ── GET  /api/auth/oidc ─────────────▶ daemon   (issuer, clientId, authorization endpoint, scopes)
app ── browser ─▶ provider /authorize ─▶ redirect with code
app ── POST /api/auth/oidc/token ───────▶ daemon ──▶ provider /token   (code + PKCE verifier)
app ◀─ ID token + refresh token ────────  daemon verifies the ID token and allow-lists first
app ── hello { auth: { kind: "oidc", token } } ─▶ daemon verifies signature, iss, aud, exp, allow-lists
```

- The daemon proxies the token endpoint so the app needs no CORS access to the provider
  (the Electron renderer origin is `paseo://app`) and a client secret can stay on the daemon. Both
  routes are mounted before the bearer middleware; the token route is rate-limited to 60 requests
  a minute.
- The credential is the **ID token**, validated against the provider's JWKS. Opaque access tokens
  are not accepted: without an audience the daemon cannot tell a token issued for Paseo from one
  issued for another client of the same provider.
- HTTP routes and `/mcp/agents` accept the ID token as `Authorization: Bearer`.
- The app stores sessions in AsyncStorage beside the saved hosts, keyed by the direct endpoint,
  because the first sign-in happens before the app knows the `serverId`. Relay and routed
  connections to the same host reuse the session of the host's direct connection. Refreshing needs
  that direct endpoint to be reachable over HTTP.
- `DaemonClient` calls `oidcToken()` before every connection attempt, so a reconnect presents a
  refreshed token. A token is checked once at admission; an open connection outlives the token's
  expiry. A refresh rejected with `invalid_grant` deletes the session, and the next connect asks
  you to sign in again.
- A provider outage leaves already-connected sessions alone and rejects new sign-ins with
  `provider_unavailable` (logged); the discovery document is cached for an hour and served stale
  if a refresh fails.

## Compatibility

- `hello.auth` gained `{ kind: "oidc", token }`, a fork-only protocol extension. The app sends it
  only after `GET /api/auth/oidc` reports `enabled: true`; an upstream daemon answers 404 there,
  so a fork app never sends the new kind to it.
- `hello.rejected` is unchanged: OIDC failures reuse `password_required` and `incorrect_password`,
  because `accepts` is `z.literal("password")` and widening it would break old clients.
- An upstream app cannot sign in to a daemon that has only OIDC. Configure a password as well if
  you need one.

## Merging upstream

- **Auth plumbing** (`auth.ts`, `session-admission-auth.ts`, `websocket-server.ts`,
  `bootstrap.ts`): the rule is that `isDaemonAuthRequired()` replaces every upstream "is a
  password set" check. If upstream adds a new place that treats "no password" as "open", route it
  through `isDaemonAuthRequired()` / `isDaemonBearerTokenAuthorizedAsync()`, or an OIDC-only daemon
  opens up. `bootstrap-oidc-auth.test.ts` covers the known entry points, including a junk bearer
  header against an OIDC-only daemon.
- **`hello.auth` union** (`packages/protocol/src/messages.ts`): if upstream adds or reshapes auth
  kinds, keep the `oidc` branch and the client's `chooseConnectionAuth()` order (local credential,
  then OIDC, then password).
- **Principals**: OIDC users are `owner`. If upstream starts minting per-device principals or
  pairing credentials, decide whether OIDC subjects map to principals instead.
- **App**: everything app-side lives in `packages/app/src/hosts/oidc/`. The hooks into upstream
  files are small: `host-runtime.ts` (`withOidcToken`, `reauthenticateHost`, and the
  `credentialsChanged` option on `updateHost`), `test-daemon-connection.ts` (`oidcToken`
  passthrough), `add-host-modal.tsx` (`probeWithOidcSignIn`), `client-hosts-page.tsx`
  (`HostOidcSection`), `_layout.tsx` (`oidc-callback` screen).
- **Locales**: only `en.ts` has strings; the other locales point at `en.oidc`.
- If upstream ships its own SSO, compare and prefer theirs; drop this patch rather than run both.

Tests: `packages/server/src/server/oidc-auth.test.ts`,
`packages/server/src/server/bootstrap-oidc-auth.test.ts` (a real in-process provider in
`test-utils/oidc-provider.ts`), and `packages/app/src/hosts/oidc/oidc-token.test.ts`.
