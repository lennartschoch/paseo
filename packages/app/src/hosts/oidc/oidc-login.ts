import AsyncStorage from "@react-native-async-storage/async-storage";
import { CryptoDigestAlgorithm, CryptoEncoding, digestStringAsync } from "expo-crypto";
import { z } from "zod";
import { isLoopbackEndpoint } from "@/hosts/connection-display";
import { i18n } from "@/i18n/i18next";
import { readValidatedJson } from "@/storage/validated-storage";
import { openOidcAuthorization, resolveOidcRedirectUri } from "./oidc-authorize";
import {
  fetchOidcDescriptor,
  isOidcTransportSecure,
  type OidcDaemonTarget,
  type OidcDescriptor,
  oidcTargetKey,
  requestOidcTokens,
} from "./oidc-http";
import { getOidcSession, saveOidcSession } from "./oidc-session-store";

// FORK(oidc): first-class OIDC sign-in for direct connections. See .fork/README.md.
//
// Authorization code + PKCE. The pending flow is persisted because the web
// build leaves the page for the provider and comes back to /oidc-callback with
// a fresh JavaScript context; native and Electron finish in the same context.

const PENDING_KEY = "@paseo:oidc-pending";
const PENDING_TTL_MS = 15 * 60 * 1000;

const PurposeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("add") }),
  z.object({ kind: z.literal("reauth"), serverId: z.string() }),
]);

export type OidcSignInPurpose = z.infer<typeof PurposeSchema>;

const PendingFlowSchema = z.object({
  state: z.string(),
  codeVerifier: z.string(),
  nonce: z.string(),
  redirectUri: z.string(),
  issuer: z.string(),
  clientId: z.string(),
  endpoint: z.string(),
  useTls: z.boolean(),
  purpose: PurposeSchema,
  createdAt: z.number(),
});

type PendingFlow = z.infer<typeof PendingFlowSchema>;

const PendingFlowsSchema = z.array(PendingFlowSchema);

export type OidcSignInResult =
  | { status: "signed_in"; target: OidcDaemonTarget; purpose: OidcSignInPurpose }
  | { status: "cancelled" }
  | { status: "failed"; message: string }
  /** The page is navigating to the provider; /oidc-callback finishes the flow. */
  | { status: "redirected" };

export class OidcCallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OidcCallbackError";
  }
}

function randomUrlSafe(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return base64ToUrlSafe(btoa(binary));
}

function base64ToUrlSafe(value: string): string {
  return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function readPendingFlows(): Promise<PendingFlow[]> {
  const flows = (await readValidatedJson(AsyncStorage, PENDING_KEY, PendingFlowsSchema)) ?? [];
  const cutoff = Date.now() - PENDING_TTL_MS;
  return flows.filter((flow) => flow.createdAt > cutoff);
}

async function writePendingFlows(flows: PendingFlow[]): Promise<void> {
  await AsyncStorage.setItem(PENDING_KEY, JSON.stringify(flows));
}

async function takePendingFlow(state: string): Promise<PendingFlow | null> {
  const flows = await readPendingFlows();
  const flow = flows.find((candidate) => candidate.state === state) ?? null;
  await writePendingFlows(flows.filter((candidate) => candidate.state !== state));
  return flow;
}

/**
 * The host supplies the authorization endpoint, and Linking.openURL opens any
 * scheme (tel:, intent:, other apps' deep links). Only https leaves the app,
 * plus http to a provider on this machine for local setups.
 */
function isSafeAuthorizationEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && isLoopbackEndpoint(url.host);
}

function buildAuthorizationUrl(input: {
  descriptor: OidcDescriptor;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}): string {
  const url = new URL(input.descriptor.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.descriptor.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", input.descriptor.scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

// Native and Electron finish in this JavaScript context; the waiter hands the
// result back to the screen that started the sign-in.
const waiters = new Map<string, (result: OidcSignInResult) => void>();

/** Resolves the sign-in started for `state` as cancelled (the user came back without finishing). */
export function cancelOidcSignIn(state: string): void {
  waiters.get(state)?.({ status: "cancelled" });
  waiters.delete(state);
}

/**
 * Starts a sign-in against the daemon's OIDC provider. Resolves null when the
 * daemon does not offer OIDC.
 */
export async function beginOidcSignIn(input: {
  target: OidcDaemonTarget;
  purpose: OidcSignInPurpose;
  descriptor?: OidcDescriptor;
}): Promise<OidcSignInResult | null> {
  if (!isOidcTransportSecure(input.target)) {
    return { status: "failed", message: i18n.t("oidc.errors.tlsRequired") };
  }
  const descriptor = input.descriptor ?? (await fetchOidcDescriptor(input.target));
  if (!descriptor) return null;
  if (!isSafeAuthorizationEndpoint(descriptor.authorizationEndpoint)) {
    return { status: "failed", message: i18n.t("oidc.errors.unsafeAuthorizationEndpoint") };
  }
  // Pin the provider: a host that starts naming another issuer or client is not
  // trusted with a sign-in until the user removes and re-adds it.
  const existing = await getOidcSession(input.target);
  if (
    existing &&
    (existing.issuer !== descriptor.issuer || existing.clientId !== descriptor.clientId)
  ) {
    return {
      status: "failed",
      message: i18n.t("oidc.errors.providerChanged", {
        issuer: descriptor.issuer,
        pinned: existing.issuer,
      }),
    };
  }

  const state = randomUrlSafe(24);
  const codeVerifier = randomUrlSafe(48);
  const nonce = randomUrlSafe(16);
  const codeChallenge = base64ToUrlSafe(
    await digestStringAsync(CryptoDigestAlgorithm.SHA256, codeVerifier, {
      encoding: CryptoEncoding.BASE64,
    }),
  );
  const redirectUri = resolveOidcRedirectUri(input.target.endpoint);
  const flows = await readPendingFlows();
  await writePendingFlows([
    ...flows,
    {
      state,
      codeVerifier,
      nonce,
      redirectUri,
      issuer: descriptor.issuer,
      clientId: descriptor.clientId,
      endpoint: input.target.endpoint,
      useTls: input.target.useTls,
      purpose: input.purpose,
      createdAt: Date.now(),
    },
  ]);

  const authorizationUrl = buildAuthorizationUrl({
    descriptor,
    redirectUri,
    state,
    nonce,
    codeChallenge,
  });
  const waiter = new Promise<OidcSignInResult>((resolve) => waiters.set(state, resolve));
  const opened = await openOidcAuthorization({
    url: authorizationUrl,
    redirectUri,
    onReturnWithoutCallback: () => cancelOidcSignIn(state),
  });
  if (opened.status === "redirected") {
    waiters.delete(state);
    return { status: "redirected" };
  }
  if (opened.status === "cancelled") {
    cancelOidcSignIn(state);
    await takePendingFlow(state);
    return { status: "cancelled" };
  }
  // The waiter receives the outcome, including a failure.
  if (opened.status === "callback") {
    void completeOidcSignIn(opened.callbackUrl).catch(() => undefined);
  }
  // "waiting": the system browser returns through the /oidc-callback deep link.
  return waiter;
}

/**
 * Finishes a sign-in from the provider's redirect. Returns whether a screen in
 * this context was waiting for it; when none was (web reload, or the app was
 * restarted), the caller owns what happens next.
 */
export async function completeOidcSignIn(
  callbackUrl: string,
): Promise<{ handled: boolean; target: OidcDaemonTarget; purpose: OidcSignInPurpose }> {
  const url = new URL(callbackUrl);
  const params = url.searchParams;
  const redirectEndpoint = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  const state = params.get("state");
  if (!state) throw new OidcCallbackError("The sign-in response has no state.");
  const flow = await takePendingFlow(state);
  const waiter = waiters.get(state);
  waiters.delete(state);
  try {
    if (!flow) throw new OidcCallbackError("This sign-in expired. Start it again.");
    // The redirect names the daemon the sign-in was started for.
    if (oidcTargetKey({ endpoint: redirectEndpoint }) !== oidcTargetKey(flow)) {
      throw new OidcCallbackError("The sign-in response is for a different host.");
    }
    const error = params.get("error");
    if (error) {
      throw new OidcCallbackError(params.get("error_description") ?? error);
    }
    const code = params.get("code");
    if (!code) throw new OidcCallbackError("The sign-in response has no authorization code.");
    const target = { endpoint: flow.endpoint, useTls: flow.useTls };
    const tokens = await requestOidcTokens(target, {
      grantType: "authorization_code",
      code,
      codeVerifier: flow.codeVerifier,
      redirectUri: flow.redirectUri,
      nonce: flow.nonce,
    });
    await saveOidcSession(target, {
      ...tokens,
      useTls: flow.useTls,
      issuer: flow.issuer,
      clientId: flow.clientId,
    });
    waiter?.({ status: "signed_in", target, purpose: flow.purpose });
    return { handled: Boolean(waiter), target, purpose: flow.purpose };
  } catch (error) {
    waiter?.({
      status: "failed",
      message: error instanceof Error ? error.message : "Sign-in failed.",
    });
    throw error;
  }
}
