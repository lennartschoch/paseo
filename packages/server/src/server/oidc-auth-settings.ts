import { z } from "zod";

// FORK(oidc): first-class OIDC sign-in for direct connections. See .fork/README.md.

const NonEmptyStringListSchema = z.array(z.string().trim().min(1));

export const OidcAuthSettingsSchema = z
  .object({
    issuer: z.url().describe("OIDC issuer URL, e.g. https://auth.example.com"),
    clientId: z.string().trim().min(1),
    clientSecret: z
      .string()
      .min(1)
      .describe(
        "Client secret of a confidential client. Required: the provider then only redeems codes the daemon presents.",
      ),
    scopes: NonEmptyStringListSchema.optional().describe(
      "Scopes the app requests. Defaults to openid profile email groups offline_access.",
    ),
    audiences: NonEmptyStringListSchema.optional().describe(
      "Extra accepted token audiences besides clientId.",
    ),
    allowedSubjects: NonEmptyStringListSchema.optional(),
    allowedEmails: NonEmptyStringListSchema.optional(),
    allowedGroups: NonEmptyStringListSchema.optional(),
    groupsClaim: z.string().trim().min(1).optional(),
    allowAnyUser: z
      .boolean()
      .optional()
      .describe(
        "Admit every user the provider signs in for this client. Required when no allow-list is set.",
      ),
  })
  .strict()
  .refine(
    (settings) =>
      settings.allowAnyUser === true ||
      Boolean(
        settings.allowedSubjects?.length ||
        settings.allowedEmails?.length ||
        settings.allowedGroups?.length,
      ),
    {
      message:
        "Set allowedSubjects, allowedEmails or allowedGroups, or set allowAnyUser: true to admit every user the provider signs in.",
    },
  );

export type OidcAuthSettings = z.infer<typeof OidcAuthSettingsSchema>;

export const DEFAULT_OIDC_SCOPES = ["openid", "profile", "email", "groups", "offline_access"];

function parseList(value: string | undefined): string[] | undefined {
  const items = value
    ?.split(/[\s,]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items && items.length > 0 ? items : undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw new Error(`Expected true or false, got "${value}".`);
}

/**
 * Reads `PASEO_OIDC_*`. Issuer and client id together enable OIDC and replace
 * the persisted `daemon.auth.oidc` block entirely.
 */
export function readOidcAuthSettingsFromEnv(env: NodeJS.ProcessEnv): OidcAuthSettings | undefined {
  const issuer = env.PASEO_OIDC_ISSUER?.trim();
  const clientId = env.PASEO_OIDC_CLIENT_ID?.trim();
  if (!issuer && !clientId) return undefined;
  if (!issuer || !clientId) {
    throw new Error("PASEO_OIDC_ISSUER and PASEO_OIDC_CLIENT_ID must be set together.");
  }
  const candidate = {
    issuer,
    clientId,
    clientSecret: env.PASEO_OIDC_CLIENT_SECRET?.trim() || undefined,
    scopes: parseList(env.PASEO_OIDC_SCOPES),
    audiences: parseList(env.PASEO_OIDC_AUDIENCES),
    allowedSubjects: parseList(env.PASEO_OIDC_ALLOWED_SUBJECTS),
    allowedEmails: parseList(env.PASEO_OIDC_ALLOWED_EMAILS),
    allowedGroups: parseList(env.PASEO_OIDC_ALLOWED_GROUPS),
    groupsClaim: env.PASEO_OIDC_GROUPS_CLAIM?.trim() || undefined,
    allowAnyUser: parseBoolean(env.PASEO_OIDC_ALLOW_ANY_USER),
  };
  const parsed = OidcAuthSettingsSchema.safeParse(
    Object.fromEntries(Object.entries(candidate).filter(([, value]) => value !== undefined)),
  );
  if (!parsed.success) {
    throw new Error(`Invalid PASEO_OIDC_* configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}
