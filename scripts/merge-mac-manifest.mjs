import fs from "node:fs";
import { dump, load } from "js-yaml";
import { isMainModule } from "./is-main-module.mjs";

// electron-updater compares this with os.release(), which reports the Darwin
// kernel version. Darwin 22 is macOS 13 Ventura.
export const MACOS_MINIMUM_DARWIN_VERSION = "22.0.0";

// Last argument is the output path, everything before it is an input manifest.
// A single input is valid: a build that only ships one macOS architecture (the
// fork builds arm64 only) merges its manifest down to itself.
export function mergeMacManifest(manifestPaths, outputPath) {
  const manifests = manifestPaths.map((filePath) => load(fs.readFileSync(filePath, "utf8")));
  const files = manifests
    .flatMap((manifest) => manifest.files ?? [])
    .filter((file, index, all) => all.findIndex((entry) => entry.url === file.url) === index);
  const output = dump(
    { ...manifests[0], files, minimumSystemVersion: MACOS_MINIMUM_DARWIN_VERSION },
    { lineWidth: -1, noRefs: true },
  );
  fs.writeFileSync(outputPath, output);
  return output;
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const manifestPaths = args.slice(0, -1);
  const outputPath = args.at(-1);
  if (!outputPath || manifestPaths.length === 0) {
    throw new Error("Usage: node scripts/merge-mac-manifest.mjs <arm64.yml> [x64.yml] <out.yml>");
  }
  process.stdout.write(mergeMacManifest(manifestPaths, outputPath));
}
