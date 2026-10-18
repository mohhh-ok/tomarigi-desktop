# Release

Pushing a `v*` tag runs `.github/workflows/release.yml`. It builds a universal (Apple Silicon + Intel) .app and .dmg, signs them with the Developer ID certificate, notarizes them, and attaches them to a draft GitHub Release. Publish the draft by hand after checking it.

## Cutting a release

1. Set the same version in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `vscode-extension/package.json` (the workflow stops if any of them differ from the tag). Run `cargo metadata --manifest-path src-tauri/Cargo.toml --format-version 1 > /dev/null` so `src-tauri/Cargo.lock` picks up the new version, and commit it too
2. Commit, then `git tag v<version>` and `git push origin v<version>`
3. When the workflow finishes (about 8–13 minutes), verify the .dmg as below, write release notes on the draft, and publish

## Verifying the .dmg

The workflow notarizes the .app (tauri-action) and then the .dmg itself (a separate step, since tauri-action only notarizes the .app). Check both on the downloaded file:

```sh
gh release download v<version> -R mohhh-ok/tomarigi-desktop -D /tmp/tomarigi-desktop/release-v<version> -p '*.dmg'
D=/tmp/tomarigi-desktop/release-v<version>/tomarigi-desktop_<version>_universal.dmg
xcrun stapler validate "$D"                                        # "The validate action worked!"
spctl -a -vv -t open --context context:primary-signature "$D"     # accepted, source=Notarized Developer ID
M=$(hdiutil attach -nobrowse -readonly "$D" | awk -F'\t' '/Volumes/{print $NF}')
spctl -a -vv "$M/tomarigi-desktop.app"                            # accepted, source=Notarized Developer ID
codesign -d --entitlements - "$M/tomarigi-desktop.app" 2>&1 | grep apple-events
lipo -archs "$M/tomarigi-desktop.app/Contents/MacOS/tomarigi-desktop"   # x86_64 arm64
hdiutil detach "$M"
```

## Repository secrets

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | The "Developer ID Application" certificate exported from Keychain Access as .p12, base64 encoded (`openssl base64 -A -in cert.p12`) |
| `APPLE_CERTIFICATE_PASSWORD` | The password set when exporting the .p12. Make sure it has no trailing newline (pasting from `pbcopy < file` can include one) |
| `APPLE_SIGNING_IDENTITY` | The certificate name, e.g. `Developer ID Application: <name> (<team id>)` (`security find-identity -v -p codesigning`) |
| `KEYCHAIN_PASSWORD` | Any string. Used for the temporary keychain on the runner |
| `APPLE_ID` | The Apple ID email of the developer account |
| `APPLE_PASSWORD` | An app-specific password for that Apple ID (account.apple.com → Sign-In and Security → App-Specific Passwords) |
| `APPLE_TEAM_ID` | The team ID (developer.apple.com → Membership details) |

The Developer ID Application certificate can only be created by the Account Holder of the developer account (developer.apple.com → Certificates → +). The Apple Development certificate used by `bun run build:verify` can't be used for distribution.

## Signing and Apple Events

Notarization requires the hardened runtime (Tauri enables it by default). The hardened runtime blocks Apple Events unless the app has the `com.apple.security.automation.apple-events` entitlement, so `src-tauri/Entitlements.plist` sets it (`bundle.macOS.entitlements` in `tauri.conf.json`). Without it, jumping to a terminal pane fails (Ghostty, iTerm2, and Terminal.app are driven by Apple Events).

## The VS Code extension

The `vsix` job in the same workflow runs the extension's tests (unit tests, then the integration test inside a downloaded VS Code under `xvfb-run`), builds `tomarigi-v<version>.vsix`, and attaches it to the same draft release. To build it locally: `cd vscode-extension && bun install && bun run package` (writes `vscode-extension/tomarigi.vsix`). `bun run test:integration` opens a VS Code window, so run it on a machine where that is fine.

Not published to a marketplace yet; both need the user's own accounts. The extension ID is `publisher` + `name` in `vscode-extension/package.json` (`mohtech.tomarigi`); it is the authority of the URI Tomarigi opens, and the publisher on each marketplace must be the same string.

VS Code Marketplace (VS Code) — https://code.visualstudio.com/api/working-with-extensions/publishing-extension
1. Sign in to https://marketplace.visualstudio.com/manage with a Microsoft account and create a publisher whose ID is the `publisher` in `vscode-extension/package.json` (the ID can't be changed later)
2. Make a token: an Azure DevOps personal access token with the scope Marketplace → Manage and organization "All accessible organizations". The page says global PATs are retired on December 1, 2026 and recommends Microsoft Entra ID (`vsce publish --azure-credential`) instead; check the page before setting this up
3. `cd vscode-extension && bunx vsce login <publisher>`, then `bunx vsce publish --packagePath tomarigi-v<version>.vsix` (or upload the .vsix on the publisher management page)

Open VSX (Cursor, Windsurf, VSCodium and other forks) — https://github.com/eclipse/openvsx/wiki/Publishing-Extensions
1. Log in to https://open-vsx.org with GitHub, link an eclipse.org account ("Log in with Eclipse" on the profile page), and agree to the Publisher Agreement
2. Make an access token in the account settings
3. Once: `bunx ovsx create-namespace <publisher> -p <token>`. Each release: `bunx ovsx publish tomarigi-v<version>.vsix -p <token>`

When the extension is published, README can point to the marketplace instead of the .vsix on Releases.
