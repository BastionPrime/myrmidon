/// Secure credential storage over flutter_secure_storage (S2: tokens only
/// here, never in prefs).
///
/// Namespace: `cred:<network>:<id>` (plan-v3 Т-1.2), e.g. `cred:max:7`.
/// The plugin is loaded through a seam ([SecureStorageLike] adapter via
/// [CredentialStore.useStorage]) so the module is analyzable and unit-testable
/// without the Flutter toolchain.
library;

import 'account_key.dart';
import 'network.dart';

/// Narrow surface of `FlutterSecureStorage` used by this store.
abstract class SecureStorageLike {
  Future<String?> read({required String key});
  Future<void> write({required String key, required String value});
  Future<void> delete({required String key});
  Future<bool> containsKey({required String key});
  Future<Map<String, String>> readAll();
}

class CredentialStore {
  static const String keyPrefix = 'cred:';

  /// Legacy Komet namespace migrated in Т-1.2: `auth_token_<id>` → MAX only.
  static const String legacyTokenPrefix = 'auth_token_';

  final SecureStorageLike _storage;

  CredentialStore([SecureStorageLike? storage])
      : _storage = storage ?? _defaultStorage();

  static SecureStorageLike Function()? _storageLoader;

  /// Wires the production adapter over `FlutterSecureStorage` (called once
  /// from main). Unit tests pass their own [SecureStorageLike] directly.
  static void useStorage(SecureStorageLike Function() loader) {
    _storageLoader = loader;
  }

  static SecureStorageLike _defaultStorage() {
    if (_storageLoader == null) {
      throw StateError(
        'CredentialStore: flutter_secure_storage is not initialized '
        '(unit tests must inject a SecureStorageLike instance)',
      );
    }
    return _storageLoader!();
  }

  static String storageKey(AccountKey key) =>
      '$keyPrefix${key.network.storageName}:${key.id}';

  /// Legacy Komet key for a MAX account id: `auth_token_<id>`.
  static String legacyKey(int accountId) => '$legacyTokenPrefix$accountId';

  Future<void> saveToken(AccountKey key, String token) =>
      _storage.write(key: storageKey(key), value: token);

  Future<String?> readToken(AccountKey key) async {
    final token = await _storage.read(key: storageKey(key));
    return (token == null || token.isEmpty) ? null : token;
  }

  Future<void> deleteToken(AccountKey key) => _storage.delete(key: storageKey(key));

  Future<bool> hasToken(AccountKey key) async =>
      await readToken(key) != null;

  /// Removes the credential and any legacy duplicate; returns whether
  /// anything was deleted. Safe to call for unknown accounts.
  Future<bool> deleteAccountCredentials(AccountKey key) async {
    var removed = false;
    if (await readToken(key) != null) {
      await _storage.delete(key: storageKey(key));
      removed = true;
    }
    if (key.network == Network.max) {
      final legacy = legacyKey(key.id);
      if (await _storage.containsKey(key: legacy)) {
        await _storage.delete(key: legacy);
        removed = true;
      }
    }
    return removed;
  }

  /// Migrates legacy Komet `auth_token_<id>` entries to the unified
  /// `cred:max:<id>` namespace.
  ///
  /// An explicit non-null [accountIds] list (from the account registry)
  /// restricts the migration to known accounts; otherwise all legacy keys
  /// found in secure storage are migrated. For each legacy key:
  /// - if the new key already has a token, the legacy value is only deleted
  ///   (new value wins);
  /// - otherwise the legacy token is copied and the legacy key deleted.
  ///
  /// Returns the ids whose tokens were moved (not the ones merely cleaned).
  Future<List<int>> migrateLegacyTokens({Set<int>? accountIds}) async {
    final all = await _storage.readAll();
    final migrated = <int>[];
    for (final entry in all.entries) {
      if (!entry.key.startsWith(legacyTokenPrefix)) continue;
      final suffix = entry.key.substring(legacyTokenPrefix.length);
      final id = int.tryParse(suffix);
      if (id == null || id <= 0) continue;
      if (accountIds != null && !accountIds.contains(id)) continue;
      final newKey = storageKey(AccountKey(network: Network.max, id: id));
      final existing = await _storage.read(key: newKey);
      if (existing == null || existing.isEmpty) {
        await _storage.write(key: newKey, value: entry.value);
        migrated.add(id);
      }
      await _storage.delete(key: entry.key);
    }
    migrated.sort();
    return migrated;
  }

  /// Lists account keys that currently hold a token in the new namespace.
  Future<List<AccountKey>> keysWithToken() async {
    final all = await _storage.readAll();
    final keys = [
      for (final entry in all.entries)
        if (entry.key.startsWith(keyPrefix) && entry.value.isNotEmpty)
          AccountKey.tryParse(entry.key.substring(keyPrefix.length)),
    ].whereType<AccountKey>().toList()
      ..sort();
    return keys;
  }
}
