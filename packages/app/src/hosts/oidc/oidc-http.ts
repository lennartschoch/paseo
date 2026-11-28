import { buildDaemonWebSocketUrl, normalizeHostPort } from "@getpaseo/protocol/daemon-endpoints";
import { z } from "zod";

// FORK(oidc): first-class OIDC sign-in for direct connections. See .fork/README.md.

/** A direct TCP daemon address. OIDC sessions are keyed by its normalized endpoint. */
export interface OidcDaemonTarget {
  endpoint: string;
  useTls: boolean;
}

export function oidcTargetKey(target: Pick<OidcDaemonTarget, "endpoint">): string {
  return normalizeHostPort(target.endpoint);
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
  | { grantType: "authorization_code"; code: string; codeVerifier: string; redirectUri: string }
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
