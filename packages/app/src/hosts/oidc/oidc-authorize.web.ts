import type { OidcAuthorizationOutcome, OpenOidcAuthorizationInput } from "./oidc-authorize-types";
import { oidcRedirectPathSegment } from "./oidc-http";

// FORK(oidc): browser web build. See .fork/README.md.

export function resolveOidcRedirectUri(endpoint: string): string {
  return `${window.location.origin}/oidc-callback/${oidcRedirectPathSegment(endpoint)}`;
}

export async function openOidcAuthorization(
  input: OpenOidcAuthorizationInput,
): Promise<OidcAuthorizationOutcome> {
  window.location.assign(input.url);
  return { status: "redirected" };
}
