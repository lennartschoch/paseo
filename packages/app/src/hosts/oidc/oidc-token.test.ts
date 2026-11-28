import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// FORK(oidc): see .fork/README.md.

interface FakeDaemon {
  endpoint: string;
  requests: Record<string, unknown>[];
  revocations: Record<string, unknown>[];
  respond(status: number, body: Record<string, unknown>): void;
  close(): Promise<void>;
}

async function startFakeDaemon(): Promise<FakeDaemon> {
  const requests: Record<string, unknown>[] = [];
  const revocations: Record<string, unknown>[] = [];
  let response: { status: number; body: Record<string, unknown> } = { status: 500, body: {} };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      if (req.url === "/api/auth/oidc/token") requests.push(JSON.parse(body));
      if (req.url === "/api/auth/oidc/revoke") revocations.push(JSON.parse(body));
      res.statusCode = response.status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(response.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    endpoint: `127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    revocations,
    respond: (status, body) => {
      response = { status, body };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function loadModules() {
  vi.resetModules();
  const storage = await import("../../../test-stubs/async-storage");
  storage.clearAsyncStorageStub();
  const store = await import("./oidc-session-store");
  const token = await import("./oidc-token");
  return { store, token };
}

function session(overrides: { expiresAt: number; refreshToken?: string | null }) {
  return {
    idToken: "id-old",
    refreshToken: overrides.refreshToken === undefined ? "refresh-old" : overrides.refreshToken,
    expiresAt: overrides.expiresAt,
    subject: "user-1",
    email: null,
    name: null,
    useTls: false,
    issuer: "https://auth.example.com",
    clientId: "paseo-test",
  };
}

describe("resolveOidcToken", () => {
  let daemon: FakeDaemon;

  beforeEach(async () => {
    daemon = await startFakeDaemon();
  });

  afterEach(async () => {
    await daemon.close();
  });

  test("returns undefined without a session", async () => {
    const { token } = await loadModules();

    await expect(token.resolveOidcToken(daemon.endpoint)).resolves.toBeUndefined();
  });

  test("returns a fresh token without contacting the daemon", async () => {
    const { store, token } = await loadModules();
    await store.saveOidcSession(
      { endpoint: daemon.endpoint },
      session({ expiresAt: Date.now() + 3_600_000 }),
    );

    await expect(token.resolveOidcToken(daemon.endpoint)).resolves.toBe("id-old");
    expect(daemon.requests).toEqual([]);
  });

  test("refreshes an expiring token once and keeps the refresh token when none is returned", async () => {
    const { store, token } = await loadModules();
    await store.saveOidcSession({ endpoint: daemon.endpoint }, session({ expiresAt: Date.now() }));
    daemon.respond(200, {
      idToken: "id-new",
      refreshToken: null,
      expiresAt: Date.now() + 3_600_000,
      subject: "user-1",
      email: null,
      name: null,
    });

    const [first, second] = await Promise.all([
      token.resolveOidcToken(daemon.endpoint),
      token.resolveOidcToken(daemon.endpoint),
    ]);

    expect([first, second]).toEqual(["id-new", "id-new"]);
    expect(daemon.requests).toEqual([{ grantType: "refresh_token", refreshToken: "refresh-old" }]);
    expect(await store.getOidcSession({ endpoint: daemon.endpoint })).toMatchObject({
      idToken: "id-new",
      refreshToken: "refresh-old",
    });
  });

  test("signs out when the provider rejects the refresh token", async () => {
    const { store, token } = await loadModules();
    await store.saveOidcSession({ endpoint: daemon.endpoint }, session({ expiresAt: Date.now() }));
    daemon.respond(400, { error: "invalid_grant", message: "expired" });

    await expect(token.resolveOidcToken(daemon.endpoint)).resolves.toBeUndefined();
    expect(await store.getOidcSession({ endpoint: daemon.endpoint })).toBeNull();
  });

  test("keeps a still-valid token when the daemon is unreachable", async () => {
    const { store, token } = await loadModules();
    await store.saveOidcSession(
      { endpoint: daemon.endpoint },
      session({ expiresAt: Date.now() + 30_000 }),
    );
    daemon.respond(502, { error: "provider_error" });

    await expect(token.resolveOidcToken(daemon.endpoint)).resolves.toBe("id-old");
    expect(await store.getOidcSession({ endpoint: daemon.endpoint })).not.toBeNull();
  });
});

describe("plain-text connections", () => {
  test("never hands out a token for a remote host without TLS", async () => {
    const { store, token } = await loadModules();
    await store.saveOidcSession(
      { endpoint: "paseo.example.com:6767" },
      session({ expiresAt: Date.now() + 3_600_000 }),
    );

    await expect(token.resolveOidcToken("paseo.example.com:6767")).resolves.toBeUndefined();
  });
});

describe("signOutOidc", () => {
  let daemon: FakeDaemon;

  beforeEach(async () => {
    daemon = await startFakeDaemon();
  });

  afterEach(async () => {
    await daemon.close();
  });

  test("revokes the refresh token through the daemon and forgets the session", async () => {
    const { store, token } = await loadModules();
    const target = { endpoint: daemon.endpoint, useTls: false };
    await store.saveOidcSession(target, session({ expiresAt: Date.now() + 3_600_000 }));
    daemon.respond(200, { revoked: true });

    await token.signOutOidc(target);

    expect(daemon.revocations).toEqual([{ refreshToken: "refresh-old" }]);
    expect(await store.getOidcSession(target)).toBeNull();
  });

  test("forgets the session even when revocation fails", async () => {
    const { store, token } = await loadModules();
    const target = { endpoint: daemon.endpoint, useTls: false };
    await store.saveOidcSession(target, session({ expiresAt: Date.now() + 3_600_000 }));
    daemon.respond(502, { error: "provider_error", message: "down" });

    await expect(token.signOutOidc(target)).rejects.toThrow("down");
    expect(await store.getOidcSession(target)).toBeNull();
  });
});

describe("oidcEndpointsForConnection", () => {
  test("tries the connection's own endpoint, then the host's other direct endpoints", async () => {
    const { token } = await loadModules();
    const host = {
      connections: [
        { id: "relay:x", type: "relay" as const, relayEndpoint: "r:443", daemonPublicKeyB64: "k" },
        { id: "direct:h:6767", type: "directTcp" as const, endpoint: "h:6767", useTls: true },
        { id: "direct:ts:443", type: "directTcp" as const, endpoint: "ts:443", useTls: true },
      ],
    };

    expect(token.oidcEndpointsForConnection(host, host.connections[0]!)).toEqual([
      "h:6767",
      "ts:443",
    ]);
    expect(token.oidcEndpointsForConnection(host, host.connections[2]!)).toEqual([
      "ts:443",
      "h:6767",
    ]);
    expect(
      token.oidcEndpointsForConnection(host, { id: "p", type: "directTcp", endpoint: "h:6767" }),
    ).toEqual([]);
    expect(
      token.oidcEndpointsForConnection(host, { id: "s", type: "directSocket", path: "/tmp/s" }),
    ).toEqual([]);
  });

  test("finds a session saved under 127.0.0.1 through the registry's localhost form", async () => {
    const { store, token } = await loadModules();
    await store.saveOidcSession(
      { endpoint: "127.0.0.1:6795" },
      session({ expiresAt: Date.now() + 3_600_000 }),
    );

    await expect(token.resolveOidcToken("localhost:6795")).resolves.toBe("id-old");
  });

  test("a route without a session of its own uses the host's signed-in endpoint", async () => {
    const { store, token } = await loadModules();
    const signedIn = { endpoint: "10.0.0.5:6795", useTls: true };
    await store.saveOidcSession(signedIn, {
      ...session({ expiresAt: Date.now() + 3_600_000 }),
      useTls: true,
    });
    const host = {
      connections: [{ id: "direct:10.0.0.5:6795", type: "directTcp" as const, ...signedIn }],
    };
    const localRoute = { id: "local", type: "directTcp" as const, endpoint: "localhost:6795" };

    const resolve = token.createOidcTokenResolver(host, localRoute);

    await expect(resolve?.()).resolves.toBe("id-old");
  });
});
