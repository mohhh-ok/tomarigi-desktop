# tomarigi-desktop design

A macOS app (Tauri 2) that watches AI coding agent sessions (Claude Code / Codex) as birds in an always-on-top floating window. It is the desktop version of the tomarigi Chrome extension.

## Scope

- Three tabs: Garden, Perch, and Recent activity (Garden is the default), plus the ⚙ settings screen
- Watches Claude Code / Codex transcripts in parallel through adapters. State is decided by local heuristics only; no hooks are installed on the agent side
- Bird states (sprites, aura while working, motion animations), and drag placement in the Garden
- Icon sets (birds / gnome / cat / robot / frog) assigned per project
- Web Audio chirps (mute, volume), speechSynthesis readout (opt-in, volume), BYOK (OpenAI / Anthropic / TypeSafe) for summaries on done, Jev verdicts, and connection tests
- Persistent event history and a debug dialog
- i18n (see "Language")
- Mock mode (presets + JSON injection)

## Language

- UI text is generated from `scripts/locales` into `public/_locales`, and every locale is checked to have the same keys
- The app is English-based. UI text comes from the locale files (English fallback). The menu bar menu is Japanese when the system language is Japanese and English otherwise. The debug log screen and mock mode are English only

## Bird states

- Machine state `BirdState`: `working | waiting | done | dozing`. Recomputed on every poll
  - `waiting`: stopped on AskUserQuestion / ExitPlanMode / request_user_input, or Claude Code's `<config>/sessions/<pid>.json` has `status: "waiting"` (while it shows options or a permission prompt, Claude Code doesn't write that tool_use to the transcript until it's answered)
  - `dozing`: a finished turn (`done`) with no new writes for 5 minutes (`DOZE_MS` in `src/lib/sessions.ts`). It only changes the sprite and the status label
- The finished-turn state is called "done" everywhere: bird state, Recent activity, sound settings buttons, and bird descriptions (all locales)
- The waiting state is called "needs reply" (ja: 返事待ち) everywhere: bird state, Recent activity events, and sound settings buttons (all locales)

## Watching

- A session that handed work to another session and is waiting on it is shown as "watching". The other session isn't necessarily in the same directory
- How links are found: from traces of Claude Code's cross-session messaging (a public feature, enabled without configuration since v2.1.224) in transcripts. The sender side is the recipient name in a SendMessage tool call; the receiver side is `<cross-session-message from-name="…">`. Names are matched against `name` in `<config>/sessions/<pid>.json` to look up the other session's sessionId, cwd, and status. Two sessions that exchanged at least one message are considered linked. No particular person's tooling (such as a script that launches sessions) is relied on
- Watching: the session's own machine state is done / dozing, and at least one linked session is working (status busy in `sessions/<pid>.json`, or its transcript's machine state is working / waiting). Chirps and readout on done are held until all linked sessions stop
- After the linked sessions stop, the bird stays watching for 5 minutes after the last one moved (`WATCH_GRACE_MS`), so the watch block and label don't flicker between the other session's turns. A linked session whose status isn't idle (e.g. shell) also counts as moving
- Presentation:
  - In the Garden, the watching bird and its linked birds are placed close together and wrapped in a rounded block. Birds are not connected by lines
  - One name is shown above the block: the watching (parent) bird's. Birds inside show no name if they are in the parent's folder, and only the path relative to the parent otherwise
  - Dragging a bird inside the block moves the whole block
  - The number of linked sessions currently working is shown at the watching bird's feet
  - In Perch, linked rows are indented under the watching row, labeled with the path relative to the watching session's cwd (or the folder name if not under it). Rows in the same folder show no name
  - When a linked session gets a "?", the watching bird doesn't. The "?" only goes on the bird that is actually asking
- The indentation parent is whichever of the two linked sessions started first. Codex has no equivalent feature and is out of scope
- Caveat: the transcript format and `sessions/<pid>.json` are not public Claude Code specs (the sessions docs say "internal to Claude Code and changes between versions"). State detection and jumping to Ghostty rely on them too

## BYOK API keys

- Providers: OpenAI / Anthropic for speech bubble summaries, TypeSafe for Jev (the "?" and the anger mark). Each can be saved, deleted, and connection-tested from the settings screen
- API keys are stored in the macOS Keychain in the everyday build (the WebView's IndexedDB is a plaintext file readable by other processes of the same user)
- The store is decided in one place at launch, by identifier. Everyday (`net.mohtech.tomarigi-desktop`) and verify (`.verify`) use the Keychain; dev (`.dev`) uses IndexedDB (dev's signature changes every build, which would trigger Keychain permission prompts every time)
- verify is signed with the local Apple Development certificate so rebuilding doesn't trigger permission prompts
- Keychain items are separated per identifier (a generic password with service `<identifier>.byok` and the provider name as the account)
- API calls that use keys (Jev, summaries, connection tests) are made from Rust; keys are never passed to the WebView's JS. JS only asks Rust to save, delete, or check whether a key is saved
- The settings screen never shows key values; it shows "Key saved" and only allows replace and delete
- Keys left in IndexedDB are moved to the Keychain and deleted from IndexedDB on the first launch of a Keychain build
- Jev: TypeSafe's `POST https://api.typesafe.ai/v1/systemone` with `jev-latest` and one Noul question. Text sent to Jev (reply text, user messages) is treated as untrusted input, and only Jev's probability of yes is used

## Watched folders

- Files are read on the Rust side. The standard locations for Claude Code and Codex, `~/.claude/projects` and `~/.codex/sessions`, are always watched as defaults (the app supplies them on every launch; they are not written into the saved list). Other folders can be added from the settings screen (native folder picker), and only added folders can be removed. People who use a different config directory via `CLAUDE_CONFIG_DIR` add its `projects` folder
- Defaults are listed first with a "Default" badge and no remove (×) button
- Default folders that don't exist are neither watched nor listed
- Labels can be edited for defaults too; default labels are stored separately
- Entries saved by older versions' "auto-register on first launch" that match a default path are dropped on load (no double watching)
- The path is shown under each label
- There is no read-permission concept, so a missing or unreadable folder just gets an "unreadable" badge

## Window and menu bar

- The app watches for as long as it runs and is controlled from the menu bar icon (left click toggles show/hide, right click opens the menu)
- The menu bar icon is `src-tauri/icons/tray.png` (a template image; Tauri's tray only accepts PNG)
- The × at the right end of the header hides the window (bring it back from the menu bar icon)
- Single instance (tauri-plugin-single-instance). A second launch shows the existing window and exits
- Window mode: switch between floating and standard windows, from the settings screen or the menu bar menu
  - Floating (default): a floating NSPanel (tauri-nspanel). Transparent, frameless, always on top, and shown above full-screen spaces too. It can be dragged from anywhere on its background. The window has a shadow. The app stays out of the Dock and Cmd+Tab (activation policy Accessory)
  - Standard: can be maximized or made full screen with the title bar buttons; not pinned on top. Shown in the Dock, Cmd+Tab, and with its own app menu bar (activation policy Regular). Switching back to floating restores Accessory
  - Info.plist includes `LSUIElement`, so the Dock icon doesn't flash at launch
- The chosen mode is saved and used on the next launch. Position and size are saved separately per mode and restored on the next launch. On first launch (no saved position, or the saved position isn't on any display) the window goes to the top-right of the main display
- The window background is translucent and blurs what's behind it with the macOS frosted-glass effect (to feel less imposing on screen). Text, birds, and bubbles stay at full strength. The opacity is fixed (`.page` and `.garden` in `src/perch/perch.css`), apart from "Fade until hovered"

## Fade until hovered

Applies to the floating window's Garden tab only.

- At rest, only the birds, their badges ("?", anger mark), and speech bubbles are shown. The background (translucent color, frosted glass, border, shadow), tabs, header, names, and status lines are faded almost to invisible. Bubbles are not a hover target and clicks on them go through at rest
- At rest, clicks anywhere except on a bird go through to the window below
- Putting the cursor on a bird shows the whole window at full strength. From then until the cursor leaves the window's bounds, the whole window takes clicks (tabs, settings, dragging the window work as usual)
- Once the cursor leaves the window's bounds, it fades again and clicks go through again
- Perch, Recent activity, settings, and the standard window are not faded (Perch and Recent activity have no birds to hover). This scope is Claude's own decision
- Because clicks go through, the WebView gets no mouse events at rest; the cursor position is watched on the Rust side to decide when a bird is under it

## Removing birds of ended sessions

- Birds are never removed because of elapsed time. A bird stays while its process is alive, however long it has been idle, and is removed right away once the process ends. The decision is based on whether the process is alive, not on the pane, so it doesn't depend on the terminal (closing a pane also ends the process inside it)
- Claude Code: match sessionId and pid from `<config>/sessions/<pid>.json` against `ps`; sessions whose pid isn't alive fade out on the next load. The same applies after `/exit`. Chicks go away with their parent
- A session whose transcript ends with a `continued-in` line (Claude Code moved the conversation to another session, e.g. a background process) is treated as ended even if its old process is still alive; the new session has its own bird
- Chicks (subagents) have no process of their own. While the parent is alive, a chick stays until the parent's transcript records its completion (the same record used for the chick's state), however long the chick has been writing nothing, and is removed once the completion is recorded
- Codex: a running codex keeps `~/.codex/thread-writer-locks/<threadId>.lock` open, and threadId is the id at the end of the rollout file name (`rollout-<time>-<threadId>.jsonl`). `lsof` on that folder gives threadId → pid. The lock file stays after codex exits, so the file's existence says nothing; only whether a process has it open counts (measured with codex-cli 0.156.1)
- Watched folders without `<config>/sessions` (older Claude Code) are not supported: there is no pid to check, so their sessions get no birds
- Avoid false removals: nothing is removed on a load where `ps` / `lsof` failed or where any `sessions/*.json` failed to parse. A bird is removed only after it is missing on two loads in a row
- Caveat: `thread-writer-locks` is not a public Codex spec, the same as `sessions/<pid>.json` for Claude Code

## Layout

- Birds without a saved (dragged) position are placed automatically in the Garden on a grid sized from the garden and one bird's size (name, icon, bubble room, status lines, marks). Cell centers are used as is (not pulled in from the edges), so neighbours keep a full cell apart
- Every bird whose process is alive is placed in the Garden, however long it has been idle, including `dozing` birds. There is no nest
- When the birds don't fit (e.g. many birds in the 340px floating window), the garden grows taller and the window scrolls instead of overlapping birds. Watch blocks count by their own height
- Status lines: line 1 is the state and elapsed time, line 2 the tool name. Inside watch blocks, line 1 is the state and line 2 the elapsed time and tool name
- When the window is wide, Perch and Recent activity are centered at a max width of about 720px, and settings at 560px. The Garden uses the full width

## Jumping to the Ghostty pane

- Clicking a bird (Garden) or a row (Perch, Recent activity) jumps to the Ghostty pane where that claude / codex is running. A chick's row jumps to its parent's pane
- Mapping: session → pid (see "Removing birds of ended sessions" for how each agent's pid is found) → tty from `ps` → `tty of terminal` in Ghostty's AppleScript, then `focus` + `activate`
- In the osascript, `tab` inside `tell application "Ghostty"` is the tab class, so the terminal list uses `character id 9` as the delimiter
- A conversation handed over to another session (`continued-in`, see "Removing birds of ended sessions") can run in a Claude Code background process whose tty isn't a Ghostty pane. When Ghostty doesn't have the new session's tty, the jump tries the sessions it came from in turn (their old process still shows the conversation)
- Sessions whose pid can't be found do nothing on click
- In the Garden, releasing after moving less than 4px is a click (left button only); anything more is a drag
- Clickable elements get a pointer cursor. No hover hint is shown

## The "?" for sessions waiting on you

- A "?" is put on birds that stopped to wait for the user's decision. This includes turns that ended by asking in plain text (like "Which one should I go with?") without using a tool
- State is kept in two fields
  - Machine state `BirdState` (see "Bird states")
  - Jev verdict: `pending | asking | not_asking | error` plus the probability of yes. Only for turns whose machine state became done, the last reply text (`assistantText`, last 2000 characters) is sent to Jev. The result is tied to the turn (sessionId + time of the last reply) and is not requested again on every poll
- The "?" is shown when the machine state is waiting, or when the machine state is done / dozing and the Jev verdict is asking. Not shown for pending / error. It disappears when the session goes back to working
- While the "?" is shown, the event marks under the bird (✓ for done, "?" for waiting) are hidden
- Noul criteria: yes = stopped in a state where it can't proceed until the user answers, such as presenting options, asking for approval, or asking for information. no = just reported finished work (including optional add-ons that need no answer)
- Without a TypeSafe key, Jev is not used and the "?" comes only from the machine state waiting
- The "?" is a badge shared by all icon sets, drawn over the bird. The asking threshold is probability 0.5 (a single constant). Chirps and readout on done don't wait for Jev. Verdicts are logged in the debug dialog

## Anger mark for abuse toward the AI

- When the user sends a message, that message is sent to Jev right away (a separate request from the "?" verdict, which waits for the turn to stop), with one Noul question: is this message abusive toward the AI
- If the probability of yes is over the threshold, an anger mark is put on that session's bird. The threshold is probability 0.6 (`ABUSE_THRESHOLD` in `src/lib/jev.ts`)
- The mark stays until the user's next message in that session. That message is judged again, and the mark disappears if it isn't abusive
- The anger mark is another kind of the same badge component as the "?", shared by all icon sets
- No separate on/off setting: it is used only when a TypeSafe key is saved. The TypeSafe key description on the settings screen says that the user's own messages are also sent (all locales)
- When the "?" is shown at the same time, both are shown: the "?" stays at the top right, the anger mark goes at the top left
- Recent activity has no bird, so the row of a session whose bird has the anger mark shows the same mark next to the state icon (✓ / ?) on the left. While any row has it, every row keeps room for it so the text lines up
- The mark is the 💢 shape itself (four red brackets bending toward the center, with a dark outline), drawn in SVG rather than with an emoji font, without a round background
- What counts as the user's message: the latest `user` entry in the transcript that is a person's text. Excluded: tool_result, isMeta lines, lines whose `origin.kind` is not `human` (task notifications etc.), and machine text starting with `<` (slash command echoes, bash-input) or `[Request interrupted`. The first 500 characters are sent. Codex uses the user messages its adapter already keeps
- The latest message seen is remembered per session, so it survives the 64KB tail window filling up with tool output. Bytes appended between two polls that already fell outside the window (a large tool result right after the message) are scanned separately so the message isn't missed (Claude Code transcripts only)
- At launch, the latest message of each session on screen is judged once. While a new message is being judged, the previous verdict stays shown
- Verdicts are logged as `[jev] anger <status> p=<probability>` in the app log and shown on the started event of that message in the debug dialog

## Speech bubbles

- Only when a turn ends (done), the last reply is summarized briefly with BYOK OpenAI / Anthropic (`src/lib/summarize.ts`). It stays until the next turn starts (working). One summary call per turn. Without a key, no bubble
- Garden: the bird's name is above the icon. Right below the icon is a bubble of about 15 full-width characters, with an upward tail pointing at the bird. Even when the bubble is shifted left or right, the tail stays right under the icon. The status line, count at the bird's feet, and marks follow below the bubble. Overflow is cut with "…" and the full text shows on hover. Bubbles may overlap each other and birds; bubbles from later turns are drawn on top
- Perch: the same summary on one line within the row
- Recent activity: each row gets the same summary for that turn on one line. No extra summary calls. Summaries aren't stored, so events from before a restart have none
- For birds waiting on a reply, the bubble shows what is being asked, and the status line is just "needs reply · elapsed time" (ja: 返事待ち)
  - When stopped on a question tool (AskUserQuestion etc.), the question text from the tool input is shortened and shown as is (works without a key)
  - While Claude Code is still showing the options (the tool_use isn't in the transcript yet; waiting comes from `sessions/<pid>.json`), there is no question text, so only the "?" is shown and no bubble. No "waiting" event (chirp) fires in that case either
  - When Jev says asking and there is no summary key, the last sentence of the last reply is shown without AI

## Other

- "Save" in the debug dialog is written by Rust to `~/Downloads/tomarigi-eventlog-<project>.json`. Existing files are not overwritten; " (1)" etc. is appended
- File reading: `src/lib/native-fs.ts` exposes the subset of FileSystemDirectoryHandle / File methods the app uses, in the same shape, and calls Rust's `fs_list` / `fs_stat` / `fs_read`. `@/` points to `src`
- Mock mode and other launch options are listed in README.md

## Distribution

- Put the .app from `bun run tauri build` at `/Applications/tomarigi-desktop.app`
- Info.plist includes `NSAppleEventsUsageDescription` (the text of the Ghostty automation permission dialog). The base text is English (`CFBundleDevelopmentRegion` en); the Japanese text is in `src-tauri/locales/ja.lproj/InfoPlist.strings`, copied into the bundle via `bundle.macOS.files` in `tauri.conf.json`
