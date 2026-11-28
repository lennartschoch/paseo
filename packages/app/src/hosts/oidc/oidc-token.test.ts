import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// FORK(oidc): see .fork/README.md.

interface FakeDaemon {
  endpoint: string;
  requests: Record<string, unknown>[];
  respond(status: number, body: Record<string, unknown>): void;
  close(): Promise<void>;
}

async function startFakeDaemon(): Promise<FakeDaemon> {
  const requests: Record<string, unknown>[] = [];
  let response: { status: number; body: Record<string, unknown> } = { status: 500, body: {} };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      if (req.url === "/api/auth/oidc/token") requests.push(JSON.parse(body));
      res.statusCode = response.status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(response.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    endpoint: `127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
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

describe("oidcEndpointForConnection", () => {
  test("uses the host's direct connection for relay connections and none for local sockets", async () => {
    const { token } = await loadModules();
    const host = {
      connections: [
        { id: "relay:x", type: "relay" as const, relayEndpoint: "r:443", daemonPublicKeyB64: "k" },
        { id: "direct:h:6767", type: "directTcp" as const, endpoint: "h:6767" },
      ],
    };

    expect(token.oidcEndpointForConnection(host, host.connections[0]!)).toBe("h:6767");
    expect(
      token.oidcEndpointForConnection(host, { id: "s", type: "directSocket", path: "/tmp/s" }),
    ).toBeNull();
  });
});
