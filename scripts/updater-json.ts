// Builds the updater's latest.json from the updater bundles and their .sig files on a GitHub Release, in the same shape
// tauri-action writes (src/upload-version-json.ts in tauri-apps/tauri-action v1.0.0). The release workflow builds the
// three platforms in parallel with tauri-action's own latest.json turned off (uploadUpdaterJson: false), and a last
// job runs this once all of them have uploaded (docs/release.md)
//
//   bun scripts/updater-json.ts <tag> <out dir>     writes <out dir>/latest.json for the release (a draft too)
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ReleaseAsset = { name: string; apiUrl: string };
export type UpdaterPlatform = { signature: string; url: string };
export type LatestJson = {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, UpdaterPlatform>;
};

type Bundle = { os: "darwin" | "windows" | "linux"; bundle: string; suffix: string; priority: number };

// The updater bundles tauri-action knows, by how their file name ends. priority picks the bundle that also gets the
// plain `{os}-{arch}` key, as tauri-action does: the AppImage on Linux, the .msi before NSIS on Windows
// (updaterJsonPreferNsis is off)
const BUNDLES: Bundle[] = [
  { os: "darwin", bundle: "app", suffix: ".app.tar.gz", priority: 0 },
  { os: "windows", bundle: "msi", suffix: ".msi", priority: 100 },
  { os: "windows", bundle: "nsis", suffix: "-setup.exe", priority: 99 },
  { os: "linux", bundle: "appimage", suffix: ".AppImage", priority: 100 },
  { os: "linux", bundle: "deb", suffix: ".deb", priority: 0 },
  { os: "linux", bundle: "rpm", suffix: ".rpm", priority: 0 },
];
const OS_ORDER = ["darwin", "windows", "linux"] as const;

function normalizeArch(arch: string): string {
  if (arch === "amd64" || arch === "x86_64" || arch === "x64") return "x86_64";
  if (arch === "x86" || arch === "i386") return "i686";
  if (arch === "arm" || arch === "armhf") return "armv7";
  if (arch === "arm64") return "aarch64";
  return arch;
}

// `<name>_<version>_<arch><suffix>`; the .msi has a language after the arch (`_x64_en-US.msi`)
function archOf(fileName: string, suffix: string): string {
  const parts = fileName.slice(0, -suffix.length).split("_");
  const last = parts.at(-1) ?? "";
  return suffix === ".msi" && /^[a-z]{2}-[A-Z]{2}$/.test(last) ? (parts.at(-2) ?? "") : last;
}

/**
 * The latest.json for one release. `signatures` maps each .sig file name on the release to its contents; every .sig
 * has to belong to an updater bundle on the release, so a new kind of bundle stops the build instead of going missing
 */
export function buildLatestJson(input: {
  version: string;
  notes?: string;
  pubDate: string;
  assets: ReleaseAsset[];
  signatures: Record<string, string>;
}): LatestJson {
  const entries = Object.entries(input.signatures).map(([sigName, signature]) => {
    const fileName = sigName.replace(/\.sig$/, "");
    const kind = BUNDLES.find((b) => fileName.endsWith(b.suffix));
    if (!sigName.endsWith(".sig") || !kind) throw new Error(`not an updater signature: ${sigName}`);
    const asset = input.assets.find((a) => a.name === fileName);
    if (!asset) throw new Error(`no asset on the release for ${sigName}`);
    return { ...kind, arch: normalizeArch(archOf(fileName, kind.suffix)), signature, url: asset.apiUrl };
  });

  const platforms: Record<string, UpdaterPlatform> = {};
  for (const os of OS_ORDER) {
    const ofOs = entries.filter((e) => e.os === os).sort((a, b) => b.priority - a.priority);
    ofOs.forEach((e, idx) => {
      const value = { signature: e.signature, url: e.url };
      // A universal macOS build serves both Apple Silicon and Intel
      const universal = os === "darwin" && e.arch === "universal";
      if (idx === 0) {
        if (universal) {
          platforms["darwin-aarch64"] = value;
          platforms["darwin-x86_64"] = value;
        }
        platforms[`${os}-${e.arch}`] = value;
      }
      if (universal) {
        platforms["darwin-aarch64-app"] = value;
        platforms["darwin-x86_64-app"] = value;
      }
      platforms[`${os}-${e.arch}-${e.bundle}`] = value;
    });
  }
  return { version: input.version, notes: input.notes ?? "", pub_date: input.pubDate, platforms };
}

// Every release has to update these; a job that didn't upload its bundle fails the workflow here
export const REQUIRED_PLATFORMS = ["darwin-aarch64", "darwin-x86_64", "windows-x86_64", "linux-x86_64"];

function gh(args: string[]): string {
  const r = Bun.spawnSync(["gh", ...args], { stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error(`gh ${args.join(" ")} exited with ${r.exitCode}`);
  return r.stdout.toString();
}

if (import.meta.main) {
  const [tag, outDir] = process.argv.slice(2);
  if (!tag || !outDir) {
    console.error("usage: bun scripts/updater-json.ts <tag> <out dir>");
    process.exit(2);
  }
  const assets = (JSON.parse(gh(["release", "view", tag, "--json", "assets"])) as { assets: ReleaseAsset[] }).assets;
  const sigDir = join(outDir, "sig");
  mkdirSync(sigDir, { recursive: true });
  gh(["release", "download", tag, "-D", sigDir, "-p", "*.sig", "--clobber"]);
  const signatures = Object.fromEntries(readdirSync(sigDir).map((f) => [f, readFileSync(join(sigDir, f), "utf8")]));

  const latest = buildLatestJson({
    version: tag.replace(/^v/, ""),
    pubDate: new Date().toISOString(),
    assets,
    signatures,
  });
  const missing = REQUIRED_PLATFORMS.filter((p) => !latest.platforms[p]);
  if (missing.length > 0) {
    console.error(`latest.json is missing ${missing.join(", ")}`);
    process.exit(1);
  }
  writeFileSync(join(outDir, "latest.json"), JSON.stringify(latest, null, 2));
  console.log(`latest.json for ${tag}: ${Object.keys(latest.platforms).join(", ")}`);
}
