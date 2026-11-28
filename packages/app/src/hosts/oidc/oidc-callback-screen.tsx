import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { Theme } from "@/styles/theme";
import { buildClientHostSettingsRoute } from "@/utils/host-routes";
import { applyOidcSignIn } from "./oidc-finish";
import { oidcRedirectPathSegment } from "./oidc-http";
import { completeOidcSignIn } from "./oidc-login";

// FORK(oidc): the provider redirects here (paseo://oidc-callback/<daemon> on native,
// <origin>/oidc-callback/<daemon> on web). See .fork/README.md.

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function buildCallbackUrl(params: Record<string, string | string[] | undefined>): string {
  const { endpoint, ...query } = params;
  const daemon = Array.isArray(endpoint) ? endpoint[0] : endpoint;
  const url = new URL(`paseo://oidc-callback/${oidcRedirectPathSegment(daemon ?? "")}`);
  for (const [key, value] of Object.entries(query)) {
    const single = Array.isArray(value) ? value[0] : value;
    if (typeof single === "string") url.searchParams.set(key, single);
  }
  return url.toString();
}

export function OidcCallbackScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const params = useLocalSearchParams();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const handleBack = useCallback(() => router.replace("/"), [router]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        const result = await completeOidcSignIn(buildCallbackUrl(params));
        if (result.handled) {
          // The screen that started the sign-in owns what happens next.
          if (router.canGoBack()) router.back();
          else router.replace("/");
          return;
        }
        const { serverId } = await applyOidcSignIn(result);
        router.replace(buildClientHostSettingsRoute(serverId));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : t("oidc.errors.generic"));
      }
    })();
  }, [params, router, t]);

  return (
    <View style={styles.container} testID="oidc-callback-screen">
      {error ? (
        <>
          <Text style={styles.title}>{t("oidc.callback.failedTitle")}</Text>
          <Text style={styles.message}>{error}</Text>
          <Button variant="outline" onPress={handleBack}>
            {t("oidc.callback.back")}
          </Button>
        </>
      ) : (
        <>
          <ThemedLoadingSpinner size="large" uniProps={mutedColorMapping} />
          <Text style={styles.message}>{t("oidc.callback.completing")}</Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[6],
    backgroundColor: theme.colors.surface0,
  },
  title: {
    fontSize: theme.fontSize.lg,
    color: theme.colors.foreground,
  },
  message: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
}));
