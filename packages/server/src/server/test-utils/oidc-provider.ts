import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";

// FORK(oidc): a real HTTP OIDC provider for tests. See .fork/README.md.

export interface TestOidcProvider {
  issuer: string;
  clientId: string;
  /** Signs an ID token. Claims override the defaults (sub, aud, exp in an hour). */
  signIdToken(claims?: JWTPayload & { expiresInSeconds?: number }): Promise<string>;
  /** Signs with a key the provider never published. */
  signWithForeignKey(claims?: JWTPayload): Promise<string>;
  /** Next token response the token endpoint returns. */
  setTokenResponse(response: { status: number; body: Record<string, unknown> }): void;
  tokenRequests: URLSearchParams[];
  tokenRequestAuthorization: (string | undefined)[];
  /** Bodies posted to the revocation endpoint. */
  revocationRequests: URLSearchParams[];
  close(): Promise<void>;
}

export async function startTestOidcProvider(
  input: { clientId?: string } = {},
): Promise<TestOidcProvider> {
  const clientId = input.clientId ?? "paseo";
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const foreign = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  const tokenRequests: URLSearchParams[] = [];
  const tokenRequestAuthorization: (string | undefined)[] = [];
  const revocationRequests: URLSearchParams[] = [];
  let tokenResponse: { status: number; body: Record<string, unknown> } = {
    status: 400,
    body: { error: "invalid_grant" },
  };
  let issuer = "";

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    if (url.pathname === "/.well-known/openid-configuration") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          revocation_endpoint: `${issuer}/revoke`,
        }),
      );
      return;
    }
    if (url.pathname === "/jwks") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (url.pathname === "/token" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        tokenRequests.push(new URLSearchParams(body));
        tokenRequestAuthorization.push(req.headers.authorization);
        res.statusCode = tokenResponse.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(tokenResponse.body));
      });
      return;
    }
    if (url.pathname === "/revoke" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        revocationRequests.push(new URLSearchParams(body));
        res.end();
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function sign(
    key: CryptoKey,
    claims: JWTPayload & { expiresInSeconds?: number } = {},
  ): Promise<string> {
    const { expiresInSeconds, ...rest } = claims;
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ sub: "user-1", aud: clientId, ...rest })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setIssuedAt(now)
      .setExpirationTime(now + (expiresInSeconds ?? 3600))
      .sign(key);
  }

  return {
    issuer,
    clientId,
    signIdToken: (claims) => sign(privateKey, claims),
    signWithForeignKey: (claims) => sign(foreign.privateKey, claims),
    setTokenResponse: (response) => {
      tokenResponse = response;
    },
    tokenRequests,
    tokenRequestAuthorization,
    revocationRequests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
