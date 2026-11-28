import { i18n } from "@/i18n/i18next";
import { confirmDialog } from "@/utils/confirm-dialog";
import { getConnectionAuthFailureReason } from "@/utils/test-daemon-connection";
import { fetchOidcDescriptor, type OidcDaemonTarget } from "./oidc-http";
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

function describeIssuer(issuer: string): string {
  try {
    return new URL(issuer).host;
  } catch {
    return issuer;
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
    const descriptor = await fetchOidcDescriptor(input.target).catch(() => null);
    if (!descriptor) throw error;
    // The host chose the provider. Name it before the browser opens, so a host
    // impersonating a familiar provider is something the user gets to refuse.
    const confirmed = await confirmDialog({
      title: i18n.t("oidc.confirm.title"),
      message: i18n.t("oidc.confirm.message", {
        host: input.target.endpoint,
        provider: describeIssuer(descriptor.issuer),
      }),
      confirmLabel: i18n.t("oidc.confirm.continue"),
      cancelLabel: i18n.t("oidc.confirm.cancel"),
    });
    if (!confirmed) throw new OidcSignInAbortedError("cancelled", "Sign-in was not completed.");
    const signIn = await beginOidcSignIn({
      target: input.target,
      purpose: { kind: "add" },
      descriptor,
    }).catch(() => null);
    if (signIn === null) throw error;
    if (signIn.status === "failed") throw new Error(signIn.message, { cause: error });
    if (signIn.status === "cancelled" || signIn.status === "redirected") {
      throw new OidcSignInAbortedError(signIn.status, "Sign-in was not completed.");
    }
    return input.probe();
  }
}
