import * as Linking from "expo-linking";
import { AppState } from "react-native";
import type { OidcAuthorizationOutcome, OpenOidcAuthorizationInput } from "./oidc-authorize-types";

// FORK(oidc): native (iOS/Android). See .fork/README.md.

export const OIDC_NATIVE_REDIRECT_URI = "paseo://oidc-callback";

// The deep link lands a moment after the app becomes active. Wait this long
// before treating a return to the app as an abandoned sign-in.
const RETURN_GRACE_MS = 2_500;

export function resolveOidcRedirectUri(): string {
  return OIDC_NATIVE_REDIRECT_URI;
}

export async function openOidcAuthorization(
  input: OpenOidcAuthorizationInput,
): Promise<OidcAuthorizationOutcome> {
  let leftApp = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const subscription = AppState.addEventListener("change", (state) => {
    if (state !== "active") {
      leftApp = true;
      return;
    }
    if (!leftApp) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      subscription.remove();
      input.onReturnWithoutCallback();
    }, RETURN_GRACE_MS);
  });
  const linkSubscription = Linking.addEventListener("url", (event) => {
    if (!event.url.startsWith(input.redirectUri)) return;
    if (timer) clearTimeout(timer);
    subscription.remove();
    linkSubscription.remove();
  });
  await Linking.openURL(input.url);
  return { status: "waiting" };
}
