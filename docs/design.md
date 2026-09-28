# tomarigi-desktop design

A macOS app (Tauri 2) that watches AI coding agent sessions (Claude Code / Codex) as birds in an always-on-top floating window. It is the desktop version of the tomarigi Chrome extension.

## Scope

- Three tabs: Garden, Perch, and Recent activity (Garden is the default), plus the ⚙ settings screen
- Watches Claude Code / Codex transcripts in parallel through adapters. State is decided by local heuristics only; no hooks are installed on the agent side
- Bird states (sprites, aura while working, motion animations), drag placement in the Garden, and the nest
- Icon sets (birds / gnome / cat / robot / frog) assigned per project
- Web Audio chirps (mute, volume), speechSynthesis readout (opt-in, volume), BYOK (OpenAI / Anthropic) summaries on done and connection tests
- Persistent event history and a debug dialog
- i18n (generated from `scripts/locales` into `public/_locales`, with a check across 43 locales)
- Mock mode (presets + JSON injection)

## How the desktop app works

- Watched folders: files are read on the Rust side. The standard locations for Claude Code and Codex, `~/.claude/projects` and `~/.codex/sessions`, are always watched as defaults (the app supplies them on every launch; they are not written into the saved list). Other folders can be added from the settings screen (native folder picker), and only added folders can be removed. People who use a different config directory via `CLAUDE_CONFIG_DIR` add its `projects` folder
  - Defaults are listed first with a "Default" badge and no remove (×) button
  - Default folders that don't exist are neither watched nor listed
  - Labels can be edited for defaults too; default labels are stored separately
  - Entries saved by older versions' "auto-register on first launch" that match a default path are dropped on load (no double watching)
  - The path is shown under each label
  - There is no read-permission concept, so a missing or unreadable folder just gets an "unreadable" badge
- Window: a floating NSPanel (tauri-nspanel). Transparent, frameless, always on top, and shown above full-screen spaces too. It can be dragged from anywhere on its background, and its position and size are restored on the next launch. On first launch (no saved position, or the saved position isn't on any display) it goes to the top-right of the main display. The window has a shadow
- The app watches for as long as it runs. It stays out of the Dock and is controlled from the menu bar icon (left click toggles show/hide, right click opens the menu). Menu text is Japanese when the system language is Japanese, English otherwise
- The × at the right end of the header hides the window (bring it back from the menu bar icon)
- Single instance (tauri-plugin-single-instance). A second launch shows the existing window and exits
- The menu bar icon is `src-tauri/icons/tray.png` (a template image; Tauri's tray only accepts PNG)
- Info.plist includes `LSUIElement` (prevents the Dock icon from flashing at launch)
- "Save" in the debug dialog is written by Rust to `~/Downloads/tomarigi-eventlog-<project>.json`. Existing files are not overwritten; " (1)" etc. is appended
- Mock mode: launching with `TOMARIGI_MOCK=1` opens `index.html?mock=1`
- File reading: `src/lib/native-fs.ts` exposes the subset of FileSystemDirectoryHandle / File methods the app uses, in the same shape, and calls Rust's `fs_list` / `fs_stat` / `fs_read`. `@/` points to `src`

## Jumping to the Ghostty pane

- Clicking a bird (Garden) or a row (Perch, Recent activity, the nest list) jumps to the Ghostty pane where that claude is running. A chick's row jumps to its parent's pane
- Mapping: `sessionId` in `<config>/sessions/<pid>.json` → pid → tty from `ps` → `tty of terminal` in Ghostty's AppleScript, then `focus` + `activate`
- Sessions that can't be mapped (Codex, ended sessions) do nothing on click
- In the Garden, releasing after moving less than 4px is a click (left button only); anything more is a drag
- Clickable elements get a pointer cursor. No hover hint is shown

## Removing birds of ended sessions

- A bird whose process has ended is removed right away instead of after 30 minutes. The decision is based on whether the process is alive, not on the pane, so it doesn't depend on the terminal (closing a pane also ends the claude inside it)
- Claude Code: match sessionId and pid from `<config>/sessions/<pid>.json` against `ps`; sessions whose pid isn't alive fade out on the next load. The same applies after `/exit`. Chicks go away with their parent
- Watched folders without `<config>/sessions` (older Claude Code) still remove birds after 30 minutes
- Avoid false removals: nothing is removed on a load where `ps` failed or where any `sessions/*.json` failed to parse. A bird is removed only after it is missing on two loads in a row
- Codex has no equivalent, so birds are removed after 30 minutes

## The "?" for sessions waiting on you

- A "?" is put on birds that stopped to wait for the user's decision. This includes turns that ended by asking in plain text (like "Which one should I go with?") without using a tool
- State is kept in two fields
  - Machine state `BirdState`: `working | waiting | done | dozing`. `waiting` means stopped on AskUserQuestion / ExitPlanMode / request_user_input, or Claude Code's `<config>/sessions/<pid>.json` has `status: "waiting"` (while it shows options or a permission prompt, Claude Code doesn't write that tool_use to the transcript until it's answered). Recomputed on every poll
  - Jev verdict: `pending | asking | not_asking | error` plus the probability of yes. Only for turns whose machine state became done, the last reply text (`assistantText`, last 2000 characters) is sent to TypeSafe's Jev (`POST https://api.typesafe.ai/v1/systemone`, `jev-latest`, one Noul question). The result is tied to the turn (sessionId + time of the last reply) and is not requested again on every poll
- The "?" is shown when the machine state is waiting, or when the machine state is done / dozing and the Jev verdict is asking. Not shown for pending / error. It disappears when the session goes back to working
- A bird with a "?" stays in the Garden even when it dozes, instead of going into the nest
- While the "?" is shown, the event marks under the bird (✓ for done, "?" for waiting) are hidden
- Noul criteria: yes = stopped in a state where it can't proceed until the user answers, such as presenting options, asking for approval, or asking for information. no = just reported finished work (including optional add-ons that need no answer)
- The TypeSafe API key is the third BYOK provider (save, delete, connection test). Without a key, Jev is not used and the "?" comes only from the machine state waiting
- The "?" is a badge shared by all icon sets, drawn over the bird. The asking threshold is probability 0.5 (a single constant). Chirps and readout on done don't wait for Jev. Verdicts are logged in the debug dialog. Reply text is treated as untrusted input, and Jev's output is used only as a probability

## Window mode

- Switch between floating and standard windows, from the settings screen or the menu bar menu
  - Floating: NSPanel (transparent, frameless, always on top, shown above full-screen spaces)
  - Standard: can be maximized or made full screen with the title bar buttons; not pinned on top. Shown in the Dock, Cmd+Tab, and with its own app menu bar (activation policy Regular). Switching back to floating restores Accessory
- The window background is translucent and blurs what's behind it with the macOS frosted-glass effect (to feel less imposing on screen). Text, birds, and bubbles stay at full strength. The opacity is fixed (`.page` and `.garden` in `src/perch/perch.css`)
- When the window is wide, Perch and Recent activity are centered at a max width of about 720px, and settings at 560px. The Garden uses the full width
- The chosen mode is saved and used on the next launch. Floating is the default. Position and size are saved separately per mode

## Speech bubbles

- Only when a turn ends (done), the last reply is summarized briefly with BYOK OpenAI / Anthropic (`src/lib/summarize.ts`). It stays until the next turn starts (working). One summary call per turn. Without a key, no bubble
- Garden: the bird's name is above the icon. Right below the icon is a bubble of about 15 full-width characters, with an upward tail pointing at the bird. Even when the bubble is shifted left or right, the tail stays right under the icon. The status line, count at the bird's feet, and marks follow below the bubble. Overflow is cut with "…" and the full text shows on hover. Bubbles may overlap each other and birds; bubbles from later turns are drawn on top
- Perch: the same summary on one line within the row
- Recent activity: each row gets the same summary for that turn on one line. No extra summary calls. Summaries aren't stored, so events from before a restart have none
- For birds waiting on a reply, the bubble shows what is being asked, and the status line is just "needs reply · elapsed time" (ja: 返事待ち)
  - When stopped on a question tool (AskUserQuestion etc.), the question text from the tool input is shortened and shown as is (works without a key)
  - While Claude Code is still showing the options (the tool_use isn't in the transcript yet; waiting comes from `sessions/<pid>.json`), there is no question text, so only the "?" is shown and no bubble. No "waiting" event (chirp) fires in that case either
  - When Jev says asking and there is no summary key, the last sentence of the last reply is shown without AI

## State names

- The finished-turn state is called "done" everywhere: bird state, Recent activity, sound settings buttons, and bird descriptions (43 locales)
- The waiting state is called "needs reply" (ja: 返事待ち) everywhere: bird state, Recent activity events, and sound settings buttons (43 locales)

## Watching

- A session that handed work to another session and is waiting on it is shown as "watching". The other session isn't necessarily in the same directory
- How links are found: from traces of Claude Code's cross-session messaging (a public feature, enabled without configuration since v2.1.224) in transcripts. The sender side is the recipient name in a SendMessage tool call; the receiver side is `<cross-session-message from-name="…">`. Names are matched against `name` in `<config>/sessions/<pid>.json` to look up the other session's sessionId, cwd, and status. Two sessions that exchanged at least one message are considered linked. No particular person's tooling (such as a script that launches sessions) is relied on
- Watching: the session's own machine state is done / dozing, and at least one linked session is working (status busy in `sessions/<pid>.json`, or its transcript's machine state is working / waiting). Chirps and readout on done are held until all linked sessions stop
- Presentation:
  - In the Garden, the watching bird and its linked birds are placed close together and wrapped in a rounded block. Birds are not connected by lines
  - One name is shown above the block: the watching (parent) bird's. Birds inside show no name if they are in the parent's folder, and only the path relative to the parent otherwise
  - Dragging a bird inside the block moves the whole block
  - The number of linked sessions currently working is shown at the watching bird's feet
  - In Perch, linked rows are indented under the watching row, labeled with the path relative to the watching session's cwd (or the folder name if not under it). Rows in the same folder show no name
  - When a linked session gets a "?", the watching bird doesn't. The "?" only goes on the bird that is actually asking
- After watching ends, the bird isn't put into the nest until 5 minutes after the linked session last moved (so it doesn't bounce in and out of the nest between the other session's turns). A linked session whose status isn't idle (e.g. shell) also counts as moving
- The indentation parent is whichever of the two linked sessions started first. Codex has no equivalent feature and is out of scope
- Caveat: the transcript format and `sessions/<pid>.json` are not public Claude Code specs (the sessions docs say "internal to Claude Code and changes between versions"). State detection and jumping to Ghostty rely on them too

## BYOK API keys

- API keys (OpenAI / Anthropic / TypeSafe) are stored in the macOS Keychain in the everyday build (the WebView's IndexedDB is a plaintext file readable by other processes of the same user)
- The store is decided in one place at launch, by identifier. Everyday (`net.mohtech.tomarigi-desktop`) and verify (`.verify`) use the Keychain; dev (`.dev`) uses IndexedDB (dev's signature changes every build, which would trigger Keychain permission prompts every time)
- verify is signed with the local Apple Development certificate so rebuilding doesn't trigger permission prompts
- Keychain items are separated per identifier
- API calls that use keys (Jev, summaries, connection tests) are made from Rust; keys are never passed to the WebView's JS. JS only asks Rust to save, delete, or check whether a key is saved
- The settings screen never shows key values; it shows "Key saved" and only allows replace and delete
- Keys left in IndexedDB are moved to the Keychain and deleted from IndexedDB on the first launch of a Keychain build

## Findings from spikes

- A plain Tauri window, or changing NSWindow's collectionBehavior, doesn't show above full-screen spaces. Making it an NSPanel with tauri-nspanel 2.1.0 does
- In WKWebView, AudioContext is running without user interaction, and speechSynthesis speaks
- Rust can list Ghostty terminals and focus by tty through osascript (inside `tell application "Ghostty"`, `tab` is the tab class, so use `character id 9` as the delimiter)
- The Rust tauri crates are pinned to 2.11.x to match `@tauri-apps/api` 2.11 on the npm side

## Distribution

- Put the .app from `bun run tauri build` at `/Applications/tomarigi-desktop.app`
- Info.plist includes `NSAppleEventsUsageDescription` (the text of the Ghostty automation permission dialog). The base text is English (`CFBundleDevelopmentRegion` en); the Japanese text is in `src-tauri/locales/ja.lproj/InfoPlist.strings`, copied into the bundle via `bundle.macOS.files` in `tauri.conf.json`
- The app is English-based. UI text comes from the locale files (English fallback); the menu bar menu is Japanese only when the system language is Japanese; the debug log screen and mock mode are English only
