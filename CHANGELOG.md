# Changelog

All notable changes to this project are documented here. The format is a
trimmed keep-a-changelog; entries group by development phase.

## [unreleased] — build & live-verification milestone

### Live verification (build image)

- TDLib `libtdjson` built from source (tdlib master, arm64-v8a via Android
  NDK + static OpenSSL) and shipped in `jniLibs/arm64-v8a/` — the debug APK
  builds from a clean clone with the native Telegram library included.
- Live smoke against the real TDLib client passes: `create → receive →
  updateAuthorizationState (authorizationStateWaitTdlibParameters)` with a
  9 ms cold start, then a clean teardown (close, stop-flag handshake,
  native destroy inside the receive isolate — no use-after-free).
- Dart FFI production adapter for the TDLib JSON client contract
  (`td_json_client.h`): dedicated receive isolate, ordered update stream,
  teardown that never overlaps `receive` and `destroy` on the native handle.

### Android packaging skeleton

- Minimal app entry (`lib/main.dart`) hosting the core modules; the unified
  UI is a later phase.
- `android/` build tree (Gradle 8.14, AGP 8.11.1, Kotlin 2.2.20, JDK 17,
  effective minSdk 24), rebadged identity `ru.wellmagram.app`, single
  distribution flavor (no push-service wiring), manifest with the
  connection foreground service and boot receiver.

### Core (from the account/backend phases)

- Multi-account model: per-account stores, credential seams, spoof profiles,
  ghost-mode suppression, session manager with switch/parallel modes.
- Telegram backend on the TDLib bridge seam: auth flow, chats, messages,
  media/voice, groups, push-registration seam — all schema-checked against
  the official `td_api.tl` by `tools/td_schema_check.py`.
- 308 unit tests green; `flutter analyze` clean.

### Notes

- The bridge choice (Dart FFI vs Kotlin JNI) remains an open decision until
  comparative live metrics on a real device (update latency, 1-hour
  stability, a 200-chat list screen); the FFI adapter is the working
  implementation of the first option.
- Debug APK artifact (85 MB, arm64-v8a, debug-signed) is produced by
  `flutter build apk --debug`; distribution is a later decision.
