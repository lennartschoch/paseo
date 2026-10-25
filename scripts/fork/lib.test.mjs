import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { nextForkNumber } from "./lib.mjs";

function gitRepo(tags) {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-fork-lib-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Fork test");
  writeFileSync(path.join(root, "file.txt"), "fixture\n");
  git("add", "file.txt");
  git("commit", "-m", "fixture");
  for (const tag of tags) git("tag", tag);
  return root;
}

test("next fork number counts builds across every upstream base", () => {
  const root = gitRepo([
    "fork-v0.12.0-fork.1",
    "fork-v0.13.0-beta.2-fork.3",
    "fork-v0.13.0-fork.2",
    "v0.13.0",
    "backup-fork-v0.13.0-beta.1-fork.1",
  ]);
  try {
    // The high-water mark is the highest build number anywhere, not the highest
    // for the base being released, so a stable build cannot land below the last
    // beta build of the same base and be refused by Android as a downgrade.
    assert.equal(nextForkNumber(root), 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("next fork number starts at one with no fork tags", () => {
  const root = gitRepo(["v0.13.0"]);
  try {
    assert.equal(nextForkNumber(root), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("next fork number ignores tags that are not fork releases", () => {
  const root = gitRepo(["fork-v0.13.0-fork.7", "fork-v-nonsense", "fork-v0.14.0-fork.x"]);
  try {
    assert.equal(nextForkNumber(root), 8);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
