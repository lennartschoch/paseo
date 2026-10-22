import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { readJson, readRootVersion, repoRootFromModule, run } from "./lib.mjs";

const root = repoRootFromModule(import.meta.url);
const version = readRootVersion(root);

function parseArgs(argv) {
  let outDir = path.join(root, "dist", "fork");
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") {
      outDir = path.resolve(argv[index + 1] ?? "");
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return outDir;
}

const outDir = parseArgs(process.argv.slice(2));
const workspaceRoots = readJson(path.join(root, "package.json")).workspaces;

// The daemon runtime graph. expo-two-way-audio and the private app/desktop
// workspaces are not part of it.
const daemonPackages = new Set([
  "@getpaseo/highlight",
  "@getpaseo/relay",
  "@getpaseo/protocol",
  "@getpaseo/client",
  "@getpaseo/plugin",
  "@getpaseo/server",
  "@getpaseo/cli",
]);
const packages = workspaceRoots
  .map((workspacePath) => readJson(path.join(root, workspacePath, "package.json")))
  .filter((pkg) => daemonPackages.has(pkg.name));

if (packages.length !== daemonPackages.size) {
  throw new Error("Not every @getpaseo daemon workspace was found");
}

const workDir = path.join(outDir, `.paseo-daemon-${version}`);
rmSync(workDir, { recursive: true, force: true });
const tarballDir = path.join(workDir, "tarballs");
mkdirSync(tarballDir, { recursive: true });

for (const pkg of packages) {
  run(
    "npm",
    [
      "pack",
      `--workspace=${pkg.name}`,
      "--pack-destination",
      tarballDir,
      "--ignore-scripts",
      "--silent",
    ],
    { cwd: root },
  );
}

const tarballs = readdirSync(tarballDir).filter((name) => name.endsWith(".tgz"));
if (tarballs.length !== packages.length) {
  throw new Error(`Expected ${packages.length} daemon tarballs, found ${tarballs.length}`);
}

writeFileSync(
  path.join(workDir, "install.sh"),
  [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'exec npm install -g "$here"/tarballs/*.tgz "$@"',
    "",
  ].join("\n"),
  { mode: 0o755 },
);

writeFileSync(
  path.join(workDir, "README.md"),
  [
    "# Paseo fork daemon",
    "",
    `Version ${version}.`,
    "",
    "Installs the fork's CLI and server packages together, so npm resolves the",
    "`@getpaseo/*` dependencies to the bundled tarballs instead of the registry.",
    "",
    "```bash",
    "tar xzf paseo-daemon-" + version + ".tar.gz",
    "./install.sh",
    "```",
    "",
    "Pass `--prefix <dir>` to install somewhere other than the global prefix.",
    "",
    "Builds for other platforms are not needed: these packages are JavaScript",
    "plus prebuilt native dependencies, and `npm install` resolves those for the",
    "host it runs on.",
    "",
  ].join("\n"),
);

const archiveName = `paseo-daemon-${version}.tar.gz`;
run("tar", ["-czf", path.join(outDir, archiveName), "-C", workDir, "."], { cwd: root });
rmSync(workDir, { recursive: true, force: true });

process.stdout.write(`${path.join(outDir, archiveName)}\n`);
