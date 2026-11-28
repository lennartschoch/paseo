import type { HostConnection, HostProfile } from "@/types/host-connection";
import {
  isOidcTransportSecure,
  type OidcDaemonTarget,
  OidcTokenRequestError,
  oidcTargetKey,
  requestOidcTokens,
  revokeOidcRefreshToken,
} from "./oidc-http";
import { clearOidcSession, getOidcSession, saveOidcSession } from "./oidc-session-store";

// FORK(oidc): first-class OIDC sign-in for direct connections. See .fork/README.md.

const REFRESH_MARGIN_MS = 60_000;
const refreshesInFlight = new Map<string, Promise<string | undefined>>();

/**
 * Returns a current ID token for the endpoint, refreshing it through the daemon
 * when it is about to expire. Resolves undefined when there is no usable
 * session; the daemon then rejects the hello and the app asks to sign in.
 */
export async function resolveOidcToken(endpoint: string): Promise<string | undefined> {
  const session = await getOidcSession({ endpoint });
  if (!session) return undefined;
  if (!isOidcTransportSecure({ endpoint, useTls: session.useTls })) return undefined;
  if (session.expiresAt - Date.now() > REFRESH_MARGIN_MS) return session.idToken;
  if (!session.refreshToken) return undefined;

  const key = oidcTargetKey({ endpoint });
  const inFlight = refreshesInFlight.get(key);
  if (inFlight) return inFlight;
  const refreshToken = session.refreshToken;
  const refresh = (async () => {
    try {
      const tokens = await requestOidcTokens(
        { endpoint, useTls: session.useTls },
        { grantType: "refresh_token", refreshToken },
      );
      await saveOidcSession(
        { endpoint },
        {
          ...tokens,
          refreshToken: tokens.refreshToken ?? refreshToken,
          useTls: session.useTls,
          issuer: session.issuer,
          clientId: session.clientId,
        },
      );
      return tokens.idToken;
    } catch (error) {
      if (error instanceof OidcTokenRequestError && error.code === "invalid_grant") {
        await clearOidcSession({ endpoint });
        return undefined;
      }
      // Network trouble: hand over the old token; a still-valid one keeps working.
      return session.expiresAt > Date.now() ? session.idToken : undefined;
    } finally {
      refreshesInFlight.delete(key);
    }
  })();
  refreshesInFlight.set(key, refresh);
  return refresh;
}

/**
 * The endpoints whose OIDC session may authenticate this connection, in order:
 * the connection's own direct TCP endpoint, then the host's other direct TCP
 * endpoints. A host reached through several addresses (LAN and Tailscale, or the
 * app's auto-detected local route) signs in through one of them; every route to
 * the same saved host reuses that session. Relay and routed connections only
 * have the host's direct endpoints to draw from. A connection without TLS to
 * another machine never carries a token.
 */
export function oidcEndpointsForConnection(
  host: Pick<HostProfile, "connections">,
  connection: HostConnection,
): string[] {
  if (connection.type === "directSocket" || connection.type === "directPipe") return [];
  if (connection.type === "directTcp") {
    const target = { endpoint: connection.endpoint, useTls: connection.useTls ?? false };
    if (!isOidcTransportSecure(target)) return [];
  }
  const own = connection.type === "directTcp" ? [connection.endpoint] : [];
  const others = host.connections.flatMap((candidate) =>
    candidate.type === "directTcp" ? [candidate.endpoint] : [],
  );
  const seen = new Set<string>();
  return [...own, ...others].filter((endpoint) => {
    const key = oidcTargetKey({ endpoint });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function createOidcTokenResolver(
  host: Pick<HostProfile, "connections">,
  connection: HostConnection,
): (() => Promise<string | undefined>) | undefined {
  const endpoints = oidcEndpointsForConnection(host, connection);
  if (endpoints.length === 0) return undefined;
  return async () => {
    for (const endpoint of endpoints) {
      const token = await resolveOidcToken(endpoint);
      if (token) return token;
    }
    return undefined;
  };
}

/**
 * Signs out of a host: revokes the refresh token at the provider through the
 * daemon, then forgets the session. The local session is removed even when
 * revocation fails, so the reported error never leaves the user signed in.
 */
export async function signOutOidc(target: OidcDaemonTarget): Promise<void> {
  const session = await getOidcSession(target);
  if (!session) return;
  let revocationError: unknown = null;
  if (session.refreshToken && isOidcTransportSecure(target)) {
    try {
      await revokeOidcRefreshToken(target, session.refreshToken);
    } catch (error) {
      revocationError = error;
    }
  }
  await clearOidcSession(target);
  if (revocationError) throw revocationError;
}
