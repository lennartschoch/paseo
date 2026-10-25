const versionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?(?:-fork\.(\d+))?$/;
const stableIosBuildSlot = 999;
const forkBuildSlots = 10_000;
const maxForkBuild = 9_999;
const FDROID_ABI_VERSION_CODE_SUFFIXES = {
  "armeabi-v7a": 1,
  "arm64-v8a": 2,
  x86: 3,
  x86_64: 4,
};

function getNativeReleaseVersion(version) {
  const match = versionPattern.exec(version);
  if (!match) {
    throw new Error(`Cannot derive native release version from unsupported version: ${version}`);
  }

  const [, majorText, minorText, patchText, betaText, forkText] = match;
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);
  const betaNumber = betaText === undefined ? null : Number(betaText);
  const forkNumber = forkText === undefined ? null : Number(forkText);

  if (minor > 999 || patch > 999) {
    throw new Error(`Cannot derive collision-free native version from: ${version}`);
  }
  if (betaNumber !== null && (betaNumber < 1 || betaNumber >= stableIosBuildSlot)) {
    throw new Error(`iOS beta number must be between 1 and 998: ${version}`);
  }

  const versionCode = major * 1_000_000 + minor * 1_000 + patch;
  if (
    !Number.isSafeInteger(versionCode) ||
    versionCode <= 0 ||
    versionCode * 10 + 9 > 2_100_000_000
  ) {
    throw new Error(`Derived Android versionCode is out of range: ${versionCode}`);
  }

  if (forkNumber !== null) {
    if (!Number.isSafeInteger(forkNumber) || forkNumber < 1 || forkNumber > maxForkBuild) {
      throw new Error(`Fork build number must be between 1 and ${maxForkBuild}: ${version}`);
    }
    // Base version code times the fork build window plus the fork build number.
    // The `-beta.N` stage is deliberately absent: `0.13.0-beta.2` and `0.13.0`
    // share a base version code, so the fork build number has to order them,
    // which means it must keep rising across bases instead of restarting at 1.
    // See nextForkNumber() in scripts/fork/lib.mjs.
    const forkVersionCode = versionCode * forkBuildSlots + forkNumber;
    if (forkVersionCode * 10 + 9 > 2_100_000_000) {
      throw new Error(`Fork Android versionCode is out of range: ${forkVersionCode}`);
    }
    return {
      // The base version alone is the same string for every fork build of one
      // upstream release, and identical for a beta and the stable it preceded,
      // so fork builds publish the full version as the native version name.
      appVersion: version,
      androidVersionCode: forkVersionCode,
      iosBuildNumber: String(forkVersionCode * 1_000 + stableIosBuildSlot),
    };
  }

  const iosBuildSlot = betaNumber ?? stableIosBuildSlot;
  const iosBuildNumber = versionCode * 1_000 + iosBuildSlot;
  if (!Number.isSafeInteger(iosBuildNumber)) {
    throw new Error(`Derived iOS buildNumber is out of range: ${iosBuildNumber}`);
  }

  return {
    appVersion: `${major}.${minor}.${patch}`,
    androidVersionCode: versionCode,
    iosBuildNumber: String(iosBuildNumber),
  };
}

function getFdroidVersionCodes(version) {
  const { androidVersionCode } = getNativeReleaseVersion(version);
  return Object.entries(FDROID_ABI_VERSION_CODE_SUFFIXES).map(([abi, suffix]) => ({
    abi,
    versionCode: androidVersionCode * 10 + suffix,
  }));
}

module.exports = {
  FDROID_ABI_VERSION_CODE_SUFFIXES,
  getFdroidVersionCodes,
  getNativeReleaseVersion,
};
