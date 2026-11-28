import { compare } from "bcryptjs";
import type { WSHelloMessage } from "@getpaseo/protocol/messages";
import { OWNER_PERMISSIONS } from "./authorization/index.js";
import { matchesLocalCredential } from "./local-credential.js";
import type { OidcVerifier } from "./oidc-auth.js";
import type { SessionAdmission } from "./websocket-server.js";

export type AdmissionFailure = "password_required" | "incorrect_password";

type AdmissionResolution = { admission: SessionAdmission } | { rejection: AdmissionFailure };

const OWNER_ADMISSION: SessionAdmission = { principalId: "owner", permissions: OWNER_PERMISSIONS };

export async function resolveSessionAdmission(input: {
  credential: WSHelloMessage["auth"];
  passwordHash: string | undefined;
  localCredential: string | null;
  // FORK(oidc): OIDC users are admitted as the owner, like the daemon password. See .fork/README.md.
  oidcVerifier?: OidcVerifier;
}): Promise<AdmissionResolution> {
  const { credential, passwordHash, localCredential, oidcVerifier } = input;
  if (!passwordHash && !oidcVerifier) {
    return { admission: OWNER_ADMISSION };
  }
  if (!credential) {
    return { rejection: "password_required" };
  }
  if (credential.kind === "localCredential") {
    if (localCredential && matchesLocalCredential(localCredential, credential.token)) {
      return { admission: OWNER_ADMISSION };
    }
    return { rejection: "incorrect_password" };
  }
  if (credential.kind === "oidc") {
    if (!oidcVerifier) return { rejection: "incorrect_password" };
    const verification = await oidcVerifier.verify(credential.token);
    return verification.ok ? { admission: OWNER_ADMISSION } : { rejection: "incorrect_password" };
  }
  if (!passwordHash) return { rejection: "incorrect_password" };
  return (await compare(credential.password, passwordHash))
    ? { admission: OWNER_ADMISSION }
    : { rejection: "incorrect_password" };
}
