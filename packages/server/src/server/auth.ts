import { compare, hashSync } from "bcryptjs";
import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { matchesLocalCredential } from "./local-credential.js";
import type { OidcVerifier } from "./oidc-auth.js";

export const DAEMON_PASSWORD_BCRYPT_COST = 12;

export interface DaemonAuthConfig {
  password?: string;
  localCredential?: () => string | null;
  // FORK(oidc): set when daemon.auth.oidc is configured. See .fork/README.md.
  oidcVerifier?: OidcVerifier;
}

/** A daemon with a password or OIDC configured rejects unauthenticated callers. */
export function isDaemonAuthRequired(auth: DaemonAuthConfig | undefined): boolean {
  return Boolean(auth?.password || auth?.oidcVerifier);
}

/**
 * Accepts the daemon password or, when OIDC is configured, a valid OIDC token.
 * Open when neither is configured.
 */
export async function isDaemonBearerTokenAuthorizedAsync(input: {
  auth: DaemonAuthConfig | undefined;
  token: string | null;
}): Promise<boolean> {
  return (await authorizeDaemonBearerToken(input)).authorized;
}

export type DaemonBearerAuthorization =
  | { authorized: false }
  /** `expiresAt` is set for OIDC tokens: the credential stops being valid then. */
  | { authorized: true; expiresAt: number | null };

export async function authorizeDaemonBearerToken(input: {
  auth: DaemonAuthConfig | undefined;
  token: string | null;
}): Promise<DaemonBearerAuthorization> {
  const { auth, token } = input;
  if (!isDaemonAuthRequired(auth)) return { authorized: true, expiresAt: null };
  if (token === null) return { authorized: false };
  // JWT-shaped tokens try OIDC first so an OIDC caller does not pay for a bcrypt compare.
  const verifier = auth?.oidcVerifier;
  if (verifier?.canVerify(token)) {
    const verification = await verifier.verify(token);
    if (verification.ok) return { authorized: true, expiresAt: verification.identity.expiresAt };
  }
  if (auth?.password && (await compare(token, auth.password))) {
    return { authorized: true, expiresAt: null };
  }
  return { authorized: false };
}

export interface BearerAuthRejectContext {
  path: string;
  method: string;
  hasToken: boolean;
}

interface BearerValidationInput {
  password: string | undefined;
  token: string | null;
}

export async function isBearerTokenValidAsync(input: BearerValidationInput): Promise<boolean> {
  if (!input.password) {
    return true;
  }
  if (input.token === null) {
    return false;
  }

  return compare(input.token, input.password);
}

export function hashDaemonPassword(password: string): string {
  return hashSync(password, DAEMON_PASSWORD_BCRYPT_COST);
}

export function extractHttpBearerToken(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const [scheme, ...tokenParts] = value.trim().split(/\s+/);
  if (scheme !== "Bearer" || tokenParts.length !== 1) {
    return null;
  }
  return tokenParts[0] ?? null;
}

export function extractWsBearerProtocol(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  for (const protocol of value.split(",")) {
    const trimmed = protocol.trim();
    const segments = trimmed.split(".");
    if (segments[0] === "paseo" && segments[1] === "bearer" && segments.length >= 3) {
      return trimmed;
    }
  }

  return null;
}

export function extractWsBearerToken(protocol: string | null): string | null {
  if (!protocol) {
    return null;
  }
  const segments = protocol.split(".");
  if (segments[0] !== "paseo" || segments[1] !== "bearer" || segments.length < 3) {
    return null;
  }
  return segments.slice(2).join(".");
}

export function createRequireBearerMiddleware(
  auth: DaemonAuthConfig | undefined,
  onReject?: (context: BearerAuthRejectContext) => void,
): RequestHandler {
  return (req, res, next) => {
    if (!isDaemonAuthRequired(auth) || shouldBypassBearerAuth(req.method, req.path)) {
      next();
      return;
    }

    void (async () => {
      try {
        const token = extractHttpBearerToken(req.header("authorization"));
        const localCredential = req.path === "/api/status" ? auth?.localCredential?.() : null;
        const isLocal =
          localCredential !== null &&
          localCredential !== undefined &&
          token !== null &&
          matchesLocalCredential(localCredential, token);
        if (!isLocal && !(await isDaemonBearerTokenAuthorizedAsync({ auth, token }))) {
          onReject?.({
            path: req.path,
            method: req.method,
            hasToken: token !== null,
          });
          res.status(401).json({ error: "Unauthorized" });
          return;
        }

        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}

const SELF_AUTHENTICATING_ROUTES = new Set(["/api/files/download", "/mcp/agents"]);

function isBearerFreeRoute(path: string): boolean {
  return path === "/api/health" || SELF_AUTHENTICATING_ROUTES.has(path);
}

export function shouldBypassBearerAuth(method: string, path: string): boolean {
  if (method === "OPTIONS") {
    return true;
  }
  return isBearerFreeRoute(path);
}

/**
 * Authorizes a request to the Agent MCP endpoint (/mcp/agents), which is exempt
 * from the global daemon-password middleware. Accepts either the per-daemon-run
 * capability token the daemon injects into its own agents' configs and MCP
 * client, or a valid daemon-password bearer (so existing password-authenticated
 * callers keep working). When no daemon password is configured the endpoint is
 * open, matching the global middleware's behavior.
 */
export async function isAgentMcpRequestAuthorized(input: {
  password: string | undefined;
  oidcVerifier?: OidcVerifier;
  capabilityToken: string | null;
  authorizationHeader: string | undefined;
}): Promise<boolean> {
  const auth = { password: input.password, oidcVerifier: input.oidcVerifier };
  if (!isDaemonAuthRequired(auth)) {
    return true;
  }
  const token = extractHttpBearerToken(input.authorizationHeader);
  if (input.capabilityToken !== null && token !== null) {
    // Constant-time compare; length-guard first because timingSafeEqual throws
    // on differing buffer lengths.
    const provided = Buffer.from(token);
    const expected = Buffer.from(input.capabilityToken);
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
      return true;
    }
  }
  return isDaemonBearerTokenAuthorizedAsync({ auth, token });
}
