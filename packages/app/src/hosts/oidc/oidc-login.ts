import AsyncStorage from "@react-native-async-storage/async-storage";
import { CryptoDigestAlgorithm, CryptoEncoding, digestStringAsync } from "expo-crypto";
import { z } from "zod";
import { readValidatedJson } from "@/storage/validated-storage";
import { openOidcAuthorization, resolveOidcRedirectUri } from "./oidc-authorize";
import {
  fetchOidcDescriptor,
  type OidcDaemonTarget,
  type OidcDescriptor,
  requestOidcTokens,
} from "./oidc-http";
import { saveOidcSession } from "./oidc-session-store";

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
  redirectUri: z.string(),
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
  const descriptor = input.descriptor ?? (await fetchOidcDescriptor(input.target));
  if (!descriptor) return null;

  const state = randomUrlSafe(24);
  const codeVerifier = randomUrlSafe(48);
  const codeChallenge = base64ToUrlSafe(
    await digestStringAsync(CryptoDigestAlgorithm.SHA256, codeVerifier, {
      encoding: CryptoEncoding.BASE64,
    }),
  );
  const redirectUri = resolveOidcRedirectUri();
  const flows = await readPendingFlows();
  await writePendingFlows([
    ...flows,
    {
      state,
      codeVerifier,
      redirectUri,
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
    nonce: randomUrlSafe(16),
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
  const params = new URL(callbackUrl).searchParams;
  const state = params.get("state");
  if (!state) throw new OidcCallbackError("The sign-in response has no state.");
  const flow = await takePendingFlow(state);
  const waiter = waiters.get(state);
  waiters.delete(state);
  try {
    if (!flow) throw new OidcCallbackError("This sign-in expired. Start it again.");
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
    });
    await saveOidcSession(target, { ...tokens, useTls: flow.useTls });
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
