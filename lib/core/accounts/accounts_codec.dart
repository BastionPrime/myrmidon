/// JSON encoding of the account registry snapshot (no secrets).
library;

import 'dart:convert';

import 'account_key.dart';
import 'account_profile.dart';
import 'account_registry_event.dart';

class AccountsCodec {
  static const int _currentVersion = 1;

  static const String prefsKey = 'wellmagram_accounts';

  static Map<String, dynamic> snapshotToJson({
    required List<AccountProfile> profiles,
    required AccountKey? activeKey,
  }) {
    return {
      'version': _currentVersion,
      'accounts': [for (final p in profiles) p.toJson()],
      'active': activeKey?.storageId,
    };
  }

  static ({List<AccountProfile> profiles, AccountKey? activeKey}) fromSnapshotJson(
    Map<String, dynamic> json,
  ) {
    final rawAccounts = json['accounts'];
    final profiles = <AccountProfile>[];
    if (rawAccounts is List) {
      for (final raw in rawAccounts) {
        if (raw is Map<String, dynamic>) {
          final profile = AccountProfile.fromJson(raw);
          if (profile != null) profiles.add(profile);
        }
      }
    }
    profiles.sort();
    AccountKey? active;
    final rawActive = json['active'];
    if (rawActive is String && rawActive.isNotEmpty) {
      active = AccountKey.tryParse(rawActive);
    }
    if (active != null &&
        !profiles.any((p) => p.key == active)) {
      active = null;
    }
    return (profiles: profiles, activeKey: active);
  }

  static String encode({
    required List<AccountProfile> profiles,
    required AccountKey? activeKey,
  }) =>
      jsonEncode(snapshotToJson(profiles: profiles, activeKey: activeKey));

  static ({List<AccountProfile> profiles, AccountKey? activeKey})? decode(
    String? raw,
  ) {
    if (raw == null || raw.isEmpty) return null;
    final Object? decoded;
    try {
      decoded = jsonDecode(raw);
    } on FormatException {
      return null;
    }
    if (decoded is! Map<String, dynamic>) return null;
    if (decoded['version'] is! int || decoded['version'] as int > _currentVersion) {
      return null;
    }
    return fromSnapshotJson(decoded);
  }

  static ({List<AccountProfile> profiles, AccountKey? activeKey}) migrateRegistry(
    Map<String, dynamic> legacy,
  ) {
    return fromSnapshotJson(legacy);
  }
}

const accountsPrefsKey = AccountsCodec.prefsKey;
final registryEventNames = {
  for (final kind in AccountRegistryEventKind.values) kind.name: kind,
};
