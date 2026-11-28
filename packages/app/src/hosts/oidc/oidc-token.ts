import type { HostConnection, HostProfile } from "@/types/host-connection";
import { OidcTokenRequestError, oidcTargetKey, requestOidcTokens } from "./oidc-http";
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
        { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken, useTls: session.useTls },
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
 * Picks the endpoint whose OIDC session authenticates this connection: the
 * connection's own for direct TCP, otherwise the host's first direct TCP
 * connection, so relay and routed connections to the same daemon reuse it.
 */
export function oidcEndpointForConnection(
  host: Pick<HostProfile, "connections">,
  connection: HostConnection,
): string | null {
  if (connection.type === "directTcp") return connection.endpoint;
  if (connection.type === "directSocket" || connection.type === "directPipe") return null;
  return host.connections.find((candidate) => candidate.type === "directTcp")?.endpoint ?? null;
}

export function createOidcTokenResolver(
  host: Pick<HostProfile, "connections">,
  connection: HostConnection,
): (() => Promise<string | undefined>) | undefined {
  const endpoint = oidcEndpointForConnection(host, connection);
  return endpoint ? () => resolveOidcToken(endpoint) : undefined;
}
