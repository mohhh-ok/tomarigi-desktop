What local TTS servers answered (2026-11-25), for tests and tools/readout-voice-shot.mjs:
- `kokoro-voices.json`, `kokoro-models.json`: Kokoro-FastAPI (ghcr.io/remsky/kokoro-fastapi-cpu), `GET /v1/audio/voices`, `GET /v1/models`
- `voicevox-speakers.json`, `voicevox-manifest.json`: VOICEVOX ENGINE 0.26.2 (voicevox/voicevox_engine:cpu-latest), `GET /speakers`, `GET /engine_manifest`
- `aivis-speakers.json`, `aivis-manifest.json`: AivisSpeech Engine (ghcr.io/aivis-project/aivisspeech-engine:cpu-latest), the same two
The manifests are cut to their identifying fields (the full ones carry icons and licenses, about 750 KB)
