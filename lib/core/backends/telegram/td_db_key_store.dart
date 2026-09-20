/// Per-account TDLib `databaseEncryptionKey` storage (plan-v3 Т-2.2, S2:
/// secrets live ONLY in the secure storage namespace of CredentialStore).
///
/// The key is generated once per account (32 random bytes), hex-encoded in
/// the `cred:tg:<id>` namespace of the CredentialStore — same seam,
/// same storage, no new secret surface. The key is never logged and never
/// written to prefs.
library;

import 'dart:math';

import 'package:wellmagram/core/accounts/account_key.dart';
import 'package:wellmagram/core/accounts/credential_store.dart';

/// Generates the raw key bytes; injectable so tests are deterministic.
typedef TdKeyGenerator = List<int> Function();

class TdDatabaseKeyStore {
  /// Hex-encoded key length for 32 bytes.
  static const int keyByteLength = 32;

  final CredentialStore credentials;

  /// Random source for key generation (crypto-secure in production wiring
  /// — dart:math Random.secure in main; tests inject a fixed generator).
  final TdKeyGenerator generate;

  TdDatabaseKeyStore({
    required this.credentials,
    TdKeyGenerator? generator,
  }) : generate = generator ?? _defaultGenerator;

  static List<int> _defaultGenerator() {
    final random = Random.secure();
    return List<int>.generate(keyByteLength, (_) => random.nextInt(256));
  }

  /// Reads the stored key for the account, or null when absent.
  Future<List<int>?> readKey(AccountKey account) async {
    final hex = await credentials.readToken(account);
    if (hex == null) return null;
    final bytes = _hexDecode(hex);
    return bytes == null ? null : bytes;
  }

  /// Reads the stored key or creates and persists a new one. The first
  /// call for an account is the moment the TDLib database becomes bound
  /// to this secure-storage entry (a lost key = unreadable local cache,
  /// the session itself lives on the Telegram server — see ADR-0001).
  Future<List<int>> ensureKey(AccountKey account) async {
    final existing = await readKey(account);
    if (existing != null && existing.length == keyByteLength) {
      return existing;
    }
    final fresh = generate();
    await credentials.saveToken(account, _hexEncode(fresh));
    return fresh;
  }

  /// Removes the key (account removal scenario 4.7 п.8 — TDLib
  /// directory goes away separately).
  Future<bool> deleteKey(AccountKey account) =>
      credentials.deleteAccountCredentials(account);

  static String _hexEncode(List<int> bytes) => bytes
      .map((b) => b.toRadixString(16).padLeft(2, '0'))
      .join();

  /// Returns null for malformed input (negative test path).
  static List<int>? _hexDecode(String hex) {
    if (hex.length.isOdd || hex.length != keyByteLength * 2) return null;
    final out = <int>[];
    for (var i = 0; i < hex.length; i += 2) {
      final byte = int.tryParse(hex.substring(i, i + 2), radix: 16);
      if (byte == null) return null;
      out.add(byte);
    }
    return out;
  }
}
