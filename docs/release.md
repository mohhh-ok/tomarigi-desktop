# Release

Pushing a `v*` tag runs `.github/workflows/release.yml`. It builds a universal (Apple Silicon + Intel) .app and .dmg, signs them with the Developer ID certificate, notarizes them, and attaches them to a draft GitHub Release. After that job, the Windows installer (NSIS `.exe`, unsigned) and then the Linux packages (`.deb`, `.AppImage`) are built and attached to the same draft. Each job also attaches the updater bundles with their signatures and adds its platforms to `latest.json` on the draft (the Linux job waits for the Windows job so they don't overwrite each other's `latest.json`). Publish the draft by hand after checking it; the app's updater only sees a release once it is published (docs/design.md "Updates").

## Cutting a release

1. Set the same version in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `vscode-extension/package.json` (the workflow stops if any of them differ from the tag). Run `cargo metadata --manifest-path src-tauri/Cargo.toml --format-version 1 > /dev/null` so `src-tauri/Cargo.lock` picks up the new version, and commit it too
2. Commit, then `git tag v<version>` and `git push origin v<version>`
3. When the workflow finishes (about 8–13 minutes), verify the .dmg as below, write release notes on the draft, and publish

## Building without a release

To check that the macOS, Windows, Linux, and VS Code extension builds pass before cutting a tag, start the same workflow by hand. It runs the same jobs and build steps, but skips the version checks, signing, notarization, and everything that makes or uploads to a GitHub Release. The bundles are kept as workflow artifacts on the run instead (the .dmg is unsigned, so Gatekeeper blocks it; it is only for checking the build).

```sh
gh workflow run release.yml -R mohhh-ok/tomarigi-desktop --ref <branch>
gh run list -R mohhh-ok/tomarigi-desktop --workflow release.yml -L 1      # the run id
gh run watch <run id> -R mohhh-ok/tomarigi-desktop
gh run download <run id> -R mohhh-ok/tomarigi-desktop -D /tmp/tomarigi-desktop/ci-run-<run id>
```

Job permissions can't depend on the event, so a manual run's token also has `contents: write`; the steps that run on a manual run get no token or secrets, and checkout runs with `persist-credentials: false` so the token isn't left in `.git/config` for `bun install`, the build scripts, or the tests to read. The tag run doesn't need it there either: tauri-action and `gh release upload` get the token from their own `env`.

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
| `TAURI_SIGNING_PRIVATE_KEY` | The updater's private key (the file written by `bunx tauri signer generate -w <file>`), as is |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password of that key, with no trailing newline |

The Developer ID Application certificate can only be created by the Account Holder of the developer account (developer.apple.com → Certificates → +). The Apple Development certificate used by `bun run build:verify` can't be used for distribution.

### The updater key

The updater (docs/design.md "Updates") only installs bundles signed with the key whose public half is `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`. The tag run signs the macOS `.app.tar.gz`, the Windows `.exe`, and the Linux `.AppImage` / `.deb` with the two secrets above and writes their signatures into `latest.json` on the release. The manual run builds without updater bundles (`createUpdaterArtifacts: false` in its `--config`), since it gets no secrets.

The key and its password are also kept in Google Secret Manager, project `mycloud-56789`, as `tomarigi-desktop-updater-private-key` and `tomarigi-desktop-updater-private-key-password` (GitHub secrets can't be read back). To restore them into the repository secrets:

```sh
gcloud secrets versions access latest --secret=tomarigi-desktop-updater-private-key --project mycloud-56789 | gh secret set TAURI_SIGNING_PRIVATE_KEY -R mohhh-ok/tomarigi-desktop
gcloud secrets versions access latest --secret=tomarigi-desktop-updater-private-key-password --project mycloud-56789 | gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD -R mohhh-ok/tomarigi-desktop
```

If the key is lost, nothing installed can update itself again: a new key pair means a new public key in the app, which the versions already installed don't have, so every user would have to replace the app by hand once more. If the key leaks, anyone with it could sign an update the app would accept; make a new pair, ship it, and ask users to replace the app by hand.

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

## Windows and Linux

The Windows and Linux jobs run after the macOS job (`needs: release`), so the macOS job creates the draft and they add to it; Linux also runs after Windows, so the two don't update `latest.json` at once. They need no secrets other than the updater key. The Windows installer is not code-signed (docs/design.md "Platforms"), so SmartScreen warns on first run.

What has been checked without real machines (on a Mac): the Linux build, `cargo test`, and a launch under Xvfb in a Docker container (arm64, Debian bookworm; Garden, Perch, and the settings without Secret Service); the Windows build only as far as `cargo check --target x86_64-pc-windows-gnu` (rustup's windows-gnu std, zig as the C compiler, `llvm-rc` for the resources). Nothing below has been checked on a real Windows or Linux machine yet.

### Checks on a real Windows 10 / 11 (x64) machine

- [ ] The NSIS installer installs and the app starts; SmartScreen shows its warning and "Run anyway" works
- [ ] Floating window: transparent with Acrylic behind it, borderless, always on top, not in the taskbar; it stays above other windows after switching apps
- [ ] Fade until hovered: at rest clicks go through to the window below except on birds and the handle; clicking the handle shows the window; leaving the window fades it. Dragging a bird and dragging the window work while faded
- [ ] Clicking a bird while faded doesn't take focus from the terminal before the jump (the window is not focusable while faded); after the handle click, the settings inputs (API keys) can be typed in
- [ ] Standard window: title bar, can maximize, shows in the taskbar; switching back to floating restores the floating look and position
- [ ] Position and size are restored per mode after a restart, also with two displays and display scaling other than 100%
- [ ] Tray icon is visible on a dark and a light taskbar; left click shows / hides; the menu is in the system language (Japanese / English)
- [ ] Claude Code (native install) sessions under `%USERPROFILE%\.claude\projects` appear as birds, and birds of ended sessions are removed (`%USERPROFILE%\.claude\sessions\<pid>.json` exists on Windows)
- [ ] Codex sessions under `%USERPROFILE%\.codex\sessions` appear, and `thread-writer-locks\<threadId>.lock` is held open while codex runs (liveness through the Restart Manager). Check that a codex starting a new thread is not disturbed by Tomarigi's sharing check on the lock files
- [ ] Agents found by their process (Qwen Code, Copilot CLI, Gemini CLI, OpenCode, Cursor CLI): their processes are recognised from the command line (node-based CLIs run as `node.exe <script>`, whose script name may not be the agent's name)
- [ ] Jumping: clicking a bird brings the terminal window forward (Windows Terminal, PowerShell / cmd in conhost, VS Code); check that SetForegroundWindow is allowed (the log line `[focus] ... foreground=true`)
- [ ] API keys: saved to Credential Manager (`net.mohtech.tomarigi-desktop.byok`), kept after a restart, deleted from settings
- [ ] Readout speaks with the system voice
- [ ] "Save" in the debug log writes to `%USERPROFILE%\Downloads`; the app log is at `%TEMP%\tomarigi-desktop\app-log.txt` (Linux: `~/.local/state/tomarigi-desktop/app-log.txt`)
- [ ] The UI font is Segoe UI / Yu Gothic UI; Japanese text has no missing glyphs

### Checks on a real Linux (x64) machine

Check on GNOME (X11 and Wayland sessions) and KDE Plasma at least, with the `.deb` on Ubuntu 22.04 / 24.04 and the `.AppImage` on another distribution.

- [ ] The app starts from the `.deb` and the `.AppImage`; on a Wayland session it runs through Xwayland (`xprop` can click it)
- [ ] Floating window: transparent (with a compositor), borderless, always on top (window manager dependent), not in the taskbar, shown on every workspace
- [ ] Fade until hovered: click-through except on birds and the handle, the handle click shows the window, leaving fades it; dragging works
- [ ] Clicking a bird while faded doesn't take focus from the terminal; after the handle click, the settings inputs can be typed in
- [ ] Standard window and switching back; position and size restored per mode after a restart
- [ ] Tray icon is shown (GNOME needs the AppIndicator extension); the menu opens and "Show / Hide" works; menu language follows the system locale
- [ ] API keys: saved to GNOME Keyring / KWallet and kept after a restart; with no Secret Service running, the settings say keys can't be saved (no key rows are shown)
- [ ] Readout: speaks where WebKitGTK has speech synthesis; where it doesn't, the "Read aloud" checkbox is disabled with the note under it
- [ ] Jumping: in tmux the pane is selected and the terminal window comes forward; outside tmux the terminal window comes forward (GNOME Terminal, Konsole, Ghostty, kitty, Alacritty); on Wayland, native Wayland terminals can't be brought forward (the log says `no window of an ancestor`)
- [ ] Codex liveness through `/proc/<pid>/fd`; processes of agents without a pid file are found (`ps` from procps is needed)
- [ ] NVIDIA: no white window (if it happens, check `WEBKIT_DISABLE_DMABUF_RENDERER=1`; https://v2.tauri.app/develop/debug/linux-graphics/)
- [ ] Japanese text renders with Noto Sans CJK

