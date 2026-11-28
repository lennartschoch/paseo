import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type { OidcDaemonTarget } from "./oidc-http";
import type { OidcSignInPurpose } from "./oidc-login";

// FORK(oidc): see .fork/README.md.

/**
 * Applies a finished sign-in to the saved hosts: adds the host for a new
 * connection, or reconnects an existing host with the new token.
 */
export async function applyOidcSignIn(input: {
  target: OidcDaemonTarget;
  purpose: OidcSignInPurpose;
}): Promise<{ serverId: string }> {
  const store = getHostRuntimeStore();
  await store.boot();
  if (input.purpose.kind === "reauth") {
    await store.reauthenticateHost(input.purpose.serverId);
    return { serverId: input.purpose.serverId };
  }
  const { serverId } = await store.probeAndUpsertDirectConnection({
    endpoint: input.target.endpoint,
    useTls: input.target.useTls,
  });
  return { serverId };
}
