import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type pino from "pino";
import { z } from "zod";
import { DEFAULT_OIDC_SCOPES, type OidcAuthSettings } from "./oidc-auth-settings.js";

// FORK(oidc): first-class OIDC sign-in for direct connections. See .fork/README.md.

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const DISCOVERY_RETRY_MS = 30 * 1000;
const PROVIDER_TIMEOUT_MS = 15 * 1000;
const CLOCK_TOLERANCE_SECONDS = 30;

const OidcDiscoverySchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  jwks_uri: z.string().url(),
  end_session_endpoint: z.string().url().optional(),
});

type OidcDiscovery = z.infer<typeof OidcDiscoverySchema>;

const OidcTokenResponseSchema = z.object({
  id_token: z.string().optional(),
  refresh_token: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

export interface OidcIdentity {
  subject: string;
  email: string | null;
  name: string | null;
  expiresAt: number;
}

export type OidcVerification =
  | { ok: true; identity: OidcIdentity }
  | { ok: false; reason: "invalid_token" | "not_allowed" | "provider_unavailable" };

/** What the app needs to start an authorization-code flow. Safe to publish unauthenticated. */
export interface OidcPublicDescriptor {
  issuer: string;
  clientId: string;
  authorizationEndpoint: string;
  endSessionEndpoint: string | null;
  scopes: string[];
}

export type OidcTokenGrant =
  | { grantType: "authorization_code"; code: string; codeVerifier: string; redirectUri: string }
  | { grantType: "refresh_token"; refreshToken: string };

export interface OidcTokenSet {
  idToken: string;
  refreshToken: string | null;
  identity: OidcIdentity;
}

export class OidcTokenExchangeError extends Error {
  constructor(
    public readonly code: "invalid_grant" | "not_allowed" | "provider_error",
    message: string,
  ) {
    super(message);
    this.name = "OidcTokenExchangeError";
  }
}

function normalizeIssuer(issuer: string): string {
  return issuer.replace(/\/+$/, "");
}

function looksLikeJwt(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part));
}

function readStringClaim(payload: JWTPayload, claim: string): string | null {
  const value = payload[claim];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readListClaim(payload: JWTPayload, claim: string): string[] {
  const value = payload[claim];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

/**
 * Validates OIDC tokens presented to the daemon and proxies the token endpoint
 * for the app, so the app never needs CORS access to the provider and a
 * confidential client secret stays on the daemon.
 */
export class OidcVerifier {
  private readonly settings: OidcAuthSettings;
  private readonly issuer: string;
  private readonly logger: pino.Logger;
  private readonly fetchImpl: typeof fetch;
  private discovery: { value: OidcDiscovery; fetchedAt: number } | null = null;
  private discoveryInFlight: Promise<OidcDiscovery> | null = null;
  private lastDiscoveryFailureAt = 0;
  private jwks: { uri: string; keySet: ReturnType<typeof createRemoteJWKSet> } | null = null;

  constructor(input: { settings: OidcAuthSettings; logger: pino.Logger; fetch?: typeof fetch }) {
    this.settings = input.settings;
    this.issuer = normalizeIssuer(input.settings.issuer);
    this.logger = input.logger.child({ module: "oidc-auth" });
    this.fetchImpl = input.fetch ?? fetch;
  }

  get hasAuthorizationRules(): boolean {
    const { allowedSubjects, allowedEmails, allowedGroups } = this.settings;
    return Boolean(allowedSubjects?.length || allowedEmails?.length || allowedGroups?.length);
  }

  async describe(): Promise<OidcPublicDescriptor> {
    const discovery = await this.loadDiscovery();
    return {
      issuer: this.settings.issuer,
      clientId: this.settings.clientId,
      authorizationEndpoint: discovery.authorization_endpoint,
      endSessionEndpoint: discovery.end_session_endpoint ?? null,
      scopes: this.settings.scopes ?? DEFAULT_OIDC_SCOPES,
    };
  }

  /** Cheap pre-check so a password-shaped credential never costs a JWKS fetch. */
  canVerify(token: string): boolean {
    return looksLikeJwt(token);
  }

  async verify(token: string): Promise<OidcVerification> {
    if (!looksLikeJwt(token)) return { ok: false, reason: "invalid_token" };
    let keySet: ReturnType<typeof createRemoteJWKSet>;
    try {
      keySet = await this.loadKeySet();
    } catch (error) {
      this.logger.warn({ err: error }, "OIDC provider discovery failed");
      return { ok: false, reason: "provider_unavailable" };
    }
    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(token, keySet, {
        issuer: [this.issuer, `${this.issuer}/`],
        audience: [this.settings.clientId, ...(this.settings.audiences ?? [])],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ["sub", "exp"],
      });
      payload = verified.payload;
    } catch (error) {
      this.logger.info(
        { errorName: error instanceof Error ? error.name : "unknown" },
        "Rejected OIDC token",
      );
      return { ok: false, reason: "invalid_token" };
    }
    const identity: OidcIdentity = {
      subject: payload.sub!,
      email: readStringClaim(payload, "email"),
      name: readStringClaim(payload, "name") ?? readStringClaim(payload, "preferred_username"),
      expiresAt: payload.exp! * 1000,
    };
    if (!this.isAllowed(payload, identity)) {
      this.logger.warn({ subject: identity.subject }, "OIDC user is not allowed on this daemon");
      return { ok: false, reason: "not_allowed" };
    }
    return { ok: true, identity };
  }

  async exchange(grant: OidcTokenGrant): Promise<OidcTokenSet> {
    let discovery: OidcDiscovery;
    try {
      discovery = await this.loadDiscovery();
    } catch (error) {
      this.logger.warn({ err: error }, "OIDC provider discovery failed");
      throw new OidcTokenExchangeError("provider_error", "The OIDC provider is unreachable.");
    }
    const body = new URLSearchParams();
    if (grant.grantType === "authorization_code") {
      body.set("grant_type", "authorization_code");
      body.set("code", grant.code);
      body.set("code_verifier", grant.codeVerifier);
      body.set("redirect_uri", grant.redirectUri);
    } else {
      body.set("grant_type", "refresh_token");
      body.set("refresh_token", grant.refreshToken);
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    };
    if (this.settings.clientSecret) {
      const basic = Buffer.from(
        `${encodeURIComponent(this.settings.clientId)}:${encodeURIComponent(this.settings.clientSecret)}`,
      ).toString("base64");
      headers.Authorization = `Basic ${basic}`;
    } else {
      body.set("client_id", this.settings.clientId);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(discovery.token_endpoint, {
        method: "POST",
        headers,
        body: body.toString(),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.warn({ err: error }, "OIDC token endpoint request failed");
      throw new OidcTokenExchangeError("provider_error", "The OIDC provider is unreachable.");
    }
    const parsed = OidcTokenResponseSchema.safeParse(await response.json().catch(() => ({})));
    const result = parsed.success ? parsed.data : {};
    if (!response.ok) {
      this.logger.info(
        { status: response.status, error: result.error, grantType: grant.grantType },
        "OIDC token endpoint rejected the grant",
      );
      const code = result.error === "invalid_grant" ? "invalid_grant" : "provider_error";
      throw new OidcTokenExchangeError(
        code,
        result.error_description ?? result.error ?? `Token endpoint returned ${response.status}`,
      );
    }
    if (!result.id_token) {
      throw new OidcTokenExchangeError(
        grant.grantType === "refresh_token" ? "invalid_grant" : "provider_error",
        "The OIDC provider did not return an ID token. Request the openid scope.",
      );
    }
    const verification = await this.verify(result.id_token);
    if (!verification.ok) {
      throw new OidcTokenExchangeError(
        verification.reason === "not_allowed" ? "not_allowed" : "provider_error",
        verification.reason === "not_allowed"
          ? "Your account is not allowed to use this host."
          : "The OIDC provider returned an ID token this daemon cannot verify.",
      );
    }
    return {
      idToken: result.id_token,
      refreshToken: result.refresh_token ?? null,
      identity: verification.identity,
    };
  }

  private isAllowed(payload: JWTPayload, identity: OidcIdentity): boolean {
    if (!this.hasAuthorizationRules) return true;
    const { allowedSubjects, allowedEmails, allowedGroups } = this.settings;
    if (allowedSubjects?.includes(identity.subject)) return true;
    if (identity.email && allowedEmails?.length) {
      const email = identity.email.toLowerCase();
      // An unverified email is attacker-controlled on many providers.
      const verified = payload.email_verified !== false;
      if (verified && allowedEmails.some((allowed) => allowed.toLowerCase() === email)) return true;
    }
    if (allowedGroups?.length) {
      const groups = readListClaim(payload, this.settings.groupsClaim ?? "groups");
      if (groups.some((group) => allowedGroups.includes(group))) return true;
    }
    return false;
  }

  private async loadKeySet(): Promise<ReturnType<typeof createRemoteJWKSet>> {
    const discovery = await this.loadDiscovery();
    if (this.jwks?.uri !== discovery.jwks_uri) {
      this.jwks = {
        uri: discovery.jwks_uri,
        keySet: createRemoteJWKSet(new URL(discovery.jwks_uri)),
      };
    }
    return this.jwks.keySet;
  }

  private async loadDiscovery(): Promise<OidcDiscovery> {
    const now = Date.now();
    if (this.discovery && now - this.discovery.fetchedAt < DISCOVERY_TTL_MS) {
      return this.discovery.value;
    }
    if (this.discoveryInFlight) return this.discoveryInFlight;
    if (!this.discovery && now - this.lastDiscoveryFailureAt < DISCOVERY_RETRY_MS) {
      throw new Error("OIDC discovery recently failed; retrying shortly");
    }
    this.discoveryInFlight = this.fetchDiscovery()
      .then((value) => {
        this.discovery = { value, fetchedAt: Date.now() };
        return value;
      })
      .catch((error: unknown) => {
        this.lastDiscoveryFailureAt = Date.now();
        // Keep serving a stale document rather than locking everyone out.
        if (this.discovery) return this.discovery.value;
        throw error;
      })
      .finally(() => {
        this.discoveryInFlight = null;
      });
    return this.discoveryInFlight;
  }

  private async fetchDiscovery(): Promise<OidcDiscovery> {
    const url = `${this.issuer}/.well-known/openid-configuration`;
    const response = await this.fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`OIDC discovery at ${url} returned ${response.status}`);
    }
    const document = OidcDiscoverySchema.parse(await response.json());
    if (normalizeIssuer(document.issuer) !== this.issuer) {
      throw new Error(
        `OIDC discovery issuer ${document.issuer} does not match configured issuer ${this.settings.issuer}`,
      );
    }
    return document;
  }
}
