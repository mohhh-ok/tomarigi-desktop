// The release workflow builds latest.json itself after all platforms are uploaded (docs/release.md), so it has to come
// out exactly as tauri-action made it. The fixture is v0.15.3 as released: its assets, the .sig files on it, and the
// latest.json tauri-action wrote
import { describe, expect, test } from "bun:test";
import { buildLatestJson, REQUIRED_PLATFORMS, type LatestJson, type ReleaseAsset } from "../scripts/updater-json.ts";
import fixture from "./fixtures/release-v0.15.3-updater.json";

const release = fixture as { assets: ReleaseAsset[]; signatures: Record<string, string>; latest: LatestJson };

describe("buildLatestJson", () => {
  test("matches the latest.json tauri-action wrote for v0.15.3, key order included", () => {
    const built = buildLatestJson({
      version: "0.15.3",
      pubDate: release.latest.pub_date,
      assets: release.assets,
      signatures: release.signatures,
    });
    expect(JSON.stringify(built, null, 2)).toBe(JSON.stringify(release.latest, null, 2));
    for (const p of REQUIRED_PLATFORMS) expect(built.platforms[p]).toBeDefined();
  });

  test("a .sig without its bundle on the release stops the build", () => {
    const assets = release.assets.filter((a) => !a.name.endsWith(".AppImage"));
    expect(() =>
      buildLatestJson({ version: "0.15.3", pubDate: "", assets, signatures: release.signatures }),
    ).toThrow("no asset on the release");
  });

  test("an unknown kind of signed file stops the build", () => {
    expect(() =>
      buildLatestJson({
        version: "0.15.3",
        pubDate: "",
        assets: [{ name: "x_0.15.3_x64.zip", apiUrl: "u" }],
        signatures: { "x_0.15.3_x64.zip.sig": "s" },
      }),
    ).toThrow("not an updater signature");
  });

  test("a missing platform is left out, so the required check can catch it", () => {
    const signatures = Object.fromEntries(
      Object.entries(release.signatures).filter(([name]) => !name.endsWith("-setup.exe.sig")),
    );
    const built = buildLatestJson({ version: "0.15.3", pubDate: "", assets: release.assets, signatures });
    expect(REQUIRED_PLATFORMS.filter((p) => !built.platforms[p])).toEqual(["windows-x86_64"]);
  });
});
