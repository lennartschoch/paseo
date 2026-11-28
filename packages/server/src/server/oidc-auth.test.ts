import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTestLogger } from "../test-utils/test-logger.js";
import { OidcTokenExchangeError, OidcVerifier } from "./oidc-auth.js";
import type { OidcAuthSettings } from "./oidc-auth-settings.js";
import { readOidcAuthSettingsFromEnv } from "./oidc-auth-settings.js";
import { startTestOidcProvider, type TestOidcProvider } from "./test-utils/oidc-provider.js";

// FORK(oidc): see .fork/README.md.

describe("OidcVerifier", () => {
  let provider: TestOidcProvider;

  beforeEach(async () => {
    provider = await startTestOidcProvider();
  });

  afterEach(async () => {
    await provider.close();
  });

  function createVerifier(settings: Partial<OidcAuthSettings> = {}): OidcVerifier {
    return new OidcVerifier({
      settings: { issuer: provider.issuer, clientId: provider.clientId, ...settings },
      logger: createTestLogger(),
    });
  }

  test("accepts an ID token signed by the issuer for this client", async () => {
    const verifier = createVerifier();
    const token = await provider.signIdToken({ email: "me@example.com", name: "Me" });

    const result = await verifier.verify(token);

    expect(result).toMatchObject({
      ok: true,
      identity: { subject: "user-1", email: "me@example.com", name: "Me" },
    });
  });

  test("rejects tokens for another client, expired tokens, and foreign signatures", async () => {
    const verifier = createVerifier();

    await expect(verifier.verify(await provider.signIdToken({ aud: "other" }))).resolves.toEqual({
      ok: false,
      reason: "invalid_token",
    });
    await expect(
      verifier.verify(await provider.signIdToken({ expiresInSeconds: -120 })),
    ).resolves.toEqual({ ok: false, reason: "invalid_token" });
    await expect(verifier.verify(await provider.signWithForeignKey())).resolves.toEqual({
      ok: false,
      reason: "invalid_token",
    });
    await expect(verifier.verify("not-a-jwt")).resolves.toEqual({
      ok: false,
      reason: "invalid_token",
    });
  });

  test("accepts extra configured audiences", async () => {
    const verifier = createVerifier({ audiences: ["paseo-api"] });

    const result = await verifier.verify(await provider.signIdToken({ aud: "paseo-api" }));

    expect(result.ok).toBe(true);
  });

  test("applies subject, verified email, and group allow-lists", async () => {
    const verifier = createVerifier({
      allowedSubjects: ["admin"],
      allowedEmails: ["Me@Example.com"],
      allowedGroups: ["paseo"],
    });

    const allowedBySubject = await provider.signIdToken({ sub: "admin" });
    const allowedByEmail = await provider.signIdToken({ sub: "a", email: "me@example.com" });
    const unverifiedEmail = await provider.signIdToken({
      sub: "b",
      email: "me@example.com",
      email_verified: false,
    });
    const allowedByGroup = await provider.signIdToken({ sub: "c", groups: ["dev", "paseo"] });
    const outsider = await provider.signIdToken({ sub: "d", groups: ["dev"] });

    expect((await verifier.verify(allowedBySubject)).ok).toBe(true);
    expect((await verifier.verify(allowedByEmail)).ok).toBe(true);
    expect(await verifier.verify(unverifiedEmail)).toEqual({ ok: false, reason: "not_allowed" });
    expect((await verifier.verify(allowedByGroup)).ok).toBe(true);
    expect(await verifier.verify(outsider)).toEqual({ ok: false, reason: "not_allowed" });
  });

  test("reports an unreachable provider separately from a bad token", async () => {
    const verifier = new OidcVerifier({
      settings: { issuer: "http://127.0.0.1:1", clientId: "paseo" },
      logger: createTestLogger(),
    });

    const result = await verifier.verify(await provider.signIdToken());

    expect(result).toEqual({ ok: false, reason: "provider_unavailable" });
  });

  test("describes the authorization endpoint and default scopes", async () => {
    const verifier = createVerifier();

    await expect(verifier.describe()).resolves.toEqual({
      issuer: provider.issuer,
      clientId: "paseo",
      authorizationEndpoint: `${provider.issuer}/authorize`,
      endSessionEndpoint: null,
      scopes: ["openid", "profile", "email", "groups", "offline_access"],
    });
  });

  test("exchanges an authorization code as a public client", async () => {
    const verifier = createVerifier();
    const idToken = await provider.signIdToken();
    provider.setTokenResponse({ status: 200, body: { id_token: idToken, refresh_token: "r1" } });

    const tokens = await verifier.exchange({
      grantType: "authorization_code",
      code: "the-code",
      codeVerifier: "v".repeat(43),
      redirectUri: "paseo://oidc-callback",
    });

    expect(tokens).toMatchObject({ idToken, refreshToken: "r1", identity: { subject: "user-1" } });
    expect(Object.fromEntries(provider.tokenRequests[0]!)).toEqual({
      grant_type: "authorization_code",
      code: "the-code",
      code_verifier: "v".repeat(43),
      redirect_uri: "paseo://oidc-callback",
      client_id: "paseo",
    });
    expect(provider.tokenRequestAuthorization[0]).toBeUndefined();
  });

  test("authenticates a confidential client with HTTP basic", async () => {
    const verifier = createVerifier({ clientSecret: "s3cret" });
    provider.setTokenResponse({ status: 200, body: { id_token: await provider.signIdToken() } });

    await verifier.exchange({ grantType: "refresh_token", refreshToken: "r1" });

    expect(provider.tokenRequests[0]!.get("client_id")).toBeNull();
    expect(provider.tokenRequestAuthorization[0]).toBe(
      `Basic ${Buffer.from("paseo:s3cret").toString("base64")}`,
    );
  });

  test("maps provider rejections and disallowed users to typed errors", async () => {
    const verifier = createVerifier({ allowedSubjects: ["someone-else"] });

    provider.setTokenResponse({ status: 400, body: { error: "invalid_grant" } });
    await expect(
      verifier.exchange({ grantType: "refresh_token", refreshToken: "stale" }),
    ).rejects.toMatchObject({ code: "invalid_grant" });

    provider.setTokenResponse({ status: 200, body: { id_token: await provider.signIdToken() } });
    const error = await verifier
      .exchange({ grantType: "refresh_token", refreshToken: "r1" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OidcTokenExchangeError);
    expect(error).toMatchObject({ code: "not_allowed" });
  });
});

describe("readOidcAuthSettingsFromEnv", () => {
  test("reads PASEO_OIDC_* lists", () => {
    expect(
      readOidcAuthSettingsFromEnv({
        PASEO_OIDC_ISSUER: "https://auth.example.com",
        PASEO_OIDC_CLIENT_ID: "paseo",
        PASEO_OIDC_ALLOWED_GROUPS: "admins, paseo",
      }),
    ).toEqual({
      issuer: "https://auth.example.com",
      clientId: "paseo",
      allowedGroups: ["admins", "paseo"],
    });
    expect(readOidcAuthSettingsFromEnv({})).toBeUndefined();
  });

  test("requires issuer and client id together", () => {
    expect(() => readOidcAuthSettingsFromEnv({ PASEO_OIDC_ISSUER: "https://a.example" })).toThrow(
      /must be set together/,
    );
  });
});
