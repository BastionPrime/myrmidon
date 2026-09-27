# wellmagram

A multi-account messenger for Android combining **MAX** and **Telegram** in one
app, with a focus on account privacy and safe traffic handling.

Status: **early development, core complete and live-verified**. The account
model, both backend seams and the native Telegram library are in place with
green unit tests; the Telegram bridge runs against a real TDLib (live smoke
passed in the build image: `updateAuthorizationState` within milliseconds of
client creation). The unified UI, store packaging and push notifications are
later phases.

## Highlights

- Multi-account: several MAX and Telegram accounts in one window, with
  per-account stores and session isolation.
- Rust transport core (kolibri) for the MAX backend, TDLib bridge for
  Telegram — behind Dart seams, so backends are swappable and testable.
- Native Telegram support ships with the app: `libtdjson` is cross-compiled
  for arm64-v8a and loaded through a Dart FFI adapter whose teardown honors
  the TDLib threading contract.
- Security-first: compile-time TLS gates, SPKI pinning points, ghost-mode
  (read/typing/online suppression) per account.

## Requirements

- Flutter SDK 3.38+ (Dart 3.10) and the Android SDK/NDK toolchain for the
  full build; the core modules alone run with plain `dart test`.
- Python 3 for the offline tooling in `tools/`.

## Build & test

```bash
flutter pub get     # resolves dependencies (see pubspec.yaml)
flutter test        # unit tests for lib/ (no device needed)
flutter build apk --debug   # debug APK, arm64-v8a, includes libtdjson
```

Telegram wire field names are machine-checked against the official TDLib
schema: run `tools/td_schema_check.py` when touching API mappings.

See `CHANGELOG.md` for the milestone history and the current state of the
TDLib bridge decision.

## Contributing

- One branch per change, named `<topic>-<short-description>`.
- `flutter test` must pass before handover; run `tools/td_schema_check.py`
  when touching Telegram API mappings.
- Pull requests against `main`; a reviewer merges.
- Don't commit secrets, internal hostnames, or internal ticket references —
  see `CONTRIBUTING.md`.

## License

Not yet decided — all rights reserved for now.
