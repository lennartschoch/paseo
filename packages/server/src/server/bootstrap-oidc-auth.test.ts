import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { startTestOidcProvider, type TestOidcProvider } from "./test-utils/oidc-provider.js";

// FORK(oidc): see .fork/README.md.

const originalEnv = { ...process.env };

function createClient(input: {
  port: number;
  clientId: string;
  oidcToken?: () => Promise<string | undefined>;
}): DaemonClient {
  return new DaemonClient({
    url: `ws://127.0.0.1:${input.port}/ws`,
    clientId: input.clientId,
    clientType: "browser",
    ...(input.oidcToken ? { oidcToken: input.oidcToken } : {}),
    webSocketFactory: (url, options) =>
      new WebSocket(url, options?.protocols, { headers: options?.headers }),
    reconnect: { enabled: false },
  });
}

describe("daemon OIDC auth", () => {
  let provider: TestOidcProvider;
  let daemon: TestPaseoDaemon;

  beforeEach(async () => {
    vi.useRealTimers();
    process.env = { ...originalEnv, PASEO_SUPERVISED: "0" };
    provider = await startTestOidcProvider();
    daemon = await createTestPaseoDaemon({
      auth: { oidc: { issuer: provider.issuer, clientId: provider.clientId } },
    });
  });

  afterEach(async () => {
    await daemon.close();
    await provider.close();
  });

  test("publishes the sign-in descriptor without authentication", async () => {
    const response = await fetch(`http://127.0.0.1:${daemon.port}/api/auth/oidc`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      enabled: true,
      issuer: provider.issuer,
      clientId: "paseo",
      authorizationEndpoint: `${provider.issuer}/authorize`,
    });
  });

  test("protects HTTP routes with the OIDC token", async () => {
    const url = `http://127.0.0.1:${daemon.port}/api/status`;

    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { Authorization: "Bearer junk" } })).status).toBe(401);
    const token = await provider.signIdToken();
    expect((await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
  });

  test("admits a client that presents a valid OIDC token", async () => {
    const token = await provider.signIdToken();
    const client = createClient({
      port: daemon.port,
      clientId: "oidc-client",
      oidcToken: async () => token,
    });
    try {
      await client.connect();
      expect(client.getLastServerInfoMessage()?.serverId).toBe(daemon.daemon.getServerId());
    } finally {
      await client.close();
    }
  });

  test("rejects a missing or invalid OIDC token", async () => {
    const anonymous = createClient({ port: daemon.port, clientId: "anonymous" });
    const forged = createClient({
      port: daemon.port,
      clientId: "forged",
      oidcToken: async () => provider.signWithForeignKey(),
    });
    try {
      await expect(anonymous.connect()).rejects.toMatchObject({ reason: "password_required" });
      await expect(forged.connect()).rejects.toMatchObject({ reason: "incorrect_password" });
    } finally {
      await anonymous.close();
      await forged.close();
    }
  });

  test("does not admit an arbitrary bearer header when only OIDC is configured", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws`, ["paseo.bearer.junk"]);
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));

    await expect(closed).resolves.toBe(4401);
  });

  test("exchanges an authorization code through the daemon", async () => {
    const idToken = await provider.signIdToken({ email: "me@example.com" });
    provider.setTokenResponse({ status: 200, body: { id_token: idToken, refresh_token: "r1" } });

    const response = await fetch(`http://127.0.0.1:${daemon.port}/api/auth/oidc/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grantType: "authorization_code",
        code: "abc",
        codeVerifier: "v".repeat(43),
        redirectUri: "paseo://oidc-callback",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      idToken,
      refreshToken: "r1",
      subject: "user-1",
      email: "me@example.com",
    });
  });

  test("reports an expired refresh token as invalid_grant", async () => {
    provider.setTokenResponse({ status: 400, body: { error: "invalid_grant" } });

    const response = await fetch(`http://127.0.0.1:${daemon.port}/api/auth/oidc/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grantType: "refresh_token", refreshToken: "stale" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });

  test("keeps the daemon password working alongside OIDC", async () => {
    // bcrypt hash of "correct-password", the fixture bootstrap-auth.test.ts uses.
    const both = await createTestPaseoDaemon({
      auth: {
        password: "$2b$12$OLxyuuP9uLK30Uzc4wQX0O6liuU/Q1t5P2b0Ebf36mULvpVK3DRZW",
        oidc: { issuer: provider.issuer, clientId: provider.clientId },
      },
    });
    try {
      const url = `http://127.0.0.1:${both.port}/api/status`;
      const token = await provider.signIdToken();
      expect((await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(
        200,
      );
      const password = { Authorization: "Bearer correct-password" };
      expect((await fetch(url, { headers: password })).status).toBe(200);
      expect((await fetch(url, { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    } finally {
      await both.close();
    }
  });
});
