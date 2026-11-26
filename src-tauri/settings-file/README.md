# Tomarigi settings file (for AI agents)

Tomarigi {{VERSION}} writes this README and `settings.schema.json` at every launch, so they always match the running version. Don't edit them: an edit is replaced at the next launch.

Tomarigi is a desktop app that shows the user's coding agent sessions. Its settings are in `{{SETTINGS}}`, plain JSON with no comments. Every key is described in `{{SCHEMA}}`; read it before you change anything.

## Changing a setting

1. Read `{{SETTINGS}}`.
2. Change only the keys the user asked about and save the file as valid JSON. Keep `"$schema"` and every other key as they are, and don't touch `id` in `watchedFolders`.
3. While Tomarigi runs, it applies a save within a second and shows the user a note of what changed. When it isn't running, the change is applied at its next launch.
4. Check the result in the log (below).

How Tomarigi takes a save:
- Each value goes through the same checks as the settings screen. A value that fails is not applied: the setting keeps its previous value, the other values of the same save are applied, and the reason is in the log and in a note to the user. The file is left as you wrote it, so fix the value and save again.
- A file that isn't valid JSON applies nothing; the log gives the line and column.
- A key you leave out keeps its value, and Tomarigi writes it back with that value. Deleting the file doesn't reset anything: Tomarigi writes it again from the current values.
- Keys Tomarigi doesn't know are left in the file and ignored.

## Voices and models

The file names a voice or a model; Tomarigi can't list them for you. Ask the server:
- VOICEVOX-compatible engines (VOICEVOX ENGINE, AivisSpeech; `readoutVoice.server.kind` = `voicevox`, default `http://localhost:50021`): `curl <baseUrl>/speakers`. `voice` is a style id from `styles[].id`, written as a string (e.g. `"2"`). These engines read Japanese only; other languages use the system voice.
- OpenAI-compatible speech servers (`kind` = `openai`, base URL ending in `/v1`, e.g. `http://localhost:8880/v1`): `model` is required; list the models with `curl <baseUrl>/models`. Voice names depend on the server (see its documentation; some list them at `<baseUrl>/audio/voices`).
- Local AI for the summaries (`localAi`, an OpenAI-compatible server such as Ollama `http://localhost:11434/v1` or LM Studio `http://localhost:1234/v1`): `curl <baseUrl>/models`.

If the server doesn't answer, tell the user it isn't running instead of guessing a name.

## The result

Tomarigi's log is `{{LOG}}`. Each applied or refused value is one line:

```
grep '\[settings-file\]' {{LOG}} | tail -n 20
```

- `[settings-file] applied <key>`: the value is in use.
- `[settings-file] refused <key>: <reason>`: not applied; the reason says what to fix.
- `[settings-file] unreadable <line>:<column>`: the file isn't valid JSON.

## What can't be set here

- API keys (Anthropic, OpenAI) are never read from this file. Ask the user to paste them on Tomarigi's settings screen (Settings → AI for summaries). `summaryProvider` can choose `anthropic` or `openai` only after the user has saved its key there.
- Debug options, updates and the window's size and place aren't in the file.
