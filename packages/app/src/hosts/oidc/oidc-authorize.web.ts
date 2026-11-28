import type { OidcAuthorizationOutcome, OpenOidcAuthorizationInput } from "./oidc-authorize-types";

// FORK(oidc): browser web build. See .fork/README.md.

export function resolveOidcRedirectUri(): string {
  return `${window.location.origin}/oidc-callback`;
}

export async function openOidcAuthorization(
  input: OpenOidcAuthorizationInput,
): Promise<OidcAuthorizationOutcome> {
  window.location.assign(input.url);
  return { status: "redirected" };
}
