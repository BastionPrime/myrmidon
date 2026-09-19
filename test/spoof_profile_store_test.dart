import 'dart:convert';

import 'package:wellmagram/core/accounts/account_key.dart';
import 'package:wellmagram/core/storage/spoof_device_presets.dart';
import 'package:wellmagram/core/storage/spoof_profile_store.dart';
import 'package:wellmagram/core/accounts/network.dart';
import 'package:test/test.dart';

const max1 = AccountKey(network: Network.max, id: 1);
const max2 = AccountKey(network: Network.max, id: 2);
const tg3 = AccountKey(network: Network.telegram, id: 3);

class FakePrefs implements SpoofPrefsLike {
  final Map<String, String> data = {};

  @override
  String? getString(String key) => data[key];

  @override
  Future<void> setString(String key, String value) async {
    data[key] = value;
  }

  @override
  Future<void> remove(String key) async {
    data.remove(key);
  }
}

void main() {
  late FakePrefs prefs;
  late SpoofProfileStore store;

  setUp(() {
    prefs = FakePrefs();
    store = SpoofProfileStore(prefs: prefs, random: SeededSpoofRandom(42));
  });

  group('naming', () {
    test('storage key is network-qualified', () {
      expect(SpoofProfileStore.storageKey(max1), 'spoof_profile_max_1');
      expect(SpoofProfileStore.storageKey(tg3), 'spoof_profile_tg_3');
    });
  });

  group('generation', () {
    test('generates a plausible preset-based profile', () {
      final profile = store.generate();
      expect(profile.enabled, isTrue);
      expect(profile.deviceType, 'ANDROID');
      expect(
        spoofDevicePresets.map((p) => p.deviceName),
        contains(profile.deviceName),
      );
      final preset = spoofDevicePresets.firstWhere(
        (p) => p.deviceName == profile.deviceName,
      );
      expect(profile.osVersion, preset.osVersion);
      expect(profile.timezone, preset.timezone);
      expect(profile.screen, preset.screen);
      expect(profile.userAgent, preset.userAgent);
      expect(profile.locale, preset.locale.split('-').first);
    });

    test('model and os_version stay a matched pair', () {
      for (var i = 0; i < 25; i++) {
        final profile = store.generate();
        final preset = spoofDevicePresets.firstWhere(
          (p) => p.deviceName == profile.deviceName,
        );
        expect(profile.osVersion, preset.osVersion,
            reason: '${profile.deviceName} должен идти с ${preset.osVersion}');
      }
    });

    test('identity fields are populated', () {
      final profile = store.generate();
      expect(profile.deviceId, hasLength(16));
      expect(profile.deviceId, matches(RegExp(r'^[0-9a-f]{16}$')));
      expect(profile.instanceId, matches(RegExp(
        r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
      )));
      expect(profile.clientSessionId, allOf(greaterThan(0), lessThan(0x80000000)));
      expect(profile.appVersion, spoofAppVersion);
      expect(profile.buildNumber, spoofBuildNumber);
      expect(profile.arch, 'arm64-v8a');
    });

    test('excludes models already used by other accounts', () {
      final taken = spoofDevicePresets
          .take(spoofDevicePresets.length - 1)
          .map((p) => p.deviceName)
          .toSet();
      final profile = store.generate(usedDeviceNames: taken);
      expect(taken, isNot(contains(profile.deviceName)));
    });

    test('falls back to the full table when all models are taken', () {
      final taken = spoofDevicePresets.map((p) => p.deviceName).toSet();
      final profile = store.generate(usedDeviceNames: taken);
      expect(
        spoofDevicePresets.map((p) => p.deviceName),
        contains(profile.deviceName),
      );
    });

    test('same seed reproduces the same profile', () {
      final a = SpoofProfileStore(prefs: prefs, random: SeededSpoofRandom(7))
          .generate();
      final b = SpoofProfileStore(prefs: prefs, random: SeededSpoofRandom(7))
          .generate();
      expect(a.deviceName, b.deviceName);
      expect(a.deviceId, b.deviceId);
      expect(a.instanceId, b.instanceId);
    });

    test('different seeds give different identities', () {
      final a = SpoofProfileStore(prefs: prefs, random: SeededSpoofRandom(1))
          .generate();
      final b = SpoofProfileStore(prefs: prefs, random: SeededSpoofRandom(2))
          .generate();
      expect(a.deviceId, isNot(b.deviceId));
      expect(a.instanceId, isNot(b.instanceId));
    });
  });

  group('persistence', () {
    test('save and load round-trip', () async {
      final profile = store.generate();
      await store.save(max1, profile);
      final loaded = await store.load(max1);
      expect(loaded, isNotNull);
      expect(loaded!.deviceName, profile.deviceName);
      expect(loaded.deviceId, profile.deviceId);
      expect(loaded.clientSessionId, profile.clientSessionId);
      expect(loaded.toJson(), profile.toJson());
    });

    test('accounts are isolated by key', () async {
      final p1 = store.generate();
      await store.save(max1, p1);
      expect(await store.load(max2), isNull);
      expect(await store.exists(max1), isTrue);
      expect(await store.exists(max2), isFalse);
    });

    test('save does not overwrite on load — profile is stable (S3)',
        () async {
      await store.save(max1, store.generate());
      final before = await store.load(max1);
      final again = await store.load(max1);
      expect(again!.deviceId, before!.deviceId);
    });

    test('remove deletes the profile and reports presence', () async {
      await store.save(max1, store.generate());
      expect(await store.remove(max1), isTrue);
      expect(await store.load(max1), isNull);
      expect(await store.remove(max1), isFalse);
    });

    test('corrupt JSON loads as null, not a crash', () async {
      await prefs.setString(
        SpoofProfileStore.storageKey(max1),
        'not-json{',
      );
      expect(await store.load(max1), isNull);
    });

    test('regenerate replaces the profile (user action, S3)', () async {
      await store.save(max1, store.generate());
      final old = await store.load(max1);
      final fresh = await store.regenerate(max1, usedDeviceNames: {
        old!.deviceName,
      });
      expect(fresh.deviceName, isNot(old.deviceName));
      expect(fresh.deviceId, isNot(old.deviceId));
      expect((await store.load(max1))!.deviceId, fresh.deviceId);
    });
  });

  group('legacy migration', () {
    test('commitPending moves the pending profile to the account key',
        () async {
      final pending = store.generate();
      await prefs.setString(
        'spoof_profile_pending',
        jsonEncode(pending.toJson()),
      );
      final committed = await store.commitPending(max1);
      expect(committed, isTrue);
      expect((await store.load(max1))!.deviceId, pending.deviceId);
      expect(prefs.data.containsKey('spoof_profile_pending'), isFalse);
    });

    test('commitPending without pending profile is a no-op', () async {
      expect(await store.commitPending(max1), isFalse);
    });

    test('adoptLegacyMax moves the numeric-key profile', () async {
      final legacy = store.generate();
      await prefs.setString('spoof_profile_7', jsonEncode(legacy.toJson()));
      final adopted = await store.adoptLegacyMax(7);
      expect(adopted, isTrue);
      expect(
        (await store.load(const AccountKey(network: Network.max, id: 7)))!
            .deviceId,
        legacy.deviceId,
      );
      expect(prefs.data.containsKey('spoof_profile_7'), isFalse);
    });

    test('adoptLegacyMax on missing key is a no-op', () async {
      expect(await store.adoptLegacyMax(9), isFalse);
    });
  });
}
