import { BrowserWindow } from "electron";

// FORK(oidc): first-class OIDC sign-in for direct connections. See .fork/README.md.
//
// The renderer origin is paseo://app, so the provider cannot redirect back into
// it. Instead the login page runs in its own window and the redirect to the
// registered redirect URI is caught before it loads. The persistent partition
// keeps the provider's session cookie, so a second sign-in is usually one click.

const OIDC_PARTITION = "persist:paseo-oidc";

export type OidcAuthorizeResult =
  | { status: "completed"; callbackUrl: string }
  | { status: "cancelled" };

function readArgs(args: Record<string, unknown> | undefined): { url: URL; redirectUri: string } {
  const rawUrl = args?.url;
  const redirectUri = args?.redirectUri;
  if (typeof rawUrl !== "string" || typeof redirectUri !== "string" || redirectUri.length === 0) {
    throw new Error("oidc_authorize requires url and redirectUri");
  }
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("oidc_authorize only opens http(s) authorization URLs");
  }
  return { url, redirectUri };
}

export function authorizeOidcInWindow(
  args: Record<string, unknown> | undefined,
): Promise<OidcAuthorizeResult> {
  const { url, redirectUri } = readArgs(args);
  return new Promise((resolve) => {
    let settled = false;
    const parent = BrowserWindow.getFocusedWindow() ?? undefined;
    const window = new BrowserWindow({
      width: 520,
      height: 720,
      parent,
      modal: false,
      autoHideMenuBar: true,
      title: "Sign in",
      webPreferences: {
        partition: OIDC_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    function finish(result: OidcAuthorizeResult): void {
      if (settled) return;
      settled = true;
      resolve(result);
      if (!window.isDestroyed()) window.close();
    }

    function capture(event: { preventDefault: () => void }, target: string): void {
      // Exact match up to the query: the redirect URI names the daemon address.
      if (target.split(/[?#]/)[0] !== redirectUri) return;
      event.preventDefault();
      finish({ status: "completed", callbackUrl: target });
    }

    window.webContents.on("will-redirect", (event) => capture(event, event.url));
    window.webContents.on("will-navigate", (event) => capture(event, event.url));
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.on("closed", () => finish({ status: "cancelled" }));
    void window.loadURL(url.toString()).catch(() => {
      // A caught redirect aborts the load; anything else leaves the window open
      // with Chromium's error page so the user can see what failed.
    });
  });
}
