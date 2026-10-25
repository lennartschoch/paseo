#!/usr/bin/env node
// Guard the one property every fork build has to keep: a later release has a
// higher native version code than the release before it. Android derives the
// version code from the upstream base and the fork build number, and the base
// drops the `-beta.N` stage, so a stable fork build of the same base as a beta
// it follows can otherwise code lower than that beta and refuse to install.
//
// Releases are ordered by tag date, because build numbers cut before they
// counted across bases repeat.

import { createRequire } from "node:module";

import { git, repoRootFromModule } from "./lib.mjs";
import { parseForkTag } from "./version-utils.mjs";

const root = repoRootFromModule(import.meta.url);
const require = createRequire(import.meta.url);
const { getNativeReleaseVersion } = require("../../packages/app/native-release-version.js");

function parseArgs(argv) {
  let tag = "";
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--tag") {
      tag = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!tag) tag = process.env.GITHUB_REF_NAME ?? "";
  if (!tag)
    throw new Error("Usage: node scripts/fork/check-version-order.mjs --tag fork-v<version>");
  return tag;
}

function versionCodeOf(parsed) {
  return getNativeReleaseVersion(parsed.version).androidVersionCode;
}

const tag = parseArgs(process.argv.slice(2));
const target = parseForkTag(tag);
const targetCode = versionCodeOf(target);

// Release order, oldest first. Tag date, not the build number: fork build
// numbers cut before they counted across bases repeat across upstream bases.
const chronology = git(root, [
  "for-each-ref",
  "--sort=creatordate",
  "--format=%(refname:short)",
  "refs/tags/fork-v*",
])
  .split("\n")
  .filter(Boolean);

const position = chronology.findIndex((candidate) => candidate.trim() === tag.trim());
if (position === -1) {
  throw new Error(`Tag ${tag} is not in this checkout; fetch tags before checking its version.`);
}

const earlier = chronology
  .slice(0, position)
  .map((candidate) => {
    try {
      return parseForkTag(candidate);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const stale = earlier
  .filter((other) => versionCodeOf(other) >= targetCode)
  .sort((a, b) => versionCodeOf(b) - versionCodeOf(a));

if (stale.length > 0) {
  const detail = stale
    .slice(0, 5)
    .map((other) => `${other.version} (${versionCodeOf(other)})`)
    .join(", ");
  throw new Error(
    `Fork version ${target.version} codes to Android versionCode ${targetCode}, which is not above ` +
      `earlier fork releases: ${detail}. Installing over them would be a downgrade.`,
  );
}

process.stdout.write(
  `${target.version}: versionCode ${targetCode}, above all ${earlier.length} earlier fork builds.\n`,
);
