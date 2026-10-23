# Paseo fork

This is `lennartschoch/paseo`, a fork that keeps the open upstream PRs applied and ships its own
desktop, daemon, and Android builds from GitHub Releases.

Upstream `getpaseo/paseo` is the `origin` remote. The fork is `fork`.

## Branches and tags

- `main` is the fork. It carries upstream stable releases plus the pending fixes and a small set
  of fork-only patches (release feed, version scheme, daemon updater gate).
- Upstream releases (`vX.Y.Z` and `vX.Y.Z-beta.N`) are merged into `main`. Never rebase `main`;
  the history is append-only so the fix commits stay reachable.
- `main` carries the upstream version. A fork version lives only in a tag, not in a version-bump
  commit. The release workflow applies it at build time.
- Fork releases are tagged `fork-v<base>-fork.<n>`, where `<n>` starts at 1 for every upstream
  base. Example: `0.12.0-fork.1`, then `0.13.0-fork.1` when upstream ships `v0.13.0`.
- The `fork-v` prefix is deliberate: upstream workflows trigger on `v*`, so a fork tag cannot
  start an upstream EAS, Docker, or release-notes run.

## Cutting a release

```bash
# Merge the newest upstream release (stable or beta) and tag a fork build.
node scripts/fork/sync-upstream.mjs --push

# Tag another build of the current base, for fork-only fixes or a rebuild.
node scripts/fork/cut-release.mjs --push
```

`sync-upstream` merges the newest upstream release, then tags `fork-v<upstream>-fork.<n>` and
pushes the branch and tag. `--no-release` merges without tagging. `cut-release` tags the current
`main` without an upstream merge.

Both commands only create a tag; neither commits a version. The tag starts
`.github/workflows/fork-release.yml`, and every build job runs
`node scripts/fork/apply-version.mjs --version "$FORK_VERSION"` before it builds, so the artifacts
carry the fork version while the tagged source stays at the upstream version.

## What the release workflow builds

| Job             | Output                                                                                |
| --------------- | ------------------------------------------------------------------------------------- |
| `daemon`        | `paseo-daemon-<version>.tar.gz` — bundled `@getpaseo/*` tarballs plus an `install.sh` |
| `desktop-linux` | AppImage, deb, rpm, tar.gz, and the `<channel>-linux.yml` manifest                    |
| `desktop-macos` | arm64 + x64 dmg/zip and the merged `<channel>-mac.yml` manifest                       |
| `android`       | `paseo-fork-<version>-android.apk`, its SHA256, and `latest-android.json`             |

Every build job applies the fork version from the tag before building. The release is created as
a draft and only published after every job succeeds. A failed platform
leaves the release as a draft; fix the build and re-run the workflow for that tag.

## Update feeds

- **Desktop** reads the fork's own GitHub releases. `packages/desktop/electron-builder.yml` sets
  the publish owner/repo to `lennartschoch/paseo`, so `app-update.yml` baked into the app points
  there.

  The updater channel follows the upstream base, not the `-fork.` suffix. When the base version is
  a prerelease (`0.13.0-beta.2`), `scripts/fork/release-env.mjs` marks the fork release as a GitHub
  prerelease and builds both desktop jobs on the `beta` channel, so the manifests are
  `beta-linux.yml` and `beta-mac.yml`. A stable base (`0.12.0`) uses `latest`. Both feed settings
  are baked in at build time, so an installed app only ever offers updates from its own channel:
  a beta fork build never updates to a stable fork build, or the reverse.

  Because a prerelease is not the repository's "Latest" release, link beta builds by tag.

- **Daemon** doesn't self-update on a fork. Fork builds advertise
  `features.daemonSelfUpdate: false`, because the upstream updater installs
  `@getpaseo/cli@latest` from npm and would replace the fork with upstream. Install daemon
  updates from the release asset:

  ```bash
  curl -LO https://github.com/lennartschoch/paseo/releases/download/fork-v<version>/paseo-daemon-<version>.tar.gz
  tar xzf paseo-daemon-<version>.tar.gz
  ./install.sh
  systemctl restart paseo.service
  ```

  `install.sh` passes its arguments to `npm install -g`, so `--prefix <dir>` works. The tarball
  contains the fork's seven `@getpaseo/*` packages; npm resolves the `@getpaseo` dependencies to
  the bundled tarballs and installs third-party dependencies normally. The packages are
  JavaScript plus prebuilt native modules, so one archive works on macOS and Linux.

- **Android** is sideloaded. `latest-android.json` points at the newest APK and carries the
  monotonic `versionCode`. Installing a new fork APK over the previous one works because every
  fork build shares the same debug signing key and increases `versionCode`.

## Signing

Apple notarization needs a paid Developer ID. Without one you can still sign with a **self-signed
certificate**: Squirrel.Mac accepts an update that satisfies the running app's designated
requirement, and a certificate you reuse for every build gives that requirement a stable leaf hash.

- **Self-signed, no Apple account:** create a Code Signing certificate in Keychain Access, export
  it as `.p12`, and add it as `APPLE_CERTIFICATE` with its password as
  `APPLE_CERTIFICATE_PASSWORD`. Leave `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID` unset; the
  workflow then signs without notarizing.
  - Trust the certificate on each Mac once: Keychain Access → import → **Always Trust**, or
    `security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db <cert>`.
  - Gatekeeper still blocks the first launch because the app is not notarized: right-click →
    **Open**, or `xattr -dr com.apple.quarantine /Applications/Paseo.app`.
  - Test two consecutive releases before relying on this. If Squirrel rejects the self-signed
    update, use the manual path below.
- **Developer ID:** add all five secrets (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`). The app is signed and notarized; first launch works
  normally and Squirrel updates work.
- **Unsigned:** no secrets. Gatekeeper bypass on every install, no auto-update.
- **Manual fallback:** download the new dmg, replace `/Applications/Paseo.app`, and
  `xattr -dr com.apple.quarantine /Applications/Paseo.app`. This always works without an Apple
  account; it just is not automatic.
- **Android** uses the debug keystore generated by `expo prebuild`. It is deterministic in the
  Expo template, so builds from the same template share a signing identity. Don't switch Expo
  templates without checking the keystore, or the next APK won't install over the old one.

## Daily sync on the agent machine

The schedule runs an agent with the `fork-sync` skill. The prompt:

```text
Run the fork-sync skill in /home/agent/workspace/paseo. Merge the newest upstream Paseo release
into fork main, resolve conflicts, run the checks, cut a fork release, and report the release URL.
If there is no new upstream release, say so and stop.
```

Create it with:

```bash
paseo schedule create \
  --name "Paseo fork sync" \
  --every 24h \
  --cwd /home/agent/workspace/paseo \
  "Run the fork-sync skill in /home/agent/workspace/paseo. Merge the newest upstream Paseo release into fork main, resolve conflicts, run the checks, cut a fork release, and report the release URL. If there is no new upstream release, say so and stop."
```

The sync script refuses to run on a dirty tree or a non-`main` branch, so it cannot quietly mix
with other agent work.

## Fork-only patches

Keep this list small; every entry is a merge conflict the next upstream sync may have to resolve.

| File                                             | Why                                                             |
| ------------------------------------------------ | --------------------------------------------------------------- |
| `packages/desktop/electron-builder.yml`          | Desktop update feed points at `lennartschoch/paseo`             |
| `packages/app/native-release-version.js`         | Accepts `-fork.N` and gives Android a monotonic versionCode     |
| `packages/server/src/server/websocket-server.ts` | Hides the npm-based daemon self-update on fork builds           |
| `.github/workflows/deploy-website.yml`           | Guards the upstream deploy job so a fork release doesn't run it |
| `.github/workflows/fork-release.yml`             | The fork release pipeline                                       |
| `scripts/fork/`                                  | Versioning, sync, and daemon packaging                          |
