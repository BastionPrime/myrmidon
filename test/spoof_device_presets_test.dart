import 'package:wellmagram/core/storage/spoof_device_presets.dart';
import 'package:wellmagram/core/storage/spoof_profile.dart';
import 'package:test/test.dart';

void main() {
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

  test('spoof identity constants are pinned', () {
    expect(spoofAppVersion, isNotEmpty);
    expect(spoofBuildNumber, greaterThan(0));
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
