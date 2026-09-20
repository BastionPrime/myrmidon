import 'package:wellmagram/core/accounts/account_key.dart';
import 'package:wellmagram/core/accounts/spoof_bridge.dart';
import 'package:wellmagram/core/storage/spoof_profile.dart';
import 'package:wellmagram/core/accounts/network.dart';
import 'package:test/test.dart';

void main() {
  test('profile maps to upstream getSpoofedSessionData shape', () {
    const profile = SpoofProfile(
      enabled: true,
      deviceName: 'Pixel 8 Pro',
      osVersion: 'Android 14',
      screen: 'xxhdpi 430dpi 1344x2992',
      timezone: 'America/New_York',
      locale: 'en',
      deviceLocale: 'en',
      deviceId: 'a1b2c3d4e5f60718',
      appVersion: '26.23.2',
      buildNumber: 6779,
      instanceId: 'inst-1',
      clientSessionId: 77,
      userAgent: 'UA',
    );
    final data = spoofProfileToSessionData(profile);
    expect(data, isNotNull);
    expect(data!['device_name'], 'Pixel 8 Pro');
    expect(data['os_version'], 'Android 14');
    expect(data['device_id'], 'a1b2c3d4e5f60718');
    expect(data['build_number'], 6779);
    expect(data['client_session_id'], 77);
    expect(data.keys, containsAll(<String>[
      'device_name', 'os_version', 'screen', 'timezone', 'locale',
      'device_locale', 'device_id', 'device_type', 'app_version', 'arch',
      'build_number', 'instance_id', 'client_session_id',
      'push_device_type', 'user_agent',
    ]));
  });

  test('disabled or missing profile yields null', () {
    expect(spoofProfileToSessionData(null), isNull);
    expect(
      spoofProfileToSessionData(const SpoofProfile(enabled: false)),
      isNull,
    );
  });

  test('bridge remove delegates to the store', () async {
    final bridge = _RecordingBridge();
    expect(await bridge.remove(const AccountKey(network: Network.max, id: 5)),
        isTrue);
    expect(bridge.removed, [const AccountKey(network: Network.max, id: 5)]);
  });
}

class _RecordingBridge implements AccountSpoofStoreBridge {
  final removed = <AccountKey>[];

  @override
  Future<bool> remove(AccountKey account) async {
    removed.add(account);
    return true;
  }
}
