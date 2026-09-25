# wellmagram

A multi-account messenger for Android combining **MAX** and **Telegram** in one
app, with a focus on account privacy and safe traffic handling.

Status: **early development**. The core architecture (accounts, backends,
transport seams) is in place with unit tests; full build packaging and store
distribution are not there yet.

## Highlights

- Multi-account: several MAX and Telegram accounts in one window, with
  per-account stores and session isolation.
- Rust transport core (kolibri) for the MAX backend, TDLib bridge for
  Telegram — behind Dart seams, so backends are swappable and testable.
- Security-first: compile-time TLS gates, SPKI pinning points, ghost-mode
  (read/typing/online suppression) per account.

## Requirements

- Dart SDK ^3.10 (the core modules run with plain `dart test`; a full Android
  build needs the Flutter SDK + Android NDK toolchain).
- Python 3 for the offline tooling in `tools/`.

## Build & test

```bash
dart pub get          # resolves dependencies (see pubspec.yaml)
dart test             # unit tests for lib/ (no device needed)
```

The Android build uses the Flutter toolchain plus a Rust cross-compile
target for the transport core.

## Contributing

- One branch per change, named `<topic>-<short-description>`.
- `dart test` must pass before handover; run `tools/td_schema_check.py` when
  touching Telegram API mappings (it cross-checks field names against the
  official TDLib schema).
- Pull requests against `main`; a reviewer merges.
- Don't commit secrets, internal hostnames, or internal ticket references —
  see `CONTRIBUTING.md`.

## License

Not yet decided — all rights reserved for now.
