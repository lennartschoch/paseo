import assert from "node:assert/strict";
import test from "node:test";
import {
  formatForkTag,
  formatForkVersion,
  isForkVersion,
  isStableUpstreamTag,
  isUpstreamReleaseTag,
  parseForkTag,
  parseForkVersion,
  stripForkSuffix,
} from "./version-utils.mjs";

test("formats a fork version from a stable upstream base", () => {
  assert.equal(formatForkVersion("0.12.0", 1), "0.12.0-fork.1");
});

test("formats a fork version from a beta upstream base", () => {
  assert.equal(formatForkVersion("0.13.0-beta.1", 7), "0.13.0-beta.1-fork.7");
});

test("parses fork versions", () => {
  assert.deepEqual(parseForkVersion("0.13.0-beta.1-fork.7"), {
    version: "0.13.0-beta.1-fork.7",
    baseVersion: "0.13.0-beta.1",
    buildNumber: 7,
  });
});

test("rejects an upstream version as a fork version", () => {
  assert.throws(() => parseForkVersion("0.13.0-beta.1"), /Unsupported fork version/);
  assert.equal(isForkVersion("0.13.0-beta.1"), false);
});

test("round-trips fork tags", () => {
  assert.equal(formatForkTag("0.13.0-beta.1-fork.2"), "fork-v0.13.0-beta.1-fork.2");
  assert.deepEqual(parseForkTag("refs/tags/fork-v0.13.0-beta.1-fork.2"), {
    version: "0.13.0-beta.1-fork.2",
    baseVersion: "0.13.0-beta.1",
    buildNumber: 2,
  });
});

test("accepts stable and beta upstream release tags", () => {
  assert.equal(isUpstreamReleaseTag("v0.12.0"), true);
  assert.equal(isUpstreamReleaseTag("v0.13.0-beta.1"), true);
  assert.equal(isUpstreamReleaseTag("v0.13.0-beta.1-fork.1"), false);
  assert.equal(isUpstreamReleaseTag("desktop-v0.12.0"), false);
});

test("only stable upstream tags are stable", () => {
  assert.equal(isStableUpstreamTag("v0.12.0"), true);
  assert.equal(isStableUpstreamTag("v0.13.0-beta.1"), false);
  assert.equal(isStableUpstreamTag("desktop-v0.12.0"), false);
});

test("strips a fork suffix", () => {
  assert.equal(stripForkSuffix("0.12.0-fork.9"), "0.12.0");
  assert.equal(stripForkSuffix("0.12.0"), "0.12.0");
});
