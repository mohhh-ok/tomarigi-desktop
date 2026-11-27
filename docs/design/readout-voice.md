# Readout voice (local TTS server)

The readout can use a TTS server running locally (or on the LAN) in place of the system's voice (the user: 「ttsさーばーをしていできるようにしようか。がいぶapiかあるいはローカルか」, then, after a report on the differences, 「いったんろーかるげんていにしようか」). Cloud TTS APIs are out of scope for now (the user's decision). Facts behind the choices (checked 2026-11-25 in the official docs): OpenAI's `/v1/audio/speech` models (`tts-1`, `tts-1-hd`, `gpt-4o-mini-tts`) shut down on 2027-01-06, and their successor runs only on the Realtime API; VOICEVOX's terms allow commercial use and require a credit that shows VOICEVOX was used (voicevox.hiroshiba.jp/term/), with each voice library's own terms on top.

## Requirements

- Readout voice in the settings: "System voice" (today's readout, the default) or "Local server". A user who never touches it hears what they hear today
- Two kinds of local server, chosen in the settings (Claude's own decision, from the report: these two cover the maintained local servers found):
  - OpenAI-compatible (`POST <base URL>/audio/speech`): Kokoro-FastAPI, mlx-audio and other servers with that endpoint
  - VOICEVOX-compatible (`POST <base URL>/audio_query` then `POST <base URL>/synthesis`): VOICEVOX ENGINE and AivisSpeech Engine
- Everything that is read aloud today goes through the chosen voice: the done readout (with its summary or fallback), needs reply, the Concierge tab's suggestions, and the events read when a Concierge request fails. What is read, its order (display name, then the body, as two utterances), the "Read aloud" setting, the menu bar item and the readout volume work as they do now. Two readouts never play over each other; they play one after another in the order they were queued, as speechSynthesis's queue does today
- The readout is never lost: when the server can't be reached, answers with an error, or gives no audio within the wait below, that utterance is read with the system voice (and not with the server's voice later). Audio that arrives after the wait is dropped (Claude's own decision: the readout is the signal that a turn finished)
- VOICEVOX-compatible servers read Japanese only, so while the UI language isn't Japanese, readout uses the system voice even when such a server is chosen, and the settings say so under the choice (Claude's own decision)
- The settings let the user hear the voice before relying on it: a "Test" plays a short sample through the server with the chosen voice, and says what went wrong when it fails (not running, wrong kind of server, no such voice)
- Where the system has no speech engine (some Linux builds), "Read aloud" can be turned on while a local server is chosen; without the fallback voice, a failed utterance is skipped and logged (Claude's own decision)
- When the server is VOICEVOX ENGINE itself, the settings show the credit 「VOICEVOX:<voice name>」 next to the chosen voice. Not for AivisSpeech Engine or another VOICEVOX-compatible server: the credit is required by VOICEVOX's terms, AivisSpeech's engine needs no credit, and its voices aren't VOICEVOX's (Claude's own decision, from the terms; may be changed; the implementing session pointed out that a credit on every VOICEVOX-compatible server would be wrong for AivisSpeech). Which engine it is comes from what the server says about itself (e.g. its engine manifest), not from the port

Pass/fail:
- Unit tests (scenes) for the choice between server and system voice: server answers in time / error / timeout / late audio dropped / English UI with VOICEVOX / no system voice / queue order with several events
- Run against real servers on this Mac: one OpenAI-compatible (Kokoro-FastAPI or mlx-audio) and one VOICEVOX-compatible (VOICEVOX or AivisSpeech). The app log shows each request, its time, and whether the server's audio or the system voice was used. The sound itself can't be checked by an agent; the user listens to the result (done, needs reply, Concierge tab, Test)

## Basic design

- Settings, saved with the other settings (not secrets, no key; Claude's own decision, as for the Local AI provider): voice source (system / local), server kind (OpenAI-compatible / VOICEVOX-compatible), base URL, and voice; for OpenAI-compatible also the model. Default base URLs: `http://localhost:8880/v1` (Kokoro-FastAPI) for OpenAI-compatible, `http://localhost:50021` (VOICEVOX) for VOICEVOX-compatible; AivisSpeech's is `http://localhost:10101`, typed by the user (Claude's own decisions)
- The base URL follows the Local AI rule (http(s), no user name or password, `?`, or `#`), checked in the settings screen and in Rust with the same rule. Any host is accepted
- Voices and models are picked from the server's lists when it has them (VOICEVOX `/speakers`; OpenAI-compatible `GET <base URL>/audio/voices` and `GET <base URL>/models`, which not every server has), and can be typed when the list can't be fetched. Editing the URL clears the list and the choice, as for the Local AI provider, so a voice of another server can't be saved with the new URL
- Requests are made from Rust, not from the WebView (Claude's own decision): the same path as the Local AI provider, and the local servers' CORS defaults (VOICEVOX allows only localhost-like origins) don't apply. The audio is passed to the page and played there, so the readout volume applies as it does now
- Wait for the server's audio: 5 seconds per utterance, counted from sending the request (Claude's own decision). The done readout's 5-second wait for the summary comes before it and is unchanged. A first request while a server loads its model may take longer and is then read with the system voice
- Nothing is written to disk: audio is played from memory and not cached. Each request writes one line to the app log (kind, time taken, server or fallback, and the error if any)
- Out of scope: cloud TTS APIs (OpenAI, ElevenLabs, Google, Azure), keys for TTS, Style-Bert-VITS2 and Piper (their own APIs; Piper's official voices have no Japanese)

## Detailed design

Written by the session that implements it, from the code as of 29842f2. All of it is Claude's own decision and may be changed.

Settings (`src/lib/readout-voice.ts`, new):
- `ReadoutVoice = { source: "system" | "local"; local?: LocalTtsConfig }`, `LocalTtsConfig = { kind: "openai" | "voicevox"; baseUrl; voice; voiceLabel?; speaker?; model?; voicevoxCredit? }`, saved under the key `readoutVoice` in the settings store (`kvGet` / `kvPut` of `src/lib/settings-store.ts`). Missing or broken data loads as `{ source: "system" }`, so a user who never touches it keeps today's readout
- The local config is kept when the source goes back to "System voice", so switching back and forth doesn't retype it. `source: "local"` with no saved local config reads with the system voice (nothing to send to)
- `voiceLabel` is the voice's name as the list showed it (VOICEVOX: the speaker's name and the style, e.g. 「四国めたん（ノーマル）」, whose value is the style id). It is saved, with `speaker` (the speaker's name alone), so the credit 「VOICEVOX:<speaker>」 and the saved card can be shown without asking the server
- `voicevoxCredit`: whether the server is VOICEVOX ENGINE itself, from its `GET <base>/engine_manifest` read with the voice list: true only when the manifest's `brand_name` is `VOICEVOX` (AivisSpeech Engine says `AivisSpeech`). A manifest that can't be read gives false, so no credit is shown for a server that doesn't say it is VOICEVOX ENGINE. Saved with the config; whether the two engines really say this is checked on both real servers before it is final
- `DEFAULT_TTS_BASE_URL = { openai: "http://localhost:8880/v1", voicevox: "http://localhost:50021" }`. Changing the kind in the form puts the other kind's default URL in the field when the field still holds the previous kind's default or is empty; a URL the user typed stays
- `routeOf(config, lang, systemAvailable)`: `"server"` when the source is local, a local config is saved, and (kind is openai, or `lang` starts with `ja`); else `"system"` when `systemAvailable`; else `"none"`. One function, read by the queue and by `readoutAvailable()`

The queue (`src/lib/readout-queue.ts`, new), used only while the source is local:
- `ReadoutQueue` with its outside world passed in (`synthesize(text, lang) → Promise<audio bytes>`, `playAudio(bytes, volume, signal) → Promise<void>`, `speakSystem(text, lang, volume) → Promise<void>`, `stopSystem()`, `wait(ms) → Promise<void>`, `now()`, `log(line)`, `route(lang)`, `volume()`), so tests drive it scene by scene without timers or a WebView
- `enqueue(text, lang, tag)`: for a server route, the request is sent at once (requests of queued utterances run in parallel; playback stays in order). Each item settles to "server audio", "system voice" or "skip" at the first of: audio arrived, the request failed, `TTS_WAIT_MS` (5,000) passed since it was sent. Audio arriving after that is dropped (the item already settled to the system voice). With no system voice, a failed item settles to "skip"
- One player loop: takes the head, waits for it to settle, plays it, and only then takes the next, so two readouts never overlap and the order is the order of `enqueue`. The system voice inside the queue is `speechSynthesis.speak` of one utterance, awaited to its `end` / `error`, with a cap of 2 seconds plus 250 ms per character (in case `end` never comes; Claude's own decision) so a lost event can't stop the queue
- The volume is read when an item starts playing (today's `voiceVolume` rule)
- `cancel()`: empties the queue, aborts the generation's `AbortSignal` (the one handed to every `playAudio` of that generation; this stops the audio whether it is still waiting to resume / decode or already sounding), `speechSynthesis.cancel()`, and bumps a generation so answers of requests still on their way are dropped. A new generation gets a new signal. `play()` also checks the signal before it falls back to the system voice after `playAudio` throws, so a cancel never ends in the system voice reading the item
- One app log line per server request, when it settles: `[voice] for=<done|waiting|concierge|test> server=<openai|voicevox> ms=<n> used=<server|system|none>` plus ` error=<timeout|network|http-<status>|not-audio|audio>` when it failed. The text and the base URL aren't logged

`src/lib/voice.ts` (changed):
- `setReadoutVoice(config)` sets a module variable, like `setVoiceVolume`, so a change applies to the next utterance even while a done waits for its summary
- `enqueueUtterance(text, lang, tag)`: source system → `speechSynthesis.speak` as now (unchanged path); source local → `ReadoutQueue.enqueue`. `speakEvent` / `speakDoneEvent` / `speakSuggestions` pass the tag (`done`, `waiting`, `concierge`); the Concierge tab's failure readout goes through `speakEvent` / `speakDoneEvent`, so it is tagged by its event type
- `readoutAvailable()` = `speechAvailable()` or `routeOf(...)` gives `"server"` for some language (local source with a saved config). It replaces `speechAvailable()` at the gates in `voice.ts`, in `App.tsx` (`canSpeak`: the "Read aloud" checkbox, its note, the volume slider) and in `src/perch/voice-menu.ts` (the menu bar item)
- `cancelSpeech()` cancels both the native queue and `ReadoutQueue`. Changing the voice source in the settings calls it, so a readout queued for one path doesn't play over the other
- Playback (`playAudio(audio, volume, signal)`): it returns without making a source if `signal` is aborted at its start or after the `resume()` wait or `decodeAudioData`, and stops its source when `signal` aborts while sounding; there is no module-wide "current source". `decodeAudioData` and an `AudioBufferSourceNode` through its own `GainNode` (the readout volume) on the AudioContext of `src/lib/chirp.ts` (new export `audioContext()`), so it isn't under the chirp volume. When no context exists yet it calls `primeAudio`; where the WebView wants a user action first, the context doesn't run, playback fails, and the utterance is read with the system voice (`error=audio`), the same constraint speechSynthesis has

Rust (`src-tauri/src/tts.rs`, new; registered in `lib.rs`):
- `tts_speech(kind, base_url, model, voice, text, timeout_ms) → raw bytes` (`tauri::ipc::Response`, so the audio isn't passed as JSON numbers)
  - openai: `POST <base>/audio/speech` with `{ model, input, voice, response_format: "wav" }` (WAV: every WebView decodes it)
  - voicevox: `POST <base>/audio_query?text=<text>&speaker=<voice>`, then `POST <base>/synthesis?speaker=<voice>` with that query as the body. Both within one deadline of `timeout_ms`
  - URLs from `local_url` of `keys.rs` (made `pub(crate)`), so the base URL rule is the same as Local AI's; `local_client` (no redirects) and `local_error` (no URL in errors) are reused
  - The answer must be audio (`content-type` `audio/*`, or the bytes start with `RIFF`, `ID3`, `OggS`, `fLaC` or an MP3 frame), else `not-audio` (a server of another kind, e.g. a 200 HTML page)
  - Errors as `<kind>: <detail>`: `timeout`, `network`, `http-<status>: <server's message, at most 200 chars>`, `not-audio`
- `tts_list(kind, base_url, path) → HttpReply`, `path` one of `speakers` and `engine_manifest` (voicevox), `audio/voices` and `models` (openai), 10-second timeout like `local_models`
- Rust tests: the URLs and bodies of both kinds, the audio check, and that an unknown `path` is refused

`src/lib/tts-server.ts` (new): the calls to those commands and what JS reads from them:
- `synthesize(config, text, timeoutMs)` → `{ ok: true, audio } | { ok: false, error }`, `error` as in the log line
- `fetchTtsVoices(kind, baseUrl)`: voicevox `/speakers` (`[{ name, styles: [{ name, id }] }]`) → `{ value: String(id), label: "<name>（<style>）", speaker: name }`; openai `/audio/voices` (`{ voices: [...] }` of strings or `{ id | name }`, or a bare array) → value and label the same. `fetchTtsModels(baseUrl)`: `/models`' `data[].id`. Undefined when the list can't be read, then the field is typed
- `testTtsVoice(config)`: synthesizes a sample (`readoutTestSample`, in the UI language; Japanese for VOICEVOX) with a 30-second wait (a first request may load the model, and the test is where the user learns that; Claude's own decision), plays it through `playAudio` at the readout volume under an `AbortSignal` of its own (so a readout's `cancel()` doesn't stop the Test, and the Test doesn't stop a readout; the Test is a user's own action in the settings, Claude's own decision), and returns the time taken or why it failed: `unreachable` (network), `wrong-server` (404 / 405 or not audio), `no-voice` (VOICEVOX 404 / 422, or OpenAI-compatible 400 / 404 / 422 whose message mentions the voice), `timeout`, `server` (anything else, with the status). The exact statuses are checked against the real servers before this is final
- The test writes the same log line with `for=test`

Settings screen (`src/perch/settings/readout-voice-settings.tsx`, new; placed under the "Read aloud" checkbox and the volume in `App.tsx`):
- Radio "System voice" / "Local server" (saved at once; the source)
- With "Local server": a card built like Local AI's (`LocalAiSettings`): kind (select: OpenAI-compatible / VOICEVOX-compatible), base URL, model (OpenAI-compatible only), voice, Save, and Change / Delete / Cancel on the saved card. The list rules are Local AI's: lists are read when the form shows and when the URL field loses focus with a new URL; editing the URL clears the lists and the choices; a saved voice / model stays for the saved URL and is put first when the list lacks it (`pickLocalModel` of `src/lib/local-judge.ts`, reused for both); an answer for an old URL is dropped; when a list can't be read, the field is typed. The rule for when Save and Test can be pressed and the one card note are the same as Local AI's (URL invalid, or voice / model empty)
- Layout after the UI checks (Claude's own decision, from two UI checks and a user-view review): the type is a short name ("OpenAI-compatible", "VOICEVOX-compatible") with the servers of that type under it as product names (Kokoro-FastAPI, mlx-audio / VOICEVOX, AivisSpeech; the same in every language), so the select isn't cut off; Save (and Cancel) sit under the whole form, not beside one field, since Save applies all of it; the saved card shows the voice, the model and the URL, with Change / Delete on their own line (beside the text they broke the URL at 260px). The note that VOICEVOX-compatible servers read Japanese only, so outside Japanese readouts use the system voice, is grey under the type: a fact with nothing to do (the parent session, from UI checks). "Turn on Read aloud with voice above to hear readouts" is amber, last in the card and set off by a line, while it is off (the sample plays either way). When the sample says the server can't be reached, the "couldn't get the list" note isn't shown too (one cause, said once). Where the system has no speech engine, "System voice" can't be chosen
- `CancelEditButton` and `CardNote` move from `ai-key-settings.tsx` to `src/perch/settings/card-parts.tsx` and are shared
- Under the choice, while VOICEVOX-compatible is chosen and the UI language isn't Japanese: a note that VOICEVOX-compatible servers read Japanese only, so readout uses the system voice (or is skipped where there is none)
- With VOICEVOX-compatible and `voicevoxCredit` true, the saved card and the form show the credit 「VOICEVOX:<speaker>」 next to the voice; for AivisSpeech Engine and other VOICEVOX-compatible servers, none
- Test: under the card, `BusyButton` (`src/perch/settings/busy-button.tsx`); its click calls `primeAudio` first. Success says it played through the server and how long it took; over 5 seconds it adds that readouts would use the system voice until the server answers faster. Failure says which of the kinds above, in words, and what to check
- `src/perch/use-settings.ts`: `readoutVoice` state, `loadReadoutVoice` in `loadSettings` (and `setReadoutVoice`), `changeReadoutSource`, `saveLocalTts`, `removeLocalTts`, `runTtsTest`
- New strings in `scripts/locales/readout-voice.mjs`, every locale, like the other groups
- For checking without the screen: `TOMARIGI_LOCAL_TTS="<kind>|<base URL>|<voice>|<model>"` sets the local source at launch and runs the test, logging its result, as `TOMARIGI_LOCAL_AI` does (README's verification list)

Docs: `README.md` / `README.ja.md` (the readout line and the Linux line), `docs/design/scope.md` "Scope"

Requirements → where they are met:

| Requirement / basic design | Where |
|---|---|
| "System voice" (default) / "Local server" | `ReadoutVoice` default in `readout-voice.ts`; radio in `readout-voice-settings.tsx`; system path of `enqueueUtterance` unchanged |
| Two kinds: OpenAI-compatible, VOICEVOX-compatible | `tts.rs` `tts_speech` (both request shapes); kind select |
| Everything read goes through the chosen voice; same text, order (name, then body), Read aloud, menu item, volume | `enqueueUtterance` is the one place every readout reaches; `readoutAvailable()` at the gates of `App.tsx` and `voice-menu.ts`; volume read at play time |
| No overlap, played in queued order | `ReadoutQueue` player loop |
| Never lost: unreachable / error / no audio in the wait → system voice; late audio dropped | `ReadoutQueue` settling at the first of audio / failure / `TTS_WAIT_MS` |
| VOICEVOX Japanese only; settings say so | `routeOf` (`lang` starts with `ja`); note in `readout-voice-settings.tsx` |
| Test plays a sample and says what went wrong | `testTtsVoice` in `tts-server.ts`; Test in the card |
| No system voice: Read aloud can be on with a local server; failed utterance skipped and logged | `readoutAvailable()`; `route` "none" → skip with `used=none` |
| Credit 「VOICEVOX:<voice name>」, only for VOICEVOX ENGINE itself, told by the server | `engine_manifest` → `voicevoxCredit`; `speaker` in the card |
| Settings saved with the others, no key; default URLs | `readoutVoice` key; `DEFAULT_TTS_BASE_URL` |
| Base URL rule in the screen and Rust | `isValidBaseUrl` (screen), `local_url` (Rust) |
| Lists, typed when missing, URL edit clears | `tts_list`, `fetchTtsVoices` / `fetchTtsModels`, card rules shared with Local AI |
| Requests from Rust; audio played in the page with the readout volume | `tts.rs`; `playAudio` on the chirp context with its own gain |
| 5 seconds per utterance from sending | `TTS_WAIT_MS`, timer started when the request is sent in `enqueue` |
| Nothing on disk; one log line per request | bytes kept in memory only; the `[voice]` line |

Tests:
- `tests/readout-queue.test.ts` (`ReadoutQueue` with fakes): server answers in time → server audio, `used=server`; error → system voice; no answer by the wait → system voice, and the audio that comes later is not played; English UI with VOICEVOX → system voice with no request; no system voice → a failed item is skipped and logged `used=none`, the next one still plays; several events (done name + body, then a waiting) → played in enqueue order with no overlap even when the second request answers first; `cancel()` drops the queue and a later answer; `cancel()` while `playAudio` is still decoding (nothing sounds) or about to fail (the system voice doesn't read it), and a new generation gets a fresh signal; `tests/voice-playback.test.ts` (`playAudio` on a fake `AudioContext`): an abort before start or during decode makes no source, during sounding stops it, and a playback under another signal (the Test) keeps sounding; a done whose name comes from the server and whose body falls back to the system voice plays both, in order, in two voices (each utterance is decided by itself; the parent session's decision to keep it so)
- `tests/readout-voice.test.ts`: `routeOf` for each case, loading broken saved data, the default-URL swap when changing the kind, `fetchTtsVoices` parsing of both list shapes
- `tests/voice-utterances.test.ts` (kept): the system path queues exactly as before
- Rust tests in `tts.rs` (above)
