import { spawnSync } from "node:child_process";

import {
  assertCleanWorktree,
  capture,
  commitAll,
  currentBranch,
  git,
  hasUnmergedPaths,
  mergeHeadExists,
  nextForkNumber,
  readRootVersion,
  repoRootFromModule,
  run,
  tagRelease,
  writeState,
} from "./lib.mjs";
import { isUpstreamReleaseTag, stripForkSuffix } from "./version-utils.mjs";

const root = repoRootFromModule(import.meta.url);

function parseArgs(argv) {
  const args = {
    tag: "",
    continue: false,
    push: false,
    noRelease: false,
    upstreamRemote: "origin",
    forkRemote: "fork",
    branch: "main",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--tag":
        args.tag = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--continue":
        args.continue = true;
        break;
      case "--push":
        args.push = true;
        break;
      case "--no-release":
        args.noRelease = true;
        break;
      case "--upstream-remote":
        args.upstreamRemote = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--fork-remote":
        args.forkRemote = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--branch":
        args.branch = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--help":
      case "-h":
        process.stdout.write(
          "Usage: node scripts/fork/sync-upstream.mjs [--tag v0.13.0] [--push] [--continue] [--no-release]\n",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function isAncestor(tag, ref = "HEAD") {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", tag, ref], { cwd: root });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`Unable to compare ${tag} with ${ref}`);
}

function latestUpstreamReleaseTag() {
  try {
    const tag = capture(
      "gh",
      [
        "release",
        "list",
        "--repo",
        "getpaseo/paseo",
        "--limit",
        "1",
        "--json",
        "tagName",
        "--jq",
        ".[0].tagName",
      ],
      { cwd: root },
    );
    if (isUpstreamReleaseTag(tag)) return tag;
  } catch {
    // gh is optional; fall back to fetched tags.
  }

  const tags = git(root, ["tag", "--list", "v*", "--sort=-v:refname"])
    .split("\n")
    .filter(isUpstreamReleaseTag);
  if (tags.length === 0) {
    throw new Error("No upstream release tag found. Fetch origin with --tags first.");
  }
  return tags[0];
}

const args = parseArgs(process.argv.slice(2));

if (currentBranch(root) !== args.branch) {
  throw new Error(`Check out ${args.branch} before syncing (currently on ${currentBranch(root)}).`);
}

if (!args.continue) {
  assertCleanWorktree(root);
  run("git", ["fetch", args.upstreamRemote, "--tags", "--prune"], { cwd: root });
  run("git", ["pull", "--ff-only", args.forkRemote, args.branch], { cwd: root });
}

const tag = args.tag || latestUpstreamReleaseTag();
if (!isUpstreamReleaseTag(tag)) {
  throw new Error(
    `Refusing to sync ${tag}; expected an upstream release tag like v0.13.0(-beta.N).`,
  );
}

const upstreamCommit = git(root, ["rev-list", "-n", "1", tag]);

if (!args.continue && isAncestor(tag)) {
  process.stdout.write(`Upstream ${tag} is already part of ${args.branch}; nothing to do.\n`);
  process.exit(0);
}

if (!args.continue) {
  const merge = spawnSync("git", ["merge", "--no-ff", "--no-commit", tag], {
    cwd: root,
    stdio: "inherit",
  });
  if (merge.status !== 0) {
    const conflicts = git(root, ["diff", "--name-only", "--diff-filter=U"]);
    process.stderr.write(
      [
        `Merge of ${tag} stopped with conflicts:`,
        conflicts || "(no unmerged paths reported)",
        "",
        "Resolve the conflicts, stage the resolved files, then run:",
        `  node scripts/fork/sync-upstream.mjs --continue --tag ${tag}`,
        "",
      ].join("\n"),
    );
    process.exit(2);
  }
} else if (hasUnmergedPaths(root)) {
  throw new Error("Unmerged paths remain. Resolve and `git add` them first.");
}

// Record the upstream base. The fork version is applied by the release workflow,
// so main stays at the upstream release's version.
writeState(root, { upstreamTag: tag, upstreamCommit });

if (mergeHeadExists(root)) {
  run("git", ["add", "-A"], { cwd: root });
  run("git", ["commit", "--no-verify", "-m", `chore(fork): sync ${tag}`], { cwd: root });
} else {
  commitAll(root, `chore(fork): sync ${tag}`);
}

if (!isAncestor(tag)) {
  throw new Error(`${tag} is still not part of ${args.branch}; the merge is incomplete.`);
}

run("git", ["fetch", args.forkRemote, "--tags"], { cwd: root });

let version = "";
if (!args.noRelease) {
  const baseVersion = stripForkSuffix(readRootVersion(root));
  const buildNumber = nextForkNumber(root, baseVersion);
  version = `${baseVersion}-fork.${buildNumber}`;
  tagRelease(root, version, `Paseo fork ${version} (upstream ${tag})`);
}

if (args.push) {
  run("git", ["push", args.forkRemote, args.branch], { cwd: root });
  if (version) {
    run("git", ["push", args.forkRemote, `fork-v${version}`], { cwd: root });
  }
}

let nextStep;
if (args.push) {
  nextStep = version
    ? `Pushed ${args.forkRemote}/${args.branch} and tag fork-v${version}. GitHub Actions builds it.`
    : `Pushed ${args.forkRemote}/${args.branch}.`;
} else if (version) {
  nextStep = `Push with: git push ${args.forkRemote} ${args.branch} && git push ${args.forkRemote} fork-v${version}`;
} else {
  nextStep = `Push with: git push ${args.forkRemote} ${args.branch}`;
}

process.stdout.write(
  [
    `Merged ${tag} (${upstreamCommit.slice(0, 12)}) into ${args.branch}.`,
    version ? `Tagged fork release ${version}.` : "No release was cut (--no-release).",
    nextStep,
    "",
  ].join("\n"),
);
