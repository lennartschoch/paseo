import express from "express";
import type pino from "pino";
import { z } from "zod";
import type { DaemonAuthConfig } from "./auth.js";
import { OidcTokenExchangeError, OidcVerifier, type OidcTokenGrant } from "./oidc-auth.js";
import type { OidcAuthSettings } from "./oidc-auth-settings.js";

// FORK(oidc): first-class OIDC sign-in for direct connections. See .fork/README.md.
//
// Both routes are mounted before the bearer middleware: the app calls them
// before it has a credential. They only reveal what the provider already
// publishes and forward grants the provider itself validates (PKCE, redirect URI).

const TokenRequestSchema = z.discriminatedUnion("grantType", [
  z.object({
    grantType: z.literal("authorization_code"),
    code: z.string().min(1).max(4096),
    codeVerifier: z.string().min(43).max(128),
    redirectUri: z.string().min(1).max(2048),
  }),
  z.object({
    grantType: z.literal("refresh_token"),
    refreshToken: z.string().min(1).max(8192),
  }),
]);

const TOKEN_REQUESTS_PER_MINUTE = 60;

/**
 * Builds the daemon credential config and mounts the OIDC routes. Call before
 * the bearer middleware.
 */
export function createDaemonAuth(input: {
  app: express.Express;
  auth: { password?: string; oidc?: OidcAuthSettings } | undefined;
  localCredential: () => string | null;
  logger: pino.Logger;
}): DaemonAuthConfig {
  const { app, auth, localCredential, logger } = input;
  const oidcVerifier = auth?.oidc ? new OidcVerifier({ settings: auth.oidc, logger }) : undefined;
  mountOidcAuthRoutes({ app, verifier: oidcVerifier, logger });
  return {
    ...(auth?.password ? { password: auth.password } : {}),
    ...(oidcVerifier ? { oidcVerifier } : {}),
    localCredential,
  };
}

export function logOidcAuthStatus(input: {
  settings: OidcAuthSettings | undefined;
  verifier: OidcVerifier | undefined;
  logger: pino.Logger;
}): void {
  const { settings, verifier, logger } = input;
  if (!settings || !verifier) return;
  logger.info(
    { issuer: settings.issuer, clientId: settings.clientId },
    "Daemon OIDC authentication enabled",
  );
  if (!verifier.hasAuthorizationRules) {
    logger.warn(
      "OIDC has no allowedSubjects/allowedEmails/allowedGroups: every user the provider authenticates for this client gets owner access",
    );
  }
}

const TOKEN_ERROR_STATUS = { invalid_grant: 400, not_allowed: 403, provider_error: 502 } as const;

async function describeOidc(input: {
  verifier: OidcVerifier | undefined;
  res: express.Response;
  logger: pino.Logger;
}): Promise<void> {
  const { verifier, res, logger } = input;
  if (!verifier) {
    res.json({ enabled: false });
    return;
  }
  try {
    res.json({ enabled: true, ...(await verifier.describe()) });
  } catch (error) {
    logger.warn({ err: error }, "OIDC discovery failed while describing sign-in");
    res.status(502).json({ enabled: true, error: "The OIDC provider is unreachable." });
  }
}

async function exchangeOidcGrant(input: {
  verifier: OidcVerifier;
  grant: OidcTokenGrant;
  res: express.Response;
  logger: pino.Logger;
}): Promise<void> {
  const { verifier, grant, res, logger } = input;
  try {
    const tokens = await verifier.exchange(grant);
    res.json({
      idToken: tokens.idToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.identity.expiresAt,
      subject: tokens.identity.subject,
      email: tokens.identity.email,
      name: tokens.identity.name,
    });
  } catch (error) {
    if (error instanceof OidcTokenExchangeError) {
      res
        .status(TOKEN_ERROR_STATUS[error.code])
        .json({ error: error.code, message: error.message });
      return;
    }
    logger.error({ err: error }, "OIDC token exchange failed");
    res.status(500).json({ error: "provider_error", message: "Sign-in failed." });
  }
}

export function mountOidcAuthRoutes(input: {
  app: express.Express;
  verifier: OidcVerifier | undefined;
  logger: pino.Logger;
}): void {
  const { app, verifier, logger } = input;

  app.get("/api/auth/oidc", (_req, res) => {
    void describeOidc({ verifier, res, logger });
  });

  let windowStartedAt = 0;
  let requestsInWindow = 0;
  app.post("/api/auth/oidc/token", express.json({ limit: "16kb" }), (req, res) => {
    if (!verifier) {
      res.status(404).json({ error: "OIDC is not configured on this daemon." });
      return;
    }
    const now = Date.now();
    if (now - windowStartedAt > 60_000) {
      windowStartedAt = now;
      requestsInWindow = 0;
    }
    requestsInWindow += 1;
    if (requestsInWindow > TOKEN_REQUESTS_PER_MINUTE) {
      res.status(429).json({ error: "Too many sign-in attempts. Try again shortly." });
      return;
    }
    const parsed = TokenRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    void exchangeOidcGrant({ verifier, grant: parsed.data, res, logger });
  });
}
