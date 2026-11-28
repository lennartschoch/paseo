import { getConnectionAuthFailureReason } from "@/utils/test-daemon-connection";
import type { OidcDaemonTarget } from "./oidc-http";
import { beginOidcSignIn } from "./oidc-login";

// FORK(oidc): see .fork/README.md.

export class OidcSignInAbortedError extends Error {
  constructor(
    public readonly outcome: "cancelled" | "redirected",
    message: string,
  ) {
    super(message);
    this.name = "OidcSignInAbortedError";
  }
}

/**
 * Probes a direct connection. When the daemon asks for a credential the user
 * did not type and it offers OIDC, signs in and probes again.
 */
export async function probeWithOidcSignIn<Result>(input: {
  target: OidcDaemonTarget;
  hasPassword: boolean;
  probe: () => Promise<Result>;
}): Promise<Result> {
  try {
    return await input.probe();
  } catch (error) {
    if (input.hasPassword || getConnectionAuthFailureReason(error) !== "password_required")
      throw error;
    const signIn = await beginOidcSignIn({ target: input.target, purpose: { kind: "add" } }).catch(
      () => null,
    );
    if (signIn === null) throw error;
    if (signIn.status === "failed") throw new Error(signIn.message, { cause: error });
    if (signIn.status === "cancelled" || signIn.status === "redirected") {
      throw new OidcSignInAbortedError(signIn.status, "Sign-in was not completed.");
    }
    return input.probe();
  }
}
