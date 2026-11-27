# Settings window

Settings open in a window of their own instead of inside the small floating window (the user: 「設定画面がみづらいのをなんとかしたい。設定が増えたのに画面がちいさいまま。どうしよう。ブラウザで設定画面を開くようにするかどうかあるいは独自画面か。どくじがめんがいいのかな」; Claude recommended a window of the app's own over a browser page, since a browser page can't reach the app's saved settings or its Rust functions without another local HTTP endpoint to guard; the user: 「どくじがめんでやって」).

## Requirements

- One settings window, opened from ⚙ in the floating window's header, from a new "Settings…" item in the menu bar menu (the taskbar menu on Windows / Linux), and with Cmd+, (Ctrl+, on Windows / Linux) while a window of the app is focused. When it is already open, it comes to the front instead of opening a second one
- It is a standard window whatever the floating / standard mode is: a title bar, not always on top, can be moved, resized and minimized, and takes keyboard focus when opened so its fields can be typed in at once. It opens at a size where every section reads without squeezing (default about 760×560, smallest about 560×420; Claude's own decision) and reopens at the size and place it was closed at
- Sections listed on the left, the chosen section's settings on the right; only the right side scrolls. Sections (Claude's own decision, from the cards the screen has now): Sound and readout (notify with sound, its volume and previews, read aloud, its volume, the readout voice), AI for summaries (keys, Local AI, which provider runs summaries and the concierge), Concierge (its look), Watched folders, Icon sets, Window (floating / standard), Settings file (was AI agent access; see "Settings file"), Updates. The section last shown is shown again on the next open
- Everything that can be set today can be set there, with the same checks, wording, tests (connection test, sample readout, sound previews) and dialogs (adding a folder, the folder picker); nothing is lost in the move
- A change takes effect at once, as now: birds, sounds, readout, summaries and the window mode follow it without reopening anything. A change made elsewhere while the settings window is open (the menu bar's "Read aloud" or window mode, an edit of the settings file, the floating window's mute button) shows in the settings window at once, and the other way round
- The floating window no longer shows settings inside it; it keeps its tabs. The debug log stays where it is (out of scope)
- In the UI language, with the app's look (dark, the same cards and controls)
- macOS, Windows and Linux

Pass/fail:
- Open it from all three places; a second open brings the same window to the front; close and reopen keeps size, place and section
- With both windows open: change each kind of setting in the settings window and see the floating window follow (a sound preview, mute, read aloud, readout voice, window mode, icon set, an added folder showing its sessions); change "Read aloud" from the menu bar and in the settings file and see the settings window follow
- Type into a field right after opening it from the floating window in floating mode (focus is taken)
- UI check of every section at the default and the smallest size, in Japanese and English

## Basic design

- A second window of the same app (Tauri window label `settings`) loading the same frontend, with the section in the URL (`?view=settings&section=<id>`; the app's rule that a screen is told by its URL). Created when first opened and destroyed when closed, so it costs nothing while closed (Claude's own decision); its size, place and section are saved and restored
- The settings are in the settings file, kept by Rust ("Settings file"), so every window reads and writes the same values through Rust's commands; keys are in the OS store through Rust. What isn't a setting (the last section shown, notes closed, the event log) is in the app's WebView IndexedDB, which both windows share since they load the same origin (checked on macOS; Windows / Linux in CI builds where possible)
- One owner of the running state: the floating window's page keeps doing what the settings drive (sounds, readout, summaries, taking edits of the settings file, the window mode). Every save, wherever it comes from, goes through the same save functions and then tells every window which setting changed (an app-wide event); each window reloads that setting. No window keeps its own copy that can go stale
- In floating mode the app is an Accessory app (no Dock icon) and its panel doesn't take focus; opening the settings window activates the app so the window takes focus, and closing it returns to the previous state without showing a Dock icon in floating mode
- The menu bar menu gets "Settings…" after Show / Hide
- Out of scope: a browser page, changing what each setting does, the debug log, the floating window's tabs

## Clarity of the settings window

The user asked to fix, before the release, what the UI checks of the settings window had found unclear on the screen from before the move (the user: 「せっていがめんのわかりにくさもなおして」, of the list Claude gave: the words 「ターン」「ペイン」「MCP」, the icon set's ⇄ with no words, the folder label editing with no Save / Cancel, and buttons of different sizes).

Requirements:
- No developer word is left unexplained on the settings window: 「ターン」 and 「ペイン」 are replaced by what the user sees (e.g. the agent's reply / that session's terminal), and 「MCP」 and 「TTS」 are either replaced or said in plain words where they first appear on a card. Every language, not only Japanese and English
- The icon set's change button says what it does in words (not only ⇄)
- Editing a watched folder's label shows a visible Save and Cancel next to the field; Enter saves and Esc cancels as before
- A button of the same kind looks the same in every section (height, corners, font, size), and the right edges of the rows in a list line up (the watched folders' rows and the icon sets' rows)
- Out of scope: changing what a setting does, moving settings between sections, the other findings in the file

Pass/fail: shots of every section at 760×560 and 560×420 in Japanese and English show none of the words above unexplained, the ⇄ button with words, the label editing with Save / Cancel, and the buttons and row edges matching; one UI check on those shots finds no "unclear word" or "different button" left

### Detailed design (clarity)

Claude's own decisions, by the session that implements it; may be changed.

Words (every locale in `scripts/locales/` is rewritten for the changed keys, not only ja / en). Found by listing every key whose ja or en has ターン / ペイン / MCP / TTS / turn / pane; the ones on the settings window:

| Key (group) | ja now → new | en now → new |
|---|---|---|
| `aiUserMessagesNote` (byok) | ターンが終わるたびに、エージェントの最後の応答と、そのターンにあなたが送った発言を送信します。… → エージェントが返事を終えるたびに、その返事と、前の返事のあとにあなたが送った発言を送信します。…（後半はそのまま） | Each time a turn finishes, the agent’s last reply and the messages you sent during that turn are sent. … → Each time the agent finishes a reply, that reply and the messages you sent since its previous reply are sent. … |
| `conciergeSettingsNote` (concierge) | …押すとそのセッションのペインに飛びます。…見た目を選べます → …押すとそのセッションのターミナルに切り替わります。…見た目は下で選べます。 | …Click it to jump to that session's pane. …Choose its look → …Click it to switch to that session's terminal. …Choose its look below. |
| `readoutVoiceLocal` (readout-voice) | ローカルの TTS サーバー → ローカルの読み上げサーバー | Local TTS server → Local speech server |
| `voiceUnavailable` (voice) | …ローカルの TTS サーバーを選んだときだけ… → …ローカルの読み上げサーバーを選んだときだけ… | …through a local TTS server. → …through a local speech server. |

- `angerBadgeTitle` (ask) has 「ターン」 too but is the floating window's bird tooltip, not the settings window: left as is (out of scope)

The icon set's button:
- The button says what it changes the row to: 「{set}にする」 / "Use {set}" (key `iconSetUseButton` with the placeholder `set`, all locales), e.g. 「ネコにする」. The image left of it stays the current set. The aria-label starts with the same visible text and then names the row and the current set (「ネコにする: {row} ({current set})」), so the accessible name contains the visible text (WCAG 2.5.3); the key `iconSetToggleAria` is removed, and the ⇄ goes

Editing a watched folder's label:
- While editing, the row is the field, then 「保存」 and 「キャンセル」 (`byokSaveButton` / `cancelButton`, both existing keys), both `button.small`. The badges and ✕ are hidden while editing, so the row fits at 560 px
- Enter saves and Esc cancels as before. Leaving the field still saves, except when the focus moves to the row's own Save / Cancel (`relatedTarget` inside the row), so Tab to Cancel and a click on Cancel don't save first. Cancel and Esc never save: the open edit is held in a ref (`src/perch/settings/edit-session.ts`) and `finishEdit` closes it once, saving only when asked, so the blur that removing the field causes finds it already closed. Cancel is the shared `CancelEditButton` (with `keepFieldFocus`, which stops the press from taking the focus off the field)

Buttons and row edges:
- Right edges: the default rows lose the invisible ✕ placeholder (it was the gap of U1). To keep 「ラベル編集」 in one column, the ✕ moves to the left of 「ラベル編集」 in added rows; 「ラベル編集」 is the last item of every row, at the row's right edge like the icon set's button
- One small button for the settings page (`html[data-view="settings"]`, so the floating window is untouched): `button` takes the page's font (`font: inherit`, the cause of the Arial-like "Check for updates"), and `button.small` (BusyButton, the remove ✕ and the copy buttons included) gets one height (`inline-flex`, centered, `min-height: 28px`, `line-height: 1.4`, 12 px text, 6 px corners)
- 「フォルダを追加」 becomes `button.small` with 12 px above it. The one larger kind stays only for a section's single main action (「v… に更新」, 「登録コマンドをコピー」), which is meant to stand out


## Detailed design

Claude's own decisions, by the session that implements it; may be changed.

Checked on macOS (verify .app, Tauri 2.12.5, a throwaway build with a second window `settings` made by `WebviewWindowBuilder` loading `index.html?probe=settings`; the code was reverted):
- (a) The two windows share one store: both pages have the origin `tauri://localhost`; the second window read the value the floating window had written to the `tomarigi` / `kv` IndexedDB a moment before (the settings themselves later moved to the settings file through Rust, "Settings file"; IndexedDB keeps what isn't a setting), and the floating window read the value the second window wrote. An event sent with `emit` from the second window reached a `listen` in the floating window. Windows / Linux are not checked yet (one origin per app there too; checked in CI builds or reported back)
- (c) In floating mode (activation policy Accessory), `activateIgnoringOtherApps:` on `NSApplication` and then `set_focus()` on the new window made it the key window with the app active, and the policy stayed Accessory (1), so no Dock icon. Typing into a field right after opening is checked again on the real window

The window (Rust, `src-tauri/src/settings_window.rs`):
- `open_settings(section?)` command, also called by the menu item and the update item. When the `settings` window exists: unminimize, show, focus, and when a section is given send it to that window (`emit_to("settings", "settings-section", id)`). Otherwise build it with `WebviewWindowBuilder` (label `settings`, URL `index.html?view=settings` plus `&section=<id>` when given), with a title bar, resizable, not always on top, dark theme, an opaque dark background, default 760×560, smallest 560×420, title `tomarigi` until the page sets its own (the page sets the title in the UI language with `setTitle`)
- Size and place: saved to `settings-window.json` in the app config folder (as `window.json` is for the floating window) after Moved / Resized settle, and restored when it is built; a place not on any display is replaced by the center of the main display. Closing destroys the window (no `prevent_close`), so nothing runs while it is closed
- Focus: before building or showing it, when the mode is floating, remember the frontmost app (`NSWorkspace.frontmostApplication`, when it isn't this app); then `activateIgnoringOtherApps:` and `set_focus()`. The activation policy isn't touched. When the window is destroyed in floating mode, the remembered app is activated again, so the app that was in front before comes back and no Dock icon shows. In standard mode nothing is remembered. Windows / Linux: `set_focus()` only
- The menu bar menu: "Settings…" (`設定…` in Japanese) after Show / Hide, calling `open_settings` without a section. The update item now opens the settings window at the Updates section instead of the floating window. The "Read aloud" click event goes to the floating window only (`emit_to("main", …)`), since only it saves from it; `window-mode` and `update-status` stay sent to every window
- `src-tauri/capabilities/default.json` lists `settings` next to `main` (with `set-title` and `close` for the page's title and Cmd+W)
- Switching the window mode while the settings window is open gives the focus back to it: setting the policy back to Accessory deactivated the app and left the settings window without focus (observed with the self-test). Right after it is built or brought forward, it is focused again 250 ms later, since macOS sometimes left the key window where it was
  - The self-test's focus results vary from run to run: in one run the settings window kept the focus after the mode switch, in another the terminal the user was working in came back to the front, already at the step that hides the floating window. Claude's guess (not checked): macOS 14 and later can refuse an app's request to come to the front without a user action while the user is working in another app (`activateIgnoringOtherApps:` is deprecated there). The self-test can't make a real click, so the focus after a real click is checked by the user
- Checking without synthetic clicks (no accessibility permission for the checking session): `TOMARIGI_SETTINGS_TEST=1` (debug builds only, like `TOMARIGI_MODE_TEST`) opens the window through the same function as the menu item, opens it again at a section, hides the floating window while the page changes settings through its own controls (`settings-selftest.ts`), closes and reopens it, and logs the focus state at each step; the values the floating window applied are in the settings file meanwhile; `tools/settings-open-check.mjs` checks ⚙ and Cmd+, in a headless browser

The page (frontend):
- `boot.tsx` renders `SettingsApp` (`src/perch/settings-app.tsx`) for `?view=settings` and `App` otherwise. `?mock=1&view=settings` opens it in a browser with the mock source, for screenshots and UI checks; `?settings=1` is replaced by `?view=settings`
- `SettingsApp`: a left list of the sections and the chosen section's content on the right (only the right scrolls). Section ids: `sound`, `ai`, `concierge`, `folders`, `icons`, `window`, `settingsFile` (was `agent`; a saved `agent` opens it), `updates`. The chosen one is written to the URL (`history.replaceState`, `?view=settings&section=<id>`) and saved (kv `settingsSection`); without `section` in the URL the saved one opens, else `sound`. The existing cards are moved, not rewritten: `RootManager` and `RootAddDialog`, `AiKeySettings`, `ConciergeSettings`, `IconSetSettings`, `SettingsFileSettings` (was the MCP card), `UpdateSettings`; the sound and readout controls and the window mode radios move out of `App.tsx` into `settings/sound-settings.tsx` and `settings/window-mode-settings.tsx`. `AiKeySettings` / `ReadoutVoiceSettings` get `open` = their section is shown (it clears drafts as closing settings did)
- Keys: Cmd+, (Ctrl+, elsewhere) in either page calls `open_settings`; Cmd+W (Ctrl+W) in the settings page closes it. The floating window's ⚙ calls `open_settings`; the Concierge tab's "set up AI" calls `open_settings("ai")`. The floating window loses `settingsOpen`, the settings `BackBar`, its Esc handling and the `open-updates` listener
- The settings page doesn't take `data-window-mode` (it is always a standard window): `useWindowMode` gets an option not to write it to `<html>`, and the page sets `data-view="settings"` for its own styles

(b) Telling every window about a change, in one place:
- `src/lib/settings-sync.ts`: `notifySettingChanged(key)` sends the app-wide event `settings-changed` with `{ key, from: <window label> }` (never a value: API keys can be in IndexedDB with the webview store; an edit of the settings file is sent with `from: "settings-file"`, so every window reloads it), and `onSettingsChanged(keys, reload)` calls `reload` for those keys when the event comes from another window (the window that saved has already set its own state; reloading on its own echo could pull a slider back mid-drag). Outside Tauri (the browser mock) it does nothing
- Called from `kvPut` and `kvDelete` in `lib/kv.ts`, which every saved setting goes through (the settings file's keys go on to Rust, the rest to IndexedDB; `api-keys.ts`, `readout-voice.ts`, `icon-set-store.ts` and `settings-store.ts` use them), and from `saveApiKey` / `deleteApiKey` / `deleteRetiredKey` in `api-keys.ts` with the key `apiKeys` (keys are kept in Rust, not in IndexedDB). So a save from the settings window, the floating window's mute button, the menu bar's "Read aloud" (saved by the floating window) and an edit of the settings file (taken by the floating window) all pass the same place
- Each window reloads only what changed: `useSettings` maps keys to its loaders (`muted` / `chirpVolume` → sound; `voiceEnabled` / `voiceVolume` / `readoutVoice` → readout; `apiKeys` / `aiProvider` / `localAi` → AI; `conciergeLook`; `iconSetAssignments`), `useRoots` reloads on `roots` / `defaultRootLabels`. A reload applies the module-level values again in that window (`setChirpVolume`, `setVoiceVolume`, `setReadoutVoice`), so previews and samples played in the settings window use the current volume and voice
- Window mode stays with Rust (`window-mode` event to every window; saved in the settings file) and updates with `update-status`, as now

One owner of the running state (`useSettings` takes a role, `"owner"` in `App`, `"settings"` in `SettingsApp`):
- Only the floating window: reading the settings file at launch and taking its edits (`useSettingsFile`), the startup imports (`TOMARIGI_LOCAL_TTS`, `TOMARIGI_LOCAL_AI`, `initApiKeys`), reporting "Read aloud" to the menu (`reportVoiceMenu`) and listening to its clicks, stopping speech when "Read aloud" turns off (also when the change came from the settings window), scanning, chirps and readouts
- What the settings window shows but isn't saved anywhere comes from the floating window: the running projects for the icon set rows, the folders that failed to scan (`brokenIds`), and this launch's changes from the settings file and refused values. The floating window sends them as `settings-runtime` to the `settings` window when they change and when the settings page asks with `settings-runtime-request` on load. In the browser mock the settings page takes them from the mock source (one scan)
- Tests in the settings window run there: the AI connection test, the readout sample, the sound previews (their own `AudioContext`, unlocked by the first click), the folder picker

Where each requirement is met:

| Requirement / basic design | Where |
|---|---|
| Opened from ⚙, the menu bar item, Cmd+, ; a second open brings it to the front | `open_settings` in `settings_window.rs`; ⚙ in `App.tsx`; "Settings…" in `tray.rs`; the keydown handler in `App.tsx` and `settings-app.tsx` |
| A standard window in either mode, takes focus | `WebviewWindowBuilder` options; activate + `set_focus` in `open_settings` |
| Default about 760×560, smallest about 560×420, reopens at its size and place | builder size / min size; `settings-window.json` save and restore |
| Sections on the left, only the right scrolls, last section shown again | `SettingsApp` layout and styles (`styles/settings-window.css`); `settingsSection` and the URL |
| Everything settable today, same checks, wording, tests, dialogs | the moved cards and hooks, unchanged; `RootAddDialog` in the settings page |
| A change takes effect at once in every window, either way | `settings-sync.ts` through `kvPut` / `kvDelete` / the key functions; reloads in `useSettings`, `useRoots`; `window-mode` from Rust |
| The floating window keeps its tabs without settings; debug log unchanged | `App.tsx` without the settings panel |
| UI language, the app's look | existing messages, new ones in `scripts/locales/`; the same card styles on an opaque dark page |
| macOS, Windows, Linux | Tauri windows; the macOS-only focus code behind `cfg(target_os = "macos")` |
| Window `settings` with the section in the URL; built on open, destroyed on close | `open_settings`, `?view=settings&section=<id>` |
| One store for both windows | the settings file through Rust ("Settings file"); (a) above for IndexedDB |
| One owner of the running state | the `"owner"` role in `App`; `settings-runtime` |
| Focus in floating mode and back on close without a Dock icon | (c) above; the remembered frontmost app |
| "Settings…" after Show / Hide | `setup_tray` |
