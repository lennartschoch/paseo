import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSyncExternalStore } from "react";
import { z } from "zod";
import { readValidatedJson } from "@/storage/validated-storage";
import { type OidcDaemonTarget, oidcTargetKey } from "./oidc-http";

// FORK(oidc): first-class OIDC sign-in for direct connections. See .fork/README.md.
//
// Sessions live beside the saved host list (AsyncStorage), the same place the
// daemon password is kept. They are keyed by endpoint rather than serverId
// because the first sign-in happens before the app knows the serverId.

const STORAGE_KEY = "@paseo:oidc-sessions";

const OidcSessionSchema = z.object({
  idToken: z.string(),
  refreshToken: z.string().nullable(),
  expiresAt: z.number(),
  subject: z.string(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  useTls: z.boolean(),
  /** The provider this session came from; a later sign-in must name the same one. */
  issuer: z.string(),
  clientId: z.string(),
});

export type OidcSession = z.infer<typeof OidcSessionSchema>;

const OidcSessionMapSchema = z.record(z.string(), OidcSessionSchema);

let sessions: Record<string, OidcSession> | null = null;
let loading: Promise<Record<string, OidcSession>> | null = null;
let version = 0;
const listeners = new Set<() => void>();

async function load(): Promise<Record<string, OidcSession>> {
  if (sessions) return sessions;
  loading ??= readValidatedJson(AsyncStorage, STORAGE_KEY, OidcSessionMapSchema)
    .then((stored) => {
      sessions ??= stored ?? {};
      return sessions;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

async function write(next: Record<string, OidcSession>): Promise<void> {
  sessions = next;
  version += 1;
  for (const listener of listeners) listener();
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

export async function getOidcSession(
  target: Pick<OidcDaemonTarget, "endpoint">,
): Promise<OidcSession | null> {
  return (await load())[oidcTargetKey(target)] ?? null;
}

export async function saveOidcSession(
  target: Pick<OidcDaemonTarget, "endpoint">,
  session: OidcSession,
): Promise<void> {
  const current = await load();
  await write({ ...current, [oidcTargetKey(target)]: session });
}

export async function clearOidcSession(target: Pick<OidcDaemonTarget, "endpoint">): Promise<void> {
  const current = await load();
  const key = oidcTargetKey(target);
  if (!(key in current)) return;
  const { [key]: _removed, ...rest } = current;
  await write(rest);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!sessions) {
    void (async () => {
      await load();
      version += 1;
      listener();
    })();
  }
  return () => {
    listeners.delete(listener);
  };
}

/** The saved OIDC session for an endpoint, or null. Re-renders on sign-in and sign-out. */
export function useOidcSession(endpoint: string | null): OidcSession | null {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
  if (!endpoint || !sessions) return null;
  return sessions[oidcTargetKey({ endpoint })] ?? null;
}
