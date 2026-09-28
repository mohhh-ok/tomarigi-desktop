# Release

Pushing a `v*` tag runs `.github/workflows/release.yml`. It builds a universal (Apple Silicon + Intel) .app and .dmg, signs them with the Developer ID certificate, notarizes them, and attaches them to a draft GitHub Release. Publish the draft by hand after checking it.

## Cutting a release

1. Set the same version in `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` (the workflow stops if any of them differ from the tag)
2. Commit, then `git tag v<version>` and `git push origin v<version>`
3. When the workflow finishes, open the draft on the Releases page, check the .dmg, and publish

## Repository secrets

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | The "Developer ID Application" certificate exported from Keychain Access as .p12, base64 encoded (`openssl base64 -A -in cert.p12`) |
| `APPLE_CERTIFICATE_PASSWORD` | The password set when exporting the .p12 |
| `APPLE_SIGNING_IDENTITY` | The certificate name, e.g. `Developer ID Application: <name> (<team id>)` (`security find-identity -v -p codesigning`) |
| `KEYCHAIN_PASSWORD` | Any string. Used for the temporary keychain on the runner |
| `APPLE_ID` | The Apple ID email of the developer account |
| `APPLE_PASSWORD` | An app-specific password for that Apple ID (account.apple.com → Sign-In and Security → App-Specific Passwords) |
| `APPLE_TEAM_ID` | The team ID (developer.apple.com → Membership details) |

The Developer ID Application certificate can only be created by the Account Holder of the developer account (developer.apple.com → Certificates → +). The Apple Development certificate used by `bun run build:verify` can't be used for distribution.

## Signing and Apple Events

Notarization requires the hardened runtime (Tauri enables it by default). The hardened runtime blocks Apple Events unless the app has the `com.apple.security.automation.apple-events` entitlement, so `src-tauri/Entitlements.plist` sets it (`bundle.macOS.entitlements` in `tauri.conf.json`). Without it, jumping to a Ghostty pane fails.
