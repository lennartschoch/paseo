---
name: fork-sync
description: Merge the newest upstream Paseo release (stable or beta) into the fork, cut a fork release, and report the GitHub release. Use when the daily fork sync schedule runs.
---

# Fork sync

The repository is `lennartschoch/paseo`. `origin` is upstream `getpaseo/paseo`; `fork` is this
repository. Read `.fork/README.md` for the release and update-feed design.

## Run the sync

From the fork checkout (normally `/home/agent/workspace/paseo`):

```bash
node scripts/fork/sync-upstream.mjs --push
```

The script fetches upstream tags, resolves the newest upstream release (stable or beta), merges it
into `main`, updates `.fork/state.json`, tags `fork-v<upstream>-fork.<n>`, and pushes the branch
and tag. The tag starts the `Fork Release` workflow.

Exit codes:

- `0` — synced and pushed, or upstream was already included. Report which.
- `2` — the merge has conflicts. Resolve them as described below, then continue.
- anything else — stop and report the error. Do not push a partial result.

## Resolve a conflict

1. Inspect `git status` and the conflicted files. `main` (HEAD) holds the fork's fixes; the
   incoming side is the upstream release.
2. Keep both sides unless they genuinely disagree. The fork-only patches in `.fork/README.md` are
   the files to protect:
   - `packages/desktop/electron-builder.yml` — publish owner/repo `lennartschoch/paseo` and
     `mac.notarize: false` (the fork has no Developer ID; upstream's `notarize: true` would fail the
     macOS build)
   - `packages/app/native-release-version.js` — `-fork.N` handling and per-base versionCode
   - `packages/server/src/server/websocket-server.ts` — the `daemonVersion.includes("-fork.")`
     gate on `daemonSelfUpdate`
   - `.github/workflows/deploy-website.yml` — the `github.repository == 'getpaseo/paseo'` guard
   - `.github/workflows/fork-release.yml`, `scripts/fork/`, `.fork/state.json`
3. Run checks before continuing:
   ```bash
   npm run format
   npm run typecheck
   ```
   Run the specific tests for the conflicted area, not the full suite.
4. Stage the resolved files, then finish the merge, tag, and push:
   ```bash
   git add -A
   node scripts/fork/sync-upstream.mjs --continue --tag <upstream-tag> --push
   ```

## Verify the release

The tag push starts the build; the workflow takes 30–60 minutes.

```bash
gh run list --repo lennartschoch/paseo --workflow fork-release.yml --limit 3
gh release view fork-v<version> --repo lennartschoch/paseo --json isDraft,isPrerelease,assets
```

The release stays draft until Linux, macOS (arm64 only), Android, and the daemon all succeed. If
a job fails, read that job's log. Fix the cause and re-run the workflow for the same tag; never
reuse a version for a changed build.

Report: upstream tag and commit, fork version and tag, release URL, whether it is a prerelease,
and any platform that failed.

## If there is no new upstream release

The script exits `0` with `Upstream <tag> is already part of main; nothing to do.` Report that and
stop. Do not cut a release just to have one.

## Fork-only release

If `main` has fixes that need to ship without an upstream merge:

```bash
node scripts/fork/cut-release.mjs --push
```

This tags another `-fork.<n>` build of the current upstream base. Use it deliberately, not as a
retry for a failed build.
