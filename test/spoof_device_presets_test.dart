import 'package:wellmagram/core/storage/preset_key_hash.dart';
import 'package:wellmagram/core/storage/spoof_device_presets.dart';
import 'package:wellmagram/core/storage/spoof_profile.dart';
import 'package:test/test.dart';

void main() {
  test('preset table has at least 60 entries', () {
    expect(spoofDevicePresets.length, greaterThanOrEqualTo(60));
  });

  test('presets carry matched model/os_version pairs', () {
    final pairs = <String>{};
    for (final preset in spoofDevicePresets) {
      expect(preset.deviceName, isNotEmpty);
      expect(preset.osVersion, startsWith('Android '));
      expect(preset.screen, matches(RegExp(r'^\w+ \d+dpi \d+x\d+$')));
      expect(preset.timezone, contains('/'));
      expect(preset.locale, matches(RegExp(r'^[a-z]{2}-[A-Z]{2}$')));
      expect(preset.userAgent, startsWith('Mozilla/5.0 (Linux; Android'));
      pairs.add('${preset.deviceName}|${preset.osVersion}');
    }
    expect(pairs, hasLength(spoofDevicePresets.length));
  });

  test('no duplicate device models in the table', () {
    final names = spoofDevicePresets.map((p) => p.deviceName).toList();
    expect(names.toSet(), hasLength(names.length));
  });

  test('os versions stay in a plausible 12..16 window', () {
    for (final preset in spoofDevicePresets) {
      final v = int.parse(preset.osVersion.split(' ').last);
      expect(v, inInclusiveRange(12, 16),
          reason: '${preset.deviceName}: Android ${v} вне правдоподобного окна');
    }
  });

  test('user agent os version matches the preset os version', () {
    for (final preset in spoofDevicePresets) {
      final m = RegExp(r'Linux; Android (\d+);').firstMatch(preset.userAgent);
      expect(m, isNotNull, reason: preset.deviceName);
      final uaV = int.parse(m!.group(1)!);
      final osV = int.parse(preset.osVersion.split(' ').last);
      expect(uaV, osV,
          reason: '${preset.deviceName}: UA Android ${uaV} != ${preset.osVersion}');
    }
  });

  test('preset table spans multiple vendors', () {
    final vendors = <String>{};
    for (final preset in spoofDevicePresets) {
      final first = preset.deviceName.split(' ').first.toLowerCase();
      vendors.add(first);
    }
    // Samsung, Google, Xiaomi, Redmi, POCO, Honor, OnePlus, Motorola,
    // Sony, Asus, Oppo, realme, vivo are all distinct first words.
    expect(vendors.length, greaterThanOrEqualTo(10));
  });

  test('spoof identity constants are pinned', () {
    expect(spoofAppVersion, isNotEmpty);
    expect(spoofBuildNumber, greaterThan(0));
  });

  test('fnv1a32 is deterministic and spreads keys', () {
    expect(fnv1a32('spoof_profile_max_1'), fnv1a32('spoof_profile_max_1'));
    expect(fnv1a32('spoof_profile_max_1'),
        isNot(fnv1a32('spoof_profile_max_2')));
  });

  test('presetIndexForAccountKey is stable per key', () {
    const count = 68;
    for (final key in [
      'spoof_profile_max_1',
      'spoof_profile_tg_42',
      'spoof_profile_max_99999',
    ]) {
      final a = presetIndexForAccountKey(key, count);
      final b = presetIndexForAccountKey(key, count);
      expect(a, b);
      expect(a, inInclusiveRange(0, count - 1));
    }
  });

  test('presetIndexForAccountKey throws on non-positive count', () {
    expect(() => presetIndexForAccountKey('k', 0), throwsArgumentError);
    expect(() => presetIndexForAccountKey('k', -1), throwsArgumentError);
  });

  test('distinct keys map to many distinct presets (spread)', () {
    final picked = <int>{};
    for (var id = 1; id <= 100; id++) {
      picked.add(presetIndexForAccountKey('spoof_profile_max_$id', 68));
    }
    // 100 keys over a 68-row table must use at least 40 distinct rows.
    expect(picked.length, greaterThanOrEqualTo(40));
  });

  test('profile json round-trips through fromJson', () {
    const profile = SpoofProfile(
      enabled: true,
      deviceName: 'X',
      osVersion: 'Android 14',
      screen: 's',
      timezone: 'Europe/Moscow',
      locale: 'ru',
      deviceLocale: 'ru',
      deviceId: 'd',
      appVersion: '26.23.2',
      buildNumber: 6779,
      instanceId: 'i',
      clientSessionId: 5,
      userAgent: 'ua',
    );
    final restored = SpoofProfile.fromJson(profile.toJson());
    expect(restored, isNotNull);
    expect(restored!.toJson(), profile.toJson());
    expect(restored.clientSessionId, 5);
    expect(restored.enabled, isTrue);
  });

  test('fromJson tolerates missing fields with upstream defaults', () {
    final restored = SpoofProfile.fromJson(const {});
    expect(restored, isNotNull);
    expect(restored!.deviceType, 'ANDROID');
    expect(restored.arch, 'arm64-v8a');
    expect(restored.pushDeviceType, 'GCM');
    expect(restored.enabled, isFalse);
    expect(restored.clientSessionId, isNull);
  });
}
