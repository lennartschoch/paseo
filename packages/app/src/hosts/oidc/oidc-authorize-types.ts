// FORK(oidc): see .fork/README.md.

export type OidcAuthorizationOutcome =
  /** Electron caught the redirect in its auth window. */
  | { status: "callback"; callbackUrl: string }
  /** The system browser is open; the /oidc-callback deep link completes the flow. */
  | { status: "waiting" }
  /** The page is navigating away; /oidc-callback completes the flow after reload. */
  | { status: "redirected" }
  | { status: "cancelled" };

export interface OpenOidcAuthorizationInput {
  url: string;
  redirectUri: string;
  /** Called when the user comes back to the app without the provider redirecting. */
  onReturnWithoutCallback: () => void;
}
