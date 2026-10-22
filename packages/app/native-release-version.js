const versionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?(?:-fork\.(\d+))?$/;
const stableIosBuildSlot = 999;
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
    if (!Number.isSafeInteger(forkNumber) || forkNumber < 1 || forkNumber > 999) {
      throw new Error(`Fork build number must be between 1 and 999: ${version}`);
    }
    // Base version code times 1000 plus the per-base fork number. The base
    // component rises with every upstream release, so the fork code stays
    // monotonic across bases without a global counter.
    const forkVersionCode = versionCode * 1_000 + forkNumber;
    if (forkVersionCode * 10 + 9 > 2_100_000_000) {
      throw new Error(`Fork Android versionCode is out of range: ${forkVersionCode}`);
    }
    return {
      appVersion: `${major}.${minor}.${patch}`,
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
