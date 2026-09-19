/// Storage seam for the account registry snapshot.
///
/// The production implementation [PrefsAccountsStore] persists the snapshot as
/// JSON in SharedPreferences; tests inject an in-memory fake. The Flutter
/// plugin is loaded through a seam so the core module stays analyzable and
/// testable without the Flutter toolchain.
library;

import 'account_key.dart';
import 'account_profile.dart';
import 'accounts_codec.dart';

/// Narrow surface of `SharedPreferences` used by the registry store.
abstract class PrefsLike {
  String? getString(String key);
  Future<void> setString(String key, String value);
}

abstract class AccountsStore {
  Future<({List<AccountProfile> profiles, AccountKey? activeKey})> read();
  Future<void> write({
    required List<AccountProfile> profiles,
    required AccountKey? activeKey,
  });
}

class PrefsAccountsStore implements AccountsStore {
  final Future<String?> Function() readRaw;
  final Future<void> Function(String raw) writeRaw;

  PrefsAccountsStore({
    Future<String?> Function()? readRaw,
    Future<void> Function(String raw)? writeRaw,
  })  : readRaw = readRaw ?? _defaultRead,
        writeRaw = writeRaw ?? _defaultWrite;

  static Future<PrefsLike> Function()? _prefsLoader;

  /// Wires the SharedPreferences instance provider.
  ///
  /// Production code calls this once from main() with a `PrefsLike` adapter
  /// over `SharedPreferences.getInstance()`. Unit tests inject
  /// [readRaw]/[writeRaw] or use [InMemoryAccountsStore] instead.
  static void usePrefsLoader(Future<PrefsLike> Function() loader) {
    _prefsLoader = loader;
  }

  @override
  Future<({List<AccountProfile> profiles, AccountKey? activeKey})> read() async {
    final raw = await readRaw();
    final decoded = AccountsCodec.decode(raw);
    return (
      profiles: decoded?.profiles ?? const [],
      activeKey: decoded?.activeKey,
    );
  }

  @override
  Future<void> write({
    required List<AccountProfile> profiles,
    required AccountKey? activeKey,
  }) async {
    await writeRaw(AccountsCodec.encode(profiles: profiles, activeKey: activeKey));
  }

  static Future<String?> _defaultRead() async {
    if (_prefsLoader == null) {
      throw StateError(
        'PrefsAccountsStore: shared_preferences is not initialized '
        '(unit tests must inject readRaw/writeRaw)',
      );
    }
    final prefs = await _prefsLoader!();
    return prefs.getString(AccountsCodec.prefsKey);
  }

  static Future<void> _defaultWrite(String raw) async {
    if (_prefsLoader == null) {
      throw StateError(
        'PrefsAccountsStore: shared_preferences is not initialized '
        '(unit tests must inject readRaw/writeRaw)',
      );
    }
    final prefs = await _prefsLoader!();
    await prefs.setString(AccountsCodec.prefsKey, raw);
  }
}

class InMemoryAccountsStore implements AccountsStore {
  String? _raw;

  @override
  Future<({List<AccountProfile> profiles, AccountKey? activeKey})> read() async {
    final decoded = AccountsCodec.decode(_raw);
    return (
      profiles: decoded?.profiles ?? const [],
      activeKey: decoded?.activeKey,
    );
  }

  @override
  Future<void> write({
    required List<AccountProfile> profiles,
    required AccountKey? activeKey,
  }) async {
    _raw = AccountsCodec.encode(profiles: profiles, activeKey: activeKey);
  }
}
