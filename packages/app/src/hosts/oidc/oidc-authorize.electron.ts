import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import type { OidcAuthorizationOutcome, OpenOidcAuthorizationInput } from "./oidc-authorize-types";

// FORK(oidc): Electron desktop. The main process opens the provider in its own
// window and catches the redirect (packages/desktop/src/features/oidc-authorize.ts).
// See .fork/README.md.

export function resolveOidcRedirectUri(): string {
  return "paseo://oidc-callback";
}

export async function openOidcAuthorization(
  input: OpenOidcAuthorizationInput,
): Promise<OidcAuthorizationOutcome> {
  const result = await invokeDesktopCommand<
    { status: "completed"; callbackUrl: string } | { status: "cancelled" }
  >("oidc_authorize", { url: input.url, redirectUri: input.redirectUri });
  return result.status === "completed"
    ? { status: "callback", callbackUrl: result.callbackUrl }
    : { status: "cancelled" };
}
