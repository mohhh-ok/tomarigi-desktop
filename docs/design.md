# tomarigi-desktop design

A desktop app for macOS, Windows, and Linux (Tauri 2; see "Platforms") that watches AI coding agent sessions (Claude Code / Codex and the other agents in "Agents") as birds in an always-on-top floating window. It is the desktop version of the tomarigi Chrome extension.

Each topic is in its own file under `docs/design/`; read the file of the topic you are changing. A reference written as `docs/design/<file>.md "<name>"` points to a heading in that file, or to the list item that starts with that name (`tests/design-refs.test.ts` checks every such reference).

- [Scope](design/scope.md): what the app includes and leaves out; read before adding a feature or a tab
- [Language](design/language.md): when adding or changing UI text or a locale
- [Bird states](design/bird-states.md): when changing how working / waiting / done / dozing is decided from a transcript
- [Watching](design/watching.md): when changing how sessions linked by cross-session messages are found and shown, or who started a turn
- [BYOK API keys](design/byok-api-keys.md): when touching the providers (OpenAI / Anthropic / Local AI), their models, key storage, or connection tests
- [Watched folders](design/watched-folders.md): when changing which agent folders are read or the add-folder dialog
- [Window and menu bar](design/window-and-menu-bar.md): when changing the floating window, window mode, or the menu bar icon and menu
- [Settings window](design/settings-window.md): when changing the settings window, its pages, or how its buttons and rows look
- [Fade until hovered](design/fade-until-hovered.md): when changing how the Garden and Concierge tabs fade while the pointer is away
- [Removing birds of ended sessions](design/removing-ended-birds.md): when changing when a bird is removed (process liveness per agent)
- [Chicks that have finished](design/finished-chicks.md): when changing how subagents (chicks) are shown and removed after they finish
- [Side chats and forked sessions of the Claude desktop app](design/side-chats-and-forks.md): when handling side chats or forks of Claude desktop app sessions
- [Display names](design/display-names.md): when changing how a session is named or how sessions with the same name are told apart
- [Layout](design/layout.md): when changing placement in the Garden, footprints, dragging, or how the window grows
- [Jumping to the terminal pane](design/jumping-to-terminal.md): when changing the jump from a bird to its terminal pane, per terminal app or editor
- [Agents](design/agents.md): when adding an agent or changing one agent's adapter
- [Readout voice (local TTS server)](design/readout-voice.md): when changing the readout through a local TTS server
- [Settings file](design/settings-file.md): when changing the settings JSON file, its keys, or how edits to it are applied
- [Platforms](design/platforms.md): when writing code that differs on macOS, Windows, or Linux
- [The "?" for sessions waiting on you](design/waiting-question-mark.md): when changing when the "?" is put on or taken off a bird
- [Anger mark for abuse toward the AI](design/anger-mark.md): when changing the anger mark
- [Turn verdicts](design/turn-verdicts.md): when changing the requests made when a turn ends (summary, asking, continuing, abusive) or their prompts
- [LLM regression test](design/llm-regression-test.md): when changing a prompt or a model, or adding a scene to `bun run test:llm`
- [Speech bubbles](design/speech-bubbles.md): when changing the summary bubbles in the Garden and Perch
- [Concierge](design/concierge.md): when changing the concierge, its request and advice, the Concierge tab, or its readout
- [Plugins](design/plugins.md): when changing plugins that send what the concierge says to other services (Slack)
- [Updates](design/updates.md): when changing the self-updater
- [Other](design/other.md): the debug log's Save, file reading, launch options, and the app log
- [Distribution](design/distribution.md): when changing how the .app is installed or its Info.plist
- [Download page](design/download-page.md): when changing the download page on moh-tech.net
