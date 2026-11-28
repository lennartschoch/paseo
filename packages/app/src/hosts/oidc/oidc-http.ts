import {
  buildDaemonWebSocketUrl,
  normalizeHostPort,
  normalizeLoopbackToLocalhost,
} from "@getpaseo/protocol/daemon-endpoints";
import { z } from "zod";
import { isLoopbackEndpoint } from "@/hosts/connection-display";

// FORK(oidc): first-class OIDC sign-in for direct connections. See .fork/README.md.

/** A direct TCP daemon address. OIDC sessions are keyed by its normalized endpoint. */
export interface OidcDaemonTarget {
  endpoint: string;
  useTls: boolean;
}

/**
 * The endpoint in the form the host registry saves it (loopback becomes
 * `localhost`), so a session saved at sign-in is found again after a reload.
 */
export function oidcTargetKey(target: Pick<OidcDaemonTarget, "endpoint">): string {
  return normalizeLoopbackToLocalhost(normalizeHostPort(target.endpoint));
}

/**
 * The redirect URI path segment that names this daemon. Binding the redirect URI
 * to the daemon address means the provider only issues a code for this client
 * when the sign-in started from that address, so a host impersonating the
 * provider's descriptor never receives a code it could redeem elsewhere.
 * Colons stay readable because they are legal in a path segment.
 */
export function oidcRedirectPathSegment(endpoint: string): string {
  return encodeURIComponent(oidcTargetKey({ endpoint })).replace(/%3A/gi, ":");
}

/**
 * OIDC credentials (ID token, refresh token) only travel over TLS, or to a
 * daemon on this machine. Plain HTTP would hand a network attacker a refresh token.
 */
export function isOidcTransportSecure(target: OidcDaemonTarget): boolean {
  return target.useTls || isLoopbackEndpoint(target.endpoint);
}

export function buildDaemonHttpUrl(target: OidcDaemonTarget, path: string): string {
  const url = new URL(buildDaemonWebSocketUrl(target.endpoint, { useTls: target.useTls }));
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = path;
  url.search = "";
  return url.toString();
}

const OidcDescriptorSchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true),
    issuer: z.string(),
    clientId: z.string(),
    authorizationEndpoint: z.string(),
    scopes: z.array(z.string()),
  }),
]);

export type OidcDescriptor = Extract<z.infer<typeof OidcDescriptorSchema>, { enabled: true }>;

/**
 * Asks the daemon whether it accepts OIDC. Resolves null for daemons without
 * the fork's OIDC support (404) or with OIDC disabled.
 */
export async function fetchOidcDescriptor(
  target: OidcDaemonTarget,
): Promise<OidcDescriptor | null> {
  const response = await fetch(buildDaemonHttpUrl(target, "/api/auth/oidc"), {
    headers: { Accept: "application/json" },
  });
  if (response.status === 404) return null;
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `The host returned ${response.status}.`;
    throw new Error(message);
  }
  const parsed = OidcDescriptorSchema.safeParse(body);
  if (!parsed.success || !parsed.data.enabled) return null;
  return parsed.data;
}

const OidcTokenResponseSchema = z.object({
  idToken: z.string(),
  refreshToken: z.string().nullable(),
  expiresAt: z.number(),
  subject: z.string(),
  email: z.string().nullable(),
  name: z.string().nullable(),
});

export type OidcTokenResponse = z.infer<typeof OidcTokenResponseSchema>;

export type OidcTokenGrant =
  | {
      grantType: "authorization_code";
      code: string;
      codeVerifier: string;
      redirectUri: string;
      nonce: string;
    }
  | { grantType: "refresh_token"; refreshToken: string };

export class OidcTokenRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OidcTokenRequestError";
  }
}

/** The daemon forwards the grant to its provider and verifies the ID token it gets back. */
export async function requestOidcTokens(
  target: OidcDaemonTarget,
  grant: OidcTokenGrant,
): Promise<OidcTokenResponse> {
  const response = await fetch(buildDaemonHttpUrl(target, "/api/auth/oidc/token"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(grant),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const code = typeof record.error === "string" ? record.error : "provider_error";
    const message = typeof record.message === "string" ? record.message : code;
    throw new OidcTokenRequestError(code, message);
  }
  return OidcTokenResponseSchema.parse(body);
}

/** Asks the daemon to revoke a refresh token at its provider. */
export async function revokeOidcRefreshToken(
  target: OidcDaemonTarget,
  refreshToken: string,
): Promise<void> {
  const response = await fetch(buildDaemonHttpUrl(target, "/api/auth/oidc/revoke"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const message =
      typeof record.message === "string" ? record.message : `The host returned ${response.status}.`;
    throw new OidcTokenRequestError("provider_error", message);
  }
}
