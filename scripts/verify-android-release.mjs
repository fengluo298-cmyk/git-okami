import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apk = process.argv[2] ? resolve(process.argv[2]) : join(repoRoot, "mobile", "android", "app", "build", "outputs", "apk", "release", "app-release.apk");
if (!existsSync(apk)) fail(`APK not found: ${apk}`);

const appConfig = JSON.parse(readFileSync(join(repoRoot, "mobile", "app.json"), "utf8")).expo;
const expectedPackage = appConfig.android.package;
const expectedVersionCode = String(appConfig.android.versionCode);
const expectedVersionName = appConfig.version;

const apksigner = findBuildTool("apksigner");
const aapt2 = findBuildTool("aapt2");
const jar = findJar();

const signature = run(apksigner, ["verify", "--print-certs", apk]);
if (/Android Debug/i.test(signature)) fail("APK is signed with the Android Debug certificate");

const badging = run(aapt2, ["dump", "badging", apk]);
const packageMatch = badging.match(/package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/);
if (!packageMatch) fail("Could not read APK package metadata");
const [, actualPackage, actualVersionCode, actualVersionName] = packageMatch;
if (actualPackage !== expectedPackage) fail(`Package mismatch: ${actualPackage} !== ${expectedPackage}`);
if (actualVersionCode !== expectedVersionCode) fail(`versionCode mismatch: ${actualVersionCode} !== ${expectedVersionCode}`);
if (actualVersionName !== expectedVersionName) fail(`versionName mismatch: ${actualVersionName} !== ${expectedVersionName}`);

const files = run(jar, ["tf", apk]);
if (!files.includes("assets/index.android.bundle")) fail("APK does not contain assets/index.android.bundle");
for (const pattern of [/\.env(\.|$)/i, /\.jks$/i, /\.keystore$/i, /passwords?\.txt$/i, /(^|\/)(__tests__|test)\//i, /secret/i]) {
  if (pattern.test(files)) fail(`APK contains forbidden file pattern: ${pattern}`);
}

const manifest = run(aapt2, ["dump", "xmltree", "--file", "AndroidManifest.xml", apk]);
if (/android:debuggable[^\n]*0xffffffff/i.test(manifest) || /android:debuggable[^\n]*true/i.test(manifest)) fail("Release manifest has android:debuggable=true");
if (/android:usesCleartextTraffic[^\n]*0xffffffff/i.test(manifest) || /android:usesCleartextTraffic[^\n]*true/i.test(manifest)) fail("Release manifest allows cleartext traffic");

console.log(JSON.stringify({ ok: true, apk, package: actualPackage, versionCode: actualVersionCode, versionName: actualVersionName, signed: true, bundle: true, debuggable: false, cleartextTraffic: false }, null, 2));

function run(command, args) {
  const result =
    process.platform === "win32" && command.toLowerCase().endsWith(".bat")
      ? spawnSync("cmd.exe", ["/d", "/c", command, ...args], { encoding: "utf8" })
      : spawnSync(command, args, { encoding: "utf8" });
  if (result.error) fail(result.error.message);
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status !== 0) fail(output.trim() || `${command} failed`);
  return output;
}

function findBuildTool(name) {
  const home = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  const exeName = process.platform === "win32" ? (name === "apksigner" ? `${name}.bat` : `${name}.exe`) : name;
  if (!home) return exeName;
  const buildTools = join(home, "build-tools");
  if (!existsSync(buildTools)) return exeName;
  for (const version of readdirSync(buildTools).sort().reverse()) {
    const exe = join(buildTools, version, exeName);
    if (existsSync(exe)) return exe;
  }
  return exeName;
}

function findJar() {
  const javaHome = process.env.JAVA_HOME;
  const exeName = process.platform === "win32" ? "jar.exe" : "jar";
  if (javaHome) {
    const exe = join(javaHome, "bin", exeName);
    if (existsSync(exe)) return exe;
  }
  return exeName;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
