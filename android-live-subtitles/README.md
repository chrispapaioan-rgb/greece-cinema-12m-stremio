# Greek Live Subtitles (Android alpha)

This branch contains the reproducible build pipeline for an Android live-subtitle app tailored to the requested use case:

- Playback audio from Filmzie, Stremio, and other Android media apps when Android capture policy allows it
- Automatic microphone fallback when playback capture is unavailable or blocked
- Source speech: Auto / English / French / Spanish / German / Russian
- Output subtitles: Greek
- Vosk on-device speech recognition
- Google ML Kit on-device translation
- Floating overlay subtitles
- Android 10+ (API 29+)

## Build provenance

The alpha is built from the GPL-3.0 SUBRIMA project at a pinned upstream commit and patched reproducibly by `patch_subrima.py`.

Upstream:
https://github.com/y-haviv/android-subtitle-overlay

Pinned commit:
`a7787aad18a116cec5ba3c13d83a59002f7612b7`

The generated artifact includes:
- signed debug APK
- SHA-256 checksum
- full patched corresponding source archive
- patch diff
- build metadata

## Important platform limitation

Android's `AudioPlaybackCapture` respects the source application's capture policy. This project does not attempt to bypass DRM or a source app's explicit no-capture policy. In those cases the app falls back to the microphone.

## License

The modified application is distributed under GPL-3.0, consistent with the upstream project.
