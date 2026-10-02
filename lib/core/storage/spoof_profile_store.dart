/// Per-account spoof profile storage (plan-v3 Т-1.6).
///
/// Upstream keys profiles by a string scope (spoof_profile_<accountId>) with
/// a 'pending' scope for pre-login generation. wellmagram keys profiles by
/// AccountKey (spoof_profile_<net>_<id>) so MAX and TG never collide, and
/// legacy pending-scope profiles migrate into the account key on commit —
/// same semantics as SpoofingService.commitPendingSpoof.
library;

import 'dart:convert';

import 'package:wellmagram/core/accounts/account_key.dart';
import 'package:wellmagram/core/accounts/network.dart';

import 'preset_key_hash.dart';
import 'spoof_device_presets.dart';
import 'spoof_profile.dart';

/// JSON key-value seam over shared_preferences (same shape as AccountsStore's
/// PrefsLike; keeps this module plugin-free for tests).
abstract class SpoofPrefsLike {
  String? getString(String key);
  Future<void> setString(String key, String value);
  Future<void> remove(String key);
}

/// Deterministic randomness seam: upstream uses Random.secure(); tests inject
/// a seeded fake to make generation reproducible.
abstract class SpoofRandom {
  int nextInt(int max);
}

class SeededSpoofRandom implements SpoofRandom {
  int _state;

  SeededSpoofRandom(int seed) : _state = seed & 0x7fffffff;

  @override
  int nextInt(int max) {
    _state = (_state * 48271) % 0x7fffffff;
    if (_state == 0) _state = 1;
    return _state % max;
  }
}

class SpoofProfileStore {
  static const String _keyPrefix = 'spoof_profile_';
  static const String pendingScope = 'pending';

  final SpoofPrefsLike prefs;
  final SpoofRandom random;

  SpoofProfileStore({required this.prefs, required this.random});

  static String storageKey(AccountKey account) =>
      '$_keyPrefix${account.network.storageName}_${account.id}';

  /// Deterministic-stable preset pick for an account key: the same key
  /// always resolves to the same preset row (FNV-1a of the storage key),
  /// and distinct keys spread across the table. Anti-ban §4.8: profile
  /// must be plausible and stable per account.
  SpoofDevicePreset presetFor(AccountKey account) {
    final index =
        presetIndexForAccountKey(storageKey(account), spoofDevicePresets.length);
    return spoofDevicePresets[index];
  }

  /// Generates a profile from the deterministic preset pick for [account]
  /// (stable per key, see [presetFor]); same contract as [generate].
  SpoofProfile generateFor(AccountKey account,
      {Set<String> usedDeviceNames = const {}}) {
    final preset = presetFor(account);
    final shortLocale = preset.locale.split(RegExp(r'[-_]')).first;
    return SpoofProfile(
      enabled: true,
      deviceName: preset.deviceName,
      osVersion: preset.osVersion,
      screen: preset.screen,
      timezone: preset.timezone,
      locale: shortLocale,
      deviceLocale: shortLocale,
      deviceId: _hex(8),
      deviceType: 'ANDROID',
      arch: 'arm64-v8a',
      appVersion: spoofAppVersion,
      buildNumber: spoofBuildNumber,
      pushDeviceType: 'GCM',
      instanceId: _uuidLike(),
      clientSessionId: random.nextInt(0x7ffffffe) + 1,
      userAgent: preset.userAgent,
    );
  }

  /// Generates a fresh plausible profile: preset pair model/os_version +
  /// timezone/locale + random ids. Excludes models already used by other
  /// accounts (upstream prepareNewAccountSpoof does the same), falling back
  /// to the full table when everything is taken.
  SpoofProfile generate({Set<String> usedDeviceNames = const {}}) {
    final pool = spoofDevicePresets
        .where((p) => !usedDeviceNames.contains(p.deviceName))
        .toList();
    final table = pool.isNotEmpty ? pool : spoofDevicePresets;
    final preset = table[random.nextInt(table.length)];
    final shortLocale = preset.locale.split(RegExp(r'[-_]')).first;
    return SpoofProfile(
      enabled: true,
      deviceName: preset.deviceName,
      osVersion: preset.osVersion,
      screen: preset.screen,
      timezone: preset.timezone,
      locale: shortLocale,
      deviceLocale: shortLocale,
      deviceId: _hex(8),
      deviceType: 'ANDROID',
      arch: 'arm64-v8a',
      appVersion: spoofAppVersion,
      buildNumber: spoofBuildNumber,
      pushDeviceType: 'GCM',
      instanceId: _uuidLike(),
      clientSessionId: random.nextInt(0x7ffffffe) + 1,
      userAgent: preset.userAgent,
    );
  }

  /// Stores the profile for an account (S3: only user action regenerates).
  Future<void> save(AccountKey account, SpoofProfile profile) async {
    await prefs.setString(
      storageKey(account),
      jsonEncode(profile.toJson()),
    );
  }

  Future<SpoofProfile?> load(AccountKey account) => _read(storageKey(account));

  Future<bool> exists(AccountKey account) async =>
      (await load(account)) != null;

  /// Removes the account's profile (part of account removal, 4.7 п.8).
  Future<bool> remove(AccountKey account) async {
    final key = storageKey(account);
    final present = prefs.getString(key) != null;
    await prefs.remove(key);
    return present;
  }

  /// Regenerates and stores a fresh profile for the account; returns it.
  Future<SpoofProfile> regenerate(
    AccountKey account, {
    Set<String> usedDeviceNames = const {},
  }) async {
    final profile = generate(usedDeviceNames: usedDeviceNames);
    await save(account, profile);
    return profile;
  }

  /// Regenerates from the deterministic preset pick for [account] and
  /// stores it; returns the profile.
  Future<SpoofProfile> regenerateFor(AccountKey account) async {
    final profile = generateFor(account);
    await save(account, profile);
    return profile;
  }

  /// Legacy migration: the upstream 'pending' scope (pre-login profile)
  /// becomes this account's profile; pending key is cleared afterwards.
  Future<bool> commitPending(AccountKey account) async {
    final pending = await _read('$_keyPrefix$pendingScope');
    if (pending == null) return false;
    await save(account, pending);
    await prefs.remove('$_keyPrefix$pendingScope');
    return true;
  }

  /// Legacy migration: an old `spoof_profile_<id>` (MAX only) becomes the
  /// account's profile under the network-qualified key.
  Future<bool> adoptLegacyMax(int accountId) async {
    final legacyKey = '$_keyPrefix$accountId';
    final legacy = await _read(legacyKey);
    if (legacy == null) return false;
    final account = AccountKey(network: Network.max, id: accountId);
    await save(account, legacy);
    await prefs.remove(legacyKey);
    return true;
  }

  Future<SpoofProfile?> _read(String key) async {
    final raw = prefs.getString(key);
    if (raw == null || raw.isEmpty) return null;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is Map<String, dynamic>) return SpoofProfile.fromJson(decoded);
    } on FormatException {
      return null;
    }
    return null;
  }

  String _hex(int bytes) {
    final sb = StringBuffer();
    for (var i = 0; i < bytes; i++) {
      sb.write(random.nextInt(256).toRadixString(16).padLeft(2, '0'));
    }
    return sb.toString();
  }

  String _uuidLike() {
    final b = [
      for (var i = 0; i < 16; i++) random.nextInt(256),
    ];
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    String h(int i) => b[i].toRadixString(16).padLeft(2, '0');
    return '${h(0)}${h(1)}${h(2)}${h(3)}-${h(4)}${h(5)}-${h(6)}${h(7)}-'
        '${h(8)}${h(9)}-${h(10)}${h(11)}${h(12)}${h(13)}${h(14)}${h(15)}';
  }
}
