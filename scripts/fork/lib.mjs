import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { parseForkTag } from "./version-utils.mjs";

export function repoRootFromModule(moduleUrl) {
  return path.resolve(path.dirname(new URL(moduleUrl).pathname), "..", "..");
}

export function run(command, args, options = {}) {
  return execFileSync(command, args, {
    stdio: "inherit",
    ...options,
  });
}

export function capture(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

export function git(root, args, options = {}) {
  return capture("git", args, { cwd: root, ...options });
}

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function readState(root) {
  return readJson(path.join(root, ".fork", "state.json"));
}

export function writeState(root, state) {
  writeJson(path.join(root, ".fork", "state.json"), state);
}

export function readRootVersion(root) {
  return readJson(path.join(root, "package.json")).version;
}

export function applyVersion(root, version) {
  const rootPackagePath = path.join(root, "package.json");
  const rootPackage = readJson(rootPackagePath);
  rootPackage.version = version;
  writeJson(rootPackagePath, rootPackage);

  run(process.execPath, ["scripts/sync-workspace-versions.mjs"], { cwd: root });
  updateLockfileVersion(root, version);

  const workspaceVersions = readJson(path.join(root, "package.json")).workspaces.map(
    (workspacePath) => readJson(path.join(root, workspacePath, "package.json")).version,
  );
  const mismatched = workspaceVersions.filter((workspaceVersion) => workspaceVersion !== version);
  if (mismatched.length > 0) {
    throw new Error(`Workspace versions did not all move to ${version}`);
  }
}

// Update the lockfile in place instead of running `npm install --package-lock-only`.
// npm rewrites peer/optional metadata across the whole tree on every run, which
// buries the version change in hundreds of unrelated lines and creates merge
// conflicts with every upstream sync.
function updateLockfileVersion(root, version) {
  const lockPath = path.join(root, "package-lock.json");
  const lock = readJson(lockPath);
  lock.version = version;
  if (lock.packages?.[""]) {
    lock.packages[""].version = version;
  }

  const workspacePaths = readJson(path.join(root, "package.json")).workspaces;
  const dependencySections = [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ];

  for (const workspacePath of workspacePaths) {
    const workspacePackage = readJson(path.join(root, workspacePath, "package.json"));
    const lockEntry = lock.packages?.[workspacePath];
    if (!lockEntry) continue;

    lockEntry.version = version;
    const internalDepRange = workspacePackage.private === true ? "*" : version;
    for (const section of dependencySections) {
      const dependencies = lockEntry[section];
      if (!dependencies) continue;
      for (const name of Object.keys(dependencies)) {
        if (name.startsWith("@getpaseo/") && name !== workspacePackage.name) {
          dependencies[name] = internalDepRange;
        }
      }
    }
  }

  writeJson(lockPath, lock);
}

export function assertCleanWorktree(root, { allowStaged = false } = {}) {
  const status = git(root, ["status", "--porcelain"]);
  if (status.length === 0) return;

  const lines = status.split("\n");
  const disallowed = allowStaged ? lines.filter((line) => !/^[MADRC] /.test(line)) : lines;
  if (disallowed.length > 0) {
    throw new Error(
      `Working tree is not clean:\n${disallowed.join("\n")}\nCommit or stash these changes first.`,
    );
  }
}

export function currentBranch(root) {
  return git(root, ["branch", "--show-current"]);
}

export function hasUnmergedPaths(root) {
  return git(root, ["diff", "--name-only", "--diff-filter=U"]).length > 0;
}

export function mergeHeadExists(root) {
  try {
    git(root, ["rev-parse", "--verify", "MERGE_HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Next fork build number. Counts every `fork-v*-fork.N` tag, across upstream
 * bases, not just the current base: Android derives versionCode from the base
 * version alone, so a per-base counter restarting at 1 produces a lower
 * versionCode than the last beta fork build of the same base and the install
 * is refused as a downgrade.
 */
export function nextForkNumber(root) {
  let highest = 0;
  for (const tag of listForkTags(root)) {
    try {
      highest = Math.max(highest, parseForkTag(tag).buildNumber);
    } catch {
      // Ignore malformed tags that happen to share the prefix.
    }
  }
  return highest + 1;
}

export function listForkTags(root) {
  const output = git(root, ["tag", "--list", "fork-v*"]);
  return output.length === 0 ? [] : output.split("\n").filter(Boolean);
}

export function commitAll(root, message) {
  run("git", ["add", "-A"], { cwd: root });
  run("git", ["commit", "--no-verify", "-m", message], { cwd: root });
}

export function tagRelease(root, version, message) {
  run("git", ["tag", "-a", `fork-v${version}`, "-m", message], { cwd: root });
}
