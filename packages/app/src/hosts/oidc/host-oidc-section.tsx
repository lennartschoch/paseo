import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type { HostProfile } from "@/types/host-connection";
import { applyOidcSignIn } from "./oidc-finish";
import { fetchOidcDescriptor, type OidcDaemonTarget, type OidcDescriptor } from "./oidc-http";
import { beginOidcSignIn } from "./oidc-login";
import { clearOidcSession, useOidcSession } from "./oidc-session-store";

// FORK(oidc): single sign-on status and actions for a saved host. See .fork/README.md.

function useDirectTarget(host: HostProfile): OidcDaemonTarget | null {
  const connection = host.connections.find((candidate) => candidate.type === "directTcp");
  if (connection?.type !== "directTcp") return null;
  return { endpoint: connection.endpoint, useTls: connection.useTls ?? false };
}

type DescriptorState =
  | { status: "loading" }
  | { status: "ready"; descriptor: OidcDescriptor | null }
  | { status: "error" };

function useOidcDescriptor(target: OidcDaemonTarget | null): DescriptorState {
  const endpoint = target?.endpoint ?? null;
  const useTls = target?.useTls ?? false;
  const [state, setState] = useState<DescriptorState>({ status: "loading" });
  useEffect(() => {
    if (!endpoint) return;
    let cancelled = false;
    setState({ status: "loading" });
    void (async () => {
      try {
        const descriptor = await fetchOidcDescriptor({ endpoint, useTls });
        if (!cancelled) setState({ status: "ready", descriptor });
      } catch {
        if (!cancelled) setState({ status: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [endpoint, useTls]);
  return state;
}

export function HostOidcSection({ host }: { host: HostProfile }) {
  const target = useDirectTarget(host);
  if (!target) return null;
  return <HostOidcSectionContent host={host} target={target} />;
}

function HostOidcSectionContent({ host, target }: { host: HostProfile; target: OidcDaemonTarget }) {
  const { t } = useTranslation();
  const session = useOidcSession(target.endpoint);
  const descriptorState = useOidcDescriptor(target);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const descriptor = descriptorState.status === "ready" ? descriptorState.descriptor : null;

  const handleSignIn = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await beginOidcSignIn({
        target,
        purpose: { kind: "reauth", serverId: host.serverId },
        ...(descriptor ? { descriptor } : {}),
      });
      if (result === null) setError(t("oidc.errors.unavailable"));
      else if (result.status === "failed") setError(result.message);
      else if (result.status === "signed_in") await applyOidcSignIn(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("oidc.errors.generic"));
    } finally {
      setBusy(false);
    }
  }, [descriptor, host.serverId, t, target]);

  const handleSignOut = useCallback(async () => {
    setBusy(true);
    try {
      await clearOidcSession(target);
      await getHostRuntimeStore().reauthenticateHost(host.serverId);
    } finally {
      setBusy(false);
    }
  }, [host.serverId, target]);

  const onSignIn = useCallback(() => void handleSignIn(), [handleSignIn]);
  const onSignOut = useCallback(() => void handleSignOut(), [handleSignOut]);

  // Hide the section for daemons that don't offer OIDC, unless a stale session needs removing.
  if (!session && descriptorState.status !== "ready") return null;
  if (!session && !descriptor) return null;

  const expired = session ? session.expiresAt <= Date.now() && !session.refreshToken : false;
  let hint: string;
  if (!session) hint = t("oidc.host.signedOut");
  else if (expired) hint = t("oidc.host.expired");
  else hint = t("oidc.host.signedInAs", { name: session.email ?? session.name ?? session.subject });

  return (
    <SettingsSection title={t("oidc.host.title")}>
      <SettingsCard>
        <SettingsRow
          label={t("oidc.host.label")}
          hint={hint}
          error={error ?? undefined}
          testID="host-oidc-row"
        >
          <View style={styles.actions}>
            {session ? (
              <Button variant="outline" onPress={onSignOut} disabled={busy}>
                {t("oidc.host.signOut")}
              </Button>
            ) : null}
            {descriptor ? (
              <Button variant="secondary" onPress={onSignIn} loading={busy} disabled={busy}>
                {session ? t("oidc.host.signInAgain") : t("oidc.host.signIn")}
              </Button>
            ) : null}
          </View>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  actions: { flexDirection: "row", gap: theme.spacing[2], flexWrap: "wrap" },
}));
