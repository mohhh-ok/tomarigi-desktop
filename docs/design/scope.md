# Scope

- Tabs: Concierge (always shown; see "Without a provider" under "Concierge"), Garden, Perch, and Recent activity (its tab reads "Activity", `tabEventsLabel`), in that order (Garden is the default); ⚙ opens the settings window ("Settings window")
- Watches the transcripts of every agent in "Agents" in parallel through adapters. State is decided by local heuristics only; no hooks are installed on the agent side
- Bird states (sprites, aura while working, motion animations), and drag placement in the Garden
- Icon sets (birds / gnome / cat / robot / frog) assigned per project
- Web Audio chirps (mute, volume), speechSynthesis readout (opt-in, volume) or a local TTS server's voice (see "Readout voice (local TTS server)"), BYOK (OpenAI / Anthropic) or a local model for summaries on done with the "?" and anger mark verdicts, and connection tests
- Persistent event history and a debug log screen
- i18n (see "Language")
- Mock mode (presets + JSON injection)
- Not bundled: the author's `peer-session` skill (starts child Claude Code sessions in Ghostty panes, which then show up as birds). It is Ghostty- and Claude Code-only and still being shaped by the author's own use (the user: 「peer-sessionはえっとね、基本的には俺も使いながらブラッシュアップしていきたいから細かい設定も基本的には俺好みでかんがえてる。でさ、もんだいはたーみなるごかんよな」「とりあえず自分の使用でそだてていきたい。」). Revisit bundling or publishing it, and support for terminals other than Ghostty, when the user brings it up again
