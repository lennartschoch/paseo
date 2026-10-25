import {
  assertCleanWorktree,
  currentBranch,
  git,
  nextForkNumber,
  readRootVersion,
  repoRootFromModule,
  run,
  tagRelease,
} from "./lib.mjs";
import { stripForkSuffix } from "./version-utils.mjs";

const root = repoRootFromModule(import.meta.url);

function parseArgs(argv) {
  const args = { push: false, forkRemote: "fork", branch: "main" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--push":
        args.push = true;
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
        process.stdout.write("Usage: node scripts/fork/cut-release.mjs [--push]\n");
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (currentBranch(root) !== args.branch) {
  throw new Error(
    `Check out ${args.branch} before cutting a release (currently on ${currentBranch(root)}).`,
  );
}
assertCleanWorktree(root);

run("git", ["fetch", args.forkRemote, "--tags"], { cwd: root });

const baseVersion = stripForkSuffix(readRootVersion(root));
const buildNumber = nextForkNumber(root);
const version = `${baseVersion}-fork.${buildNumber}`;

tagRelease(root, version, `Paseo fork ${version} (upstream ${baseVersion})`);

if (args.push) {
  run("git", ["push", args.forkRemote, args.branch], { cwd: root });
  run("git", ["push", args.forkRemote, `fork-v${version}`], { cwd: root });
}

process.stdout.write(
  [
    `Tagged fork version ${version} at ${git(root, ["rev-parse", "--short", "HEAD"])}.`,
    "No version commit was created; the release workflow applies the version at build time.",
    args.push
      ? `Pushed ${args.forkRemote}/${args.branch} and tag fork-v${version}. GitHub Actions builds it.`
      : `Review and push with:\n  git push ${args.forkRemote} ${args.branch} && git push ${args.forkRemote} fork-v${version}`,
    "",
  ].join("\n"),
);
