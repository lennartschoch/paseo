import { describe, expect, it } from "vitest";

const {
  FDROID_ABI_VERSION_CODE_SUFFIXES,
  getFdroidVersionCodes,
  getNativeReleaseVersion,
} = require("./native-release-version");

describe("native release version", () => {
  it("reserves the final iOS build slot for a stable release", () => {
    expect(getNativeReleaseVersion("0.2.6")).toEqual({
      appVersion: "0.2.6",
      androidVersionCode: 2006,
      iosBuildNumber: "2006999",
    });
  });

  it("gives each beta a unique iOS build slot under the stable app version", () => {
    expect(getNativeReleaseVersion("0.2.6-beta.2")).toEqual({
      appVersion: "0.2.6",
      androidVersionCode: 2006,
      iosBuildNumber: "2006002",
    });
  });

  it("rejects beta numbers that consume the stable iOS build slot", () => {
    expect(() => getNativeReleaseVersion("0.2.6-beta.999")).toThrow(
      "iOS beta number must be between 1 and 998",
    );
  });

  it("publishes the full fork version as the native version name", () => {
    expect(getNativeReleaseVersion("0.13.0-fork.4")).toEqual({
      appVersion: "0.13.0-fork.4",
      androidVersionCode: 130_000_004,
      iosBuildNumber: "130000004999",
    });
  });

  it("orders a stable fork build above every beta fork build of the same base", () => {
    // The fork build number rises across upstream bases, so a stable build of
    // 0.13.0 outranks the last 0.13.0-beta.2 build instead of restarting below it.
    const beta = getNativeReleaseVersion("0.13.0-beta.2-fork.3");
    const stable = getNativeReleaseVersion("0.13.0-fork.4");
    expect(stable.androidVersionCode).toBeGreaterThan(beta.androidVersionCode);
    expect(Number(stable.iosBuildNumber)).toBeGreaterThan(Number(beta.iosBuildNumber));
    expect(stable.appVersion).not.toEqual(beta.appVersion);
  });

  it("keeps fork version codes above the base version codes around them", () => {
    const fork = getNativeReleaseVersion("0.13.0-fork.4");
    expect(fork.androidVersionCode).toBeGreaterThan(
      getNativeReleaseVersion("0.13.0").androidVersionCode,
    );
    expect(getNativeReleaseVersion("0.14.0-fork.5").androidVersionCode).toBeGreaterThan(
      fork.androidVersionCode,
    );
    expect(() => getNativeReleaseVersion("0.13.0-fork.0")).toThrow(
      "Fork build number must be between 1 and 9999",
    );
  });

  it("derives one F-Droid version code per published ABI", () => {
    expect(FDROID_ABI_VERSION_CODE_SUFFIXES).toEqual({
      "armeabi-v7a": 1,
      "arm64-v8a": 2,
      x86: 3,
      x86_64: 4,
    });
    expect(getFdroidVersionCodes("0.5.0")).toEqual([
      { abi: "armeabi-v7a", versionCode: 50001 },
      { abi: "arm64-v8a", versionCode: 50002 },
      { abi: "x86", versionCode: 50003 },
      { abi: "x86_64", versionCode: 50004 },
    ]);
  });
});
