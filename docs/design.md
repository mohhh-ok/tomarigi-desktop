# tomarigi-desktop design

A macOS app (Tauri 2) that watches AI coding agent sessions (Claude Code / Codex and the other agents in "Agents") as birds in an always-on-top floating window. It is the desktop version of the tomarigi Chrome extension.

## Scope

- Three tabs: Garden, Perch, and Recent activity (Garden is the default), plus the ⚙ settings screen
- Watches the transcripts of every agent in "Agents" in parallel through adapters. State is decided by local heuristics only; no hooks are installed on the agent side
- Bird states (sprites, aura while working, motion animations), and drag placement in the Garden
- Icon sets (birds / gnome / cat / robot / frog) assigned per project
- Web Audio chirps (mute, volume), speechSynthesis readout (opt-in, volume), BYOK (OpenAI / Anthropic / TypeSafe) for summaries on done, Jev verdicts, and connection tests
- Persistent event history and a debug log screen
- i18n (see "Language")
- Mock mode (presets + JSON injection)

## Language

- UI text is generated from `scripts/locales` into `public/_locales`, and every locale is checked to have the same keys
- The app is English-based. UI text comes from the locale files (English fallback). The menu bar menu is Japanese when the system language is Japanese and English otherwise. The debug log screen and mock mode are English only

## Bird states

- Machine state `BirdState`: `working | waiting | done | dozing`. Recomputed on every poll
  - `waiting`: stopped on AskUserQuestion / ExitPlanMode / request_user_input, or Claude Code's `<config>/sessions/<pid>.json` has `status: "waiting"` (while it shows options or a permission prompt, Claude Code doesn't write that tool_use to the transcript until it's answered)
  - `dozing`: a finished turn (`done`) with no new writes for 5 minutes (`DOZE_MS` in `src/lib/bird-state.ts`). It only changes the sprite and the status label
- The finished-turn state is called "done" everywhere: bird state, Recent activity, sound settings buttons, and bird descriptions (all locales)
- The waiting state is called "needs reply" (ja: 返事待ち) everywhere: bird state, Recent activity events, and sound settings buttons (all locales)

## Watching

- A session that handed work to another session and is waiting on it is shown as "watching". The other session isn't necessarily in the same directory
- How links are found: from traces of Claude Code's cross-session messaging (a public feature, enabled without configuration since v2.1.224) in transcripts. The sender side is the recipient name in a SendMessage tool call; the receiver side is `<cross-session-message from-name="…">`. Names are matched against `name` in `<config>/sessions/<pid>.json` to look up the other session's sessionId, cwd, and status. Two sessions that exchanged at least one message are considered linked. No particular person's tooling (such as a script that launches sessions) is relied on
- Watching: the session's own machine state is done / dozing, and at least one linked session is working (status busy in `sessions/<pid>.json`, or its transcript's machine state is working / waiting). Chirps and readout on done are held until all linked sessions stop
- After the linked sessions stop, the bird stays watching for 5 minutes after the last one moved (`WATCH_GRACE_MS`), so the watch block and label don't flicker between the other session's turns. A linked session whose status isn't idle (e.g. shell) also counts as moving
- Presentation:
  - In the Garden, the watching bird and its linked birds are placed close together and wrapped in a rounded block. Birds are not connected by lines
  - The watching (parent) bird's name is shown above the parent bird itself, wherever its cell is in the block; the block has no title of its own (the user's decision: a title on the block's top edge read as the name of the bird below it). Other birds inside show no name if they are in the parent's folder, and only the path relative to the parent otherwise
  - Dragging a bird inside the block moves the whole block
  - The number of linked sessions currently working is shown at the watching bird's feet
  - In Perch, linked rows are indented under the watching row, labeled with the path relative to the watching session's cwd (or the folder name if not under it). Rows in the same folder show no name
  - When a linked session gets a "?", the watching bird doesn't. The "?" only goes on the bird that is actually asking
- The indentation parent is whichever of the two linked sessions started first. Codex has no equivalent feature and is out of scope
- Caveat: the transcript format and `sessions/<pid>.json` are not public Claude Code specs (the sessions docs say "internal to Claude Code and changes between versions"). State detection and jumping to the terminal pane rely on them too

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

- Files are read on the Rust side. The standard location of every agent in "Agents" (`~/.claude/projects`, `~/.codex/sessions`, `~/.qwen/projects`, `~/.copilot/session-state`, `~/.gemini/tmp`, `~/.local/share/opencode`, `~/.cursor/projects`) is always watched as a default (the app supplies them on every launch; they are not written into the saved list). The list of agents and their folders is kept in one place, `AGENTS` in `src/lib/agents.ts`. Other folders can be added from the settings screen (native folder picker), and only added folders can be removed. People who use a different config directory via `CLAUDE_CONFIG_DIR` (or `QWEN_HOME`, `COPILOT_HOME`, `GEMINI_CLI_HOME`, `OPENCODE_DB`) add that folder
- The add-folder dialog has one choice per agent, top to bottom: Claude Code, Codex, Qwen Code, GitHub Copilot CLI, Gemini CLI, OpenCode, Cursor CLI. Each row is "＋ <agent>" with its standard folder and a copy button, as before. Above the choices, one line tells people who moved an agent's folder with an environment variable (`CLAUDE_CONFIG_DIR`, `COPILOT_HOME`, etc.) to pick the folder with the same name inside it (Claude's own decision, from a user-view review) A default folder row is labeled with the agent's name. Birds and rows don't show which agent a session belongs to (the same as for Codex until now); when the same project name comes from two watched folders, the folder's label is added, as before
- Defaults are listed first with a "Default" badge and no remove (×) button
- Default folders that don't exist are neither watched nor listed
- Labels can be edited for defaults too; default labels are stored separately
- Entries saved by older versions' "auto-register on first launch" that match a default path are dropped on load (no double watching)
- The path is shown under each label
- There is no read-permission concept, so a missing or unreadable folder just gets an "unreadable" badge

## Window and menu bar

- The app watches for as long as it runs and is controlled from the menu bar icon (left click toggles show/hide, right click opens the menu)
- The menu bar icon is `src-tauri/icons/tray.png` (a template image; Tauri's tray only accepts PNG)
- The app icon (Dock, Finder, Product Hunt thumbnail) shows the same blue round bird as the in-app birds icon set (`src/assets/birds/`), so the icon and the app read as the same character (the user's decision). The icons in `src-tauri/icons/` are generated from `src-tauri/app-icon.png` (1024px, transparent outside the rounded tile) with `bunx tauri icon src-tauri/app-icon.png -o <temp dir>`, then only the files already in `src-tauri/icons/` are copied in (the android / ios output isn't used; `tray.png` is separate and kept)
- Gallery images for Product Hunt and the README are in `docs/images/` (WebP). They are shot from mock mode (`TOMARIGI_MOCK=1`, `TOMARIGI_QUERY="tint=0&preset=..."`)
- The × at the right end of the header hides the window (bring it back from the menu bar icon). Its label says "hide window", not "close", so it isn't mistaken for leaving settings or a dialog
- The header and the row under it (the tabs, or the settings bar while in settings) stay at the top; only the content below them scrolls. The add-folder dialog follows the same rule: its title and × stay in view and only its content scrolls
- The debug log is a screen like settings: it replaces the tabs' content under the header (the header buttons stay), shows a "‹ Back" row in place of the tabs, and closes with Back, the debug button again, or Esc. Settings and the debug log are never open at the same time
- Settings: ⚙ in the header opens it. While open, the tab row is replaced by a bar with "‹ Back" and the "Settings" title. Back, ⚙ again, or Esc (when no dialog or inline edit is open) returns to the tab that was showing
- Single instance (tauri-plugin-single-instance). A second launch shows the existing window and exits
- Window mode: switch between floating and standard windows, from the settings screen or the menu bar menu
  - Floating (default): a floating NSPanel (tauri-nspanel). Transparent, frameless, always on top, and shown above full-screen spaces too. It can be dragged from anywhere on its background. The window has a shadow. The app stays out of the Dock and Cmd+Tab (activation policy Accessory)
  - Standard: can be maximized or made full screen with the title bar buttons; not pinned on top. Shown in the Dock, Cmd+Tab, and with its own app menu bar (activation policy Regular). Switching back to floating restores Accessory
  - Info.plist includes `LSUIElement`, so the Dock icon doesn't flash at launch
  - In both modes, the first click on the window while another app is in front already reaches the content, so a bird or the window can be dragged without clicking once to activate it (`acceptFirstMouse` in `src-tauri/tauri.conf.json`; the user asked for it)
- The chosen mode is saved and used on the next launch. Position and size are saved separately per mode and restored on the next launch. On first launch (no saved position, or the saved position isn't on any display) the window goes to the top-right of the main display
- The window background is translucent and blurs what's behind it with the macOS frosted-glass effect (to feel less imposing on screen). Text, birds, and bubbles stay at full strength. The opacity is fixed (`.page` in `src/perch/styles/base.css` and `.garden` in `src/perch/styles/garden.css`), apart from "Fade until hovered"

## Fade until hovered

Applies to the floating window's Garden tab only.

- At rest, only the birds, their badges ("?", anger mark), speech bubbles, and the handle are shown. The background (translucent color, frosted glass, border, shadow), the garden's frame, watch blocks, tabs, header buttons, names, and status lines are fully transparent (the user's decision: 「とうめいもーどのときは完全透明にして」). The scrollbar is not shown (the user's decision); it keeps its width so the birds don't shift when the window fades in. Bubbles are not a hover target and clicks on them go through at rest
- At rest, clicks anywhere except on a bird or the window handle go through to the window below
- Birds can be clicked (jump to the terminal pane) and dragged while the window stays faded; hovering a bird no longer shows the whole window (the user's decision)
- The window handle stays visible at rest. Dragging it moves the window; clicking it shows the whole window at full strength (the user's decision: 「どらっぐでまどがうごく、くりっくでとうめいかいじょ、いいね」)
  - The handle has no menu of its own. The tabs and header buttons are reached by clicking it to show the window (the user's decision: 「透明解除されたらそこでめにゅーみれるもんな」)
  - The handle is the text "Tomarigi" (the user's decision: 「えだってみえないやろ。普通にTomarigi文字にしろ」)
  - It sits where the app name is in the header (top left). The header row is outside the Garden, so birds don't need to keep clear of it, and it stays at the window's top left when the window grows or shrinks (the user's decision: 「ヘッダーのとこでええわ」)
  - A press on it becomes a window drag once the cursor moves 4px with the button held; released before that, it is a click (Claude's own decision: a drag started on press swallows the release, so the click could not be told apart)
  - At rest it gets a dark backing of its own so it stays readable over light or busy windows behind; the backing's room is kept when shown, so the name doesn't move (Claude's own decision). It acts as the handle (drag moves the window) on every tab of the floating window, not only at rest
  - At rest the handle (text and backing together) is translucent (the user's decision: 「tomarigiははんとうめいにしておいて」). Its opacity is 0.8: 0.6 was too faint (the user: 「tomarigiの半透明はもうちょっとみえるようにして」; the value 0.8 is Claude's own decision). Shown, it is at full strength
  - While the cursor is on a bird at rest, the handle stands out (full strength, a light ring and glow) (the user's decision: 「とりにマウスオーバーした時にめだつようにして」; the look is Claude's own decision). The Rust side decides it from the cursor, since the WebView's :hover isn't reliable while clicks go through
  - Not yet decided: whether hovering a bird shows only that bird's name and status (Claude's proposal). Until decided, hovering a bird shows nothing more
- After clicking the handle, the whole window takes clicks until the cursor leaves the window's bounds (tabs, settings, dragging the window work as usual)
- Once the cursor leaves the window's bounds, it fades again and clicks go through again
- With no birds in the Garden it fades too (the user's decision: 「0ワの時は、透明にしたい」). The empty message (「いまは誰もとまっていません」, or the one asking to grant folder access again) then stays at rest at full strength on the same dark backing as the handle, since the handle alone is easy to miss (the user: 「なにかめだつものをおいておかないといかんよな。「tomarigi」はめだたないし」; the user chose the empty message among Claude's options). It acts as a second handle: dragging it moves the window, clicking it shows the whole window. Full strength rather than the handle's 0.8 is Claude's own decision
- Perch, Recent activity, settings, and the standard window are not faded (Perch and Recent activity have no birds to hover). This scope is Claude's own decision
- Because clicks go through, the WebView gets no mouse events at rest; the cursor position is watched on the Rust side to decide when a bird or the handle is under it. Once a drag starts there, clicks are taken until the button is released

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

- A bird that appears goes to its saved (dragged) position if it has one, otherwise to a free cell of a grid sized from the garden and one bird's footprint, starting from a cell picked by its id. A watch block that forms goes where its birds were: they take its cells in the order they stood (top to bottom, then left to right), and the block goes to the spot that moves them the least on average. A block keeps that cell order afterwards; birds that join it later take the next cells (Claude's own decision)
- Each bird and block takes a footprint: the most room it can need (name, icon, bubble room, both status lines, marks, and for a watching bird the count row). Every row of a watch block has that fixed height too (name row, bubble room, count row), so a bubble, a name inside the block, or the count appearing never moves a bird in it (Claude's own decision; the empty name row of a block is no longer tightened). A block uses up to 3 columns, fewer if the garden is too narrow, and keeps its column count when the window grows. Neighbours keep a 12px gap between footprints, so bubbles and status lines coming and going never make them overlap
- A bird or watch block on screen stays at the same place on screen until the user drags it (the user asked that birds stop moving around). Nothing else moves it: bubbles appearing or disappearing, tool / status lines, text wrapping, watch links forming or changing, other birds joining or leaving, and the window growing or shrinking. The only exception is a bird that would otherwise overlap another bird or block; then only that one moves, to the nearest free spot
  - Positions are kept in px, not as a share of the garden. When the window is resized (grown, shrunk, or by hand), they are shifted by how far the garden's corner moved on screen, so they stay at the same place on screen. A bird or block that then sticks out of the garden also moves to the nearest free spot inside
  - Which one moves when two would overlap: blocks already on screen come first, then birds already on screen (the earlier shown first), then what the user just dropped, then what just appeared. A bird dropped onto another is nudged next to it (Claude's own decision)
  - A dragged position is saved as the bird's center and top edge in % of the garden, and is used only when the bird appears (e.g. after a relaunch). On screen, birds are anchored at their top edge, so a line added under a bird doesn't move its icon
- The Garden never sticks out of the window and never scrolls, in any state. When birds can't all fit, they overlap instead (the user's decision: 「ウィンドウからはみだすのはあかんわやっぱり。スクロール状態になるのがあかん。それよりはあいこんがかさなるほうがまだまし」)
- Every bird whose process is alive is placed in the Garden, however long it has been idle, including `dozing` birds. There is no nest
- Birds are not made any smaller to fit: the icon's lower limit (26px) is the smallest that stays readable (the user's decision)
- The icon size follows the garden size and the number of birds, but it grows only when birds leave and nothing on screen would have to move for it, never when the window grows: a larger icon makes every bird taller and would push neighbours away (Claude's own decision)
- When the birds don't fit in the floating window's Garden tab, the window grows automatically (the user's decision). Watch blocks count by their own height
  - It grows only when the birds actually can't be placed without overlapping at the current size, and only by as much as needed. Growing when they would fit leaves the birds sparse, which is a bug (the user's report)
  - "Can't be placed" is judged by the actual placement: the birds on screen stay where they are, and a bird or block that has no free spot among them overflows. How far is also found with the actual placement: the smallest size at which, with the birds on screen kept at the same place on screen, everything gets a spot without moving anyone (failing that, the smallest at which everything gets a spot). Until the window has grown, the bird that has no spot is placed overlapping others
  - It grows away from the display edges it sits near, decided per axis: a window in the right part of the display keeps its right edge and grows left, one in the bottom part keeps its bottom edge and grows up, and one in the middle grows both ways around its center (the user's decision). "Part" is the display's thirds, judged by the window's center (Claude's own decision)
  - It grows up to the visible area of the display the window is on (excluding the menu bar and the Dock). If the birds still don't fit at that size, birds that have no spot overlap others at the nearest place
  - Width and height grow together keeping the aspect ratio of the user's size (the user's decision)
  - A manual resize always wins, including making it smaller (the user's decision): the resized size becomes the user's size and the window is not grown back over it. It grows again only when a bird joins and no longer fits (Claude's own decision)
  - When birds leave, the window shrinks back toward the user's size, never below it, and only as far as no bird on screen would have to move (Claude's own decision). The grown size is not saved; the next launch opens at the user's size
  - Only the floating window's Garden tab. On Perch, Recent activity, settings, the debug log, and in the standard window, the window stays at the user's size (Claude's own decision)
- Status lines: line 1 is the state and elapsed time, line 2 the tool name. Inside watch blocks, line 1 is the state and line 2 the elapsed time and tool name
- When the window is wide, Perch and Recent activity are centered at a max width of about 720px, and settings at 560px. The Garden uses the full width

## Jumping to the terminal pane

- Clicking a bird (Garden) or a row (Perch, Recent activity) jumps to the terminal pane where that agent is running. A chick's row jumps to its parent's pane
- Mapping: session → pid (see "Removing birds of ended sessions" and "Agents" for how each agent's pid is found) → tty and the chain of ancestor processes from `ps` → the terminal app that owns an ancestor process (by bundle id; an iTerm2 `iTermServer` process left under launchd counts as iTerm2) → that terminal's adapter focuses the pane whose tty matches. Only the adapter of the owning app is called
- tmux: when the tty is a tmux pane (`tmux list-panes -a -F '#{pane_tty} #{pane_id} #{session_name}'`), the pane is selected with `tmux switch-client -c <client tty> -t <pane id>` on the client attached to that session that was used last (`client_activity`), and the jump continues with that client's tty as the target, so the outer terminal is focused by its own adapter. Sockets other than the default (`-L` / `-S`) are taken from the command line of the tmux server among the ancestors, which keeps the arguments of the client that started it. The tmux binary is looked up in fixed install places (`/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin`, `/usr/bin`), not from the path `ps` shows
- Adapters (macOS):
  - Ghostty: every running instance (bundle id `com.mitchellh.ghostty`) is asked by pid through ScriptingBridge (`SBApplication applicationWithProcessIdentifier:`) for the terminal whose `tty` matches, then `focus` + activate. `tell application "Ghostty"` reaches only one of several instances (`open -n`), so osascript is not used
  - iTerm2: the session whose `tty` matches is selected, then its tab, then its window (AppleScript dictionary)
  - Terminal.app: the tab whose `tty` matches becomes the selected tab of its window, the window becomes frontmost with index 1, and the app is activated
  - WezTerm: `wezterm cli list --format json` gives `tty_name` → `pane_id`, then `wezterm cli activate-pane --pane-id <id>`, and the app is brought forward through LaunchServices (`NSWorkspace openApplicationAtURL:` with `activates`; WezTerm has no AppleScript dictionary, and `NSRunningApplication activate` alone lost to another app coming forward at the same time). The binary is taken from the bundle of the running app (`NSRunningApplication.bundleURL`)
  - kitty: only when the user has set `allow_remote_control` and `listen_on` in `kitty.conf`; then `kitten @ --to <socket> focus-window --match pid:<pid>` with the pid of the ancestor kitty started (the shell). The socket is the unix socket the kitty process listens on (`lsof -a -U -p <pid>`), and `kitten` comes from the app bundle. Tomarigi never edits `kitty.conf`; without the setting, kitty is only activated. README tells kitty users which two settings to add
  - Any other app (Warp, Alacritty, and terminals not listed): the app is only brought to the front. Warp has no way to address a tab from outside (warpdotdev/warp#8929 is open); Alacritty has no tabs or panes and its IPC has no focus command
- A conversation handed over to another session (`continued-in`, see "Removing birds of ended sessions") can run in a Claude Code background process whose tty isn't a terminal pane. When no adapter finds the new session's pane, the jump tries the sessions it came from in turn (their old process still shows the conversation). Only a pane-level focus counts as found; when none is found, the app owning the first session is brought to the front
- Apple Events permission dialogs appear once per terminal app (Ghostty, iTerm2, Terminal.app). `NSAppleEventsUsageDescription` names terminals in general, not only Ghostty
- Sessions whose pid can't be found do nothing on click
- Every agent's jump goes through one command, `focus_pid(pid, fallbackToApp)`, which returns how far it got (`pane` / `app` / `none`); `focusPid` in `src/lib/terminal-focus.ts` calls it
- In the Garden, releasing after moving less than 4px is a click (left button only); anything more is a drag
- Clickable elements get a pointer cursor. No hover hint is shown
- VS Code / Cursor (and other VS Code forks): the integrated terminal tab is focused through Tomarigi's own VS Code extension (the user's decision: 「vscodeようの拡張？そんなんもできるの？やって」). The extension lives in `vscode-extension/` in this repo
  - Each window's extension writes `~/.tomarigi/vscode/<uriScheme>-<extension host pid>.json` when it starts and whenever a terminal opens or closes: a URI addressed to its own window (`env.asExternalUri`, which carries the window id) and the `processId` of every terminal in that window. It deletes the file when the window closes
  - Tomarigi looks for a file whose terminal pids include the agent's pid or one of its ancestors and whose extension host is alive, and opens that window's URI with the pids added. The extension shows that terminal, and the editor brings that window to the front. A plain URI would go only to the topmost window (VS Code API docs: "the topmost window will handle the uri"), so the window-addressed URI is required
  - When no such file exists (extension not installed, or a stale file whose extension host is gone), no URI is opened, because an editor without the extension shows an "install extension?" dialog for every unknown URI. The app is only brought to the front, as before
  - The editor asks once whether the extension may open the URI ("don't ask again" stops it). README says so
  - The extension ID (`publisher.name`, now `mohtech.tomarigi`) is written only in `vscode-extension/package.json`; Tomarigi never needs it, because it opens the URI the extension wrote. The extension runs on the UI side (`extensionKind: ui`), so the window file is written on the machine where Tomarigi runs, also for a remote window
  (Claude's own decision, from the vscode worker's findings in /tmp/tomarigi-desktop/vscode-findings.md)
  - README tells users how to install the extension. Publishing to the VS Code Marketplace (for VS Code) and Open VSX (for Cursor and other forks) needs the user's accounts; until it is published, the `.vsix` built by CI is attached to the GitHub Release

## Agents

- Each agent is one adapter in one place: list sessions under its root → read the tail into the shared `TailInfo` → liveness (which sessions have a live process, and their pid) → the pid used for jumping. State (`deriveState`) and everything after it don't know which agent a session is
- Supported agents and where they are read (each standard location is watched when it exists, the same as the defaults in "Watched folders"):
  - Claude Code: `~/.claude/projects`. pid from `<config>/sessions/<pid>.json`
  - Codex: `~/.codex/sessions`. pid from `thread-writer-locks`
  - Qwen Code: `~/.qwen/projects/<project>/chats/<sessionId>.jsonl`. pid from `<sessionId>.runtime.json`
  - GitHub Copilot CLI: `~/.copilot/session-state/<sessionId>/events.jsonl`
  - Gemini CLI: `~/.gemini/tmp/<project>/chats/session-*.jsonl`; cwd from `<project>/.project_root`, or else `~/.gemini/projects.json`
  - OpenCode: `~/.local/share/opencode/opencode.db` (SQLite, opened read-only on the Rust side); cwd from `session.directory`. Subagent sessions (`parent_id` set) get no bird of their own, like Codex's internal rollouts (Claude's own decision)
  - Cursor CLI: `~/.cursor/projects/<cwd slug>/agent-transcripts/<id>/<id>.jsonl`. Its lines have no time and no cwd: a line's time is the file's modification time on the load that first read it (the only exception to not using mtime), and the cwd is the matched process's (the folder name is the cwd with every character other than letters and digits turned into `-`) (Claude's own decision)
- Agents without a pid file: a session is alive while a process of that agent (matched by the program in `ps axww -o pid=,tty=,etime=,command=`, either the binary or the script run by node / bun) runs with the session's cwd (`lsof -a -d cwd -p <pid> -Fn`). Processes without a tty are ignored. When N processes of one agent share a cwd, the N sessions in that cwd written since that agent's processes started, latest first, are alive (Claude's own decision). So a process that was started but hasn't written yet shows no bird, the same as Claude Code before its first message. Jumping uses the matched pid; when several sessions share a cwd, the session written last gets the newest process and the others do nothing on click (Claude's own decision)
- The same safeguards as "Removing birds of ended sessions" apply: nothing is removed on a load where `ps` / `lsof` failed, and a bird is removed only after it is missing on two loads in a row
- "Needs reply" is shown only where the agent's transcript records that it is waiting on the user; agents with no such record show working or done instead. Recorded: a call to the agent's question tool that has no result yet (Qwen Code `ask_user_question` / `exit_plan_mode`, Gemini CLI and Copilot CLI `ask_user` / `exit_plan_mode`, OpenCode `question`). Permission prompts are not recorded by any of them, so they show working
- Watching (cross-session links) is Claude Code only
- Not supported: Aider (its history is Markdown with no record of turns ending, so no state can be derived). Kiro CLI and Amp are deferred until their session files are confirmed on a real install (the only sources found disagree or are unofficial; Claude's own decision). Resume when a session file from each is available to read
- Caveat: none of these transcript formats is a public spec, the same as for Claude Code and Codex. Qwen Code's `runtime.json` is the exception (written for outside tools)

## Platforms

- macOS, Windows 10 / 11 (x64), and Linux (x64, X11). On a Wayland session the app runs through Xwayland (`GDK_BACKEND=x11` is set at launch), because pure Wayland has no always-on-top, no global cursor position, no window position restore, and no way to focus another app's window (Claude's own decision, from research)
- Platform-specific code is behind three seams, each with one implementation per OS: the window (transparent, always on top, not stealing focus, click-through except on birds and the handle), key storage, and process lookup (liveness and jumping). Everything else is shared
- Window on Windows / Linux: transparent, frameless, always on top, hidden from the taskbar. The "fade until hovered" click-through works the same way as on macOS (the cursor position is polled and the window takes clicks only over birds and the handle). Always-on-top on X11 is a request the window manager may ignore. Showing on every virtual desktop is not supported on Windows
- Frosted background: Windows uses Acrylic; Linux has none and uses the plain translucent background (Claude's own decision)
- Clicking the window doesn't take focus from the terminal where possible (`focusable: false` equivalent); if a platform can't take a click without focus, it takes focus (Claude's own decision)
- Keys: Windows Credential Manager and Linux Secret Service (GNOME Keyring / KWallet) through the `keyring` crate. When Secret Service is not available, keys can't be saved and the settings screen says so; there is no plaintext fallback (Claude's own decision)
- Tray: on Linux the left click is not delivered, so the menu has "Show / Hide". The menu language comes from the system locale (not `defaults`)
- Liveness: pids are checked without `ps` on Windows (`sysinfo`). Codex's lock holders are found with the Restart Manager on Windows and `/proc/<pid>/fd` on Linux. Agent folders are under the user's home directory on every OS (`%USERPROFILE%` on Windows)
- Jumping: tmux works the same on Linux. Otherwise only the terminal window is brought to the front: on Windows the nearest ancestor with a visible window (`SetForegroundWindow`; Windows Terminal tabs can't be addressed from outside), on X11 the window whose `_NET_WM_PID` is an ancestor (`_NET_ACTIVE_WINDOW`). The VS Code extension works on every OS
- Readout uses the WebView's speechSynthesis; where it's missing (some Linux builds), readout is off and the settings say so
- Distribution: CI builds Windows (NSIS) and Linux (deb, AppImage) next to macOS. Windows builds are unsigned for now, so Windows shows a SmartScreen warning on first run (Claude's own decision; a code-signing certificate is pending, see below). Real-machine checks on Windows and Linux are listed in docs/release.md and are not done yet
- Pending: a Windows code-signing certificate. Azure Artifact Signing is open to individual developers only in the US and Canada (organizations in Japan are eligible), so an individual in Japan needs a certificate from a CA. The user has not decided

## The "?" for sessions waiting on you

- A "?" is put on birds that stopped to wait for the user's decision. This includes turns that ended by asking in plain text (like "Which one should I go with?") without using a tool
- State is kept in two fields
  - Machine state `BirdState` (see "Bird states")
  - Jev verdict: `pending | asking | not_asking | error` plus the probability of yes. Only for turns whose machine state became done, the last reply text (`assistantText`, last 2000 characters) is sent to Jev. The result is tied to the turn (sessionId + time of the last reply) and is not requested again on every poll
- The "?" is shown when the machine state is waiting, or when the machine state is done / dozing and the Jev verdict is asking. Not shown for pending / error. It disappears when the session goes back to working
- While the "?" is shown, the event marks under the bird (✓ for done, "?" for waiting) are hidden
- Noul criteria: yes = stopped in a state where it can't proceed until the user answers, such as presenting options, asking for approval, or asking for information. no = just reported finished work (including optional add-ons that need no answer)
- Without a TypeSafe key, Jev is not used and the "?" comes only from the machine state waiting
- The "?" is a badge shared by all icon sets, drawn over the bird. The asking threshold is probability 0.5 (a single constant). Chirps and readout on done don't wait for Jev. Verdicts are logged in the debug log screen

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
- Verdicts are logged as `[jev] anger <status> p=<probability>` in the app log and shown on the started event of that message in the debug log screen

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

- "Save" in the debug log screen is written by Rust to `~/Downloads/tomarigi-eventlog-<project>.json`. Existing files are not overwritten; " (1)" etc. is appended
- File reading: `src/lib/native-fs.ts` exposes the subset of FileSystemDirectoryHandle / File methods the app uses, in the same shape, and calls Rust's `fs_list` / `fs_stat` / `fs_read`. `@/` points to `src`
- Mock mode and other launch options are listed in README.md

## Distribution

- Put the .app from `bun run tauri build` at `/Applications/tomarigi-desktop.app`
- Info.plist includes `NSAppleEventsUsageDescription` (the text of the terminal automation permission dialog). The base text is English (`CFBundleDevelopmentRegion` en); the Japanese text is in `src-tauri/locales/ja.lproj/InfoPlist.strings`, copied into the bundle via `bundle.macOS.files` in `tauri.conf.json`
