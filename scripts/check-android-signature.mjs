import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const artifact = process.argv[2];
if (!artifact || !existsSync(artifact)) {
  console.error("Usage: node scripts/check-android-signature.mjs <apk-or-aab>");
  process.exit(2);
}

const apksigner = findApksigner();
const result = spawnSync(apksigner, ["verify", "--print-certs", artifact], { encoding: "utf8", shell: process.platform === "win32" });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
process.stdout.write(output);
if (result.status !== 0) process.exit(result.status ?? 1);
if (/Android Debug/i.test(output)) {
  console.error("Release artifact is signed with Android Debug certificate.");
  process.exit(1);
}

function findApksigner() {
  const home = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!home) return "apksigner";
  const buildTools = join(home, "build-tools");
  if (!existsSync(buildTools)) return "apksigner";
  const versions = readdirSync(buildTools).sort().reverse();
  for (const version of versions) {
    const exe = join(buildTools, version, process.platform === "win32" ? "apksigner.bat" : "apksigner");
    if (existsSync(exe)) return exe;
  }
  return "apksigner";
}
