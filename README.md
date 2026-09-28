# tomarigi-desktop

<img width="1020" height="510" alt="desktop-garden CKGxXzrE_Z2my0rT" src="https://github.com/user-attachments/assets/1c105780-6db6-45a6-91ca-9784181f1bd3" />

A macOS app that watches your AI coding agent sessions (Claude Code / Codex) as birds in an always-on-top window. Each session gets its own bird in the Garden, so you can tell at a glance which one is working, which one is waiting for your reply, and which one is done. Click a bird to jump to the Ghostty pane where that Claude Code session is running.

- No hooks or config changes on the agent side. It only reads the transcripts under `~/.claude/projects` and `~/.codex/sessions`
- The "?" for sessions waiting on you, the speech bubble that summarizes the end of each turn, and voice readout work with optional BYOK keys (OpenAI / Anthropic / TypeSafe). Keys are stored in the macOS Keychain
- Requirements: macOS. Jumping to a pane works with Ghostty only

The design spec lives in docs/design.md.

## Build

```sh
bun install                   # prepare sets core.hooksPath to .githooks and enables the gitleaks pre-commit hook
bun run dev                   # run the dev app (tauri dev; also starts the vite dev server, bun run dev:web)
bun run build:verify          # verification .app (src-tauri/target/debug/bundle/macos/tomarigi-desktop (verify).app) with a greenish background. Signed with your local Apple Development certificate (scripts/build-verify.sh; override with APPLE_SIGNING_IDENTITY)
bun run tauri build --debug   # src-tauri/target/debug/bundle/macos/tomarigi-desktop.app
bun run tauri build           # release build. Put the resulting .app at /Applications/tomarigi-desktop.app
bun run gen:locales           # scripts/locales/*.mjs → public/_locales/*/messages.json (also runs in bun run build)
bun run verify:locales        # checks that all 43 locales have exactly the same keys
```

Distribution builds are made by CI when a `v*` tag is pushed (signed, notarized, attached to a draft GitHub Release). See docs/release.md.

The everyday build (/Applications), `bun run dev`, and `bun run build:verify` use different identifiers (`src-tauri/tauri.dev.conf.json` and `tauri.verify.conf.json` are layered with `--config`). Single-instance locking, settings, and window position are separate for each, so they can run side by side. Each one asks for Ghostty automation permission on first use. Agents that launch the app for verification should only launch the verify .app (so they don't stop the everyday build or dev).

`public/_locales` is generated. Don't edit it directly; write all 43 locales in scripts/locales/*.mjs and generate.

The dev server port is fixed at 4842 (HMR 4843) in `vite.config.ts` and `src-tauri/tauri.conf.json`.

Environment variables at launch (pass them when running the binary `Contents/MacOS/tomarigi-desktop` directly):

- `TOMARIGI_MOCK=1`: mock mode. Injects presets / JSON instead of real data
- `TOMARIGI_QUERY`: initial screen. Join `tab=perch` / `tab=events` / `settings=1` / `debug=1` / `preset=<id>` (initial mock preset; `preset=asking` shows the "?") / `scrollTo=<class name>` (scrolls the window to that element, e.g. `settings=1&scrollTo=window-mode`) with `&`
- `TOMARIGI_FOCUS_TEST="<config_dir>|<sessionId>|<return tty>"`: 3 seconds after launch, jumps to that session's Ghostty pane, then 1.5 seconds later jumps back to the return pane (logs `front=<tty>`)
- `TOMARIGI_MODE_TEST`: window mode self-test. `1` cycles standard → floating → standard → maximized → full screen → floating every 5 seconds; `normal` just switches to the standard window
- `TOMARIGI_IMPORT_KEY=<anthropic|openai|typesafe>`: saves the first line of stdin as that provider's API key (for checking without operating the settings screen by hand; only the length is logged)
- `TOMARIGI_KEY_BACKEND=webview`: stores keys in IndexedDB instead of the Keychain (for testing the IndexedDB → Keychain migration)

Where BYOK API keys are stored depends on the identifier (KeyStore in src-tauri/src/lib.rs). The everyday and verify builds use the macOS Keychain (item `<identifier>.byok`); dev uses IndexedDB. API calls that use keys are made from Rust.

Logs are appended to `/tmp/tomarigi-desktop/app-log.txt`.

The Rust tauri crates are pinned to 2.11.x to match `@tauri-apps/api` 2.11 on the npm side (`tauri build` stops on a major/minor mismatch).

## License

MIT (see LICENSE). The character images (`src/assets/`) were generated with OpenAI's gpt-image and are distributed under the same MIT license.
